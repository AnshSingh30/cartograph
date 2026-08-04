import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";

export type Lang = "javascript" | "typescript" | "tsx" | "python";

const GRAMMAR_SPECIFIER: Record<Lang, string> = {
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
};

const BASE_QUERY = `
(import_statement source: (string (string_fragment) @import))
(export_statement source: (string (string_fragment) @import))
(call_expression
  function: (identifier) @fn
  arguments: (arguments (string (string_fragment) @import))
  (#eq? @fn "require"))
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @import)))
`;

// import x = require('...') is TypeScript-only; the node type doesn't exist
// in the plain JS grammar, so it must live in its own query object.
const TS_REQUIRE_QUERY = `
(import_require_clause source: (string (string_fragment) @import))
`;

// Python's grammar is unrelated to the JS/TS family, so it gets its own query and its own
// extraction path below rather than being folded into the capture-name convention above.
//
// "from X import Y" is captured as one (module_name, name) pair PER imported name -- verified
// empirically: `query.matches()` produces a separate match for each name in a comma-separated
// `from foo import bar, baz`, each paired with the same module_name. This resolves the
// ambiguity Python has that JS doesn't: "from foo import bar" may mean bar is a symbol
// defined inside foo.py, or that foo/bar.py is itself a submodule -- both are common, so
// extractImportSpecifiers emits candidates for both and the resolver in build.ts keeps
// whichever one exists on disk.
const PYTHON_QUERY = `
(import_statement name: (dotted_name) @py_import)
(import_statement name: (aliased_import name: (dotted_name) @py_import))
(import_from_statement
  module_name: (_) @py_from_mod
  name: (_) @py_from_name)
`;

let initialized = false;
// One parser per language, reused for every file. A parser holds WASM memory that JS
// garbage collection does not reclaim, so allocating one per file leaks for the whole scan.
const parsers = new Map<Lang, Parser>();
const queries = new Map<Lang, Parser.Query[]>();

async function loadParser(lang: Lang): Promise<{
  parser: Parser;
  queries: Parser.Query[];
}> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  let parser = parsers.get(lang);
  if (!parser) {
    const wasmPath = fileURLToPath(import.meta.resolve(GRAMMAR_SPECIFIER[lang]));
    const language = await Parser.Language.load(wasmPath);
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(lang, parser);
    const langQueries =
      lang === "python"
        ? [language.query(PYTHON_QUERY)]
        : [language.query(BASE_QUERY)];
    if (lang !== "javascript" && lang !== "python") langQueries.push(language.query(TS_REQUIRE_QUERY));
    queries.set(lang, langQueries);
  }
  return { parser, queries: queries.get(lang)! };
}

export function langForFile(filePath: string): Lang | null {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return "javascript";
  if (filePath.endsWith(".py")) return "python";
  return null;
}

/**
 * Encodes one Python "from X import Y" as a small set of resolvable specifier strings, using
 * leading dots to carry the relative-import level exactly the way Python's own syntax does
 * (so build.ts's resolver can count them straight off the string). `modText` is the raw text
 * of the module_name capture -- a plain dotted name ("foo.bar") for an absolute import, or a
 * relative_import's text ("." / ".." / "..pkg") for a relative one.
 */
function pythonFromSpecifiers(modText: string, name: string | null): string[] {
  if (!name) return [modText];
  const isPureDots = /^\.+$/.test(modText); // "." or ".." with no path component, e.g. "from . import x"
  if (isPureDots) {
    // Resolving the bare dots alone would target every importing file's own package
    // __init__ -- ubiquitous and uninformative, so only the dots-plus-name form is useful.
    return [modText + name];
  }
  return [modText, modText + "." + name];
}

/** Raw import specifiers found in a source file (e.g. "./foo", "some-pkg"). Unresolved. */
export async function extractImportSpecifiers(source: string, lang: Lang): Promise<string[]> {
  const { parser, queries: langQueries } = await loadParser(lang);
  // Everything after this point is synchronous, so the shared parser cannot be
  // re-entered and the tree is always freed before another parse starts.
  const tree = parser.parse(source);
  try {
    const specifiers: string[] = [];
    if (lang === "python") {
      for (const query of langQueries) {
        for (const match of query.matches(tree.rootNode)) {
          const plain = match.captures.find((c) => c.name === "py_import");
          if (plain) {
            specifiers.push(plain.node.text);
            continue;
          }
          const mod = match.captures.find((c) => c.name === "py_from_mod");
          const nameCap = match.captures.find((c) => c.name === "py_from_name");
          if (!mod || !nameCap) continue;
          if (nameCap.node.type === "wildcard_import") continue; // "from x import *": no specific name to resolve
          const name =
            nameCap.node.type === "aliased_import"
              ? (nameCap.node.childForFieldName("name")?.text ?? null)
              : nameCap.node.text;
          specifiers.push(...pythonFromSpecifiers(mod.node.text, name));
        }
      }
      return specifiers;
    }
    for (const query of langQueries) {
      for (const capture of query.captures(tree.rootNode)) {
        if (capture.name === "import") specifiers.push(capture.node.text);
      }
    }
    return specifiers;
  } finally {
    tree.delete();
  }
}

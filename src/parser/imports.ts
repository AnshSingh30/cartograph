import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";

export type Lang = "javascript" | "typescript" | "tsx";

const GRAMMAR_SPECIFIER: Record<Lang, string> = {
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
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
    const langQueries = [language.query(BASE_QUERY)];
    if (lang !== "javascript") langQueries.push(language.query(TS_REQUIRE_QUERY));
    queries.set(lang, langQueries);
  }
  return { parser, queries: queries.get(lang)! };
}

export function langForFile(filePath: string): Lang | null {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return "javascript";
  return null;
}

/** Raw import specifiers found in a source file (e.g. "./foo", "some-pkg"). Unresolved. */
export async function extractImportSpecifiers(source: string, lang: Lang): Promise<string[]> {
  const { parser, queries: langQueries } = await loadParser(lang);
  // Everything after this point is synchronous, so the shared parser cannot be
  // re-entered and the tree is always freed before another parse starts.
  const tree = parser.parse(source);
  try {
    const specifiers: string[] = [];
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

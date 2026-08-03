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
const languages = new Map<Lang, Parser.Language>();
const queries = new Map<Lang, Parser.Query[]>();

async function loadLanguage(lang: Lang): Promise<{
  language: Parser.Language;
  queries: Parser.Query[];
}> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  let language = languages.get(lang);
  if (!language) {
    const wasmPath = fileURLToPath(import.meta.resolve(GRAMMAR_SPECIFIER[lang]));
    language = await Parser.Language.load(wasmPath);
    languages.set(lang, language);
    const langQueries = [language.query(BASE_QUERY)];
    if (lang !== "javascript") langQueries.push(language.query(TS_REQUIRE_QUERY));
    queries.set(lang, langQueries);
  }
  return { language, queries: queries.get(lang)! };
}

export function langForFile(filePath: string): Lang | null {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return "javascript";
  return null;
}

/** Raw import specifiers found in a source file (e.g. "./foo", "some-pkg"). Unresolved. */
export async function extractImportSpecifiers(source: string, lang: Lang): Promise<string[]> {
  const { language, queries: langQueries } = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const specifiers: string[] = [];
  for (const query of langQueries) {
    for (const capture of query.captures(tree.rootNode)) {
      if (capture.name === "import") specifiers.push(capture.node.text);
    }
  }
  return specifiers;
}

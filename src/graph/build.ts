import fs from "node:fs";
import path from "node:path";
import Graph from "graphology";
import { extractImportSpecifiers, langForFile, type Lang } from "../parser/imports.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "test",
  "tests",
  "__tests__",
  "spec",
  "examples",
  "example",
  "fixtures",
]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(full, files);
    } else if (entry.isFile() && langForFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Resolves a relative import specifier to a repo-relative path already present in the repo, or null (external/unresolved). */
function resolveImport(fromFile: string, specifier: string, fileSet: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}.mjs`,
    `${joined}.cjs`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
    `${joined}/index.js`,
    `${joined}/index.jsx`,
  ];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

export interface BuiltGraph {
  graph: Graph;
  loc: Map<string, number>;
}

export async function buildImportGraph(repoRoot: string): Promise<BuiltGraph> {
  const absFiles = walk(repoRoot);
  const relFiles = absFiles.map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));
  const fileSet = new Set(relFiles);

  const graph = new Graph({ type: "directed" });
  const loc = new Map<string, number>();
  for (const rel of relFiles) graph.addNode(rel);

  for (let i = 0; i < absFiles.length; i++) {
    const rel = relFiles[i];
    const lang = langForFile(absFiles[i]) as Lang;
    const source = fs.readFileSync(absFiles[i], "utf8");
    loc.set(rel, source.split("\n").length);

    const specifiers = await extractImportSpecifiers(source, lang);
    for (const spec of specifiers) {
      const target = resolveImport(rel, spec, fileSet);
      if (target && target !== rel && !graph.hasEdge(rel, target)) {
        graph.addEdge(rel, target, { type: "import" });
      }
    }
  }

  return { graph, loc };
}

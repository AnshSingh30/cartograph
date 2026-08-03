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

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Maps workspace package names to their repo-relative directory, e.g. "@vue/shared" -> "packages/shared".
 *
 * Reads the `name` field of every package.json rather than guessing from directory names, because the
 * two often differ (Vue's "@vue/compat" lives in packages/vue-compat). Deliberately ignores
 * main/module/exports: those point at build output that does not exist in a fresh clone.
 */
function findWorkspacePackages(repoRoot: string, dir = repoRoot, out = new Map<string, string>()): Map<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) findWorkspacePackages(repoRoot, full, out);
    } else if (entry.name === "package.json") {
      try {
        const name = JSON.parse(fs.readFileSync(full, "utf8")).name;
        // A malformed or nameless manifest anywhere must not abort the whole scan.
        if (typeof name === "string" && name) {
          out.set(name, path.relative(repoRoot, dir).split(path.sep).join("/"));
        }
      } catch {
        // ignore unparseable package.json
      }
    }
  }
  return out;
}

/** First existing candidate for a module path: the path itself, then with each extension, then as a directory index. */
function resolveModulePath(base: string, fileSet: Set<string>): string | null {
  if (fileSet.has(base)) return base;
  for (const ext of EXTENSIONS) {
    if (fileSet.has(`${base}${ext}`)) return `${base}${ext}`;
  }
  for (const ext of EXTENSIONS) {
    if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return null;
}

/** Resolves an import specifier to a repo-relative path already present in the repo, or null (external/unresolved). */
function resolveImport(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
  packages: Map<string, string>,
): string | null {
  if (!specifier.startsWith(".")) {
    // Bare specifier: an internal workspace package in a monorepo, or a real node_modules dependency.
    const dir = packages.get(specifier);
    if (dir === undefined) return null;
    return resolveModulePath(dir ? `${dir}/src` : "src", fileSet) ?? resolveModulePath(dir, fileSet);
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));

  // TypeScript ESM makes you write "./x.js" even though the file on disk is "./x.ts",
  // so a literal match must be tried first, then the same path with the extension dropped.
  const stripped = joined.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const bases = stripped === joined ? [joined] : [joined, stripped];

  for (const base of bases) {
    const hit = resolveModulePath(base, fileSet);
    if (hit) return hit;
  }
  return null;
}

export interface BuiltGraph {
  graph: Graph;
  loc: Map<string, number>;
}

export async function buildImportGraph(repoRoot: string): Promise<BuiltGraph> {
  const absFiles = walk(repoRoot);
  const relFiles = absFiles.map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));
  const fileSet = new Set(relFiles);
  const packages = findWorkspacePackages(repoRoot);

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
      const target = resolveImport(rel, spec, fileSet, packages);
      if (target && target !== rel && !graph.hasEdge(rel, target)) {
        graph.addEdge(rel, target, { type: "import" });
      }
    }
  }

  return { graph, loc };
}

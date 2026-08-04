import fs from "node:fs";
import path from "node:path";
import Graph from "graphology";
import { extractImportSpecifiers, extractDefinitions, langForFile, type Lang } from "../parser/imports.js";

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
  // Python virtual envs and caches -- unlike node_modules these carry no name a bare-import
  // specifier would ever reference, so skipping them loses nothing but scan time.
  "__pycache__",
  "venv",
  ".venv",
  "env",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);

/** Lines in a file. A trailing newline terminates the last line rather than starting a new one. */
export function countLines(source: string): number {
  if (source === "") return 0;
  const n = source.split("\n").length;
  return source.endsWith("\n") ? n - 1 : n;
}

/** Directory entries, or none if the directory cannot be read. */
function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // One unreadable directory (permissions, a broken mount) must not abort the whole scan.
    return [];
  }
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readDirSafe(dir)) {
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
  for (const entry of readDirSafe(dir)) {
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

/** First existing candidate for a Python module path: the module file, then its package init. */
function resolvePyModulePath(base: string, fileSet: Set<string>): string | null {
  if (fileSet.has(`${base}.py`)) return `${base}.py`;
  if (fileSet.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  return null;
}

/**
 * Resolves a Python import specifier (dot-encoded by extractImportSpecifiers, e.g. "foo.bar"
 * or "..pkg.mod") to a repo-relative path, or null.
 *
 * Absolute imports (no leading dot) resolve from the repo root, with a "src/" fallback
 * mirroring the existing JS workspace-package heuristic below. Relative imports resolve by
 * walking up from the importing file's own directory: one leading dot means "this file's own
 * directory" and each further dot goes up one more level. This is the same rule Python's
 * import system itself uses (importlib._bootstrap._resolve_name) -- level 1 never strips a
 * directory, level 2 strips one, and so on -- derived and cross-checked against CPython's
 * source rather than guessed, since getting the off-by-one wrong here silently drops or
 * misroutes every relative import in the file.
 */
function resolvePythonImport(fromFile: string, specifier: string, fileSet: Set<string>): string | null {
  const level = specifier.match(/^\.*/)![0].length;
  const parts = specifier.slice(level).split(".").filter(Boolean);

  if (level === 0) {
    const base = parts.join("/");
    return resolvePyModulePath(base, fileSet) ?? resolvePyModulePath(`src/${base}`, fileSet);
  }

  const fromDir = path.posix.dirname(fromFile);
  const dirParts = fromDir === "." ? [] : fromDir.split("/");
  const stripCount = level - 1;
  if (stripCount > dirParts.length) return null; // "attempted relative import beyond top-level package"
  const baseDirParts = stripCount === 0 ? dirParts : dirParts.slice(0, dirParts.length - stripCount);

  return resolvePyModulePath([...baseDirParts, ...parts].join("/"), fileSet);
}

export interface BuiltGraph {
  graph: Graph;
  loc: Map<string, number>;
  symbols: Map<string, string[]>;
}

export async function buildImportGraph(repoRoot: string): Promise<BuiltGraph> {
  const absFiles = walk(repoRoot);
  const relFiles = absFiles.map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));
  const fileSet = new Set(relFiles);
  const packages = findWorkspacePackages(repoRoot);

  const graph = new Graph({ type: "directed" });
  const loc = new Map<string, number>();
  const symbols = new Map<string, string[]>();
  for (const rel of relFiles) graph.addNode(rel);

  for (let i = 0; i < absFiles.length; i++) {
    const rel = relFiles[i];
    const lang = langForFile(absFiles[i]) as Lang;
    let source: string;
    try {
      source = fs.readFileSync(absFiles[i], "utf8");
    } catch {
      // Deleted or unreadable since the walk. Keep the node, skip its edges.
      continue;
    }
    loc.set(rel, countLines(source));
    symbols.set(rel, await extractDefinitions(source, lang));

    const specifiers = await extractImportSpecifiers(source, lang);
    for (const spec of specifiers) {
      const target = lang === "python" ? resolvePythonImport(rel, spec, fileSet) : resolveImport(rel, spec, fileSet, packages);
      if (target && target !== rel && !graph.hasEdge(rel, target)) {
        graph.addEdge(rel, target, { type: "import" });
      }
    }
  }

  return { graph, loc, symbols };
}

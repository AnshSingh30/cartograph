import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildImportGraph, countLines, stripJsonComments } from "./build.js";
import { buildManifest } from "../output/cartographJson.js";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartograph-fixture-"));
  const files: Record<string, string> = {
    "entry.js": `require('./a'); require('./b'); require('./c');`,
    "a.js": `require('./shared');`,
    "b.js": `require('./shared');`,
    "c.js": `require('./shared');`,
    "shared.js": `module.exports = {};`,
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }

  const { graph, loc } = await buildImportGraph(dir);
  assert.strictEqual(graph.order, 5, "expected 5 files in the graph");
  assert.strictEqual(graph.size, 6, "expected 6 import edges (3 from entry, 1 each from a/b/c)");

  const manifest = buildManifest("fixture", graph, loc);
  const byId = new Map(manifest.nodes.map((n) => [n.id, n]));
  const shared = byId.get("shared.js")!;
  const entry = byId.get("entry.js")!;
  assert.ok(shared, "shared.js should be a node");
  assert.ok(
    shared.centrality > entry.centrality,
    `expected shared.js (imported by 3 files) to outrank entry.js, got shared=${shared.centrality} entry=${entry.centrality}`,
  );

  const cluster = manifest.clusters.find((c) => c.files.includes("shared.js"));
  assert.ok(cluster, "shared.js should belong to a cluster");

  fs.rmSync(dir, { recursive: true, force: true });

  await tsEsmExtensionRewrite();
  await monorepoWorkspaceImports();
  lineCounting();
  await unreadableFilesAreSkipped();
  await pythonImports();
  jsonCommentStripping();
  await tsconfigPathAliases();
  console.log("OK: graph.test.ts passed");
}

/**
 * tsconfig.json is JSONC: comments and trailing commas are legal and JSON.parse rejects both.
 * A "//" or "/*" inside a string value (e.g. a URL) must survive untouched.
 */
function jsonCommentStripping() {
  const input = `{
  // line comment
  "a": 1, /* block
  comment */ "b": 2,
  "url": "http://example.com/*not-a-comment*/",
  "trailing": [1, 2,],
}`;
  const parsed = JSON.parse(stripJsonComments(input));
  assert.strictEqual(parsed.a, 1);
  assert.strictEqual(parsed.b, 2);
  assert.strictEqual(parsed.url, "http://example.com/*not-a-comment*/", "// and /* inside a string must not be stripped");
  assert.deepStrictEqual(parsed.trailing, [1, 2]);
}

/**
 * "@/*" -> "./*" is the tsconfig paths alias every create-next-app project sets up by default.
 * Found missing entirely by scanning a real repo (85 independent Next.js apps): 1356 of ~1400
 * internal imports used this alias and were silently dropped as unresolvable externals,
 * versus 46 edges actually resolved. This fixture reproduces that shape at small scale:
 * multiple independent apps, each with its own tsconfig scoped to its own subtree (not a
 * single repo-wide alias map), plus the child-config-wins-outright extends case and
 * longest-prefix-wins when two patterns could both match.
 */
async function tsconfigPathAliases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartograph-tsconfig-"));
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };

  // App A: standalone tsconfig with its own "@/*" alias, JSONC-formatted.
  write(
    "appA/tsconfig.json",
    `{
  // Next.js default
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], } },
}`,
  );
  write("appA/components/button.tsx", `export const Button = 1;`);
  write("appA/app/page.tsx", `import { Button } from "@/components/button";`);

  // App B: a second, unrelated app in the same repo -- its "@/*" must resolve within its OWN
  // subtree, not accidentally hit App A's files of the same name.
  write("appB/tsconfig.json", `{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }`);
  write("appB/components/button.tsx", `export const Button = 2;`);
  write("appB/app/page.tsx", `import { Button } from "@/components/button";`);

  // App C: extends a base config that declares the alias; the child declares none of its own,
  // so it must inherit rather than lose path resolution entirely.
  write("appC/tsconfig.base.json", `{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }`);
  write("appC/tsconfig.json", `{ "extends": "./tsconfig.base.json" }`);
  write("appC/lib/util.ts", `export const util = 3;`);
  write("appC/app/page.tsx", `import { util } from "@/lib/util";`);

  // App D: two overlapping patterns -- the more specific "@/lib/*" must win over the general "@/*".
  write("appD/tsconfig.json", `{ "compilerOptions": { "paths": { "@/*": ["./*"], "@/lib/*": ["./shared/*"] } } }`);
  write("appD/shared/special.ts", `export const special = 4;`);
  write("appD/components/special.ts", `export const wrongOne = "should not be picked";`);
  write("appD/app/page.tsx", `import { special } from "@/lib/special";`);

  const { graph } = await buildImportGraph(dir);

  assert.ok(graph.hasEdge("appA/app/page.tsx", "appA/components/button.tsx"), 'basic "@/*" alias must resolve');
  assert.ok(
    graph.hasEdge("appB/app/page.tsx", "appB/components/button.tsx"),
    "each app's alias must resolve within its own subtree, not cross into a sibling app",
  );
  assert.ok(!graph.hasEdge("appB/app/page.tsx", "appA/components/button.tsx"), "must not cross into the sibling app");
  assert.ok(graph.hasEdge("appC/app/page.tsx", "appC/lib/util.ts"), "paths inherited via extends must resolve");
  assert.ok(
    graph.hasEdge("appD/app/page.tsx", "appD/shared/special.ts"),
    "the more specific @/lib/* pattern must win over the general @/*",
  );
  assert.ok(!graph.hasEdge("appD/app/page.tsx", "appD/components/special.ts"), "the less specific pattern must not also match");

  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Python's relative-import level (each leading dot) walks up one directory per dot beyond
 * the first, and "from X import Y" is ambiguous between Y being a symbol inside X and Y
 * being a submodule of X -- both are common, and getting either wrong silently drops most
 * of a real Python codebase's internal graph, the same failure mode the ESM ".js" rewrite
 * above exists to catch for TypeScript.
 */
async function pythonImports() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartograph-py-"));
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };

  write("main.py", `import pkg.mod\nfrom pkg import HELPER\n`);
  write("pkg/__init__.py", `HELPER = 1\n`);
  write("pkg/mod.py", `X = 1\n`);
  write("pkg/sub/__init__.py", ``);
  write("pkg/sub/a.py", `from . import b\n`); // level 1: same directory
  write("pkg/sub/b.py", `X = 1\n`);
  write("pkg/sub/c.py", `from .. import mod\n`); // level 2: up to pkg/, hits pkg/mod.py directly

  const { graph } = await buildImportGraph(dir);

  assert.ok(graph.hasEdge("main.py", "pkg/mod.py"), 'absolute "import pkg.mod" must resolve to pkg/mod.py');
  assert.ok(
    graph.hasEdge("main.py", "pkg/__init__.py"),
    'from pkg import HELPER: HELPER is a symbol not a submodule, so this must fall back to resolving "pkg" itself',
  );
  assert.ok(graph.hasEdge("pkg/sub/a.py", "pkg/sub/b.py"), "level-1 relative import must stay in the same directory");
  assert.ok(
    graph.hasEdge("pkg/sub/c.py", "pkg/mod.py"),
    "level-2 relative import must go up exactly one directory from the importing file's own package",
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

/** A trailing newline terminates the last line; counting it as one inflates every file by 1. */
function lineCounting() {
  assert.strictEqual(countLines(""), 0, "empty file has no lines");
  assert.strictEqual(countLines("a"), 1);
  assert.strictEqual(countLines("a\n"), 1, "trailing newline must not add a line");
  assert.strictEqual(countLines("a\nb"), 2);
  assert.strictEqual(countLines("a\nb\n"), 2, "trailing newline must not add a line");
  assert.strictEqual(countLines("\n"), 1, "a lone newline is one empty line");
  assert.strictEqual(countLines("a\n\n"), 2, "a deliberate blank last line still counts");
}

/** A directory the scanner cannot read must cost only that directory, not the whole scan. */
async function unreadableFilesAreSkipped() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartograph-perm-"));
  fs.writeFileSync(path.join(dir, "ok.js"), `require('./other');`);
  fs.writeFileSync(path.join(dir, "other.js"), `module.exports = 1;`);
  const locked = path.join(dir, "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "hidden.js"), `module.exports = 2;`);
  fs.chmodSync(locked, 0o000);

  try {
    const { graph } = await buildImportGraph(dir);
    assert.ok(graph.hasNode("ok.js"), "readable files must still be scanned");
    assert.ok(graph.hasEdge("ok.js", "other.js"), "edges among readable files must survive");
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Monorepo packages import each other by bare name ("@scope/pkg"), not by relative path.
 * Treating those as external dependencies silently drops most of a monorepo's internal graph.
 */
async function monorepoWorkspaceImports() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartograph-mono-"));
  const pkg = (dirName: string, name: string) => {
    fs.mkdirSync(path.join(dir, "packages", dirName, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", dirName, "package.json"), JSON.stringify({ name }));
  };
  // "@fix/renamed" deliberately lives in a directory that does NOT match its package name --
  // the case naive name-to-directory guessing gets wrong (cf. @vue/compat in packages/vue-compat).
  pkg("shared", "@fix/shared");
  pkg("odd-dirname", "@fix/renamed");
  pkg("app", "@fix/app");
  fs.writeFileSync(path.join(dir, "packages", "shared", "src", "index.ts"), `export const s = 1;`);
  fs.writeFileSync(path.join(dir, "packages", "odd-dirname", "src", "index.ts"), `export const r = 2;`);
  fs.writeFileSync(
    path.join(dir, "packages", "app", "src", "main.ts"),
    `import { s } from "@fix/shared";\nimport { r } from "@fix/renamed";\nimport express from "express";\n`,
  );

  const { graph } = await buildImportGraph(dir);
  assert.ok(
    graph.hasEdge("packages/app/src/main.ts", "packages/shared/src/index.ts"),
    'bare "@fix/shared" must resolve to the workspace package source',
  );
  assert.ok(
    graph.hasEdge("packages/app/src/main.ts", "packages/odd-dirname/src/index.ts"),
    'package name must be read from package.json, not inferred from the directory name',
  );
  // A genuine node_modules dependency must still be excluded rather than invented as a node.
  assert.ok(!graph.hasNode("express"), "external dependencies must not become graph nodes");
  assert.strictEqual(graph.size, 2, "expected exactly 2 edges (external import excluded)");

  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * TypeScript ESM requires importing "./x.js" when the file on disk is "./x.ts".
 * Getting this wrong yields an edgeless graph and uniform centrality — a silent
 * failure that still reports a successful scan.
 */
async function tsEsmExtensionRewrite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartograph-tsesm-"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "entry.ts"), `import { a } from "./sub/dep.js";\nimport { b } from "./sub/index.js";\n`);
  fs.writeFileSync(path.join(dir, "sub", "dep.ts"), `export const a = 1;`);
  fs.writeFileSync(path.join(dir, "sub", "index.ts"), `export const b = 2;`);

  const { graph } = await buildImportGraph(dir);
  assert.ok(graph.hasEdge("entry.ts", "sub/dep.ts"), 'import "./sub/dep.js" must resolve to sub/dep.ts');
  assert.ok(graph.hasEdge("entry.ts", "sub/index.ts"), 'import "./sub/index.js" must resolve to sub/index.ts');
  assert.strictEqual(graph.size, 2, "expected exactly 2 edges");

  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildImportGraph } from "./build.js";
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
  console.log("OK: graph.test.ts passed");
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

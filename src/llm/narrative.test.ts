import assert from "node:assert";
import { parseJsonObject, applyNarrative } from "./narrative.js";
import type { CartographManifest } from "../output/cartographJson.js";

// Models routinely wrap the object in prose or ```json fences.
const fenced = 'Sure! Here you go:\n```json\n{"clusters": {"0": "Auth"}, "files": {"a.ts": "Does a thing."}}\n```\nHope that helps!';
const parsed = parseJsonObject(fenced);
assert.strictEqual(parsed.clusters?.["0"], "Auth", "should unwrap fenced JSON");
assert.strictEqual(parsed.files?.["a.ts"], "Does a thing.");

assert.throws(() => parseJsonObject("no json at all here"), /No JSON object/);

const manifest: CartographManifest = {
  repo: "fixture",
  generated_at: "now",
  language: "javascript/typescript",
  nodes: [
    { id: "a.ts", centrality: 0.5, cluster: 0, loc: 10 },
    { id: "b.ts", centrality: 0.1, cluster: 1, loc: 20 },
  ],
  edges: [],
  clusters: [
    { id: 0, files: ["a.ts"] },
    { id: 1, files: ["b.ts"] },
  ],
};

// Cluster ids are numbers, JSON keys are strings — this is the join that can silently no-op.
const counts = applyNarrative(manifest, parsed);
assert.strictEqual(counts.clusters, 1, "numeric cluster id should match its string JSON key");
assert.strictEqual(counts.files, 1);
assert.strictEqual(manifest.clusters[0].label, "Auth");
assert.strictEqual(manifest.nodes[0].description, "Does a thing.");
assert.strictEqual(manifest.clusters[1].label, undefined, "unnamed clusters stay unlabelled");
assert.strictEqual(manifest.nodes[1].description, undefined);

console.log("OK: narrative.test.ts passed");

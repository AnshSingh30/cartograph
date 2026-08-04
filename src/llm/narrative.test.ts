import assert from "node:assert";
import { parseJsonObject, applyNarrative, selectFilesToDescribe } from "./narrative.js";
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
const counts = applyNarrative(manifest, parsed, new Set(["a.ts"]));
assert.strictEqual(counts.clusters, 1, "numeric cluster id should match its string JSON key");
assert.strictEqual(counts.files, 1);
assert.strictEqual(manifest.clusters[0].label, "Auth");
assert.strictEqual(manifest.nodes[0].description, "Does a thing.");
assert.strictEqual(manifest.clusters[1].label, undefined, "unnamed clusters stay unlabelled");
assert.strictEqual(manifest.nodes[1].description, undefined);

// Verified against real output on axios: models will confidently describe a file they only
// saw the name of (from the cluster listing, which names every file for context) even when
// told not to. b.ts's content was never shown to the model (not in describedFiles) but the
// model supplied a description for it anyway -- this must be discarded, not trusted.
const hallucinated: CartographManifest = {
  repo: "fixture",
  generated_at: "now",
  language: "javascript/typescript",
  nodes: [
    { id: "a.ts", centrality: 0.5, cluster: 0, loc: 10 },
    { id: "b.ts", centrality: 0.1, cluster: 1, loc: 20 },
  ],
  edges: [],
  clusters: [{ id: 0, files: ["a.ts", "b.ts"] }],
};
const modelOverreach = { clusters: {}, files: { "a.ts": "Does a thing.", "b.ts": "Guessed from the filename." } };
const guarded = applyNarrative(hallucinated, modelOverreach, new Set(["a.ts"]));
assert.strictEqual(guarded.files, 1, "only the file actually shown to the model may be described");
assert.strictEqual(hallucinated.nodes[0].description, "Does a thing.");
assert.strictEqual(
  hallucinated.nodes[1].description,
  undefined,
  "a description for a file whose content was never shown must be discarded, not trusted",
);

// An uncapped topPerCluster times out the LLM call on a real repo with many clusters
// (measured on vuejs/core: 42 clusters * 3 = up to 126 files sent, response alone exceeded
// the 120s client timeout). A synthetic repo with 100 clusters reproduces the shape of that
// without needing a real large repo or a live API call.
const manyClusters: CartographManifest = {
  repo: "fixture",
  generated_at: "now",
  language: "javascript/typescript",
  nodes: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}/a.ts`, centrality: 1 / (i + 1), cluster: i, loc: 10 })),
  edges: [],
  clusters: Array.from({ length: 100 }, (_, i) => ({ id: i, files: [`c${i}/a.ts`] })),
};
const capped = selectFilesToDescribe(manyClusters, 3);
assert.ok(capped.length <= 60, `expected the file budget to stay capped, got ${capped.length}`);

// The round-robin ordering (every cluster's best file, then every cluster's second-best...)
// means a capped budget still favors breadth over exhausting one cluster's full quota first.
const wide: CartographManifest = {
  repo: "fixture",
  generated_at: "now",
  language: "javascript/typescript",
  nodes: [
    { id: "a1.ts", centrality: 0.9, cluster: 0, loc: 10 },
    { id: "a2.ts", centrality: 0.8, cluster: 0, loc: 10 },
    { id: "b1.ts", centrality: 0.5, cluster: 1, loc: 10 },
  ],
  edges: [],
  clusters: [
    { id: 0, files: ["a1.ts", "a2.ts"] },
    { id: 1, files: ["b1.ts"] },
  ],
};
const roundRobin = selectFilesToDescribe(wide, 2);
assert.deepStrictEqual(
  roundRobin,
  ["a1.ts", "b1.ts", "a2.ts"],
  "cluster 1's only file must be picked before cluster 0's second file, not after",
);

console.log("OK: narrative.test.ts passed");

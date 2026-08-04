import assert from "node:assert";
import { buildAgentsMd } from "./agentsMd.js";
import type { CartographManifest } from "./cartographJson.js";

function manifest(edges: CartographManifest["edges"], clusters: CartographManifest["clusters"]): CartographManifest {
  const nodes = clusters.flatMap((c) => c.files.map((id) => ({ id, centrality: 0.1, cluster: c.id, loc: 10 })));
  return { repo: "fixture", generated_at: "now", language: "javascript/typescript", nodes, edges, clusters };
}

// A clean layering -- one cluster depends on another, never the reverse -- is exactly the
// convention FR1.6 asks AGENTS.md to surface, and it must come from the graph, not a guess.
const layered = buildAgentsMd(
  manifest(
    [
      { from: "handlers/a.ts", to: "db/client.ts", type: "import" },
      { from: "handlers/b.ts", to: "db/client.ts", type: "import" },
    ],
    [
      { id: 0, label: "Handlers", files: ["handlers/a.ts", "handlers/b.ts"] },
      { id: 1, label: "DB", files: ["db/client.ts"] },
    ],
  ),
);
assert.match(layered, /## Conventions/);
assert.match(layered, /Handlers \(cluster 0\) depends on DB \(cluster 1\) \(2 imports\), never the reverse/);

// Two clusters importing each other is a cycle between subsystems -- a genuine architecture
// smell, and the opposite conclusion from the unidirectional case, so it must be labelled
// distinctly rather than silently reported as just another "depends on" line.
const cyclic = buildAgentsMd(
  manifest(
    [
      { from: "a/x.ts", to: "b/y.ts", type: "import" },
      { from: "b/y.ts", to: "a/x.ts", type: "import" },
    ],
    [
      { id: 0, files: ["a/x.ts"] },
      { id: 1, files: ["b/y.ts"] },
    ],
  ),
);
assert.match(cyclic, /import each other/, "bidirectional cluster edges must be flagged as a cycle, not a layering rule");

// Clusters with no edges between them at all have nothing to report -- the section should
// not appear rather than padding the output with an empty or vacuous heading.
const isolated = buildAgentsMd(
  manifest(
    [],
    [
      { id: 0, files: ["a.ts"] },
      { id: 1, files: ["b.ts"] },
    ],
  ),
);
assert.ok(!isolated.includes("## Conventions"), "no inter-cluster edges means no Conventions section");

console.log("OK: agentsMd.test.ts passed");

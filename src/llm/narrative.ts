import fs from "node:fs";
import path from "node:path";
import { generateText } from "./provider.js";
import type { CartographManifest } from "../output/cartographJson.js";

const HEAD_LINES = 40;

export interface NarrativeResponse {
  clusters?: Record<string, string>;
  files?: Record<string, string>;
}

/** Models like to wrap JSON in prose or fences; take the outermost object. */
export function parseJsonObject(raw: string): NarrativeResponse {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`No JSON object in model response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function buildPrompt(manifest: CartographManifest, repoRoot: string, topFiles: string[]): string {
  const importsOf = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  for (const edge of manifest.edges) {
    if (!importsOf.has(edge.from)) importsOf.set(edge.from, []);
    if (!importedBy.has(edge.to)) importedBy.set(edge.to, []);
    importsOf.get(edge.from)!.push(edge.to);
    importedBy.get(edge.to)!.push(edge.from);
  }

  const clusterBlock = manifest.clusters
    .map((c) => `- Cluster ${c.id}: ${c.files.slice(0, 25).join(", ")}`)
    .join("\n");

  const fileBlock = topFiles
    .map((id) => {
      let head = "";
      try {
        head = fs.readFileSync(path.join(repoRoot, id), "utf8").split("\n").slice(0, HEAD_LINES).join("\n");
      } catch {
        head = "(unreadable)";
      }
      return [
        `### ${id}`,
        `imports: ${(importsOf.get(id) ?? []).join(", ") || "(none)"}`,
        `imported by: ${(importedBy.get(id) ?? []).join(", ") || "(none)"}`,
        "```",
        head,
        "```",
      ].join("\n");
    })
    .join("\n\n");

  return `You are documenting the repository "${manifest.repo}" for engineers and coding agents.

Clusters were derived by Louvain community detection over the import graph:
${clusterBlock}

The highest-centrality files, with their import relationships and the first ${HEAD_LINES} lines of each:

${fileBlock}

Return ONLY a JSON object, no prose and no markdown fences:
{
  "clusters": { "<cluster id>": "<2-4 word plain-English subsystem name>" },
  "files": { "<file path>": "<1-2 sentences: what it does and why it is structurally important>" }
}
Name every cluster listed above. Describe every file listed above. Base descriptions on the code shown, not on guesses from the filename.`;
}

/** Merges a model response into the manifest in place. Cluster ids are numbers; JSON keys are strings. */
export function applyNarrative(
  manifest: CartographManifest,
  result: NarrativeResponse,
): { clusters: number; files: number } {
  let clusters = 0;
  for (const cluster of manifest.clusters) {
    const label = result.clusters?.[String(cluster.id)];
    if (label) {
      cluster.label = label;
      clusters++;
    }
  }

  let files = 0;
  for (const node of manifest.nodes) {
    const description = result.files?.[node.id];
    if (description) {
      node.description = description;
      files++;
    }
  }

  return { clusters, files };
}

/** Adds cluster labels and file descriptions in place. Returns the count of each. */
export async function describeManifest(
  manifest: CartographManifest,
  repoRoot: string,
  topN = 15,
): Promise<{ clusters: number; files: number }> {
  const topFiles = [...manifest.nodes]
    .sort((a, b) => b.centrality - a.centrality)
    .slice(0, topN)
    .map((n) => n.id);

  const raw = await generateText(buildPrompt(manifest, repoRoot, topFiles));
  return applyNarrative(manifest, parseJsonObject(raw));
}

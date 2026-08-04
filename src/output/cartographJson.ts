import type Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank.js";
import louvain from "graphology-communities-louvain";

export interface CartographNode {
  id: string;
  centrality: number;
  cluster: number;
  loc: number;
  description?: string;
}

export interface CartographEdge {
  from: string;
  to: string;
  type: "import";
}

export interface CartographCluster {
  id: number;
  label?: string;
  files: string[];
}

export interface CartographManifest {
  repo: string;
  generated_at: string;
  language: string;
  nodes: CartographNode[];
  edges: CartographEdge[];
  clusters: CartographCluster[];
}

/** Summarizes which of the supported languages are actually present, so a Python-only or
 * mixed repo doesn't get mislabeled as "javascript/typescript". */
function detectLanguages(ids: string[]): string {
  const hasJsTs = ids.some((id) => /\.(m|c)?(j|t)sx?$/.test(id));
  const hasPython = ids.some((id) => id.endsWith(".py"));
  if (hasJsTs && hasPython) return "javascript/typescript, python";
  if (hasPython) return "python";
  return "javascript/typescript";
}

export function buildManifest(
  repoName: string,
  graph: Graph,
  loc: Map<string, number>,
): CartographManifest {
  const centrality: Record<string, number> = graph.order > 0 ? pagerank(graph) : {};
  const communities: Record<string, number> = graph.order > 0 ? louvain(graph) : {};

  const clusterFiles = new Map<number, string[]>();
  for (const id of graph.nodes()) {
    const cluster = communities[id] ?? 0;
    if (!clusterFiles.has(cluster)) clusterFiles.set(cluster, []);
    clusterFiles.get(cluster)!.push(id);
  }

  const nodes: CartographNode[] = graph.nodes().map((id) => ({
    id,
    centrality: centrality[id] ?? 0,
    cluster: communities[id] ?? 0,
    loc: loc.get(id) ?? 0,
  }));

  const edges: CartographEdge[] = [];
  graph.forEachEdge((_edge, _attrs, source, target) => {
    edges.push({ from: source, to: target, type: "import" });
  });

  const clusters: CartographCluster[] = [...clusterFiles.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, files]) => ({ id, files }));

  return {
    repo: repoName,
    generated_at: new Date().toISOString(),
    language: detectLanguages(graph.nodes()),
    nodes,
    edges,
    clusters,
  };
}

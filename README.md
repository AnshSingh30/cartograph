# Cartograph

**Every coding agent already computes, privately and from scratch each session, which files in your repo actually matter. Cartograph is the persisted, cross-tool, human-readable record of that.**

Aider computes a repo map with PageRank. Claude Code explores live with grep and glob. Cursor keeps its own index. All three work — and all three are ephemeral, single-tool, and invisible to humans. None of them leave behind an artifact a teammate can read, a reviewer can check, or another agent can load.

Cartograph produces that artifact: `cartograph.json` for machines and `AGENTS.md` for humans and agents alike.

> **Status: v0.1, in progress.** The structure layer and its visual map work and are validated on real repos. CI integration is not built yet — see [Current limitations](#current-limitations). This README describes only what runs today.

---

## Quickstart

```bash
git clone https://github.com/AnshSingh30/cartograph.git
cd cartograph
npm install

npx tsx src/cli.ts scan /path/to/your/repo --out ./cartograph-output
npx tsx src/cli.ts serve ./cartograph-output
```

That runs **fully offline**. No API key, no network, no account.

### The map

`serve` opens an interactive drawing of the scan on `localhost` — node size is how much depends on a file, lines are imports, and files are grouped into the subsystems Louvain found. Click any file for its description, who imports it, what it imports, and its rank.

```bash
npx tsx src/cli.ts serve ./cartograph-output --port 4173   # default port
npx tsx src/cli.ts serve ./cartograph-output --no-open      # don't launch a browser
```

The page is a single self-contained file with the manifest inlined — no CDN, no webfonts, no telemetry, no network calls of any kind. It re-reads `cartograph.json` on every refresh, so a re-scan shows up without restarting the server.

To get that same page as a file you can commit, email, or host anywhere:

```bash
npx tsx src/cli.ts export ./cartograph-output --out map.html
```

One HTML file, opens straight from `file://` with no server.

### Installing it properly

```bash
npm install && npm run build
node dist/cli.js scan /path/to/repo      # or `npm link` for a global `cartograph`
```

### Optional: plain-English descriptions

To have an LLM name each subsystem and describe the load-bearing files, copy `.env.example` to `.env` and add a key:

```bash
cp .env.example .env
# then edit .env:
#   OPENROUTER_API_KEY=sk-or-v1-...
#   CARTOGRAPH_MODEL=anthropic/claude-opus-5

npx tsx src/cli.ts scan /path/to/your/repo --describe
```

Works with either **Anthropic** (`ANTHROPIC_API_KEY`) or **OpenRouter** (`OPENROUTER_API_KEY`) — set whichever you have. This step is opt-in behind `--describe`, so a scan never spends credits unless you ask it to. If the call fails, the scan still writes its rule-based output rather than losing your work.

---

## What it produces

Two files. Both are committable, diffable, and tool-agnostic.

### `AGENTS.md`

Real output from scanning [expressjs/express](https://github.com/expressjs/express), trimmed:

```markdown
## Load-bearing files (by import centrality)

- `lib/utils.js` — cluster 2, 272 LOC, centrality 0.2450
  - Provides shared pure utilities: lowercased HTTP methods list, ETag
    generators, content-type normalization, query parser compilation, and
    trust proxy compilation. It has no internal dependencies and is used by
    Application and Response.
- `lib/express.js` — cluster 0, 82 LOC, centrality 0.1540
  - Exports createApplication() which constructs an Express app by combining
    Router middleware handling with Application prototype...

## Subsystem map

### Core Express Factory (cluster 0) — 3 files
- `index.js`
- `lib/express.js`
- `lib/request.js`
```

Plain markdown with no vendor-specific syntax — paste it into Claude Code, Cursor, Aider, or a PR description.

### `cartograph.json`

```json
{
  "repo": "express",
  "generated_at": "2026-08-03T09:59:06.310Z",
  "language": "javascript/typescript",
  "nodes": [
    {
      "id": "lib/utils.js",
      "centrality": 0.2449983669640,
      "cluster": 2,
      "loc": 272,
      "description": "Provides shared pure utilities..."
    }
  ],
  "edges": [{ "from": "index.js", "to": "lib/express.js", "type": "import" }],
  "clusters": [
    { "id": 0, "label": "Core Express Factory", "files": ["index.js", "lib/express.js", "lib/request.js"] }
  ]
}
```

---

## How the ranking works

Two standard algorithms, no custom scoring:

- **Importance — PageRank** over the directed import graph, where an edge runs `importer → imported`. A file gains rank from every file that imports it, the same way a web page gains rank from inbound links. This is why `lib/utils.js` tops the Express list: it has the most inbound edges (`lib/application.js` and `lib/response.js`), and both of those are themselves imported by the app factory — rank flows through.
- **Subsystems — Louvain community detection**, grouping files that import each other densely while staying sparsely connected to the rest.

Parsing is [tree-sitter](https://tree-sitter.github.io/), so the import extraction is real syntax analysis rather than regex — it handles ESM `import`, CommonJS `require()`, dynamic `import()`, and TypeScript's `import x = require()`.

**Monorepos are handled.** Workspace packages that import each other by name (`@scope/pkg`) are resolved by reading the `name` field of every `package.json`, so packages whose directory differs from their published name still link up correctly. Genuine `node_modules` dependencies stay excluded from the graph.

Anything an LLM contributes is **narration only**. It never influences the ranking or the clustering.

## Performance

| Repo | Files scanned | LOC | Parse + graph build |
|---|---|---|---|
| [vuejs/core](https://github.com/vuejs/core) | 320 | 66,305 | **~0.7s** |
| [expressjs/express](https://github.com/expressjs/express) | 7 | 2,776 | **~0.04s** |

Median of 3 runs on an M-series MacBook Air, excluding the optional `--describe` pass. Reproduce with `npx tsx src/cli.ts scan <repo>` — the CLI prints its own timing.

Memory is dominated by loading the tree-sitter grammar, not by repo size: about **1.6 GB fixed** for TypeScript (570 MB for JavaScript only), plus roughly 4 MB per file. Measured by scanning single Vue packages — 13 files and 65 files land within 220 MB of each other. Fine on a laptop or a CI runner; worth knowing before running it in a memory-capped container.

## Privacy

Parsing and graph analysis are **100% local** — deterministic, free, and offline. No API key is needed to produce a usable map, so Cartograph runs on private, proprietary, or air-gapped repositories with nothing leaving the machine.

The only step that makes a network call is `--describe`, which is opt-in.

---

## Current limitations

Stated plainly, because a map you can't trust the boundaries of isn't much of a map:

- **JavaScript and TypeScript only.** Python is planned but not implemented.
- **Import edges only.** Function/class definitions and call references are not yet extracted, so the graph captures module structure rather than call flow.
- **Monorepo subpath imports are not resolved.** Bare workspace imports (`@scope/pkg`) resolve correctly, but deep ones (`@scope/pkg/submodule`) are still treated as external.
- **Descriptions cover the top ~15 files repo-wide,** not the top files *per cluster*. On a large repo most clusters get a name but no per-file prose.
- **The map is a layout, not a floorplan.** Node positions come from a force simulation seeded by cluster, so they are stable in character but not identical between runs. Files with no imports either way are parked in a labelled margin block rather than placed by physics.
- **Tests and examples are excluded** from the graph by default, since test helpers otherwise crowd out application code in the ranking.
- **The map uses system fonts,** not the webfonts in the original design, so that `serve` makes no network requests at all.

## Roadmap

- [x] **Layer 1 — Structure.** "What should the agent know?" Import graph, centrality, clustering, `AGENTS.md` + `cartograph.json`.
  - [x] CLI, tree-sitter parsing, PageRank, Louvain, LLM narration
  - [x] Interactive visual map (`cartograph serve`)
  - [ ] GitHub Action to keep output fresh on every merge
- [ ] **Layer 2 — Trust.** "What shouldn't it trust?" Scanner for hidden instructions in repo content and dependency source, with a published labeled corpus. No accuracy number will be claimed without the dataset that produced it.
- [ ] **Layer 3 — Replay.** "What did it actually do?" Overlay an agent run's real file reads and edits onto the same map.

## How this differs from existing tools

| Tool | What it does | How Cartograph differs |
|---|---|---|
| **Aider repo map** | Runtime PageRank over an import graph, sent fresh with each request | Ephemeral, single-tool, no UI, no persistence. Cartograph persists, versions, and visualizes the same *kind* of signal, portably. |
| **Claude Code / agentic search** | Live grep and glob exploration, no pre-built map | Produces no artifact at all. Cartograph doesn't compete — it complements, giving the agent a starting map instead of a cold start. |
| **Cursor indexing** | Proprietary embedding index, per-editor | Closed and single-tool; not portable to CI or to another agent. |
| **Langfuse / LangSmith** | Full trace and span observability for LLM apps | General-purpose and much heavier. Layer 3 is scoped narrowly to file-path traces on Cartograph's own map, not a competing observability platform. |

**Cartograph does not claim to out-retrieve retrieval.** Aider's repo map, Claude Code's agentic search, and Cursor's index are runtime mechanisms that work well. Cartograph is the artifact layer none of them produce.

## Development

```bash
npm test                        # assert-based self-checks, no framework
./node_modules/.bin/tsc --noEmit  # typecheck
npx tsx src/cli.ts scan .       # dogfood: scan Cartograph itself
```

## License

MIT — see [LICENSE](LICENSE).

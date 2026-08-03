#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { buildImportGraph } from "./graph/build.js";
import { buildManifest } from "./output/cartographJson.js";
import { buildAgentsMd } from "./output/agentsMd.js";
import { describeManifest } from "./llm/narrative.js";
import { serve } from "./serve.js";

// Load .env from the working directory. Shell-exported vars take precedence.
if (fs.existsSync(".env")) process.loadEnvFile();

const program = new Command();

program.name("cartograph").description("Structural map of your repo for humans and coding agents.");

program
  .command("scan")
  .argument("<path>", "path to the repo to scan")
  .option("-o, --out <dir>", "output directory", ".")
  .option("--describe", "use an LLM to name clusters and describe top files (costs API credits)")
  .action(async (targetPath: string, opts: { out: string; describe?: boolean }) => {
    const repoRoot = path.resolve(targetPath);
    const repoName = path.basename(repoRoot);

    console.log(`Scanning ${repoRoot} ...`);
    const start = Date.now();
    const { graph, loc } = await buildImportGraph(repoRoot);
    console.log(`Parsed ${graph.order} files, ${graph.size} import edges in ${Date.now() - start}ms.`);

    const manifest = buildManifest(repoName, graph, loc);

    if (opts.describe) {
      console.log("Generating descriptions ...");
      try {
        const { clusters, files } = await describeManifest(manifest, repoRoot);
        console.log(`Labelled ${clusters} clusters, described ${files} files.`);
      } catch (err) {
        // The graph is already built; fall back to rule-based output rather than lose the scan.
        console.error(`Descriptions failed: ${err instanceof Error ? err.message : err}`);
        console.error("Writing rule-based output instead.");
      }
    }

    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "cartograph.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, "AGENTS.md"), buildAgentsMd(manifest));
    console.log(`Wrote cartograph.json and AGENTS.md to ${outDir}`);
  });

program
  .command("serve")
  .description("open the interactive map for an existing scan")
  .argument("[dir]", "directory containing cartograph.json", ".")
  .option("-p, --port <n>", "port to listen on", "4173")
  .option("--no-open", "do not open a browser")
  .action((dir: string, opts: { port: string; open: boolean }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exit(1);
    }
    serve(dir, port, opts.open);
  });

program.parse();

#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { buildImportGraph } from "./graph/build.js";
import { buildManifest } from "./output/cartographJson.js";
import { buildAgentsMd } from "./output/agentsMd.js";

const program = new Command();

program.name("cartograph").description("Structural map of your repo for humans and coding agents.");

program
  .command("scan")
  .argument("<path>", "path to the repo to scan")
  .option("-o, --out <dir>", "output directory", ".")
  .action(async (targetPath: string, opts: { out: string }) => {
    const repoRoot = path.resolve(targetPath);
    const repoName = path.basename(repoRoot);

    console.log(`Scanning ${repoRoot} ...`);
    const start = Date.now();
    const { graph, loc } = await buildImportGraph(repoRoot);
    console.log(`Parsed ${graph.order} files, ${graph.size} import edges in ${Date.now() - start}ms.`);

    const manifest = buildManifest(repoName, graph, loc);
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "cartograph.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, "AGENTS.md"), buildAgentsMd(manifest));
    console.log(`Wrote cartograph.json and AGENTS.md to ${outDir}`);
  });

program.parse();

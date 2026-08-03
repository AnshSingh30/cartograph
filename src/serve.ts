import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";

/** Inlines the manifest into the UI shell. `<` is escaped so a file path can never close the script tag. */
export function render(shell: string, manifest: string): string {
  return shell.replace("__CARTOGRAPH_DATA__", manifest.replace(/</g, "\\u003c"));
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Best-effort: the URL is printed regardless, so a missing opener is not an error.
  exec(`${cmd} ${url}`, () => {});
}

export function serve(dir: string, port: number, open: boolean): void {
  const outDir = path.resolve(dir);
  const manifestPath = path.join(outDir, "cartograph.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`No cartograph.json in ${outDir}.`);
    console.error(`Run: npx tsx src/cli.ts scan <repo> --out ${dir}`);
    process.exit(1);
  }

  const shellPath = path.join(import.meta.dirname, "ui", "app.html");
  const server = http.createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404).end("Not found");
      return;
    }
    // Both files are re-read per request so a re-scan shows up on refresh.
    try {
      const html = render(fs.readFileSync(shellPath, "utf8"), fs.readFileSync(manifestPath, "utf8"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    } catch (err) {
      res.writeHead(500).end(`Failed to read map: ${err instanceof Error ? err.message : err}`);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is in use. Try: --port ${port + 1}`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`Cartograph map for ${path.basename(outDir)} at ${url}`);
    console.log("Ctrl-C to stop. Nothing leaves this machine.");
    if (open) openBrowser(url);
  });
}

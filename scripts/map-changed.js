#!/usr/bin/env node
// Exits non-zero if the freshly generated manifest differs from the committed one in
// any way other than its timestamp.
//
// `generated_at` moves on every single run, so a plain `git diff` is always dirty and
// would fail every pull request. Comparing the manifests with that field removed is the
// only way "is this map stale?" gives a useful answer.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const file = process.argv[2];
if (!file) {
  console.error("usage: map-changed.js <path-to-cartograph.json>");
  process.exit(2);
}

/** The manifest minus the one field that changes even when nothing else does. */
function withoutTimestamp(raw) {
  const { generated_at, ...rest } = JSON.parse(raw);
  return JSON.stringify(rest);
}

let committed;
try {
  // stderr is discarded so git's own "invalid object name" noise doesn't bury our message.
  committed = execFileSync("git", ["show", `HEAD:${file}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  console.error(`${file} has never been committed. Run the scan and commit the result.`);
  process.exit(1);
}

let current;
try {
  current = fs.readFileSync(file, "utf8");
} catch {
  console.error(`${file} was not generated.`);
  process.exit(1);
}

if (withoutTimestamp(current) === withoutTimestamp(committed)) {
  console.log("Map is current — only the timestamp moved.");
  process.exit(0);
}

console.error(`::error::${file} is out of date. Re-run the scan and commit the result.`);
process.exit(1);

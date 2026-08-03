import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { render, assertManifest } from "./serve.js";

// A repo can legitimately contain a file named `</script>...`. Injecting the manifest
// raw would let that path close the script tag and turn scanned source into live markup.
const hostile = JSON.stringify({
  repo: "evil",
  nodes: [{ id: "src/</script><img src=x onerror=alert(1)>.ts", centrality: 1, cluster: 0, loc: 1 }],
});

const out = render('<script id="data" type="application/json">__CARTOGRAPH_DATA__</script>', hostile);

assert.ok(!out.includes("</script><img"), "manifest must not be able to close the script tag");
assert.ok(out.includes("\\u003c/script>"), "`<` should be escaped as \\u003c");
// Escaping must survive a round trip: the browser has to read back the original path.
const inner = out.slice(out.indexOf(">") + 1, out.lastIndexOf("</script>"));
assert.strictEqual(
  JSON.parse(inner).nodes[0].id,
  "src/</script><img src=x onerror=alert(1)>.ts",
  "escaped manifest must still parse back to the original path",
);

// The shipped shell must carry the placeholder, or serve would silently return an empty map.
const shell = fs.readFileSync(path.join(import.meta.dirname, "ui", "app.html"), "utf8");
assert.ok(shell.includes("__CARTOGRAPH_DATA__"), "app.html must contain the data placeholder");

// JSON that parses but isn't a manifest used to load a blank page and fail in the browser
// console, which reads as a broken UI rather than "you pointed me at the wrong file".
assertManifest('{"nodes":[],"edges":[]}');
assert.throws(() => assertManifest("{ not json"), /not valid JSON/);
assert.throws(() => assertManifest('{"hello":"world"}'), /nodes.*edges/);
assert.throws(() => assertManifest('{"nodes":{},"edges":[]}'), /nodes.*edges/);
assert.throws(() => assertManifest("null"), /nodes.*edges/);

console.log("OK: serve.test.ts passed");

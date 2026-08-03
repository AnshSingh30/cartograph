import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { render } from "./serve.js";

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

console.log("OK: serve.test.ts passed");

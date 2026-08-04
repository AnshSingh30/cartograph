import assert from "node:assert";
import { extractDefinitions } from "./imports.js";

async function main() {
  // A closure defined inside another function is an implementation detail, not something
  // this file exports -- listing it alongside real top-level definitions would make the
  // "what does this file define" hint noisy rather than useful. This exercises all four
  // capture shapes (function declaration, class, const-arrow, const-function-expression)
  // in both their top-level and nested form.
  const ts = `
export function foo() {}
export default function bar() {}
export class Baz {}
class Qux {}
export const handler = () => {};
const helper = function() {};
function outer() {
  function inner() {}
  const nested = () => {};
}
const notAFunc = 5;
`;
  const tsDefs = await extractDefinitions(ts, "typescript");
  assert.deepStrictEqual(
    new Set(tsDefs),
    new Set(["foo", "bar", "Baz", "Qux", "handler", "helper", "outer"]),
    "nested inner/nested must be excluded; notAFunc is not a function/class at all",
  );

  const py = `
def foo():
    def inner():
        pass
    pass

class Bar:
    def method(self):
        pass
`;
  const pyDefs = await extractDefinitions(py, "python");
  assert.deepStrictEqual(
    new Set(pyDefs),
    new Set(["foo", "Bar"]),
    "a method inside a class body and a function nested inside another function are both nested",
  );

  console.log("OK: imports.test.ts passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

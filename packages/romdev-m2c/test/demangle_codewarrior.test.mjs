// The self-test table from m2c/demangle_codewarrior.py (its `--test` mode),
// run against the JS port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demangle, TEST_CASES, test as selfTest } from "../src/demangle_codewarrior.js";

for (const [mangled, demangled] of TEST_CASES) {
  test(`demangle ${mangled}`, () => {
    assert.equal(demangle(mangled), demangled);
  });
}

test("self-test reports all cases passing", () => {
  assert.equal(selfTest(), true);
});

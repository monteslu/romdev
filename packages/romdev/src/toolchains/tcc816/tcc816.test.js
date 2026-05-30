// tcc-65816 → 65816 assembly smoke test.
//
// We don't yet ship wla-65816 + wlalink, so this only verifies the
// compile→.s step. The full C-to-SNES-ROM pipeline is pending.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTcc816 } from "./tcc816.js";

test("tcc816: compile a trivial C function to 65816 .s", async () => {
  const r = await runTcc816({
    source: "int main(void) { return 42; }\n",
  });
  assert.equal(r.exitCode, 0, "tcc816 exit: " + r.exitCode + " log:\n" + r.log);
  assert.ok(r.asmSource, "no asm output");
  // tcc-65816's hello world has a "main:" label and a wla-dx .SECTION header.
  assert.match(r.asmSource, /^\.include "hdr\.asm"/m, "missing .include hdr.asm header");
  assert.match(r.asmSource, /^main:/m, "missing main: label");
  assert.match(r.asmSource, /\.SECTION/, "missing .SECTION directive");
});

test("tcc816: header inclusion via -I/work works", async () => {
  const r = await runTcc816({
    source: '#include "shared.h"\nint main(void) { return MAGIC; }\n',
    headers: { "shared.h": "#define MAGIC 7\n" },
  });
  assert.equal(r.exitCode, 0, "tcc816 with header exit: " + r.exitCode + " log:\n" + r.log);
  assert.ok(r.asmSource, "no asm output");
});

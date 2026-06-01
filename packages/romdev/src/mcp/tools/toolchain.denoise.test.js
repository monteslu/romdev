// Unit tests for denoiseSuccessLog — strips GCC LTO interprocedural-optimization
// banners and the -ftime-report timing table from a SUCCESSFUL build log, so the
// linker-map / objcopy signal isn't crowded out of the tail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { denoiseSuccessLog } from "./toolchain.js";

test("strips the GCC -ftime-report timing table", () => {
  const log = [
    "--- ld ---",
    "linking objects",
    "Time variable                  usr    sys    wall    GGC",
    " phase setup                 : 0.00   0.00   0.00   1234k",
    " phase parsing               : 0.01   0.00   0.01   5678k",
    " TOTAL                       : 0.00   0.00   0.00   1542k",
    "objcopy: out.bin written (524288 bytes)",
  ].join("\n");
  const out = denoiseSuccessLog(log);
  assert.doesNotMatch(out, /Time variable/);
  assert.doesNotMatch(out, /phase parsing/);
  assert.doesNotMatch(out, /TOTAL/);
  // Signal survives.
  assert.match(out, /linking objects/);
  assert.match(out, /objcopy: out\.bin written/);
});

test("strips the LTO interprocedural-optimization phase dump", () => {
  const log = [
    "Performing interprocedural optimizations",
    " <*free_lang_data> {heap 32M} <visibility> {heap 32M} <build_ssa_passes> {heap 32M}",
    "compiling main.c",
    "objcopy done",
  ].join("\n");
  const out = denoiseSuccessLog(log);
  assert.doesNotMatch(out, /Performing interprocedural/);
  assert.doesNotMatch(out, /free_lang_data/);
  assert.match(out, /compiling main\.c/);
  assert.match(out, /objcopy done/);
});

test("leaves a clean log untouched", () => {
  const log = "--- m68k ---\ncompiling\nlinking\nobjcopy: ok\n";
  assert.equal(denoiseSuccessLog(log), log);
});

test("does not eat real content after the timing block ends", () => {
  const log = [
    "Time variable usr sys wall GGC",
    " TOTAL : 1 2 3 4k",
    "ERROR-LIKE LINE THAT SHOULD SURVIVE",
  ].join("\n");
  const out = denoiseSuccessLog(log);
  assert.match(out, /ERROR-LIKE LINE THAT SHOULD SURVIVE/);
  assert.doesNotMatch(out, /TOTAL/);
});

// "Good code from the agents that use romdev": a build's issues[] must put the
// dangerous diagnostics FIRST so a weak agent triaging the array can't skip a
// crash-class warning buried among unused-variable noise.
//
// Two parts:
//   1. preflight-lint marks the unconditional infinite-loop as `critical`.
//   2. rankIssues() orders critical → error → warning → info (stable within rank).

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSdccSource } from "../src/toolchains/sdcc/preflight-lint.js";
import { rankIssues } from "../src/toolchains/index.js";

test("uint8 loop-bound trap is flagged CRITICAL (it always hangs)", () => {
  // u8 counter can never reach 576 → infinite loop, no SDCC warning.
  const src = "void f(void){ unsigned char i; for (i = 0; i < 32*18; i++){ } }";
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  const hang = issues.find((i) => i.ref === "uint8-loop-bound");
  assert.ok(hang, "the infinite-loop is detected");
  assert.equal(hang.critical, true, "marked critical, not a plain warning");
  assert.match(hang.message, /WILL HANG/, "message leads with the consequence");
});

test("the VRAM byte-copy pattern stays a NON-critical warning (conditional)", () => {
  // dst[i]=src[i] only crashes IF dst is VRAM/__xdata — can't be proven
  // statically, so it must NOT cry wolf as critical on a plain WRAM array copy.
  const src = "void f(void){ for (i = 0; i < n; i++){ a[i] = b[i]; } }";
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  const copy = issues.find((i) => i.ref === "xdata-copy-miscompile");
  if (copy) {
    assert.notEqual(copy.critical, true, "conditional miscompile is not marked critical");
    assert.equal(copy.severity, "warning");
  }
});

test("rankIssues orders critical → error → warning → info, stable within a rank", () => {
  const input = [
    { severity: "warning", message: "unused variable a" },
    { severity: "error", message: "syntax error" },
    { severity: "warning", critical: true, message: "WILL HANG: infinite loop" },
    { severity: "warning", message: "unused variable b" },
    { severity: "info", message: "note" },
  ];
  const out = rankIssues(input);
  assert.match(out[0].message, /WILL HANG/, "critical first");
  assert.equal(out[1].message, "syntax error", "error second");
  assert.equal(out[2].message, "unused variable a", "warnings keep source order");
  assert.equal(out[3].message, "unused variable b");
  assert.equal(out[4].message, "note", "info last");
});

test("rankIssues is a no-op shape-wise on an empty / single-item list", () => {
  assert.deepEqual(rankIssues([]), []);
  const one = [{ severity: "warning", message: "x" }];
  assert.deepEqual(rankIssues(one), one);
});

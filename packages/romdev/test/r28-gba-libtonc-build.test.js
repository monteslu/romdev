// R28 — Game Boy Advance libtonc smoke test.
//
// Confirms the libtonc runtime path works end-to-end. libtonc is the
// new DEFAULT GBA C runtime as of R28 (replacing libgba — see PLAN.md
// + new_note_for_mcp_user.md for the rationale).
//
// Three paths exercised:
//   runtime: "libtonc" — Tonc tutorial alignment, TTE text engine
//   runtime: "libgba"  — devkitPro SDK (R24 backward compat)
//   runtime: "none"    — bare main() against raw GBA regs

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";

test("R28 GBA libtonc (default): #include <tonc.h> compiles + links", { timeout: 180000 }, async () => {
  // Default runtime is libtonc — no `runtime` arg needed.
  const r = await buildGbaC({
    source: `
#include <tonc.h>
int main(void) {
  REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;
  return 0;
}
`,
  });
  assert.equal(r.ok, true, `libtonc build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.equal(r.runtime, "libtonc");
  assert.ok(r.binary && r.binary.length > 256, `binary too small: ${r.binary?.length}`);
  // GBA cart format: first 4 bytes = ARM 'b' instruction.
  assert.equal(r.binary[3], 0xEA, "expected ARM 'b' at offset 0");
});

test("R28 GBA libtonc: TTE drawing actually links (tte_init_chr4c_default + tte_write)", { timeout: 180000 }, async () => {
  // TTE (Tonc Text Engine) is the headline libtonc feature — tile-text
  // rendering without needing libsysbase. This is the path that
  // replaces libgba's console.c for "Hello, World".
  const r = await buildGbaC({
    source: `
#include <tonc.h>
int main(void) {
  tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));
  REG_DISPCNT = DCNT_MODE0 | DCNT_BG0;
  tte_write("Hello, Tonc!");
  while (1) { VBlankIntrWait(); }
  return 0;
}
`,
  });
  assert.equal(r.ok, true, `TTE build failed at ${r.stage}: ${(r.log || "").slice(-800)}`);
  assert.equal(r.runtime, "libtonc");
  // TTE pulls in the font + a chunk of libtonc — expect a much bigger
  // ROM than the bare hello (R24 measured 32 KB for tonc_hello.c).
  assert.ok(r.binary.length > 4000,
    `TTE-using ROM should be substantial; got ${r.binary.length}`);
});

test("R28 GBA libgba opt-in still works after R28 default switch", { timeout: 180000 }, async () => {
  // R24 backward-compatibility check — anyone passing runtime:"libgba"
  // (or the legacy libgba:true flag) must keep getting the libgba path.
  const r = await buildGbaC({
    source: `
#include <gba.h>
int main(void) {
  REG_DISPCNT = MODE_3 | BG2_ON;
  return 0;
}
`,
    runtime: "libgba",
  });
  assert.equal(r.ok, true, `libgba build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.equal(r.runtime, "libgba");
});

test("R28 GBA legacy libgba:false flag still maps to runtime:none", { timeout: 120000 }, async () => {
  // R24 callers passing libgba:false got the bare path. That should
  // still work post-R28 even though the new way is runtime:"none".
  const r = await buildGbaC({
    source: "int main(void) { volatile int x = 7; return x + 1; }",
    libgba: false,
  });
  assert.equal(r.ok, true, `bare build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.equal(r.runtime, "minimal");
});

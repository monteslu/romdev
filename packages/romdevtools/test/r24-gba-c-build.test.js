// R24 — Game Boy Advance C tier-1 build smoke test.
//
// End-to-end check that the WASM toolchain (cc1-arm + arm-none-eabi-as
// + arm-none-eabi-ld + arm-none-eabi-objcopy) + bundled libgba runtime
// produces a loadable .gba ROM from a `#include <gba.h>` source.
//
// Two paths exercised:
//   libgba: false (minimum-viable) — bare main() against raw GBA regs
//   libgba: true  (full SDK)       — links libgba.a + libgcc + libc

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGbaC } from "romdev-platform-gba";

test("R24 GBA minimum-viable: bare main() compiles + links", { timeout: 120000 }, async () => {
  const r = await buildGbaC({
    source: "int main(void) { volatile int x = 7; return x + 1; }",
    libgba: false,
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.equal(r.runtime, "minimal");
  assert.ok(r.binary && r.binary.length > 0, "no binary produced");
});

test("R24 GBA libgba: #include <gba.h> + REG_DISPCNT compiles + links", { timeout: 180000 }, async () => {
  // Canonical GBA mode-3 demo. Sets up the framebuffer mode and turns
  // on BG2 (the only BG in mode 3). The libgba header chain pulls in
  // gba_video.h which exposes REG_DISPCNT / MODE_3 / BG2_ON.
  const r = await buildGbaC({
    source: `
#include <gba.h>
int main(void) {
  REG_DISPCNT = MODE_3 | BG2_ON;
  return 0;
}
`,
    libgba: true,
  });
  assert.equal(r.ok, true, `libgba build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.equal(r.runtime, "libgba");
  assert.ok(r.binary && r.binary.length > 256, `binary too small: ${r.binary?.length}`);

  // GBA cart format: first 4 bytes = ARM 'b' instruction branching
  // past the cart header. The branch encoding always ends in 0xEA
  // (unconditional 'b' opcode in ARM mode).
  assert.equal(r.binary[3], 0xEA,
    `expected ARM 'b' at offset 0 (last byte 0xEA), got ${r.binary[3].toString(16)}`);
});

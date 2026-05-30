// snes-c end-to-end smoke tests.
//
// Covers both runtime modes of buildSnesC:
//   pvsneslib: false → minimum-viable original-code crt0+hdr (R16)
//   pvsneslib: true  → idiomatic PVSnesLib-linked runtime  (R18, default)

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnesC } from "./snes-c.js";

test("buildSnesC pvsneslib:false: minimal main() compiles to a 32KB LoROM SNES ROM", async () => {
  const r = await buildSnesC({
    source: `
int counter = 7;
int main(void) {
  counter += 1;
  return counter;
}
`,
    pvsneslib: false,
  });
  assert.equal(r.ok, true, "build failed at stage " + r.stage + ":\n" + r.log);
  assert.equal(r.runtime, "minimal");
  assert.ok(r.binary, "no binary");
  assert.equal(r.binary.length, 32 * 1024, "expected 32KB LoROM, got " + r.binary.length);
  // LoROM header NAME field lives at $7FC0..$7FD4 (21 bytes).
  const name = Buffer.from(r.binary.subarray(0x7FC0, 0x7FC0 + 21)).toString("ascii");
  assert.match(name, /^ROM-DEV-MCP C BUILD/);
});

test("buildSnesC pvsneslib:true (default): bare main() links against PVSnesLib runtime", async () => {
  const r = await buildSnesC({
    source: "int main(void) { return 42; }",
  });
  assert.equal(r.ok, true, "build failed at stage " + r.stage + ":\n" + r.log);
  assert.equal(r.runtime, "pvsneslib");
  assert.ok(r.binary.length >= 32 * 1024, "expected at least 32KB, got " + r.binary.length);
  // PVSnesLib's hdr.asm declares ROMBANKS 8 (= 256KB minimum). The header
  // NAME field is at file offset $7FC0 (LoROM convention, regardless of
  // ROM size).
  const name = Buffer.from(r.binary.subarray(0x7FC0, 0x7FC0 + 21)).toString("ascii");
  // PVSnesLib's bundled include/hdr.asm sets NAME to "snes-sdk default hdr ".
  // Real projects override hdr.asm in their own source tree.
  assert.match(name, /snes-sdk|SNES/i, "expected PVSnesLib hdr.asm NAME field, got: " + JSON.stringify(name));
});

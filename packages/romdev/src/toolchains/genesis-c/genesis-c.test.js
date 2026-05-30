// genesis-c end-to-end smoke test.
//
// Builds a tiny C source through the WASM gcc toolchain (cc1 + as + ld +
// objcopy) and asserts the resulting ROM has the Sega Mega Drive header
// signature.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGenesisC } from "./genesis-c.js";

test("buildGenesisC sgdk:false: bare main() compiles via minimum-viable path", async () => {
  const r = await buildGenesisC({
    source: "int counter = 7; int main(void) { counter += 1; return counter; }",
    sgdk: false,
  });
  assert.equal(r.ok, true, "build failed at stage " + r.stage + ":\n" + r.log);
  assert.equal(r.runtime, "minimal");
  assert.ok(r.binary, "no binary");
  assert.ok(r.binary.length >= 256, "expected at least vector + header = 256 bytes");

  // Vector table: SSP at offset 0 should be $00FFE000 (top of WRAM).
  const ssp =
    (r.binary[0] << 24) | (r.binary[1] << 16) | (r.binary[2] << 8) | r.binary[3];
  assert.equal(ssp, 0x00FFE000, "wrong initial SSP");

  // ROM header at $100 should start with "SEGA MEGA DRIVE ".
  const headerStart = Buffer.from(r.binary.subarray(0x100, 0x110)).toString("ascii");
  assert.equal(headerStart, "SEGA MEGA DRIVE ");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { runVasm68k } from "./vasm68k.js";

const GENESIS_HELLO = `
        org     $0
        dc.l    $00FFE000   ; initial SP
        dc.l    Start       ; reset vector
        dcb.l   62, Stub    ; rest of vector table

        org     $200
Start:
Stub:
        bra     Start
        end
`;

test("vasm68k assembles a minimal 68k program", async () => {
  const r = await runVasm68k({ source: GENESIS_HELLO });
  assert.equal(r.exitCode, 0, "log:\n" + r.log);
  assert.ok(r.binary, "log:\n" + r.log);
  // Initial SP big-endian.
  assert.equal(r.binary[0], 0x00);
  assert.equal(r.binary[1], 0xff);
  assert.equal(r.binary[2], 0xe0);
  assert.equal(r.binary[3], 0x00);
});

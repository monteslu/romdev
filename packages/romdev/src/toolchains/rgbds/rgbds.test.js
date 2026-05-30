import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGB } from "./rgbds.js";

// Minimal Game Boy program. Sits at $0100 (entry point), jumps to itself.
const GB_SOURCE = `
SECTION "Header", ROM0[$0100]
  jp Start
  ds $150 - @, 0

SECTION "Main", ROM0[$0150]
Start:
  di
.loop:
  jr .loop
`;

test("RGBDS builds a minimal Game Boy ROM", async () => {
  const r = await buildGB({ source: GB_SOURCE });
  assert.equal(r.exitCode, 0, "build failed at " + r.stage + "\n" + r.log);
  assert.ok(r.binary);
  // Game Boy ROM: 32KB minimum.
  assert.ok(r.binary.length >= 0x8000);
  // Logo bytes at $0104 should be present (rgbfix fills them).
  assert.equal(r.binary[0x0104], 0xce);
  assert.equal(r.binary[0x0105], 0xed);
  assert.equal(r.binary[0x0106], 0x66);
}, { timeout: 30000 });

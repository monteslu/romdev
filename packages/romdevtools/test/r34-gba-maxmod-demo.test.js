// R34 — GBA maxmod music demo end-to-end test.
//
// Builds the maxmod_demo template (libtonc + libmm + a hand-authored CC0
// chiptune soundbank), asserts the ROM links cleanly, and verifies the
// soundbank bytes are actually embedded in the final .gba binary. The
// soundbank.bin gets `.incbin`'d via an auto-emitted asm stub in the
// libtonc build path — if the byte pattern isn't in the ROM, either the
// stub didn't run or the linker dropped it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync as _existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const XM_PATH         = join(REPO_ROOT, "src/platforms/gba/lib/maxmod/music/chiptune.xm");
const SOUNDBANK_PATH  = join(REPO_ROOT, "src/platforms/gba/lib/maxmod/music/chiptune_soundbank.bin");
const TEMPLATE_PATH   = join(REPO_ROOT, "examples/gba/templates/maxmod_demo.c");

test("R34 chiptune.xm + pre-built soundbank.bin both ship", () => {
  assert.ok(existsSync(XM_PATH), `xm missing: ${XM_PATH}`);
  assert.ok(existsSync(SOUNDBANK_PATH), `soundbank.bin missing: ${SOUNDBANK_PATH}`);
});

test("R34 maxmod_demo.c template ships", () => {
  assert.ok(existsSync(TEMPLATE_PATH), `template missing: ${TEMPLATE_PATH}`);
});

test("R34 chiptune.xm is a valid Fasttracker II module", async () => {
  const buf = await fs.readFile(XM_PATH);
  // Bytes 0..16: "Extended Module: "
  const tag = Buffer.from(buf.slice(0, 17)).toString("ascii");
  assert.equal(tag, "Extended Module: ", `bad XM magic: ${JSON.stringify(tag)}`);
  // Byte 37 should be the 0x1a EOF marker (after 17-byte tag + 20-byte title).
  assert.equal(buf[37], 0x1a, "missing 0x1a marker at offset 37");
});

test("R34 maxmod_demo builds + soundbank bytes are linked into the .gba", { timeout: 240000 }, async () => {
  const source = await fs.readFile(TEMPLATE_PATH, "utf-8");
  const soundbank = await fs.readFile(SOUNDBANK_PATH);

  const r = await buildGbaC({
    source,
    maxmod: true,
    binaryIncludes: { "soundbank.bin": new Uint8Array(soundbank) },
  });

  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-800)}`);
  assert.ok(r.binary && r.binary.length > 4096, `ROM too small: ${r.binary?.length}`);

  // Verify the soundbank actually got embedded. Take a 32-byte slice
  // from the middle of the soundbank (skipping any zero-padded prefix
  // that might collide with the ROM's general zero fill) and look for
  // it as a contiguous substring in the linked ROM.
  const needleStart = Math.floor(soundbank.length / 2);
  const needle = soundbank.slice(needleStart, needleStart + 32);
  const hay = Buffer.from(r.binary);
  const idx = hay.indexOf(needle);
  assert.ok(idx >= 0,
    `soundbank bytes (offset ${needleStart}..${needleStart + 32}) not found in linked ROM — ` +
    `the .incbin stub probably didn't run or the linker GC'd it. log tail: ${(r.log || "").slice(-500)}`);
});

test("R34 maxmod build fails clean without a soundbank when the C uses soundbank_bin", { timeout: 240000 }, async () => {
  // Sanity check: if you forget the soundbank binary include, the link
  // step should fail with an undefined-reference rather than silently
  // producing a broken ROM. This locks in the "soundbank_bin is the
  // canonical extern symbol" contract.
  const source = await fs.readFile(TEMPLATE_PATH, "utf-8");
  const r = await buildGbaC({ source, maxmod: true /* no binaryIncludes */ });
  assert.equal(r.ok, false, "expected link failure when soundbank.bin is missing");
  assert.ok(/soundbank_bin|undefined reference/i.test(r.log || ""),
    `expected undefined-reference error mentioning soundbank_bin; got log tail: ${(r.log || "").slice(-400)}`);
});

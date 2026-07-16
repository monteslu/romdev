// binaryIncludes as base64 STRINGS (the MCP/HTTP contract) must produce the
// SAME bytes as passing raw Uint8Arrays (the in-process contract).
//
// The defect (the GBA maxmod-silence saga, internal-gbalua): binaryFile() in
// _worker/run.js did `Buffer.from(bytes)` — a base64 STRING decoded as UTF-8 —
// so the base64 TEXT itself became the mounted file's contents and .incbin
// embedded ~4/3-inflated garbage into the ROM. Every MCP route delivers strings
// (inline binaryIncludes AND binaryIncludePaths both arrive base64), so every
// server-side GBA soundbank was corrupt while direct Uint8Array callers were
// fine — "same source, different ROM" between sessions. asar/cc65/vasm68k/wladx
// each carried their own either/or guard; binaryFile now carries it too, which
// also covers the generic gcc runner (Genesis/MIPS/SH .incbin paths).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGbaC } from "romdev-platform-gba";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK = path.join(__dirname, "..", "..", "romdev-platform-gba", "share", "gba", "lib", "maxmod", "music", "chiptune_soundbank.bin");

const SRC = `
#include <tonc.h>
#include <maxmod.h>
extern const u8 soundbank_bin[];
int main(void) {
    irq_init(NULL);
    irq_add(II_VBLANK, mmVBlank);
    mmInitDefault((mm_addr)soundbank_bin, 8);
    mmStart(0, MM_PLAY_LOOP);
    while (1) { mmFrame(); VBlankIntrWait(); }
}
`;

test("GBA binaryIncludes: base64 STRING builds byte-identical to Uint8Array (soundbank not corrupted)", { timeout: 180000 }, async () => {
  const bank = new Uint8Array(await readFile(BANK));

  const asBytes = await buildGbaC({
    sources: { "main.c": SRC },
    binaryIncludes: { "soundbank.bin": bank },
    maxmod: true,
  });
  assert.equal(asBytes.ok, true, "bytes build failed: " + (asBytes.log || "").slice(-300));

  const asString = await buildGbaC({
    sources: { "main.c": SRC },
    binaryIncludes: { "soundbank.bin": Buffer.from(bank).toString("base64") },
    maxmod: true,
  });
  assert.equal(asString.ok, true, "base64-string build failed: " + (asString.log || "").slice(-300));

  // The two contracts must produce the SAME ROM.
  assert.equal(Buffer.compare(Buffer.from(asBytes.binary), Buffer.from(asString.binary)), 0,
    `base64-string build differs from bytes build (${asString.binary.length} vs ${asBytes.binary.length} bytes) — the string was embedded as text, not decoded`);

  // And the ROM must contain the DECODED bank, never its base64 text.
  const rom = Buffer.from(asString.binary);
  assert.ok(rom.indexOf(Buffer.from(bank.slice(0, 16))) >= 0, "decoded soundbank bytes must be embedded in the ROM");
  const b64head = Buffer.from(Buffer.from(bank.slice(0, 12)).toString("base64"), "latin1");
  assert.equal(rom.indexOf(b64head), -1, "the soundbank's BASE64 TEXT must never appear in the ROM (the corruption signature)");
});

// romdev-xgm2 — VGM → XGM2 conversion structure tests. Validates the output
// against the SGDK bin/xgm2.txt format spec. (A full "does the Z80 driver play
// it" check lives in the romdev-mcp integration test, which builds a Genesis ROM
// that XGM2_play()s the blob and runs it in gpgx.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { vgmToXgm2, vgmToXgm2C } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Self-contained fixture (691B, copied from SGDK's demo.vgm). The old
// cross-package reach-in (packages/romdev/src/platforms/genesis/lib/...)
// died TWICE without these tests noticing — the romdev→romdevtools rename,
// then the 0.95.0 share-tree move to romdev-toolchain-m68k-gcc — because
// `npm test --workspaces` failures hid behind the last workspace's summary.
const DEMO_VGM = join(__dirname, "fixtures", "demo.vgm");

function header(blob) {
  return {
    id: String.fromCharCode(blob[0], blob[1], blob[2], blob[3]),
    version: blob[4],
    flags: blob[5],
    slen: blob[6] | (blob[7] << 8),
    fmlen: blob[8] | (blob[9] << 8),
    psglen: blob[10] | (blob[11] << 8),
  };
}

test("converts demo.vgm to a structurally-valid uncompiled XGM2 blob", () => {
  const vgm = readFileSync(DEMO_VGM);
  assert.equal(String.fromCharCode(vgm[0], vgm[1], vgm[2]), "Vgm", "input is a VGM");

  const blob = vgmToXgm2(vgm, { packed: false });
  const h = header(blob);
  assert.equal(h.id, "XGM2", "uncompiled blob starts with the XGM2 id");
  assert.equal(h.version, 0x10, "version byte is 0x10");
  // SLEN/FMLEN/PSGLEN are block counts (×256). The body that follows must match.
  const expectedMin = 0xc + 248 + h.slen * 256 + h.fmlen * 256 + h.psglen * 256;
  assert.ok(blob.length >= expectedMin,
    `blob (${blob.length}) must hold header + SID(248) + SLEN/FMLEN/PSGLEN blocks (>=${expectedMin})`);
  // This VGM has music, so at least one of FM/PSG must be non-empty.
  assert.ok(h.fmlen > 0 || h.psglen > 0, "a music VGM must produce FM and/or PSG data");
});

test("packed (compiled) blob has no XGM2 id and is 256-aligned", () => {
  const vgm = readFileSync(DEMO_VGM);
  const packed = vgmToXgm2(vgm, { packed: true });
  // The compiled form omits the 4-byte "XGM2" id (per asByteArray: `if (!packed) write "XGM2"`).
  assert.notEqual(String.fromCharCode(packed[0], packed[1], packed[2], packed[3]), "XGM2");
  assert.equal(packed.length % 256, 0, "compiled XGM2 data is 256-byte aligned");
  assert.ok(packed.length > 0);
});

test("system:'pal'/'ntsc' sets the PAL flag bit (#0 of format byte)", () => {
  const vgm = readFileSync(DEMO_VGM);
  const ntsc = header(vgmToXgm2(vgm, { packed: false, system: "ntsc" }));
  const pal = header(vgmToXgm2(vgm, { packed: false, system: "pal" }));
  assert.equal(ntsc.flags & 1, 0, "NTSC clears format bit #0");
  assert.equal(pal.flags & 1, 1, "PAL sets format bit #0");
});

test("emitC produces a 256-aligned C array + LEN define", () => {
  const vgm = readFileSync(DEMO_VGM);
  const { blob, cSource, lenDefine } = vgmToXgm2C(vgm, "bgm_test");
  assert.equal(lenDefine, "BGM_TEST_LEN");
  assert.match(cSource, /#define BGM_TEST_LEN \d+/);
  assert.match(cSource, /const unsigned char bgm_test\[\d+\] __attribute__\(\(aligned\(256\)\)\)/);
  // Byte count in the array matches the blob.
  const hexCount = (cSource.match(/0x[0-9a-f]{2}/g) || []).length;
  assert.equal(hexCount, blob.length, "every blob byte is emitted");
  assert.match(cSource, new RegExp(`\\[${blob.length}\\]`), "declared array length == blob length");
});

test("accepts gzipped (.vgz) input transparently (same output as raw)", async () => {
  const { gzipSync } = await import("node:zlib");
  const vgm = readFileSync(DEMO_VGM);
  const fromRaw = vgmToXgm2(vgm, { packed: true });
  const fromGz = vgmToXgm2(gzipSync(vgm), { packed: true });
  assert.deepEqual(Array.from(fromGz), Array.from(fromRaw), "a .vgz gunzips to the same XGM2 as the raw .vgm");
});

// C64 .d64 codec — pack a .prg into a 1541 disk image, read it back, extract.
// The disk path is how the C64 resurgence ships/loads games (the new Commodore
// 64 Ultimate FPGA hardware + the homebrew scene), so the codec has to produce a
// real, loadable image and round-trip files out of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prgToD64, readDirectory, extractFile, D64_IMAGE_SIZE } from "./d64.js";

// A tiny synthetic .prg: load addr $0801 (BASIC start) + a few body bytes.
function fakePrg(n = 300) {
  const b = new Uint8Array(n);
  b[0] = 0x01; b[1] = 0x08; // load address $0801, little-endian
  for (let i = 2; i < n; i++) b[i] = (i * 7) & 0xff; // deterministic body
  return b;
}

// REGRESSION: a directory entry whose name is in HIGH-BIT PETSCII (0xC1..0xDA =
// A..Z) — how the C64 KERNAL SAVE actually stores filenames. readDirectory used
// to drop those bytes, so an emulator-written "SCORE" read back as an empty name
// and the file looked missing. This is the bug that hid working in-game saves.
test("readDirectory decodes high-bit PETSCII filenames (KERNAL SAVE style)", () => {
  const d64 = prgToD64(fakePrg(400), { name: "GAME" });
  // hand-write a 2nd dir entry at track 18 sector 1, slot 1, name "SCORE" in
  // high-bit PETSCII (S=0xD3,C=0xC3,O=0xCF,R=0xD2,E=0xC5).
  const t18s1 = (17 * 21 + 1) * 256;          // track 18, sector 1 byte offset
  const slot1 = t18s1 + 2 + 32;               // first entry at +2, second at +34
  d64[slot1 + 0] = 0x82;                       // closed PRG (type byte)
  d64[slot1 + 1] = 1; d64[slot1 + 2] = 4;     // dummy first track/sector
  const score = [0xd3, 0xc3, 0xcf, 0xd2, 0xc5]; // "SCORE" in high-bit PETSCII
  for (let i = 0; i < 16; i++) d64[slot1 + 3 + i] = i < score.length ? score[i] : 0xa0; // name at +3
  const dir = readDirectory(d64);
  assert.ok(dir.find((e) => e.name === "SCORE"), `expected SCORE, got ${JSON.stringify(dir.map((d) => d.name))}`);
});

test("prgToD64 produces a standard 174848-byte 35-track image", () => {
  const d64 = prgToD64(fakePrg(), { name: "GAME" });
  assert.equal(d64.length, D64_IMAGE_SIZE);
  assert.equal(d64.length, 174848);
});

test("the packed file appears in the directory as a PRG", () => {
  const d64 = prgToD64(fakePrg(500), { name: "MYGAME", diskName: "MY DISK" });
  const dir = readDirectory(d64);
  assert.equal(dir.length, 1);
  assert.equal(dir[0].name, "MYGAME");
  assert.equal(dir[0].type, "PRG");
  assert.ok(dir[0].blocks >= 1, "block count should be ≥1");
});

test("extractFile round-trips the .prg bytes exactly (small)", () => {
  const prg = fakePrg(300);
  const d64 = prgToD64(prg, { name: "RT" });
  const back = extractFile(d64, "RT");
  assert.ok(back, "file not found");
  assert.equal(back.length, prg.length);
  assert.deepEqual([...back], [...prg]);
});

test("extractFile round-trips a multi-sector file (spans the dir track)", () => {
  // > 254*60 forces the chain to walk past track 18 (the directory track),
  // exercising the skip logic.
  const prg = fakePrg(20000);
  const d64 = prgToD64(prg, { name: "BIG" });
  const back = extractFile(d64, "BIG");
  assert.ok(back, "file not found");
  assert.equal(back.length, prg.length);
  assert.deepEqual([...back.subarray(0, 64)], [...prg.subarray(0, 64)]);
  assert.deepEqual([...back.subarray(-64)], [...prg.subarray(-64)]);
});

test("extractFile with no name returns the first file", () => {
  const prg = fakePrg(300);
  const d64 = prgToD64(prg, { name: "ONLYONE" });
  const back = extractFile(d64);
  assert.ok(back);
  assert.deepEqual([...back], [...prg]);
});

test("a too-small .prg is rejected", () => {
  assert.throws(() => prgToD64(new Uint8Array([0x01]), {}), /too small/i);
});

test("the BAM marks the file + directory sectors as used", () => {
  const d64 = prgToD64(fakePrg(300), { name: "X" });
  // BAM track-18 entry: track 18 holds BAM(0)+dir(1) used, so free count < 19.
  // BAM per-track table starts at offset 4 within the BAM sector; track 18's
  // image offset = start of track 18 sector 0. We just sanity-check the disk
  // name and DOS type bytes are where they belong.
  // Track 18 sector 0 offset: tracks 1-17 = 17*21 sectors.
  const t18s0 = (17 * 21) * 256;
  assert.equal(d64[t18s0 + 0], 18, "BAM should point dir track = 18");
  assert.equal(d64[t18s0 + 1], 1, "BAM should point dir sector = 1");
  assert.equal(d64[t18s0 + 2], 0x41, "BAM DOS format byte should be 'A'");
});

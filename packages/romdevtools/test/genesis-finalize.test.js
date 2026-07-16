import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeGenesisRom } from "romdev-toolchain-m68k-gcc";

// finalizeGenesisRom mirrors SGDK's post-link step: pad to a 128KB
// boundary (min 512KB) and write the $18E checksum (sum of BE words
// from $200 to EOF, mod $10000). These ROMs were rejected by RetroArch's
// Genesis Plus GX before the fix (unaligned size + $0000 checksum).

function checksumOf(rom) {
  let s = 0;
  for (let i = 0x200; i + 1 < rom.length; i += 2) {
    s = (s + ((rom[i] << 8) | rom[i + 1])) & 0xFFFF;
  }
  return s;
}

test("pads a tiny ROM up to the 512KB minimum", () => {
  const raw = new Uint8Array(65536); // 64KB, like the old hsl-hack.bin
  const out = finalizeGenesisRom(raw);
  assert.equal(out.length, 512 * 1024, "padded to 512KB floor");
  assert.equal(out.length % 131072, 0, "128KB-aligned");
});

test("pads a mid-size ROM up to the next 128KB boundary", () => {
  const raw = new Uint8Array(433412); // like gemcrush.bin
  const out = finalizeGenesisRom(raw);
  assert.equal(out.length % 131072, 0, "128KB-aligned");
  assert.ok(out.length >= raw.length, "never shrinks");
  assert.equal(out.length, 524288, "433412 -> next 128KB boundary = 512KB");
});

test("a ROM already aligned and above the floor is left at size", () => {
  const raw = new Uint8Array(786432); // 6x128KB, like Old-Towers
  const out = finalizeGenesisRom(raw);
  assert.equal(out.length, 786432, "no extra padding when already aligned");
});

test("writes a correct $18E checksum", () => {
  const raw = new Uint8Array(70000);
  // sprinkle some data after 0x200 so the checksum is non-trivial
  for (let i = 0x200; i < 0x400; i++) raw[i] = (i * 7) & 0xFF;
  const out = finalizeGenesisRom(raw);
  const stored = (out[0x18e] << 8) | out[0x18f];
  assert.equal(stored, checksumOf(out), "stored checksum matches computed");
  assert.notEqual(stored, 0x0000, "checksum is actually written, not left zero");
});

test("checksum excludes the header (bytes before $200)", () => {
  const raw = new Uint8Array(512 * 1024);
  // garbage in the header region must NOT affect the checksum
  for (let i = 0; i < 0x200; i++) raw[i] = 0xAB;
  const out = finalizeGenesisRom(raw);
  const stored = (out[0x18e] << 8) | out[0x18f];
  // body is all zero, so checksum should be 0 despite header garbage
  assert.equal(stored, 0x0000, "header bytes excluded from checksum");
});

test("preserves the original ROM bytes in place", () => {
  const raw = new Uint8Array(1000);
  raw[0x204] = 0x12; raw[0x205] = 0x34;
  const out = finalizeGenesisRom(raw);
  assert.equal(out[0x204], 0x12);
  assert.equal(out[0x205], 0x34);
});

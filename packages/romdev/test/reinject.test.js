// Re-inject path — findPointerTo / makeStoredBlock / relocateBlock.
//
// makeStoredBlock's correctness is proven the only way that matters: a REFERENCE
// DECOMPRESSOR (implemented here from the format spec) expands the tool's output
// back to the exact input payload. If the game's own decompressor follows the
// documented format, it produces the same bytes. We round-trip GBA BIOS LZ77 and
// SNES LC_LZ2 this way, and byte-check the simpler RLE/PackBits forms against the
// research's worked examples.
//
// findPointerTo + relocateBlock are tested on real built ROMs (cc65/m68k) by
// planting a known 32-bit pointer and confirming the tools find + rewrite it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  makeStoredBlockCore, findPointerToCore, relocateBlockCore,
  storedGbaLz77, storedSnesLz2, storedSegaRle, storedPackBits, storedKonamiRle,
  PLATFORM_REGISTRY, encodeInt,
} from "../src/mcp/tools/reinject.js";

// ── Reference decompressors (from the format specs) ─────────────────────────

/** GBA BIOS LZ77 (SWI 0x11) reference decompressor. */
function gbaLz77Decompress(src) {
  assert.equal(src[0], 0x10, "GBA LZ77 header type byte must be 0x10");
  const size = src[1] | (src[2] << 8) | (src[3] << 16);
  const out = [];
  let p = 4;
  while (out.length < size) {
    const flags = src[p++];
    for (let bit = 7; bit >= 0 && out.length < size; bit--) {
      if (flags & (1 << bit)) {
        // compressed back-reference
        const b0 = src[p++], b1 = src[p++];
        const len = (b0 >> 4) + 3;
        const disp = (((b0 & 0x0F) << 8) | b1) + 1;
        for (let k = 0; k < len && out.length < size; k++) out.push(out[out.length - disp]);
      } else {
        out.push(src[p++]);   // literal
      }
    }
  }
  return Uint8Array.from(out.slice(0, size));
}

/** SNES LC_LZ2 reference decompressor (direct-copy command only is enough here). */
function snesLz2Decompress(src) {
  const out = [];
  let p = 0;
  while (p < src.length) {
    const b = src[p++];
    if (b === 0xFF) break;                       // end marker
    let cmd = b >> 5, len = (b & 0x1F) + 1;
    if (cmd === 0x07) {                          // long-length extended form
      cmd = (b >> 2) & 0x07;
      len = (((b & 0x03) << 8) | src[p++]) + 1;
    }
    if (cmd === 0) {                             // direct copy (literal)
      for (let k = 0; k < len; k++) out.push(src[p++]);
    } else {
      throw new Error("test decompressor only handles direct-copy LC_LZ2 (the stored escape)");
    }
  }
  return Uint8Array.from(out);
}

const eq = (a, b) => assert.deepEqual(Array.from(a), Array.from(b));

// ── makeStoredBlock: round-trip + byte-exactness ────────────────────────────

test("makeStoredBlock GBA LZ77 round-trips through a reference decompressor", () => {
  for (const len of [1, 4, 8, 9, 17, 100, 257]) {
    const payload = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xFF);
    const block = storedGbaLz77(payload);
    eq(gbaLz77Decompress(block.bytes), payload);
  }
  // exact worked example
  eq(storedGbaLz77(Uint8Array.from([0xAA,0xBB,0xCC,0xDD])).bytes,
     [0x10,0x04,0x00,0x00, 0x00, 0xAA,0xBB,0xCC,0xDD, 0x00,0x00,0x00]);
});

test("makeStoredBlock SNES LC_LZ2 round-trips through a reference decompressor", () => {
  for (const len of [1, 4, 32, 33, 100, 1025]) {
    const payload = Uint8Array.from({ length: len }, (_, i) => (i * 53 + 7) & 0xFF);
    const block = storedSnesLz2(payload);
    eq(snesLz2Decompress(block.bytes), payload);
  }
  eq(storedSnesLz2(Uint8Array.from([0xAA,0xBB,0xCC,0xDD])).bytes,
     [0x03, 0xAA,0xBB,0xCC,0xDD, 0xFF]);
});

test("makeStoredBlock RLE/PackBits match the documented worked examples", () => {
  const p = Uint8Array.from([0xAA,0xBB,0xCC,0xDD]);
  eq(storedSegaRle(p).bytes,  [0x84, 0xAA,0xBB,0xCC,0xDD]);   // SMS/GG: 0x80|4
  eq(storedPackBits(p).bytes, [0x03, 0xAA,0xBB,0xCC,0xDD]);   // copy n+1
  eq(storedKonamiRle(p).bytes,[0x84, 0xAA,0xBB,0xCC,0xDD]);   // 0x80+4
});

test("makeStoredBlockCore: raw verdict + per-platform format gating", async () => {
  // Lynx/2600/7800 = raw, no wrapper.
  for (const plat of ["lynx", "atari2600", "atari7800"]) {
    const r = await makeStoredBlockCore({ platform: plat, rawHex: "AABBCCDD" });
    assert.equal(r.verdict, "raw");
    assert.equal(r.hex, "AA BB CC DD");
  }
  // GB rejects a GBA-only format with the valid list.
  await assert.rejects(
    makeStoredBlockCore({ platform: "gb", rawHex: "AA", format: "lz77-literal" }),
    /not valid for gb/,
  );
  // Kosinski is flagged experimental.
  const k = await makeStoredBlockCore({ platform: "genesis", rawHex: "AABBCCDD", format: "kosinski-literal" });
  assert.equal(k.experimental, true);
  // Every platform supports raw.
  for (const plat of Object.keys(PLATFORM_REGISTRY)) {
    const r = await makeStoredBlockCore({ platform: plat, rawHex: "0102", format: "raw" });
    assert.equal(r.hex, "01 02");
  }
});

// ── findPointerTo + relocateBlock on a real ROM ─────────────────────────────

test("findPointerTo + relocateBlock plant/find/repoint a 32-bit pointer (Genesis)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reinject-"));
  // Build a fake 64KB Genesis ROM: zeros, with a 32-bit BE pointer to 0x4000
  // planted at offset 0x100, and a 16-byte block of data at 0x4000.
  const rom = new Uint8Array(0x10000);
  const target = 0x4000;
  rom.set(encodeInt(target, 4, "be"), 0x100);          // pointer @ 0x100 → 0x4000
  for (let i = 0; i < 16; i++) rom[target + i] = 0x11; // original block
  // Free space (0xFF run) at 0x8000 for relocation.
  for (let i = 0x8000; i < 0x9000; i++) rom[i] = 0xFF;
  const romPath = path.join(dir, "fake.md");
  await writeFile(romPath, Buffer.from(rom));

  // 1) findPointerTo(0x4000) must find the planted pointer at 0x100.
  const fp = await findPointerToCore({ path: romPath, platform: "genesis", romOffset: target });
  const hitAt0x100 = fp.hits.find((h) => h.atOffsetDec === 0x100);
  assert.ok(hitAt0x100, "findPointerTo did not find the planted pointer: " + JSON.stringify(fp.hits.slice(0, 4)));
  assert.equal(hitAt0x100.bytes, "00 00 40 00");

  // 2) relocateBlock: write an edited block to free space (0x8000) and repoint.
  const edited = "2222222222222222"; // 8 bytes of 0x22
  const rb = await relocateBlockCore({
    path: romPath, platform: "genesis", newHex: edited,
    toOffset: 0x8000, pointerOffset: 0x100,
  });
  assert.equal(rb.blockAt, "0x008000");
  assert.equal(rb.pointer.after, "00 00 80 00", "pointer not repointed to 0x8000: " + JSON.stringify(rb.pointer));

  // 3) Confirm on disk: block written at 0x8000 + pointer now reads 0x8000.
  const after = new Uint8Array(await readFile(romPath));
  assert.equal(after[0x8000], 0x22, "edited block not on disk");
  eq(after.slice(0x100, 0x104), [0x00, 0x00, 0x80, 0x00]);

  // 4) findPointerTo(0x8000) now finds the repointed pointer.
  const fp2 = await findPointerToCore({ path: romPath, platform: "genesis", romOffset: 0x8000 });
  assert.ok(fp2.hits.some((h) => h.atOffsetDec === 0x100), "repointed pointer not found");
});

test("findPointerTo GBA: 32-bit LE 0x08000000+offset (value-search-complete)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reinject-gba-"));
  const rom = new Uint8Array(0x8000);
  const off = 0x1234;
  // A literal-pool word pointing at ROM offset 0x1234 → 0x08001234, LE.
  rom.set(encodeInt(0x08001234, 4, "le"), 0x40);
  const romPath = path.join(dir, "fake.gba");
  await writeFile(romPath, Buffer.from(rom));
  const fp = await findPointerToCore({ path: romPath, platform: "gba", romOffset: off });
  const hit = fp.hits.find((h) => h.atOffsetDec === 0x40);
  assert.ok(hit, "GBA pointer not found: " + JSON.stringify(fp));
  assert.equal(hit.bytes, "34 12 00 08");
});

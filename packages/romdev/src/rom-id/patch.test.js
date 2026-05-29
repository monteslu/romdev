import { test } from "node:test";
import assert from "node:assert/strict";
import { patchRom, extractChrFromINes } from "./patch.js";
import { buildForPlatform } from "../toolchains/index.js";

test("patchRom: applies a single write", () => {
  const rom = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const r = patchRom({ rom, writes: [{ offset: 2, hex: "aabb" }] });
  assert.equal(r.applied, 1);
  assert.equal(r.expanded, 0);
  assert.deepEqual(Array.from(r.rom), [0, 1, 0xaa, 0xbb, 4, 5]);
});

test("patchRom: rejects out-of-range writes without allowExpand", () => {
  const rom = new Uint8Array([0, 1, 2, 3]);
  assert.throws(
    () => patchRom({ rom, writes: [{ offset: 3, hex: "deadbeef" }] }),
    /patch extends ROM/,
  );
});

test("patchRom: expands with allowExpand", () => {
  const rom = new Uint8Array([0, 1, 2, 3]);
  const r = patchRom({
    rom,
    writes: [{ offset: 6, hex: "ff" }],
    allowExpand: true,
  });
  assert.equal(r.expanded, 3);
  assert.equal(r.rom.length, 7);
  assert.equal(r.rom[4], 0);
  assert.equal(r.rom[5], 0);
  assert.equal(r.rom[6], 0xff);
});

test("extractChrFromINes: pulls 8KB CHR from a cc65 NES ROM", async () => {
  const r = await buildForPlatform({
    platform: "nes",
    source: "void main(void){while(1){}}\n",
  });
  assert.equal(r.ok, true);
  const chr = extractChrFromINes(r.binary);
  assert.ok(chr, "expected CHR to be present");
  assert.equal(chr.length, 8192);
});

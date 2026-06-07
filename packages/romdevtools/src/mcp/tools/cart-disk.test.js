// cart({op:'packDisk'}) + cart({op:'extract'}) on a C64 .d64 — the disk
// distribution path. packDisk wraps a built .prg into the .d64 the C64 Ultimate
// hardware and the homebrew scene load; extract reads files back off a disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";

import { packDiskCore, extractDiskCore } from "./cart-parts.js";

function fakePrg(n = 400) {
  const b = Buffer.alloc(n);
  b[0] = 0x01; b[1] = 0x08; // $0801
  for (let i = 2; i < n; i++) b[i] = (i * 13) & 0xff;
  return b;
}

test("packDisk inline returns a 174848-byte .d64 base64", async () => {
  const r = await packDiskCore({ base64: fakePrg().toString("base64"), name: "GAME", inline: true });
  assert.equal(r.packed, true);
  assert.equal(r.format, "d64");
  assert.equal(r.name, "GAME");
  const d64 = Buffer.from(r.base64, "base64");
  assert.equal(d64.length, 174848);
});

test("packDisk writes <prg>.d64 next to the .prg by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d64-"));
  try {
    const prgPath = path.join(dir, "mygame.prg");
    await writeFile(prgPath, fakePrg(600));
    const r = await packDiskCore({ prgPath });
    assert.equal(r.path, path.join(dir, "mygame.d64"));
    assert.equal(r.name, "MYGAME");
    const d64 = await readFile(r.path);
    assert.equal(d64.length, 174848);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extract on a .d64 lists the directory, and pulls a file back out", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d64-"));
  try {
    const prg = fakePrg(800);
    const prgPath = path.join(dir, "rt.prg");
    await writeFile(prgPath, prg);
    const packed = await packDiskCore({ prgPath, name: "RT" });

    const listed = await extractDiskCore({ path: packed.path });
    assert.equal(listed.format, "d64");
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, "RT");
    assert.equal(listed.files[0].type, "PRG");

    // pull the file off the disk and confirm it matches the source .prg
    const pulled = await extractDiskCore({ path: packed.path, name: "RT", inline: true });
    const back = Buffer.from(pulled.file.base64, "base64");
    assert.deepEqual([...back], [...prg]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extract .d64 for a missing file errors with the available names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d64-"));
  try {
    const prgPath = path.join(dir, "x.prg");
    await writeFile(prgPath, fakePrg(300));
    const packed = await packDiskCore({ prgPath, name: "REAL" });
    await assert.rejects(
      () => extractDiskCore({ path: packed.path, name: "NOPE", inline: true }),
      /no file 'NOPE'.*REAL/s,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

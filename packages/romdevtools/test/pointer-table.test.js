// Static pointer-table decode (analysis/pointer-table.js + disasm target). Covers
// the three dispatcher forms from the v0.41.0 feedback (note 005444 N2): a
// contiguous `dw` table, a SPLIT lo/hi pair at two bases, the 6502 RTS-trick (+1),
// and the REVERSE lookup (handler → dispatch index).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { decodePointerTable, reverseLookup } from "../src/analysis/pointer-table.js";
import { registerDisasmTools } from "../src/mcp/tools/disasm.js";

// ── unit: the decoder ──
const identity = (a) => a; // CPU addr == offset for the unit tests

test("contiguous LE dw table decodes index→handler", () => {
  const data = new Uint8Array(0x10000);
  data.set([0x34, 0x82, 0x78, 0x56], 0x1000); // $8234, $5678
  const { entries, form } = decodePointerTable({ data, toOffset: identity, count: 2, loBase: 0x1000 });
  assert.match(form, /contiguous LE/);
  assert.equal(entries[0].handler, 0x8234);
  assert.equal(entries[1].handler, 0x5678);
});

test("split lo/hi arrays decode (lo[i] | hi[i]<<8)", () => {
  const data = new Uint8Array(0x10000);
  data.set([0xc0, 0x10], 0x100); // lo array
  data.set([0xb2, 0x80], 0x200); // hi array
  const { entries, form } = decodePointerTable({ data, toOffset: identity, count: 2, loBase: 0x100, hiBase: 0x200 });
  assert.match(form, /split/);
  assert.equal(entries[0].handler, 0xb2c0);
  assert.equal(entries[1].handler, 0x8010);
});

test("rts+1 convention adds 1 (table holds handler-1)", () => {
  const data = new Uint8Array(0x10000);
  data.set([0xc0, 0xb2], 0x100); // stored $B2C0
  const { entries } = decodePointerTable({ data, toOffset: identity, count: 1, loBase: 0x100, convention: "rts+1" });
  assert.equal(entries[0].storedWord, 0xb2c0);
  assert.equal(entries[0].handler, 0xb2c1, "+1 applied for the RTS trick");
});

test("reverseLookup returns ALL indices that reach a handler", () => {
  const entries = [
    { index: 0, handler: 0xb2c1 }, { index: 1, handler: 0x8000 }, { index: 2, handler: 0xb2c1 },
  ];
  assert.deepEqual(reverseLookup(entries, 0xb2c1), [0, 2]);
  assert.deepEqual(reverseLookup(entries, 0x9999), []);
});

// ── tool: the disasm target (with the NES mapper) ──
function toolHandler() {
  const map = {};
  registerDisasmTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z);
  return map.disasm;
}
const parse = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);

test("disasm({target:'pointerTable'}) decodes a split RTS-trick table on a NES ROM + reverse lookup", async () => {
  // Zanac's form: lo array @ $8618, hi array @ $8673, RTS-trick. Handler $B2C1 at
  // indices 0 and 2 (stored as $B2C0).
  const prg = new Uint8Array(0x8000);
  prg.set([0xc0, 0x00, 0xc0], 0x618); // lo: $C0, $00, $C0
  prg.set([0xb2, 0x80, 0xb2], 0x673); // hi: $B2, $80, $B2
  prg[0x7ffc] = 0; prg[0x7ffd] = 0x80;
  const header = new Uint8Array(16); header.set([0x4e, 0x45, 0x53, 0x1a, 2, 0]);
  const rom = new Uint8Array(16 + 0x8000); rom.set(header); rom.set(prg, 16);

  const dir = await mkdtemp(path.join(os.tmpdir(), "pt-tool-"));
  try {
    const p = path.join(dir, "t.nes");
    await writeFile(p, rom);
    const disasm = toolHandler();
    const r = parse(await disasm({
      target: "pointerTable", platform: "nes", path: p,
      loBase: 0x8618, hiBase: 0x8673, count: 3, convention: "rts+1", reverseHandler: 0xb2c1,
    }));
    assert.match(r.form, /split.*rts\+1/);
    assert.equal(r.entries[0].handler, "$B2C1");
    assert.equal(r.entries[0].storedWord, "$B2C0");
    assert.equal(r.entries[2].handler, "$B2C1");
    assert.deepEqual(r.reverse.indices, [0, 2], "reverse: indices 0 and 2 dispatch to $B2C1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pointerTable works on a NON-NES platform: GB LE table", async () => {
  // GB cpu addr == file offset for $0000-$7FFF. LE word table at $1000.
  const gb = new Uint8Array(0x8000);
  gb.set([0x34, 0x42, 0xbc, 0x5a], 0x1000); // $4234, $5ABC (LE)
  const dir = await mkdtemp(path.join(os.tmpdir(), "pt-gb-"));
  try {
    const p = path.join(dir, "t.gb");
    await writeFile(p, gb);
    const r = parse(await toolHandler()({ target: "pointerTable", platform: "gb", path: p, loBase: 0x1000, count: 2 }));
    assert.equal(r.platform, "gb");
    assert.match(r.form, /contiguous LE/);
    assert.equal(r.entries[0].handler, "$4234");
    assert.equal(r.entries[1].handler, "$5ABC");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pointerTable defaults to BIG-endian on Genesis (m68k word order)", async () => {
  const gen = new Uint8Array(0x40000);
  gen.set([0x12, 0x34, 0x56, 0x78], 0x2000); // BE words $1234, $5678
  const dir = await mkdtemp(path.join(os.tmpdir(), "pt-gen-"));
  try {
    const p = path.join(dir, "t.bin");
    await writeFile(p, gen);
    const r = parse(await toolHandler()({ target: "pointerTable", platform: "genesis", path: p, loBase: 0x2000, count: 2 }));
    assert.match(r.form, /contiguous BE/, "Genesis tables default to big-endian");
    assert.equal(r.entries[0].handler, "$1234");
    assert.equal(r.entries[1].handler, "$5678");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pointerTable rejects a platform with no static mapper, listing the supported set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pt-pce-"));
  try {
    const p = path.join(dir, "t.pce");
    await writeFile(p, new Uint8Array(0x2000));
    const res = await toolHandler()({ target: "pointerTable", platform: "pce", path: p, loBase: 0x1000, count: 1 });
    assert.equal(res.isError, true);
    const msg = res.content.find((c) => c.type === "text").text;
    assert.match(msg, /no static address mapper/);
    assert.match(msg, /breakpoint\(\{on:'jumptable'\}\)/, "steers to the live resolver");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Game Boy IR export: records carry CPU addresses and `jr` targets are right,
// above 64KB and on secondary (mid-instruction) records alike.
//
// Both bugs this guards were measured on real carts: above 64KB a record's
// `addr` was its FILE OFFSET and the jr target that offset truncated to 16
// bits (a 512KB MBC1 cart's `jr nz,$4003` at ROM $10006 exported as
// `nz,0x0003`); on secondary records the target was resolved against the
// batch-decode slot (a 32KB cart's $01DA `18 FA`, jr -6, exported as $048C). The
// synthetic ROM below reproduces both shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportZ80IR, irPlan, irRecords } from "./export-z80-ir.js";
import { gbWindows, gbFixOps } from "./gb-metadata.js";
import { objdumpAvailable } from "../../toolchains/objdump.js";

/** 128KB (8 banks), nop-filled, with the two jr shapes placed. */
function rom() {
  const r = new Uint8Array(0x20000);
  // bank 4, CPU $4006: jr nz,-3 -> $4005 (the above-64KB shape)
  r.set([0x20, 0xFD], 0x10006);
  // bank 0: `3e 18` (ld a,$18) then `fa 00 c0`; offset $01D1 is only reached
  // as a SECONDARY decode: `18 fa` = jr -6 from $01D1 -> $01CD.
  r.set([0x3E, 0x18, 0xFA, 0x00, 0xC0], 0x1D0);
  // bank 7, CPU $7FFE: jr $+4 runs off the window: target $8002 (16-bit).
  r.set([0x18, 0x02], 0x1FFFE);
  // bank 0, CPU $0000: jr -2 wraps to $FFFE.
  r.set([0x18, 0xFC], 0x0000);
  return r;
}

async function records(buf) {
  const { isa, windows } = irPlan(Buffer.from(buf), { platform: "gb", allOffsets: true });
  const out = new Map();
  for await (const rec of irRecords(Buffer.from(buf), isa, windows, { wantAllAlignments: true })) {
    if (!out.has(rec.off) || rec.alignment === "primary") out.set(rec.off, rec);
  }
  return out;
}

test("gbWindows: one window per 16KB bank, bank 0 at $0000, every other bank at $4000", () => {
  const w = gbWindows(0x20000, { allOffsets: true });
  assert.equal(w.length, 8);
  assert.deepEqual(w.map((x) => x.addr), [0, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000]);
  assert.deepEqual(w.map((x) => x.off), [0, 0x4000, 0x8000, 0xC000, 0x10000, 0x14000, 0x18000, 0x1C000]);
  // a physical range crossing a bank edge splits at it, each at its CPU address
  const f = gbWindows(0x20000, { fileOffset: 0xBFF0, length: 0x20 });
  assert.deepEqual(f.map((x) => [x.off, x.addr, x.bank]), [[0xBFF0, 0x7FF0, 2], [0xC000, 0x4000, 3]]);
  // a CPU address in the switched window maps through `bank`
  const c = gbWindows(0x20000, { startAddress: 0x4100, length: 16, bank: 5 });
  assert.deepEqual(c.map((x) => [x.off, x.addr]), [[5 * 0x4000 + 0x100, 0x4100]]);
  assert.throws(() => gbWindows(0x20000, { startAddress: 0xC000, length: 16 }), /ROM/);
});

test("gbFixOps recomputes jr from the bytes and the true address; everything else passes through", () => {
  assert.equal(gbFixOps("jr", "nz,0x0003", [0x20, 0xFD], 0x4006), "nz,0x4005");
  assert.equal(gbFixOps("jr", "0x048c", [0x18, 0xFA], 0x01DA), "0x01d6");
  assert.equal(gbFixOps("jr", "c,0x0000", [0x38, 0x00], 0x7FFE), "c,0x8000");
  assert.equal(gbFixOps("jp", "0x020c", [0xC3, 0x0C, 0x02], 0x4000), "0x020c");
  assert.equal(gbFixOps("ld", "a,0x18", [0x3E, 0x18], 0x1D0), "a,0x18");
});

test("IR export: primary and secondary jr targets are CPU addresses, above 64KB too",
  { skip: !objdumpAvailable("gbz80") && "gbz80 objdump not installed" }, async () => {
    const r = rom();
    const recs = await records(r);
    assert.equal(recs.size, r.length, "a record at every offset");
    const big = recs.get(0x10006);
    assert.equal(big.alignment, "primary");
    assert.equal(big.addr, 0x4006, "addr is the CPU address, not the file offset");
    assert.equal(big.bank, 4);
    assert.equal(big.ops, "nz,0x4005");
    assert.equal(big.kind, "branch");
    assert.equal(big.target, 0x4005);
    const sec = recs.get(0x1D1);
    assert.equal(sec.alignment, "secondary");
    assert.equal(sec.mnemonic, "jr");
    assert.equal(sec.addr, 0x1D1);
    assert.equal(sec.ops, "0x01cd", "secondary target from the true address, not the batch slot");
    assert.equal(recs.get(0x1FFFE).ops, "0x8002");
    assert.equal(recs.get(0x1FFFE).addr, 0x7FFE);
    assert.equal(recs.get(0).ops, "0xfffe");
    // every jr in the export agrees with its own bytes
    for (const rec of recs.values()) {
      if (rec.mnemonic !== "jr") continue;
      const t = (rec.addr + 2 + ((rec.bytes[1] << 24) >> 24)) & 0xFFFF;
      assert.ok(rec.ops.endsWith("0x" + t.toString(16).padStart(4, "0")), `jr at ${rec.off.toString(16)}: ${rec.ops} vs $${t.toString(16)}`);
    }
    // control flow is classified from the bytes (it was handed the mnemonic)
    assert.equal(recs.get(0x1D2).kind, "none");
    assert.equal(recs.get(0x1D2).mnemonic, "ld");
  });

test("exportZ80IR writes the same records as irRecords (one decode path)",
  { skip: !objdumpAvailable("gbz80") && "gbz80 objdump not installed" }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-ir-"));
    try {
      const r = rom();
      writeFileSync(path.join(dir, "t.gb"), r);
      const m = await exportZ80IR({ platform: "gb", path: path.join(dir, "t.gb"), outputPath: path.join(dir, "t.jsonl"), allOffsets: true, alignments: "all" });
      assert.equal(m.offsetsWithRecord, r.length);
      assert.equal(m.unresolvedOffsets, 0);
      const lines = readFileSync(path.join(dir, "t.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines.length, m.instrCount + m.secondaryCount);
      const at = lines.find((x) => x.off === 0x10006 && x.alignment === "primary");
      assert.equal(at.ops, "nz,0x4005");
      assert.equal(at.addr, 0x4006);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

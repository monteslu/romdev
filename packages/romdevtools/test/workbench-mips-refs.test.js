// %hi/%lo arithmetic, the raw-word decoder, and the shift word census.
// Ported from the workbench's own tests; every fixture is hand-built words.
// The upstream live-conformance class replays a commercial image pair and is
// not ported (no ROM-derived bytes here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPCODE_J, OPCODE_JAL, OPCODE_LUI, GeneratedSpec, RangeModel, RegionSpec, WhitelistEntry, _classifyTextWord, alignment,
  buildWordCensus, compose, decodeWord, defaultN64Windows, hi16For, lo16For } from "../src/decomp/workbench/mips-refs.js";

const word = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

test("naive top16 would change but signed hi does not", () => {
  const oldA = 0x8000FFF0, newA = oldA + 0x10;
  assert.equal(oldA & 0xFFFF, 0xFFF0);
  assert.equal(newA & 0xFFFF, 0);
  assert.equal(hi16For(oldA), hi16For(newA));
  assert.notEqual(hi16For(oldA), (oldA >>> 16) & 0xFFFF);
});

test("crossing into negative lo bumps hi", () => {
  const oldA = 0x80007FF8, newA = oldA + 0x10;
  assert.equal(newA & 0xFFFF, 0x8008);
  assert.equal(hi16For(newA), hi16For(oldA) + 1);
});

test("lo16For is the signed value, not the raw field", () => {
  assert.equal(lo16For(0x8000FFF0), -0x10);
  assert.equal(lo16For(0x80010000), 0);
  assert.equal(lo16For(0x80007FF8), 0x7FF8);
});

test("compose round-trips hi16For and lo16For", () => {
  for (const a of [0x80000450, 0x8000FFF0, 0x80010000, 0x80007FF8, 0x80008008, 0, 0xFFFFFFFF, 0x800D1DB0]) {
    assert.equal(compose(hi16For(a), lo16For(a) & 0xFFFF), a >>> 0, a.toString(16));
  }
});

test("compose sign-extends the raw lo field", () => { assert.equal(compose(0x8001, 0xFFF0), 0x8000FFF0); });

test("j decodes the 26-bit target and composes with region", () => {
  const ref = decodeWord((OPCODE_J << 26) | 0x123456);
  assert.equal(ref.kind, "j");
  assert.equal(ref.opcode, OPCODE_J);
  assert.equal(ref.target26, 0x123456);
  assert.equal(ref.target({ region: 0x80000000 }), 0x80000000 + (0x123456 << 2));
  assert.equal(ref.target({ region: 0x8048D158 }), ref.target({ region: 0x80000000 }));
});

test("jal decodes the same shape as j", () => {
  const ref = decodeWord((OPCODE_JAL << 26) | 0x204);
  assert.equal(ref.kind, "jal");
  assert.equal(ref.target26, 0x204);
  assert.equal(ref.target({ region: 0x80000000 }), 0x80000810);
});

test("lui decodes rt and imm16", () => {
  const ref = decodeWord((OPCODE_LUI << 26) | (8 << 16) | 0x8012);
  assert.equal(ref.kind, "lui");
  assert.equal(ref.rt, 8);
  assert.equal(ref.imm16, 0x8012);
  assert.equal(ref.target26, null);
});

test("imm16-bearing op decodes rs, rt and the signed immediate", () => {
  const ref = decodeWord((0x09 << 26) | (29 << 21) | (8 << 16) | 0xFFF0);
  assert.equal(ref.kind, "imm16");
  assert.equal(ref.rs, 29);
  assert.equal(ref.rt, 8);
  assert.equal(ref.imm16, 0xFFF0);
  assert.equal(ref.simm16, -16);
});

test("SPECIAL opcode is other, not imm16", () => {
  const ref = decodeWord((8 << 21) | (9 << 16) | (10 << 11) | 0x20);
  assert.equal(ref.kind, "other");
  assert.equal(ref.imm16, null);
  assert.equal(ref.target26, null);
});

test("target is null off a non-jump word; asDict is JSON-ready", () => {
  assert.equal(decodeWord((OPCODE_LUI << 26) | 0x8000).target({ region: 0x80000000 }), null);
  const payload = decodeWord((OPCODE_J << 26) | 0x10).asDict();
  assert.equal(payload.kind, "j");
  assert.equal(payload.target26, 0x10);
});

test("range model windows: narrower first wins, kseg1, kseg0, segmented, none", () => {
  const model = new RangeModel({ windows: defaultN64Windows() });
  assert.deepEqual(model.classifyValue(0xB0001234), ["cart", false, null]);
  assert.equal(model.classifyValue(0xA4001234)[0], "kseg1");
  assert.equal(model.classifyValue(0x80123456)[0], "kseg0");
  assert.equal(model.classifyValue(0x06000000)[0], "segmented");
  const [w, wl] = model.classifyValue(0xD0000000);
  assert.equal(w, null);
  assert.equal(wl, false);
});

test("exact and ranged whitelist entries; whitelist and window are independent", () => {
  let model = new RangeModel({ whitelist: [WhitelistEntry.exact(0x80100400, { reason: "CIC-6103 boot address" })] });
  let [, wl, reason] = model.classifyValue(0x80100400);
  assert.equal(wl, true);
  assert.equal(reason, "CIC-6103 boot address");
  assert.equal(model.classifyValue(0x80100401)[1], false);
  model = new RangeModel({ whitelist: [new WhitelistEntry({ lo: 0x80100000, hi: 0x80101000, reason: "ucode data blob" })] });
  [, wl, reason] = model.classifyValue(0x80100400);
  assert.equal(wl, true);
  assert.equal(reason, "ucode data blob");
  model = new RangeModel({ windows: defaultN64Windows(), whitelist: [WhitelistEntry.exact(0x80100400, { reason: "CIC-6103 boot address" })] });
  assert.deepEqual(model.classifyValue(0x80100400), ["kseg0", true, "CIC-6103 boot address"]);
});

test("alignment is value mod 4", () => {
  assert.equal(alignment(0x80000450), 0);
  assert.equal(alignment(0x8007BA73), 3);
});

// Word census: one hand-built image pair exercising every class at once.
const DELTA = 0x10;
function fixture() {
  const old = new Map([
    [0x00, 0x11111111], [0x04, 0x80000100], [0x08, 0x80000450], [0x0C, 0x00000001],
    [0x10, (OPCODE_J << 26) | 0x100], [0x14, (OPCODE_JAL << 26) | 0x200],
    [0x18, ((0x23 << 26) | (29 << 21) | (8 << 16) | 0x0010) >>> 0], [0x1C, ((0x23 << 26) | (29 << 21) | (9 << 16) | 0xFFF0) >>> 0],
    [0x20, (OPCODE_LUI << 26) | (8 << 16) | 0x8000], [0x24, (0x01 << 26) | 0x3FFFFF8], [0x28, 0x12345678], [0x2C, 0xDEADBEEF],
  ]);
  const nw = new Map(old);
  nw.set(0x00, 0xAAAAAAAA); nw.set(0x04, old.get(0x04) + DELTA);
  nw.set(0x10, (OPCODE_J << 26) | 0x104); nw.set(0x14, (OPCODE_JAL << 26) | 0x204);
  nw.set(0x18, ((0x23 << 26) | (29 << 21) | (8 << 16) | 0x0020) >>> 0); nw.set(0x1C, ((0x23 << 26) | (29 << 21) | (9 << 16)) >>> 0);
  nw.set(0x20, (OPCODE_LUI << 26) | (8 << 16) | 0x8001); nw.set(0x24, old.get(0x24) + DELTA);
  nw.set(0x28, 0x87654321); nw.set(0x2C, 0xCAFEBABE);
  const span = 0x30;
  const base = Buffer.alloc(span), shiftedBody = Buffer.alloc(span);
  for (const [o, v] of old) word(v).copy(base, o);
  for (const [o, v] of nw) word(v).copy(shiftedBody, o);
  return { base, shifted: Buffer.concat([shiftedBody, Buffer.alloc(DELTA)]), insertion_offset: span,
    regions: [new RegionSpec({ start: 0, end: 8, kind: "header" }), new RegionSpec({ start: 8, end: 0x10, kind: "blob" }), new RegionSpec({ start: 0x10, end: 0x30, kind: "text" })],
    generated: [new GeneratedSpec({ start: 0, end: 4, label: "crc-header" })], moved_range: [0x80000400, 0x80001000] };
}
const census = (over = {}) => { const f = fixture(); return buildWordCensus(f.base, f.shifted, { insertion_offset: f.insertion_offset, delta: DELTA,
  regions: f.regions, generated: f.generated, moved_range: f.moved_range, ...over }); };

test("every class is counted once", () => {
  const r = census();
  assert.deepEqual(r.counts, { "abs32-tracks": 2, "crc-header": 1, "hi16-adjust": 1, "j26-tracks": 2, "lo16-tracks": 2, unexplained: 2 });
  assert.equal(r.differing_total, 10);
  assert.equal(r.unexplained_total, 2);
});

test("generated span wins before any decode", () => {
  const r = census();
  assert.ok(!r.unexplained.some((w) => w.offset === 0 && w.old === 0x11111111));
});

test("equal pair inside the moved range is stale; outside is not", () => {
  const r = census();
  assert.equal(r.stale_total, 1);
  assert.equal(r.stale[0].offset, 0x08);
  assert.equal(r.stale[0].value, 0x80000450);
  assert.equal(r.stale[0].alignment, 0);
  assert.ok(!r.stale.some((s) => s.offset === 0x0C));
});

test("stale candidates carry range-model features", () => {
  const r = census({ range_model: new RangeModel({ windows: defaultN64Windows() }) });
  assert.equal(r.stale[0].window, "kseg0");
  assert.equal(r.stale[0].whitelisted, false);
});

test("unexplained words are the ones no class covers; cap limits samples not totals", () => {
  assert.deepEqual(census().unexplained.map((u) => u.offset).sort((a, b) => a - b), [0x28, 0x2C]);
  const capped = census({ detail_cap: 1 });
  assert.equal(capped.unexplained.length, 1);
  assert.equal(capped.unexplained_total, 2);
});

test("asDict is plain JSON-ready structures", () => {
  const p = census().asDict();
  assert.equal(typeof p.counts, "object");
  assert.ok(Array.isArray(p.unexplained));
  assert.ok(Array.isArray(p.stale));
  assert.equal(p.differing_total, 10);
});

test("length mismatch against the declared delta is rejected", () => {
  const f = fixture();
  assert.throws(() => buildWordCensus(f.base, Buffer.concat([f.shifted, Buffer.alloc(4)]), { insertion_offset: f.insertion_offset, delta: DELTA }), { name: "ValueError" });
});

test("an offset outside every region falls back to the default kind", () => {
  const f = fixture();
  const r = buildWordCensus(f.base, f.shifted, { insertion_offset: f.insertion_offset, delta: DELTA, regions: [new RegionSpec({ start: 0, end: 8, kind: "header" })],
    generated: f.generated, default_kind: "data" });
  assert.ok(r.unexplained.some((u) => u.offset === 0x10));
});

test("the sign-wrap word classifies lo16, not unexplained", () => {
  assert.equal(_classifyTextWord(0x8C2EFFF0, 0x8C2E0000, DELTA), "lo16-tracks");
});

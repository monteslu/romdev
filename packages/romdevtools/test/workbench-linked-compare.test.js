// The linked image as an oracle, classified per function range; and the
// declarative relocation identity join. Synthetic byte strings only. Ported
// from the workbench's own linked-compare and relocation-identity tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import * as lc from "../src/decomp/workbench/linked-compare.js";
import { R_MIPS_26, Site } from "../src/decomp/workbench/reloc-surface.js";
import { IDENTITY_PROVIDER_SCHEMA, identityReport, parseIdentityProvider } from "../src/decomp/workbench/relocation-identity.js";

const TARGET = Buffer.concat(Array.from({ length: 16 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
function built(edits = {}) {
  const image = Buffer.from(TARGET);
  for (const [offset, value] of Object.entries(edits)) image[Number(offset)] = value;
  return image;
}
const R = (name, start, end) => new lc.ImageRange({ name, start, end });

test("a command-line range reads start and end, or start and size", () => {
  const item = lc.parseRangeArgument("draw:0x100:0x180");
  assert.deepEqual([item.name, item.start, item.end], ["draw", 0x100, 0x180]);
  assert.equal(lc.parseRangeArgument("draw:0x100+0x80").end, 0x180);
});

test("an empty range is refused rather than reported exact", () => {
  assert.throws(() => lc.parseRangeArgument("draw:0x100:0x100"), (e) => e instanceof lc.RangeError && e.message.includes("empty range"));
});

test("a range without a separator says what the shape is", () => {
  assert.throws(() => lc.parseRangeArgument("draw"), /NAME:START:END/);
});

test("a ranges document accepts end or size; a bare list is accepted", () => {
  const parsed = lc.parseRanges({ schema: lc.RANGES_SCHEMA, ranges: [{ name: "a", start: "0x10", end: "0x20" }, { name: "b", start: 32, size: 16 }] });
  assert.deepEqual(parsed.map((r) => r.end), [0x20, 48]);
  assert.equal(lc.parseRanges([{ name: "a", start: 0, size: 4 }]).length, 1);
});

test("an unknown ranges schema is refused by name", () => {
  assert.throws(() => lc.parseRanges({ schema: "other-v1", ranges: [] }), (e) => e.message.includes(lc.RANGES_SCHEMA));
});

test("a range with neither end nor size is refused", () => {
  assert.throws(() => lc.parseRanges([{ name: "a", start: 0 }]), /'end' or a 'size'/);
});

const ranges = [R("draw", 0x100, 0x140)];

test("an identical image is exact", () => {
  const r = lc.compareImages(TARGET, TARGET, ranges);
  assert.equal(r.klass, "exact");
  assert.equal(r.differing_bytes, 0);
  assert.equal(r.ok, true);
  assert.equal(r.verdicts[0].summary, "exact");
});

test("a difference outside the range is text-exact", () => {
  const r = lc.compareImages(built({ 0x800: 0xFF }), TARGET, ranges);
  const v = r.verdicts[0];
  assert.equal(v.klass, "text-exact");
  assert.equal(v.out_of_range_bytes, 1);
  assert.equal(v.first_out_of_range, 0x800);
  assert.equal(v.first_in_range, null);
  assert.equal(r.ok, true);
});

test("differences inside the range are counted in words", () => {
  const r = lc.compareImages(built({ 0x104: 0xFF, 0x105: 0xFE, 0x120: 0xFD }), TARGET, ranges);
  const v = r.verdicts[0];
  assert.equal(v.klass, "text-differs");
  assert.equal(v.in_range_bytes, 3);
  assert.equal(v.in_range_words, 2);
  assert.equal(v.first_in_range, 0x104);
  assert.equal(v.summary, "text-differs 2 words");
  assert.equal(r.ok, false);
});

test("a size difference refuses a range verdict", () => {
  const r = lc.compareImages(Buffer.concat([TARGET, Buffer.alloc(16)]), TARGET, ranges);
  assert.equal(r.size_delta, 16);
  assert.equal(r.verdicts[0].klass, "size-differs");
  assert.equal(r.verdicts[0].summary, "size-differs (+16)");
  assert.equal(r.ok, false);
});

test("a range past the shorter image is a size difference", () => {
  const short = TARGET.subarray(0, 0x120);
  assert.equal(lc.compareImages(short, Buffer.concat([short, Buffer.alloc(0x100)]), ranges).verdicts[0].klass, "size-differs");
});

test("a range past an equal-length image says that, not a delta", () => {
  const r = lc.compareImages(TARGET, TARGET, [R("beyond", TARGET.length - 4, TARGET.length + 8)]);
  const v = r.verdicts[0];
  assert.equal(v.klass, "size-differs");
  assert.equal(v.past_image, true);
  assert.equal(v.size_delta, 0);
  assert.ok(v.summary.includes("past the image"));
  assert.equal(r.ok, false);
});

test("a range inside a differently sized image is not past it", () => {
  const r = lc.compareImages(Buffer.concat([TARGET, Buffer.alloc(16)]), TARGET, ranges);
  assert.equal(r.verdicts[0].past_image, false);
  assert.equal(r.verdicts[0].summary, "size-differs (+16)");
});

test("many ranges over a wholly differing image stay linear", () => {
  const size = 0x40000;
  const target = Buffer.alloc(size), build = Buffer.alloc(size, 0xFF);
  const many = Array.from({ length: 400 }, (_, i) => R(`f${i}`, i * 0x40, i * 0x40 + 0x40));
  const start = Date.now();
  const r = lc.compareImages(build, target, many);
  assert.ok(Date.now() - start < 5000);
  assert.equal(r.verdicts[0].in_range_words, 0x10);
  assert.equal(r.verdicts[0].first_in_range, 0);
  assert.equal(r.verdicts[1].first_in_range, 0x40);
  assert.equal(r.verdicts[0].out_of_range_bytes, size - 0x40);
  assert.equal(r.verdicts[0].first_out_of_range, 0x40);
  assert.equal(r.verdicts.at(-1).first_out_of_range, 0);
});

test("the image verdict is the worst of its ranges", () => {
  const r = lc.compareImages(built({ 0x104: 0xFF }), TARGET, [R("a", 0, 0x40), R("draw", 0x100, 0x140)]);
  assert.deepEqual(r.verdicts.map((v) => v.klass), ["text-exact", "text-differs"]);
  assert.equal(r.klass, "text-differs");
});

test("with no ranges the image still gets a verdict", () => {
  assert.equal(lc.compareImages(TARGET, TARGET).klass, "exact");
  assert.equal(lc.compareImages(built({ 0x800: 0xFF }), TARGET).klass, "text-exact");
});

test("every differing byte is visited across block boundaries", () => {
  const big = Buffer.alloc(0x4000), edited = Buffer.alloc(0x4000);
  for (const o of [0x0, 0xFFF, 0x1000, 0x2FFF, 0x3FFF]) edited[o] = 0xFF;
  assert.deepEqual([...lc.differingOffsets(edited, big)], [0x0, 0xFFF, 0x1000, 0x2FFF, 0x3FFF]);
});

test("the table names the class and the first offset", () => {
  const text = lc.render(lc.compareImages(built({ 0x104: 0xFF }), TARGET, ranges)).join("\n");
  for (const s of ["draw", "text-differs", "0x104", "verdict         text-differs"]) assert.ok(text.includes(s), s);
});

test("the JSON document carries every range and its class", () => {
  const payload = JSON.parse(JSON.stringify(lc.compareImages(built({ 0x104: 0xFF }), TARGET, ranges).asDict()));
  assert.equal(payload.schema, lc.LINKED_COMPARE_SCHEMA);
  assert.equal(payload.class, "text-differs");
  assert.equal(payload.ranges[0].in_range_words, 1);
  assert.equal(payload.ok, false);
});

test("a ranges file written by a host reads back", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-lc-"));
  const p = path.join(dir, "ranges.json");
  writeFileSync(p, JSON.stringify({ schema: lc.RANGES_SCHEMA, ranges: [{ name: "draw", start: "0x100", end: "0x140" }] }));
  assert.equal(lc.parseRanges(JSON.parse(readFileSync(p, "utf8")), { origin: p })[0].size, 0x40);
  rmSync(dir, { recursive: true, force: true });
});

// relocation identity

const site = () => new Site({ symbol: "callee", object: "build/tu.o", section: ".text", object_offset: 4, type: R_MIPS_26 });
function provider(status = "resolved") {
  const entry = { object: "build/tu.o", section: ".text", object_offset: 4, type: R_MIPS_26, symbol: "callee", status, evidence: "canonical overlay ownership" };
  if (status === "resolved") entry.identity = { namespace: "overlay-section-offset", module: "overlay7", section: ".text", offset: "0x120", addend: 0 };
  return { schema: IDENTITY_PROVIDER_SCHEMA, entries: [entry] };
}

test("a resolved identity is joined by the exact site", () => {
  const report = identityReport([site()], parseIdentityProvider(provider()));
  assert.equal(report.complete, true);
  assert.equal(report.resolved, 1);
  assert.equal(report.entries[0].identity.module, "overlay7");
  assert.equal(report.entries[0].identity.offset, 0x120);
});

test("missing knowledge is unknown, not a contradiction", () => {
  const report = identityReport([site()], parseIdentityProvider({ schema: IDENTITY_PROVIDER_SCHEMA, entries: [] }));
  assert.equal(report.complete, false);
  assert.deepEqual([report.unknown, report.contradicted], [1, 0]);
});

test("a contradiction is distinct and blocks completeness", () => {
  const report = identityReport([site()], parseIdentityProvider(provider("contradicted")));
  assert.equal(report.complete, false);
  assert.equal(report.contradicted, 1);
});

test("duplicate exact sites are refused", () => {
  const document = provider();
  document.entries = [document.entries[0], document.entries[0]];
  assert.throws(() => parseIdentityProvider(document), /duplicates/);
});

test("unknown entries cannot smuggle an identity", () => {
  const document = provider("unknown");
  document.entries[0].identity = { namespace: "overlay", module: "wrong", section: ".text", offset: 0 };
  assert.throws(() => parseIdentityProvider(document), /only when status=resolved/);
});

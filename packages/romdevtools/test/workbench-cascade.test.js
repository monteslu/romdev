// The CDX allocator decision cascade: frame-offset spellings, CdxLog
// indexing, every round of one site's cascade, the kill signal, the colour
// order with its same-save ties, block intersections, and the
// trace-cascade / trace-order / trace-blocks commands. Ported from the
// workbench's own cascade tests; the logs are generated here from the
// record grammar (synthetic, not captured).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CascadeError, CdxLog, blockReport, colorOrderReport, formatFrameOffset, parseFrameOffset } from "../src/decomp/workbench/cascade.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { assemble } from "./fixtures/workbench/mips-asm.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const fixtureLog = () => new CdxLog(fs.readFileSync(path.join(FIX, "cascade.trace"), "utf8"), { name: "cascade.log" });

const DETAIL = "[CDX] webdetail phase=p1 proc=0 role=target web={web} sym={sym} type=3 dtype=13 table=847 chain=1 exprtable=1865 exprchain=1 bb=371 line=23 "
  + "raw10={raw10} raw14=0x00030102 raw18=0x04010000 raw20=0x00000000";
const OCC = "[CDX] saveocc proc=0 web={web} occ={occ} usesdefs=1.0 weight={weight} term=1.000000 bb={bb} uses={uses} defs={defs} occp=1 nl={nl} bb5=0 "
  + "o22={o22} o23={o23} w34={w34}";
const SAVE = "[CDX] savedetail proc=0 web={web} sym={sym} occ={occ} gross={gross} chargeA={charge_a} chargeB={charge_b} net={net} divisor={nocs} "
  + "nocs={nocs} dtype=13 save={save} class={piece_class} forced=0";
const DEC = "[CDX] p1dec phase=p1 proc=0 web={web} sym={sym} class=2 save={save} nocs={nocs} totalsave={net} bestcost={cost} bestcolor={color} bestreg=? "
  + "forbidden0={forbidden} forbidden1=0x00000000 regsleft=5 numintf={intf} available0={available} available1=0x00000000 allcallersave=0 taken1=-1 "
  + "taken2=-1 decision={decision} forced={forced}";
const COLOR = "[CDX] p1color phase=p1 proc=0 web={web} sym={sym} color={color} reg=? forced={forced}";
const fmt = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => String(values[k]));

const ONE_FREE = "0x000000fb", ONE_FREE_TIE = "0x00000004", THREE_FREE = "0x000000e3", THREE_FREE_TIE = "0x0000001c";
const TARGET_OFFSET = "0xfffffdf8";
const f6 = (v) => v.toFixed(6);

/** A four-round split cascade, ending in a colour or in a kill. */
function cascadeLog({ symbol, killed }) {
  const lines = ["[CDX] globalcolor proc=0"];
  const parent = symbol, child = symbol + 2020;
  for (const web of [parent, child]) lines.push(fmt(DETAIL, { web, sym: symbol, raw10: TARGET_OFFSET }));
  lines.push(fmt(DETAIL, { web: 255, sym: 255, raw10: "0xfffffcec" }));
  lines.push(fmt(OCC, { web: 255, occ: 1, weight: "1.0", bb: 900, uses: 2, defs: 0, nl: 0, o22: 0, o23: 0, w34: 0 }));
  lines.push(fmt(SAVE, { web: 255, sym: 255, occ: 1, gross: "24.000000", charge_a: "0.000000", charge_b: "0.000000", net: "24.000000", nocs: 3, save: "8.000000", piece_class: 1 }));
  lines.push(fmt(DEC, { web: 255, sym: 255, save: "8.000000", nocs: 3, net: "24.000000", cost: "0.000000", color: 25, forbidden: THREE_FREE, intf: 16, available: THREE_FREE_TIE, decision: "color", forced: -2 }));
  lines.push(fmt(COLOR, { web: 255, sym: 255, color: 25, forced: -2 }));
  [[8.0, 0.0], [3.0, 2.0], [2.0, 0.0]].forEach(([net, chargeB], i) => {
    const index = i + 1;
    lines.push(fmt(OCC, { web: parent, occ: 1, weight: "1.0", bb: 100 + index, uses: 1, defs: 0, nl: 0, o22: 0, o23: 0, w34: 1 }));
    if (chargeB) lines.push(fmt(OCC, { web: parent, occ: 2, weight: "2.0", bb: 200 + index, uses: 0, defs: 1, nl: 0, o22: 1, o23: 0, w34: 1 }));
    lines.push(fmt(SAVE, { web: parent, sym: symbol, occ: chargeB ? 2 : 1, gross: f6(net + chargeB), charge_a: "0.000000", charge_b: f6(chargeB), net: f6(net), nocs: 19, save: f6(net / 19), piece_class: 1 }));
    lines.push(fmt(DEC, { web: parent, sym: symbol, save: f6(net / 19), nocs: 19, net: f6(net), cost: "8.000000", color: 29, forbidden: ONE_FREE, intf: 28, available: ONE_FREE_TIE, decision: "split", forced: -2 }));
    lines.push(fmt(SAVE, { web: parent, sym: symbol, occ: 1, gross: "1.000000", charge_a: "2.000000", charge_b: "0.000000", net: "-1.000000", nocs: 2, save: "-0.500000", piece_class: 2 }));
  });
  lines.push(fmt(OCC, { web: child, occ: 1, weight: "1.0", bb: 300, uses: 2, defs: 1, nl: 0, o22: 0, o23: 1, w34: 1 }));
  lines.push(fmt(SAVE, { web: child, sym: symbol, occ: 1, gross: "5.000000", charge_a: "1.000000", charge_b: "0.000000", net: killed ? "0.000000" : "4.000000", nocs: 2, save: killed ? "0.000000" : "2.000000", piece_class: killed ? 2 : 1 }));
  lines.push(fmt(DEC, { web: child, sym: symbol, save: killed ? "0.000000" : "2.000000", nocs: 2, net: killed ? "0.000000" : "4.000000", cost: "0.000000", color: 27, forbidden: THREE_FREE, intf: 10, available: THREE_FREE_TIE, decision: killed ? "split" : "color", forced: -2 }));
  if (!killed) lines.push(fmt(COLOR, { web: child, sym: symbol, color: 27, forced: -2 }));
  return lines.join("\n") + "\n";
}

/** A CDX_FORCE run: `bestcolor` is 24, the web is forced onto c25. */
const forcedLog = () => ["[CDX] globalcolor proc=0", fmt(DETAIL, { web: 40, sym: 40, raw10: TARGET_OFFSET }),
  fmt(DEC, { web: 40, sym: 40, save: "2.000000", nocs: 2, net: "4.000000", cost: "0.000000", color: 24, forbidden: THREE_FREE, intf: 10, available: THREE_FREE_TIE, decision: "color", forced: 25 }),
  fmt(COLOR, { web: 40, sym: 40, color: 25, forced: 25 })].join("\n") + "\n";

const shippedOnlyLog = () => cascadeLog({ symbol: 1039, killed: false }).split("\n").slice(0, -1)
  .filter((l) => !l.startsWith("[CDX] savedetail") && !l.startsWith("[CDX] saveocc")).join("\n") + "\n";

const tieLog = () => cascadeLog({ symbol: 1039, killed: false })
  + "[CDX] p1dec phase=p1 proc=0 web=260 sym=260 class=2 save=8.000000 nocs=3 totalsave=24.000000 bestcost=0.000000 bestcolor=24 "
  + "bestreg=? forbidden0=0x000000e3 forbidden1=0x00000000 regsleft=5 numintf=15 available0=0x0000001c available1=0x00000000 "
  + "allcallersave=0 taken1=-1 taken2=-1 decision=color forced=-2\n";

function written(text, { name = "build.ilog", extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-cascade-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  for (const [n, t] of Object.entries(extra)) fs.writeFileSync(path.join(dir, n), t);
  return { file, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const logOf = (text, name = "build.ilog") => new CdxLog(text, { name });
const at = (log) => log.cascade(log.resolve({ frame_offset: parseFrameOffset(TARGET_OFFSET) }));

// -- frame offsets and log indexing (fixture log) --

test("a frame offset parses from every spelling a trace or reader uses", () => {
  assert.equal(parseFrameOffset("0xfffffdf8"), -520);
  assert.equal(parseFrameOffset("-520"), -520);
  assert.equal(parseFrameOffset(" 0XFFFFFDF8 "), -520);
  assert.equal(parseFrameOffset("16"), 16);
  assert.throws(() => parseFrameOffset("slot"), (e) => e instanceof CascadeError && /not a frame offset/.test(e.message));
  assert.equal(formatFrameOffset(-520), "0xfffffdf8 (-520)");
  assert.equal(formatFrameOffset(16), "0x00000010 (+16)");
});

test("the log is indexed by record kind, frame offset, symbol and web", () => {
  const l = fixtureLog();
  assert.equal(l.kinds.get("webdetail"), 3);
  assert.deepEqual(l.missing(["p1dec", "symtab"]), ["symtab"]);
  const offsets = l.frameOffsets();
  assert.deepEqual([...offsets.get(-520)], [1039]);
  assert.deepEqual([...offsets.get(-788)], [255]);
  assert.deepEqual(l.websOfSymbol(1039), [1039, 3059]);
  assert.equal(l.symbolOfWeb(3059), 1039);
  assert.equal(l.webDetail(255).raw10, "0xfffffcec");
  assert.deepEqual(l.webDetail(99999), {});
});

test("a missing record kind is refused by name, with what is present", () => {
  assert.throws(() => fixtureLog().require(["symtab"], { purpose: "a frame ladder" }),
    (e) => e instanceof CascadeError && e.message.includes("carries no symtab record(s), which a frame ladder needs") && e.message.includes("Present: globalcolor"));
  fixtureLog().require(["p1dec", "webdetail"], { purpose: "a cascade" });
});

test("allocator decisions reach the colouring sweep records", () => {
  const webs = fixtureLog().trace.allocatorWebs({ proc: 0 });
  assert.ok(webs.length >= 3);
  assert.ok(webs.every((w) => w.phase_tag === "p1"));
});

// -- cascade reading --

test("every round is reported, not only the last", () => {
  const c = at(logOf(cascadeLog({ symbol: 1039, killed: false })));
  assert.equal(c.rounds.length, 4);
  assert.deepEqual(c.rounds.map((r) => r.decision), ["split", "split", "split", "color"]);
  assert.deepEqual(c.rounds.map((r) => r.index), [1, 2, 3, 4]);
  assert.ok(c.rounds.slice(0, 3).every((r) => r.web === 1039));
  assert.equal(c.rounds[3].web, 3059);
});

test("the site is found across a symbol renumbering", () => {
  const first = at(logOf(cascadeLog({ symbol: 1042, killed: false }), "before.ilog"));
  const second = at(logOf(cascadeLog({ symbol: 1039, killed: true }), "after.ilog"));
  assert.equal(first.site.symbol, 1042);
  assert.equal(second.site.symbol, 1039);
  assert.equal(first.killed, false);
  assert.equal(second.killed, true);
});

test("a missing offset says it is not a kill", () => {
  const log = logOf(cascadeLog({ symbol: 1039, killed: false }));
  assert.throws(() => log.resolve({ frame_offset: parseFrameOffset("0xfffffd00") }),
    (e) => e instanceof CascadeError && e.message.includes("NOT a kill") && e.message.includes("Nearest offsets present") && e.message.includes(TARGET_OFFSET));
});

test("a symbol lookup carries its own caution", () => {
  const site = logOf(cascadeLog({ symbol: 1039, killed: false })).resolve({ symbol: 1039 });
  assert.ok(site.caution.includes("trace-local"));
  assert.ok(site.caution.includes("--frame-offset"));
});

test("the colour reported is the post-resolution one", () => {
  const item = at(logOf(forcedLog(), "forced.ilog")).rounds[0];
  assert.equal(item.natural_color, 24);
  assert.equal(item.resolved_color, 25);
  assert.equal(item.resolution_differs, true);
  assert.equal(item.resolved_register, "$f2");
});

test("float registers are named from the corrected map", () => {
  const c = at(logOf(cascadeLog({ symbol: 1039, killed: false })));
  assert.equal(c.rounds[0].natural_register, "$f18");
  assert.equal(c.rounds[3].resolved_register, "$f14");
  assert.deepEqual(c.rounds[3].forbidden.map((x) => c.rounds[3].colorName(x)), ["c24/$f0", "c25/$f2", "c26/$f12", "c30", "c31"]);
});

test("the decision prints as one inequality", () => {
  const c = at(logOf(cascadeLog({ symbol: 1039, killed: false })));
  assert.equal(c.rounds[0].inequality, "net 8.000 <= bestcost 8.000 ?  YES -> split (memory-resident, no colour)");
  assert.equal(c.rounds[3].inequality, "net 4.000 <= bestcost 0.000 ?  NO -> colour it");
  assert.ok(Math.abs(c.rounds[3].deficit - 4.0) < 1e-7);
});

test("the chargeB gate reproduces the recorded charge", () => {
  const detail = at(logOf(cascadeLog({ symbol: 1039, killed: false }))).rounds[1].entering;
  assert.equal(detail.charge_b, 2.0);
  assert.equal(detail.charge_b_accounted, true);
  const payers = detail.charge_b_contributors;
  assert.deepEqual(payers.map((p) => p.index), [2]);
  assert.deepEqual([payers[0].o22, payers[0].defs, payers[0].o23], [1, 1, 0]);
});

test("each round keeps its own occurrence list", () => {
  const c = at(logOf(cascadeLog({ symbol: 1039, killed: false })));
  assert.deepEqual(c.rounds.map((r) => (r.entering ? r.entering.occurrences.length : 0)), [1, 2, 1, 1]);
});

test("a shipped-only log still gives rounds and the kill signal", () => {
  const c = at(logOf(shippedOnlyLog(), "shipped.ilog"));
  assert.equal(c.rounds.length, 4);
  assert.equal(c.killed, false);
  assert.equal(c.rounds[0].entering, null);
});

test("a block report needs the campaign-local records", () => {
  assert.throws(() => blockReport(logOf(shippedOnlyLog(), "shipped.ilog"), { webs: [1039], blocks: [] }),
    (e) => e instanceof CascadeError && e.message.includes("saveocc") && e.message.includes("campaign-local uopt patch"));
});

test("a log without CDX records says how to make one", () => {
  const w = written("nothing here\n");
  try { assert.throws(() => CdxLog.read(w.file), (e) => e instanceof CascadeError && e.message.includes("CDX_LOG=1")); } finally { w.done(); }
});

// -- kill signal --

test("the kill line names the colour that was taken", () => {
  assert.equal(at(logOf(cascadeLog({ symbol: 1039, killed: false }), "A1.ilog")).killLine(), "kill: NO A1.ilog sym=1039 rounds=4 colors=1 final=w3059:c27/$f14");
});

test("the kill line says YES when no web was coloured", () => {
  const c = at(logOf(cascadeLog({ symbol: 1039, killed: true }), "FINAL.ilog"));
  assert.equal(c.killed, true);
  assert.equal(c.killLine(), "kill: YES FINAL.ilog sym=1039 rounds=4 colors=0");
});

// -- colour order and blocks --

test("the order names the same-save tie groups", () => {
  const report = colorOrderReport(logOf(tieLog()), { limit: null });
  assert.equal(report.tie_groups.length, 1);
  assert.equal(report.tie_groups[0].save, 8.0);
  assert.deepEqual(report.tie_groups[0].members.map((m) => m.web), [255, 260]);
});

test("the float class filter is the float web census", () => {
  const log = logOf(cascadeLog({ symbol: 1039, killed: false }));
  const floats = colorOrderReport(log, { limit: null, register_class: 2 });
  const integers = colorOrderReport(log, { limit: null, register_class: 1 });
  assert.equal(floats.shown, floats.decision_count);
  assert.ok(floats.order.every((i) => i.register_class === 2));
  assert.equal(integers.shown, 0);
  assert.equal(floats.order[0].position, 1);
});

test("two webs sharing no block are named as disjoint", () => {
  const report = blockReport(logOf(cascadeLog({ symbol: 1039, killed: false })), { webs: [255, 3059], blocks: [] });
  assert.equal(report.disjoint, true);
  assert.deepEqual(report.intersection, []);
  assert.deepEqual(report.webs[0].blocks, [900]);
  assert.deepEqual(report.webs[1].blocks, [300]);
});

test("a block query finds every web occurring in it", () => {
  assert.deepEqual(blockReport(logOf(cascadeLog({ symbol: 1039, killed: false })), { webs: [], blocks: [900] }).webs.map((w) => w.web), [255]);
});

test("a web with no occurrences is an error, not an empty set", () => {
  assert.throws(() => blockReport(logOf(cascadeLog({ symbol: 1039, killed: false })), { webs: [999], blocks: [] }), (e) => e instanceof CascadeError && e.message.includes("999"));
});

// -- commands --

const PROLOGUE = ["addiu sp,sp,-1704", "sw ra,28(sp)"];
const EPILOGUE = ["lw ra,28(sp)", "jr ra", "addiu sp,sp,1704"];
const ROM_BODY = [...PROLOGUE, "lwc1 f0,1184(sp)", "swc1 f12,1184(sp)", ...EPILOGUE];
const CANDIDATE_BODY = [...PROLOGUE, "lwc1 f14,1184(sp)", "lwc1 f14,1184(sp)", "swc1 f14,1184(sp)", ...EPILOGUE];

async function cli(text, argv, opts) {
  const w = written(text, opts);
  try { return await runCommand(argv(w)); } finally { w.done(); }
}

test("the command prints every round and the kill signal", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET]);
  assert.equal(r.code, 0);
  for (const s of ["round 4", "kill: NO", "net 8.000 <= bestcost 8.000 ?  YES", "piece left memory-resident"]) assert.ok(r.stdout.includes(s), s);
});

test("the kill flag prints one line", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: true }), (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--kill"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "kill: YES build.ilog sym=1039 rounds=4 colors=0");
});

test("a slot needs a frame and the error says the arithmetic", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--slot", "1184"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--frame -1704"));
});

test("a slot and a frame name the same site as the offset", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--slot", "1184", "--frame", "-1704"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("frame offset 0xfffffdf8 (-520)"));
});

test("the diff reports a renumbered symbol and a changed kill", async () => {
  const a = written(cascadeLog({ symbol: 1042, killed: false }), { name: "a.ilog" });
  const b = written(cascadeLog({ symbol: 1039, killed: true }), { name: "b.ilog" });
  try {
    const r = await runCommand(["trace-cascade", a.file, "--against", b.file, "--frame-offset", TARGET_OFFSET]);
    assert.equal(r.code, 0);
    for (const s of ["symbol 1042 -> 1039", "renumbered", "VERDICT: the kill signal changed"]) assert.ok(r.stdout.includes(s), s);
  } finally { a.done(); b.done(); }
});

test("the occurrence table marks the chargeB payers", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--occurrences"]);
  assert.equal(r.code, 0);
  for (const s of ["o22 o23 w34", "PAYS", "store-placement term (L92)"]) assert.ok(r.stdout.includes(s), s);
});

test("the reference object names the colours it never uses (retained dump)", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }),
    (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--rom", path.join(w.dir, "target.dump"), "--dumps"],
    { extra: { "target.dump": assemble(ROM_BODY, { symbol: "demo" }) } });
  assert.equal(r.code, 0, r.stderr);
  for (const s of ["float colours the reference uses:", "never uses: c25/$f2 c27/$f14 c28/$f16 c29/$f18", "cheapest-tie colours the reference never uses",
    "cannot have been blocked by those colours", "occupancy over the named rows"]) assert.ok(r.stdout.includes(s), s);
});

test("the screen line carries stores apart from loads (retained dump)", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }),
    (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--object", path.join(w.dir, "candidate.dump"), "--dumps", "--slot", "1184"],
    { extra: { "candidate.dump": assemble(CANDIDATE_BODY, { symbol: "demo" }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("ld1184=2 st1184=1"), r.stdout);
});

test("two site spellings that disagree are refused; that agree are accepted", async () => {
  const bad = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--slot", "999", "--frame", "-1704", "--kill"]);
  assert.equal(bad.code, 2);
  for (const s of ["-520", "-705", "Name one site"]) assert.ok(bad.stderr.includes(s), s);
  const good = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--slot", "1184", "--frame", "-1704", "--kill"]);
  assert.equal(good.code, 0);
  assert.ok(good.stdout.includes("kill:"));
});

test("an unreadable reference object is refused, not traced back", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }),
    (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--rom", path.join(w.dir, "target.o"), "--objdump", "/bin/false"],
    { extra: { "target.o": "\x7fELF placeholder" } });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith("error: objdump failed for"), r.stderr);
  assert.ok(!r.stderr.includes("    at "));
});

test("JSON carries the schema and the rounds; a missing site is a JSON error", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--frame-offset", TARGET_OFFSET, "--json"]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "decomp-workbench-cascade-v1");
  assert.equal(doc.rounds.length, 4);
  assert.equal(doc.rounds[3].resolved_register, "$f14");
  assert.equal(doc.killed, false);
  const e = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-cascade", w.file, "--frame-offset", "0xfffffd00", "--json"]);
  assert.equal(e.code, 2);
  const err = JSON.parse(e.stdout);
  assert.equal(err.schema, "decomp-workbench-error-v1");
  assert.ok(err.error.message.includes("NOT a kill"));
});

test("the grammar is printable without a log", async () => {
  const r = await runCommand(["trace-cascade", "--grammar"]);
  assert.equal(r.code, 0);
  for (const s of ["savedetail", "CAMPAIGN-LOCAL", "p1-decision-arithmetic", "symtabcount"]) assert.ok(r.stdout.includes(s), s);
});

test("the order command prints the ties; the blocks command names an empty intersection", async () => {
  const o = await cli(tieLog(), (w) => ["trace-order", w.file, "--class", "2"]);
  assert.equal(o.code, 0);
  for (const s of ["colour order:", "ASCENDING web number", "pos1/w255, pos6/w260"]) assert.ok(o.stdout.includes(s), s);
  const b = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace-blocks", w.file, "--web", "255", "--web", "3059"]);
  assert.equal(b.code, 0);
  assert.ok(b.stdout.includes("intersection: EMPTY"));
});

test("the shipped example logs are the generated fixtures", () => {
  assert.equal(fs.readFileSync(path.join(FIX, "cascade.trace"), "utf8"), tieLog());
  assert.equal(fs.readFileSync(path.join(FIX, "cascade-killed.trace"), "utf8"), cascadeLog({ symbol: 1035, killed: true }));
});

test("the grouped spelling reaches the same command", async () => {
  const r = await cli(cascadeLog({ symbol: 1039, killed: false }), (w) => ["trace", "cascade", w.file, "--frame-offset", TARGET_OFFSET, "--kill"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("kill: NO"));
});

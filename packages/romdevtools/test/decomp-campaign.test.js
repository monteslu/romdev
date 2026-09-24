// The campaign layer added for the decomp acceleration audit: work classes,
// semantic gating, experiment records, mechanism-aware ranking, the dispatcher,
// asset round-trips, artifact retention and skill staleness.
//
// Each test pins a rule that, if broken, produces a CONFIDENT WRONG ANSWER
// rather than an error - which is the failure mode this whole domain exists to
// prevent.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeWorkClassifier } from "../src/decomp/work-class.js";
import { semanticGate } from "../src/decomp/semantic-gate.js";
import { rankCandidates } from "../src/decomp/ranking.js";
import { Dispatcher } from "../src/decomp/dispatch.js";
import { identify, roundTrip, encodeMio0, decodeMio0Container } from "../src/decomp/assets.js";

/** The assets module, for tests that need several of its exports. */
function require0() { return { encodeMio0, decodeMio0Container, roundTrip, identify }; }
import { generateSkill } from "../src/decomp/skill-sync.js";

// ── work classes ───────────────────────────────────────────────────────────

test("work class: one TU listed under several sections classifies by its CODE type", () => {
  // splat lists "sys/sys_utils" three times: as `c`, `.rodata` AND `.bss`. A
  // plain Map.set keeps whichever came last (.rodata), so every such object
  // classified as data - that misfiled 152 real game functions and emptied the
  // default queue entirely.
  const splat = { segments: [{ name: "main", subsegments: [
    { name: "sys/sys_utils", type: "c" },
    { name: "sys/sys_utils", type: ".rodata" },
    { name: "sys/sys_utils", type: ".bss" },
  ] }] };
  const classify = makeWorkClassifier(splat, { splat: { buildPath: "build", srcPath: "src" } });
  assert.equal(classify("build/src/sys/sys_utils.o"), "game-matching-c");
});

test("work class: the subsegment is matched by FULL PATH, not basename alone", () => {
  // The linker map names objects "build/src/sys/sys_utils.o" while splat names
  // subsegments "sys/sys_utils". Two directories can hold the same file name.
  const splat = { segments: [{ name: "m", subsegments: [
    { name: "game/render", type: "c" },
    { name: "audio/render", type: "hasm" },
  ] }] };
  const classify = makeWorkClassifier(splat, { splat: { buildPath: "build", srcPath: "src" } });
  assert.equal(classify("build/src/game/render.o"), "game-matching-c");
  assert.equal(classify("build/src/audio/render.o"), "handwritten-asm-retain");
});

test("work class: handwritten asm and libultra are separated from game targets", () => {
  const splat = { segments: [{ name: "m", subsegments: [{ name: "entrypoint", type: "hasm" }] }] };
  const classify = makeWorkClassifier(splat, { splat: { buildPath: "build", srcPath: "src" } });
  assert.equal(classify("build/asm/us/rev1/entrypoint.o"), "handwritten-asm-retain");
  assert.equal(classify("build/src/libultra/os/thread.o"), "libultra-known-source");
  assert.equal(classify("build/src/rsp/ucode.o"), "rsp-source");
});

// ── the semantic gate ──────────────────────────────────────────────────────

test("gate: exactness is NEVER erased by a quality finding", () => {
  // These are separate dimensions. A candidate can be exact AND artificial, and
  // collapsing them is how an unmaintainable source tree gets integrated.
  const g = semanticGate({ candidateText: "void f(void){ s32 i; i = i; }", exactFunctionMatch: true, functionLocal: "exact" });
  assert.equal(g.classification, "byte-exact/artificial");
  assert.equal(g.exactFunctionMatch, true, "the exactness result must survive");
  assert.equal(g.functionLocal, "exact");
  assert.equal(g.integrationEligible, false);
});

test("gate: the score-optimiser's constructs are all caught", () => {
  for (const [src, id] of [
    ["void f(void){ s32 i; i = i; }", "self-assignment"],
    ["void f(s32 x){ if (x) { } }", "empty-branch"],
    ["void f(s32 *p){ p[0] = (p, 0); }", "comma-zero"],
  ]) {
    const g = semanticGate({ candidateText: src, exactFunctionMatch: true, functionLocal: "exact" });
    assert.ok(g.findings.some((f) => f.id === id), `${id} must be caught in: ${src}`);
    assert.equal(g.classification, "byte-exact/artificial");
  }
});

test("gate: patterns inside strings and comments are NOT findings", () => {
  // A checker that fires on its own documentation is a checker nobody runs.
  for (const src of [
    'void f(void){ debug("i = i;"); note("(a, 0)"); }',
    "void f(void){ /* i = i; and if (x) { } */ s32 a; a = 1; }",
  ]) {
    const g = semanticGate({ candidateText: src, exactFunctionMatch: true, functionLocal: "exact" });
    assert.equal(g.counts.total, 0, `false positive in: ${src}`);
    assert.equal(g.classification, "byte-exact/plausible");
  }
});

test("gate: dropping volatile or short-circuiting is a behaviour change", () => {
  const base = "void f(volatile u32 *r, s32 n){ if (n > 0 && ok(n)) { *r = 1; } }";
  const cand = "void f(u32 *r, s32 n){ if (n > 0 & (n != 0)) { *r = 1; } }";
  const g = semanticGate({ candidateText: cand, baselineText: base, exactFunctionMatch: true, functionLocal: "exact" });
  assert.ok(g.findings.some((f) => f.id === "volatile-dropped"));
  assert.ok(g.findings.some((f) => f.id === "short-circuit-lost"));
  assert.equal(g.classification, "byte-exact/artificial");
});

test("gate: a non-exact candidate is 'not-exact' however clean it reads", () => {
  const g = semanticGate({ candidateText: "void f(s32 *p){ p[0] = 1; }", exactFunctionMatch: false });
  assert.equal(g.classification, "not-exact");
  assert.equal(g.integrationEligible, false);
});

// ── mechanism-aware ranking ────────────────────────────────────────────────

test("ranking: aligned_total is NEVER compared across different gap states", () => {
  // THE TRAP: `b` posts a LOWER aligned_total precisely because more of its
  // rows failed to line up. Ranking a mixed set by that scalar picks the worse
  // candidate with full confidence.
  const r = rankCandidates([
    { id: "a", comparison: { aligned_gaps: 0, aligned_insertions: 0, aligned_deletions: 0, aligned_total: 8, aligned_register: 8 }, distance: 12 },
    { id: "b", comparison: { aligned_gaps: 6, aligned_insertions: 6, aligned_deletions: 0, aligned_total: 3, aligned_register: 3 }, distance: 44 },
  ]);
  assert.equal(r.mixedGapState, true);
  assert.equal(r.rankingRule, "fallback-distance");
  assert.equal(r.ranked[0].id, "a", "the candidate with fewer gaps and lower distance must win");
  assert.match(r.rankingRationale, /not comparable|different gap states/i);
});

test("ranking: within ONE gap state, aligned metrics rank", () => {
  const r = rankCandidates([
    { id: "a", comparison: { aligned_gaps: 0, aligned_insertions: 0, aligned_deletions: 0, aligned_total: 8, aligned_register: 8 }, distance: 30 },
    { id: "b", comparison: { aligned_gaps: 0, aligned_insertions: 0, aligned_deletions: 0, aligned_total: 3, aligned_register: 3 }, distance: 35 },
  ]);
  assert.equal(r.rankingRule, "aligned");
  assert.equal(r.ranked[0].id, "b", "lower aligned_total wins when the gap state matches");
  assert.equal(r.ranked[0].mechanismOwner, "register");
});

test("ranking: temporary-prefix is refused when its precondition does not hold", () => {
  const r = rankCandidates([
    { id: "a", comparison: { aligned_gaps: 0, aligned_total: 8 }, distance: 12 },
    { id: "b", comparison: { aligned_gaps: 3, aligned_total: 3 }, distance: 44 },
  ], { preferTemporaryPrefix: true });
  assert.equal(r.rankingRule, "fallback-distance");
  assert.match(r.rankingRationale, /precondition/i);
});

test("ranking: candidates compiling to the same object are counted once", () => {
  const r = rankCandidates([
    { id: "x", objectSha: "dead", comparison: { aligned_gaps: 0, aligned_total: 5 }, distance: 10 },
    { id: "y", objectSha: "dead", comparison: { aligned_gaps: 0, aligned_total: 5 }, distance: 10 },
    { id: "z", objectSha: "beef", comparison: { aligned_gaps: 0, aligned_total: 9 }, distance: 20 },
  ]);
  assert.equal(r.ranked.length, 2, "duplicates overstate a sweep's yield");
  assert.equal(r.deduplicated.length, 1);
});

// ── the dispatcher ─────────────────────────────────────────────────────────

test("dispatcher: two workers never hold the same TU lock", async () => {
  // compileAndCompare splices the candidate into its owning TU, so a race here
  // corrupts both results silently.
  const d = new Dispatcher({ budgetMiB: 1_000_000, maxWorkers: 8 });
  const live = new Map();
  let violations = 0, peak = 0, running = 0;
  const task = (tu, i) => ({ cls: "compare", lockKey: tu, label: `t${i}`, fn: async () => {
    running++; peak = Math.max(peak, running);
    const n = (live.get(tu) ?? 0) + 1; live.set(tu, n);
    if (n > 1) violations++;
    await new Promise((r) => setTimeout(r, 15));
    live.set(tu, live.get(tu) - 1); running--;
    return { i };
  } });
  const tasks = [];
  for (let i = 0; i < 18; i++) tasks.push(task(`tu${i % 6}`, i));
  const res = await d.all(tasks);
  assert.equal(violations, 0, "a TU lock violation would corrupt both candidates");
  assert.ok(res.every((r) => r.ok));
  assert.ok(peak > 1, "independent TUs must actually run in parallel");
  assert.ok(peak <= 6, `at most one worker per distinct TU, got ${peak}`);
});

test("dispatcher: admission is bounded by MEMORY, not just worker count", async () => {
  // A thread count cannot express "instrumented IDO takes 1.5GB".
  const d = new Dispatcher({ budgetMiB: 700, maxWorkers: 16 });  // one 600MiB compare fits
  let peak = 0, running = 0;
  const tasks = Array.from({ length: 6 }, (_, i) => ({ cls: "compare", lockKey: `tu${i}`, label: `t${i}`, fn: async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--; return {};
  } }));
  await d.all(tasks);
  assert.equal(peak, 1, "a 700MiB budget admits exactly one 600MiB worker, regardless of maxWorkers");
  assert.ok(d.report().stats.deferredForMemory > 0, "the memory ceiling must actually defer work");
});

// ── asset round-trip ───────────────────────────────────────────────────────

test("assets: an unidentified range says so instead of guessing", () => {
  const id = identify(Buffer.from("not a known container at all, really"), { name: "mystery" });
  assert.equal(id.candidates[0].confidence, "none");
  assert.match(id.note, /NOT identified/);
});

test("assets: a MIO0 range round-trips to BYTE-IDENTICAL bytes", () => {
  // Round trip is the acceptance test, and it now completes: romdev ships an
  // encoder that reproduces the reference's match choices, so decode -> encode
  // returns the original container byte for byte. An earlier version of this
  // test asserted only that decode alone is NOT "recovered" - true, but it
  // stopped short of the thing that actually matters.
  const { encodeMio0, decodeMio0Container, roundTrip } = require0();
  // A payload with runs, repeats and literals - all three encoder paths.
  const payload = Buffer.concat([
    Buffer.alloc(64),                                   // run-fill
    Buffer.from("the quick brown fox ".repeat(12)),     // long matches
    Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 37) & 0xff)), // literals
  ]);
  const container = encodeMio0(payload);
  assert.equal(container.toString("ascii", 0, 4), "MIO0");

  // decode(encode(x)) === x : the payload survives.
  const back = decodeMio0Container(container);
  assert.ok(back && Buffer.compare(Buffer.from(back), payload) === 0, "payload must survive the round trip");

  // encode(decode(container)) === container : the CONTAINER survives too.
  const r = roundTrip(container, { name: "synthetic" });
  assert.equal(r.payloadExact, true, "payload round trip");
  assert.equal(r.containerExact, true, `container round trip: ${r.why}`);
  assert.equal(r.roundTrip, "byte-exact");
  assert.equal(r.state, "round-trip-tool", "byte-exact repack is what advances a range past format-identified");
});

test("assets: payload-exact is reported SEPARATELY from container-exact", () => {
  // Two different claims. A container that decodes to the same payload is
  // editable; one that is byte-identical additionally rebuilds the original
  // ROM. Collapsing them would overstate the result.
  const { encodeMio0, roundTrip } = require0();
  const container = encodeMio0(Buffer.from("abcabcabcabc".repeat(8)));
  const r = roundTrip(container, { name: "s" });
  assert.equal(typeof r.payloadExact, "boolean");
  assert.equal(typeof r.containerExact, "boolean");
  assert.match(r.why, /byte for byte|PAYLOAD exactly|not faithful/i);
});

// ── skill sync ─────────────────────────────────────────────────────────────

test("skill: a generated skill names every platform the server actually has", () => {
  // The installed skill declared ~14 platforms and never mentioned N64 while
  // the server had full N64 support. An agent reading it correctly concludes
  // romdev cannot do the thing it is being asked to do.
  const md = generateSkill({
    version: "0.139.0",
    platforms: ["nes", "snes", "genesis", "n64", "ps1", "dreamcast", "wasmcart"],
    decompPlatforms: ["n64"], domains: [{ name: "decomp", description: "matching decompilation" }],
  });
  for (const p of ["n64", "ps1", "dreamcast", "wasmcart"]) {
    assert.ok(md.includes(p), `the generated skill must mention ${p}`);
  }
  assert.match(md, /version: "0\.139\.0"/);
  assert.match(md, /do not hand-edit/i, "a generated file must say it is generated");
  // And it must carry the contract that keeps a reader honest.
  assert.match(md, /never invented|no single completion percentage/i);
});

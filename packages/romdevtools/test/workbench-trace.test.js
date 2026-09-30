// Ported from the workbench's trace tests: CODEX/DKWB free-list parsing,
// normalized actions, and the strict FIFO replay the temp-ring lever reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMISSION_MAP_SCHEMA, aliasTraceSummary, parseEmissionMap, parseRegister, parseTrace, registerName, replayFifo, traceSummary } from "../src/decomp/workbench/trace.js";

const TRACE = `noise from the compiler
CODEX-UGEN-APPEND line=182 list=10019da4 reg=14
CODEX-UGEN-APPEND line=182 list=10019da4 reg=15
CODEX-UGEN-ALLOC serial=1 line=700 reg=14
CODEX-UGEN-ALLOC serial=2 line=701 reg=15
CODEX-UGEN-APPEND line=702 list=10019da4 reg=14
CODEX-UGEN-ALLOC serial=3 line=703 reg=14
CODEX-UGEN-APPEND line=704 list=10019da4 reg=15
CODEX-UGEN-APPEND line=705 list=10019da4 reg=14
`;

test("parses the historical trace", () => {
  const events = parseTrace(TRACE);
  assert.equal(events.length, 8);
  assert.equal(events[0].action, "append");
  assert.equal(events[0].list_address, 0x10019DA4);
  assert.equal(events[2].serial, 1);
  assert.equal(events[2].register, 14);
});

test("reconstructs logical values", () => {
  const r = replayFifo(parseTrace(TRACE));
  assert.ok(r.valid, r.violations.join("; "));
  assert.deepEqual(r.initial_queue, [14, 15]);
  assert.deepEqual(r.allocations, [14, 15, 14]);
  assert.deepEqual(r.final_queue, [15, 14]);
  assert.equal(r.max_live, 2);
  assert.deepEqual(r.logical_events.map((e) => [e.action, e.value]), [["allocate", 1], ["allocate", 2], ["free", 1], ["allocate", 3], ["free", 2], ["free", 3]]);
});

test("reports a FIFO violation", () => {
  const r = replayFifo(parseTrace(TRACE.replace("serial=1 line=700 reg=14", "serial=1 line=700 reg=15")));
  assert.ok(!r.valid);
  assert.ok(r.violations[0].includes("FIFO head was t6"));
});

test("the list filter keeps allocations and matching appends", () => {
  const events = parseTrace("CODEX-UGEN-APPEND list=0x1000 reg=14\nCODEX-UGEN-APPEND list=0x2000 reg=15\nCODEX-UGEN-ALLOC serial=1 reg=14\nCODEX-UGEN-APPEND reg=14\nCODEX-UGEN-APPEND list=0x1000 reg=14\n");
  const r = replayFifo(events, { list_address: 0x1000 });
  assert.ok(r.valid, r.violations.join("; "));
  assert.deepEqual(r.initial_queue, [14]);
  assert.deepEqual(r.allocations, [14]);
  assert.deepEqual(r.final_queue, [14]);
  assert.equal(r.ignored_events, 2);
});

test("summary and register names", () => {
  assert.deepEqual(traceSummary(parseTrace(TRACE)).actions, { allocate: 3, append: 5 });
  assert.equal(parseRegister("$t6"), 14);
  assert.equal(parseRegister("14"), 14);
});

test("summary separates in-range descriptors from registers", () => {
  const requests = parseTrace("DKWB-FREELIST ALLOC_GP proc=0 reg=14 emitted=1 line=2\nDKWB-FREELIST ALLOC_FP proc=0 reg=14 emitted=2 line=2\nDKWB-FREELIST ALLOC_FUTURE proc=0 reg=14 emitted=3 line=2\n");
  const s = traceSummary(requests);
  assert.deepEqual(s.registers, {});
  assert.deepEqual(s.allocation_descriptors, { "ALLOC_GP:14": 1, "ALLOC_FP:14": 1, "ALLOC_FUTURE:14": 1 });
  const legacy = parseTrace("CODEX-ALLOC reg=14\nDKWB-FREELIST ALLOC reg=14\n");
  assert.deepEqual(traceSummary([...requests, ...legacy]).registers, { t6: 2 });
  assert.deepEqual(traceSummary(legacy).allocation_descriptors, {});
});

test("summarizes the alias profile", () => {
  const events = parseTrace("DKWB-BASE ordinal=0 reg=16 kind=3 type=isvar sym=7 addr=4096 hadbase=0 path=fresh\n"
    + "DKWB-ALIAS-QUERY ordinal=0 reg=16 result=no-alias left_kind=3 left_type=isvar left_sym=7 left_addr=4096 right_kind=1 right_type=islda right_sym=8 right_addr=8192\n");
  const r = aliasTraceSummary(events);
  assert.deepEqual(events.map((e) => e.action), ["base", "alias-query"]);
  assert.deepEqual(r.base_paths, { fresh: 1 });
  assert.deepEqual(r.query_results, { "no-alias": 1 });
  assert.deepEqual(r.registers, { s0: 2 });
});

test("normalizes generic free-list events", () => {
  const events = parseTrace("DKWB-FREELIST ALLOC reg=8\nDKWB-FREELIST ADD reg=9\nDKWB-FREELIST FREE reg=10\nDKWB-FREELIST FORCE_FREE reg=11\nDKWB-FREELIST REMOVE reg=12\nDKWB-FREELIST MOVE_END reg=13\n");
  assert.deepEqual(events.map((e) => e.action), ["allocate", "append", "free-request", "free-request", "remove", "used-list-request"]);
});

test("names floating point registers from the unified space", () => {
  assert.equal(registerName(36), "$f4");
  assert.equal(registerName(38), "$f6");
  assert.equal(registerName(42), "$f10");
  assert.equal(registerName(14), "t6");
  assert.equal(registerName(96), "96");
  assert.equal(registerName(208), "208");
});

test("exposes the fp and integer temp ring pop sequences", () => {
  const fp = parseTrace("DKWB-FREELIST ALLOC_FP reg=96 emitted=3\nDKWB-FREELIST ALLOC_FP_RESULT reg=36 emitted=3\nDKWB-FREELIST ALLOC_FP reg=208 emitted=4\nDKWB-FREELIST ALLOC_FP_RESULT reg=38 emitted=4\n");
  const results = fp.filter((e) => e.fields._event === "ALLOC_FP_RESULT");
  assert.deepEqual(results.map((e) => e.register), [36, 38]);
  assert.deepEqual(results.map((e) => e.asDict().register_name), ["$f4", "$f6"]);
  assert.deepEqual(fp.map((e) => e.action), ["allocation-request", "allocate", "allocation-request", "allocate"]);
  const request = fp.find((e) => e.fields._event === "ALLOC_FP");
  assert.equal(request.register, 96);
  assert.equal(request.asDict().register_name, "96");
  const gp = parseTrace("DKWB-FREELIST ALLOC_GP reg=176 emitted=60 line=42\nDKWB-FREELIST ALLOC_GP_RESULT reg=14 emitted=60 line=42\nDKWB-FREELIST ALLOC_GP_RESULT reg=15 emitted=64 line=42\n");
  const gr = gp.filter((e) => e.fields._event === "ALLOC_GP_RESULT");
  assert.deepEqual(gr.map((e) => e.asDict().register_name), ["t6", "t7"]);
  assert.deepEqual(gp.map((e) => e.action), ["allocation-request", "allocate", "allocate"]);
  assert.deepEqual(gr.map((e) => e.source_line), [42, 42]);
});

test("mixed-procedure FIFO requires an explicit scope", () => {
  const events = parseTrace("DKWB-FREELIST ADD proc=0 reg=14\nDKWB-FREELIST ALLOC_GP_RESULT proc=0 reg=14\nDKWB-FREELIST ADD proc=1 reg=15\nDKWB-FREELIST ALLOC_GP_RESULT proc=1 reg=15\n");
  assert.throws(() => replayFifo(events), /multiple procedures/);
  const r = replayFifo(events, { procedure: 1 });
  assert.equal(r.procedure, 1);
  assert.deepEqual(r.allocations, [15]);
  assert.ok(r.logical_events.every((e) => e.procedure === 1));
});

test("modern requests are not FIFO allocations even for register values", () => {
  const events = parseTrace("DKWB-FREELIST ADD proc=0 reg=14\nDKWB-FREELIST ALLOC_GP proc=0 reg=8 emitted=1 line=2\nDKWB-FREELIST ALLOC_GP_RESULT proc=0 reg=14 emitted=1 line=2\n");
  assert.equal(events[1].asDict().register_name, "8");
  const r = replayFifo(events, { procedure: 0 });
  assert.ok(r.valid);
  assert.deepEqual(r.allocations, [14]);
  assert.deepEqual(r.asDict().allocation_event_counts, { ALLOC_GP: 1, ALLOC_GP_RESULT: 1 });
});

test("unsupported and incomplete allocations cannot validate a FIFO", () => {
  for (const bad of ["ALLOC_FUTURE reg=14", "ALLOC_GP_RESULT reg=96", "ALLOC_FP_RESULT reg=14", "ALLOC_GP reg=8"]) {
    const events = parseTrace(`DKWB-FREELIST ADD proc=0 reg=14\nDKWB-FREELIST ${bad} proc=0\n`);
    assert.ok(!replayFifo(events, { procedure: 0 }).valid, bad);
  }
});

test("scoped and unscoped events cannot be combined; unscoped diagnostics do not poison scope", () => {
  assert.throws(() => replayFifo(parseTrace("DKWB-FREELIST ADD proc=-1 reg=14\nDKWB-FREELIST ALLOC_GP_RESULT proc=0 reg=14\n")), /scoped and unscoped/);
  const r = replayFifo(parseTrace("DKWB-CALL ENTER name=f_get_free_reg\nDKWB-FREELIST ADD proc=2 reg=14\nDKWB-FREELIST ALLOC_GP_RESULT proc=2 reg=14\n"));
  assert.equal(r.procedure, 2);
  assert.ok(r.valid);
  assert.throws(() => replayFifo(parseTrace("DKWB-FREELIST ADD proc=2 reg=14\nDKWB-FREELIST ALLOC_GP_RESULT proc=2 reg=14\n"), { procedure: 3 }), /no FIFO events for procedure 3/);
});

test("joins FIFO events to emitted rows and source, never inferring a row", () => {
  const events = parseTrace("DKWB-FREELIST ADD reg=14 emitted=257\nDKWB-FREELIST ALLOC reg=14 emitted=258\nDKWB-FREELIST ADD reg=14 emitted=259\n");
  const map = parseEmissionMap({ schema: EMISSION_MAP_SCHEMA, entries: [
    { emitted_index: 258, object_row: 700, source_file: "camera.c", source_line: 412, instruction: "sll t0,t1,2" },
    { emitted_index: 259, object_row: 701, source_file: "camera.c", source_line: 412 }] });
  const r = replayFifo(events, { emission_map: map });
  assert.ok(r.valid, r.violations.join("; "));
  const a = r.logical_events[0];
  assert.equal(a.emitted_index, 258);
  assert.equal(a.object_row, 700);
  assert.equal(a.source_file, "camera.c");
  assert.equal(a.source_line, 412);
  assert.equal(a.instruction, "sll t0,t1,2");
  assert.ok(r.asDict().emission_join.complete);
  assert.equal(r.asDict().emission_join.with_instruction, 1);
  const bare = replayFifo(parseTrace("DKWB-FREELIST ADD reg=14 emitted=257\nDKWB-FREELIST ALLOC reg=14 emitted=258\n"));
  assert.equal(bare.logical_events[0].emitted_index, 258);
  assert.equal(bare.logical_events[0].object_row, null);
  assert.ok(bare.asDict().emission_join.calibration_required);
  assert.throws(() => parseEmissionMap({ schema: EMISSION_MAP_SCHEMA, entries: [{ emitted_index: 1, object_row: 2 }, { emitted_index: 1, object_row: 3 }] }), /duplicated/);
});

test("an absent explicit procedure is refused", () => {
  const events = parseTrace("DKWB-FREELIST ADD proc=2 reg=14\nDKWB-FREELIST ALLOC_GP_RESULT proc=2 reg=14\n");
  assert.throws(() => replayFifo(events, { procedure: 3 }), /no FIFO events for procedure 3/);
});

test("an emitted index is not inferred to be an object row", () => {
  const report = replayFifo(parseTrace("DKWB-FREELIST ADD reg=14 emitted=257\nDKWB-FREELIST ALLOC reg=14 emitted=258\n"));
  const event = report.logical_events[0];
  assert.equal(event.emitted_index, 258);
  assert.equal(event.object_row, null);
  assert.equal(report.asDict().emission_join.calibration_required, true);
});

test("the emission map refuses duplicate ordinals", () => {
  assert.throws(() => parseEmissionMap({ schema: EMISSION_MAP_SCHEMA, entries: [{ emitted_index: 1, object_row: 2 }, { emitted_index: 1, object_row: 3 }] }), /duplicated/);
});

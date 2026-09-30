// Opt-in ugen instrumentation, guarded uopt alias tracing, and composed uopt
// profiles. Ported from the workbench tests for instrument, instrument_alias
// and instrument_profiles; the C fixtures are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKER, instrumentUgen } from "../src/decomp/workbench/instrument.js";
import { MARKER as ALIAS_MARKER, instrumentUoptAlias } from "../src/decomp/workbench/instrument-alias.js";
import { instrumentUoptProfiles } from "../src/decomp/workbench/instrument-profiles.js";
import { MARKER as GLOBALCOLOR_MARKER } from "../src/decomp/workbench/instrument-uopt.js";

const SOURCE = `#include "header.h"
static uint32_t f_alloc_reg(uint8_t *mem, uint32_t sp, uint32_t a0) {
return a0;
}
static void f_free_reg(uint8_t *mem, uint32_t sp, uint32_t a0) {
(void)mem;
}
static void helper(void) {
}
`;

// The recompiled allocators take a request descriptor in a0 and return the
// register they chose in v0; only a return-site hook can see the allocation.
const FP_ALLOC_SOURCE = `#include "header.h"
static void f_init_regs(uint8_t *mem, uint32_t sp) {
(void)mem;
}
static uint32_t f_get_free_reg(uint8_t *mem, uint32_t sp, uint32_t a0, uint32_t a1) {
uint32_t v0 = 0, s0 = 0;
s0 = a0;
v0 = s0;
return v0;
}
static uint32_t f_get_free_fp_reg(uint8_t *mem, uint32_t sp, uint32_t a0) {
uint32_t v0 = 0, s0 = 0;
s0 = a0;
v0 = s0;
return v0;
}
static void f_free_reg(uint8_t *mem, uint32_t sp, uint32_t a0) {
(void)mem;
}
`;

// The ibuffer emit helpers; f_demit_* writes the backward buffer.
const EMIT_SOURCE = `#include "header.h"
static void f_emit_rrr(uint8_t *mem, uint32_t sp, uint32_t a0, uint32_t a1) {
(void)mem;
}
static void f_demit_dir1(uint8_t *mem, uint32_t sp, uint32_t a0, uint32_t a1) {
(void)mem;
}
static void f_define_label(uint8_t *mem, uint32_t sp, uint32_t a0) {
(void)mem;
}
static void f_emit_vers(uint8_t *mem, uint32_t sp) {
(void)mem;
}
static void f_init_regs(uint8_t *mem, uint32_t sp, uint32_t a0) {
(void)mem;
}
`;

const ALIAS_SOURCE = `#include "header.h"
static uint32_t f_base_noalias(void) {
L420e28:
// bdead 21 ra = MEM_U32(sp + 36);
// bdead 21 sp = sp + 0x28;
v0 = a0 < 0x1;
}
static void f_base_in_reg(void) {
t0 = a3 + t6;
v0 = MEM_U32(t0 + 0);
// fdead 400083eb MEM_U32(sp + 44) = s6;
}
`;

const PROFILES_SOURCE = `#include "header.h"
static uint32_t f_base_noalias(void) {
L420e28:
// bdead 21 ra = MEM_U32(sp + 36);
// bdead 21 sp = sp + 0x28;
v0 = a0 < 0x1;
}
static void f_base_in_reg(void) {
t0 = a3 + t6;
v0 = MEM_U32(t0 + 0);
// fdead 400083eb MEM_U32(sp + 44) = s6;
}
static void f_formlivbb(uint8_t *mem, uint32_t sp, uint32_t a0, uint32_t a1, uint32_t a2) {
uint32_t zero = 0;
uint32_t v0 = 0, s0 = a0, s1 = a2;
MEM_U32(sp + 92) = a1;
MEM_U32(v0 + 52) = zero;
MEM_U32(v0 + 56) = zero;
goto L464644;
L464644:
L4647b8:
// bdead 1 ra = MEM_U32(sp + 36);
}
static void f_makelivranges(uint8_t *mem, uint32_t sp) {
L468998:
//makelivranges:
}
static void f_compute_save(uint8_t *mem, uint32_t sp, uint32_t a0) {
}
static void f_globalcolor(uint8_t *mem, uint32_t sp) {
uint32_t a3 = 0;
L47106c:
//globalcolor:
L471758:
s5 = MEM_U32(sp + 276);
//nop;
f0.w[0] = MEM_U32(s5 + 48);
L47190c:
cf = f2.f[0] < f20.f[0];
L471afc:
cf = f2.f[0] < f20.f[0];
cf = f6.f[0] <= f20.f[0];
//nop;
if (!cf) {
}
L471d6c:
t5 = MEM_U32(sp + 220);
L4723a4:
cf = f2.f[0] < f20.f[0];
L4725b0:
cf = f2.f[0] < f20.f[0];
cf = f20.f[0] < f10.f[0];
//nop;
if (!cf) {
}
L4727d4:
t8 = MEM_U32(sp + 220);
}
`;

test("instruments selected functions and hooks", () => {
  const r = instrumentUgen(SOURCE);
  assert.equal(r.functions, 2);
  assert.equal(r.free_list_hooks, 2);
  for (const s of [MARKER, "DKWB_TRACE_FRAME(\"f_alloc_reg\");", "dkwb_freelist(\"ALLOC\", a0, mem);", "emitted=%ld", "DKWB_IBUFFER_FORWARD_CURSOR"]) assert.ok(r.source.includes(s), s);
  assert.ok(!r.source.includes("DKWB_TRACE_FRAME(\"helper\");"));
});

test("a free-list record carries the source line", () => {
  const r = instrumentUgen(SOURCE);
  for (const s of ["line=%ld", "DKWB_CURRENT_SOURCE_LINE", "dkwb_source_line(mem)"]) assert.ok(r.source.includes(s), s);
});

test("a function filter retains the free-list hook", () => {
  const r = instrumentUgen(SOURCE, { function_pattern: "^f_free" });
  assert.equal(r.functions, 1);
  assert.equal(r.free_list_hooks, 2);
});

test("refuses double instrumentation", () => {
  assert.throws(() => instrumentUgen(instrumentUgen(SOURCE).source), /already instrumented/);
});

test("allocators record the returned register", () => {
  const r = instrumentUgen(FP_ALLOC_SOURCE);
  assert.equal(r.result_hooks, 2);
  assert.equal(r.procedure_hooks, 1);
  assert.ok(r.source.includes("dkwb_proc_begin();"));
  assert.ok(r.source.includes("proc=%d reg=%u"));
  for (const event of ["ALLOC_GP", "ALLOC_FP"]) {
    assert.ok(r.source.includes(`dkwb_freelist("${event}", a0, mem);`));
    assert.ok(r.source.includes(`dkwb_freelist("${event}_RESULT", v0, mem);\nreturn v0;`));
  }
});

test("no result hook without the named function", () => {
  const r = instrumentUgen(SOURCE);
  assert.equal(r.result_hooks, 0);
  assert.ok(!r.source.includes("ALLOC_FP_RESULT"));
});

test("the procedure hook can be disabled without guessing an alternative", () => {
  const r = instrumentUgen(FP_ALLOC_SOURCE, { procedure_function: null });
  assert.equal(r.procedure_hooks, 0);
  assert.ok(!r.source.includes("dkwb_proc_begin();"));
});

test("the default leaves the emit helpers alone", () => {
  const r = instrumentUgen(EMIT_SOURCE);
  assert.equal(r.emit_hooks, 0);
  assert.ok(!r.source.includes("dkwb_emit("));
  assert.ok(!r.source.includes("DKWB_UGEN_SCHED"));
});

test("hooks every emit helper that takes a0 and mem", () => {
  const r = instrumentUgen(EMIT_SOURCE, { emit_provenance: true });
  assert.equal(r.emit_hooks, 3);
  assert.ok(r.source.includes("dkwb_emit(\"f_emit_rrr\", a0, mem, 0, 0);"));
  assert.ok(r.source.includes("dkwb_emit(\"f_define_label\", a0, mem, 0, 1);"));
});

test("marks the backward buffer emitters", () => {
  assert.ok(instrumentUgen(EMIT_SOURCE, { emit_provenance: true }).source.includes("dkwb_emit(\"f_demit_dir1\", a0, mem, 1, 0);"));
});

test("emits the helper block only when asked", () => {
  const r = instrumentUgen(EMIT_SOURCE, { emit_provenance: true });
  for (const s of ["DKWB_UGEN_SCHED", "DKWB_IBUFFER_BACKWARD_CURSOR", "DKWB-EMIT-V1"]) assert.ok(r.source.includes(s), s);
});

test("the block counter resets at each procedure", () => {
  assert.ok(instrumentUgen(EMIT_SOURCE, { emit_provenance: true }).source.includes("dkwb_sched_block = 0;"));
});

test("refuses a source with no emit helper", () => {
  assert.throws(() => instrumentUgen(SOURCE, { emit_provenance: true }), /no ibuffer emit helpers/);
});

test("alias: refuses an unpinned source", () => {
  assert.throws(() => instrumentUoptAlias(ALIAS_SOURCE), /not the pinned/);
});

test("alias: instruments base and decision", () => {
  const r = instrumentUoptAlias(ALIAS_SOURCE, { allow_unverified_source: true });
  for (const s of [ALIAS_MARKER, "DKWB-BASE", "DKWB-ALIAS-QUERY", "DKWB_UOPT_ALIAS_TRACE"]) assert.ok(r.source.includes(s), s);
});

test("alias: refuses a missing anchor", () => {
  assert.throws(() => instrumentUoptAlias(ALIAS_SOURCE.replace("t0 = a3 + t6;", "t0 = a3 + t7;"), { allow_unverified_source: true }), /base-in-register/);
});

test("profiles combine in a stable order", () => {
  const r = instrumentUoptProfiles(PROFILES_SOURCE, ["globalcolor", "alias", "globalcolor"], { allow_unverified_source: true });
  assert.deepEqual(r.profiles, ["alias", "globalcolor"]);
  assert.equal(r.trace_points, 15);
  assert.ok(r.source.includes(ALIAS_MARKER));
  assert.ok(r.source.includes(GLOBALCOLOR_MARKER));
});

test("profiles reject an unknown profile", () => {
  assert.throws(() => instrumentUoptProfiles(PROFILES_SOURCE, ["other"], { allow_unverified_source: true }), /unknown uopt/);
});

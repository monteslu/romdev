// Guarded, profiled uopt instrumentation (instrument globalcolor), ported
// from the workbench's own suite. The header-compile tests build the injected
// C with the host C compiler and skip when none is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { HEADER, MARKER, ForceEntry, colorRegisterTable, instrumentUoptGlobalcolor, parseForceSpecification } from "../src/decomp/workbench/instrument-uopt.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

let globalcolor = null;
try { globalcolor = await import("../src/decomp/workbench/globalcolor.js"); } catch { globalcolor = null; }
const colorTable = () => {
  const t = globalcolor.COLOR_REGISTERS;
  return typeof t.get === "function" ? new Map([...t.entries()].map(([k, v]) => [Number(k), v])) : new Map(Object.entries(t).map(([k, v]) => [Number(k), v]));
};

const SOURCE = "static void f_formlivbb(uint8_t *mem, uint32_t sp, uint32_t a0, "
  + "uint32_t a1, uint32_t a2) {\n"
  + `uint32_t zero = 0;
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

const COMPILE_PRELUDE = `#include <stdint.h>
static uint8_t dkwb_test_memory[64];
#define MEM_U32(address) (*(uint32_t *)dkwb_test_memory)
#define MEM_U16(address) (*(uint16_t *)dkwb_test_memory)
#define MEM_U8(address) (*(uint8_t *)dkwb_test_memory)
`;

const COMPILE_DRIVER = `int main(void) {
    dkwb_cdx_init();
    dkwb_cdx_procindex();
    dkwb_cdx_finish();
    (void)dkwb_cdx_active(0);
    (void)dkwb_cdx_lookup(0, "p1", 9);
    (void)dkwb_cdx_lookup(0, "p2", 9);
    (void)dkwb_cdx_force_color(0, "p1", "dec", 9, 0, 0);
    (void)dkwb_cdx_reg_taken(dkwb_test_memory, 1);
    dkwb_cdx_lineage_begin();
    dkwb_cdx_log_lineage_range(dkwb_test_memory, 0, 0);
    dkwb_cdx_log_lineage_member(dkwb_test_memory, 0, 0, 0);
    dkwb_cdx_log_interference(dkwb_test_memory, 0, "p1", 9, 0);
    DKWB_CDX_LOG(0, "%s\\n", dkwb_cdx_register_name(2));
    DKWB_CDX_COST(0, "p1", 9, 2, "caller", 1.0, 2.0);
    return 0;
}
`;

const FORCE_DRIVER = `int main(int argc, char **argv) {
    uint32_t forbidden0 = (uint32_t)strtoul(argv[1], 0, 0);
    uint32_t forbidden1 = (uint32_t)strtoul(argv[2], 0, 0);
    int web = (int)strtol(argv[3], 0, 0);
    (void)argc;
    dkwb_cdx_init();
    printf("force=%d\\n",
        dkwb_cdx_force_color(0, "p1", "dec", web, forbidden0, forbidden1));
    (void)dkwb_cdx_active(0);
    (void)dkwb_cdx_lookup(0, "p2", 9);
    (void)dkwb_cdx_reg_taken(dkwb_test_memory, 1);
    dkwb_cdx_lineage_begin();
    dkwb_cdx_log_lineage_range(dkwb_test_memory, 0, 0);
    dkwb_cdx_log_lineage_member(dkwb_test_memory, 0, 0, 0);
    dkwb_cdx_log_interference(dkwb_test_memory, 0, "p1", 9, 0);
    DKWB_CDX_LOG(0, "%s\\n", dkwb_cdx_register_name(2));
    DKWB_CDX_COST(0, "p1", 9, 2, "caller", 1.0, 2.0);
    dkwb_cdx_procindex();
    dkwb_cdx_finish();
    return 0;
}
`;

const FORBIDDEN_MASKS = [
  [0x7F800000, 0, 1, true], [0x7F800000, 0, 8, true], [0x7F800000, 0, 9, false], [0x7F800000, 0, 0, false],
  [0x00000000, 0, 2, false], [0x80000000, 0, 0, true], [0x20000000, 0, 2, true], [0x20000000, 0, 3, false],
  [0x00000001, 0, 31, true], [0x00000001, 0, 30, false], [0x08CBBF00, 0, 4, true], [0x08CBBF00, 0, 5, false],
  [0, 0x80000000, 32, true], [0, 0x80000000, 33, false], [0, 0x00000001, 63, true], [0xFFFFFFFF, 0xFFFFFFFF, 23, true],
];

const FORCE_SPECIFICATIONS = [
  ["p1:w9=c30", true], ["p2:w55=c2", true], ["p1:w9=s", true], ["p2:w0=c0", true], ["p1:w9=c30,p2:w55=c2", true],
  ["p1:w123=c7,p1:w4=s,p2:w9=c1", true],
  ["w55=c2", false], ["w9=s", false], ["p1:w9=c30,w55=c2", false],
  ["p1:w9", false], ["p1:w9=", false], ["p1:wgarbage=c2", false], ["p1:w9=zzz", false], ["p1:w9=c", false],
  ["p1:w9=cx", false], ["p1:w9=c30x", false], ["p1:w9=sx", false], ["p3:w9=c30", false], ["p1w9=c30", false],
  ["P1:W9=C30", false], ["p1:w-1=c30", false],
  ["", false], [",", false], ["p1:w9=c30,", false], [",p1:w9=c30", false], ["p1:w9=c30,,p2:w1=s", false],
  [" p1:w9=c30", false], ["p1:w9=c30 ", false],
  ["p1:w9=c" + "3".repeat(60), false],
];

const instrumented = () => instrumentUoptGlobalcolor(SOURCE, { allow_unverified_source: true }).source;
const count = (s, sub) => s.split(sub).length - 1;
const hex = (n) => `0x${n.toString(16)}`;

function hostCompiler() {
  for (const c of ["cc", "gcc"]) if (spawnSync(c, ["--version"]).status === 0) return c;
  return null;
}
const CC = hostCompiler();

function buildHeaderProgram(root, driver = COMPILE_DRIVER) {
  const source = instrumented();
  const start = source.indexOf("/* DKWB_UOPT_GLOBALCOLOR_V1"), end = source.indexOf("static void f_compute_save");
  const program = path.join(root, "header.c");
  writeFileSync(program, COMPILE_PRELUDE + source.slice(start, end) + driver);
  const binary = path.join(root, "header");
  const r = spawnSync(CC, ["-Wall", "-Werror", program, "-o", binary], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return binary;
}
const withTemp = (fn) => { const d = mkdtempSync(path.join(os.tmpdir(), "romdev-uopt-")); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const withTempAsync = async (fn) => { const d = mkdtempSync(path.join(os.tmpdir(), "romdev-uopt-")); try { return await fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const runBinary = (binary, args, env) => spawnSync(binary, args, { encoding: "utf8", env: { ...env, PATH: process.env.PATH ?? "" } });

test("refuses unpinned source by default", () => {
  assert.throws(() => instrumentUoptGlobalcolor(SOURCE), /not the pinned/);
});

test("instruments all profile anchors", () => {
  const src = instrumented();
  for (const s of [MARKER, "[CDX] p1dec", "[CDX] p2color", "[CDX] intf", "[CDX] webdetail", "[CDX] %scost",
    '"p1", (int)MEM_U32(sp + 268)', '"p2", (int)MEM_U32(sp + 272)', "dkwb_cdx_emulated_pointer", "CDX_DETAIL_WEB",
    "CDX_LINEAGE_TABLES", "[CDX] lineage_range", "[CDX] lineage_member", 'strcmp(value, "all")',
    "forbidden0=0x%08x forbidden1=0x%08x", "available0=0x%08x available1=0x%08x", "allcallersave=%d taken1=%d taken2=%d",
    "dkwb_cdx_reg_taken(mem, 2)", "MEM_U8(s5 + 33)", "CDX_FORCE", "CDX_FORCE ignored without CDX_PROC"]) assert.ok(src.includes(s), s);
  assert.equal(instrumentUoptGlobalcolor(SOURCE, { allow_unverified_source: true }).trace_points, 13);
  assert.equal(count(src, "dkwb_web = (int)MEM_U32(sp + 268)"), 2);
  assert.equal(count(src, "dkwb_web = (int)MEM_U32(sp + 272)"), 2);
});

test("records carry their allocator phase", () => {
  const src = instrumented();
  for (const r of ["p1cand", "p1dec", "p1color"]) assert.ok(src.includes(`[CDX] ${r} phase=p1`));
  for (const r of ["p2dec", "p2color"]) assert.ok(src.includes(`[CDX] ${r} phase=p2`));
  for (const s of ['"[CDX] %scost phase=%s', '"[CDX] webdetail phase=%s', '"[CDX] intf phase=%s',
    'dkwb_cdx_log_interference(mem, dkwb_cdx_ordinal, "p1"', 'dkwb_cdx_log_interference(mem, dkwb_cdx_ordinal, "p2"']) assert.ok(src.includes(s), s);
});

test("force keys are phase qualified", () => {
  const src = instrumented();
  assert.ok(src.includes('snprintf(key, sizeof(key), "%s:w%d=", phase, web)'));
  assert.equal(count(src, 'dkwb_cdx_force_color(dkwb_cdx_ordinal, "p1"'), 2);
  assert.equal(count(src, 'dkwb_cdx_force_color(dkwb_cdx_ordinal, "p2"'), 2);
  assert.equal(count(src, "dkwb_cdx_lookup(ordinal, phase, web)"), 1);
  for (const s of ["is not a phase-qualified force ", "disjoint ", "web spaces", "dkwb_cdx_validate_force", "dkwb_cdx_force_entry_ok"]) assert.ok(src.includes(s), s);
});

test("colors are decoded to registers in output", () => {
  const src = instrumented();
  for (const s of ["bestcolor=%d bestreg=%s", "color=%d reg=%s forced=%d", "color=%d reg=%s kind=%s", "dkwb_cdx_register_name((int)MEM_U32(sp + 220))"]) assert.ok(src.includes(s), s);
});

test("color table is generated from one mapping", { skip: !globalcolor && "globalcolor.js not present" }, () => {
  const table = colorRegisterTable();
  const colors = colorTable();
  assert.ok(table.includes(`#define DKWB_CDX_MAX_COLOR ${Math.max(...colors.keys())}`));
  for (const [, reg] of colors) assert.ok(table.includes(`"${reg}"`));
  assert.equal(colors.has(13), false);
  assert.ok(table.includes('"t5", 0, "s0"'));
  assert.ok(HEADER.includes("DKWB_CDX_COLOR_TABLE"));
  assert.ok(!instrumented().includes("DKWB_CDX_COLOR_TABLE"));
});

test("symbol-named procedure is refused with an index table", () => {
  const src = instrumented();
  for (const s of ["strtol(value, &end, 10)", "is a symbol name", "[CDX] procindex proc=%d decisions=%d", "dkwb_cdx_proc_decisions++", "atexit(dkwb_cdx_finish)"]) assert.ok(src.includes(s), s);
});

test("generated header compiles", { skip: !CC && "no host C compiler" }, () => {
  withTemp((d) => assert.ok(existsSync(buildHeaderProgram(d))));
});

test("force specification parses accepted controls", () => {
  assert.deepEqual(parseForceSpecification("p2:w55=c2,p1:w9=s"),
    [new ForceEntry({ phase: "p2", web: 55, color: 2 }), new ForceEntry({ phase: "p1", web: 9, color: null })]);
  assert.equal(String(new ForceEntry({ phase: "p2", web: 55, color: 2 })), "p2:w55=c2");
  assert.equal(String(new ForceEntry({ phase: "p1", web: 9, color: null })), "p1:w9=s");
  assert.throws(() => parseForceSpecification("w55=c2"), /phase-qualified/);
  assert.throws(() => parseForceSpecification("p1:w9=c30,w55=c2"), /disjoint web spaces/);
  assert.throws(() => parseForceSpecification(""), /empty/);
});

test("workbench force validation matches the table", () => {
  for (const [spec, accepted] of FORCE_SPECIFICATIONS) {
    if (accepted) assert.ok(parseForceSpecification(spec).length, spec);
    else assert.throws(() => parseForceSpecification(spec), { name: "ValueError" }, spec);
  }
});

test("generated pass force validation matches the workbench", { skip: !CC && "no host C compiler" }, () => {
  withTemp((d) => {
    const binary = buildHeaderProgram(d);
    for (const [spec, accepted] of FORCE_SPECIFICATIONS) {
      if (!spec) continue;
      const r = runBinary(binary, [], { CDX_FORCE: spec, CDX_PROC: "0" });
      if (accepted) assert.equal(r.status, 0, r.stderr);
      else { assert.equal(r.status, 2, spec); assert.ok(r.stderr.includes("phase-qualified"), spec); }
    }
  });
});

test("a forbidden force is declined at every force site", () => {
  const src = instrumented();
  assert.ok(src.includes("[CDX] force_declined phase=%s site=%s"));
  assert.ok(src.includes("dkwb_cdx_color_forbidden"));
  for (const [phase, site] of [["p1", "dec"], ["p1", "color"], ["p2", "dec"], ["p2", "color"]]) {
    assert.ok(src.includes(`dkwb_cdx_force_color(dkwb_cdx_ordinal, "${phase}", "${site}"`));
  }
  assert.equal(count(src, "MEM_U32(s5 + 40), MEM_U32(s5 + 44));"), 4);
  assert.equal(count(src, "dkwb_cdx_lookup(dkwb_cdx_ordinal,"), 0);
});

test("the workbench and the pass decode one mask", { skip: !globalcolor && "globalcolor.js not present" }, () => {
  const isForbidden = globalcolor.colorIsForbidden;
  for (const [f0, f1, color, forbidden] of FORBIDDEN_MASKS) assert.equal(isForbidden(f0, f1, color), forbidden, `${hex(f0)} ${hex(f1)} c${color}`);
});

test("the generated pass declines the colors the workbench names", { skip: !CC && "no host C compiler" }, () => {
  withTemp((d) => {
    const binary = buildHeaderProgram(d, FORCE_DRIVER);
    for (const [f0, f1, color, forbidden] of FORBIDDEN_MASKS) {
      const r = runBinary(binary, [hex(f0), hex(f1), "9"], { CDX_FORCE: `p1:w9=c${color}`, CDX_PROC: "0" });
      assert.equal(r.status, 0, r.stderr);
      if (forbidden) {
        assert.ok(r.stdout.includes("force=-2"));
        assert.ok(r.stderr.includes("[CDX] force_declined"));
        assert.ok(r.stderr.includes(`color=${color}`));
        assert.ok(r.stderr.includes(`forbidden=0x${f0.toString(16).padStart(8, "0")}${f1.toString(16).padStart(8, "0")}`));
      } else {
        assert.ok(r.stdout.includes(`force=${color}`));
        assert.ok(!r.stderr.includes("force_declined"));
      }
    }
  });
});

test("a decline is recorded even with tracing off", { skip: !CC && "no host C compiler" }, () => {
  withTemp((d) => {
    const r = runBinary(buildHeaderProgram(d, FORCE_DRIVER), ["0x20000000", "0x0", "9"], { CDX_FORCE: "p1:w9=c2", CDX_PROC: "0" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes("[CDX] force_declined phase=p1 site=dec proc=0 web=9"));
    assert.ok(r.stderr.includes("reg=v1"));
    assert.ok(!r.stderr.includes("[CDX] p1cost"));
  });
});

test("the split force is never declined", { skip: !CC && "no host C compiler" }, () => {
  withTemp((d) => {
    const r = runBinary(buildHeaderProgram(d, FORCE_DRIVER), ["0xffffffff", "0xffffffff", "9"], { CDX_FORCE: "p1:w9=s", CDX_PROC: "0" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("force=-1"));
    assert.ok(!r.stderr.includes("force_declined"));
  });
});

test("refuses double instrumentation", () => {
  assert.throws(() => instrumentUoptGlobalcolor(instrumented(), { allow_unverified_source: true }), /already instrumented/);
});

test("refuses partial profile", () => {
  assert.throws(() => instrumentUoptGlobalcolor(SOURCE.replace("L4727d4:", "Lchanged:"), { allow_unverified_source: true }), /phase-two color/);
});

test("command writes output, refuses same path and unpinned source", async () => {
  await withTempAsync(async (d) => {
    const input = path.join(d, "uopt.c");
    writeFileSync(input, SOURCE);
    const ok = await runCommand(["instrument", "globalcolor", "uopt.c", "out/uopt.c", "--allow-unverified-source"], { cwd: d });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, "instrumented 13 globalcolor sites using ido-5.3-static-recomp-v12 -> out/uopt.c\n");
    assert.equal(readFileSync(path.join(d, "out/uopt.c"), "utf8"), instrumented());
    const same = await runCommand(["instrument-uopt-globalcolor", "uopt.c", "uopt.c"], { cwd: d });
    assert.equal(same.code, 2);
    assert.equal(same.stderr, "error: input and output are identical; pass --in-place to confirm\n");
    const pinned = await runCommand(["instrument-uopt-globalcolor", "uopt.c", "x.c"], { cwd: d });
    assert.equal(pinned.code, 2);
    assert.match(pinned.stderr, /^error: source SHA-256 is not the pinned IDO 5\.3 static-recomp profile \([0-9a-f]{64}\); pass --allow-unverified-source/);
    assert.equal(existsSync(path.join(d, "x.c")), false);
  });
});

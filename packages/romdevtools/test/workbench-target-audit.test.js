// `target audit`: the static target-object scope check. Every object is
// hand-built by the fixture builder; no game or ROM bytes. Ported from the
// workbench's own target audit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildTargetObject, poolSymbol as P } from "./fixtures/workbench/target-audit-fixtures.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { ElfFormatError, parseElf } from "../src/decomp/workbench/elf.js";
import { DEFECT, INFO, WARNING, auditTarget, targetAuditLines } from "../src/decomp/workbench/target-audit.js";

const write = (data, name = "obj.o") => { const p = path.join(mkdtempSync(path.join(os.tmpdir(), "romdev-wb-ta-")), name); writeFileSync(p, data); return p; };
const codes = (audit, severity = null) => audit.findings.filter((f) => severity === null || f.severity === severity).map((f) => f.code);

test("truncated pool is a defect", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 10, rodata_extra_bytes: 0, pool_symbols: [
    P("D_ovl0_800D6120", 0x100, 0x104), P("D_ovl0_800D6124", 0x108, 0x10C), P("D_ovl0_800D6128", 0x110, 0x114), P("D_ovl0_800D612C", 0x118, 0x11C)] })));
  assert.equal(audit.verdict, "defects");
  assert.ok(codes(audit, DEFECT).includes("literal-pool-truncated-at-jump-table"));
  assert.equal(audit.data_scope.jump_table_words, 10);
  assert.equal(audit.data_scope.jump_table_end, 40);
  assert.equal(audit.data_scope.bytes_after_jump_table, 0);
});

test("pool present past the table is ok", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 10, rodata_extra_bytes: 16, pool_symbols: [P("D_ovl0_800D6120", 0x100, 0x104), P("D_ovl0_800D6124", 0x108, 0x10C)] })));
  assert.equal(audit.verdict, "ok");
  assert.ok(codes(audit, INFO).includes("literal-pool-present"));
  assert.equal(audit.data_scope.bytes_after_jump_table, 16);
});

test("a function pointer array ending .rodata is not the defect", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 2, jump_table_start: 8, rodata_extra_bytes: 0, pool_symbols: [P("D_wb_literal_0", 0x100, 0x104), P("D_wb_literal_1", 0x108, 0x10C)] })));
  assert.equal(audit.verdict, "warnings");
  assert.deepEqual(codes(audit, DEFECT), []);
  assert.ok(codes(audit, WARNING).includes("rodata-ends-at-text-relocated-words"));
  assert.equal(audit.data_scope.jump_table_start, 8);
  assert.equal(audit.data_scope.bytes_after_jump_table, 0);
});

test("a scattered run of relocated words is not the defect", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 2, jump_table_stride: 8, rodata_extra_bytes: 0, pool_symbols: [P("D_wb_literal_0", 0x100, 0x104)] })));
  assert.equal(audit.verdict, "warnings");
  assert.deepEqual(codes(audit, DEFECT), []);
  assert.equal(audit.data_scope.jump_table_contiguous, false);
});

test("a relocation past .rodata's end is reported, not subtracted", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 4, rodata_extra_bytes: 8, stray_rodata_reloc_offsets: [0x400], pool_symbols: [P("D_wb_literal_0", 0x100, 0x104)] })));
  assert.ok(codes(audit, DEFECT).includes("rodata-relocation-out-of-range"));
  assert.deepEqual(audit.data_scope.rodata_relocations_out_of_range, [0x400]);
  assert.equal(audit.data_scope.jump_table_words, 4);
  assert.equal(audit.data_scope.bytes_after_jump_table, 8);
});

test("decoy load through a non-$at register is excluded", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 5, rodata_extra_bytes: 0, pool_symbols: [], include_decoy: true })));
  assert.equal(audit.verdict, "ok");
  assert.deepEqual(codes(audit), []);
  assert.equal(audit.data_scope.undef_data_symbol_count, 1);
  assert.ok("D_decoy" in audit.data_scope.undef_data_symbols);
});

test("no jump table context is a warning", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 0, rodata_extra_bytes: 0, pool_symbols: [P("D_thing", 0x0, 0x4)] })));
  assert.equal(audit.verdict, "warnings");
  assert.ok(codes(audit, WARNING).includes("fp-literal-undef-no-jump-table-context"));
  assert.equal(audit.data_scope.jump_table_end, null);
});

test("ldc1 and lw opcodes are also recognised", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 4, rodata_extra_bytes: 0, pool_symbols: [P("D_a", 0x0, 0x4, { opcode: 0x35 }), P("D_b", 0x8, 0xC, { opcode: 0x23 })] })));
  assert.equal(audit.verdict, "defects");
  const f = audit.findings.find((x) => x.code === "literal-pool-truncated-at-jump-table");
  assert.deepEqual([...f.evidence.distinct_undef_symbols].sort(), ["D_a", "D_b"]);
});

test("addend structure is reported per symbol", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 2, rodata_extra_bytes: 8, pool_symbols: [P("D_shared", 0x0, 0x4), P("D_shared", 0x8, 0xC)] })));
  assert.deepEqual(audit.data_scope.undef_data_symbols.D_shared, [0, 0]);
  assert.equal(audit.data_scope.undef_data_symbol_count, 1);
});

test("missing symtab is a defect", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 2, rodata_extra_bytes: 8, pool_symbols: [], include_symtab: false })));
  assert.equal(audit.verdict, "defects");
  assert.ok(codes(audit, DEFECT).includes("missing-symtab"));
});

test("reloc entsize mismatch is a defect", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 2, rodata_extra_bytes: 8, pool_symbols: [P("D_x", 0x0, 0x4)], rel_text_entsize: 4 })));
  assert.ok(codes(audit, DEFECT).includes("reloc-section-malformed"));
});

test("bad magic raises ElfFormatError", () => {
  assert.throws(() => parseElf(Buffer.from("not an elf file at all")), ElfFormatError);
});

const defective = () => write(buildTargetObject({ jump_table_words: 2, rodata_extra_bytes: 0, pool_symbols: [P("D_a", 0x0, 0x4), P("D_b", 0x8, 0xC)] }));

test("ROM arguments must be paired", () => {
  const p = defective();
  assert.throws(() => auditTarget(p, { rom: "somewhere.z64" }), { name: "ValueError" });
  assert.throws(() => auditTarget(p, { rom_offset: 0, va: 0 }), { name: "ValueError" });
});

test("ROM confirms the literal pool", () => {
  const p = defective();
  const romOffset = 0x100, past = romOffset + 8;
  const rom = Buffer.alloc(past + 16 + 16);
  [0x4422F983, 0x4422F983, 0xDEADBEEF, 0x11111111].forEach((w, i) => rom.writeUInt32BE(w, past + 4 * i));
  const audit = auditTarget(p, { rom: write(rom, "rom.z64"), rom_offset: romOffset, va: 0x80000100 });
  assert.equal(audit.verdict, "defects");
  assert.ok(codes(audit, INFO).includes("rom-confirms-literal-pool"));
  assert.equal(audit.rom_check.most_common_count, 2);
  assert.equal(audit.rom_check.matches_undef_fp_symbol_count, true);
  assert.deepEqual(audit.rom_check.words.slice(0, 2), ["0x4422f983", "0x4422f983"]);
});

test("ROM read out of range is a defect", () => {
  const audit = auditTarget(defective(), { rom: write(Buffer.alloc(4), "tiny.z64"), rom_offset: 0x1000, va: 0x80001000 });
  assert.equal(audit.verdict, "defects");
  assert.ok(codes(audit, DEFECT).includes("rom-read-out-of-range"));
});

test("healthy object is not penalised by unrelated ROM bytes", () => {
  const p = write(buildTargetObject({ jump_table_words: 2, rodata_extra_bytes: 16, pool_symbols: [P("D_a", 0x0, 0x4), P("D_b", 0x8, 0xC)] }));
  const romOffset = 0x100, past = romOffset + 24;
  const rom = Buffer.alloc(past + 32);
  [1, 2, 3, 4].forEach((w, i) => rom.writeUInt32BE(w, past + 4 * i));
  const audit = auditTarget(p, { rom: write(rom, "rom.z64"), rom_offset: romOffset, va: 0x80000100 });
  assert.equal(audit.verdict, "ok");
  assert.deepEqual(codes(audit, WARNING), []);
  assert.deepEqual(codes(audit, DEFECT), []);
});

test("lines render and name the verdict", () => {
  const audit = auditTarget(write(buildTargetObject({ jump_table_words: 3, rodata_extra_bytes: 0, pool_symbols: [P("D_x", 0x0, 0x4)] })));
  assert.ok(targetAuditLines(audit).includes("verdict: DEFECTS (1 defect(s), 0 warning(s))"));
});

test("CLI reports a defect and exits 2", async () => {
  const p = write(buildTargetObject({ jump_table_words: 4, rodata_extra_bytes: 0, pool_symbols: [P("D_x", 0x0, 0x4)] }));
  const r = await runCommand(["target", "audit", p]);
  assert.equal(r.code, 2);
  assert.ok(r.stdout.includes("DEFECTS"));
  assert.ok(r.stdout.includes("literal-pool-truncated-at-jump-table"));
});

test("CLI reports ok and exits 0", async () => {
  const p = write(buildTargetObject({ jump_table_words: 4, rodata_extra_bytes: 16, pool_symbols: [] }));
  const r = await runCommand(["target", "audit", p]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("verdict: OK"));
});

test("CLI JSON output is the versioned schema", async () => {
  const p = write(buildTargetObject({ jump_table_words: 4, rodata_extra_bytes: 16, pool_symbols: [] }));
  const r = await runCommand(["target", "audit", p, "--json"]);
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.schema, "decomp-workbench-target-audit-v1");
  assert.equal(payload.verdict, "ok");
});

test("CLI refuses partial ROM arguments", async () => {
  const p = write(buildTargetObject({ jump_table_words: 4, rodata_extra_bytes: 16, pool_symbols: [] }));
  const r = await runCommand(["target", "audit", p, "--rom", "x.z64"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--rom-offset"));
});

test("CLI group listing exits zero", async () => {
  const r = await runCommand(["target"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("audit"));
});

// The linked-artifact symbol readers: the `ld -Map` parser and the ELF
// .symtab reader. Ported from the workbench's own tests; every fixture is a
// handcrafted excerpt or a byte-built ELF. The upstream conformance classes
// replay commercial projects' maps and ELFs and are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SHN_ABS, SHN_UNDEF, ElfFormatError, InputSection, LinkerSymbol, OutputSection, SymbolMovement, TilingGap, auditSymbolMovement,
  auditTiling, parseElfSymbols, parseLdMap, readElfSymbols, readLdMap } from "../src/decomp/workbench/ldmap.js";
import { ValueError } from "../src/decomp/workbench/py.js";
import { buildElf } from "./fixtures/workbench/elf-symtab.js";

export const SECTIONS_MAP = `
Linker script and memory map

LOAD build/code.o
LOAD build/other.o

.boot           0x00000000       0x40
 FILL mask 0x00000000
 build/code.o(.text)
 .text          0x00000000       0x40 build/code.o

.main           0x80000400    0x1000 load address 0x00001000
 FILL mask 0x00000000
 build/code.o(.text)
 .text          0x80000400       0x20 build/code.o
 .text          0x80000428       0x18 build/other.o
 .data          0x80000440       0x10 build/code.o

OUTPUT(build/game.elf elf32-tradbigmips)
`;

const SYMBOLS_MAP = `
Linker script and memory map

.main           0x80000400     0x100

                0x80000400                        main_TEXT_START = .
                0x80000400                start_function
                0x80000420                helper_function
                0x80000430                        gSomeChecksum = 0xdeadbeef
                0x80000440                        . = ALIGN (., 0x10)
                0x80000450                        main_TEXT_END = .
                0x80000460                weird thing here
`;

const WRAPPED_MAP = `
Linker script and memory map

.a_very_long_output_section_name_that_wraps
                0x80010000       0x40 load address 0x00002000
 .MIPS.abiflags
                0x80010000       0x18 build/code.o
`;

const NO_HEADER_MAP = `.tiny           0x80020000       0x10

 .text          0x80020000       0x10 build/code.o
                0x80020000                tiny_symbol
`;

const LOOKUP_MAP = `
Linker script and memory map

.header         0x00000000       0x40

.main           0x80000400      0x100 load address 0x00001000
 .text          0x80000400       0x40 build/code.o
                0x80000400                entry_point
                0x80000420                middle_function

.small_lut      0x80001000        0x8 load address 0x00002000
 .data          0x80001000        0x8 build/lut.o

.big_blob       0x80001000     0x8000 load address 0x00002008
 .data          0x80001000     0x8000 build/blob.o
`;

const OVERLAY_MAP = `
Linker script and memory map

.overlay_a      0x80386000      0x100 load address 0x00100000
 .text          0x80386000      0x100 build/a.o

.overlay_b      0x80386000       0x40 load address 0x00200000
 .text          0x80386000       0x40 build/b.o

.overlay_c      0x80386000       0x10 load address 0x00300000
 .text          0x80386000       0x10 build/c.o
`;

const OVERLAY_ROM_MAP = `
Linker script and memory map

.rom_lut        0x80400000        0x8 load address 0x00050000
 .data          0x80400000        0x8 build/lut.o

.rom_blob       0x80500000     0x1000 load address 0x00050000
 .data          0x80500000     0x1000 build/blob.o
`;

const TILING_MAP = `
Linker script and memory map

.main           0x80000400      0x100
 .text          0x80000400       0x10 build/a.o
 .text          0x80000420       0x10 build/b.o
 .text          0x80000430       0x10 build/c.o
 .text          0x80000438       0x10 build/d.o
 .text          0x80000440        0x0 build/e.o
`;

const BASE_MOVEMENT_MAP = `
Linker script and memory map

.main           0x80000400      0x100
                0x80000400                fixed_symbol
                0x80000420                moved_symbol
                0x80000440                odd_symbol
                0x80000450                base_only_symbol
`;

const SHIFTED_MOVEMENT_MAP = `
Linker script and memory map

.main           0x80000400      0x110
                0x80000400                fixed_symbol
                0x80000430                moved_symbol
                0x80000448                odd_symbol
                0x80000460                shifted_only_symbol
`;

const sortNum = (a) => [...a].sort((x, y) => x - y);

test("output sections: AT() carries a load address, no AT() has none", () => {
  const p = parseLdMap(SECTIONS_MAP);
  const main = p.sections.find((s) => s.name === ".main");
  assert.deepEqual([main.vma, main.size, main.load_address], [0x80000400, 0x1000, 0x1000]);
  const boot = p.sections.find((s) => s.name === ".boot");
  assert.deepEqual([boot.vma, boot.size, boot.load_address], [0, 0x40, null]);
});

test("section end and contains; a zero-size section contains only its own address", () => {
  const s = new OutputSection({ name: ".x", vma: 0x1000, size: 0x10, load_address: null });
  assert.equal(s.end, 0x1010);
  assert.ok(s.contains(0x1000) && s.contains(0x100F) && !s.contains(0x1010));
  const e = new OutputSection({ name: ".empty", vma: 0x2000, size: 0, load_address: null });
  assert.ok(e.contains(0x2000) && !e.contains(0x2001));
});

test("input records carry their own name distinct from the output section", () => {
  const p = parseLdMap(SECTIONS_MAP);
  const d = p.input_sections.find((i) => i.object_path === "build/code.o" && i.vma === 0x80000440);
  assert.equal(d.name, ".data");
  assert.equal(d.output_section, ".main");
});

test("two objects can both contribute text to one output section; boot's record belongs to boot", () => {
  const p = parseLdMap(SECTIONS_MAP);
  const rows = p.input_sections.filter((i) => i.output_section === ".main" && i.name === ".text").map((i) => [i.vma, i.size, i.object_path]);
  assert.deepEqual(rows, [[0x80000400, 0x20, "build/code.o"], [0x80000428, 0x18, "build/other.o"]]);
  const b = p.input_sections.find((i) => i.output_section === ".boot");
  assert.deepEqual([b.name, b.vma, b.size, b.object_path], [".text", 0, 0x40, "build/code.o"]);
  const r = new InputSection({ name: ".text", output_section: ".main", vma: 0x80000400, size: 0x20, object_path: "build/code.o" });
  assert.equal(r.end, 0x80000420);
  assert.ok(r.contains(0x80000400) && !r.contains(0x80000420));
});

test("plain symbols are not assignments; assignments carry their expression", () => {
  const p = parseLdMap(SYMBOLS_MAP);
  const s = p.symbol("start_function");
  assert.deepEqual([s.address, s.is_assignment, s.expression], [0x80000400, false, null]);
  const c = p.symbol("gSomeChecksum");
  assert.deepEqual([c.address, c.is_assignment, c.expression], [0x80000430, true, "0xdeadbeef"]);
});

test("location-counter updates and unrecognized address lines are not symbols", () => {
  const p = parseLdMap(SYMBOLS_MAP);
  assert.ok(!p.symbolNames().has("."));
  assert.deepEqual([...p.symbolNames()].sort(), ["gSomeChecksum", "helper_function", "main_TEXT_END", "main_TEXT_START", "start_function"]);
  assert.ok(!p.symbolNames().has("weird"));
  assert.equal(p.symbols.length, 5);
  assert.deepEqual(new LinkerSymbol({ name: "foo", address: 0x10, is_assignment: true, expression: "bar" }).asDict(),
    { name: "foo", address: 0x10, is_assignment: true, expression: "bar" });
});

test("wrapped output and input section names are merged", () => {
  const p = parseLdMap(WRAPPED_MAP);
  assert.equal(p.sections.length, 1);
  const s = p.sections[0];
  assert.deepEqual([s.name, s.vma, s.size, s.load_address], [".a_very_long_output_section_name_that_wraps", 0x80010000, 0x40, 0x2000]);
  assert.equal(p.input_sections.length, 1);
  const r = p.input_sections[0];
  assert.deepEqual([r.name, r.output_section, r.vma, r.size, r.object_path], [".MIPS.abiflags", ".a_very_long_output_section_name_that_wraps", 0x80010000, 0x18, "build/code.o"]);
});

test("text with no heading is read from the top", () => {
  const p = parseLdMap(NO_HEADER_MAP);
  assert.equal(p.sections.length, 1);
  assert.equal(p.sections[0].name, ".tiny");
  assert.equal(p.input_sections.length, 1);
  assert.ok(p.symbol("tiny_symbol"));
});

test("lookup API: symbols by name, containing, sorted orders, smallest overlapping section", () => {
  const p = parseLdMap(LOOKUP_MAP);
  assert.equal(p.symbol("does_not_exist"), null);
  let [s, off] = p.symbolContaining(0x80000430);
  assert.deepEqual([s.name, off], ["middle_function", 0x10]);
  [s, off] = p.symbolContaining(0x80000420);
  assert.deepEqual([s.name, off], ["middle_function", 0]);
  assert.equal(p.symbolContaining(0x1), null);
  const addrs = p.symbolsSorted().map((x) => x.address);
  assert.deepEqual(addrs, sortNum(addrs));
  const vmas = p.sectionsSorted().map((x) => x.vma);
  assert.deepEqual(vmas, sortNum(vmas));
  assert.equal(p.sectionContaining(0x80001004).name, ".small_lut");
  assert.equal(p.sectionContaining(0x90000000), null);
  assert.equal(p.inputSectionContaining(0x80000410).object_path, "build/code.o");
  const iv = parseLdMap(TILING_MAP).inputSectionsSorted().map((x) => x.vma);
  assert.deepEqual(iv, sortNum(iv));
});

test("translation: rom<->vram through AT() only, smaller overlapping section preferred", () => {
  const p = parseLdMap(LOOKUP_MAP);
  assert.equal(p.romForVram(0x80000410), 0x1010);
  assert.equal(p.vramForRom(0x1010), 0x80000410);
  assert.equal(p.romForVram(0x90000000), null);
  assert.equal(p.romForVram(0x10), null);
  assert.equal(p.romForVram(0x80001004), 0x2004);
  assert.equal(p.vramForRom(0x50000), null);
});

test("overlay ambiguity: every candidate, smallest first, single answers unchanged", () => {
  const p = parseLdMap(OVERLAY_MAP);
  const c = p.sectionsContaining(0x80386000);
  assert.deepEqual(c.map((s) => s.name), [".overlay_c", ".overlay_b", ".overlay_a"]);
  assert.equal(c[0], p.sectionContaining(0x80386000));
  assert.deepEqual(p.sectionsContaining(0x90000000), []);
  assert.equal(p.sectionContaining(0x80386000).name, ".overlay_c");
  assert.equal(p.romForVram(0x80386000), 0x300000);
  const r = parseLdMap(OVERLAY_ROM_MAP);
  assert.deepEqual(r.sectionsLoadedAt(0x50004).map((s) => s.name), [".rom_lut", ".rom_blob"]);
  assert.equal(r.vramForRom(0x50004), 0x80400004);
  assert.deepEqual(r.sectionsLoadedAt(0x90000), []);
});

test("tiling audit: gaps, overlaps, exact tiles and zero-size records", () => {
  const findings = auditTiling(parseLdMap(TILING_MAP));
  const gaps = findings.filter((f) => f.kind === "gap");
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0].low.object_path, gaps[0].high.object_path, gaps[0].gap], ["build/a.o", "build/b.o", 0x10]);
  const ov = findings.filter((f) => f.kind === "overlap");
  assert.equal(ov.length, 1);
  assert.deepEqual([ov[0].low.object_path, ov[0].high.object_path, ov[0].gap, ov[0].asDict().bytes], ["build/c.o", "build/d.o", -8, 8]);
  assert.ok(!findings.some((f) => f.low.object_path === "build/b.o" && f.high.object_path === "build/c.o"));
  assert.ok(!findings.some((f) => f.low.object_path === "build/e.o" || f.high.object_path === "build/e.o"));
  const g = new TilingGap({ output_section: ".main", low: new InputSection({ name: ".text", output_section: ".main", vma: 0, size: 0x10, object_path: "a.o" }),
    high: new InputSection({ name: ".text", output_section: ".main", vma: 0x20, size: 0x10, object_path: "b.o" }), gap: 0x10 });
  assert.equal(g.kind, "gap");
  assert.equal(g.asDict().bytes, 0x10);
  assert.equal(g.asDict().kind, "gap");
});

const movementAudit = (allowed = [0, 0x10]) => auditSymbolMovement(parseLdMap(BASE_MOVEMENT_MAP, { path: "base.map" }),
  parseLdMap(SHIFTED_MOVEMENT_MAP, { path: "shifted.map" }), { allowed_deltas: allowed });

test("movement audit: shared symbols, deltas, anomalies, one-sided symbols, defaults, asDict", () => {
  const a = movementAudit();
  assert.deepEqual(new Set(a.movements.map((m) => m.name)), new Set(["fixed_symbol", "moved_symbol", "odd_symbol"]));
  const by = Object.fromEntries(a.movements.map((m) => [m.name, m.delta]));
  assert.deepEqual([by.fixed_symbol, by.moved_symbol, by.odd_symbol], [0, 0x10, 8]);
  assert.deepEqual(a.anomalous_names, new Set(["odd_symbol"]));
  assert.equal(a.anomalies.length, 1);
  assert.equal(a.anomalies[0].name, "odd_symbol");
  assert.deepEqual(movementAudit([0, 8, 0x10]).anomalies, []);
  assert.deepEqual(a.only_in_base, ["base_only_symbol"]);
  assert.deepEqual(a.only_in_shifted, ["shifted_only_symbol"]);
  assert.ok(!a.anomalous_names.has("base_only_symbol"));
  const d = auditSymbolMovement(parseLdMap(BASE_MOVEMENT_MAP), parseLdMap(SHIFTED_MOVEMENT_MAP));
  assert.deepEqual(d.anomalous_names, new Set(["moved_symbol", "odd_symbol"]));
  assert.equal(new SymbolMovement({ name: "x", base_address: 0x10, shifted_address: 0x20 }).delta, 0x10);
  const p = a.asDict();
  assert.equal(p.shared_symbols, 3);
  assert.equal(p.anomalies.length, 1);
  assert.deepEqual(p.only_in_base, ["base_only_symbol"]);
  assert.deepEqual(p.only_in_shifted, ["shifted_only_symbol"]);
});

test("readLdMap reads and parses a file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-ldmap-"));
  try {
    const p = path.join(dir, "sample.map");
    writeFileSync(p, NO_HEADER_MAP);
    const parsed = readLdMap(p);
    assert.equal(parsed.path, p);
    assert.ok(parsed.symbol("tiny_symbol"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

export const SHADOW_ELF = buildElf([[".text", 0x80000400, 0x100, 6], [".bss", 0x80000500, 0x80, 3]], [
  ["func_a", 0x80000400, 0x40, 2, 1, 1], ["gCounter", 0x80000500, 4, 1, 1, 2], ["D_80000540", 0x80000540, 8, 1, 1, SHN_ABS],
  ["D_B0000574", 0xB0000574, 0, 0, 1, SHN_ABS], ["osSyncPrintf", 0, 0, 2, 1, SHN_UNDEF], ["code_a.c", 0, 0, 4, 0, SHN_ABS], [".text", 0x80000400, 0, 3, 0, 1],
]);

test("ELF reader: file and section symbols are not addresses; object-backed vs absolute", () => {
  const elf = parseElfSymbols(SHADOW_ELF, { path: "fixture.elf" });
  assert.deepEqual([...elf.names()].sort(), ["D_80000540", "D_B0000574", "func_a", "gCounter", "osSyncPrintf"]);
  const f = elf.symbol("func_a");
  assert.deepEqual([f.is_object_backed, f.is_absolute, f.section, f.kind, f.binding, f.shadows_definition], [true, false, ".text", "func", "global", false]);
  const a = elf.symbol("D_B0000574");
  assert.deepEqual([a.is_absolute, a.is_object_backed, a.section, a.kind], [true, false, null, "notype"]);
});

test("ELF reader: the shadowing rule is the inherited size; undefined is neither; section_at; path", () => {
  const elf = parseElfSymbols(SHADOW_ELF, { path: "fixture.elf" });
  const s = elf.symbol("D_80000540"), p = elf.symbol("D_B0000574");
  assert.equal(s.shadows_definition, true);
  assert.deepEqual([s.size, s.kind], [8, "object"]);
  assert.equal(p.shadows_definition, false);
  assert.deepEqual([p.size, p.kind], [0, "notype"]);
  const u = elf.symbol("osSyncPrintf");
  assert.deepEqual([u.is_undefined, u.is_object_backed, u.shadows_definition], [true, false, false]);
  assert.equal(elf.sectionAt(0x80000540).name, ".bss");
  assert.equal(elf.sectionAt(0xB0000574), null);
  assert.equal(elf.path, "fixture.elf");
});

test("ELF refusals: not an ELF, little-endian, 64-bit, stripped; all are ValueErrors", () => {
  assert.throws(() => parseElfSymbols(Buffer.concat([Buffer.from([0x80, 0x37, 0x12, 0x40]), Buffer.alloc(200)]), { path: "rom.z64" }), (e) => e instanceof ElfFormatError && /not an ELF file/.test(e.message) && /rom\.z64/.test(e.message));
  assert.throws(() => parseElfSymbols(buildElf([], [], { encoding: 1 })), /big-endian/);
  assert.throws(() => parseElfSymbols(buildElf([], [], { elf_class: 2 })), /32-bit/);
  assert.throws(() => parseElfSymbols(buildElf([], [], { with_symtab: false }), { path: "game.elf" }), /stripped/);
  assert.ok(new ElfFormatError("x") instanceof ValueError);
});

test("readElfSymbols carries the path", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-elf-"));
  try {
    const p = path.join(dir, "one.elf");
    writeFileSync(p, SHADOW_ELF);
    const found = readElfSymbols(p);
    assert.equal(found.path, p);
    assert.ok(found.names().has("func_a"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

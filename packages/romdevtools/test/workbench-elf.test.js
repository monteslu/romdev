// Workbench ELF readers: the true instruction count read from .text bytes,
// function extents from the symbol table, and the relocatable-object reader.
// Every object is built by the synthetic fixture builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildElf32be, buildObject, buildRelocatable, words, STT_FUNC, STT_NOTYPE, STB_LOCAL, STB_GLOBAL, R_MIPS_26, R_MIPS_HI16 } from "./fixtures/workbench/elf-fixtures.js";
import { MINIMUM_ELIDED_RUN, ElfFormatError, readSection, trueInstructionCount, trueInstructionCountFromBytes } from "../src/decomp/workbench/elf-instructions.js";
import { symbolExtent } from "../src/decomp/workbench/elf-symbols.js";
import { parseElf } from "../src/decomp/workbench/elf.js";

const JR_RA = 0x03E00008, NONZERO = 0x27BD06A8;
const writeObject = (bytes) => { const p = path.join(mkdtempSync(path.join(os.tmpdir(), "wb-elf-")), "obj.o"); writeFileSync(p, bytes); return p; };

test("trims a run of trailing padding", () => assert.equal(trueInstructionCountFromBytes(words(0, JR_RA, NONZERO, 0, 0, 0)), 3));
test("does not trim a single trailing zero word", () => assert.equal(trueInstructionCountFromBytes(words(JR_RA, NONZERO, 0)), 3));
test("trims exactly at the measured threshold", () => {
  assert.equal(MINIMUM_ELIDED_RUN, 2);
  const below = words(JR_RA, NONZERO, ...Array(MINIMUM_ELIDED_RUN - 1).fill(0));
  const at = words(JR_RA, NONZERO, ...Array(MINIMUM_ELIDED_RUN).fill(0));
  assert.equal(trueInstructionCountFromBytes(below), below.length / 4);
  assert.equal(trueInstructionCountFromBytes(at), 2);
});
test("no padding needed reports the full length", () => assert.equal(trueInstructionCountFromBytes(words(0, JR_RA, NONZERO)), 3));
test("no return at all reports the full length", () => assert.equal(trueInstructionCountFromBytes(words(0, 0, 0)), 3));
test("nonzero content after the last return is not trimmed", () => assert.equal(trueInstructionCountFromBytes(words(JR_RA, NONZERO, 0x24020001, 0, 0)), 5));
test("a return as the final word is not trimmed", () => assert.equal(trueInstructionCountFromBytes(words(0, JR_RA)), 2));

test("reads the named section verbatim; a missing section is null", () => {
  const text = words(JR_RA, NONZERO);
  const p = writeObject(buildElf32be({ ".text": text }));
  assert.deepEqual(readSection(p, ".text"), text);
  assert.equal(readSection(p, ".rodata"), null);
});
test("rejects a non-ELF file, little-endian and 64-bit ELF", () => {
  assert.throws(() => readSection(writeObject(Buffer.from("not an elf file at all, just text")), ".text"), ElfFormatError);
  const le = buildElf32be({ ".text": words(JR_RA, NONZERO) }); le[5] = 1;
  assert.throws(() => readSection(writeObject(le), ".text"), /big-endian/);
  const wide = buildElf32be({ ".text": words(JR_RA, NONZERO) }); wide[4] = 2;
  assert.throws(() => readSection(writeObject(wide), ".text"), /32-bit/);
});
test("true count end to end; empty and absent sections are null", () => {
  assert.equal(trueInstructionCount(writeObject(buildElf32be({ ".text": words(0, JR_RA, NONZERO, 0, 0, 0) }))), 3);
  assert.equal(trueInstructionCount(writeObject(buildElf32be({ ".text": Buffer.alloc(0) }))), null);
  assert.equal(trueInstructionCount(writeObject(buildElf32be({ ".data": words(0) })), { section: ".text" }), null);
});

test("an interior NOTYPE label does not end a sized-zero function; the next FUNC does", () => {
  const p = writeObject(buildObject({ text: words(...Array(12).fill(0)), symbols: [
    ["func_a", 0, 0, STT_FUNC, STB_GLOBAL], ["jtgt_a", 8, 0, STT_NOTYPE, STB_LOCAL], ["func_b", 32, 0, STT_FUNC, STB_GLOBAL]] }));
  const e = symbolExtent(p, "func_a");
  assert.deepEqual([e.start, e.stop, e.basis], [0, 32, "next-function"]);
  assert.equal(e.contains(8), true);
  assert.equal(e.contains(32), false);
  const last = symbolExtent(p, "func_b");
  assert.deepEqual([last.start, last.stop, last.basis], [32, null, "section-end"]);
});
test("size wins; a global NOTYPE label ends a handwritten function; unique case fold", () => {
  const p = writeObject(buildObject({ text: words(...Array(8).fill(0)), symbols: [
    ["Foo", 0, 12, STT_FUNC, STB_GLOBAL], ["bar", 16, 0, STT_NOTYPE, STB_GLOBAL], ["baz", 24, 0, STT_NOTYPE, STB_GLOBAL]] }));
  assert.deepEqual([symbolExtent(p, "Foo").stop, symbolExtent(p, "Foo").basis], [12, "size"]);
  assert.equal(symbolExtent(p, "foo").name, "Foo");
  assert.deepEqual([symbolExtent(p, "bar").stop, symbolExtent(p, "bar").basis], [24, "next-global"]);
  assert.equal(symbolExtent(p, "missing"), null);
  assert.equal(symbolExtent(writeObject(Buffer.from("junk")), "Foo"), null);
});
test("relocatable reader resolves relocations and undefined symbols", () => {
  const elf = parseElf(buildRelocatable({ ".text": words(0x0C000000, 0x3C010000) },
    [{ name: "ext", section: null }, { name: "fn", kind: STT_FUNC, section: ".text", size: 8 }],
    [{ section: ".text", offset: 0, symbol: "ext", type: R_MIPS_26 }, { section: ".text", offset: 4, symbol: "ext", type: R_MIPS_HI16 }]));
  const rel = elf.relocationsFor(".text");
  assert.deepEqual(rel.map((r) => [r.offset, r.kind, elf.symbolName(r.sym_index)]), [[0, "R_MIPS_26", "ext"], [4, "R_MIPS_HI16", "ext"]]);
  assert.equal(elf.symbols.find((s) => s.name === "ext").defined, false);
  assert.deepEqual(elf.malformed_reloc_sections, []);
});

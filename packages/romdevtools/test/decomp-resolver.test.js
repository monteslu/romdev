// decomp-resolver.test.js — the splat segment resolver on SYNTHETIC fixtures:
// a nonzero load address, a relocated code segment, two overlays sharing a
// VA with different contents, BSS, and reverse (ROM offset → VA) mapping.
// Asserts the SELECTED BYTES, not merely that something resolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSplatMap, loadSymbolAddrs, loadLinkerMap, parseSplatAsm, findFunctionSource } from "../src/decomp/splat-map.js";

const YAML = `
name: Synthetic
sha1: 0000
options:
  platform: n64
  target_path: base.z64
  src_path: src
segments:
  - name: header
    type: header
    start: 0x0
  - name: boot
    type: bin
    start: 0x40
  - name: entry
    type: code
    start: 0x1000
    vram: 0x80000400
    subsegments:
      - [0x1000, hasm, entrypoint]
  - name: main
    type: code
    start: 0x1050
    vram: 0x80000450
    bss_size: 0x100
    subsegments:
      - [0x1050, c, game/main]
      - [0x1100, c, game/other]
  - name: relocated
    type: code
    start: 0x2000
    vram: 0x80100000
    subsegments:
      - [0x2000, c, reloc/code]
  - name: ovl_a
    type: code
    start: 0x3000
    vram: 0x80200000
    subsegments:
      - [0x3000, c, overlays/ovl_a/a]
  - name: ovl_b
    type: code
    start: 0x3100
    vram: 0x80200000
    subsegments:
      - [0x3100, c, overlays/ovl_b/b]
  - [0x3200]
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "romdev-decomp-"));
  await writeFile(join(dir, "s.yaml"), YAML);
  return dir;
}

test("resolver: entry segment maps like the header formula; relocated segment does NOT", async () => {
  const map = await loadSplatMap(join(await fixture(), "s.yaml"));
  const e = map.resolveVa(0x80000400);
  assert.equal(e.ok, true); assert.equal(e.resolved.segment, "entry"); assert.equal(e.resolved.romOffset, 0x1000);
  const r = map.resolveVa(0x80100010);
  assert.equal(r.ok, true); assert.equal(r.resolved.segment, "relocated"); assert.equal(r.resolved.romOffset, 0x2010);
  // The formula would have said va - entry + 0x1000 = 0x100C10: inside a big ROM, wrong segment.
  assert.notEqual(r.resolved.romOffset, 0x80100010 - 0x80000400 + 0x1000);
});

test("resolver: overlays sharing a VA are AMBIGUOUS until a segment is named; each yields different bytes", async () => {
  const map = await loadSplatMap(join(await fixture(), "s.yaml"));
  const amb = map.resolveVa(0x80200040);
  assert.equal(amb.ok, false); assert.equal(amb.code, "AMBIGUOUS_OVERLAY");
  assert.deepEqual(amb.candidates.map((c) => c.segment).sort(), ["ovl_a", "ovl_b"]);
  const a = map.resolveVa(0x80200040, { segment: "ovl_a" });
  const b = map.resolveVa(0x80200040, { segment: "ovl_b" });
  assert.equal(a.resolved.romOffset, 0x3040); assert.equal(b.resolved.romOffset, 0x3140);
  assert.equal(a.resolved.overlay, true);
  const wrong = map.resolveVa(0x80100000, { segment: "ovl_a" });
  assert.equal(wrong.ok, false); assert.equal(wrong.code, "SEGMENT_MISMATCH");
});

test("resolver: BSS addresses resolve to a segment with no ROM bytes; unmapped VAs are refused", async () => {
  const map = await loadSplatMap(join(await fixture(), "s.yaml"));
  const bss = map.resolveVa(0x80000450 + (0x2000 - 0x1050) + 0x10);
  assert.equal(bss.ok, true); assert.equal(bss.resolved.kind, "bss"); assert.equal(bss.resolved.romOffset, null);
  const un = map.resolveVa(0x8fffffff);
  assert.equal(un.ok, false); assert.equal(un.code, "UNMAPPED_VA");
});

test("resolver: ROM offset → VA is unique and names the subsegment", async () => {
  const map = await loadSplatMap(join(await fixture(), "s.yaml"));
  const r = map.resolveRomOffset(0x1108);
  assert.equal(r.ok, true); assert.equal(r.resolved.segment, "main"); assert.equal(r.resolved.va, 0x80000450 + 0xb8); assert.equal(r.resolved.subsegment.name, "game/other");
  const o = map.resolveRomOffset(0x3140);
  assert.equal(o.resolved.segment, "ovl_b"); assert.equal(o.resolved.va, 0x80200040);
});

test("symbol_addrs + linker map parse; sizes come from the next symbol", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "syms.txt"), "func_A = 0x80000450; // type:func size:0x20\nD_1 = 0x80000500;\n");
  const syms = await loadSymbolAddrs([join(dir, "syms.txt")]);
  assert.equal(syms.get("func_A").va, 0x80000450); assert.equal(syms.get("func_A").size, 0x20);
  const MAP = [
    " .text          0x80000450       0xb0 build/src/game/main.o",
    "                0x80000450                func_A",
    "                0x80000450                func_A.NON_MATCHING",
    "                0x80000470                func_B",
    " .text          0x80000500       0x40 build/src/game/other.o",
    "                0x80000500                func_C",
    "",
  ].join("\n");
  await writeFile(join(dir, "x.map"), MAP);
  const ld = await loadLinkerMap(join(dir, "x.map"));
  assert.equal(ld.symbols.get("func_A").size, 0x20);
  assert.equal(ld.symbols.get("func_B").size, 0xb0 - 0x20);
  assert.equal(ld.symbols.get("func_C").object, "build/src/game/other.o");
});

test("parseSplatAsm: instruction words + rodata carried by the function", () => {
  const p = parseSplatAsm(`.section .late_rodata\ndlabel D_1\n    /* 100 80000100 3F800000 */ .float 1.0\n\n.section .text\nglabel func_X\n    /* 1000 80000400 27BDFFE8 */  addiu      $sp, $sp, -0x18\n    /* 1004 80000404 03E00008 */  jr         $ra\n`);
  assert.equal(p.name, "func_X"); assert.equal(p.instructions.length, 2); assert.equal(p.va, 0x80000400); assert.equal(p.romOffset, 0x1000);
  assert.deepEqual(p.rodataSymbols.map((r) => r.name), ["D_1"]); assert.equal(p.data.length, 1);
});

test("findFunctionSource: GLOBAL_ASM pragma vs C definition, and a duplicate is reported", async () => {
  const dir = await fixture();
  await mkdir(join(dir, "src", "a"), { recursive: true });
  await writeFile(join(dir, "src", "a", "one.c"), `#include "x.h"\n\n#pragma GLOBAL_ASM("asm/nonmatchings/a/one/func_A.s")\n\nvoid func_B(s32 x) {\n    return;\n}\n`);
  await writeFile(join(dir, "src", "a", "two.c"), `void func_B(s32 x) { }\n`);
  const a = findFunctionSource(dir, "src", "func_A");
  assert.equal(a.length, 1); assert.equal(a[0].state, "asm"); assert.equal(a[0].line, 3);
  const b = findFunctionSource(dir, "src", "func_B");
  assert.equal(b.length, 2); assert.equal(b[0].state, "c");
});

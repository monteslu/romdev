// Synthesizing a placeholder symbol's value from the shipped image. Every
// object is hand-built; the "image" carries the addends a runtime linker
// would patch. No game bytes, no toolchain, no linked ELF. Ported from the
// workbench's own relocation-surface tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { R_MIPS_26, R_MIPS_32, R_MIPS_HI16, R_MIPS_LO16, STB_GLOBAL, STB_LOCAL, STT_FUNC, buildRelocatable, words } from "./fixtures/workbench/elf-fixtures.js";
import * as rs from "../src/decomp/workbench/reloc-surface.js";
import { parseElf } from "../src/decomp/workbench/elf.js";
import { JAL, LUI, NOP, MODULE_START, TU_OFFSET, sym, rel, candidateObject, shippedImage, moduleDocument } from "./fixtures/workbench/reloc-fixtures.js";

const hx = (n) => `0x${n.toString(16)}`;
const fromMap = (m) => Object.fromEntries(m);

function surfaceFor({ object_bytes = null, image = null, ...overrides } = {}) {
  const module = rs.parseModuleMap(moduleDocument(overrides));
  return rs.synthesize([["tu.c.o", parseElf(object_bytes ?? candidateObject())]], module, image ?? shippedImage());
}

// module map

test("a map parses hex and decimal alike", () => {
  const module = rs.parseModuleMap(moduleDocument());
  assert.equal(module.image_start, 0x1000);
  assert.equal(module.synthetic_vma, 0xF0000000);
  assert.equal(module.placementsFor("build/tu.c.o")[0].offset, TU_OFFSET);
});

test("an unknown schema is refused by name", () => {
  const document = moduleDocument();
  document.schema = "something-else-v9";
  assert.throws(() => rs.parseModuleMap(document), (e) => e instanceof rs.ModuleMapError && e.message.includes(rs.MODULE_MAP_SCHEMA));
});

test("a section past the module's end is refused", () => {
  assert.throws(() => rs.parseModuleMap(moduleDocument({ sections: { ".text": { offset: 0, size: 0x9000 } } })), /past the module/);
});

test("a placement outside its section is refused", () => {
  assert.throws(() => rs.parseModuleMap(moduleDocument({ text_placement: [{ object: "tu.c.o", section: ".text", offset: "0x900" }] })), /outside section/);
});

test("a module that ends before it starts is refused", () => {
  assert.throws(() => rs.parseModuleMap(moduleDocument({ image_end: "0x1000" })), rs.ModuleMapError);
});

// synthesis

test("a call takes the synthetic VMA and the stored immediate", () => {
  assert.equal(surfaceFor().valueMap().get("callee"), 0xF0000000 + (0x123 << 2));
});

test("a hi/lo pair is read together and the object's addend removed", () => {
  assert.equal(surfaceFor().valueMap().get("gBase"), 0x18010);
});

test("the object addend is what makes one base serve many fields", () => {
  const first = surfaceFor({ object_bytes: candidateObject({ low_addend: 0x10 }), image: shippedImage({ lo: 0x8020 }) });
  const second = surfaceFor({ object_bytes: candidateObject({ low_addend: 0x24 }), image: shippedImage({ lo: 0x8034 }) });
  assert.equal(first.valueMap().get("gBase"), second.valueMap().get("gBase"));
});

const twoObjectModule = () => rs.parseModuleMap(moduleDocument({ text_placement: [
  { object: "tu.c.o", section: ".text", offset: hx(TU_OFFSET) }, { object: "other.c.o", section: ".text", offset: "0x100" }] }));

test("a symbol another object of the module defines needs no value", () => {
  const other = buildRelocatable({ ".text": words(NOP) }, [sym("callee", 0, 4, STT_FUNC, STB_GLOBAL, ".text")]);
  const surface = rs.synthesize([["tu.c.o", parseElf(candidateObject())], ["other.c.o", parseElf(other)]], twoObjectModule(), shippedImage());
  assert.ok(!surface.valueMap().has("callee"));
  assert.ok(surface.valueMap().has("gBase"));
});

test("a static in another object does not satisfy the reference", () => {
  const other = buildRelocatable({ ".text": words(NOP) }, [sym("callee", 0, 4, STT_FUNC, STB_LOCAL, ".text")]);
  const surface = rs.synthesize([["tu.c.o", parseElf(candidateObject())], ["other.c.o", parseElf(other)]], twoObjectModule(), shippedImage());
  assert.ok(surface.valueMap().has("callee"));
});

test("a map written with backslashes matches a posix object path", () => {
  const module = rs.parseModuleMap(moduleDocument({ text_placement: [{ object: "build\\overlay\\tu.c.o", section: ".text", offset: hx(TU_OFFSET), size: 16 }] }));
  const surface = rs.synthesize([["build/overlay/tu.c.o", parseElf(candidateObject())]], module, shippedImage());
  assert.ok(surface.valueMap().has("callee"));
});

test("an R_MIPS_32 site takes the stored word", () => {
  const obj = buildRelocatable({ ".text": words(NOP), ".data": words(4) }, [sym("gPointer")], [rel(".data", 0, "gPointer", R_MIPS_32)]);
  const image = shippedImage();
  words(0x80112244).copy(image, MODULE_START + 0x200);
  const surface = surfaceFor({ object_bytes: obj, image, sections: { ".text": { offset: 0, size: 0x200 }, ".data": { offset: 0x200, size: 0x100 } },
    text_placement: [{ object: "tu.c.o", section: ".data", offset: "0x200", size: 4 }], relocation_sites: [{ offset: 0x200, type: "R_MIPS_32" }] });
  assert.deepEqual(fromMap(surface.valueMap()), { gPointer: 0x80112240 });
});

test("an alias block is emitted for the names the object defines", () => {
  const surface = surfaceFor({ alias_template: "func_{module}_{module_offset:07X}" });
  assert.deepEqual(surface.aliases.map((a) => [a.identity, a.name]), [["func_m1_0000040", "myFunc"]]);
  const block = rs.renderLinkerBlock(surface).join("\n");
  assert.ok(block.includes("func_m1_0000040 = myFunc;"));
  assert.ok(block.includes("callee = 0xF000048C;"));
});

test("an identity that is its own name gets no circular alias", () => {
  const obj = buildRelocatable({ ".text": words(NOP) }, [sym("func_m1_0000040", 0, 4, STT_FUNC, STB_GLOBAL, ".text")]);
  assert.deepEqual(surfaceFor({ object_bytes: obj, alias_template: "func_{module}_{module_offset:07X}" }).aliases, []);
});

test("the rendered block reads back as the values it states", () => {
  const surface = surfaceFor();
  assert.deepEqual(fromMap(rs.trackedValues(rs.renderLinkerBlock(surface).join("\n"))), fromMap(surface.valueMap()));
});

// refusals

const twoCalls = () => buildRelocatable({ ".text": words(JAL, JAL, NOP, NOP) }, [sym("callee")], [rel(".text", 0, "callee", R_MIPS_26), rel(".text", 4, "callee", R_MIPS_26)]);
const twoCallImage = () => { const image = Buffer.alloc(0x4000); words((JAL | 0x111) >>> 0, (JAL | 0x222) >>> 0, NOP, NOP).copy(image, MODULE_START + TU_OFFSET); return image; };

test("two sites demanding different values are refused by name", () => {
  const surface = surfaceFor({ object_bytes: twoCalls(), image: twoCallImage(), relocation_sites: [{ offset: TU_OFFSET, type: "R_MIPS_26" }, { offset: TU_OFFSET + 4, type: "R_MIPS_26" }] });
  assert.equal(surface.valueMap().size, 0);
  assert.equal(surface.ok, false);
  assert.equal(surface.conflicts.length, 1);
  const [conflict] = surface.conflicts;
  assert.equal(conflict.symbol, "callee");
  assert.equal(conflict.reason, "schedule-divergence-at-site");
  assert.deepEqual(conflict.values, [0xF0000000 + (0x111 << 2), 0xF0000000 + (0x222 << 2)]);
  assert.deepEqual(conflict.sites.map((s) => s.module_offset).sort((a, b) => a - b), [TU_OFFSET, TU_OFFSET + 4]);
});

test("a site the shipped table does not name is ignored when another is", () => {
  const surface = surfaceFor({ object_bytes: twoCalls(), image: twoCallImage(), relocation_sites: [{ offset: TU_OFFSET, type: "R_MIPS_26" }] });
  assert.deepEqual(fromMap(surface.valueMap()), { callee: 0xF0000000 + (0x111 << 2) });
  assert.deepEqual(surface.conflicts, []);
});

test("a symbol whose every corroborated site moved is reported", () => {
  const surface = surfaceFor({ relocation_sites: [{ offset: TU_OFFSET + 8, type: "R_MIPS_HI16" }] });
  const reasons = Object.fromEntries(surface.conflicts.map((c) => [c.symbol, c.reason]));
  assert.equal(reasons.gBase, "no-corroborated-site");
  assert.ok(surface.valueMap().has("callee"));
});

test("a site outside the module is not read as an addend", () => {
  const surface = surfaceFor({ text_placement: [{ object: "tu.c.o", section: ".text", offset: "0x7F8" }], relocation_sites: [] });
  assert.ok(surface.conflicts.map((c) => c.reason).includes("unmapped-site"));
});

test("an object the map does not place says so", () => {
  const surface = rs.synthesize([["unplaced.c.o", parseElf(candidateObject())]], rs.parseModuleMap(moduleDocument()), shippedImage());
  assert.deepEqual(surface.values, []);
  assert.ok(surface.warnings.some((w) => w.includes("places no section")));
});

test("without a shipped table the missing corroboration is stated", () => {
  const surface = surfaceFor({ relocation_sites: [] });
  assert.equal(surface.corroborated, false);
  assert.ok(surface.warnings.some((w) => w.includes("no shipped relocation table")));
});

// a lone HI16

const orphanSurface = () => {
  const obj = buildRelocatable({ ".text": words(LUI, NOP) }, [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text"), sym("gBase")], [rel(".text", 0, "gBase", R_MIPS_HI16)]);
  const image = Buffer.alloc(0x4000);
  words((LUI | 0x0002) >>> 0, NOP).copy(image, MODULE_START + TU_OFFSET);
  return surfaceFor({ object_bytes: obj, image, relocation_sites: [{ offset: TU_OFFSET, type: "R_MIPS_HI16" }] });
};

test("a lone HI16 value is produced but the run says it is a guess", () => {
  const surface = orphanSurface();
  assert.equal(surface.valueMap().get("gBase"), 0x0002 << 16);
  assert.ok(surface.warnings.some((w) => w.includes("gBase") && w.includes("LO16")), surface.warnings.join("\n"));
});

test("a paired HI16 is not warned about", () => {
  assert.ok(!surfaceFor().warnings.some((w) => w.includes("unpaired")));
});

// audit

test("a hand-written block that agrees scores clean", () => {
  const report = rs.audit(surfaceFor(), rs.trackedValues("callee = 0xF000048C;\n"));
  assert.deepEqual([report.agree, report.disagree], [1, 0]);
  assert.equal(report.ok, true);
  assert.equal(report.count("untracked"), 1);
});

test("a disagreement names both values", () => {
  const report = rs.audit(surfaceFor(), { callee: 0x1234 });
  const row = report.rows.find((r) => r.name === "callee");
  assert.equal(row.status, "disagree");
  assert.deepEqual([row.tracked, row.synthesized], [0x1234, 0xF000048C]);
  assert.equal(report.ok, false);
});

test("a name the synthesis did not reach is not a disagreement", () => {
  const report = rs.audit(surfaceFor(), { gElsewhere: 0x10 });
  assert.equal(report.rows.find((r) => r.name === "gElsewhere").status, "unreproduced");
  assert.equal(report.disagree, 0);
});

test("the last assignment wins, the way a linker reads one", () => {
  assert.deepEqual(fromMap(rs.trackedValues("gDup = 0x1;\n/* gDup = 0x9; */\ngDup = 0x2;\n")), { gDup: 2 });
});

test("an alias line reads back as a name, not a number", () => {
  assert.deepEqual(fromMap(rs.parseLinkerBlock("func_m1_0000040 = myFunc;\ngA = 0x4;\n")), { func_m1_0000040: "myFunc", gA: "0x4" });
  assert.deepEqual(fromMap(rs.trackedValues("func_m1_0000040 = myFunc;\n")), {});
});

// the permuter's precondition

const target = (symbol) => buildRelocatable({ ".text": words(JAL, NOP) },
  [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text"), symbol !== "myFunc" ? sym(symbol) : sym("pad")], [rel(".text", 0, symbol, R_MIPS_26)]);

test("a call that names the function itself is unreproducible", () => {
  const f = rs.placeholderCallCheck(parseElf(target("myFunc")), null, { function: "myFunc" });
  assert.equal(f.blocked, true);
  assert.deepEqual(f.self_named, ["myFunc"]);
  assert.ok(f.message.includes("linked-compare"));
});

test("a call to a symbol the candidate lacks is unreproducible", () => {
  const candidate = buildRelocatable({ ".text": words(JAL, NOP) }, [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text")]);
  const f = rs.placeholderCallCheck(parseElf(target("overlayChain0Reloc")), parseElf(candidate), { function: "myFunc" });
  assert.equal(f.blocked, true);
  assert.deepEqual(f.absent_from_candidate, ["overlayChain0Reloc"]);
});

test("a call the candidate can name is not blocked", () => {
  const candidate = buildRelocatable({ ".text": words(JAL, NOP) }, [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text"), sym("ordinaryCallee")], [rel(".text", 0, "ordinaryCallee", R_MIPS_26)]);
  const f = rs.placeholderCallCheck(parseElf(target("ordinaryCallee")), parseElf(candidate), { function: "myFunc" });
  assert.equal(f.blocked, false);
  assert.deepEqual(f.reproducible, ["ordinaryCallee"]);
});

test("ordinary self-recursion the candidate reproduces is not blocked", () => {
  const candidate = buildRelocatable({ ".text": words(JAL, NOP) }, [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text")], [rel(".text", 0, "myFunc", R_MIPS_26)]);
  const f = rs.placeholderCallCheck(parseElf(target("myFunc")), parseElf(candidate), { function: "myFunc" });
  assert.equal(f.blocked, false);
  assert.deepEqual(f.reproducible, ["myFunc"]);
  assert.deepEqual(f.self_named, []);
});

test("without a candidate a self call names recursion as the other reading", () => {
  const f = rs.placeholderCallCheck(parseElf(target("myFunc")), null, { function: "myFunc" });
  assert.equal(f.blocked, true);
  assert.ok(f.message.includes("--candidate-object"));
  assert.ok(f.message.includes("recursion"));
});

test("a function with no calls at all is never blocked", () => {
  const obj = buildRelocatable({ ".text": words(NOP, NOP) }, [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text")]);
  const f = rs.placeholderCallCheck(parseElf(obj), parseElf(obj), { function: "myFunc" });
  assert.equal(f.call_sites, 0);
  assert.equal(f.blocked, false);
});

test("only the named function's own sites are read", () => {
  const obj = buildRelocatable({ ".text": words(JAL, NOP, JAL, NOP) },
    [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text"), sym("neighbour", 8, 8, STT_FUNC, STB_GLOBAL, ".text"), sym("ordinaryCallee")],
    [rel(".text", 0, "ordinaryCallee", R_MIPS_26), rel(".text", 8, "myFunc", R_MIPS_26)]);
  const candidate = buildRelocatable({ ".text": words(JAL, NOP) }, [sym("myFunc", 0, 8, STT_FUNC, STB_GLOBAL, ".text"), sym("ordinaryCallee")]);
  const f = rs.placeholderCallCheck(parseElf(obj), parseElf(candidate), { function: "myFunc" });
  assert.equal(f.call_sites, 1);
  assert.equal(f.blocked, false);
});

// the synthesized value replayed through the linker's own formulas

const linkHiLo = (value, hiAddend, loAddend) => {
  const final = (value + hiAddend * 65536 + rs.sext16(loAddend)) % 2 ** 32;
  const f = (final + 2 ** 32) % 2 ** 32;
  return [Math.floor((f + 0x8000) / 65536) & 0xFFFF, f & 0xFFFF];
};
const linkJump = (value, addend) => Math.floor((value + addend * 4) / 4) & 0x03FFFFFF;

test("a hi/lo value relinks to the shipped words", () => {
  for (const storedLo of [0x0000, 0x0001, 0x7FFF, 0x8000, 0x8020, 0xFFFF]) {
    for (const objectLo of [0x0000, 0x0010, 0x7FFF, 0x8000, 0xFFF0]) {
      const value = surfaceFor({ object_bytes: candidateObject({ low_addend: objectLo }), image: shippedImage({ lo: storedLo }) }).valueMap().get("gBase");
      assert.deepEqual(linkHiLo(value, 0, objectLo), [0x0002, storedLo], `${storedLo} ${objectLo}`);
    }
  }
});

test("a call value relinks to the shipped immediate", () => {
  for (const stored of [0x000000, 0x000123, 0x1FFFFFF, 0x3FFFFFF]) {
    const value = surfaceFor({ image: shippedImage({ jal_immediate: stored }) }).valueMap().get("callee");
    assert.equal(linkJump(value, 0), stored);
  }
});

test("a synthetic VMA below the jump region does not reach the field", () => {
  const value = surfaceFor({ synthetic_vma: "0x80100000", image: shippedImage({ jal_immediate: 0x123 }) }).valueMap().get("callee");
  assert.equal(value, 0x80000000 + (0x123 << 2));
  assert.equal(linkJump(value, 0), 0x123);
});

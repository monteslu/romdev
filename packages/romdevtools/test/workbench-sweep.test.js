// The sweep framework, tested against the incidents that shaped it. Ported
// from the workbench's sweep tests; the fixture is a synthetic stand-in.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { SweepCoverage } from "../src/decomp/workbench/coverage.js";
import { declarations, stripNoncode } from "../src/decomp/workbench/csource.js";
import { GENERATOR_CLASSES, SweepError, Variant, VariantKey, checkKeys, knownClass, readManifest, writeFamily } from "../src/decomp/workbench/sweep.js";
import { carrierPool, commutativeFamily, copyFamily, fusionDonors, fusionFamily, hoistFamily, parseConstruct, removalFamily } from "../src/decomp/workbench/sweep-generators.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/workbench/sweep-base.c", import.meta.url));

const SOURCE = `void demo(Object *obj) {
    f32 lead;
    f32 span;
    f32 reach;
    f32 carry;

    lead = obj->x * obj->y;
    span = lead + obj->z;
    reach = obj->speed * (obj->scale + obj->trim);
    if (span != 0.0f);
    carry = reach;
    limit(carry * obj->radius);
    tail(span);
}
`;

const TARGET_DUMP = `
00000000 <demo>:
   0: 27bdffe8  addiu $sp,$sp,-24
   4: afbf0014  sw $ra,20($sp)
   8: 8c8e0000  lw $t6,0($a0)
   c: 03e00008  jr $ra
  10: 27bd0018  addiu $sp,$sp,24
`;
const EXACT_DUMP = TARGET_DUMP;
const SHIFTED_DUMP = `
00000000 <demo>:
   0: 27bdffe8  addiu $sp,$sp,-24
   4: afbf0014  sw $ra,20($sp)
   8: 8c8e0000  lw $t6,0($a0)
   c: 000e7080  sll $t6,$t6,2
  10: 03e00008  jr $ra
  14: 27bd0018  addiu $sp,$sp,24
`;

const throwsSweep = (fn, re) => assert.throws(fn, (e) => e instanceof SweepError && re.test(e.message));

let root, file;
const code = () => stripNoncode(readFileSync(file, "utf8"));
function setup() {
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sweep-"));
    file = path.join(root, "work.c");
    writeFileSync(file, SOURCE);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
}

describe("registry", () => {
  test("an unregistered class is an error, not a shorter table", () => {
    let message = "";
    try { knownClass("Z"); } catch (e) { assert.ok(e instanceof SweepError); message = e.message; }
    assert.ok(message.includes("not a generator class"));
    for (const l of ["N", "O", "P", "A"]) assert.ok(message.includes(`${l} (`));
  });
  test("every registered class describes itself", () => {
    for (const [letter, entry] of Object.entries(GENERATOR_CLASSES)) {
      assert.equal(entry.letter, letter);
      assert.ok(entry.name && entry.description);
    }
  });
  test("a variant key checks its class on construction", () => {
    assert.throws(() => new VariantKey({ site: "L1", generator_class: "Z" }), SweepError);
  });
});

describe("keys", () => {
  const variant = (site, carrier, text = "x") => new Variant({ key: new VariantKey({ site, generator_class: "O", carrier }),
    filename: `${site}.${carrier}.c`, text, description: `${site} into ${carrier}` });
  test("one site and two carriers are two experiments", () => {
    const vs = [variant("L920", "lead"), variant("L920", "reach")];
    checkKeys(vs);
    assert.deepEqual(new Set(vs.map((v) => v.key.label)), new Set(["O.L920.lead", "O.L920.reach"]));
  });
  test("a repeated triple is a generator defect", () => {
    throwsSweep(() => checkKeys([variant("L920", "lead"), variant("L920", "lead")]), /share the key/);
  });
  test("a key with no carrier reads without a placeholder", () => {
    assert.equal(new VariantKey({ site: "L14", generator_class: "N" }).label, "N.L14");
  });
});

describe("carrier pool", () => {
  setup();
  test("a dead local is free and a live one says why", () => {
    const pool = carrierPool(file, { at: 12 });
    const verdicts = Object.fromEntries(pool.carriers.map((c) => [c.name, c.verdict]));
    assert.equal(verdicts.lead, "dead");
    assert.equal(verdicts.span, "live");
    assert.ok(pool.carriers.find((c) => c.name === "span").reason.includes("reads it before anything writes it"));
  });
  test("the pool is ordered by declaration index", () => {
    const usable = carrierPool(file, { at: 12 }).usable.map((c) => c.declaration_index);
    assert.deepEqual(usable, [...usable].sort((a, b) => a - b));
  });
  test("a fresh declaration is never proposed", () => {
    const pool = carrierPool(file, { at: 12 });
    const declared = new Set(declarations(code()).map((d) => d.name));
    assert.ok(pool.carriers.every((c) => declared.has(c.name)));
    assert.ok(JSON.stringify(pool.asDict()).includes("frame gate rejects it"));
  });
  test("a local whose address escapes is refused", () => {
    writeFileSync(file, SOURCE.replace("tail(span);", "tail(&lead);"));
    const lead = carrierPool(file, { at: 12 }).carriers.find((c) => c.name === "lead");
    assert.equal(lead.verdict, "escapes");
    assert.equal(lead.usable, false);
  });
  test("a type filter narrows the pool", () => {
    assert.deepEqual(carrierPool(file, { at: 12, wanted_type: "s32" }).carriers, []);
  });
  test("a line past the end names the file length", () => {
    assert.throws(() => carrierPool(file, { at: 999 }), /--at names line 999/);
  });
});

describe("removal", () => {
  setup();
  test("the lattice carries its own control", () => {
    const m = removalFamily(file, { constructs: [parseConstruct("10=deadread"), parseConstruct("11=copy")] });
    const sites = m.variants.map((v) => v.key.site);
    assert.equal(sites[0], "control");
    assert.equal(m.variants[0].text, readFileSync(file, "utf8"));
    for (const s of ["L10", "L11", "L10+L11"]) assert.ok(sites.includes(s));
  });
  test("the joint point is always included", () => {
    const m = removalFamily(file, { constructs: ["10=a", "11=b", "12=c"].map(parseConstruct), order: 1 });
    assert.ok(m.variants.map((v) => v.key.site).includes("L10+L11+L12"));
  });
  test("a removal that orphans a read is flagged, not hidden", () => {
    const m = removalFamily(file, { constructs: [parseConstruct("11=copy")] });
    const removal = m.variants.find((v) => v.key.site === "L11");
    assert.ok(removal.detail.semantics.includes("read-before-definition"));
    assert.ok(removal.detail.semantics.includes("carry"));
  });
  test("removing a line inside a frozen zone is refused by name", () => {
    const m = removalFamily(file, { constructs: [parseConstruct("10=deadread")], frozen: [[9, 11]] });
    assert.deepEqual(m.dropped.map((d) => d.site), ["L10"]);
    assert.ok(m.dropped[0].reason.includes("frozen zone 9..11"));
  });
  test("naming no construct says what a construct is", () => {
    throwsSweep(() => removalFamily(file, { constructs: [] }), /--construct LO\.\.HI=label/);
  });
  test("a construct past the end of the file is refused", () => {
    throwsSweep(() => removalFamily(file, { constructs: [parseConstruct("900")] }), /names line 900/);
  });
});

describe("hoist", () => {
  setup();
  test("the deep hoist reaches a leaf no top-level split can", () => {
    const deep = hoistFamily(file, { line: 9, classes: ["O"], carriers: ["lead"] });
    assert.ok(deep.variants.map((v) => v.detail.leaf).includes("obj->trim"));
    const shallow = hoistFamily(file, { line: 9, classes: ["H"], carriers: ["lead"] });
    assert.ok(!shallow.variants.map((v) => v.detail.leaf).includes("obj->trim"));
  });
  test("one line and two carriers are two variants", () => {
    const m = hoistFamily(file, { line: 9, classes: ["H"], carriers: ["lead", "carry"] });
    assert.deepEqual(new Set(m.variants.map((v) => v.key.carrier)), new Set(["lead", "carry"]));
    assert.equal(new Set(m.variants.map((v) => v.text)).size, m.variants.length);
  });
  test("the compound-assignment class exists", () => {
    writeFileSync(file, SOURCE.replace("    span = lead + obj->z;", "    span *= lead + obj->z;"));
    const m = hoistFamily(file, { line: 8, classes: ["P"], carriers: ["lead"] });
    assert.deepEqual(m.variants.map((v) => v.key.generator_class), ["P"]);
    assert.ok(m.variants[0].text.includes("lead = lead + obj->z;"));
  });
  test("the call-argument class exists", () => {
    const m = hoistFamily(file, { line: 12, classes: ["A"], carriers: ["lead"] });
    assert.deepEqual(m.variants.map((v) => v.key.generator_class), ["A"]);
    assert.ok(m.variants[0].text.includes("lead = carry * obj->radius;"));
  });
  test("no carrier names the command that says why", () => {
    writeFileSync(file, "void demo(Object *obj) {\n    f32 span;\n    span = obj->x;\n    tail(span + obj->y * obj->z);\n}\n");
    let message = "";
    try { hoistFamily(file, { line: 4, classes: ["A"] }); } catch (e) { assert.ok(e instanceof SweepError); message = e.message; }
    assert.ok(message.includes("sweep carriers"));
    assert.ok(message.includes("mints a frame slot"));
  });
  test("an unknown hoist class lists the four", () => {
    throwsSweep(() => hoistFamily(file, { line: 9, classes: ["Q"], carriers: ["lead"] }), /not a hoist class/);
  });
  test("a carrier this file does not declare is refused", () => {
    throwsSweep(() => hoistFamily(file, { line: 9, classes: ["H"], carriers: ["nowhere"] }), /does not declare nowhere/);
  });
});

describe("commutative", () => {
  setup();
  const sites = (m) => new Set(m.variants.map((v) => v.description));
  test("a pointer declarator is not a multiplication", () => {
    for (const v of commutativeFamily(file).variants) assert.ok(!v.description.includes("Object"));
  });
  test("a swap that would reassociate is never offered", () => {
    writeFileSync(file, "void demo(Object *obj) {\n    f32 span;\n    span = obj->a + obj->b * obj->c;\n    tail(span);\n}\n");
    const described = [...sites(commutativeFamily(file))];
    assert.equal(described.length, 1);
    assert.ok(described[0].includes("obj->b * obj->c exchanged"));
  });
  test("a parenthesized subexpression is its own pair", () => {
    const m = commutativeFamily(file, { lines: [9] });
    assert.equal(m.variants.length, 2);
    assert.ok([...sites(m)].join(" ").includes("obj->scale + obj->trim exchanged"));
  });
  test("a comparison offers nothing", () => {
    throwsSweep(() => commutativeFamily(file, { lines: [10] }), /no exchangeable commutative operand pair/);
  });
  test("the exchange is textually pure", () => {
    assert.ok(commutativeFamily(file, { lines: [7] }).variants[0].text.includes("lead = obj->y * obj->x;"));
  });
});

describe("copies", () => {
  setup();
  test("a copy is dropped and its reads rehosted", () => {
    const m = copyFamily(file);
    assert.equal(m.variants.length, 1);
    assert.ok(!m.variants[0].text.includes("carry = reach;"));
    assert.ok(m.variants[0].text.includes("limit(reach * obj->radius);"));
  });
  test("a copy whose source is rewritten is refused with the line", () => {
    writeFileSync(file, SOURCE.replace("    limit(carry * obj->radius);", "    reach = 0.0f;\n    limit(carry * obj->radius);"));
    const m = copyFamily(file);
    assert.deepEqual(m.variants, []);
    assert.ok(m.dropped[0].reason.includes("reach is written at line 12"));
  });
  test("a file with no copy says so", () => {
    writeFileSync(file, "void demo(void) {\n    f32 span;\n    span = 1.0f;\n    tail(span);\n}\n");
    throwsSweep(() => copyFamily(file), /no copy of the form/);
  });
});

describe("fusion", () => {
  setup();
  test("a declaration block does not make every range overlap", () => {
    const lead = fusionDonors(file, { target: "carry" }).find((d) => d.name === "lead");
    assert.equal(lead.disjoint, true);
    assert.ok(lead.reason.includes("dies at line"));
  });
  test("an overlapping range is refused with both ranges", () => {
    const span = fusionDonors(file, { target: "carry" }).find((d) => d.name === "span");
    assert.equal(span.disjoint, false);
    assert.ok(span.reason.includes("overlaps the target's"));
  });
  test("a fused variant drops the donor and renames its uses", () => {
    const m = fusionFamily(file, { target: "carry" });
    assert.deepEqual(m.variants.map((v) => v.key.site), ["lead->carry"]);
    assert.ok(!m.variants[0].text.includes("f32 lead;"));
    assert.ok(m.variants[0].text.includes("carry = obj->x * obj->y;"));
  });
  test("naming an overlapping donor refuses it rather than fusing", () => {
    const m = fusionFamily(file, { target: "carry", donors: ["span"] });
    assert.deepEqual(m.variants, []);
    assert.ok(m.dropped[0].reason.includes("overlaps"));
  });
  test("a target this file does not declare is refused", () => {
    assert.throws(() => fusionDonors(file, { target: "nowhere" }), /does not declare/);
  });
});

describe("manifest", () => {
  setup();
  const manifest = () => removalFamily(file, { constructs: [parseConstruct("10=deadread"), parseConstruct("11=copy")] });
  test("a written family reads back with every key", () => {
    const dir = path.join(root, "regress");
    const placed = writeFamily(manifest(), { directory: dir });
    const again = readManifest(dir);
    assert.deepEqual(again.variants.map((v) => v.key.asDict()), placed.variants.map((v) => v.key.asDict()));
    assert.equal(again.generator, "regress");
  });
  test("a non-empty directory is refused without overwrite", () => {
    const dir = path.join(root, "regress");
    writeFamily(manifest(), { directory: dir });
    throwsSweep(() => writeFamily(manifest(), { directory: dir }), /--overwrite/);
    writeFamily(manifest(), { directory: dir, overwrite: true });
  });
  test("a manifest naming an unregistered class fails to read", () => {
    const dir = path.join(root, "regress");
    writeFamily(manifest(), { directory: dir });
    const payload = JSON.parse(readFileSync(path.join(dir, "sweep.json"), "utf8"));
    payload.variants[1].class = "Z";
    writeFileSync(path.join(dir, "sweep.json"), JSON.stringify(payload));
    throwsSweep(() => readManifest(dir), /not a generator class/);
  });
  test("two classes that spell one file pay for one build", () => {
    const placed = writeFamily(hoistFamily(file, { line: 8, classes: ["H", "O"], carriers: ["lead"] }), { directory: path.join(root, "hoist") });
    const texts = placed.variants.map((v) => v.text);
    assert.equal(texts.length, new Set(texts).size);
    assert.ok(placed.dropped.some((d) => d.reason.includes("byte-identical")));
  });
});

describe("ingest", () => {
  setup();
  let ingestSweep, ingestLines;
  beforeEach(async () => {
    ({ ingestSweep, ingestLines } = await import("../src/decomp/workbench/sweep-ingest.js"));
  });
  function build() {
    const directory = path.join(root, "regress");
    writeFamily(removalFamily(file, { constructs: [parseConstruct("10=deadread"), parseConstruct("11=copy")] }), { directory });
    const objects = path.join(root, "o");
    mkdirSync(objects);
    writeFileSync(path.join(objects, "work.N.control.objdump"), SHIFTED_DUMP);
    writeFileSync(path.join(objects, "work.N.L10.objdump"), EXACT_DUMP);
    writeFileSync(path.join(objects, "work.N.L11.objdump"), SHIFTED_DUMP);
    const target = path.join(root, "target.objdump");
    writeFileSync(target, TARGET_DUMP);
    return { directory, objects, target };
  }
  const ingest = async () => {
    const { directory, objects, target } = build();
    return ingestSweep(readManifest(directory), { objects, target, suffix: ".objdump", dumps: true, target_dumps: true });
  };
  test("a wrong instruction count is a column, not a rejection", async () => {
    const control = (await ingest()).control;
    assert.equal(control.rows_away, 1);
    assert.equal(control.inserted, 1);
    assert.equal(control.screen.instructions, 6);
  });
  test("the price table names what each construct costs", async () => {
    const result = await ingest();
    const prices = Object.fromEntries(result.scored.filter((r) => r.key.site !== "control").map((r) => [r.key.site, result.price(r)]));
    assert.equal(prices.L10, 1);
    assert.equal(prices.L11, 0);
    const report = ingestLines(result).join("\n");
    assert.ok(report.includes("COSTS 1 row(s): removing it improves the base"));
    assert.ok(report.includes("free: removing it changes nothing measurable"));
  });
  test("an unbuilt variant is a row naming the path", async () => {
    const result = await ingest();
    assert.deepEqual(result.missing.map((r) => r.key.site), ["L10+L11"]);
    assert.ok((result.missing[0].missing || "").includes("work.N.L10-L11.objdump"));
    assert.ok(ingestLines(result).join("\n").includes("unbuilt (1)"));
  });
  test("coverage falls by whatever failed to build", async () => {
    const result = await ingest();
    assert.equal(result.asDict().coverage.covered, 3);
    assert.ok(ingestLines(result).join("\n").includes("coverage:"));
  });
  test("an unbuilt point is unvisited and never an exclusion", async () => {
    const result = await ingest();
    const payload = result.asDict();
    assert.equal(result.missing.length, 1);
    assert.equal(payload.coverage.excluded, 0);
    assert.equal(payload.coverage.unvisited, 1);
    const sentence = ingestLines(result).join("\n");
    assert.ok(sentence.includes("sampled"));
    assert.ok(sentence.includes("never visited"));
    assert.ok(!sentence.includes("is a proof about this space"));
  });
  test("the best variant ranks first", async () => {
    const result = await ingest();
    assert.equal(result.ranked[0].key.site, "L10");
    assert.equal(result.ranked[0].rows_away, 0);
  });
  test("an objects path that is not a directory says what it is for", async () => {
    const { directory, target } = build();
    await assert.rejects(ingestSweep(readManifest(directory), { objects: path.join(root, "nowhere"), target, dumps: true, target_dumps: true }), (e) => e instanceof SweepError && /compile-one wrapper/.test(e.message));
  });
});

describe("sweep commands", () => {
  test("the group lists its operations rather than erroring", async () => {
    const r = await runCommand(["sweep"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.includes("sweep regress"));
    assert.ok(r.stdout.includes("sweep ingest"));
  });
  test("--at and --line are one option across the family", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sweep-"));
    try {
      const source = path.join(d, "work.c");
      writeFileSync(source, SOURCE);
      const byAt = await runCommand(["sweep", "carriers", source, "--at", "12"]);
      const byLine = await runCommand(["sweep", "carriers", source, "--line", "12"]);
      assert.equal(byAt.code, 0);
      assert.equal(byLine.code, 0);
      assert.equal(byAt.stdout, byLine.stdout);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("carriers reports the pool as JSON", async () => {
    const r = await runCommand(["sweep", "carriers", FIXTURE, "--at", "16", "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.schema, "decomp-workbench-carrier-pool-v1");
    assert.equal(payload.pool_size, 2);
  });
  test("a generator writes a manifest and names the next step", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sweep-"));
    try {
      const out = path.join(d, "commute");
      const r = await runCommand(["sweep", "commute", FIXTURE, "--write", out]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(existsSync(path.join(out, "sweep.json")));
      assert.ok(r.stdout.includes("sweep ingest"));
      assert.ok(r.stdout.includes("coverage:"));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a bad construct spec explains the spelling", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sweep-"));
    try {
      const r = await runCommand(["sweep", "regress", FIXTURE, "--construct", "the deadread", "--write", path.join(d, "out")]);
      assert.equal(r.code, 2);
      assert.ok(r.stderr.includes("LO..HI[=label]"));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("the grouped spelling is an exact alias", async () => {
    const grouped = await runCommand(["sweep", "carriers", FIXTURE, "--at", "16", "--json"]);
    const flat = await runCommand(["sweep-carriers", FIXTURE, "--at", "16", "--json"]);
    assert.deepEqual(grouped, flat);
  });
  test("donors, hoist, copies, fuse and regress run through the command surface", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sweep-"));
    try {
      const donors = await runCommand(["sweep", "donors", FIXTURE, "--target", "carry", "--json"]);
      assert.equal(donors.code, 0, donors.stderr);
      assert.equal(JSON.parse(donors.stdout).schema, "decomp-workbench-fusion-donors-v1");
      const hoist = await runCommand(["sweep", "hoist", FIXTURE, "--at", "16", "--class", "a", "--write", path.join(d, "h"), "--json"]);
      assert.equal(hoist.code, 0, hoist.stderr);
      assert.equal(JSON.parse(hoist.stdout).schema, "decomp-workbench-sweep-v1");
      const copies = await runCommand(["sweep-copies", FIXTURE, "--write", path.join(d, "c")]);
      assert.equal(copies.code, 0, copies.stderr);
      const fuse = await runCommand(["sweep", "fuse", FIXTURE, "--target", "carry", "--write", path.join(d, "f")]);
      assert.ok([0, 2].includes(fuse.code));
      const regress = await runCommand(["sweep", "regress", FIXTURE, "--construct", "11..12=levers", "--write", path.join(d, "r"), "--json"]);
      assert.equal(regress.code, 0, regress.stderr);
      assert.equal(JSON.parse(regress.stdout).variant_count, 2);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

test("a sampled family never claims a proof", () => {
  const coverage = new SweepCoverage({ basis: "carriers", space: 10, covered: 3 });
  assert.equal(coverage.vocabulary, "sampled");
  assert.ok(coverage.sentence().includes("not a proof"));
});

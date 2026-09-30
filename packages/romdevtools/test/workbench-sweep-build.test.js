// `sweep build`: the compile fan-out, its cache, and its scored table. The
// compiler is a node script the test writes: it copies a prebuilt object into
// place, so the wave's own behaviour (pool, nice, cache, ordering, table) is
// under test without a MIPS compiler. The objects are hand-built ELFs holding
// synthetic instruction words. Ported from the workbench's sweep-build tests.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { STB_GLOBAL, STT_FUNC, buildObject, words } from "./fixtures/workbench/elf-fixtures.js";
import { DEFAULT_JOBS, DEFAULT_NICE, SweepBuildError, buildLines, collectSources, runSweepBuild } from "../src/decomp/workbench/sweep-build.js";
import { parseWatchRows } from "../src/decomp/workbench/watch-rows.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const TARGET_WORDS = words(0x27BDFFE8, 0x00851021, 0x24420004, 0x03E00008, 0x27BD0018);
const NEAR_WORDS = words(0x27BDFFE8, 0x00851821, 0x24420004, 0x03E00008, 0x27BD0018);
const FAR_WORDS = words(0x27BDFFE8, 0x00851821, 0x24420008, 0x03E00008, 0x27BD0018);
const object = (text) => buildObject({ text, symbols: [["wb_demo", 0, text.length, STT_FUNC, STB_GLOBAL]] });

// A GNU-compatible MIPS objdump: the registered project's (with its library
// path) when present, else one on PATH.
function findObjdump() {
  try {
    const m = JSON.parse(readFileSync(path.join(os.homedir(), ".romdev/decomp/wr64-us-rev1/manifest.json"), "utf8"));
    const p = m.toolchain?.objdump?.path;
    if (p && existsSync(p)) {
      const lib = path.join(m.root, ".toolchains/mips/usr/lib/x86_64-linux-gnu");
      if (existsSync(lib)) process.env.LD_LIBRARY_PATH = lib + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : "");
      return p;
    }
  } catch { /* no registered project */ }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of ["mips-linux-gnu-objdump", "mips64-elf-objdump"]) if (existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}
const OBJDUMP = findObjdump();

const manifestJson = (variants) => JSON.stringify({ schema: "decomp-workbench-sweep-v1", generator: "demo", base: "base.c", base_sha256: "0".repeat(64),
  variants: variants.map(([site, filename]) => ({ site, class: "H", carrier: "-", filename })), coverage: { basis: "sampled", covered: variants.length } });

describe("collect sources", () => {
  let d;
  beforeEach(() => { d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sb-")); });
  afterEach(() => rmSync(d, { recursive: true, force: true }));
  test("a directory contributes its sources in order", () => {
    for (const n of ["b.c", "a.c", "notes.txt"]) writeFileSync(path.join(d, n), "x");
    assert.deepEqual(collectSources([d]).map((p) => path.basename(p)), ["a.c", "b.c"]);
  });
  test("a sweep directory follows its manifest order", () => {
    for (const n of ["v-second.c", "v-first.c"]) writeFileSync(path.join(d, n), "x");
    writeFileSync(path.join(d, "sweep.json"), manifestJson([["L2", "v-second.c"], ["L1", "v-first.c"]]));
    assert.deepEqual(collectSources([d]).map((p) => path.basename(p)), ["v-second.c", "v-first.c"]);
  });
  test("a missing input names what the command accepts", () => {
    assert.throws(() => collectSources(["/nonexistent/variants"]), (e) => e instanceof SweepBuildError && e.message.includes("sweep.json"));
  });
  test("a manifest variant whose file is missing is still collected", () => {
    writeFileSync(path.join(d, "v-present.c"), "x");
    writeFileSync(path.join(d, "sweep.json"), manifestJson([["L1", "v-present.c"], ["L2", "v-vanished.c"]]));
    assert.deepEqual(collectSources([d]).map((p) => path.basename(p)), ["v-present.c", "v-vanished.c"]);
  });
  test("a source named twice is built once", () => {
    const s = path.join(d, "a.c");
    writeFileSync(s, "x");
    assert.equal(collectSources([s, d, s]).length, 1);
  });
});

describe("a whole wave", { skip: OBJDUMP ? false : "needs a MIPS objdump" }, () => {
  let root, sources, objects, prebuilt, target, compiler, template;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sb-"));
    sources = path.join(root, "variants"); mkdirSync(sources);
    objects = path.join(root, "objects");
    prebuilt = path.join(root, "prebuilt"); mkdirSync(prebuilt);
    target = path.join(root, "target.o");
    writeFileSync(target, object(TARGET_WORDS));
    for (const [name, text] of [["exact", TARGET_WORDS], ["near", NEAR_WORDS], ["far", FAR_WORDS]]) {
      writeFileSync(path.join(prebuilt, `${name}.o`), object(text));
      writeFileSync(path.join(sources, `${name}.c`), `/* ${name} */\n`);
    }
    writeFileSync(path.join(sources, "broken.c"), "/* broken */\n");
    compiler = path.join(root, "fake-cc.mjs");
    writeFileSync(compiler, `import fs from "node:fs"; import path from "node:path";
const [source, output] = process.argv.slice(2);
const root = ${JSON.stringify(prebuilt)};
const stem = path.basename(source).replace(/\\.[^.]*$/, "");
const scoped = path.join(root, path.basename(path.dirname(source)) + "-" + stem + ".o");
const prebuilt = fs.existsSync(scoped) ? scoped : path.join(root, stem + ".o");
if (!fs.existsSync(prebuilt)) { process.stderr.write("no rule to make " + stem + "\\n"); process.exit(2); }
fs.copyFileSync(prebuilt, output);
const counter = path.join(path.dirname(output), "compile-count.txt");
fs.writeFileSync(counter, fs.existsSync(counter) ? String(Number(fs.readFileSync(counter, "utf8") || 0) + 1) : "1");
`);
    template = `${process.execPath} ${compiler} {source} {output}`;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (over = {}) => runSweepBuild(collectSources([sources]), { target, template, objects, jobs: 2, niceness: DEFAULT_NICE, timeout: 60.0, objdump: OBJDUMP, ...over });

  test("the table is ranked and nothing is lost", async () => {
    const wave = await run();
    assert.deepEqual(wave.ranked.map((r) => r.label), ["exact", "near", "far"]);
    assert.deepEqual(wave.unscored.map((r) => r.label), ["broken"]);
    assert.equal(wave.unscored[0].status, "failed");
    assert.ok(wave.unscored[0].detail.includes("no rule to make broken"));
    assert.equal(wave.count("compiled"), 3);
  });
  test("an up-to-date object is not rebuilt", async () => {
    const first = await run();
    assert.equal(first.count("compiled"), 3);
    const second = await run();
    assert.equal(second.count("cached"), 3);
    assert.equal(second.count("compiled"), 0);
    assert.deepEqual(second.ranked.map((r) => r.label), first.ranked.map((r) => r.label));
  });
  test("a changed compile command invalidates the cache", async () => {
    await run();
    assert.equal((await run({ template: template + " --ignored-flag" })).count("compiled"), 3);
  });
  test("refresh rebuilds everything", async () => {
    await run();
    assert.equal((await run({ refresh: true })).count("compiled"), 3);
  });
  test("the watch signature is a column", async () => {
    const wave = await run({ watch: parseWatchRows("a=1,b=2") });
    const sig = Object.fromEntries(wave.ranked.map((r) => [r.label, r.signature]));
    assert.deepEqual(sig, { exact: "..", near: "X.", far: "XX" });
  });
  test("the watch order ranks by healed columns", async () => {
    assert.deepEqual((await run({ watch: parseWatchRows("a=1,b=2"), order: "watch" })).ranked.map((r) => r.label), ["exact", "near", "far"]);
  });
  test("the name order ignores the metrics", async () => {
    assert.deepEqual((await run({ order: "name" })).ranked.map((r) => r.label), ["exact", "far", "near"]);
  });
  test("an unknown order is refused", async () => {
    await assert.rejects(run({ order: "vibes" }), SweepBuildError);
  });
  test("the terminal table carries the signature and the verdict", async () => {
    const rendered = buildLines(await run({ watch: parseWatchRows("r1=1,r2=2") })).join("\n");
    for (const s of ["watch rows", "r1 r2", "instruction-words-identical", "EXACT: exact", "failed"]) assert.ok(rendered.includes(s), s);
  });
  test("the JSON reports every status and the ranked rows", async () => {
    const payload = (await run({ watch: parseWatchRows("r1=1") })).asDict();
    assert.equal(payload.schema, "decomp-workbench-sweep-build-v1");
    assert.equal(payload.compiled, 3);
    assert.equal(payload.failed, 1);
    assert.deepEqual(payload.results.map((r) => r.label), ["exact", "near", "far"]);
    assert.equal(payload.results[0].watch_signature, ".");
    assert.ok(!("schema" in payload.results[0]));
    assert.equal(payload.results[0].words, 0);
    assert.deepEqual(payload.unscored.map((r) => r.label), ["broken"]);
  });
  test("the default pool and niceness are the documented ones", () => {
    assert.deepEqual([DEFAULT_JOBS, DEFAULT_NICE], [4, 10]);
  });
  test("the command surface exits zero and prints JSON", async () => {
    const r = await runCommand(["sweep", "build", sources, "--target", target, "--compile-command", template, "--objects", objects,
      "--jobs", "2", "--timeout", "60", "--watch-rows", "r1=1", "--objdump", OBJDUMP, "--json"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.nice, DEFAULT_NICE);
    assert.equal(payload.jobs, 2);
    assert.deepEqual(payload.watch_row_set.map((e) => e.label), ["r1"]);
    const text = await runCommand(["sweep-build", sources, "--target", target, "--compile-command", template, "--objects", objects, "--objdump", OBJDUMP]);
    assert.equal(text.code, 0);
    assert.ok(text.stdout.includes("already current"));
  });
  test("same-named sources from two directories do not collide", async () => {
    const first = path.join(root, "wave-a"), second = path.join(root, "wave-b");
    for (const [dir, text] of [[first, TARGET_WORDS], [second, FAR_WORDS]]) {
      mkdirSync(dir);
      writeFileSync(path.join(dir, "hoist.c"), "/* hoist */\n");
      writeFileSync(path.join(prebuilt, `${path.basename(dir)}-hoist.o`), object(text));
    }
    const objs = path.join(root, "collision-objects");
    const wave = await runSweepBuild(collectSources([first, second]), { target, template, objects: objs, jobs: 2, niceness: 0, timeout: 60.0, objdump: OBJDUMP });
    assert.deepEqual(wave.colliding_stems, ["hoist"]);
    const labels = wave.ranked.map((r) => r.label);
    assert.equal(new Set(labels).size, 2);
    assert.ok(labels.every((l) => l.startsWith("hoist-")), String(labels));
    assert.deepEqual(wave.ranked.map((r) => r.comparison.word_mismatches).sort((a, b) => a - b), [0, 2]);
    assert.equal(readdirSync(objs).filter((n) => /^hoist-.*\.o$/.test(n)).length, 2);
    assert.ok(buildLines(wave).join("\n").includes("appear in more than one input directory"));
  });
  test("a declared variant whose file is missing gets a row", async () => {
    const dir = path.join(root, "manifest");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "near.c"), "/* near */\n");
    writeFileSync(path.join(dir, "sweep.json"), manifestJson([["L1", "near.c"], ["L2", "vanished.c"]]));
    const wave = await runSweepBuild(collectSources([dir]), { target, template, objects: path.join(root, "manifest-objects"), jobs: 1, niceness: 0, timeout: 60.0, objdump: OBJDUMP });
    assert.deepEqual(wave.unscored.map((r) => r.label), ["vanished"]);
    assert.equal(wave.unscored[0].status, "failed");
    assert.ok(wave.unscored[0].detail.includes("does not exist"));
    assert.equal(wave.count("failed"), 1);
    assert.deepEqual(wave.ranked.map((r) => r.label), ["near"]);
  });
  test("a swapped compiler binary invalidates the cache", async () => {
    const wrapper = path.join(root, "cc-wrapper");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} "${compiler}" "$1" "$2"\n`);
    chmodSync(wrapper, 0o755);
    const tpl = `${wrapper} {source} {output}`;
    const objs = path.join(root, "swap-objects");
    assert.equal((await run({ template: tpl, objects: objs })).count("compiled"), 3);
    writeFileSync(wrapper, `#!/bin/sh\n# rebuilt toolchain\nexec ${process.execPath} "${compiler}" "$1" "$2"\n`);
    chmodSync(wrapper, 0o755);
    const again = await run({ template: tpl, objects: objs });
    assert.equal(again.count("compiled"), 3);
    assert.equal(again.count("cached"), 0);
  });
  test("a wave that scores nothing exits one", async () => {
    const empty = path.join(root, "none");
    mkdirSync(empty);
    writeFileSync(path.join(empty, "broken.c"), "/* broken */\n");
    const r = await runCommand(["sweep", "build", empty, "--target", target, "--compile-command", template, "--objects", path.join(root, "none-objects"),
      "--jobs", "1", "--nice", "0", "--objdump", OBJDUMP, "--json"]);
    assert.equal(r.code, 1);
  });
});

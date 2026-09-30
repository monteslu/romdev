// Toolchain microcases and cross-revision lineage stay redistributable.
// The compiler and objdump here are small node stand-ins. Ported from the
// workbench's own fingerprint tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { compareFingerprintReports, crossRomLineage, instructionFingerprint, runToolchainFingerprint } from "../src/decomp/workbench/fingerprint.js";
import { Instruction } from "../src/decomp/workbench/model.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

test("computed jump excludes the return register in both objdump dialects", () => {
  const features = instructionFingerprint([new Instruction({ address: 0, word: "01c00008", assembly: "jr\tt6" }), new Instruction({ address: 4, word: "03e00008", assembly: "jr\t$ra" })]);
  assert.equal(features.computed_jump, true);
  assert.deepEqual(features.computed_jumps, ["jr\tt6"]);
});

function makeTools() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "romdev-wb-fp-")));
  const compiler = path.join(root, "compile.mjs");
  writeFileSync(compiler, "import fs from 'node:fs';\nfs.writeFileSync(process.argv[3], fs.readFileSync(process.argv[2]));\n");
  const objdump = path.join(root, "objdump");
  writeFileSync(objdump, `#!${process.execPath}\n`
    + "for (const name of ['dkwb_fp_control_flow', 'dkwb_fp_stack_home', 'dkwb_fp_schedule', 'dkwb_fp_allocation', 'dkwb_fp_dense_switch_4', 'dkwb_fp_dense_switch_5']) {\n"
    + "  console.log(`00000000 <${name}>:`);\n  console.log('   0: 27bdffe0  addiu $sp,$sp,-32');\n  console.log('   4: 03e00008  jr $ra');\n  console.log('   8: 00000000  nop');\n}\n");
  chmodSync(objdump, 0o755);
  return { root, compiler, objdump, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("the bundled microcases produce a stable feature fingerprint", async () => {
  const t = makeTools();
  const report = await runToolchainFingerprint(`${process.execPath} ${t.compiler} {source} {output}`, { compile_cwd: t.root, environment: {}, objdump: t.objdump, timeout: 10 });
  assert.equal(report.cases.length, 6);
  assert.equal(report.fingerprint.length, 64);
  assert.ok(report.cases.every((c) => c.features.instructions === 3));
  assert.ok(report.proof.includes("not a claim"));
  assert.equal(report.suite.length, 64);
  const dispatch = Object.fromEntries(report.cases.filter((c) => c.name.startsWith("dense-switch-")).map((c) => [c.name, c.features.computed_jump]));
  assert.deepEqual(dispatch, { "dense-switch-4": false, "dense-switch-5": false });
  assert.equal(compareFingerprintReports(report, report).identical, true);
  const comparison = compareFingerprintReports(report, { ...report, suite: "0".repeat(64) });
  assert.equal(comparison.compatible, false);
  assert.equal(comparison.identical, false);
  t.done();
});

test("lineage records hashes without reading ROM data", () => {
  const t = makeTools();
  const us = path.join(t.root, "us.o"), jp = path.join(t.root, "jp.o");
  writeFileSync(us, "us"); writeFileSync(jp, "jp");
  const report = crossRomLineage({ us, jp }, { objdump: t.objdump, symbol: "dkwb_fp_control_flow", rom_hashes: { us: "a".repeat(64), jp: "b".repeat(64) } });
  assert.throws(() => crossRomLineage({ us, jp }, { objdump: t.objdump, symbol: "dkwb_fp_control_flow", rom_hashes: { eu: "c".repeat(64) } }), /no matching revision/);
  assert.throws(() => crossRomLineage({ us, jp }, { objdump: t.objdump, symbol: "dkwb_fp_control_flow", rom_hashes: { us: "not-a-sha256" } }), /64 hexadecimal/);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].exact, true);
  assert.equal(report.revisions.us.rom_sha256, "a".repeat(64));
  assert.ok(report.proof.includes("never reads"));
  t.done();
});

test("the commands: fingerprint, compare two reports, lineage", async () => {
  const t = makeTools();
  const out = path.join(t.root, "fp.json");
  let r = await runCommand(["toolchain", "fingerprint", "--compile-command", `${process.execPath} ${t.compiler} {source} {output}`, "--objdump", t.objdump,
    "--compile-cwd", t.root, "--output", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^toolchain fingerprint: [0-9a-f]{64}\nmicrocase suite: [0-9a-f]{64}\ncases: 6\ndense switch dispatch: 4=chain, 5=chain\n/);
  r = await runCommand(["fingerprint-toolchain", "--compare", out, out]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "toolchain fingerprints: IDENTICAL\n");
  r = await runCommand(["fingerprint-toolchain", "--compile-command", "x {source} {output}", "--output", out, "--compile-cwd", t.root, "--objdump", t.objdump]);
  assert.equal(r.code, 2);
  r = await runCommand(["fingerprint-toolchain", "--json"]);
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.stdout).error.message, /one of the arguments --compile-command --compare is required/);
  const us = path.join(t.root, "us.o"), jp = path.join(t.root, "jp.o");
  writeFileSync(us, "us"); writeFileSync(jp, "jp");
  r = await runCommand(["toolchain", "lineage", `us=${us}`, `jp=${jp}`, "--symbol", "dkwb_fp_control_flow", "--objdump", t.objdump]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^lineage: 2 revision\(s\), 1 normalized group\(s\)\n[0-9a-f]{12}: jp, us\nproof: /);
  r = await runCommand(["lineage", "us", "--symbol", "x"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("revision expects NAME=VALUE: 'us'"));
  t.done();
});

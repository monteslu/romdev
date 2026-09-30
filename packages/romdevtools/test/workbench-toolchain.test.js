// Real-copy toolchains remain inspectable and refuse unsupported claims.
// Ported from the workbench's toolchain tests; the stand-in objdump is a node
// script.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MANIFEST_NAME, calibrateToolchain, initializeToolchain, toolchainStatus, seams } from "../src/decomp/workbench/toolchain.js";
import { toolchainCalibrateCommand } from "../src/decomp/workbench/toolchain-cli.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-toolchain-")));

function makeObjdump(root) {
  const p = path.join(root, "objdump");
  fs.writeFileSync(p, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes("-s")) console.log(" 0000 11223344");
else if (a.includes("-r")) console.log("RELOCATION RECORDS FOR [.text]:");
else if (a.includes("-t")) { console.log("SYMBOL TABLE:"); console.log("00000000 g F .text 00000004 demo"); }
`);
  fs.chmodSync(p, 0o755);
  return p;
}

test("init dereferences source links and detects tampering", async () => {
  const root = tmp();
  try {
    const base = path.join(root, "stock");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "real-uopt"), "stock");
    fs.symlinkSync("real-uopt", path.join(base, "uopt"));
    const replacement = path.join(root, "instrumented-uopt");
    fs.writeFileSync(replacement, "instrumented");
    const output = path.join(root, "copy");
    const report = await initializeToolchain(output, { base, replacements: { uopt: replacement } });
    assert.ok(!fs.lstatSync(path.join(output, "uopt")).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(output, "uopt"), "utf8"), "instrumented");
    assert.equal(report.claim, "uncalibrated");
    assert.equal(report.gates.real_copy, true);
    assert.ok(fs.statSync(path.join(output, MANIFEST_NAME)).isFile());
    assert.equal(toolchainStatus(output).integrity, true);
    fs.writeFileSync(path.join(output, "uopt"), "tampered");
    const status = toolchainStatus(output);
    assert.equal(status.integrity, false);
    assert.equal(status.claim, "uncalibrated");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("init refuses an existing destination and a nested copy", async () => {
  const root = tmp();
  try {
    const base = path.join(root, "stock");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "cc"), "cc");
    await assert.rejects(initializeToolchain(path.join(base, "nested"), { base, replacements: {} }), { name: "ValueError" });
    fs.mkdirSync(path.join(root, "existing"));
    await assert.rejects(initializeToolchain(path.join(root, "existing"), { base, replacements: {} }), (e) => e.kind === "FileExistsError");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("init never cleans up a destination it did not create", async () => {
  const root = tmp();
  const saved = seams.mkdir;
  try {
    const base = path.join(root, "stock");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "cc"), "cc");
    const output = path.join(root, "raced");
    seams.mkdir = (p) => {
      fs.mkdirSync(p);
      fs.writeFileSync(path.join(p, "foreign"), "do not remove");
      const e = new Error(`[Errno 17] File exists: '${p}'`);
      e.kind = "FileExistsError";
      throw e;
    };
    await assert.rejects(initializeToolchain(output, { base, replacements: {} }), (e) => e.kind === "FileExistsError");
    assert.equal(fs.readFileSync(path.join(output, "foreign"), "utf8"), "do not remove");
  } finally { seams.mkdir = saved; fs.rmSync(root, { recursive: true, force: true }); }
});

test("the manifest contains no proprietary contents", async () => {
  const root = tmp();
  try {
    const base = path.join(root, "stock");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "cc"), "private-binary");
    const output = path.join(root, "copy");
    await initializeToolchain(output, { base, replacements: {} });
    assert.ok(!fs.readFileSync(path.join(output, MANIFEST_NAME), "utf8").includes("private-binary"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("calibration reaches ready only after every gate passes", async () => {
  const root = tmp();
  try {
    const base = path.join(root, "stock");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "cc"), "cc");
    const objdump = makeObjdump(root);
    const stock = path.join(root, "stock.o"), instrumented = path.join(root, "instrumented.o");
    fs.writeFileSync(stock, "stock");
    fs.writeFileSync(instrumented, "instrumented");
    const scheduler = path.join(root, "scheduler.log");
    fs.writeFileSync(scheduler, "[DKWB-SCHED-V1] proc=1 block=2 cycle=3 word=0x8c220000 opcode=lw line=9 ready=2 chosen=n4 tie=source-order\n");
    const output = path.join(root, "copy");
    await initializeToolchain(output, { base, replacements: {}, fidelity_pairs: [[stock, instrumented]], scheduler_positive_log: scheduler, objdump });
    assert.equal(toolchainStatus(output).claim, "uncalibrated");
    const report = await calibrateToolchain(output, { unedited_replay_pairs: [[stock, instrumented]], collateral_pairs: [[stock, instrumented]], project_output_pairs: [[stock, stock]], objdump });
    assert.equal(report.claim, "ready");
    assert.deepEqual(report.next_missing_gates, []);
    // The commands agree: status exits 0 on a ready, intact copy.
    const s = await runCommand(["toolchain", "status", output, "--json"]);
    assert.equal(s.code, 0);
    assert.equal(JSON.parse(s.stdout).claim, "ready");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a successful partial calibration is not a process failure", async () => {
  const io = { out: [], print(s) { this.out.push(s); }, eprint() {} };
  const root = tmp();
  try {
    const base = path.join(root, "stock");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "cc"), "cc");
    const output = path.join(root, "copy");
    await initializeToolchain(output, { base, replacements: {} });
    const scheduler = path.join(root, "scheduler.log");
    fs.writeFileSync(scheduler, "[DKWB-SCHED-V1] proc=1 block=2 cycle=3 word=0x8c220000 opcode=lw line=9 ready=2 chosen=n4 tie=source-order\n");
    const args = { directory: output, unedited_replay_pair: [], collateral_pair: [], project_output_pair: [], scheduler_positive_log: scheduler, objdump: null, json: false };
    const status = await toolchainCalibrateCommand(args, io, { resolve: (p) => path.resolve(root, p) });
    assert.equal(status, 0);
    assert.ok(io.out.join("\n").includes("UNCALIBRATED"));
    const none = await runCommand(["toolchain-calibrate", output]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /at least one evidence input/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

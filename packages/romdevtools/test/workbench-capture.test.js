// Phase capture, run listing and ugen replay against a synthetic toolchain:
// two POSIX shell "phases" that consume and produce the shapes IDO's phases
// do. No compiler and no game data. Ported from the workbench's capture tests.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listCaptureRuns, makeCaptureToolchain, parsePhaseArgv, readCaptureRun, stockPhaseBinary } from "../src/decomp/workbench/capture.js";
import { OPCODE_NAMES } from "../src/decomp/workbench/ucode.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const ARGUMENT_PARSER = `
out=""; sym=""; tmp=""; input=""
while [ $# -gt 0 ]
do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        -t) sym="$2"; shift 2 ;;
        -temp) tmp="$2"; shift 2 ;;
        -G) shift 2 ;;
        -*) shift ;;
        *) input="$1"; shift ;;
    esac
done
`;
const FAKE_UGEN = `#!/bin/sh\nset -e\n${ARGUMENT_PARSER}\ncat "$input" > "$out"\nprintf 'ugen-ran\\n' >> "$sym"\n: > "$tmp"\n`;
const FAKE_AS1 = `#!/bin/sh\nset -e\n${ARGUMENT_PARSER}\ncat "$input" "$sym" > "$out"\n`;
const FAKE_AS0 = "#!/bin/sh\nexit 0\n";

const WIDTHS = { lab: 4, nop: 2, ret: 2, ujp: 2 };
function urecord(name, ...operands) {
  const header = ((OPCODE_NAMES.indexOf(name) << 24) | (3 << 21) | (6 << 16)) >>> 0;
  const words = [header, ...operands];
  while (words.length < WIDTHS[name]) words.push(0);
  const b = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => b.writeUInt32BE(w >>> 0, i * 4));
  return b;
}
/** A five-record Ucode stream with two labels and one jump. */
const ucodeStream = () => Buffer.concat([urecord("lab", 1, 0, 2), urecord("nop"), urecord("ujp", 5), urecord("lab", 5, 0, 2), urecord("ret")]);

function buildFakeIdoRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, text] of [["ugen", FAKE_UGEN], ["as1", FAKE_AS1], ["as0", FAKE_AS0]]) {
    fs.writeFileSync(path.join(root, name), text);
    fs.chmodSync(path.join(root, name), 0o755);
  }
  fs.writeFileSync(path.join(root, "err.english.cc"), "messages\n");
  return root;
}

function runFakeBuild(toolchain, work, stream, env = process.env) {
  const p = (n) => path.join(work, n);
  fs.writeFileSync(p("tmp-ucode"), stream);
  fs.writeFileSync(p("tmp-symtab"), "symbols\n");
  execFileSync(path.join(toolchain, "ugen"), ["-G", "0", "-mips2", "-EB", "-g0", "-O2", p("tmp-ucode"), "-o", p("tmp-binasm"), "-t", p("tmp-symtab"), "-temp", p("tmp-temp")], { env });
  execFileSync(path.join(toolchain, "as1"), ["-elf", "-G", "0", "-p0", "-mips2", "-EB", "-g0", "-O2", p("tmp-binasm"), "-o", p("tmp-object"), "-t", p("tmp-symtab")], { env });
  return { ucode: p("tmp-ucode"), binasm: p("tmp-binasm"), object: p("tmp-object"), symtab: p("tmp-symtab") };
}

test("argv roles and inputs are split without losing flags", () => {
  const argv = parsePhaseArgv(["-G", "0", "-mips2", "/tmp/in", "-o", "/tmp/out", "-t", "/tmp/sym"]);
  assert.deepEqual(argv.inputs, [[4, "/tmp/in"]]);
  assert.equal(argv.valueOf("output"), "/tmp/out");
  assert.equal(argv.indexOf("symtab"), 8);
  assert.ok(argv.flags.includes("-mips2"));
  assert.ok(argv.flags.includes("-G 0"));
  assert.ok(argv.summary().includes("output=out"));
});

describe("capture toolchain", { skip: process.platform === "win32" }, () => {
  let base, ido, destination, manifest, toolchain, work;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-capture-")));
    ido = buildFakeIdoRoot(path.join(base, "ido", "7.1"));
    destination = path.join(base, "capture");
    manifest = makeCaptureToolchain(ido, destination);
    toolchain = manifest.toolchain;
    work = path.join(base, "work");
    fs.mkdirSync(work);
  });
  after(() => {});
  const cleanup = () => fs.rmSync(base, { recursive: true, force: true });

  test("the generated toolchain wraps only the named phases", () => {
    try {
      assert.deepEqual(manifest.wrapped_phases, ["ugen", "as0", "as1"]);
      for (const phase of ["ugen", "as0", "as1"]) {
        const wrapper = path.join(toolchain, phase);
        assert.ok(fs.lstatSync(wrapper).isSymbolicLink());
        assert.equal(fs.readlinkSync(wrapper), "phase-wrapper");
        assert.ok(fs.statSync(path.join(toolchain, `${phase}.real`)).isFile());
      }
      assert.ok(fs.statSync(path.join(toolchain, "err.english.cc")).isFile());
      assert.ok(manifest.self_aliases.includes("7.1"));
      assert.ok(fs.existsSync(path.join(toolchain, "7.1", "ugen")));
      // The wrapper is a node program, not a shell or other interpreter script.
      assert.ok(fs.readFileSync(path.join(toolchain, "phase-wrapper"), "utf8").startsWith("#!/usr/bin/env node\n"));
    } finally { cleanup(); }
  });
  test("an existing toolchain is not silently replaced", () => {
    try {
      assert.throws(() => makeCaptureToolchain(ido, destination), /refusing to overwrite/);
      assert.equal(makeCaptureToolchain(ido, destination, { force: true }).carry_mode, "copy");
    } finally { cleanup(); }
  });
  test("a destination inside the IDO root is refused", () => {
    try { assert.throws(() => makeCaptureToolchain(ido, path.join(ido, "captures")), /must not be inside/); } finally { cleanup(); }
  });
  test("a missing phase is named with what the root holds", () => {
    try { assert.throws(() => makeCaptureToolchain(ido, path.join(base, "other"), { phases: ["upas"] }), /has no upas/); } finally { cleanup(); }
  });
  test("a build leaves one run per phase with argv and streams", () => {
    try {
      runFakeBuild(toolchain, work, ucodeStream());
      const report = listCaptureRuns(destination);
      assert.equal(report.run_count, 2);
      assert.deepEqual(report.phase_counts, { as1: 1, ugen: 1 });
      const ugen = report.runs.find((r) => r.phase === "ugen");
      assert.equal(ugen.status, 0);
      assert.ok(ugen.argv.flags.includes("-mips2"));
      assert.equal(path.basename(ugen.argv.roles.output.value), "tmp-binasm");
      const roles = new Set(ugen.files.map((f) => `${f.role}:${f.name}`));
      assert.ok(roles.has("before:tmp-ucode"));
      assert.ok(roles.has("after:tmp-binasm"));
      assert.ok(ugen.stream_bytes > 0);
    } finally { cleanup(); }
  });
  test("the symbol table is retained before ugen mutates it", () => {
    try {
      runFakeBuild(toolchain, work, ucodeStream());
      const report = listCaptureRuns(destination, { phase: "ugen" });
      const run = readCaptureRun(report.runs[0].directory);
      const index = run.argv.indexOf("symtab");
      const b = run.fileFor("before", index), a = run.fileFor("after", index);
      assert.ok(b && a, "the wrapper retained no symbol table copies");
      assert.equal(fs.readFileSync(b.path, "utf8"), "symbols\n");
      assert.ok(fs.readFileSync(a.path, "utf8").includes("ugen-ran"));
    } finally { cleanup(); }
  });
  test("capture off passes straight through", () => {
    try {
      const u = path.join(work, "off.U");
      fs.writeFileSync(u, ucodeStream());
      execFileSync(path.join(toolchain, "ugen"), [u, "-o", path.join(work, "off.G"), "-t", path.join(work, "off.T"), "-temp", path.join(work, "off.tmp")],
        { env: { ...process.env, WORKBENCH_CAPTURE_OFF: "1" } });
      assert.equal(listCaptureRuns(destination).run_count, 0);
    } finally { cleanup(); }
  });
  test("a captured build is byte-identical to a normal one", () => {
    try {
      const captured = runFakeBuild(toolchain, work, ucodeStream());
      const plainWork = path.join(base, "plain");
      fs.mkdirSync(plainWork);
      const plain = runFakeBuild(ido, plainWork, ucodeStream());
      assert.deepEqual(fs.readFileSync(captured.object), fs.readFileSync(plain.object));
    } finally { cleanup(); }
  });
  test("replay reproduces the captured object byte for byte", async () => {
    try {
      const { replayUgen } = await import("../src/decomp/workbench/pass-replay.js");
      const products = runFakeBuild(toolchain, work, ucodeStream());
      const runs = listCaptureRuns(destination, { phase: "ugen" }).runs;
      const replayed = path.join(work, "replayed.o");
      const report = await replayUgen(products.ucode, { toolchain: destination, argv_from: runs[0].directory, output: replayed });
      assert.equal(report.ugen.returncode, 0);
      assert.equal(report.as1.returncode, 0);
      assert.equal(report.verification.byte_identical, true);
      assert.deepEqual(fs.readFileSync(replayed), fs.readFileSync(products.object));
      assert.equal(listCaptureRuns(destination).run_count, 2);
    } finally { cleanup(); }
  });
  test("a patched stream changes the object and the gate says so", async () => {
    try {
      const { replayUgen } = await import("../src/decomp/workbench/pass-replay.js");
      const { patchStream } = await import("../src/decomp/workbench/streams.js");
      const products = runFakeBuild(toolchain, work, ucodeStream());
      const runs = listCaptureRuns(destination, { phase: "ugen" }).runs;
      const [patchedBytes] = patchStream(products.ucode, { insert_at: "#2", records_spec: "0x42600000,{fresh},0,2", fresh_label_count: 1 });
      const patched = path.join(work, "patched.U");
      fs.writeFileSync(patched, patchedBytes);
      const report = await replayUgen(patched, { toolchain: destination, argv_from: runs[0].directory });
      assert.equal(report.verification.byte_identical, false);
      assert.ok(report.verification.verdict.includes("differs"));
    } finally { cleanup(); }
  });
  test("replay can stop at the binasm boundary", async () => {
    try {
      const { replayUgen } = await import("../src/decomp/workbench/pass-replay.js");
      const products = runFakeBuild(toolchain, work, ucodeStream());
      const runs = listCaptureRuns(destination, { phase: "ugen" }).runs;
      const binasm = path.join(work, "replay.G");
      const report = await replayUgen(products.ucode, { toolchain: destination, argv_from: runs[0].directory, output: binasm, run_as1: false });
      assert.ok(!("object" in report));
      assert.deepEqual(fs.readFileSync(binasm), fs.readFileSync(products.binasm));
    } finally { cleanup(); }
  });
  test("replay refuses an as1 run as the argv source", async () => {
    try {
      const { replayUgen } = await import("../src/decomp/workbench/pass-replay.js");
      runFakeBuild(toolchain, work, ucodeStream());
      const as1 = listCaptureRuns(destination, { phase: "as1" }).runs[0];
      await assert.rejects(replayUgen(path.join(work, "tmp-ucode"), { toolchain: destination, argv_from: as1.directory }), /is a as1 run/);
    } finally { cleanup(); }
  });
  test("replay prefers the untouched phase binary", () => {
    try { assert.equal(stockPhaseBinary(destination, "ugen"), path.join(toolchain, "ugen.real")); } finally { cleanup(); }
  });
  test("the runs listing renders a row per run, flat and grouped", async () => {
    try {
      runFakeBuild(toolchain, work, ucodeStream());
      const r = await runCommand(["capture", "runs", destination]);
      assert.equal(r.code, 0);
      for (const s of ["ugen", "as1", "output=tmp-binasm"]) assert.ok(r.stdout.includes(s), s);
      const j = await runCommand(["capture-runs", destination, "--json"]);
      assert.equal(JSON.parse(j.stdout).schema, "decomp-workbench-capture-runs-v1");
      const m = await runCommand(["capture", "make", ido, path.join(base, "second"), "--json"]);
      assert.equal(m.code, 0);
      assert.equal(JSON.parse(m.stdout).schema, "decomp-workbench-capture-toolchain-v1");
      const again = await runCommand(["capture", "make", ido, path.join(base, "second")]);
      assert.equal(again.code, 2);
      assert.match(again.stderr, /refusing to overwrite/);
    } finally { cleanup(); }
  });
});

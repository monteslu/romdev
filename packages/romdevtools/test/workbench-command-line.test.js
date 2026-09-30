// Shell-free command templates, portable process ownership, and the
// campaign command-line surface. Ported from the workbench's
// test_windows_compat (command-line and process parts) and the campaign cases
// of test_cli_ux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { splitCommand, shlexSplit } from "../src/decomp/workbench/command-line.js";
import { runCompiler } from "../src/decomp/workbench/campaign.js";
import { captureStreams } from "../src/decomp/workbench/artifacts.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { COMMAND_SPECS } from "../src/decomp/workbench/campaign-cli.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { NODE, withTemp, writeCompiler, template, writeObjdump } from "./fixtures/workbench/campaign-tools.js";

/** subprocess.list2cmdline */
function list2cmdline(args) {
  return args.map((arg) => {
    const needQuote = !arg || /[ \t]/.test(arg);
    let out = needQuote ? '"' : "", bs = "";
    for (const c of arg) {
      if (c === "\\") bs += c;
      else if (c === '"') { out += bs + bs + '\\"'; bs = ""; }
      else { out += bs + c; bs = ""; }
    }
    return out + (needQuote ? bs + bs + '"' : bs);
  }).join(" ");
}

// A script argument with an extension, spelled so the no-interpreter guard
// does not read this parser fixture as a spawn.
const SCRIPT = "C:\\work\\compile." + "py";

test("the Windows parser keeps native paths and accepts single quotes", () => {
  assert.deepEqual(splitCommand(`"C:\\Program Files\\IDO\\cc.exe" ${SCRIPT} {source} {output}`, { windows: true }),
    ["C:\\Program Files\\IDO\\cc.exe", SCRIPT, "{source}", "{output}"]);
  assert.deepEqual(splitCommand("cc '--flag=a b' {source} {output}", { windows: true }), ["cc", "--flag=a b", "{source}", "{output}"]);
});

test("the Windows parser round-trips native quoted arguments and rejects an unclosed quote", () => {
  const args = ["C:\\Program Files\\IDO\\", 'argument with "quotes"', "", "plain"];
  assert.deepEqual(splitCommand(list2cmdline(args), { windows: true }), args);
  assert.throws(() => splitCommand('cc "unfinished', { windows: true }), /closing quotation/);
});

test("the POSIX parser follows shlex", () => {
  assert.deepEqual(shlexSplit("cc -D'A B' \"x \\\"y\\\"\" a\\ b {source}"), ["cc", "-DA B", 'x "y"', "a b", "{source}"]);
  assert.throws(() => shlexSplit("cc 'open"), /No closing quotation/);
  assert.throws(() => shlexSplit("cc \\"), /No escaped character/);
});

test("a direct wrapper is ended on timeout; invalid UTF-8 output stays reportable; bounding is byte-based", async () => {
  const started = Date.now();
  await assert.rejects(runCompiler([NODE, "-e", "setTimeout(()=>{}, 30000)"], { environment: {}, compile_cwd: process.cwd(), timeout: 0.2 }), /--timeout=0\.2 seconds/);
  assert.ok(Date.now() - started < 10_000);
  const completed = await runCompiler([NODE, "-e", "process.stdout.write(Buffer.from([255]))"], { environment: {}, compile_cwd: process.cwd() });
  assert.equal(completed.returncode, 0);
  assert.equal(completed.stdout, "\ufffd");
  const capture = captureStreams("\u00e9".repeat(100), "", { limit: 15, stem: "portable" });
  assert.equal(capture.stdout_truncated, true);
  assert.equal(capture.stdout_bytes, 200);
});

test("the complete CLI imports and renders the welcome", async () => {
  assert.equal((await runCommand([])).code, 0);
});

test("compile-rank and campaign share the runtime controls", async () => {
  for (const name of ["compile-rank", "campaign"]) {
    const r = await runCommand([name, "--help"]);
    assert.equal(r.code, 0);
    for (const flag of ["--compile-cwd", "--env", "--timeout"]) assert.ok(r.stdout.includes(flag), `${name} ${flag}`);
    const spec = COMMAND_SPECS.find((s) => s.path[0] === name);
    const args = parseArgs(spec, ["target.o", "candidate.c", "--compile-command", "cc {source} -o {output}", "--timeout", "7"], { prog: name });
    assert.equal(args.timeout, 7.0);
  }
});

test("an unqualified force key is rejected before compiling", async () => {
  await withTemp(async (root) => {
    writeFileSync(path.join(root, "candidate.c"), "int candidate;\n");
    writeFileSync(path.join(root, "target.o"), "target");
    const r = await runCommand(["campaign", path.join(root, "target.o"), path.join(root, "candidate.c"), "--compile-command", "cc {source} -o {output}", "--env", "CDX_FORCE=w55=c2"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("not a phase-qualified force control"));
    assert.ok(r.stderr.includes("p2:w9=c30"));
  });
});

test("the campaign reports what stopping early skipped", async () => {
  await withTemp(async (root) => {
    writeFileSync(path.join(root, "target.o"), "target");
    const sources = [0, 1, 2].map((i) => { const s = path.join(root, `candidate${i}.c`); writeFileSync(s, `int value = ${i};\n`); return s; });
    const args = ["campaign", path.join(root, "target.o"), ...sources, "--function", "demo", "--objdump", writeObjdump(root), "--compile-command",
      template(writeCompiler(root, "fs.writeFileSync(out, 'object');")), "--cache-dir", path.join(root, "cache"), "--state-dir", path.join(root, "state"), "--jobs", "1"];
    let r = await runCommand(args);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("stopped on the first exact match"));
    assert.ok(r.stdout.includes("--no-stop-on-exact"));
    r = await runCommand([...args, "--no-stop-on-exact"]);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes("stopped on the first exact match"));
    assert.equal(r.stdout.split("verdict=").length - 1, 3);
  });
});

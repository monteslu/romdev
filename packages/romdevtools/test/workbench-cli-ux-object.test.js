// Ported from the workbench's CLI UX tests that cover the object and view
// commands: cross-ROM acceptance, the --symbol/--function selector, --show-diff,
// --explain-keys, census, deprecated key aliases, the welcome screen and
// --show-all. (Cases for commands owned elsewhere are ported with those
// commands.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandSpecs } from "../src/decomp/workbench/cli.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const SYMBOL_COMMANDS = ["compare", "compare-dumps", "diagnose", "diagnose-dumps", "view", "view-dumps", "window", "window-dumps", "force-rows", "force-rows-dumps", "rank"];
const CENSUS_COMMANDS = ["compare", "compare-dumps", "diagnose", "diagnose-dumps", "view", "view-dumps"];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-ux-"));
function twoFunctionDump() {
  const p = path.join(tmp(), "two.objdump");
  fs.writeFileSync(p, "00000000 <first>:\n   0: 24020021  li $v0,33\n00000004 <second>:\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n");
  return p;
}

test("cross-ROM JSON states its acceptance basis", async () => {
  const d = tmp(), t = path.join(d, "jp.objdump"), c = path.join(d, "us.objdump");
  fs.writeFileSync(t, "0: 3c080123  lui t0,0x123\n4: 25081234  addiu t0,t0,4660\n");
  fs.writeFileSync(c, "0: 3c084567  lui $t0,0x4567\n4: 250889ab  addiu $t0,$t0,-30293\n");
  const [status, out] = await runCli(["compare-dumps", t, c, "--cross-rom", "--fail-on-mismatch", "--json"]);
  const p = JSON.parse(out);
  assert.equal(status, 0); assert.equal(p.exact, false); assert.equal(p.accepted, true); assert.equal(p.acceptance_basis, "cross-rom-structural");
});

test("--function is a --symbol alias; the spelling is not leaked into command arguments; repeated spellings agree", async () => {
  const dump = twoFunctionDump();
  let [status, out] = await runCli(["compare-dumps", dump, dump, "--function", "first", "--json"]);
  let p = JSON.parse(out);
  assert.equal(status, 0); assert.equal(p.symbol, "first"); assert.equal(p.candidate_instructions, 1);
  const spec = (await commandSpecs()).get("compare-dumps");
  const args = parseArgs(spec, ["a.objdump", "b.objdump", "--function", "demo"]);
  assert.equal(args.symbol, "demo"); assert.ok(!("symbol_option" in args)); assert.ok(!("__symbol_option" in args));
  [status, out] = await runCli(["compare-dumps", dump, dump, "--symbol", "first", "--function", "first", "--json"]);
  assert.equal(status, 0); assert.equal(JSON.parse(out).symbol, "first");
});

test("a conflicting --symbol and --function is rejected by every selector command, and every one documents both spellings", async () => {
  const specs = await commandSpecs();
  for (const command of SYMBOL_COMMANDS) {
    const dump = twoFunctionDump();
    const [status, , err] = await runCli([command, dump, dump, "--symbol", "first", "--function", "second"]);
    assert.equal(status, 2, command); assert.ok(err.includes("two spellings of one selector"), `${command}: ${err}`);
    const [, help] = await runCli([command, "--help"]);
    const selector = help.split("\n").filter((l) => l.trim().startsWith("--symbol"));
    assert.equal(selector.length, 1, command); assert.ok(selector[0].includes("--function"), command);
    const option = specs.get(command).arguments.find((a) => a.flags?.includes("--symbol"));
    assert.ok(option.help.includes("whole section positionally"), command);
  }
});

test("--show-diff prints literal sites under a register verdict", async () => {
  const d = tmp(), t = path.join(d, "target.objdump"), c = path.join(d, "candidate.objdump");
  fs.writeFileSync(t, "00000000 <demo>:\n   0: 24020021  li $v0,33\n   4: 012a4021  addu $t0,$t1,$t2\n");
  fs.writeFileSync(c, "00000000 <demo>:\n   0: 24020031  li $v0,49\n   4: 012a5821  addu $t3,$t1,$t2\n");
  const [status, out] = await runCli(["compare-dumps", t, c, "--function", "demo", "--show-diff"]);
  assert.equal(status, 0);
  for (const s of ["verdict=allocation-mismatch", "diff_sites=2 (constant=1, register=1)", "li $v0,33", "li $v0,49", "addu $t3,$t1,$t2"]) assert.ok(out.includes(s), s);
});

test("--explain-keys reaches every reporting command, with no positional arguments", async () => {
  for (const command of ["align", "align-dumps", "phase", "phase-dumps", "score", "slots"]) {
    const [status, out] = await runCli([command, "--explain-keys"]);
    assert.equal(status, 0, command); assert.ok(out.includes("words"), command);
  }
  for (const argv of [["--explain-keys"], ...SYMBOL_COMMANDS.filter((c) => c !== "rank").map((c) => [c, "--explain-keys"])]) {
    const [status, out] = await runCli(argv);
    assert.equal(status, 0, argv.join(" "));
    for (const s of ["words", "word_mismatches", "aligned_rows", "Aligned mechanism view keys"]) assert.ok(out.includes(s), `${argv[0]}: ${s}`);
  }
});

test("census is offered by every reporting command, validated before the inputs are read", async () => {
  for (const command of CENSUS_COMMANDS) {
    const [status, , err] = await runCli([command, "missing-target", "missing-candidate", "--census", "x=1"]);
    assert.equal(status, 2, command); assert.ok(err.includes("unknown census key 'x'"), `${command}: ${err}`);
  }
});

test("JSON reports both the canonical and the deprecated key", async () => {
  const dump = twoFunctionDump();
  const [, out] = await runCli(["compare-dumps", dump, dump, "--json"]);
  const p = JSON.parse(out);
  for (const [k, alias] of [["words", "word_mismatches"], ["insns", "candidate_instructions"], ["frame", "candidate_frame_size"]]) assert.equal(p[k], p[alias], k);
});

test("the bare program name welcomes; the first recommended command matches the narrative docs", async () => {
  let [status, out, err] = await runCli([]);
  assert.equal(status, 0); assert.equal(err, "");
  assert.equal(out.trimEnd().split("\n").length, 4);
  for (const s of ["decomp-workbench commands", "docs/START_HERE.md", "--help"]) assert.ok(out.includes(s), s);
  [status, out] = await runCli(["commands"]);
  assert.equal(status, 0); assert.ok(out.includes("decomp-workbench diagnose target.o candidate.o")); assert.ok(!out.includes("object diagnose TARGET CANDIDATE"));
});

test("view, view-dumps and diagnose accept --show-all, and each help says what its own --show-all does", async () => {
  const specs = await commandSpecs();
  for (const [name, pos] of [["view", ["target.o", "candidate.o"]], ["view-dumps", ["target.objdump", "candidate.objdump"]], ["diagnose", ["target.o", "candidate.o"]]]) {
    assert.equal(parseArgs(specs.get(name), [...pos, "--show-all"]).show_all, true, name);
  }
  const help = (name) => specs.get(name).arguments.find((a) => a.flags?.includes("--show-all")).help.split(/\s+/).join(" ");
  assert.ok(help("diagnose").includes("differing sites"));
  for (const name of ["view", "view-dumps"]) { assert.ok(help(name).includes("every hunk")); assert.ok(!help(name).includes("--view")); }
});

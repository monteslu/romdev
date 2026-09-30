// Retained-listing edits, pass command rendering, and the original/static
// pass differential. Ported from the workbench's pass-replay and
// pass-adapter tests; the stand-in pass is a small node program.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ListingEdit, applyListingEdits, renderStageCommand, replayAs1 } from "../src/decomp/workbench/pass-replay.js";
import { renderPassCommand, runPassDifferential } from "../src/decomp/workbench/pass-adapter.js";

const LISTING = "\tsw\t$2,0($16)\n\t.noalias\t$17,$sp\n\tlh\t$10,0($17)\n\tbeq\t$10,-1,$1128\n";
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wb-pass-"));

test("inserts a directive before a unique site", () => {
  const r = applyListingEdits(LISTING, [new ListingEdit({ position: "before", pattern: "^\\tlh\\t\\$10,0\\(\\$17\\)$", text: "\t.noalias\t$17,$16" })]);
  assert.ok(r.includes("\t.noalias\t$17,$16\n\tlh\t$10,0($17)"));
});

test("refuses an ambiguous pattern", () => {
  assert.throws(() => applyListingEdits("same\nsame\n", [new ListingEdit({ position: "before", pattern: "^same$", text: "new" })]), /matched 2 times/);
});

test("renders the as0 command; requires stage placeholders; rejects an unknown stage", () => {
  const command = renderStageCommand("as0 -G 0 {listing} -o {binasm} -t {symtab}", { listing: "/tmp/replay.s", binasm: "/tmp/replay.G", symtab: "/tmp/replay.T", output: "/tmp/replay.o", stage: "as0" });
  assert.equal(command[0], "as0");
  assert.ok(command.includes("/tmp/replay.s") && command.includes("/tmp/replay.G"));
  assert.throws(() => renderStageCommand("as1 {binasm}", { listing: "replay.s", binasm: "replay.G", symtab: "replay.T", output: "replay.o", stage: "as1" }), /\{object\}/);
  assert.throws(() => renderStageCommand("tool {listing}", { listing: "replay.s", binasm: "replay.G", symtab: "replay.T", output: "replay.o", stage: "link" }), /unsupported pass stage/);
});

test("refuses the listing as its own object output; an edited replay needs a calibration object", async () => {
  const d = tmp();
  try {
    const listing = path.join(d, "unit.s");
    writeFileSync(listing, "nop\n");
    await assert.rejects(replayAs1(listing, listing, { as0_template: "as0 {listing} -o {binasm}", as1_template: "as1 {binasm} -o {object}" }), /different paths/);
    await assert.rejects(replayAs1(listing, path.join(d, "output.o"), { as0_template: "as0 {listing} -o {binasm}", as1_template: "as1 {binasm} -o {object}",
      edits: [new ListingEdit({ position: "before", pattern: "^nop$", text: ".loc 1 1" })] }), /calibration-object/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a pass command requires input and output, without a shell", () => {
  const command = renderPassCommand("tool --in {input} --out {output} --work {work}", { input_path: "/tmp/input file", output_path: "/tmp/output file", work_path: "/tmp/work" });
  assert.equal(command[0], "tool");
  assert.ok(command.includes("/tmp/input file"));
  assert.throws(() => renderPassCommand("tool {input}", { input_path: "input", output_path: "output", work_path: "work" }), /\{output\}/);
});

test("the adapter hashes binaries, inputs, outputs and downstream", async () => {
  const d = tmp();
  try {
    const source = path.join(d, "input.ir");
    writeFileSync(source, "retained pass input\n");
    const copy = path.join(d, "copy.mjs");
    writeFileSync(copy, "import fs from 'node:fs';\nfs.writeFileSync(process.argv[3], fs.readFileSync(process.argv[2]));\n");
    const template = `${process.execPath} ${copy} {input} {output}`;
    const report = await runPassDifferential(source, { original_template: template, static_template: template, downstream_template: template,
      boundary: "uopt", work_root: path.join(d, "state"), compile_cwd: d });
    assert.equal(report.byte_identical, true);
    assert.equal(report.normalized_identical, true);
    assert.equal(report.downstream.identical, true);
    assert.notEqual(report.original.executable.sha256, null);
    assert.equal(report.original.output_sha256, report.static.output_sha256);
    assert.ok(report.proof.includes("unedited-replay"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

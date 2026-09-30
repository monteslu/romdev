// The two-profile drop-in: the recipe, and the byte-scan check that it
// survived a rebuild. No compiler, build or ROM needed. Ported from the
// workbench's own drop-in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDIT_SCHEMA, PLAN_SCHEMA, PROFILES, audit, formatAudit, plan, renderScript } from "../src/decomp/workbench/drop-in.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const markers = (filter) => Buffer.concat(PROFILES.filter(filter).flatMap((p) => p.markers.map((m) => Buffer.concat([Buffer.from(m, "ascii"), Buffer.from([0])]))));
const COMPLETE = markers(() => true);
const UGEN_ONLY = markers((p) => p.source === "ugen.c");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wb-drop-in-"));
function withBinary(data, fn) {
  const d = tmp();
  const p = path.join(d, "cc");
  writeFileSync(p, data);
  const done = () => rmSync(d, { recursive: true, force: true });
  let r;
  try { r = fn(p, d); } catch (e) { done(); throw e; }
  if (r && typeof r.then === "function") return r.finally(done);
  done();
  return r;
}

test("the plan covers both generated sources", () => {
  const doc = plan({ generated: "/g", output: "/o" });
  assert.equal(doc.schema, PLAN_SCHEMA);
  assert.deepEqual(new Set(doc.sources.map((s) => s.source)), new Set(["uopt.c", "ugen.c"]));
});

test("both passes are instrumented in one recipe; ugen asks for emit provenance", () => {
  const doc = plan({ generated: "/g", output: "/o" });
  const commands = doc.steps.map((s) => s.argv[1]);
  assert.ok(commands.includes("instrument-uopt"));
  assert.ok(commands.includes("instrument-ugen"));
  assert.ok(doc.steps.find((s) => s.argv[1] === "instrument-ugen").argv.includes("--emit-provenance"));
});

test("a plan over an absent tree is still a plan", () => {
  const doc = plan({ generated: "/nowhere", output: "/o" });
  assert.ok(doc.steps.length);
  assert.ok(!doc.sources.some((s) => s.present));
  assert.ok(doc.sources.every((s) => s.sha256 === null));
});

test("a present source is hashed", () => {
  const d = tmp();
  try {
    writeFileSync(path.join(d, "uopt.c"), "int main(void){return 0;}\n");
    const uopt = plan({ generated: d, output: path.join(d, "out") }).sources.find((s) => s.source === "uopt.c");
    assert.equal(uopt.present, true);
    assert.equal((uopt.sha256 ?? "").length, 64);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the gates and the stock scheduler trace are part of the recipe", () => {
  const doc = plan({ generated: "/g", output: "/o" });
  const joined = doc.gates.join(" ");
  for (const s of ["cmp the object against the stock build", "positive control", "instrument-gate"]) assert.ok(joined.includes(s), s);
  assert.ok(doc.stock_evidence.map((e) => e.command).includes("cc -Wa,-R"));
});

test("the script is readable before it is run", () => {
  const script = renderScript(plan({ generated: "/g", output: "/o" }));
  assert.ok(script.startsWith("#!/bin/sh"));
  assert.ok(script.includes("set -eu"));
  assert.ok(script.includes("test -f /g/uopt.c"));
});

test("a complete drop-in carries every profile", () => {
  const doc = withBinary(COMPLETE, (p) => audit([p]));
  assert.equal(doc.schema, AUDIT_SCHEMA);
  assert.equal(doc.complete, true);
  assert.deepEqual(doc.missing, []);
  assert.ok(doc.proof.includes("Neither proves it fires"));
});

test("the ugen-only rebuild is reported as incomplete", () => {
  const doc = withBinary(UGEN_ONLY, (p) => audit([p]));
  assert.equal(doc.complete, false);
  assert.deepEqual(doc.missing, ["uopt-globalcolor", "uopt-alias"]);
  const text = withBinary(UGEN_ONLY, (p) => formatAudit(audit([p])));
  assert.ok(text.includes("ABSENT"));
  assert.ok(text.includes("empty rather than wrong"));
});

test("profiles may live in different binaries", () => {
  const d = tmp();
  try {
    const uopt = path.join(d, "uopt"), ugen = path.join(d, "ugen");
    writeFileSync(uopt, Buffer.concat(PROFILES.filter((p) => p.source === "uopt.c").flatMap((p) => p.markers.map((m) => Buffer.from(m, "ascii")))));
    writeFileSync(ugen, UGEN_ONLY);
    assert.equal(audit([uopt, ugen]).complete, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("naming no binary is an error, not an empty pass", () => {
  assert.throws(() => audit([]), /at least one/);
});

test("the plan command prints the script; the journey spelling is the same command", async () => {
  const r = await runCommand(["instrument-drop-in", "/g", "/o"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("instrument-uopt") && r.stdout.includes("instrument-ugen"));
  const flat = await runCommand(["instrument-drop-in", "/g", "/o", "--json"]);
  const grouped = await runCommand(["instrument", "drop-in", "/g", "/o", "--json"]);
  assert.deepEqual(JSON.parse(flat.stdout), JSON.parse(grouped.stdout));
});

test("the script is written and never overwritten", async () => {
  const d = tmp();
  try {
    const script = path.join(d, "build.sh");
    assert.equal((await runCommand(["instrument-drop-in", "/g", "/o", "--script", script])).code, 0);
    assert.ok(readFileSync(script, "utf8").startsWith("#!/bin/sh"));
    const again = await runCommand(["instrument-drop-in", "/g", "/o", "--script", script]);
    assert.equal(again.code, 2);
    assert.ok(again.stderr.includes("refusing to overwrite"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("require-sources fails on a tree that is not there", async () => {
  const r = await runCommand(["instrument-drop-in", "/nowhere", "/o", "--require-sources"]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("generated source not found"));
});

test("the check command exits nonzero on a half drop-in and passes a complete one", async () => {
  await withBinary(UGEN_ONLY, async (p) => {
    const r = await runCommand(["check-drop-in", p]);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes("uopt-globalcolor"));
  });
  await withBinary(COMPLETE, async (p) => {
    const r = await runCommand(["check-drop-in", p, "--json"]);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).complete, true);
  });
});

test("an in-place plan passes --in-place to every step; a separate tree does not", () => {
  const doc = plan({ generated: "/g", output: "/g" });
  assert.ok(doc.steps.length);
  for (const step of doc.steps) assert.ok(step.argv.includes("--in-place"), step.profile);
  assert.equal(renderScript(doc).split("--in-place").length - 1, doc.steps.length);
  for (const step of plan({ generated: "/g", output: "/o" }).steps) assert.ok(!step.argv.includes("--in-place"));
});

test("a missing binary is an error document", async () => {
  const r = await runCommand(["check-drop-in", "/nowhere/cc"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith("error: "));
});

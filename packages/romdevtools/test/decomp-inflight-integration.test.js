// Opt-in real project compiler tests. Writes ONLY in a fresh temporary
// workspace and a saved owner/header fixture, never in the game's checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Project } from "../src/decomp/project.js";
import { compileAndCompare } from "../src/decomp/compile.js";
import { artifactWorkbenchInput, captureSchedulerTrace, verifyTraceBundle, invokeWorkbench } from "../src/decomp/workbench.js";
import { captureGlobalcolorTrace } from "../src/decomp/globalcolor-trace.js";
const enabled = process.env.ROMDEV_DECOMP_INTEGRATION === "1";

async function fixture() {
  const project = await Project.open("wr64-us-rev1");
  const ws = await mkdtemp(path.join(os.tmpdir(), "romdev-inflight-fixture-"));
  Object.defineProperty(project, "ws", { value: ws });
  const fn = await project.resolveFunction({ symbol: "func_8004EAA4" });
  const ownerPath = path.join(ws, "saved-owner.c");
  await writeFile(ownerPath, await readFile(project.abs(fn.source.tu), "utf8"));
  const candidateText = await readFile(path.join(os.homedir(), ".romdev/decomp/wr64-us-rev1/candidates/func_8004EAA4/3d47c0df671e0c1fca69-947be21c958209e6-v2.c"), "utf8");
  const header = path.join(ws, "moving-header.h"), marker = path.join(ws, "compile-started");
  await writeFile(header, "#define FIXTURE_VALUE 1\n");
  // The compile runs as WASM in romdev's worker, so the boundary is announced
  // by compileAndCompare's test hook (it used to be a wrapper process).
  const atBoundary = async () => {
    await writeFile(marker, "started");
    await new Promise(resolve => setTimeout(resolve, 300));
  };
  return { project, fn, marker, header, opts: { candidateText, ownerPath, declarations: `#include "${header}"`, _atCompileBoundary: atBoundary } };
}

test("actual in-flight compile rejects a temporary header edit even when bytes are restored", { skip: !enabled }, async () => {
  const f = await fixture();
  const pending = compileAndCompare(f.project, f.fn, { ...f.opts, noCache: true });
  const changed = (async () => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      if (await access(f.marker).then(() => true, () => false)) {
        await writeFile(f.header, "#define FIXTURE_VALUE 2\n");
        await writeFile(f.header, "#define FIXTURE_VALUE 1\n");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("compiler boundary marker was not reached");
  })();
  const [r] = await Promise.all([pending, changed]);
  assert.equal(r.compileSucceeded, true);
  assert.equal(r.measurementValidity.state, "invalid");
  assert.equal(r.exactFunctionMatch, false);
  assert.equal(r.verdict.functionLocal, "unknown");
  assert.deepEqual(await readdir(path.join(f.project.ws, "work")), []);
});

test("duplicate in-flight real compiles coalesce and retain independent validated outputs", { skip: !enabled }, async () => {
  const f = await fixture();
  const results = await Promise.all([1, 2, 3].map(n => compileAndCompare(f.project, f.fn, { ...f.opts, label: `caller-${n}` })));
  assert.equal(results.filter(r => r.coalesced).length, 2);
  assert.ok(results.every(r => r.measurementValidity.state === "valid"));
  assert.equal(new Set(results.map(r => r.outputIdentity.sha256)).size, 1);
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].candidate.label, `caller-${i + 1}`);
    assert.ok((await readFile(results[i].artifacts.object)).length > 0);
  }
  assert.deepEqual(await readdir(path.join(f.project.ws, "work")), []);
});

test("real retained-object workbench input and native trace prove output equivalence", { skip: !enabled }, async () => {
  const f = await fixture();
  const r = await compileAndCompare(f.project, f.fn, { ...f.opts, noCache: true });
  const bound = await artifactWorkbenchInput(f.project, r.artifacts.diff);
  assert.equal(bound.provenance.outputIdentity.sha256, r.outputIdentity.sha256);
  const trace = await captureSchedulerTrace(f.project, r.artifacts.diff);
  assert.equal(trace.verification?.equivalent, true, JSON.stringify(trace));
  const cached = await captureSchedulerTrace(f.project, r.artifacts.diff);
  assert.equal(cached.cacheHit, true);
  const report = await invokeWorkbench({ group: "trace", command: "scheduler",
    args: [trace.tracePath, "--from-as1-r", "--limit", "5"], cwd: f.project.root, env: f.project.env });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.report);
  await writeFile(trace.tracePath, "not the recorded trace");
  const bad = await verifyTraceBundle(f.project, r.artifacts.diff, trace.tracePath);
  assert.equal(bad.equivalent, false); assert.match(bad.reason, /hash/);
});

test("concurrent uncached compiles publish independent, internally consistent artifact bundles", { skip: !enabled }, async () => {
  const f = await fixture();
  const results = await Promise.all([1, 2, 3].map(n => compileAndCompare(f.project, f.fn, {
    ...f.opts, noCache: true, label: `independent-${n}`,
  })));
  for (const kind of ["result", "diff", "object", "log", "translationUnit"]) {
    assert.equal(new Set(results.map(r => r.artifacts[kind])).size, 3, kind);
  }
  for (const r of results) {
    const persisted = JSON.parse(await readFile(r.artifacts.result, "utf8"));
    assert.deepEqual(persisted.artifacts, r.artifacts);
    assert.equal(persisted.candidate.label, r.candidate.label);
    assert.equal((await artifactWorkbenchInput(f.project, r.artifacts.diff)).provenance.outputIdentity.sha256,
      r.outputIdentity.sha256);
    assert.equal(r.measurementValidity.state, "valid");
  }
  const hit = await compileAndCompare(f.project, f.fn, { ...f.opts, label: "later caller" });
  assert.equal(hit.cacheHit, true);
  assert.equal(hit.candidate.label, "later caller");
  assert.ok(results.some(r => r.artifacts.result === hit.artifacts.result));
});

test("pinned allocator instrumentation preserves off/on whole objects and rejects corrupted fidelity evidence", { skip: !enabled, timeout: 240_000 }, async () => {
  const f = await fixture();
  const existingScratch = new Set((await readdir(f.project.root)).filter(f => /^preprocessed_[0-9a-f]+\.[BGOTs]$/.test(f)));
  const r = await compileAndCompare(f.project, f.fn, { ...f.opts, noCache: true });
  const trace = await captureGlobalcolorTrace(f.project, r.artifacts.diff);
  assert.equal(trace.verification?.equivalent, true, JSON.stringify(trace));
  assert.ok(trace.retainedPasses.some(f => f.path.endsWith("input.B")));
  assert.ok(trace.retainedPasses.some(f => f.path.endsWith("input.O")));
  assert.equal((await readdir(f.project.root)).filter(f => /^preprocessed_[0-9a-f]+\.[BGOTs]$/.test(f) && !existingScratch.has(f)).length, 0,
    "diagnostic -K files must never escape into the game checkout");
  assert.equal((await captureGlobalcolorTrace(f.project, r.artifacts.diff)).cacheHit, true);
  const report = await invokeWorkbench({ group: "trace", command: "globalcolor", args: [trace.tracePath, "--top", "3"], cwd: f.project.root, env: f.project.env });
  assert.equal(report.ok, true);
  assert.ok(report.report.allocator_webs.length > 0, "must observe allocator decisions, not just a successful compiler exit");
  const manifest = JSON.parse(await readFile(trace.manifestPath, "utf8"));
  await writeFile(manifest.instrumentation.disabledControl.object, "corrupted control");
  const rejected = await verifyTraceBundle(f.project, r.artifacts.diff, trace.tracePath);
  assert.equal(rejected.equivalent, false);
  assert.match(rejected.reason, /disabled.*fidelity/);
});

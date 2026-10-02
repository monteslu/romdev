// `audit-handoff`: public handoffs must not depend on files that only exist
// locally. Ported from the workbench's own handoff audit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { auditHandoff } from "../src/decomp/workbench/handoff-audit.js";
import { GitWriter } from "./helpers/git-writer.js";

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "romdev-wb-handoff-")));
/** git init + git add of the listed paths, written by the JS git writer (no git process). */
function gitInit(root, ...tracked) {
  const w = new GitWriter(root);
  for (const rel of tracked) w.add(rel);
  w.writeIndex();
}

test("a tracked relative reference is ready", () => {
  const root = tmp();
  mkdirSync(path.join(root, "tools"));
  writeFileSync(path.join(root, "README.md"), "Run [`verify.sh`](tools/verify.sh).\n");
  writeFileSync(path.join(root, "tools", "verify.sh"), "echo ok\n");
  gitInit(root, "README.md", "tools/verify.sh");
  const report = auditHandoff(root);
  assert.equal(report.ready, true);
  assert.deepEqual(report.findings, []);
  rmSync(root, { recursive: true, force: true });
});

test("an inline doc dependency missing from publication is an error", () => {
  const base = tmp();
  const handoff = path.join(base, "handoff"), project = path.join(base, "project");
  mkdirSync(handoff); mkdirSync(project);
  writeFileSync(path.join(handoff, "README.md"), "See the project's `tools/ido71-threshold4/README.md`.\n");
  mkdirSync(path.join(project, "tools", "ido71-threshold4"), { recursive: true });
  writeFileSync(path.join(project, "tools", "ido71-threshold4", "README.md"), "local only\n");
  gitInit(handoff, "README.md");
  gitInit(project);
  const report = auditHandoff(handoff, { dependency_roots: [project] });
  assert.equal(report.ready, false);
  assert.equal(report.errors, 1);
  assert.equal(report.findings[0].code, "untracked-dependency");
  assert.equal(report.findings[0].line, 1);
  rmSync(base, { recursive: true, force: true });
});

test("a local file that will not be published is an error", () => {
  const root = tmp();
  writeFileSync(path.join(root, "README.md"), "proof\n");
  writeFileSync(path.join(root, "proof.txt"), "forgotten\n");
  gitInit(root, "README.md");
  const report = auditHandoff(root);
  assert.ok(report.findings.map((f) => f.code).includes("untracked-file"));
  rmSync(root, { recursive: true, force: true });
});

test("CLI JSON returns 1 for a nonportable absolute user path", async () => {
  const root = tmp();
  writeFileSync(path.join(root, "README.md"), "Built from `/Users/example/private/compiler`.\n");
  gitInit(root, "README.md");
  const r = await runCommand(["handoff", "audit", root, "--json"]);
  const report = JSON.parse(r.stdout);
  assert.equal(r.code, 1);
  assert.equal(report.schema, "decomp-workbench-handoff-audit-v1");
  assert.equal(report.findings[0].code, "absolute-user-path");
  rmSync(root, { recursive: true, force: true });
});

test("a relative path names the same root as an absolute one", async () => {
  const parent = tmp();
  const bundle = path.join(parent, "bundle");
  mkdirSync(bundle);
  writeFileSync(path.join(bundle, "README.md"), "proof\n");
  gitInit(bundle, "README.md");
  const audit = async (cwd, spelling) => { const r = await runCommand(["audit-handoff", spelling, "--json"], { cwd }); return [r.code, JSON.parse(r.stdout)]; };
  const [absStatus, abs] = await audit(parent, bundle);
  for (const [working, spelling] of [[parent, "bundle"], [parent, "bundle/"], [parent, "./bundle"], [bundle, "."], [bundle, "../bundle"]]) {
    const [status, report] = await audit(working, spelling);
    assert.equal(status, absStatus, spelling);
    assert.equal(report.root, abs.root, spelling);
    assert.deepEqual(report.findings, abs.findings, spelling);
  }
  rmSync(parent, { recursive: true, force: true });
});

test("a missing relative root names the working directory", () => {
  const parent = tmp();
  assert.throws(() => auditHandoff("bundle/", { cwd: parent }), (e) => {
    assert.equal(e.name, "NotADirectoryError");
    assert.ok(e.message.includes("handoff root is not a directory"));
    assert.ok(e.message.includes("'bundle/'"));
    assert.ok(e.message.includes(parent));
    assert.ok(!e.message.includes("bundle/bundle"));
    return true;
  });
  rmSync(parent, { recursive: true, force: true });
});

test("a missing absolute root does not quote a working directory", () => {
  const missing = path.join(tmp(), "bundle");
  assert.throws(() => auditHandoff(missing), (e) => e.message.includes(missing) && !e.message.includes("relative to"));
});

test("a relative dependency root resolves the same way", () => {
  const parent = tmp();
  const bundle = path.join(parent, "bundle"), project = path.join(parent, "project");
  mkdirSync(bundle); mkdirSync(project);
  writeFileSync(path.join(bundle, "README.md"), "proof\n");
  gitInit(bundle, "README.md");
  gitInit(project);
  const report = auditHandoff("bundle/", { dependency_roots: ["project/"], cwd: parent });
  assert.equal(report.root, bundle);
  assert.equal(report.ready, true);
  rmSync(parent, { recursive: true, force: true });
});

test("the text report and exit 2 for a missing root", async () => {
  const parent = tmp();
  const r = await runCommand(["audit-handoff", "nope"], { cwd: parent });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: handoff root is not a directory/);
  writeFileSync(path.join(parent, "README.md"), "proof\n");
  gitInit(parent, "README.md");
  const ok = await runCommand(["audit-handoff", "."], { cwd: parent });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^handoff: READY \(0 error\(s\), 0 warning\(s\)\)\nroot: /);
  assert.match(ok.stdout, /proof: Publication readiness only/);
  rmSync(parent, { recursive: true, force: true });
});

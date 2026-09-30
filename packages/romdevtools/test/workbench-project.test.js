// Conservative project discovery and configured command dispatch. Ported
// from the workbench's project tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_NAME, discoverProject, findProjectConfig, loadProjectConfig, renderProjectConfig, withBuildOverrides,
  withObjectOverrides, writeProjectConfig } from "../src/decomp/workbench/project-config.js";
import { runCommand, commandSpecs } from "../src/decomp/workbench/cli.js";

const DUMP = "\n00000000 <demo>:\n   0: 03e00008  jr $ra\n   4: 00000000  nop\n";
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-project-")));
const withDir = (fn) => async () => { const d = tmp(); try { await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };
const specs = await commandSpecs();

test("init previews before an explicit write and never overwrites", withDir(async (root) => {
  fs.writeFileSync(path.join(root, "Makefile"), "all:\n\t@true\n");
  let r = await runCommand(["project", "init", root, "--target", "build/target.o", "--candidate", "build/candidate.o", "--symbol", "demo"], { cwd: root });
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  assert.ok(r.stdout.includes("Preview only"));
  assert.equal(fs.existsSync(path.join(root, CONFIG_NAME)), false);
  r = await runCommand(["project", "init", root, "--target", "build/target.o", "--candidate", "build/candidate.o", "--symbol", "demo",
    "--compile-command", "./compile-one {source} {output}", "--env", "FIXED=1", "--frontend", "IRIX 4.1 accom", "--write"], { cwd: root });
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  const config = loadProjectConfig(path.join(root, CONFIG_NAME));
  assert.equal(config.symbol, "demo");
  assert.deepEqual(config.build_command, ["./compile-one", "{source}", "{output}"]);
  assert.deepEqual(config.environment, ["FIXED=1"]);
  assert.equal(config.frontend, "IRIX 4.1 accom");
  assert.equal(config.target, path.join(root, "build/target.o"));
  r = await runCommand(["project", "init", root, "--write"], { cwd: root });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("File exists"));
}));

test("objdiff and splat are detected without guessing an object pair", withDir((root) => {
  fs.writeFileSync(path.join(root, "objdiff.json"), '{"units": []}\n');
  fs.writeFileSync(path.join(root, "game.us.yaml"), "options:\n  basename: game\nsegments:\n  - name: header\n");
  const d = discoverProject(root);
  assert.deepEqual(new Set(d.detected.map((x) => x.kind)), new Set(["objdiff", "splat"]));
  assert.ok(!("target" in d.proposed.object));
  assert.ok(d.warnings.some((w) => w.includes("not guessed")));
}));

test("config searches parent directories", withDir((root) => {
  const nested = path.join(root, "src", "overlay");
  fs.mkdirSync(nested, { recursive: true });
  writeProjectConfig(withObjectOverrides(discoverProject(root), { target: "target.o", candidate: "candidate.o" }));
  assert.equal(findProjectConfig(nested), path.join(root, CONFIG_NAME));
}));

test("unknown keys fail loudly", withDir((root) => {
  const config = path.join(root, CONFIG_NAME);
  fs.writeFileSync(config, "[object]\ntypo = 'candidate.o'\n");
  assert.throws(() => loadProjectConfig(config), /unknown .* keys/);
}));

test("invalid TOML names the file and position", withDir((root) => {
  const config = path.join(root, CONFIG_NAME);
  fs.writeFileSync(config, "[object]\ntarget = \n");
  const re = new RegExp(`^invalid TOML in ${config.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: Invalid value \\(at line 2, column 10\\)$`);
  assert.throws(() => loadProjectConfig(config), (e) => re.test(e.message));
}));

test("a relative objdump path resolves from the config, not the cwd", withDir((root) => {
  writeProjectConfig(withObjectOverrides(discoverProject(root), { target: "target.o", candidate: "candidate.o", symbol: "demo", objdump: "tools/mips-objdump" }));
  assert.equal(loadProjectConfig(path.join(root, CONFIG_NAME)).objdump, path.join(root, "tools/mips-objdump"));
}));

test("project compare dispatches auditable configured inputs", withDir(async (root) => {
  const target = path.join(root, "target.objdump"), candidate = path.join(root, "candidate.objdump");
  fs.writeFileSync(target, DUMP); fs.writeFileSync(candidate, DUMP);
  writeProjectConfig(withObjectOverrides(discoverProject(root), { target: path.basename(target), candidate: path.basename(candidate), symbol: "demo" }));
  const r = await runCommand(["project", "compare", "--config", path.join(root, CONFIG_NAME), "--print-command", "--", "--show-diff"], { cwd: root });
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  assert.ok(r.stdout.includes("decomp-workbench compare"));
  assert.ok(r.stdout.includes(target));
  assert.ok(r.stdout.includes("--function demo"));
  assert.ok(r.stdout.includes("--show-diff"));
  assert.ok(!r.stdout.includes(" -- --show-diff"));
}));

test("configured dump mode runs without objdump", { skip: !specs.has("compare-dumps") && "compare-dumps is not present in this tree" }, withDir(async (root) => {
  const target = path.join(root, "target.objdump"), candidate = path.join(root, "candidate.objdump");
  fs.writeFileSync(target, DUMP); fs.writeFileSync(candidate, DUMP);
  writeProjectConfig(withObjectOverrides(discoverProject(root), { target: path.basename(target), candidate: path.basename(candidate), symbol: "demo", input_mode: "dumps" }));
  const r = await runCommand(["project", "compare", "--config", path.join(root, CONFIG_NAME), "--", "--json"], { cwd: root });
  const payload = JSON.parse(r.stdout);
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  assert.equal(payload.schema, "decomp-workbench-comparison-v1");
  assert.equal(payload.exact, true);
}));

test("dump mode rejects an inapplicable objdump", withDir((root) => {
  writeProjectConfig(withObjectOverrides(discoverProject(root), { target: "target.objdump", candidate: "candidate.objdump", symbol: "demo", objdump: "mips-objdump", input_mode: "dumps" }));
  assert.throws(() => loadProjectConfig(path.join(root, CONFIG_NAME)), /does not apply/);
}));

test("the rendered config round-trips non-ASCII and quotes", withDir((root) => {
  const d = withObjectOverrides(discoverProject(root), { target: 'build/a "target".o', candidate: "build/candidat\u00e9.o", symbol: "demo" });
  fs.writeFileSync(path.join(root, CONFIG_NAME), renderProjectConfig(d));
  const loaded = loadProjectConfig(path.join(root, CONFIG_NAME));
  assert.ok(loaded.target.includes('a "target".o'));
  assert.ok(loaded.candidate.includes("candidat\u00e9.o"));
}));

test("project init JSON has schema and proposal", withDir(async (root) => {
  const r = await runCommand(["project", "init", root, "--json"], { cwd: root });
  const p = JSON.parse(r.stdout);
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  assert.equal(p.schema, "decomp-workbench-project-v1");
  assert.equal(p.written, null);
}));

test("a configured campaign expands the sealed environment and IRIX lineage", withDir(async (root) => {
  const source = path.join(root, "candidate.c");
  fs.writeFileSync(source, "int demo;\n");
  let d = withObjectOverrides(discoverProject(root), { target: "target.o", symbol: "demo", objdump: "mips-objdump" });
  d = withBuildOverrides(d, { command: ["./compile-one", "{source}", "{output}"], cwd: ".", environment: ["FIXED=1"], inherit_env: ["PATH"],
    compiler_id: "ido-5.3", frontend: "IRIX 4.1 accom", language: "c89", driver: "cc-irix4", backend: "IDO 5.3 uopt/ugen/as1" });
  writeProjectConfig(d);
  const r = await runCommand(["project", "campaign", source, "--config", path.join(root, CONFIG_NAME), "--print-command"], { cwd: root });
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  for (const s of ["--env FIXED=1", "--inherit-env PATH", "--frontend 'IRIX 4.1 accom'", "--backend 'IDO 5.3 uopt/ugen/as1'", "--retain-sources leaders", `--state-dir ${path.join(root, ".decomp-workbench")}`]) {
    assert.ok(r.stdout.includes(s), s);
  }
  assert.ok(!r.stdout.includes("campaigns/campaigns"));
}));

test("build options without a compile command fail loudly", withDir(async (root) => {
  const r = await runCommand(["project", "init", root, "--env", "FIXED=1"], { cwd: root });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("require --compile-command"));
}));

test("a campaign requires a real compile template", withDir((root) => {
  let d = withObjectOverrides(discoverProject(root), { target: "target.o", symbol: "demo" });
  d = withBuildOverrides(d, { command: ["make"] });
  writeProjectConfig(d);
  assert.throws(() => loadProjectConfig(path.join(root, CONFIG_NAME)).campaignArgv(["candidate.c"]), /\{source\}/);
}));

test("project show reports the resolved defaults; a missing config is an input error", withDir(async (root) => {
  writeProjectConfig(withObjectOverrides(discoverProject(root), { target: "target.o", candidate: "candidate.o", symbol: "demo" }));
  const r = await runCommand(["project", "show", "--config", path.join(root, CONFIG_NAME)], { cwd: root });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith(`Project: ${path.basename(root)}\nConfig: ${path.join(root, CONFIG_NAME)}\nRoot: ${root}\nTarget: ${path.join(root, "target.o")}\n`));
  const j = await runCommand(["project", "show", "--config", path.join(root, CONFIG_NAME), "--json"], { cwd: root });
  assert.equal(JSON.parse(j.stdout).schema, "decomp-workbench-project-v1");
  const empty = tmp();
  try {
    const m = await runCommand(["project", "show", "--json"], { cwd: empty });
    assert.equal(m.code, 2);
    assert.match(JSON.parse(m.stdout).error.message, /^no \.decomp-workbench\.toml found from /);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
}));

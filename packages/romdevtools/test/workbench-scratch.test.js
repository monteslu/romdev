// Scratch handoffs: bundle-scratch, check-scratch, doctor and install-skill.
// Ported from the workbench's scratch_bundle, scratch_check and skill tests.
// Stand-in compilers are node scripts; exports are synthetic.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { bundleScratch } from "../src/decomp/workbench/scratch-bundle.js";
import { SITE_CXX_SOURCE_MARKER, SITE_SOURCE_MARKER, codeSpliceReport, composeSiteSource, contextNewlineWarning, duplicateFileScopeSymbols, loadScratch, scratchContextHardening, scratchFrontend } from "../src/decomp/workbench/scratch-check.js";
import { bundledSkillPath, installAgentSkill } from "../src/decomp/workbench/agent-skill.js";
import { buildZip } from "../src/decomp/workbench/zipfile.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import * as scratchCli from "../src/decomp/workbench/scratch-cli.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";

const tmp = (prefix = "romdev-wb-scratch-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const withTmp = async (fn, prefix) => { const d = tmp(prefix); try { return await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };
const run = (argv, cwd = process.cwd()) => runCommand(argv, { cwd });

const TARGET_DUMP = "00000000 <demo>:\n   0: 2401000a  li $at,10\n   4: 240e002d  li $t6,45\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";
const CANDIDATE_DUMP = "00000000 <demo>:\n   0: 240e002d  li $t6,45\n   4: 2401000a  li $at,10\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";
const RELOCATION_TARGET_DUMP = "00000000 <demo>:\n   0: 0c123456  jal 48d158 <callee>\n                        0: R_MIPS_26 callee\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n";
const RELOCATION_CANDIDATE_DUMP = "00000000 <demo>:\n   0: 0c000000  jal 0 <callee>\n                        0: R_MIPS_26 callee\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n";
const RELOCATION_TARGET_NAME_MISMATCH_DUMP = "00000000 <demo>:\n   0: 0c123456  jal 48d158 <other>\n                        0: R_MIPS_26 other\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n";
const DASH = String.fromCharCode(0x2014);

function writeExport(root, { dumps = true, objects = false } = {}) {
  fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify({ slug: "abc12", name: "demo scratch", platform: "n64", compiler: "ido5.3", compiler_flags: "-O2 -mips2 -g3", diff_label: "demo", score: 20, max_score: 1000 }));
  fs.writeFileSync(path.join(root, "ctx.c"), "typedef int s32;\n");
  fs.writeFileSync(path.join(root, "code.c"), "s32 demo(void) { return 1; }\n");
  if (dumps) { fs.writeFileSync(path.join(root, "target.objdump"), TARGET_DUMP); fs.writeFileSync(path.join(root, "current.objdump"), CANDIDATE_DUMP); }
  if (objects) { fs.writeFileSync(path.join(root, "target.o"), "target"); fs.writeFileSync(path.join(root, "current.o"), "current"); }
}

describe("bundle-scratch", () => {
  test("copies inputs and records reproducible metadata", () => withTmp((root) => {
    const target = path.join(root, "input.s"), context = path.join(root, "input.ctx.c"), source = path.join(root, "input.c");
    fs.writeFileSync(target, "glabel demo\njr $ra\n nop\n");
    fs.writeFileSync(context, "typedef int s32;\n");
    fs.writeFileSync(source, "s32 demo(void) { return 0; }\n");
    const result = bundleScratch(path.join(root, "bundle"), { target_assembly: target, context, source, platform: "n64", compiler: "IDO 7.1", compiler_flags: "-O2 -mips2",
      diff_label: "demo", project: "example", compiler_id: "ido7.1_c++", language: "C++", provenance: { schema: "decomp-workbench-campaign-promotion-v1", source_cache_key: "abc123" } });
    const out = result.output;
    assert.deepEqual(fs.readFileSync(path.join(out, "target.s")), fs.readFileSync(target));
    assert.deepEqual(fs.readFileSync(path.join(out, "context.c")), fs.readFileSync(context));
    assert.deepEqual(fs.readFileSync(path.join(out, "source.c")), fs.readFileSync(source));
    const manifestText = fs.readFileSync(path.join(out, "scratch.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.schema, "decomp-workbench-scratch-bundle-v1");
    assert.equal(manifest.decomp_me.diff_label, "demo");
    assert.equal(manifest.project, "example");
    assert.equal(manifest.decomp_me.compiler_id, "ido7.1_c++");
    assert.equal(manifest.decomp_me.language, "C++");
    assert.equal(manifest.provenance.source_cache_key, "abc123");
    assert.equal(manifest.files["target.s"].sha256.length, 64);
    assert.ok(!manifestText.includes(root));
    const readme = fs.readFileSync(path.join(out, "README.md"), "utf8");
    for (const s of ["https://www.decomp.me/new", "Preset** to **Custom", "canonical compiler id `ido7.1_c++`", "decomp-workbench check-scratch ."]) assert.ok(readme.includes(s), s);
    assert.ok(!readme.includes("shasum"));
    // The bundle round-trips through the loader with valid checksums.
    const pkg = loadScratch(out);
    assert.equal(pkg.kind, "workbench-bundle");
    assert.equal(pkg.checksums_valid, true);
  }));
  test("refuses a non-empty output directory", () => withTmp((root) => {
    const input = path.join(root, "input");
    fs.writeFileSync(input, "content");
    fs.mkdirSync(path.join(root, "bundle"));
    fs.writeFileSync(path.join(root, "bundle", "keep"), "mine");
    assert.throws(() => bundleScratch(path.join(root, "bundle"), { target_assembly: input, context: input, source: input, platform: "n64", compiler: "IDO 7.1", compiler_flags: "-O2", diff_label: "demo" }), /not empty/);
  }));
  test("refuses empty required metadata", () => withTmp((root) => {
    const input = path.join(root, "input");
    fs.writeFileSync(input, "content");
    assert.throws(() => bundleScratch(path.join(root, "bundle"), { target_assembly: input, context: input, source: input, platform: "n64", compiler: "IDO 7.1", compiler_flags: "", diff_label: "" }), /diff_label/);
  }));
  test("the command writes the bundle and prints its manifest", () => withTmp(async (root) => {
    fs.writeFileSync(path.join(root, "t.s"), "glabel f\n");
    fs.writeFileSync(path.join(root, "c.c"), "int x;\n");
    fs.writeFileSync(path.join(root, "s.c"), "void f(void) {}\n");
    const r = await run(["scratch", "bundle", "b", "--target-assembly", "t.s", "--context", "c.c", "--source", "s.c", "--platform", "n64", "--compiler", "ido5.3", "--diff-label", "f", "--json"], root);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).schema, "decomp-workbench-scratch-bundle-v1");
    const missing = await run(["bundle-scratch", "b2", "--context", "c.c"], root);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /required: --target-assembly/);
  }));
});

describe("install-skill", () => {
  const SKILL = path.join(bundledSkillPath(), "SKILL.md");
  test("the portable skill has only standard core frontmatter", () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(SKILL, "utf8"));
    assert.ok(m);
    const fields = Object.fromEntries(m[1].split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]));
    assert.deepEqual(Object.keys(fields).sort(), ["description", "name"]);
    assert.equal(fields.name, "n64-decomp-campaign");
    assert.ok(fields.description);
  });
  test("skill references are present", () => {
    const refs = [...fs.readFileSync(SKILL, "utf8").matchAll(/\(references\/([^)]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(refs, ["evidence-ladder.md", "ido-late-stage-patterns.md", "campaign-hygiene.md", "frontend-lineage.md", "late-stage-doctrine.md"]);
    for (const r of refs) assert.ok(fs.statSync(path.join(path.dirname(SKILL), "references", r)).isFile());
  });
  test("the installer is idempotent and refuses different content", () => withTmp((temp) => {
    const destination = path.join(temp, "skills");
    const [installed, status] = installAgentSkill("claude", { destination });
    assert.equal(status, "installed");
    assert.ok(fs.statSync(path.join(installed, "SKILL.md")).isFile());
    assert.deepEqual(installAgentSkill("claude", { destination }), [installed, "current"]);
    fs.writeFileSync(path.join(installed, "SKILL.md"), "different\n");
    assert.throws(() => installAgentSkill("claude", { destination }), /already exists and differs/);
  }));
  test("the installer rejects an unknown client and a file as the destination", () => withTmp((temp) => {
    assert.throws(() => installAgentSkill("other", { destination: temp }), /unsupported client/);
    const f = path.join(temp, "not-a-directory");
    fs.writeFileSync(f, "file\n");
    assert.throws(() => installAgentSkill("codex", { destination: f }), /not a directory/);
  }));
  test("the command reports installed then already current", () => withTmp(async (temp) => {
    const a = await run(["install-skill", "codex", "--destination", "sk"], temp);
    assert.equal(a.code, 0);
    assert.ok(a.stdout.includes("skill installed:") && a.stdout.includes("invoke with: $n64-decomp-campaign"));
    const b = await run(["install-skill", "codex", "--destination", "sk", "--json"], temp);
    assert.equal(JSON.parse(b.stdout).status, "current");
  }));
});

describe("check-scratch", () => {
  test("directory report separates site score from aligned truth", () => withTmp(async (root) => {
    writeExport(root);
    const r = await run(["check-scratch", root, "--json", "--fail-on-mismatch"]);
    const p = JSON.parse(r.stdout);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "");
    assert.equal(p.schema, "decomp-workbench-scratch-check-v1");
    assert.equal(p.external_score.percentage, 98.0);
    assert.equal(p.evidence, "retained-objdump-text");
    assert.equal(p.comparison.verdict, "schedule-mismatch");
    assert.equal(p.comparison.aligned_schedule, 2);
    assert.equal(p.comparison.symbol, "demo");
  }));
  test("a relocation-normalized match is not a zero-score claim", () => withTmp(async (root) => {
    writeExport(root);
    fs.writeFileSync(path.join(root, "target.objdump"), RELOCATION_TARGET_DUMP);
    fs.writeFileSync(path.join(root, "current.objdump"), RELOCATION_CANDIDATE_DUMP);
    const r = await run(["check-scratch", root, "--json", "--fail-on-mismatch"]);
    const c = JSON.parse(r.stdout).comparison;
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "");
    assert.equal(c.exact, true);
    assert.equal(c.linked_function_exact, true);
    assert.equal(c.decomp_me_score_proxy_exact, false);
    assert.equal(c.raw_instruction_words_exact, false);
    assert.equal(c.relocation_targets_exact, true);
    assert.equal(c.accepted, false);
    assert.equal(c.acceptance_basis, "raw-instruction-word-mismatch");
  }));
  test("a relocation target mismatch rejects the local score proxy", () => withTmp(async (root) => {
    writeExport(root);
    fs.writeFileSync(path.join(root, "target.objdump"), RELOCATION_TARGET_DUMP);
    fs.writeFileSync(path.join(root, "current.objdump"), RELOCATION_TARGET_NAME_MISMATCH_DUMP);
    const r = await run(["check-scratch", root, "--json", "--fail-on-mismatch"]);
    const c = JSON.parse(r.stdout).comparison;
    assert.equal(r.code, 1);
    assert.equal(c.linked_function_exact, true);
    assert.equal(c.raw_instruction_words_exact, true);
    assert.equal(c.relocation_targets_exact, false);
    assert.equal(c.decomp_me_score_proxy_exact, false);
    assert.equal(c.acceptance_basis, "relocation-target-mismatch");
    assert.equal(c.acceptance_summary, `NOT ACCEPTED ${DASH} instruction text exact; 1 relocation target differs`);
    assert.equal(c.exact_scope, "linked-function-after-relocation-field-masking");
    assert.equal(c.relocation_target_differences[0].target.symbol, "callee");
    assert.equal(c.relocation_target_differences[0].candidate.symbol, "other");
  }));
  test("the terminal leads with an unambiguous relocation rejection", () => withTmp(async (root) => {
    writeExport(root);
    fs.writeFileSync(path.join(root, "target.objdump"), RELOCATION_TARGET_DUMP);
    fs.writeFileSync(path.join(root, "current.objdump"), RELOCATION_TARGET_NAME_MISMATCH_DUMP);
    const r = await run(["check-scratch", root, "--fail-on-mismatch"]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.includes(`acceptance: NOT ACCEPTED ${DASH} instruction text exact; 1 relocation target differs`));
    assert.ok(r.stdout.includes("symbol=callee") && r.stdout.includes("symbol=other"));
  }));
  test("the terminal calls out relocation-normalized score residue", () => withTmp(async (root) => {
    writeExport(root);
    fs.writeFileSync(path.join(root, "target.objdump"), RELOCATION_TARGET_DUMP);
    fs.writeFileSync(path.join(root, "current.objdump"), RELOCATION_CANDIDATE_DUMP);
    const r = await run(["check-scratch", root, "--fail-on-mismatch"]);
    assert.equal(r.code, 1);
    for (const s of ["decomp.me score proxy: FAIL", "linked-function exact is not a 100% site score", "Match both raw instruction words and relocation symbol/addend targets"]) assert.ok(r.stdout.includes(s), s);
  }));
  test("site source composition resets the editable source to line one", () => withTmp((root) => {
    writeExport(root);
    const composed = composeSiteSource(loadScratch(root), null);
    assert.equal(composed, "typedef int s32;\n" + SITE_SOURCE_MARKER + "s32 demo(void) { return 1; }\n");
    assert.equal(composed.split(SITE_SOURCE_MARKER).length - 1, 1);
  }));
  test("site composition preserves context and source newlines", () => withTmp((root) => {
    writeExport(root);
    fs.writeFileSync(path.join(root, "ctx.c"), "typedef int s32;\n\n");
    fs.writeFileSync(path.join(root, "code.c"), "s32 demo(void) {\r\nreturn 1;\r\n}\r\n");
    assert.equal(composeSiteSource(loadScratch(root), null), 'typedef int s32;\n\n#line 1 "src.c"\ns32 demo(void) {\r\nreturn 1;\r\n}\r\n');
  }));
  test("a C++ export uses the cxx line identity and names the NCC frontend", () => withTmp((root) => {
    writeExport(root);
    const m = JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8"));
    Object.assign(m, { language: "C++", compiler: "ido7.1_c++" });
    fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify(m));
    const pkg = loadScratch(root);
    const composed = composeSiteSource(pkg, null), frontend = scratchFrontend(pkg);
    assert.ok(composed.includes(SITE_CXX_SOURCE_MARKER) && !composed.includes(SITE_SOURCE_MARKER));
    assert.equal(frontend.source_name, "src.cxx");
    assert.equal(frontend.expected_driver, "NCC");
    assert.equal(frontend.frontend, "EDG C++");
  }));
  test("a C++ export accepts current .c++ member names", () => withTmp((root) => {
    writeExport(root);
    const m = JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8"));
    Object.assign(m, { language: "C++", compiler: "ido7.1_c++" });
    fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify(m));
    fs.renameSync(path.join(root, "code.c"), path.join(root, "code.c++"));
    fs.renameSync(path.join(root, "ctx.c"), path.join(root, "ctx.c++"));
    const composed = composeSiteSource(loadScratch(root), null);
    assert.ok(composed.includes(SITE_CXX_SOURCE_MARKER));
    assert.ok(composed.endsWith("s32 demo(void) { return 1; }\n"));
  }));
  test("compile mode uses the composed source and can retain it", () => withTmp(async (root) => {
    const exp = path.join(root, "export");
    fs.mkdirSync(exp);
    writeExport(exp, { dumps: false, objects: true });
    const helper = path.join(root, "compiler.mjs");
    fs.writeFileSync(helper, "import fs from 'node:fs';\nfs.writeFileSync(process.argv[3], 'candidate');\n");
    const retained = path.join(root, "composed.c");
    const command = `${process.execPath} ${helper} {source} {output}`;
    const instructions = parseDisassembly(TARGET_DUMP, { symbol: "demo" });
    const saved = scratchCli.seams.compareObjects;
    scratchCli.seams.compareObjects = async () => compareInstructions(instructions, instructions, { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });
    try {
      const r = await run(["check-scratch", exp, "--compile-command", command, "--keep-composed", retained]);
      const j = await run(["check-scratch", exp, "--compile-command", command, "--env", "MODE=test", "--json"]);
      const composed = fs.readFileSync(retained, "utf8");
      const report = JSON.parse(j.stdout).compile;
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
      assert.equal(j.code, 0);
      assert.ok(r.stdout.includes("source composition: site-faithful"));
      assert.ok(composed.includes(SITE_SOURCE_MARKER.trim()));
      assert.deepEqual(report.explicit_environment, { MODE: "test" });
      assert.equal(report.composed_source_sha256.length, 64);
      assert.ok(report.compiler.sha256);
      assert.equal(report.timeout_seconds, 120.0);
      assert.ok(composed.indexOf("typedef int s32") < composed.indexOf(SITE_SOURCE_MARKER));
      assert.ok(composed.indexOf(SITE_SOURCE_MARKER) < composed.indexOf("s32 demo"));
    } finally { scratchCli.seams.compareObjects = saved; }
  }));
  test("a compiler failure is the structured compile error", () => withTmp(async (root) => {
    const exp = path.join(root, "export");
    fs.mkdirSync(exp);
    writeExport(exp, { dumps: false, objects: true });
    const helper = path.join(root, "fail.mjs");
    fs.writeFileSync(helper, "process.stderr.write('boom\\n'); process.exit(3);\n");
    const j = await run(["check-scratch", exp, "--compile-command", `${process.execPath} ${helper} {source} {output}`, "--json"]);
    const p = JSON.parse(j.stdout);
    assert.equal(j.code, 2);
    assert.equal(p.stage, "compile");
    assert.equal(p.error.details.returncode, 3);
    assert.match(p.error.message, /compiler failed with exit 3: boom/);
  }));
  test("a source override requires compile mode", async () => {
    const r = await run(["check-scratch", "unused.zip", "--source", "candidate.c"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("--source requires --compile-command"));
  });
  test("compile mode preflights the target before starting the wrapper", () => withTmp(async (root) => {
    writeExport(root, { dumps: false, objects: false });
    const marker = path.join(root, "compiler-ran");
    const helper = path.join(root, "touch.mjs");
    fs.writeFileSync(helper, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, '');\n`);
    const r = await run(["check-scratch", root, "--compile-command", `${process.execPath} ${helper} {source} {output}`]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("needs target.o"));
    assert.ok(!fs.existsSync(marker));
  }));
  test("a ZIP is read without extracting members", () => withTmp((root) => {
    const expanded = path.join(root, "expanded");
    fs.mkdirSync(expanded);
    writeExport(expanded);
    const archive = path.join(root, "scratch.zip");
    fs.writeFileSync(archive, buildZip(fs.readdirSync(expanded).map((n) => ({ name: `one-root/${n}`, data: fs.readFileSync(path.join(expanded, n)), compress: true }))));
    const pkg = loadScratch(archive);
    assert.equal(pkg.kind, "decomp.me-export");
    assert.ok(pkg.files.has("metadata.json"));
  }));
  test("a ZIP rejects path traversal and members from different roots", () => withTmp((root) => {
    const a = path.join(root, "scratch.zip");
    fs.writeFileSync(a, buildZip([{ name: "../metadata.json", data: "{}" }]));
    assert.throws(() => loadScratch(a), /unsafe scratch member path/);
    const b = path.join(root, "mixed.zip");
    fs.writeFileSync(b, buildZip([{ name: "metadata/metadata.json", data: JSON.stringify({ score: 0, max_score: 100 }) },
      { name: "source/code.c", data: "int demo(void) { return 0; }\n" }, { name: "context/ctx.c", data: "" }]));
    assert.throws(() => loadScratch(b), /share one flat directory/);
  }));
  test("a directory rejects nested content instead of ignoring it", () => withTmp((root) => {
    writeExport(root);
    fs.mkdirSync(path.join(root, "unexpected"));
    fs.writeFileSync(path.join(root, "unexpected", "other-code.c"), "int other;\n");
    assert.throws(() => loadScratch(root), /must be flat/);
  }));
  test("an export rejects impossible browser scores", async () => {
    for (const [score, maximum] of [[-1, 100], [101, 100]]) {
      await withTmp((root) => {
        writeExport(root);
        const m = JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8"));
        Object.assign(m, { score, max_score: maximum });
        fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify(m));
        assert.throws(() => loadScratch(root), /score/);
      });
    }
  });
  test("a bundle checksum failure and a non-hex checksum are explicit", async () => {
    for (const [sha, re] of [["0".repeat(64), /checksum mismatch/], ["z".repeat(64), /invalid SHA-256/]]) {
      await withTmp((root) => {
        fs.writeFileSync(path.join(root, "source.c"), "changed\n");
        fs.writeFileSync(path.join(root, "scratch.json"), JSON.stringify({ schema: "decomp-workbench-scratch-bundle-v1", files: { "source.c": { sha256: sha } } }));
        assert.throws(() => loadScratch(root), re);
      });
    }
  });
});

describe("doctor", () => {
  test("validates a scratch and prints a quoted next command", () => withTmp(async (root) => {
    writeExport(root);
    const r = await run(["doctor", root]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.includes("scratch: VALID (decomp.me-export"));
    assert.ok(r.stdout.includes("decomp-workbench check-scratch"));
    assert.ok(r.stdout.includes("'"));
  }, "scratch with space "));
  test("can inspect the cache used by a project", () => withTmp(async (temp) => {
    const cache = path.join(temp, "custom-cache");
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, "candidate.o"), "candidate");
    const r = await run(["doctor", "--cache-dir", cache, "--json"]);
    const p = JSON.parse(r.stdout);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(p.schema, "decomp-workbench-doctor-v1");
    assert.equal(p.cache.files, 1);
    assert.equal(p.cache.bytes, 9);
  }));
  test("fails readiness when exported objects cannot be read", () => withTmp(async (root) => {
    writeExport(root, { dumps: false, objects: true });
    const r = await run(["doctor", root, "--objdump", "/definitely/missing/mips-objdump"]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.includes("object workflow: LIMITED"));
    assert.ok(r.stdout.includes("explicit objdump"));
  }));
  test("rejects an executable that cannot read MIPS ELF", () => withTmp(async (temp) => {
    const fake = path.join(temp, "objdump");
    fs.writeFileSync(fake, "#!/bin/sh\necho not-a-mips-objdump\n");
    fs.chmodSync(fake, 0o755);
    const r = await run(["doctor", "--objdump", fake]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.includes("object workflow: LIMITED"));
    assert.ok(r.stdout.includes("not GNU/MIPS compatible"));
  }));
});

describe("context hardening", () => {
  test("decomp.me's source boundary makes a missing newline safe", () => {
    for (const t of ["static int *prev_bmbuf = 0;", "static int *prev_bmbuf = 0;\n", ""]) assert.equal(contextNewlineWarning(t), null);
  });
  test("a symbol defined in both files is reported with both lines", () => {
    const d = duplicateFileScopeSymbols("typedef int s32;\nstatic int *prev_bmbuf = 0;\n", "static int *prev_bmbuf = 0;\n\ns32 demo(void) { return 1; }\n");
    assert.deepEqual(d, [{ symbol: "prev_bmbuf", ctx_line: 2, code_line: 1 }]);
    assert.deepEqual(duplicateFileScopeSymbols("static int prev_bmbuf = 0;\n", "void f(void) {\n    int prev_bmbuf = 0;\n}\n"), []);
    assert.deepEqual(duplicateFileScopeSymbols("typedef int s32;\n", "s32 demo(void) { return 1; }\n"), []);
  });
  test("line splices: broken, load-bearing, macro continuations, clean", () => {
    assert.deepEqual(codeSpliceReport("void f(void) {\n    if (x) \\ \n        y();\n}\n"), { broken: [2], load_bearing: [] });
    assert.deepEqual(codeSpliceReport("void f(void) {\n    if (temp_s1 <= 0)      \\\n    {                      \\\n        temp_s1 -= 0x8;    \\\n    }                      \\\n    sp134 = temp_s2;\n}\n"), { broken: [], load_bearing: [2, 3, 4, 5] });
    assert.deepEqual(codeSpliceReport("#define STEP(x) \\\n    do_one(x); \\\n    do_two(x)\nint g;\n"), { broken: [], load_bearing: [] });
    assert.deepEqual(codeSpliceReport("#define STEP(x) \\ \n    do_one(x)\n").broken, [1]);
    assert.deepEqual(codeSpliceReport("s32 demo(void) {\n    return 1;\n}\n"), { broken: [], load_bearing: [] });
  });
  test("workbench bundles are not applicable", () => withTmp((root) => {
    fs.writeFileSync(path.join(root, "source.c"), "int demo(void) { return 0; }\n");
    fs.writeFileSync(path.join(root, "scratch.json"), JSON.stringify({ schema: "decomp-workbench-scratch-bundle-v1", files: { "source.c": { sha256: createHash("sha256").update(fs.readFileSync(path.join(root, "source.c"))).digest("hex") } } }));
    assert.deepEqual(scratchContextHardening(loadScratch(root)), { applicable: false });
  }));
  test("a healthy export reports no warnings and no lint findings", () => withTmp((root) => {
    writeExport(root);
    const h = scratchContextHardening(loadScratch(root));
    assert.equal(h.applicable, true);
    assert.equal(h.context_newline_warning, null);
    assert.deepEqual(h.duplicate_symbols, []);
    assert.deepEqual(h.code_splices, { broken: [], load_bearing: [] });
    assert.deepEqual(h.context_lint.findings, []);
  }));
  const CONFLICT_CODE = "static int *prev_bmbuf = 0;\n\ns32 demo(void) {\n#if BUILD_VERSION >= VERSION_J\n    do_extra();\n#endif\n    return 1;\n}\n";
  test("context interactions are checked end to end", () => withTmp((root) => {
    writeExport(root);
    fs.writeFileSync(path.join(root, "ctx.c"), "typedef int s32;\nstatic int *prev_bmbuf = 0;");
    fs.writeFileSync(path.join(root, "code.c"), CONFLICT_CODE);
    const h = scratchContextHardening(loadScratch(root));
    assert.equal(h.context_newline_warning, null);
    assert.equal(h.duplicate_symbols.length, 1);
    assert.equal(h.duplicate_symbols[0].symbol, "prev_bmbuf");
    assert.equal(h.context_lint.findings.length, 1);
    assert.equal(h.context_lint.findings[0].kind, "always-true-by-absence");
  }));
  test("compiler flags seed defines and can resolve the guard", () => withTmp((root) => {
    writeExport(root);
    const m = JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8"));
    m.compiler_flags = "-O2 -DBUILD_VERSION=3 -DVERSION_J=5";
    fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify(m));
    fs.writeFileSync(path.join(root, "code.c"), "s32 demo(void) {\n#if BUILD_VERSION >= VERSION_J\n    do_extra();\n#endif\n    return 1;\n}\n");
    const h = scratchContextHardening(loadScratch(root));
    assert.deepEqual(h.context_lint.findings, []);
    assert.equal(Number(h.context_lint.defines.BUILD_VERSION), 3); // context-lint keeps macro values as BigInt
  }));
  test("check-scratch surfaces context conflicts in terminal and JSON", () => withTmp(async (root) => {
    writeExport(root);
    fs.writeFileSync(path.join(root, "ctx.c"), "typedef int s32;\nstatic int *prev_bmbuf = 0;");
    fs.writeFileSync(path.join(root, "code.c"), CONFLICT_CODE);
    const r = await run(["check-scratch", root]);
    const j = await run(["check-scratch", root, "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.ok(!r.stdout.includes("context does not end in a newline"));
    assert.ok(r.stdout.includes("prev_bmbuf is defined in both ctx.c"));
    assert.ok(r.stdout.includes("always-true-by-absence"));
    const h = JSON.parse(j.stdout).context_hardening;
    assert.equal(j.code, 0);
    assert.equal(h.applicable, true);
    assert.equal(h.duplicate_symbols.length, 1);
    assert.equal(h.context_lint.findings.length, 1);
  }));
  test("check-scratch stays calm when ctx and code are clean", () => withTmp(async (root) => {
    writeExport(root);
    const r = await run(["check-scratch", root]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.ok(!r.stdout.includes("warning:"));
    assert.ok(r.stdout.includes("context lint: no undefined-identifier collapse found"));
  }));
});

describe("check-scratch grammar", () => {
  test("accepts --show-all and says what it does without --view; symbol spellings conflict", async () => {
    const { parseArgs, formatHelp } = await import("../src/decomp/workbench/argparse.js");
    const spec = scratchCli.COMMAND_SPECS.find((s) => s.path[0] === "check-scratch");
    assert.equal(parseArgs(spec, ["export.zip", "--show-all"]).show_all, true);
    assert.ok(formatHelp(spec, { prog: "decomp-workbench check-scratch" }).split(/\s+/).join(" ").includes("with --view"));
    assert.throws(() => parseArgs(spec, ["x.zip", "--symbol", "a", "--function", "b"]), /two spellings of one selector/);
  });
});

// No Python anywhere in romdev.
//
// romdev is JS (ESM) + WASM only: every tool, build script and runtime path is
// node or a WASM module. emsdk is the one exception and it is external (the
// compiler SDK, invoked as emcc/emar/em-config like any other compiler); no
// romdev file may run a Python interpreter or pip itself.
//
// This guard fails when:
//   1. any tracked file is Python source or bytecode (.py / .pyc / .pyi);
//   2. any tracked script or source spawns python / python3 / pip / pip3, or a
//      .py program: a quoted argv token in JS, a command word in a shell
//      script / Dockerfile / CI workflow, a PYTHON* environment variable
//      handed to a child process, or a CI step that sets up Python;
//   3. any package.json script references Python.
//
// KNOWN OFFENDERS (2026-09-29), each being ported to JS by another agent:
//   packages/romdevtools/scripts/recompile-gen/genesis_gpgx.py
//   packages/romdevtools/src/decomp/{m2c,jobs,workbench,project,platform}.js
//     (and test/decomp-platform.test.js, whose fixture argv is platform.js's
//     python invocation shape)
// This test is EXPECTED TO FAIL until those ports land, and to go green once
// they do. Do not silence it by allowlisting them: port them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function repoRoot() {
  try {
    return execFileSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
const ROOT = repoRoot();
const tracked = ROOT
  ? execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean)
  : [];

// Comments that explain the rule itself may name the forbidden commands.
// Keep this tight: exact file + exact line text, nothing broader.
const ALLOW = [];
const allowed = (file, line) => ALLOW.some((a) => a.file === file && line.includes(a.text));

const JS_EXT = /\.(?:m|c)?[jt]s$/;
const SHELL_FILE = (f) => /\.(?:sh|bash)$/.test(f) || /(^|\/)Dockerfile[^/]*$/.test(f) || /(^|\/)Makefile[^/]*$/.test(f) || /^\.github\/.*\.ya?ml$/.test(f);

// A quoted argv token: "python3", 'pip', `python3 -m x`, ".../venv/bin/python",
// "build.py", "tool.py --flag".
const JS_PATTERNS = [
  { re: /["'`](?:[^"'`\s]*\/)?(?:python[0-9.]*|pip[0-9]*)(?=["'`\s])/, why: "spawns python/pip" },
  { re: /["'`][^"'`\s]+\.py(?=["'`\s])/, why: "runs a .py program" },
  { re: /\bPYTHON(?:PATH|HOME|UNBUFFERED|DONTWRITEBYTECODE|STARTUP)\b/, why: "sets a Python environment variable for a child" },
];
// A command word in a shell line (comments included: a shell comment that
// shows how to run a Python tool is still an instruction to run Python).
const SHELL_PATTERNS = [
  { re: /(?:^|[\s;&|(`=$"'])(?:[^\s;&|(`"']*\/)?(?:python[0-9.]*|pip[0-9]*)(?=\s|$|[;&|)`"'])/, why: "runs python/pip" },
  { re: /(?:^|[\s;&|(`"'])[^\s;&|(`"']+\.py(?=\s|$|[;&|)`"'])/, why: "runs a .py program" },
  { re: /setup-python|\bPYTHON(?:PATH|HOME|UNBUFFERED)\b/, why: "sets up Python" },
];

function scan(file, patterns) {
  const hits = [];
  const text = readFileSync(path.join(ROOT, file), "utf8");
  text.split("\n").forEach((line, i) => {
    for (const p of patterns) {
      if (p.re.test(line) && !allowed(file, line)) { hits.push(`${file}:${i + 1}: ${p.why}: ${line.trim().slice(0, 140)}`); break; }
    }
  });
  return hits;
}

test("no tracked Python source or bytecode", { skip: !ROOT && "not a git checkout" }, () => {
  const py = tracked.filter((f) => /\.py[ci]?$/.test(f));
  assert.deepEqual(py, [], `Python files are tracked in romdev (port them to node .mjs):\n  ${py.join("\n  ")}`);
});

test("no script or source spawns python or pip", { skip: !ROOT && "not a git checkout" }, () => {
  const hits = [];
  for (const f of tracked) {
    if (!existsSync(path.join(ROOT, f))) continue;
    if (f === "packages/romdevtools/test/no-python.test.js") continue; // this file names the tokens it hunts
    if (JS_EXT.test(f) && !f.endsWith(".d.ts")) hits.push(...scan(f, JS_PATTERNS));
    else if (SHELL_FILE(f)) hits.push(...scan(f, SHELL_PATTERNS));
  }
  assert.deepEqual(hits, [], `romdev must not invoke Python (JS + WASM only):\n  ${hits.join("\n  ")}`);
});

test("no package.json script references Python", { skip: !ROOT && "not a git checkout" }, () => {
  const hits = [];
  for (const f of tracked.filter((f) => f === "package.json" || f.endsWith("/package.json"))) {
    const scripts = JSON.parse(readFileSync(path.join(ROOT, f), "utf8")).scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (/\bpython[0-9.]*\b|\bpip[0-9]*\b|\.py\b/i.test(cmd)) hits.push(`${f} scripts.${name}: ${cmd}`);
    }
  }
  assert.deepEqual(hits, [], `package.json scripts reference Python:\n  ${hits.join("\n  ")}`);
});

// The scanners themselves must be able to fail: each pattern set flags a
// known-bad line and passes a known-good one.
test("the Python scanners catch what they claim to", () => {
  const js = (l) => JS_PATTERNS.some((p) => p.re.test(l));
  const sh = (l) => SHELL_PATTERNS.some((p) => p.re.test(l));
  for (const bad of [
    `spawn("python3", ["-m", "x"])`, `const py = path.join(root, "venv", "bin", "python");`,
    `argv0: [process.env.ROMDEV_PYTHON ?? "python3", "-m", "cli"]`, `execFileSync('pip', ['install', 'x'])`,
    "run(`python3 -c 'print(1)'`)", `args: ["build.py", "--flag"]`, `env: { PYTHONUNBUFFERED: "1" }`,
  ]) assert.ok(js(bad), `JS scanner missed: ${bad}`);
  for (const good of [
    `// Ported from sms-wat src/emit_gb.py; the WAT is identical to the Python emitter's.`,
    `const pythonLike = true;`, `files.filter(f => f.endsWith(".py"))`, `import x from "./pipeline.js";`, `"piped output"`,
  ]) assert.ok(!js(good), `JS scanner false positive: ${good}`);
  for (const bad of [
    `done < <(python3 -c "import json")`, `require_cmd python3`, `MESON=(python3 "$SRC/meson.py")`,
    `pip install pyyaml`, `  /usr/bin/python3 tool`, `./gen.py out.c`, `- uses: actions/setup-python@v5`,
  ]) assert.ok(sh(bad), `shell scanner missed: ${bad}`);
  for (const good of [
    `require_cmd node`, `# emsdk already provides: emcc/emar/emcmake, git, make, cmake, python3, node.`,
    `node scripts/binary-manifest.mjs --write`, `pipeline=1`,
  ]) assert.ok(!sh(good), `shell scanner false positive: ${good}`);
});

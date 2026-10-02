// No Python anywhere in romdev.
//
// romdev is JS (ESM) + WASM only: every tool, build script and runtime path is
// node or a WASM module. emsdk is the one exception and it is external (the
// compiler SDK, invoked as emcc/emar/em-config like any other compiler); no
// romdev file may run a Python interpreter or pip itself.
//
// This guard fails when:
//   1. any tracked file is Python source or bytecode (.py / .pyc / .pyi);
//   2. JS source LAUNCHES Python: a process call (spawn / exec / execFile /
//      fork / run / runner / ...) whose arguments name python or pip (a
//      literal, or a variable or property that holds one), a .py program, or
//      a shell line invoking python; an argv array whose program is python or
//      pip; or a PYTHON* environment variable set for a child;
//   3. a shell script / Dockerfile / Makefile / CI workflow runs python or pip
//      as a command word (comments included: a shell comment showing how to
//      run a Python tool is an instruction to run Python), or sets Python up;
//   4. any package.json script references Python.
//
// romdev reads decomp projects whose build steps ARE Python scripts
// (asm-processor's build.py, asset packers) and substitutes its own JS/WASM
// ports for them. Recognising such a step is data, not a launch: naming a
// project's script in a lookup table, a message, a comment or a classifier
// test is fine. The one shape that looks exactly like a launch - an argv
// array whose program is python - is a genuine exception only where the array
// is handed to a classifier; such a line carries
//   // no-python-guard: <reason>
// with a reason of at least ten characters. A marker without a reason fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { showToplevel, lsFiles } from "../src/git/index.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = "packages/romdevtools/test/no-python.test.js";

// git rev-parse --show-toplevel / git ls-files, read by romdev's own git reader.
const ROOT = showToplevel(HERE);
const tracked = ROOT ? lsFiles(ROOT, { cached: true }) : [];

const JS_EXT = /\.(?:m|c)?[jt]s$/;
const SHELL_FILE = (f) => /\.(?:sh|bash)$/.test(f) || /(^|\/)Dockerfile[^/]*$/.test(f) || /(^|\/)Makefile[^/]*$/.test(f) || /^\.github\/.*\.ya?ml$/.test(f);

// ── JS: a lexer just good enough to tell code from strings and comments ──
/**
 * Split JS source into tokens with line numbers: strings (', ", template
 * text), regex literals, identifiers/punctuation. Comments are dropped;
 * the marker comment of each line is recorded.
 */
export function lexJs(text) {
  const toks = [], markers = new Map();
  let i = 0, line = 1, prevSig = null;
  const push = (type, value, l) => { toks.push({ type, value, line: l }); if (type !== "ws") prevSig = { type, value }; };
  const regexAllowed = () => !prevSig || (prevSig.type === "punct" && !/[)\]}]/.test(prevSig.value)) || (prevSig.type === "ident" && /^(return|typeof|case|in|of|new|delete|void|throw|else|do|yield|await)$/.test(prevSig.value));
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i); const body = text.slice(i, end < 0 ? text.length : end);
      const m = /no-python-guard:(.*)$/.exec(body);
      if (m) markers.set(line, m[1].trim());
      i = end < 0 ? text.length : end; continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2); const body = text.slice(i, end < 0 ? text.length : end + 2);
      line += (body.match(/\n/g) ?? []).length; i = end < 0 ? text.length : end + 2; continue;
    }
    if (c === "'" || c === '"') {
      const l = line; let j = i + 1, s = "";
      while (j < text.length && text[j] !== c && text[j] !== "\n") { if (text[j] === "\\") { s += text[j + 1] ?? ""; j += 2; continue; } s += text[j++]; }
      push("str", s, l); i = j + 1; continue;
    }
    if (c === "`") {
      // Template: literal chunks are strings; ${...} bodies are lexed as code.
      let j = i + 1, s = "", l = line;
      const flush = () => { push("str", s, l); s = ""; l = line; };
      while (j < text.length && text[j] !== "`") {
        if (text[j] === "\\") { s += text[j + 1] ?? ""; j += 2; continue; }
        if (text[j] === "$" && text[j + 1] === "{") {
          flush();
          let depth = 1, k = j + 2;
          while (k < text.length && depth) { if (text[k] === "{") depth++; else if (text[k] === "}") depth--; if (text[k] === "\n") line++; if (depth) k++; }
          const inner = lexJs(text.slice(j + 2, k));
          for (const t of inner.toks) toks.push({ ...t, line: t.line + l - 1 });
          j = k + 1; l = line; continue;
        }
        if (text[j] === "\n") line++;
        s += text[j++];
      }
      flush(); i = j + 1; continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1, inClass = false;
      while (j < text.length && text[j] !== "\n") { if (text[j] === "\\") { j += 2; continue; } if (text[j] === "[") inClass = true; else if (text[j] === "]") inClass = false; else if (text[j] === "/" && !inClass) break; j++; }
      j++; while (/[a-z]/i.test(text[j] ?? "")) j++;
      push("regex", text.slice(i, j), line); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (/[\w$]/.test(text[j] ?? "")) j++; push("ident", text.slice(i, j), line); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (/[\w.]/.test(text[j] ?? "")) j++; push("num", text.slice(i, j), line); i = j; continue; }
    push("punct", c, line); i++;
  }
  return { toks, markers };
}

// A string that IS a python/pip program (optionally a path to one).
const PY_PROGRAM = /^(?:.*\/)?(?:python[0-9.]*|pip[0-9]*)$/;
// A shell line that runs python/pip as a command word.
const PY_SHELL = /(?:^|[\s;&|(`=$"'])(?:[^\s;&|(`"']*\/)?(?:python[0-9.]*|pip[0-9]*)(?=\s|$|[;&|)`"'])/;
const PY_FILE = /\.py$/;
// Calls that start a process (node's API and the runners romdev's code wraps them in).
const LAUNCH = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "run", "runner", "runCommand", "runCommandIsolated", "runIsolated", "execa", "defaultRunner"]);
const PY_ENV = /^PYTHON(?:PATH|HOME|UNBUFFERED|DONTWRITEBYTECODE|STARTUP|IOENCODING|NOUSERSITE)$/;

/**
 * Scan JS text; returns [{line, why}] of Python launches.
 */
export function scanJs(text) {
  const { toks, markers } = lexJs(text);
  const hits = [];
  const hit = (line, why) => hits.push({ line, why });
  // Names that hold a python program: `const py = ... "python3"`, `{ python: "python3" }`, `x.python = ...`.
  const pyNames = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== "str" || !PY_PROGRAM.test(t.value)) continue;
    // walk back to the assignment target on this statement
    for (let b = k - 1; b >= 0 && b > k - 40; b--) {
      const p = toks[b];
      if (p.type === "punct" && (p.value === ";" || p.value === "{" || p.value === "}")) break;
      if (p.type === "punct" && (p.value === "=" || p.value === ":") && toks[b - 1]?.type === "ident") { pyNames.add(toks[b - 1].value); break; }
    }
  }
  const isPyRef = (k) => {
    const t = toks[k];
    if (t.type === "str") return PY_PROGRAM.test(t.value) || PY_FILE.test(t.value) || PY_SHELL.test(t.value);
    if (t.type === "ident") return /python/i.test(t.value) || pyNames.has(t.value);
    return false;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    // 1. a launch call whose arguments name python, a .py program, or a python shell line
    if (t.type === "ident" && LAUNCH.has(t.value) && toks[k + 1]?.value === "(" && toks[k - 1]?.value !== "function" && toks[k - 1]?.value !== ".") {
      let depth = 0, j = k + 1;
      for (; j < toks.length; j++) {
        if (toks[j].value === "(" || toks[j].value === "[" || toks[j].value === "{") depth++;
        else if (toks[j].value === ")" || toks[j].value === "]" || toks[j].value === "}") { depth--; if (!depth) break; }
        else if (toks[j].type !== "punct" && isPyRef(j)) { hit(toks[j].line, `${t.value}() launches Python`); break; }
      }
    }
    // 2. an argv array whose program (first element) is python/pip
    if (t.value === "[" && t.type === "punct") {
      const first = [];
      for (let j = k + 1; j < toks.length && first.length < 8; j++) {
        if (toks[j].value === "," || toks[j].value === "]") break;
        first.push(j);
      }
      if (first.some((j) => toks[j].type === "str" && PY_PROGRAM.test(toks[j].value))) hit(t.line, "an argv array whose program is python/pip");
    }
    // 3. PYTHON* environment for a child
    if ((t.type === "ident" || t.type === "str") && PY_ENV.test(t.value)) hit(t.line, "sets a Python environment variable for a child");
  }
  // Per-line exceptions: a marker must carry its reason.
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const key = `${h.line}:${h.why}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = markers.get(h.line);
    if (reason !== undefined && reason.length >= 10) continue;
    out.push(reason !== undefined ? { ...h, why: `${h.why} (no-python-guard marker needs a reason of 10+ characters)` } : h);
  }
  for (const [line, reason] of markers) if (reason.length < 10 && !out.some((h) => h.line === line)) out.push({ line, why: "no-python-guard marker without a reason" });
  return out.sort((a, b) => a.line - b.line);
}

// ── shell-like files ─────────────────────────────────────────────────────
const SHELL_PATTERNS = [
  { re: PY_SHELL, why: "runs python/pip" },
  { re: /(?:^|[\s;&|(`"'])[^\s;&|(`"']+\.py(?=\s|$|[;&|)`"'])/, why: "runs a .py program" },
  { re: /setup-python|\bPYTHON(?:PATH|HOME|UNBUFFERED)\b/, why: "sets up Python" },
];
function scanShell(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const p of SHELL_PATTERNS) if (p.re.test(line)) { hits.push({ line: i + 1, why: p.why }); break; }
  });
  return hits;
}

test("no tracked Python source or bytecode", { skip: !ROOT && "not a git checkout" }, () => {
  const py = tracked.filter((f) => /\.py[ci]?$/.test(f));
  assert.deepEqual(py, [], `Python files are tracked in romdev (port them to node .mjs):\n  ${py.join("\n  ")}`);
});

test("no script or source launches python or pip", { skip: !ROOT && "not a git checkout" }, () => {
  const hits = [];
  for (const f of tracked) {
    if (!existsSync(path.join(ROOT, f)) || f === SELF) continue;
    let found = [];
    if (JS_EXT.test(f) && !f.endsWith(".d.ts")) found = scanJs(readFileSync(path.join(ROOT, f), "utf8"));
    else if (SHELL_FILE(f)) found = scanShell(readFileSync(path.join(ROOT, f), "utf8"));
    const lines = found.length ? readFileSync(path.join(ROOT, f), "utf8").split("\n") : [];
    for (const h of found) hits.push(`${f}:${h.line}: ${h.why}: ${(lines[h.line - 1] ?? "").trim().slice(0, 140)}`);
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

// The scanners themselves must be able to fail: real launches (including the
// exact shapes romdev once had) are caught, recognising a project's Python
// build step as data is not, and a marker without a reason is itself a hit.
test("the Python scanners catch launches and treat script names as data", () => {
  const js = (src) => scanJs(src).length > 0;
  for (const bad of [
    `spawn("python3", ["-m", "x"])`,
    `execFileSync('pip', ['install', 'x'])`,
    "run(`python3 -c 'print(1)'`)",
    `exec("cd tools && python3 gen.py out.c")`,
    `const r = run(t.python, ["-c", "import sys"]);`,
    `const py = path.join(root, "venv", "bin", "python");\nawait run(py, ["--version"], { env });`,
    `const t = { python: fs.existsSync(p) ? p : "python3" };\nrun(t.python, args, { cwd });`,
    `const child = spawn("timeout", ["-s", "INT", "-k", "10", String(s), t.python, ...args], { cwd });`,
    `spawnSync(process.execPath, ["tools/x.py"])`,
    `return { argv0: [process.env.ROMDEV_PYTHON ?? "python3", "-m", "decomp_workbench.cli"] };`,
    `const argv = ["python3", "tools/asm-processor/build.py"]; // no-python-guard: too`,
    `env: { PYTHONUNBUFFERED: "1" }`,
    `if (loc.pythonPath) env.PYTHONPATH = loc.pythonPath;`,
  ]) assert.ok(js(bad), `JS scanner missed: ${bad}`);
  for (const good of [
    `// Ported from sms-wat src/emit_gb.py; runs as \`python3 emit_gb.py\` upstream.`,
    `const pythonLike = true;`, `files.filter(f => f.endsWith(".py"))`, `import x from "./pipeline.js";`, `"piped output"`,
    `const PORTED = { "build_font_container.py": { kind: "asset-container" }, "assemble_rsp.py": { kind: "assemble-rsp" } };`,
    `const ap = path.join(root, "tools", "asm-processor", "asm_processor.py"); const h = await sha256File(ap);`,
    "return { kind: \"unsupported\", reason: `python script ${script} has no romdev port` };",
    `const idx = res.findIndex((arg) => ["asm_processor", "asm-processor", "build.py", "preprocess.py"].some((c) => arg.includes(c)));`,
    `const PYTHON_RE = /(^|\\/)(python[0-9.]*|pypy[0-9.]*)$/;`,
    `classifyCommand([".venv/bin/python3", "tools/asm-processor/build.py"]); // no-python-guard: a project's python step, classified (data)`,
  ]) assert.ok(!js(good), `JS scanner false positive: ${good}`);
  const sh = (l) => scanShell(l).length > 0;
  for (const bad of [
    `done < <(python3 -c "import json")`, `require_cmd python3`, `MESON=(python3 "$SRC/meson.py")`,
    `pip install pyyaml`, `  /usr/bin/python3 tool`, `./gen.py out.c`, `- uses: actions/setup-python@v5`,
  ]) assert.ok(sh(bad), `shell scanner missed: ${bad}`);
  for (const good of [
    `require_cmd node`, `# emsdk already provides: emcc/emar/emcmake, git, make, cmake, python3, node.`,
    `node scripts/binary-manifest.mjs --write`, `pipeline=1`,
  ]) assert.ok(!sh(good), `shell scanner false positive: ${good}`);
});

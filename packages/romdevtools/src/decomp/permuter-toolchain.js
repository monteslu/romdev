// permuter-toolchain.js - the toolchain adapter romdev-permuter's import.mjs
// and permuter.mjs use (see romdev-permuter src/import.js). Every program
// upstream decomp-permuter shells out to runs here as romdev's JS/WASM:
//   make --dry-run / ninja -t commands -> the project's Makefile read in JS
//                                         (makefile.js) / build.ninja read here
//   cpp                                -> WASM cc1 -E (cpp.js)
//   the assembler, IDO, binutils       -> recipe.js dispatch (WASM)
//   compile.sh                         -> its cd + command line run through
//                                         recipe.js (no bash)
import fs from "node:fs";
import path from "node:path";
import { Makefile } from "./makefile.js";
import { preprocess as cppPreprocess } from "./cpp.js";
import { runArgv, runRecipeLine } from "./recipe.js";

function patMatch(pattern, word) {
  const p = pattern.indexOf("%");
  if (p < 0) return pattern === word ? "" : null;
  const pre = pattern.slice(0, p), post = pattern.slice(p + 1);
  if (word.length >= pre.length + post.length && word.startsWith(pre) && word.endsWith(post)) return word.slice(pre.length, word.length - post.length);
  return null;
}

/** make: the recipe lines of every target whose rule builds from the C file. */
async function makeLines(root, cFile, makeFlags) {
  const overrides = { PERMUTER: "1" };
  for (const f of makeFlags) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(f);
    if (m) overrides[m[1]] = m[2];
  }
  const mk = await Makefile.load(root, { overrides });
  const targets = new Set();
  for (const r of mk.rules) {
    if (!r.pattern) {
      if (r.prereqs.includes(cFile)) for (const t of r.targets) targets.add(t);
      continue;
    }
    for (const p of r.prereqs) {
      const stem = patMatch(p, cFile);
      if (stem != null) for (const t of r.targets) targets.add(t.replace("%", stem));
    }
  }
  const lines = [];
  for (const t of targets) {
    const rec = mk.recipeFor(t);
    if (rec) for (const l of rec.lines) lines.push(l.command);
  }
  return lines;
}

/** ninja -t commands: every build edge's command, from build.ninja (and its include/subninja files). */
function ninjaLines(root, flags) {
  const vars = new Map();
  const rules = new Map();
  const builds = [];
  const expand = (s, scopes) => s.replace(/\$(\$|:|\s|\n|\{([A-Za-z0-9_.-]+)\}|([A-Za-z0-9_-]+))/g, (m, x, braced, bare) => {
    if (x === "$") return "$";
    if (x === ":") return ":";
    if (/^\s$/.test(x)) return x === "\n" ? "" : " ";
    const name = braced ?? bare;
    for (const sc of scopes) if (sc.has(name)) return sc.get(name);
    return "";
  });
  const read = (file) => {
    const text = fs.readFileSync(path.resolve(root, file), "utf8").replace(/\$\r?\n\s*/g, "");
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
      const indented = /^\s/.test(raw);
      const line = raw.trim();
      if (indented && cur) {
        const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
        if (m) cur.vars.set(m[1], cur.kind === "rule" ? m[2] : expand(m[2], [cur.vars, vars]));
        continue;
      }
      cur = null;
      let m;
      if ((m = /^rule\s+(\S+)/.exec(line))) { cur = { kind: "rule", vars: new Map() }; rules.set(m[1], cur); continue; }
      if ((m = /^build\s+(.*)$/.exec(line))) {
        const [outs, rest] = splitColon(m[1]);
        const parts = rest.trim().split(/\s+/);
        const rule = parts.shift();
        const inputs = [];
        for (const p of parts) { if (p === "|" || p === "||") break; inputs.push(p); }
        cur = { kind: "build", rule, outs: outs.split(/\s+/).filter((o) => o && o !== "|").map((o) => expand(o, [vars])), ins: inputs.map((i) => expand(i, [vars])), vars: new Map() };
        builds.push(cur);
        continue;
      }
      if ((m = /^(include|subninja)\s+(.*)$/.exec(line))) { read(expand(m[2].trim(), [vars])); continue; }
      if ((m = /^(default|pool)\b/.exec(line))) continue;
      if ((m = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line))) vars.set(m[1], expand(m[2], [vars]));
    }
  };
  const splitColon = (s) => {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "$") { i++; continue; }
      if (s[i] === ":") return [s.slice(0, i), s.slice(i + 1)];
    }
    return [s, ""];
  };
  read("build.ninja");
  const wanted = flags.filter((f) => !f.startsWith("-"));
  const out = [];
  for (const b of builds) {
    const rule = rules.get(b.rule);
    if (!rule || b.rule === "phony") continue;
    if (wanted.length && !b.outs.some((o) => wanted.includes(o))) continue;
    const scope = new Map([...b.vars, ["in", b.ins.join(" ")], ["out", b.outs.join(" ")], ["in_newline", b.ins.join("\n")]]);
    const cmd = rule.vars.get("command");
    if (cmd) out.push(expand(expand(cmd, [scope, vars]), [scope, vars]));
  }
  return out;
}

export async function buildCommandLines({ root, cFile, makeFlags, buildSystem }) {
  if (buildSystem === "ninja") return { lines: ninjaLines(root, makeFlags), invocation: ["ninja", "-t", "commands", ...makeFlags] };
  return { lines: await makeLines(root, cFile, makeFlags), invocation: ["make", "--always-make", "--dry-run", "--debug=j", "PERMUTER=1", ...makeFlags] };
}

export async function preprocess({ cwd, argv, stdin }) {
  const r = await cppPreprocess({ cwd, args: argv.slice(1), stdin: stdin == null ? undefined : Buffer.from(stdin, "utf8") });
  if (r.exitCode !== 0) throw Object.assign(new Error(String(r.log ?? "").slice(0, 2000)), { argv });
  return r.output.toString("utf8");
}

/** A private scratch dir per call: concurrent compiles share the permuter's tmp dir. */
function tmpRootFor(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.mkdtempSync(path.join(dir, ".romdev-tmp-"));
}

export async function run({ cwd, argv }) {
  const tmpRoot = tmpRootFor(cwd === "/" ? process.cwd() : path.dirname(argv[argv.length - 1]));
  try {
    const r = await runArgv(argv, { cwd, tmpRoot });
    if (r.unsupported) return { code: 127, log: `romdev has no port of this program: ${r.unsupported}` };
    return { code: r.code, log: r.log ?? "" };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const sq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\"'\"'") + "'");

/**
 * Run a permuter compile.sh (`bash compile.sh <in> -o <out>`) without bash:
 * its `cd <dir>` and command line, with "$INPUT"/"$OUTPUT" bound, go through
 * recipe.js. Assignments, `set` and `export` lines carry nothing the WASM
 * toolchain uses.
 */
export async function compileScript({ script, input, output }) {
  const lines = fs.readFileSync(script, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let cwd = path.dirname(script);
  const commands = [];
  for (const l of lines) {
    if (/^(set|export)\s/.test(l) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)) continue;
    const cd = /^cd\s+(.+)$/.exec(l);
    if (cd) { cwd = path.resolve(cwd, cd[1].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1")); continue; }
    commands.push(l.split("\"$INPUT\"").join(sq(path.resolve(input))).split("\"$OUTPUT\"").join(sq(path.resolve(output))));
  }
  const tmpRoot = tmpRootFor(path.dirname(path.resolve(output)));
  try {
    for (const c of commands) {
      const r = await runRecipeLine(c, { cwd, tmpRoot });
      if (r.unsupported) throw new Error(`compile.sh step not supported by romdev's toolchain: ${r.unsupported}`);
      if (r.code !== 0) return false;
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  return fs.existsSync(output);
}

/** compileModule form for romdev-permuter: the directory's compile.sh arrives as the fourth argument. */
export function compileWithScript(cPath, oPath, config, script) {
  return compileScript({ script: config?.script ?? script, input: cPath, output: oPath });
}

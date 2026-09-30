// cpp.js - the C preprocessor for the decomp domain, as WASM: the gcc
// toolchain's cc1 (romdev-toolchain-mips-gcc) in preprocess mode. Used for
// m2c contexts, header-dependency discovery (the cache keys), and the
// `cpp | iconv | as` step of a project's .s rule. No host gcc/clang/cpp.
//
// cc1 runs over MEMFS. Rather than copy whole include trees in, the files a
// TU can reach are found first (includeClosure: every #include/#include_next
// resolved against the same search path cpp uses, across all conditional
// branches), and exactly those are mounted at their real absolute paths with
// the module's cwd set to the project root.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HANDLER = fileURLToPath(new URL("./wasm-run.js", import.meta.url));

function cc1Glue() {
  let dir;
  try { dir = path.dirname(fileURLToPath(import.meta.resolve("romdev-toolchain-mips-gcc"))); }
  catch { dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "romdev-toolchain-mips-gcc"); }
  const g = path.join(dir, "wasm", "cc1.mjs");
  if (!fs.existsSync(g)) throw Object.assign(new Error(`cc1 WASM missing (${g}); install romdev-toolchain-mips-gcc`), { code: "TOOLCHAIN_MISSING" });
  return g;
}

/**
 * Split cpp-style arguments into what cc1 needs. Accepts the spellings a
 * project's Makefile uses for cpp/gcc -E/clang -E.
 * @returns {{includes:string[], quoteIncludes:string[], defines:string[], forced:string[], inputs:string[], output:string|null, flags:string[], deps:{mode:string|null, target:string|null, file:string|null, phony:boolean, missingOk:boolean}, nostdinc:boolean}}
 */
export function parseCppArgs(args) {
  const r = { includes: [], quoteIncludes: [], defines: [], forced: [], inputs: [], output: null, flags: [], deps: { mode: null, target: null, file: null, phony: false, missingOk: false }, nostdinc: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "-I") r.includes.push(next());
    else if (a.startsWith("-I")) r.includes.push(a.slice(2));
    else if (a === "-iquote") r.quoteIncludes.push(next());
    else if (a === "-D" || a === "-U") r.defines.push(a + next());
    else if (a.startsWith("-D") || a.startsWith("-U")) r.defines.push(a);
    else if (a === "-include" || a === "-imacros") r.forced.push(a, next());
    else if (a === "-o") r.output = next();
    else if (a === "-x") next(); // cc1 is a C preprocessor already
    else if (a === "-E" || a === "-c" || a === "-S") { /* mode flags of the driver */ }
    else if (a === "-nostdinc") r.nostdinc = true;
    // -l<lib> is a link option: the driver accepts and drops it when only
    // preprocessing (so a Makefile's legacy `cpp -lang-c` is `-l ang-c`).
    else if (a === "-l") next();
    else if (/^-l./.test(a)) { /* link library: no effect on -E */ }
    else if (a === "-M" || a === "-MM") r.deps.mode = a;
    else if (a === "-MD" || a === "-MMD") r.deps.mode = a;
    else if (a === "-MG") r.deps.missingOk = true;
    else if (a === "-MP") r.deps.phony = true;
    else if (a === "-MT" || a === "-MQ") r.deps.target = next();
    else if (a === "-MF") r.deps.file = next();
    else if (/^-(std|ansi|P|C|CC|undef|traditional|traditional-cpp|trigraphs|w|fno-|fdollars|fno-dollars|fdirectives-only|d[DMNIU]$|W)/.test(a)) r.flags.push(a);
    else if (/^-m|^-f|^-O|^-g|^-march|^-mabi|^--?target|^-G$/.test(a)) { if (a === "-G") next(); /* codegen flags: irrelevant to cpp */ }
    else if (a === "-") r.inputs.push("-");
    else if (a.startsWith("-")) r.flags.push(a);
    else r.inputs.push(a);
  }
  return r;
}

const INCLUDE_RE = /^[ \t]*#[ \t]*(include|include_next|import)[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>|([A-Za-z_]\w*))/gm;

/**
 * Every file a TU may #include (all branches, transitively), resolved the way
 * cpp resolves them. Unresolvable names are reported, not fatal (-MG / a
 * missing optional header is the compiler's call).
 * @returns {{files:string[], missing:string[], computed:string[]}} absolute paths
 */
export function includeClosure(cwd, entryFiles, { includes = [], quoteIncludes = [], forced = [] } = {}, virtualEntries = []) {
  const sysDirs = includes.map((d) => path.resolve(cwd, d));
  const quoteDirs = quoteIncludes.map((d) => path.resolve(cwd, d));
  const seen = new Set(), missing = new Set(), computed = new Set();
  const stack = [];
  const push = (abs) => { if (!seen.has(abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) { seen.add(abs); stack.push(abs); return true; } return false; };
  for (const f of entryFiles) push(path.resolve(cwd, f));
  const virtual = new Map(virtualEntries.map((v) => [v.path, v.text]));
  for (const v of virtualEntries) { seen.add(v.path); stack.push(v.path); }
  for (let i = 0; i < forced.length; i += 2) push(path.resolve(cwd, forced[i + 1]));
  while (stack.length) {
    const file = stack.pop();
    let text;
    try { text = virtual.has(file) ? virtual.get(file) : fs.readFileSync(file, "latin1"); } catch { continue; }
    if (!text.includes("#")) continue;
    for (const m of text.matchAll(INCLUDE_RE)) {
      const name = m[2] ?? m[3];
      if (!name) { computed.add(`${path.relative(cwd, file)}: #${m[1]} ${m[4]}`); continue; }
      if (path.isAbsolute(name)) { if (!push(name) && !seen.has(name)) missing.add(name); continue; }
      const dirs = m[2] !== undefined ? [path.dirname(file), ...quoteDirs, ...sysDirs] : sysDirs;
      let hit = false;
      // #include_next and duplicates across dirs: every candidate that exists is
      // mountable, which keeps include_next's "the next one" resolvable too.
      for (const d of dirs) {
        const cand = path.resolve(d, name);
        if (seen.has(cand)) { hit = true; if (m[1] !== "include_next") break; continue; }
        if (push(cand)) { hit = true; if (m[1] !== "include_next") break; }
      }
      if (!hit) missing.add(name);
    }
  }
  return { files: [...seen].filter((f) => !virtual.has(f)), missing: [...missing], computed: [...computed] };
}

let runIsolated = null;

/**
 * Preprocess with cc1 -E.
 * @param {{cwd:string, args:string[], stdin?:Buffer, timeoutMs?:number}} a cpp-style args (as a project's recipe spells them)
 * @returns {Promise<{exitCode:number, output:Buffer, log:string, deps?:string, files:string[], missing:string[], computed:string[]}>}
 */
export async function preprocess({ cwd, args, stdin, timeoutMs = 120_000 }) {
  const p = parseCppArgs(args);
  let inputs = p.inputs;
  // Input on stdin (a recipe's "... | cpp"): cc1 reads it as a MEMFS file.
  const fromStdin = inputs.length === 0 || inputs[0] === "-";
  const stdinPath = path.join(cwd, ".romdev-stdin.c");
  const virtualEntries = fromStdin ? [{ path: stdinPath, text: (stdin ?? Buffer.alloc(0)).toString("latin1") }] : [];
  if (fromStdin) inputs = [stdinPath];
  const closure = includeClosure(cwd, fromStdin ? [] : inputs, p, virtualEntries);
  // A computed include (#include MACRO) cannot be resolved without running
  // cpp: mount every header under the search path so cc1 can.
  if (closure.computed.length) closure.files = [...new Set([...closure.files, ...headersUnder(cwd, [...p.quoteIncludes, ...p.includes])])];
  const cc1Args = ["cc1", "-E", "-quiet", ...(p.nostdinc ? ["-nostdinc"] : []), ...p.flags,
    ...p.quoteIncludes.flatMap((d) => ["-iquote", d]), ...p.includes.flatMap((d) => ["-I", d]), ...p.defines, ...p.forced];
  let depOut = null;
  if (p.deps.mode) {
    depOut = "/romdev-deps.d";
    // -M/-MM replace the output with the rule; -MD/-MMD write it beside the
    // preprocessed output (cc1 takes the file after the flag).
    if (p.deps.mode === "-MD" || p.deps.mode === "-MMD") cc1Args.push(p.deps.mode, depOut);
    else cc1Args.push(p.deps.mode === "-MM" ? "-MM" : "-M", "-MF", depOut);
    if (p.deps.missingOk) cc1Args.push("-MG");
    if (p.deps.phony) cc1Args.push("-MP");
    if (p.deps.target) cc1Args.push("-MT", p.deps.target);
  }
  cc1Args.push(...inputs);
  if (!runIsolated) ({ runIsolated } = await import("../toolchains/_worker/run.js"));
  const r = await runIsolated({
    handler: HANDLER, kind: "memfs", glue: cc1Glue(), argv: cc1Args, cwd,
    mount: closure.files, mountDirs: p.includes.map((d) => path.resolve(cwd, d)),
    memFiles: fromStdin ? [{ path: stdinPath, base64: (stdin ?? Buffer.alloc(0)).toString("base64") }] : [],
    outputs: depOut ? [depOut] : [], timeoutMs,
  });
  if (r.crash || r.timedOut) return { exitCode: r.exitCode ?? -1, output: Buffer.alloc(0), log: r.log ?? "worker crashed", ...closure };
  const output = Buffer.from(r.stdout ?? "", "base64");
  const deps = depOut && r.outputs?.[depOut] ? Buffer.from(r.outputs[depOut], "base64").toString("utf8") : undefined;
  return { exitCode: r.exitCode, output, log: r.log ?? "", deps, ...closure };
}

function headersUnder(cwd, dirs, cap = 5000) {
  const out = [];
  const walk = (d, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= cap) return;
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 6) walk(f, depth + 1);
      else if (e.isFile() && /\.(h|hh|hpp|inc|def)$/i.test(e.name)) out.push(f);
    }
  };
  for (const d of dirs) walk(path.resolve(cwd, d), 0);
  return out;
}

/** Parse a make-style dependency list ("obj: a b \\\n c") into paths. */
export function parseDepsText(text, { exclude = [] } = {}) {
  const body = text.replace(/\\\n/g, " ");
  const firstColon = body.indexOf(": ");
  const list = (firstColon >= 0 ? body.slice(firstColon + 1) : body).split(/\n/)[0];
  return list.split(/\s+/).filter((t) => t && !t.endsWith(":") && !exclude.includes(t));
}

/**
 * A project's gcc `-fsyntax-only` warnings pass, run with the WASM gcc front
 * end (cc1). Host-target code-generation flags (-m32, -march=...) and
 * dependency-file flags are dropped: they select the HOST ABI for a check
 * that only parses. Returns cc1's diagnostics.
 * @returns {Promise<{exitCode:number, log:string}>}
 */
export async function syntaxCheck({ cwd, args, timeoutMs = 120_000 }) {
  const keep = [];
  const inputs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "-MF" || a === "-MT" || a === "-MQ") { i++; continue; }
    if (/^-(MMD|MD|MP|MG|M|MM|c|E|S|fsyntax-only|fdiagnostics-color.*|pipe)$/.test(a) || /^-m/.test(a)) continue;
    if (a === "-I" || a === "-D" || a === "-U" || a === "-include" || a === "-iquote" || a === "-x") { keep.push(a, args[++i]); continue; }
    if (a.startsWith("-")) { keep.push(a); continue; }
    inputs.push(a);
  }
  const p = parseCppArgs(keep);
  const closure = includeClosure(cwd, inputs, p);
  const cc1Args = ["cc1", "-fsyntax-only", "-quiet", ...keep.filter((a, i) => a !== "-x" && keep[i - 1] !== "-x"), ...inputs];
  if (!runIsolated) ({ runIsolated } = await import("../toolchains/_worker/run.js"));
  const r = await runIsolated({ handler: HANDLER, kind: "memfs", glue: cc1Glue(), argv: cc1Args, cwd, mount: [...closure.files, ...inputs.map((f) => path.resolve(cwd, f))], mountDirs: p.includes.map((d) => path.resolve(cwd, d)), outputs: [], timeoutMs });
  return { exitCode: r.exitCode ?? -1, log: r.log ?? "" };
}

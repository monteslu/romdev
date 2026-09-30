// recipe.js - run a build recipe line (as makefile.js expands it) through
// romdev's WASM/JS toolchain. Each line is parsed like /bin/sh would parse it
// (quotes, `;`, `&&`, `||`, pipelines, redirections) and every program is
// dispatched to its romdev equivalent:
//
//   IDO cc (.../ido*/<ver>/.../cc)            -> WASM IDO (toolchain.js)
//   mips-*-{as,ld,objcopy,objdump}         -> WASM mips-linux-gnu binutils
//   <python> .../asm-processor/build.py      -> JS asm-processor
//   <python> .../set_o32abi_bit.py           -> JS
//   cpp / clang -E / gcc -E                -> WASM cc1 -E (cpp.js)
//   iconv / n64crc / sha1sum / printf / echo / mkdir / rm / cp / touch / : / true
//
// Anything else is UNSUPPORTED: the step is not run and the caller decides
// (a build keeps an existing output and reports the gap; it never falls back
// to a host binary). A gcc/clang `-fsyntax-only` step (a Makefile's host
// warnings pass) produces nothing and is skipped with a note.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { asmProcessorBuild } from "./asm-processor.js";
import { idoCompile, binutils, toolName } from "./toolchain.js";
import { preprocess } from "./cpp.js";
import { iconv, parseIconvArgs, n64crcFile, setO32AbiBit } from "./host-ports.js";

// -- sh parsing ----------------------------------------------------------
/**
 * Parse a command line into a list of pipelines joined by ; && ||.
 * @returns {Array<{op:';'|'&&'|'||'|null, pipeline:Array<{argv:string[], env:Record<string,string>, redirects:Array<{fd:number, op:string, target:string}>}>}>}
 */
export function parseShell(line) {
  const tokens = [];
  let i = 0, cur = null;
  const push = () => { if (cur !== null) { tokens.push({ word: cur }); cur = null; } };
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t" || c === "\n") { push(); i++; continue; }
    if (c === "\\" && line[i + 1] === "\n") { i += 2; continue; }
    if (c === "'") { const j = line.indexOf("'", i + 1); if (j < 0) throw new Error("unterminated ' in: " + line); cur = (cur ?? "") + line.slice(i + 1, j); i = j + 1; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\" && '"\\$`\n'.includes(line[j + 1])) { s += line[j + 1]; j += 2; continue; }
        if (line[j] === "$" || line[j] === "`") throw new Error("command substitution / variables inside quotes are not supported: " + line);
        s += line[j++];
      }
      if (j >= line.length) throw new Error('unterminated " in: ' + line);
      cur = (cur ?? "") + s; i = j + 1; continue;
    }
    if (c === "\\") { cur = (cur ?? "") + (line[i + 1] ?? ""); i += 2; continue; }
    if (c === "$" || c === "`") throw new Error("shell expansion is not supported in a recipe step: " + line);
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ">>" || two === "2>" || two === "&>") {
      if (two === "2>" && cur !== null) { cur += c; i++; continue; }
      push();
      if (two === "2>") {
        if (line[i + 2] === "&") { tokens.push({ op: "2>&", fd: 2 }); i += 3; continue; }
        if (line[i + 2] === ">") { tokens.push({ op: ">>", fd: 2 }); i += 3; continue; }
        tokens.push({ op: ">", fd: 2 }); i += 2; continue;
      }
      tokens.push({ op: two, fd: two === ">>" ? 1 : undefined }); i += 2; continue;
    }
    if (c === ";" || c === "|" || c === ">" || c === "<") { push(); tokens.push({ op: c, fd: c === ">" ? 1 : c === "<" ? 0 : undefined }); i++; continue; }
    cur = (cur ?? "") + c; i++;
  }
  push();
  const lists = [];
  let pipeline = [], cmd = { argv: [], env: {}, redirects: [] }, joinOp = null;
  const endCmd = () => { if (cmd.argv.length || Object.keys(cmd.env).length || cmd.redirects.length) pipeline.push(cmd); cmd = { argv: [], env: {}, redirects: [] }; };
  const endPipeline = (op) => { endCmd(); if (pipeline.length) lists.push({ op: joinOp, pipeline }); pipeline = []; joinOp = op; };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.word !== undefined) {
      if (!cmd.argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.word)) { const e = t.word.indexOf("="); cmd.env[t.word.slice(0, e)] = t.word.slice(e + 1); continue; }
      cmd.argv.push(t.word);
      continue;
    }
    if (t.op === "|") { endCmd(); continue; }
    if (t.op === ";" || t.op === "&&" || t.op === "||") { endPipeline(t.op); continue; }
    if (t.op === ">" || t.op === ">>" || t.op === "<" || t.op === "&>") {
      const target = tokens[++k]?.word;
      if (target === undefined) throw new Error("redirection without a target: " + line);
      cmd.redirects.push({ fd: t.op === "&>" ? -1 : t.fd, op: t.op === "&>" ? ">" : t.op, target });
      continue;
    }
    if (t.op === "2>&") { const target = tokens[++k]?.word; cmd.redirects.push({ fd: 2, op: ">&", target }); continue; }
  }
  endPipeline(null);
  return lists;
}

// -- dispatch ------------------------------------------------------------
const PYTHON_RE = /(^|\/)(python[0-9.]*|pypy[0-9.]*)$/;

/** What a command would run as (for reporting and for callers that plan). */
export function classifyCommand(argv) {
  const prog = argv[0] ?? "";
  const base = path.basename(prog);
  if (prog === ":" || prog === "true") return { kind: "noop" };
  if (prog === "false") return { kind: "false" };
  if (base === "printf" || base === "echo") return { kind: "print" };
  if (PYTHON_RE.test(prog)) {
    const script = argv.find((a, i) => i > 0 && !a.startsWith("-")) ?? "";
    if (/asm-processor\/build\.py$/.test(script)) return { kind: "asm-processor", script };
    if (/set_o32abi_bit\.py$/.test(script)) return { kind: "set-o32abi-bit", script };
    return { kind: "unsupported", reason: `python script ${script || "(none)"} has no romdev port` };
  }
  const tn = toolName(prog);
  if (tn?.kind === "ido") return { kind: "ido", version: tn.version, program: tn.program };
  if (tn?.kind === "binutils") return { kind: "binutils", tool: tn.tool };
  if ((base === "gcc" || base === "clang" || base === "cc" || /-gcc$/.test(base)) && argv.includes("-fsyntax-only")) return { kind: "syntax-check" };
  if (base === "cpp" || /-cpp$/.test(base) || ((base === "gcc" || base === "clang" || /-gcc$/.test(base)) && argv.includes("-E"))) return { kind: "cpp" };
  if (base === "iconv") return { kind: "iconv" };
  if (base === "n64crc" || /n64crc$/.test(prog)) return { kind: "n64crc" };
  if (base === "sha1sum") return { kind: "sha1sum" };
  if (["mkdir", "rm", "cp", "touch", "mv"].includes(base)) return { kind: "fs", op: base };
  return { kind: "unsupported", reason: `no WASM/JS equivalent for '${prog}'` };
}

class Unsupported extends Error {}

/**
 * Run one expanded recipe line.
 * @param {string} line
 * @param {{cwd:string, tmpRoot:string, log?:(s:string)=>void}} ctx
 * @returns {Promise<{code:number, log:string, steps:Array<{argv:string[], kind:string, code:number}>, unsupported?:string, skipped?:string[]}>}
 */
export async function runRecipeLine(line, ctx) {
  let parsed;
  try { parsed = parseShell(line); }
  catch (e) { return { code: 127, log: "", steps: [], unsupported: e.message }; }
  let log = "", code = 0;
  const steps = [], skipped = [];
  for (const { op, pipeline } of parsed) {
    if (op === "&&" && code !== 0) continue;
    if (op === "||" && code === 0) continue;
    let input = null;
    for (let s = 0; s < pipeline.length; s++) {
      const cmd = pipeline[s];
      const last = s === pipeline.length - 1;
      const redirIn = cmd.redirects.find((r) => r.fd === 0);
      if (redirIn) input = fs.readFileSync(path.resolve(ctx.cwd, redirIn.target));
      const cls = classifyCommand(cmd.argv);
      if (cls.kind === "unsupported") return { code: 127, log, steps, unsupported: `${cls.reason} (in: ${line.slice(0, 200)})` };
      let r;
      try { r = await runOne(cmd.argv, cls, { ...ctx, stdin: input }); }
      catch (e) {
        if (e instanceof Unsupported) return { code: 127, log, steps, unsupported: e.message };
        throw e;
      }
      if (cls.kind === "syntax-check") skipped.push("host syntax check (-fsyntax-only) skipped: it produces no output");
      steps.push({ argv: cmd.argv, kind: cls.kind, code: r.code });
      log += r.log ?? "";
      // stdout: into the next stage, a redirect, or the log.
      const out = r.stdout ?? Buffer.alloc(0);
      const redirOut = cmd.redirects.find((x) => x.fd === 1 || x.fd === -1);
      if (redirOut && redirOut.target !== "/dev/null") {
        const p = path.resolve(ctx.cwd, redirOut.target);
        if (redirOut.op === ">>") fs.appendFileSync(p, out); else fs.writeFileSync(p, out);
        input = null;
      } else if (!last) input = out;
      else if (!redirOut) log += out.toString("latin1");
      code = r.code;
      if (code !== 0 && !last) { input = Buffer.alloc(0); }
    }
  }
  return { code, log, steps, ...(skipped.length ? { skipped } : {}) };
}

async function runOne(argv, cls, ctx) {
  const { cwd, tmpRoot } = ctx;
  switch (cls.kind) {
    case "noop": case "syntax-check": return { code: 0 };
    case "false": return { code: 1 };
    case "print": {
      const args = argv.slice(1);
      const text = path.basename(argv[0]) === "printf" ? cprintf(args) : args.filter((a) => a !== "-e" && a !== "-n").join(" ") + (args.includes("-n") ? "" : "\n");
      return { code: 0, stdout: Buffer.from(text, "latin1") };
    }
    case "ido": {
      const r = await idoCompile({ version: cls.version, argv, cwd, tmpRoot, ...(ctx.ido ?? {}) });
      return { code: r.exitCode, log: r.log };
    }
    case "binutils": {
      const r = await binutils(cls.tool, argv.slice(1), { cwd, stdin: ctx.stdin ?? undefined });
      return { code: r.exitCode, log: r.stderr ?? r.log, stdout: Buffer.from(r.stdout ?? "", "latin1") };
    }
    case "asm-processor": {
      const i = argv.indexOf(cls.script);
      const scriptDir = path.dirname(path.resolve(cwd, cls.script));
      const r = await asmProcessorBuild({
        args: argv.slice(i + 1), cwd, preludePath: path.join(scriptDir, "prelude.inc"), tmpDir: tmpRoot,
        compile: async (ccArgv) => {
          const c = classifyCommand(ccArgv);
          if (c.kind !== "ido") throw new Unsupported(`asm-processor compiler '${ccArgv[0]}' has no WASM equivalent`);
          const x = await idoCompile({ version: c.version, argv: ccArgv, cwd, tmpRoot, ...(ctx.ido ?? {}) });
          return { code: x.exitCode, log: x.log };
        },
        assemble: async (asArgv, s, o) => {
          const c = classifyCommand(asArgv);
          if (c.kind !== "binutils" || c.tool !== "as") throw new Unsupported(`asm-processor assembler '${asArgv[0]}' has no WASM equivalent`);
          const x = await binutils("as", [...asArgv.slice(1), s, "-o", o], { cwd });
          return { code: x.exitCode, log: x.stderr ?? x.log };
        },
      });
      return { code: r.code, log: r.log };
    }
    case "set-o32abi-bit": {
      const file = argv[argv.indexOf(cls.script) + 1];
      setO32AbiBit(path.resolve(cwd, file));
      return { code: 0 };
    }
    case "cpp": {
      const args = argv.slice(1);
      const r = await preprocess({ cwd, args, stdin: ctx.stdin ?? undefined });
      const outIdx = args.indexOf("-o");
      if (outIdx >= 0 && r.exitCode === 0) { fs.writeFileSync(path.resolve(cwd, args[outIdx + 1]), r.output); return { code: 0, log: r.log }; }
      // `cpp in out` (a second positional is the output file)
      const pos = args.filter((a, k) => !a.startsWith("-") && !["-I", "-D", "-U", "-o", "-x", "-include", "-MF", "-MT", "-MQ", "-iquote", "-imacros"].includes(args[k - 1]));
      if (pos.length === 2 && r.exitCode === 0) { fs.writeFileSync(path.resolve(cwd, pos[1]), r.output); return { code: 0, log: r.log }; }
      return { code: r.exitCode, log: r.log, stdout: r.output };
    }
    case "iconv": {
      const { from, to, files } = parseIconvArgs(argv.slice(1));
      const input = files.length ? Buffer.concat(files.map((f) => fs.readFileSync(path.resolve(cwd, f)))) : (ctx.stdin ?? Buffer.alloc(0));
      try { return { code: 0, stdout: iconv(input, from, to) }; }
      catch (e) { return { code: 1, log: `iconv: ${e.message}\n` }; }
    }
    case "n64crc": {
      const file = argv[1];
      return { code: 0, stdout: Buffer.from(n64crcFile(path.resolve(cwd, file))) };
    }
    case "sha1sum": return sha1sum(argv.slice(1), cwd);
    case "fs": return fsOp(cls.op, argv.slice(1), cwd);
    default: throw new Unsupported(`no runner for ${cls.kind}`);
  }
}

function cprintf(args) {
  const fmt = args[0] ?? "";
  let k = 1;
  const esc = (s) => s.replace(/\\(n|t|\\|033|e|0[0-7]{0,3}|")/g, (m, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "\\" ? "\\" : c === '"' ? '"' : c === "e" || c === "033" ? "\x1b" : String.fromCharCode(parseInt(c, 8))));
  return esc(fmt).replace(/%([-0-9.]*)([sdxX%])/g, (m, w, t) => (t === "%" ? "%" : String(args[k++] ?? "")));
}

function sha1sum(args, cwd) {
  const status = args.includes("--status");
  const checkIdx = args.indexOf("-c");
  const files = args.filter((a) => !a.startsWith("-"));
  if (checkIdx >= 0 || args.includes("--check")) {
    let ok = true, out = "";
    for (const list of files) {
      for (const l of fs.readFileSync(path.resolve(cwd, list), "utf8").split("\n")) {
        const m = /^([0-9a-fA-F]{40})\s+\*?(.+)$/.exec(l.trim());
        if (!m) continue;
        let got = null;
        try { got = createHash("sha1").update(fs.readFileSync(path.resolve(cwd, m[2]))).digest("hex"); } catch { got = null; }
        const pass = got === m[1].toLowerCase();
        ok &&= pass;
        if (!status) out += `${m[2]}: ${pass ? "OK" : "FAILED"}\n`;
      }
    }
    return { code: ok ? 0 : 1, stdout: Buffer.from(out) };
  }
  const out = files.map((f) => `${createHash("sha1").update(fs.readFileSync(path.resolve(cwd, f))).digest("hex")}  ${f}\n`).join("");
  return { code: 0, stdout: Buffer.from(out) };
}

function fsOp(op, args, cwd) {
  const flags = args.filter((a) => a.startsWith("-")), paths = args.filter((a) => !a.startsWith("-")).map((p) => path.resolve(cwd, p));
  if (op === "mkdir") { for (const p of paths) fs.mkdirSync(p, { recursive: flags.some((f) => f.includes("p")) }); return { code: 0 }; }
  if (op === "rm") { for (const p of paths) fs.rmSync(p, { force: true, recursive: flags.some((f) => /r/i.test(f)) }); return { code: 0 }; }
  if (op === "touch") { for (const p of paths) { const t = new Date(); try { fs.utimesSync(p, t, t); } catch { fs.writeFileSync(p, ""); } } return { code: 0 }; }
  if (op === "cp") {
    const [dst] = paths.slice(-1);
    for (const src of paths.slice(0, -1)) fs.cpSync(src, fs.existsSync(dst) && fs.statSync(dst).isDirectory() ? path.join(dst, path.basename(src)) : dst, { recursive: flags.some((f) => /r/i.test(f)) });
    return { code: 0 };
  }
  if (op === "mv") { const [src, dst] = paths; fs.renameSync(src, dst); return { code: 0 }; }
  return { code: 127, log: `unsupported fs op ${op}\n` };
}

/**
 * Run one argv (a single command, no shell syntax) through the same dispatch.
 * `ido: { programs, env }` is threaded into every IDO compile the step makes
 * (including asm-processor's): pass-module overrides and extra environment.
 * For an IDO or asm-processor step `log` holds the passes' stderr and stdout.
 * @returns {Promise<{code:number, log:string, stdout?:Buffer, kind:string, unsupported?:string}>}
 */
export async function runArgv(argv, { cwd, tmpRoot, stdin, ido } = {}) {
  const cls = classifyCommand(argv);
  if (cls.kind === "unsupported") return { code: 127, log: "", kind: cls.kind, unsupported: cls.reason };
  try {
    const r = await runOne(argv, cls, { cwd, tmpRoot, stdin, ido });
    return { code: r.code, log: (r.log ?? "") + (r.stdout && cls.kind !== "print" ? "" : ""), stdout: r.stdout, kind: cls.kind };
  } catch (e) {
    if (e instanceof Unsupported) return { code: 127, log: "", kind: cls.kind, unsupported: e.message };
    throw e;
  }
}

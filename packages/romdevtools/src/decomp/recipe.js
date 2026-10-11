// recipe.js - run a build recipe line (as makefile.js expands it) through
// romdev's WASM/JS toolchain. Each line is parsed like /bin/sh would parse it
// (quotes, `;`, `&&`, `||`, pipelines, redirections) and every program is
// dispatched to its romdev equivalent:
//
//   IDO cc (.../ido*/<ver>/.../cc)            -> WASM IDO (toolchain.js)
//   KMC gcc 2.7.2 (.../2.7.2/gcc, as)       -> WASM gcc 2.7.2 + binutils 2.6
//   EGCS 1.1.2 (.../1.1.2-4/gcc, as)        -> WASM egcs 2.91.66 + binutils 2.9.5
//   armips                                  -> WASM armips
//   mips-linux-gnu-gcc / -cpp                -> WASM gcc 14.2 (mips-linux-gnu)
//   slinky-cli / pigment64 / crunch64       -> WASM builds of decompals' releases
//   a PS1 project's string encoder          -> psx-str, WASM build of the pinned project tool
//   the project's disk/asset tools, its
//   go-run wrapper, go run ./tools/<tool>,
//   dirt_patcher.py,
//   cat / truncate                          -> psx-setup.js (Go tools as wasip1, JS ports)
//   mips-*-{as,ld,objcopy,objdump}         -> WASM mips-linux-gnu binutils
//   <python> .../asm-processor/build.py      -> JS asm-processor
//   <python> .../set_o32abi_bit.py           -> JS
//   <python> <ported project script>.py      -> JS (PORTED_SCRIPTS, by sha256;
//                                              maspsx included)
//   cc1-psx-26 (.../gcc-2.6.3-psx/cc1)        -> WASM gcc 2.6.3-psx
//   <python> -m splat split / .../splat/split.py / splat split
//                                            -> romdev-splat (JS splat; the splat and
//                                              spimdisasm versions the project pins)
//   uv run <command>                         -> <command>
//   cpp / clang -E / gcc -E                -> WASM cc1 -E (cpp.js)
//   iconv / n64crc / sha1sum / md5sum / printf / echo / mkdir / rm / cp / touch / : / true
//
// Anything else is UNSUPPORTED: the step is not run and the caller decides
// (a build keeps an existing output and reports the gap; it never falls back
// to a host binary). A gcc/clang `-fsyntax-only` step (a Makefile's host
// warnings pass) produces nothing and is skipped with a note.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { asmProcessorBuild } from "./asm-processor.js";
import { idoCompile, binutils, toolName, armips, decompGcc, decompTool } from "./toolchain.js";
import { preprocess } from "./cpp.js";
import { maspsxMain } from "./maspsx.js";
import { split as splatSplit } from "romdev-splat";
import { classifyPsxSetup, runPsxSetup, PSX_SETUP_KINDS } from "./psx-setup.js";
import { iconv, parseIconvArgs, n64crcFile, setO32AbiBit, buildAssetContainer, incFromBin, msgReencode, n64ChecksumUpdate, romCompress } from "./host-ports.js";
import { romDecompress, parseBaseromHashes, extractCompressedSegments, mio0Extract, parseMio0Offsets } from "./setup-ports.js";

// Project scripts with a JS port, by the exact script content ported (sha256).
// A script whose bytes differ is a different program: it is reported
// unsupported rather than assumed to behave like the port.
const PORTED_SCRIPTS = {
  "build_font_container.py": { kind: "asset-container", sha256: ["45c9d8af2f4dce095da093411641cba59016711cdd2e2b8cefd68cc7c7936b24"],
    helpers: { "font_texture.py": ["7f778618cf4aedc5d232a515b2fd0d2ecb62402db6c276f642094cbed599618d"] } },
  "assemble_rsp.py": { kind: "assemble-rsp", sha256: ["782936f3b533bb9c91d000f3797bc1f28d0a74a75e67df73e7c79e345824de54"] },
  "inc_from_bin.py": { kind: "inc-from-bin", sha256: ["d403a21ce83e75870afbad867b010ede9e700c881982c5d83b850c0cbdbbe7b0"] },
  "msg_reencoder.py": { kind: "msg-reencoder", sha256: ["c3e9cce705bfd65b787f35bb199504b4d1d183f4ae8fa2849223e6779208f420"] },
  "checksummer.py": { kind: "n64-checksummer", sha256: ["c7bbf85dc06165b44af768d83f4d1926debfa02710d4afb72fcc98f80c304516"] },
  "maspsx.py": { kind: "maspsx", sha256: ["38c090123ad707fb28c40013121c71036a763ec3b787a5c6ab6b55752d1166ae"],
    helpers: { "maspsx/__init__.py": ["043e2480f05f9dc433eed14ad5b3ef60a379d9a988250822741fe4e15b359d33"] } },
  "rom_compressor.py": { kind: "rom-compressor", sha256: ["4ed8bab52b3d8d7fb8bf8fdb3edffd8473a436ba8917fc928be52c9b5b863d9c"],
    helpers: { "compression_common.py": ["4ae0c40605478dea0f17194f9a855d53b1d3d37d5e929e51bf39b6f906a1cb5e"] } },
  // Project setup (setup-ports.js).
  "rom_decompressor.py": { kind: "rom-decompressor", sha256: ["aa069aa129a7da2a800d79aa63b982eb4d35a1abf24ebbcfb2b3768c28dbb71f"],
    helpers: { "compression_common.py": ["4ae0c40605478dea0f17194f9a855d53b1d3d37d5e929e51bf39b6f906a1cb5e"] } },
  "extract_compressed_segments.py": { kind: "extract-compressed-segments", sha256: ["1c46b501e2d74cab03210eedef85608457412315116c73781876569cbec727fd"],
    helpers: { "compression_common.py": ["4ae0c40605478dea0f17194f9a855d53b1d3d37d5e929e51bf39b6f906a1cb5e"] } },
  "mio0_extract.py": { kind: "mio0-extract", sha256: ["ce486c3850127f377ac67cd2ef7e560aea74b5623913c277cc12c62c1754e6a6"] },
};

function portedScript(script, cwd) {
  const spec = PORTED_SCRIPTS[path.basename(script)];
  if (!spec) return null;
  const sha = (f) => { try { return createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };
  const abs = path.resolve(cwd, script);
  const got = sha(abs);
  if (!spec.sha256.includes(got)) return { kind: "unsupported", reason: `${script} (sha256 ${got ?? "unreadable"}) is not the version romdev ported` };
  for (const [h, shas] of Object.entries(spec.helpers ?? {})) {
    const hs = sha(path.join(path.dirname(abs), h));
    if (!shas.includes(hs)) return { kind: "unsupported", reason: `${script}'s helper ${h} (sha256 ${hs ?? "missing"}) is not the version romdev ported` };
  }
  return { kind: spec.kind, script };
}

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
export function classifyCommand(argv, cwd = process.cwd()) {
  const prog = argv[0] ?? "";
  const base = path.basename(prog);
  if (prog === ":" || prog === "true") return { kind: "noop" };
  if (prog === "false") return { kind: "false" };
  if (base === "printf" || base === "echo") return { kind: "print" };
  // `uv run [--opts] cmd ...` (a project's PYTHON = uv run python) runs cmd.
  if (base === "uv" && argv[1] === "run") {
    let k = 2;
    while (k < argv.length && argv[k].startsWith("-")) k++;
    return classifyCommand(argv.slice(k), cwd);
  }
  // splat: `python -m splat split`, a vendored `.../splat/split.py`, or the
  // `splat split` console script a project's venv installs.
  if (PYTHON_RE.test(prog) && argv[1] === "-m" && argv[2] === "splat") return { kind: "splat", args: argv.slice(3) };
  if (PYTHON_RE.test(prog)) {
    const script = argv.find((a, i) => i > 0 && !a.startsWith("-")) ?? "";
    if (/(^|\/)splat\/split\.py$/.test(script)) return { kind: "splat", args: ["split", ...argv.slice(argv.indexOf(script) + 1)] };
  }
  if (base === "splat") return { kind: "splat", args: argv.slice(1) };
  const psx = classifyPsxSetup(argv, cwd);
  if (psx) return psx;
  if (PYTHON_RE.test(prog)) {
    const script = argv.find((a, i) => i > 0 && !a.startsWith("-")) ?? "";
    if (/asm-processor\/build\.py$/.test(script)) return { kind: "asm-processor", script };
    if (/set_o32abi_bit\.py$/.test(script)) return { kind: "set-o32abi-bit", script };
    const ported = portedScript(script, cwd);
    if (ported) return ported;
    return { kind: "unsupported", reason: `python script ${script || "(none)"} has no romdev port` };
  }
  const tn = toolName(prog);
  if (tn?.kind === "ido") return { kind: "ido", version: tn.version, program: tn.program };
  if (tn?.kind === "binutils") return { kind: "binutils", tool: tn.tool, littleEndian: /^mipsel/.test(tn.prefix) };
  if (tn?.kind === "armips") return { kind: "armips" };
  if (tn?.kind === "decomp-tool") return { kind: "decomp-tool", tool: tn.tool };
  if (tn?.kind === "decomp-gcc") return { kind: "decomp-gcc", family: tn.family, program: tn.program };
  if ((base === "gcc" || base === "clang" || base === "cc" || /-gcc$/.test(base)) && argv.includes("-fsyntax-only")) return { kind: "syntax-check" };
  if (base === "cpp" || /-cpp$/.test(base) || ((base === "gcc" || base === "clang" || /-gcc$/.test(base)) && argv.includes("-E"))) return { kind: "cpp" };
  if (base === "iconv") return { kind: "iconv" };
  if (base === "n64crc" || /n64crc$/.test(prog)) return { kind: "n64crc" };
  if (base === "sha1sum" || base === "md5sum") return { kind: "sha1sum", algo: base === "md5sum" ? "md5" : "sha1" };
  if (["mkdir", "rm", "cp", "touch", "mv"].includes(base)) return { kind: "fs", op: base };
  if (base === "make" || base === "gmake") return { kind: "make" };
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
      const cls = classifyCommand(cmd.argv, ctx.cwd);
      if (cls.kind === "unsupported") return { code: 127, log, steps, unsupported: `${cls.reason} (in: ${line.slice(0, 200)})` };
      let r;
      try { r = await runOne(cmd.argv, cls, { ...ctx, stdin: input, env: cmd.env }); }
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
      // pipefail: a failing stage fails the pipeline (a truncated preprocess
      // must never become an "ok" object).
      if (s === 0 || code === 0) code = r.code;
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
      // mipsel-linux-gnu-* is the same toolchain defaulting to little-endian.
      const endian = cls.littleEndian && (cls.tool === "as" || cls.tool === "ld") && !argv.includes("-EB") ? ["-EL"] : [];
      const r = await binutils(cls.tool, [...endian, ...argv.slice(1)], { cwd, stdin: ctx.stdin ?? undefined });
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
    case "sha1sum": return sha1sum(argv.slice(1), cwd, cls.algo);
    case "make": return subMake(argv.slice(1), ctx);
    case "decomp-gcc": {
      const r = await decompGcc({ family: cls.family, argv, cwd, tmpRoot, stdin: ctx.stdin ?? undefined });
      return { code: r.exitCode, log: r.stderr ?? r.log, stdout: r.stdout };
    }
    case "armips": {
      const r = await armips(argv.slice(1), { cwd });
      return { code: r.exitCode, log: r.log };
    }
    case "asset-container": {
      const args = argv.slice(argv.indexOf(cls.script) + 1).filter((a) => !a.startsWith("-"));
      if (args.length !== 2) return { code: 2, log: `usage: ${cls.script} layout output\n` };
      try {
        const data = await buildAssetContainer(path.resolve(cwd, args[0]));
        const out = path.resolve(cwd, args[1]);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, data);
        return { code: 0 };
      } catch (e) { return { code: 1, log: `${e.message}\n` }; }
    }
    case "assemble-rsp": return assembleRsp(argv.slice(argv.indexOf(cls.script) + 1), ctx);
    case "decomp-tool": {
      if (cls.tool === "psx-str") {
        // a pipeline stage: stdin in, stdout out (bytes)
        const r = await decompTool(cls.tool, argv.slice(1), { cwd, stdin: ctx.stdin ?? undefined, stdoutBinary: true });
        return { code: r.exitCode, log: r.stderr ?? r.log, stdout: r.stdout };
      }
      const r = await decompTool(cls.tool, argv.slice(1), { cwd });
      return { code: r.exitCode, log: r.log };
    }
    case "maspsx": {
      const args = argv.slice(argv.indexOf(cls.script) + 1);
      // A recipe step with no piped input reads maspsx's input file argument.
      const r = maspsxMain(args, { stdin: ctx.stdin ?? Buffer.alloc(0), readFile: (f) => fs.readFileSync(path.resolve(cwd, f)) });
      if (r.code !== 0 || !r.runAssembler) return { code: r.code, log: r.stderr, stdout: Buffer.from(r.stdout, "utf8") };
      const asCls = classifyCommand([r.runAssembler.argv[0]], cwd);
      if (asCls.kind !== "binutils" || asCls.tool !== "as") throw new Unsupported(`maspsx --gnu-as-path '${r.runAssembler.argv[0]}' has no WASM equivalent`);
      const x = await runOne(r.runAssembler.argv, asCls, { ...ctx, stdin: Buffer.from(r.runAssembler.input, "utf8") });
      return { code: x.code, log: r.stderr + (x.log ?? ""), stdout: x.stdout };
    }
    case "inc-from-bin": case "msg-reencoder": case "n64-checksummer": case "rom-compressor":
    case "rom-decompressor": case "extract-compressed-segments": case "mio0-extract":
      return runPortedScript(cls, argv.slice(argv.indexOf(cls.script) + 1), ctx);
    case "fs": return fsOp(cls.op, argv.slice(1), cwd);
    case "splat": return runSplat(cls.args, ctx);
    default:
      if (PSX_SETUP_KINDS.has(cls.kind)) return runPsxSetup(argv, cls, { cwd, tmpRoot, stdin: ctx.stdin ?? undefined, env: ctx.env ?? {} });
      throw new Unsupported(`no runner for ${cls.kind}`);
  }
}

/** The ported project scripts (argparse-shaped command lines). */
async function runPortedScript(cls, args, { cwd, tmpRoot }) {
  const pos = args.filter((a) => !a.startsWith("-"));
  const flag = (...names) => args.some((a) => names.includes(a));
  const abs = (p) => path.resolve(cwd, p);
  const usage = (n) => ({ code: 2, log: `${cls.script}: expected ${n} arguments, got ${pos.length}\n` });
  try {
    switch (cls.kind) {
      case "inc-from-bin": {
        if (pos.length !== 2) return usage(2);
        fs.writeFileSync(abs(pos[1]), incFromBin(fs.readFileSync(abs(pos[0]))));
        return { code: 0 };
      }
      case "msg-reencoder": {
        if (pos.length !== 3) return usage(3);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(abs(pos[0])));
        fs.writeFileSync(abs(pos[1]), msgReencode(text, pos[2]), "latin1");
        return { code: 0 };
      }
      case "n64-checksummer": {
        if (pos.length !== 2) return usage(2);
        const out = n64ChecksumUpdate(fs.readFileSync(abs(pos[0])));
        fs.mkdirSync(path.dirname(abs(pos[1])), { recursive: true });
        fs.writeFileSync(abs(pos[1]), out);
        return { code: 0 };
      }
      case "rom-compressor": {
        if (pos.length !== 5) return usage(5);
        const [inRom, outRom, elf, segments, version] = pos;
        const scratch = path.join(tmpRoot, `romc-${randomUUID().slice(0, 8)}`);
        fs.mkdirSync(scratch, { recursive: true });
        let n = 0;
        // crunch64's gzip and vanilla zlib's raw deflate, as WASM, over files.
        const viaTool = async (tool, argsFor, input) => {
          const i = path.join(scratch, `in${n}`), o = path.join(scratch, `out${n++}`);
          fs.writeFileSync(i, input);
          const r = await decompTool(tool, argsFor(i, o), { cwd: scratch });
          if (r.exitCode !== 0) throw new Error(`${tool} failed: ${r.log ?? ""}`);
          return fs.readFileSync(o);
        };
        try {
          const r = await romCompress({
            inRom: fs.readFileSync(abs(inRom)), elf: fs.readFileSync(abs(elf)), segmentsCsv: fs.readFileSync(abs(segments), "utf8"),
            version, padRom: flag("-p", "--pad-rom"), cwd,
            gzip: (bytes, level, smallMem) => viaTool("crunch64", (i, o) => ["compress", "gzip", i, o, "--level", String(level), ...(smallMem ? ["--small-mem"] : [])], bytes),
            zlibRaw: (bytes, level) => viaTool("raw-deflate", (i, o) => [String(level), i, o], bytes),
          });
          fs.writeFileSync(abs(outRom), r.rom);
          return { code: 0, log: r.log };
        } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      }
      case "rom-decompressor": {
        if (pos.length !== 4) return usage(4);
        const [inRom, outRom, segments, version] = pos;
        const r = romDecompress({
          inRom: fs.readFileSync(abs(inRom)), segmentsCsv: fs.readFileSync(abs(segments), "utf8"), version,
          baseromHashes: parseBaseromHashes(fs.readFileSync(abs(cls.script), "utf8")),
        });
        fs.writeFileSync(abs(outRom), r.rom);
        return { code: 0, stdout: Buffer.from(r.log) };
      }
      case "extract-compressed-segments": {
        if (pos.length !== 3) return usage(3);
        const [inRom, segments, version] = pos;
        const r = extractCompressedSegments({ inRom: fs.readFileSync(abs(inRom)), segmentsCsv: fs.readFileSync(abs(segments), "utf8"), version });
        for (const f of r.files) { fs.mkdirSync(path.dirname(abs(f.path)), { recursive: true }); fs.writeFileSync(abs(f.path), f.bytes); }
        return { code: 0, stdout: Buffer.from(r.log) };
      }
      case "mio0-extract": {
        // sys.argv[1] is the ROM; later arguments are ignored.
        if (args.length < 1) return { code: 1, stdout: Buffer.from("Usage: python mio0_extract.py <input_rom>\n") };
        const offsets = parseMio0Offsets(fs.readFileSync(abs(cls.script), "utf8"));
        const r = mio0Extract({ rom: fs.readFileSync(abs(args[0])), offsets });
        for (const d of r.dirs) fs.mkdirSync(abs(d), { recursive: true });
        for (const f of r.files) fs.writeFileSync(abs(f.path), f.bytes);
        return { code: 0, stdout: Buffer.from(r.log) };
      }
    }
  } catch (e) { return { code: 1, log: `${cls.script}: ${e.message}\n` }; }
  throw new Unsupported(`no runner for ${cls.kind}`);
}

function cprintf(args) {
  const fmt = args[0] ?? "";
  let k = 1;
  const esc = (s) => s.replace(/\\(n|t|\\|033|e|0[0-7]{0,3}|")/g, (m, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "\\" ? "\\" : c === '"' ? '"' : c === "e" || c === "033" ? "\x1b" : String.fromCharCode(parseInt(c, 8))));
  return esc(fmt).replace(/%([-0-9.]*)([sdxX%])/g, (m, w, t) => (t === "%" ? "%" : String(args[k++] ?? "")));
}

/** sha1sum / md5sum, including -c / --check / --status. */
function sha1sum(args, cwd, algo = "sha1") {
  const hexLen = algo === "md5" ? 32 : 40;
  const status = args.includes("--status");
  const checkIdx = args.indexOf("-c");
  const files = args.filter((a) => !a.startsWith("-"));
  if (checkIdx >= 0 || args.includes("--check")) {
    let ok = true, out = "";
    for (const list of files) {
      for (const l of fs.readFileSync(path.resolve(cwd, list), "utf8").split("\n")) {
        const m = new RegExp("^([0-9a-fA-F]{" + hexLen + "})\\s+\\*?(.+)$").exec(l.trim());
        if (!m) continue;
        let got = null;
        try { got = createHash(algo).update(fs.readFileSync(path.resolve(cwd, m[2]))).digest("hex"); } catch { got = null; }
        const pass = got === m[1].toLowerCase();
        ok &&= pass;
        if (!status) out += `${m[2]}: ${pass ? "OK" : "FAILED"}\n`;
      }
    }
    return { code: ok ? 0 : 1, stdout: Buffer.from(out) };
  }
  const out = files.map((f) => `${createHash(algo).update(fs.readFileSync(path.resolve(cwd, f))).digest("hex")}  ${f}\n`).join("");
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
 * `ido: { programs, env, cwd }` is threaded into every IDO compile the step
 * makes (including asm-processor's compile; asm-processor itself keeps the
 * step's cwd): pass-module overrides, extra environment, and the directory cc
 * runs in (where -K intermediates land).
 * For an IDO or asm-processor step `log` holds the passes' stderr and stdout.
 * @returns {Promise<{code:number, log:string, stdout?:Buffer, kind:string, unsupported?:string}>}
 */
/** @param {{cwd:string, tmpRoot:string, stdin?:Buffer, ido?:{programs?:Record<string,string>, env?:Record<string,string>, cwd?:string}}} [o] */
export async function runArgv(argv, { cwd, tmpRoot, stdin, ido } = {}) {
  const cls = classifyCommand(argv, cwd);
  if (cls.kind === "unsupported") return { code: 127, log: "", kind: cls.kind, unsupported: cls.reason };
  try {
    const r = await runOne(argv, cls, { cwd, tmpRoot, stdin, ido });
    return { code: r.code, log: (r.log ?? "") + (r.stdout && cls.kind !== "print" ? "" : ""), stdout: r.stdout, kind: cls.kind };
  } catch (e) {
    if (e instanceof Unsupported) return { code: 127, log: "", kind: cls.kind, unsupported: e.message };
    throw e;
  }
}

/**
 * assemble_rsp.py: assemble one RSP source with armips in an isolated scratch
 * directory beside the output, check the generated size, publish atomically.
 * The --assembler path names the project's armips; romdev runs its WASM armips.
 */
async function assembleRsp(args, { cwd }) {
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--(assembler|source|output|size)(?:=(.*))?$/.exec(args[i]);
    if (m) opt[m[1]] = m[2] ?? args[++i];
  }
  for (const k of ["assembler", "source", "output", "size"]) if (opt[k] == null) return { code: 2, log: `assemble_rsp: --${k} is required\n` };
  const size = Number(opt.size);
  const source = path.resolve(cwd, opt.source), output = path.resolve(cwd, opt.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(path.dirname(output), "rsp-"));
  try {
    fs.copyFileSync(source, path.join(scratch, path.basename(source)));
    const r = await armips([path.basename(source)], { cwd: scratch });
    if (r.exitCode !== 0) return { code: 1, log: r.log };
    const generated = path.join(scratch, path.basename(source).replace(/\.[^.]*$/, "") + ".bin");
    const got = fs.statSync(generated).size;
    if (got !== size) return { code: 1, log: `${path.basename(source)}: expected ${size} bytes, got ${got}\n` };
    fs.renameSync(generated, output);
    return { code: 0, log: r.log };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/**
 * A recursive `$(MAKE) [-C dir] [VAR=value ...] targets`: romdev reads that
 * directory's Makefile with the command-line variables and builds the targets
 * through the same WASM/JS dispatch. -j/-s/-k style flags are accepted and
 * ignored (the outer build already schedules and reports).
 */
async function subMake(args, { cwd, tmpRoot, always = false }) {
  let dir = cwd, makefile = "Makefile";
  const overrides = {}, targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C") dir = path.resolve(dir, args[++i]);
    else if (a.startsWith("-C")) dir = path.resolve(dir, a.slice(2));
    else if (a === "-f") makefile = args[++i];
    else if (/^-j\d*$/.test(a) && args[i + 1] && /^\d+$/.test(args[i + 1])) i++;
    else if (a.startsWith("-")) continue;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { const e = a.indexOf("="); overrides[a.slice(0, e)] = a.slice(e + 1); }
    else targets.push(a);
  }
  const { loadMakefile, buildGoal } = await import("./build.js");
  const mk = await loadMakefile(dir, { makefile, overrides });
  let log = "";
  for (const t of targets.length ? targets : ["all"]) {
    // The outer build's -B (always) reaches the sub-make, as MAKEFLAGS carries it.
    const r = await buildGoal(mk, t, { tmpRoot, jobs: 1, always });
    log += Object.values(r.logs).join("");
    if (!r.ok) return { code: 2, log: log + `make: ${r.failed?.message ?? "failed"}\n` + (r.failed?.log ?? "") };
    if (r.keptPrebuilt.length) return { code: 127, log: log + r.keptPrebuilt.map((k) => `cannot rebuild ${k.target}: ${k.reason}\n`).join("") };
  }
  return { code: 0, log };
}

/** Quote one word for /bin/sh. */
export function shellQuote(a) { return /^[\w@%+=:,./-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'"; }

/**
 * Rewrite every command word of a recipe line through `map(argv) -> argv`
 * and render it back to a line (env assignments, pipes, ;/&&/|| and
 * redirections preserved).
 */
export function mapRecipeLine(line, map) {
  return parseShell(line).map(({ op, pipeline }) => {
    const body = pipeline.map((c) => [
      ...Object.entries(c.env).map(([k, v]) => `${k}=${shellQuote(v)}`),
      ...map(c.argv).map(shellQuote),
      ...c.redirects.map((r) => `${r.fd === 2 ? "2" : r.fd === 0 ? "" : ""}${r.op === ">&" ? ">&" : r.op} ${shellQuote(r.target)}`),
    ].join(" ")).join(" | ");
    return (op ? `${op} ` : "") + body;
  }).join(" ");
}

// splat's `split` command line -> romdev-splat. The splat, spimdisasm and
// rabbitizer versions are the ones the project pins (uv.lock, requirements,
// a vendored copy), read from the project directory.
const SPLAT_FLAGS = { "--verbose": "verbose", "--use-cache": "useCache", "--skip-version-check": "skipVersionCheck", "--stdout-only": "stdoutOnly", "--disassemble-all": "disassembleAll", "--make-full-disasm-for-code": "makeFullDisasmForCode" };
async function runSplat(args, { cwd }) {
  const a = args[0] === "split" ? args.slice(1) : args;
  if (args[0] && args[0] !== "split" && !args[0].endsWith(".yaml") && !args[0].endsWith(".yml")) throw new Unsupported(`splat subcommand '${args[0]}' has no romdev port (only split)`);
  const configs = [], o = {};
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (SPLAT_FLAGS[x]) o[SPLAT_FLAGS[x]] = true;
    else if (x === "--modes") { o.modes = []; while (i + 1 < a.length && !a[i + 1].startsWith("-")) o.modes.push(a[++i]); }
    else if (x.startsWith("-")) throw new Unsupported(`splat option '${x}' is not supported by romdev-splat`);
    else configs.push(x);
  }
  if (!configs.length) return { code: 2, log: "splat split: at least one config yaml is required\n" };
  let out = "";
  const r = await splatSplit(configs, { ...o, cwd, projectDir: cwd, splatVersion: "auto", onOutput: (_stream, text) => { out += text; } });
  return { code: r.exitCode, log: out || `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// toolchain.js - the decomp domain's WASM toolchain: IDO (built by the user, see
// idoDir) and the mips-linux-gnu binutils (romdev-toolchain-mips-gcc), run in romdev's
// isolated WASM worker against the project's real tree. Nothing here spawns a
// host binary.
//
//   execWasm({ argv, cwd })     run one program (argv[0] names it, see toolName)
//   idoCompile(...)             IDO cc with its passes as sibling modules
//   binutils(tool, args, ...)   as / ld / objcopy / objdump
//
// A project's build names its tools by host path or PATH name
// ("tools/ido-static-recomp/build/5.3/out/cc", "mips-linux-gnu-as"); toolName()
// maps those onto the shipped modules, so a recipe step taken from the
// project's own Makefile runs unchanged.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HANDLER = fileURLToPath(new URL("./wasm-run.js", import.meta.url));

export const IDO_VERSIONS = ["5.3", "7.1"];
const IDO_PROGRAMS = ["cc", "acpp", "cfe", "uopt", "ugen", "as0", "as1", "ujoin", "uld", "umerge", "usplit"];
const BINUTILS = ["as", "ld", "objcopy", "objdump"];
// gcc families decomp projects pin, as shipped by romdev-toolchain-decomp-gcc.
// Each maps the program names the driver runs to its modules; `binutilsAs`
// families assemble with romdev-toolchain-mips-gcc's mips-linux-gnu-as.
export const DECOMP_GCC = {
  "kmc-2.7.2": { dir: "kmc-2.7.2", programs: ["gcc", "cpp", "cc1", "as"], aliases: { xgcc: "gcc", cccp: "cpp" } },
  "egcs-1.1.2": { dir: "egcs-1.1.2", programs: ["gcc", "cpp", "cc1", "as"], aliases: { xgcc: "gcc", cccp: "cpp" } },
  // PS1: projects mostly run cc1 directly (decompals/old-gcc gcc-2.6.3-psx);
  // the driver's as step is mips-linux-gnu-as (its specs pass -EL).
  "psx-gcc-2.6.3": { dir: "psx-gcc-2.6.3", programs: ["cc1", "cpp", "gcc"], binutilsAs: true, aliases: { "cc1-psx-26": "cc1", cccp: "cpp", xgcc: "gcc" } },
  // relocatable: run with GCC_EXEC_PREFIX=<dir>/lib/gcc/, so the tool include
  // dir is <dir>/mips-linux-gnu/include (where stdc-predef.h ships, the header
  // Debian's cross cpp pre-includes) and no host directory is searched.
  "mips-linux-gnu-14.2": {
    dir: "mips-linux-gnu-14.2", programs: ["gcc", "cpp", "cc1"], binutilsAs: true, relocatable: true,
    aliases: { "mips-linux-gnu-gcc": "gcc", "mips-linux-gnu-cpp": "cpp", "mips-linux-gnu-cc1": "cc1", xgcc: "gcc" },
  },
};
// Command-line tools decomp builds run (romdev-toolchain-decomp-gcc
// wasm/tools/, scripts/build-decomp-rust-tools.sh): decompals' Rust tools,
// plus vanilla zlib's raw deflate for ports of Python compressors.
// A PS1 decomp project's own string encoder (the compile pipeline pipes
// through it) is built from the pinned project tree the same way and ships as
// psx-str; recipes name it by the project's binary name, mapped below.
export const DECOMP_TOOLS = ["slinky-cli", "pigment64", "crunch64", "raw-deflate", "psx-str"];
// The PS1 project names its string encoder <project>_str.
const PROJECT_STR_RE = /^[a-z0-9]+_str$/;

function packageDir(pkg) {
  try {
    return path.dirname(fileURLToPath(import.meta.resolve(pkg)));
  } catch {
    const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", pkg);
    if (existsSync(path.join(sibling, "package.json"))) return sibling;
    throw Object.assign(new Error(`${pkg} is not installed (the decomp domain's WASM toolchain ships in it)`), { code: "TOOLCHAIN_MISSING" });
  }
}

/**
 * Directory holding one IDO version's modules (and err.english.cc, which cc reads via USR_LIB).
 *
 * IDO is SGI's proprietary compiler, so romdev does not ship it. Build it from a
 * romdev checkout with scripts/build-ido.sh (it lands in packages/romdev-toolchain-ido/wasm/,
 * which a checkout finds on its own), or point ROMDEV_IDO_DIR at a directory holding
 * the 5.3/ and 7.1/ module folders.
 */
export function idoDir(version) {
  if (!IDO_VERSIONS.includes(version)) throw Object.assign(new Error(`IDO ${version} is not supported (have ${IDO_VERSIONS.join(", ")})`), { code: "UNSUPPORTED_COMPILER" });
  let root = process.env.ROMDEV_IDO_DIR;
  if (!root) {
    try { root = path.join(packageDir("romdev-toolchain-ido"), "wasm"); } catch { root = null; }
  }
  const dir = root ? path.join(root, version) : null;
  if (!dir || !existsSync(path.join(dir, "cc.wasm"))) {
    throw Object.assign(new Error(`IDO ${version} is not installed${dir ? ` (no cc.wasm under ${dir})` : ""}. IDO is SGI's proprietary compiler and does not ship with romdev: build it to WASM from a romdev checkout with scripts/build-ido.sh, or set ROMDEV_IDO_DIR to a directory holding its 5.3/ and 7.1/ module folders.`), { code: "TOOLCHAIN_MISSING" });
  }
  return dir;
}

export function idoPrograms(version) {
  const dir = idoDir(version);
  return Object.fromEntries(IDO_PROGRAMS.map((p) => [p, path.join(dir, `${p}.mjs`)]));
}

export function binutilsGlue(tool) {
  if (!BINUTILS.includes(tool)) throw new Error(`no WASM binutils '${tool}'`);
  const p = path.join(packageDir("romdev-toolchain-mips-gcc"), "wasm", `mips-linux-gnu-${tool}.mjs`);
  if (!existsSync(p)) throw Object.assign(new Error(`${p} missing (scripts/build-mips-linux-binutils-wasm.sh)`), { code: "TOOLCHAIN_MISSING" });
  return p;
}

/**
 * Which decomp gcc a recipe names, by its path: the N64 SDK's KMC gcc 2.7.2
 * as projects vendor it (tools/gcc_kmc/<os>/2.7.2/gcc, .../2.7.2/as), EGCS
 * 1.1.2 likewise (tools/gcc_egcs/<os>/1.1.2-4/gcc), or the distro cross
 * compiler by its name (mips-linux-gnu-gcc, mips-linux-gnu-cpp).
 */
export function decompGccFamily(cmd) {
  const base = path.basename(cmd);
  if (/^mips-linux-gnu-(gcc|cpp)$/.test(base)) return "mips-linux-gnu-14.2";
  if (base === "cc1-psx-26" || (/^(cc1|cpp|cccp|gcc|xgcc)$/.test(base) && /(^|\/)gcc-2\.6\.3-psx(\/|$)/.test(path.dirname(cmd)))) return "psx-gcc-2.6.3";
  if (!/(^|\/)(gcc|xgcc|cpp|cccp|cc1|as)$/.test(base)) return null;
  if (/(^|\/)2\.7\.2(\/|$)/.test(path.dirname(cmd)) || /(^|[/_-])kmc([/_-]|$)/i.test(path.dirname(cmd))) return "kmc-2.7.2";
  if (/(^|\/)(1\.1\.2|2\.91\.66)(-\d+)?(\/|$)/.test(path.dirname(cmd)) || /(^|[/_-])egcs([/_-]|$)/i.test(path.dirname(cmd))) return "egcs-1.1.2";
  return null;
}

export function decompGccPrograms(family) {
  const f = DECOMP_GCC[family];
  if (!f) throw Object.assign(new Error(`no decomp gcc '${family}' (have ${Object.keys(DECOMP_GCC).join(", ")})`), { code: "UNSUPPORTED_COMPILER" });
  const dir = path.join(packageDir("romdev-toolchain-decomp-gcc"), "wasm", f.dir);
  if (!existsSync(path.join(dir, `${f.programs[0]}.wasm`))) throw Object.assign(new Error(`${dir} missing (${family === "mips-linux-gnu-14.2" ? "scripts/build-mips-linux-gcc-wasm.sh" : "scripts/build-decomp-gcc.sh"})`), { code: "TOOLCHAIN_MISSING" });
  const programs = Object.fromEntries(f.programs.map((p) => [p, path.join(dir, `${p}.mjs`)]));
  if (f.binutilsAs) programs.as = binutilsGlue("as");
  return programs;
}

/** Glue for one of the decomp build tools (slinky-cli, pigment64, crunch64, raw-deflate, psx-str). */
export function decompToolGlue(name) {
  if (!DECOMP_TOOLS.includes(name)) throw new Error(`no WASM decomp tool '${name}'`);
  const p = path.join(packageDir("romdev-toolchain-decomp-gcc"), "wasm", "tools", `${name}.mjs`);
  if (!existsSync(p)) throw Object.assign(new Error(`${p} missing (scripts/build-decomp-rust-tools.sh)`), { code: "TOOLCHAIN_MISSING" });
  return p;
}

/** Run a decomp build tool as WASM on the real tree (stdin: bytes piped in; stdoutBinary: stdout as a Buffer). */
export function decompTool(name, args, { cwd, timeoutMs, stdin, stdoutBinary = false } = {}) {
  return execWasm({ argv: [name, ...args], cwd, programs: { [name]: decompToolGlue(name) }, stdin, stdoutBinary, timeoutMs });
}

/**
 * Run a decomp gcc program (the driver or one of its passes) as WASM. The
 * driver's subprograms (cpp, cc1, as) run as sibling modules; stdin feeds
 * `gcc ... -`, stdout is returned as bytes (preprocessed text in the
 * project's encoding). TMPDIR is a fresh directory under tmpRoot.
 */
export async function decompGcc({ family, argv, cwd, tmpRoot, stdin, timeoutMs, env = {} }) {
  const programs = decompGccPrograms(family);
  const self = DECOMP_GCC[family].aliases[path.basename(argv[0])] ?? path.basename(argv[0]);
  const tmp = path.join(tmpRoot, `gcc-${randomUUID().slice(0, 8)}`);
  const reloc = DECOMP_GCC[family].relocatable ? { GCC_EXEC_PREFIX: path.join(path.dirname(programs.gcc), "lib", "gcc") + "/" } : {};
  mkdirSync(tmp, { recursive: true });
  try {
    return await execWasm({ argv, cwd, programs: { ...programs, [path.basename(argv[0])]: programs[self] }, env: { TMPDIR: tmp, ...reloc, ...env }, stdin, stdoutBinary: true, inheritStdin: true, timeoutMs });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** armips (RSP/MIPS assembler) glue, shipped in romdev-toolchain-mips-gcc. */
export function armipsGlue() {
  const p = path.join(packageDir("romdev-toolchain-mips-gcc"), "wasm", "armips.mjs");
  if (!existsSync(p)) throw Object.assign(new Error(`${p} missing (scripts/build-armips.sh)`), { code: "TOOLCHAIN_MISSING" });
  return p;
}

/** Run armips as WASM on the real tree (cwd = where its .create paths resolve). */
export function armips(args, { cwd, timeoutMs } = {}) {
  return execWasm({ argv: ["armips", ...args], cwd, programs: { armips: armipsGlue() }, timeoutMs });
}

/**
 * Classify a program named by a build recipe.
 * @returns {{kind:'ido', version:string, program:string} | {kind:'binutils', tool:string, prefix:string} | {kind:'armips'} | {kind:'decomp-tool', tool:string} | {kind:'decomp-gcc', family:string, program:string} | null}
 */
export function toolName(cmd) {
  const base = path.basename(cmd);
  const bin = /^(.*-)?(as|ld|objcopy|objdump)$/.exec(base);
  if (bin && bin[1] && /mips/.test(bin[1])) return { kind: "binutils", tool: bin[2], prefix: bin[1] };
  if (base === "armips") return { kind: "armips" };
  if (DECOMP_TOOLS.includes(base)) return { kind: "decomp-tool", tool: base };
  if (PROJECT_STR_RE.test(base)) return { kind: "decomp-tool", tool: "psx-str" };
  const fam = decompGccFamily(cmd);
  if (fam) return { kind: "decomp-gcc", family: fam, program: DECOMP_GCC[fam].aliases[base] ?? base };
  const ido = /(?:^|[/_-])(?:ido)?[/_-]?(5\.3|7\.1)(?:[/_]|$)/i.exec(cmd);
  if (ido && IDO_PROGRAMS.includes(base)) return { kind: "ido", version: ido[1], program: base };
  return null;
}

let runIsolated = null;
async function worker(job) {
  if (!runIsolated) ({ runIsolated } = await import("../toolchains/_worker/run.js"));
  return runIsolated({ handler: HANDLER, ...job });
}

/**
 * Run one WASM program in the worker.
 * @param {{argv:string[], cwd:string, programs:Record<string,string>, env?:Record<string,string>, stdin?:Buffer, stdoutBinary?:boolean, timeoutMs?:number, trace?:boolean}} a
 * @returns {Promise<{exitCode:number, stdout:string|Buffer, stderr:string, log:string, trace?:string[][], crash?:any}>}
 */
export async function execWasm({ argv, cwd, programs, env = {}, stdin, stdoutBinary = false, timeoutMs = 300_000, trace = false, inheritStdin = false }) {
  const r = await worker({
    argv, cwd, programs, env, trace, inheritStdin,
    stdinBase64: stdin ? Buffer.from(stdin).toString("base64") : undefined,
    stdoutBase64: stdoutBinary,
    timeoutMs,
  });
  if (r.crash || r.timedOut) return { exitCode: r.exitCode ?? -1, stdout: stdoutBinary ? Buffer.alloc(0) : "", stderr: r.log ?? "", log: r.log ?? "", crash: r.crash ?? { timedOut: true } };
  return { ...r, stdout: stdoutBinary ? Buffer.from(r.stdout ?? "", "base64") : r.stdout };
}

/**
 * Run a binutils tool (as/ld/objcopy/objdump) on the real tree.
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, log:string}>}
 */
export function binutils(tool, args, { cwd, stdin, timeoutMs } = {}) {
  const glue = binutilsGlue(tool);
  const name = `mips-linux-gnu-${tool}`;
  return execWasm({ argv: [name, ...args], cwd, programs: { [name]: glue }, stdin, timeoutMs });
}

/**
 * IDO cc (the driver) with every pass it can exec available as a sibling module.
 * TMPDIR is a fresh directory under `tmpRoot` (the project workspace; never /tmp),
 * removed afterwards.
 * `programs` overrides pass modules by name (e.g. { uopt: <diagnostic uopt glue> })
 * and `env` adds environment over { USR_LIB, TMPDIR }.
 * The returned `log` is the passes' stderr followed by their stdout (both
 * streams, not interleaved); `stdout` is stdout alone.
 * @param {{version:string, argv:string[], cwd:string, tmpRoot:string, trace?:boolean, programs?:Record<string,string>, env?:Record<string,string>}} a argv[0] is the path the project named cc by
 */
export async function idoCompile({ version, argv, cwd, tmpRoot, trace = false, timeoutMs, programs: extraPrograms = {}, env: extraEnv = {} }) {
  const programs = { ...idoPrograms(version), ...extraPrograms };
  const tmp = path.join(tmpRoot, `ido-${randomUUID().slice(0, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // cc is looked up by basename; its passes arrive as /usr/lib/<pass>, which
    // the recompiled libc redirects under USR_LIB (also where err.english.cc is).
    return await execWasm({
      argv, cwd, programs: { ...programs, [path.basename(argv[0])]: programs.cc },
      env: { USR_LIB: idoDir(version), TMPDIR: tmp, ...extraEnv }, trace, timeoutMs,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The files that ARE a recipe program when romdev runs it: the WASM modules
 * (IDO: every pass of that version plus its message catalog), or the JS port.
 * Measurement identities hash these, so a rebuilt module invalidates cached
 * verdicts the way a replaced host binary used to.
 */
export function programFiles(argv0, argv = []) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const t = toolName(argv0);
  try {
    if (t?.kind === "ido") {
      const dir = idoDir(t.version);
      return [...IDO_PROGRAMS.map((p) => path.join(dir, `${p}.wasm`)), path.join(dir, "err.english.cc")];
    }
    if (t?.kind === "binutils") return [binutilsGlue(t.tool).replace(/\.mjs$/, ".wasm")];
    if (t?.kind === "armips") return [armipsGlue().replace(/\.mjs$/, ".wasm")];
    if (t?.kind === "decomp-tool") return [decompToolGlue(t.tool).replace(/\.mjs$/, ".wasm")];
    if (t?.kind === "decomp-gcc") return Object.values(decompGccPrograms(t.family)).map((g) => g.replace(/\.mjs$/, ".wasm"));
  } catch { return []; }
  if (argv.some((a) => /asm-processor\/build\.py$/.test(a))) return [path.join(here, "asm-processor.js"), path.join(here, "euc-jp.js")];
  return [];
}

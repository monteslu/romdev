// toolchain.js - the decomp domain's WASM toolchain: IDO (romdev-toolchain-ido)
// and the mips-linux-gnu binutils (romdev-toolchain-mips-gcc), run in romdev's
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

function packageDir(pkg) {
  try {
    return path.dirname(fileURLToPath(import.meta.resolve(pkg)));
  } catch {
    const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", pkg);
    if (existsSync(path.join(sibling, "package.json"))) return sibling;
    throw Object.assign(new Error(`${pkg} is not installed (the decomp domain's WASM toolchain ships in it)`), { code: "TOOLCHAIN_MISSING" });
  }
}

/** Directory holding one IDO version's modules (and err.english.cc, which cc reads via USR_LIB). */
export function idoDir(version) {
  if (!IDO_VERSIONS.includes(version)) throw Object.assign(new Error(`IDO ${version} is not shipped (have ${IDO_VERSIONS.join(", ")})`), { code: "UNSUPPORTED_COMPILER" });
  const dir = path.join(packageDir("romdev-toolchain-ido"), "wasm", version);
  if (!existsSync(path.join(dir, "cc.wasm"))) throw Object.assign(new Error(`IDO ${version} WASM modules missing under ${dir} (scripts/build-ido.sh)`), { code: "TOOLCHAIN_MISSING" });
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
 * Classify a program named by a build recipe.
 * @returns {{kind:'ido', version:string, program:string} | {kind:'binutils', tool:string, prefix:string} | null}
 */
export function toolName(cmd) {
  const base = path.basename(cmd);
  const bin = /^(.*-)?(as|ld|objcopy|objdump)$/.exec(base);
  if (bin && bin[1] && /mips/.test(bin[1])) return { kind: "binutils", tool: bin[2], prefix: bin[1] };
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
export async function execWasm({ argv, cwd, programs, env = {}, stdin, stdoutBinary = false, timeoutMs = 300_000, trace = false }) {
  const r = await worker({
    argv, cwd, programs, env, trace,
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
 * @param {{version:string, argv:string[], cwd:string, tmpRoot:string, trace?:boolean}} a argv[0] is the path the project named cc by
 */
export async function idoCompile({ version, argv, cwd, tmpRoot, trace = false, timeoutMs }) {
  const programs = idoPrograms(version);
  const tmp = path.join(tmpRoot, `ido-${randomUUID().slice(0, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // cc is looked up by basename; its passes arrive as /usr/lib/<pass>, which
    // the recompiled libc redirects under USR_LIB (also where err.english.cc is).
    return await execWasm({
      argv, cwd, programs: { ...programs, [path.basename(argv[0])]: programs.cc },
      env: { USR_LIB: idoDir(version), TMPDIR: tmp }, trace, timeoutMs,
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
  } catch { return []; }
  if (argv.some((a) => /asm-processor\/build\.py$/.test(a))) return [path.join(here, "asm-processor.js"), path.join(here, "euc-jp.js")];
  return [];
}

// project.js - a registered matching-decompilation project: the manifest, its
// durable workspace, toolchain fingerprints, and the per-TU compile invocation
// derived from the project's OWN build system (never a guessed flag set - the
// Makefile's per-file exceptions are the truth). The Makefile is read by
// makefile.js (no host make); a manifest may instead declare a TU's recipe in
// build.recipes. Every tool the recipe names runs as WASM (toolchain.js).
//
// Workspace: ~/.romdev/decomp/<projectId>/ (or $ROMDEV_DECOMP_HOME/<id>). It
// lives OUTSIDE the source checkout so nothing lands in the project's git
// status, and it survives server restarts:
//   manifest.json        the registered project (versioned; re-import bumps)
//   context/             preprocessed TU contexts, keyed by a dependency hash
//   targets/<func>/      target.s / target.o assembled from the extracted asm
//   candidates/<func>/   every candidate ever compared: source + result JSON
//   jobs/<jobId>/        bounded search runs (permuter dir, log, best)
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Makefile } from "./makefile.js";
import { parseShell, classifyCommand } from "./recipe.js";
import { preprocess, parseDepsText, parseCppArgs } from "./cpp.js";
import { idoDir, binutilsGlue, toolName, programFiles } from "./toolchain.js";
import { loadSplatMap, loadSymbolAddrs, loadLinkerMap, findFunctionSource, parseSplatAsm, hx } from "./splat-map.js";
import { profileFor, readRomHeader, classifyInvocation, binutilsPrefixFromAssembler } from "./platform.js";
import { fileIdentities } from "./measurement.js";
import { revParseHead, statusPorcelain, GitUnsupportedError } from "../git/index.js";

export const DECOMP_HOME = process.env.ROMDEV_DECOMP_HOME || path.join(os.homedir(), ".romdev", "decomp");
export const MANIFEST_VERSION = 1;

export function workspaceDir(projectId) { return path.join(DECOMP_HOME, projectId); }

export async function sha1File(p) {
  const h = createHash("sha1");
  await new Promise((res, rej) => fs.createReadStream(p).on("data", (d) => h.update(d)).on("end", res).on("error", rej));
  return h.digest("hex");
}
export async function sha256File(p) {
  const h = createHash("sha256");
  await new Promise((res, rej) => fs.createReadStream(p).on("data", (d) => h.update(d)).on("end", res).on("error", rej));
  return h.digest("hex");
}
export function sha256Text(s) { return createHash("sha256").update(s).digest("hex"); }

/**
 * Environment the project's build declares (manifest build.env). Tools are no
 * longer found on PATH - every compiler/binutils step runs as WASM - so this
 * carries only what a project deliberately sets.
 */
export function projectEnv(manifest) {
  const env = {};
  for (const [k, v] of Object.entries(manifest.build?.env ?? {})) env[k] = v;
  return env;
}

/**
 * Register (or re-register) a project. Reads the splat yaml, verifies the ROM
 * hash, fingerprints the toolchain, captures the build adapter, and writes the
 * manifest. Never modifies the project's sources.
 */
export async function importProject({ id, root, splatYaml, rom, expectedSha1, buildCommand, makeTarget, sourceDir, buildPath, makeVariables, ido, notes }) {
  root = path.resolve(root);
  if (!fs.existsSync(root)) throw new Error(`project root '${root}' does not exist`);
  // Find the splat yaml.
  let yamlPath = splatYaml ? path.resolve(root, splatYaml) : null;
  if (!yamlPath) {
    const ys = (await readdir(root)).filter((f) => /\.ya?ml$/.test(f) && f !== "decomp.yaml" && f !== "config.yml");
    const withSegs = [];
    for (const y of ys) { try { const t = await readFile(path.join(root, y), "utf8"); if (/^segments:/m.test(t)) withSegs.push(y); } catch {} }
    if (withSegs.length !== 1) throw new Error(`could not pick the splat yaml in '${root}' (candidates: ${withSegs.join(", ") || "none"}). Pass splatYaml.`);
    yamlPath = path.join(root, withSegs[0]);
  }
  const map = await loadSplatMap(yamlPath);
  const o = map.options;
  const romPath = path.resolve(root, rom ?? o.target_path ?? "baserom.z64");
  if (!fs.existsSync(romPath)) throw new Error(`base ROM '${romPath}' not found (splat target_path). Pass rom.`);
  const romSha1 = await sha1File(romPath);
  const want = expectedSha1 ?? map.sha1 ?? null;
  if (want && want.toLowerCase() !== romSha1) throw new Error(`base ROM sha1 ${romSha1} != expected ${want} (from ${expectedSha1 ? "argument" : "splat yaml"}). Wrong ROM - refusing to register.`);
  const romBuf = await readFile(romPath, { encoding: null });
  const splatPlatform = map.options.platform ?? "n64";
  const profile = profileFor(splatPlatform);
  const { byteOrder, header: romHeader } = readRomHeader(profile, romBuf);

  // The build is run by romdev itself (build.js reads the Makefile); the
  // project's own command is recorded for humans, never executed.
  const buildCmd = buildCommand ?? (fs.existsSync(path.join(root, "tools", "matching-build.sh")) ? ["bash", "tools/matching-build.sh"] : ["make"]);
  const manifest = {
    manifestVersion: MANIFEST_VERSION, id, root, platform: profile.platform, splatPlatform, endian: profile.endian, platformVerified: profile.verified,
    platformNote: profile.verified ? undefined : `the ${splatPlatform} splat path shares the MIPS code with n64 but has not been run on a real ${profile.platform} checkout yet - treat verdicts as unproven until a known-matching function compares exact here`,
    registeredAt: new Date().toISOString(),
    splat: { yaml: path.relative(root, yamlPath), name: map.name, compiler: o.compiler ?? null, srcPath: sourceDir ?? o.src_path ?? "src", asmPath: o.asm_path ?? "asm", buildPath: buildPath ?? o.build_path ?? "build",
      symbolAddrs: (o.symbol_addrs_path ? [].concat(o.symbol_addrs_path) : []), elfPath: o.elf_path ?? null, ldScript: o.ld_script_path ?? null, basename: o.basename ?? null },
    rom: { path: path.relative(root, romPath), sha1: romSha1, expectedSha1: want, bytes: romBuf.length, byteOrder, header: romHeader },
    build: { command: buildCmd, cwd: ".", finalTarget: makeTarget ?? null, env: {}, makefile: "Makefile", makeVariables: makeVariables ?? {} },
    toolchain: null, notes: notes ?? null,
    git: await gitState(root),
  };
  manifest.toolchain = await fingerprintToolchain(manifest, ido);
  // Built ROM/ELF/map locations (from the Makefile's conventions via splat options).
  const built = builtArtifacts(manifest);
  manifest.built = built;
  await mkdir(workspaceDir(id), { recursive: true });
  await writeFile(path.join(workspaceDir(id), "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function builtArtifacts(manifest) {
  const b = manifest.splat.buildPath;
  const elf = manifest.splat.elfPath ? path.join(manifest.root, manifest.splat.elfPath) : null;
  const base = elf ? elf.replace(/\.elf$/, "") : null;
  return {
    elf: elf && path.relative(manifest.root, elf),
    map: base && path.relative(manifest.root, base + ".map"),
    rom: base && path.relative(manifest.root, base + (manifest.platform === "n64" ? ".z64" : manifest.platform === "ps1" ? ".exe" : ".bin")),
    buildDir: b,
  };
}

/**
 * The checkout's commit and dirty-path count: what `git rev-parse --short
 * HEAD` and the line count of `git status --porcelain` report, read by
 * romdev's pure-JS git reader (src/git/) with no git process. null where git
 * would have failed (not a repository, unborn HEAD) or the layout is one the
 * reader will not guess about.
 */
export async function gitState(root) {
  const ask = (fn) => { try { return fn(); } catch (e) { if (e instanceof GitUnsupportedError) return null; throw e; } };
  const head = ask(() => revParseHead(root, { short: true }));
  const dirty = ask(() => statusPorcelain(root));
  return { head, dirtyFiles: dirty === null ? null : dirty.length };
}

/**
 * Registered-vs-live project state.
 *
 * `manifest.git` is a SNAPSHOT taken when the project was imported. Reporting
 * it as `git` in a status response presents a possibly very old commit as the
 * current one: a real campaign ran nine days past its registration at a
 * different HEAD with 141 dirty paths while status still said the
 * registration-time HEAD and 18 dirty files. Nothing marked it stale.
 *
 * `buildFreshness` answers the other half - whether the built artifact is
 * newer than every source/header it was built from. "unknown" is a real
 * answer here and is never upgraded to "fresh".
 */
export async function projectFreshness(project) {
  const m = project.m;
  const liveGit = await gitState(m.root);
  const registeredGit = m.git ?? { head: null, dirtyFiles: null };
  const staleReasons = [];
  if (registeredGit.head && liveGit.head && registeredGit.head !== liveGit.head) {
    staleReasons.push(`HEAD moved: registered ${registeredGit.head} -> live ${liveGit.head}`);
  }
  if (registeredGit.dirtyFiles != null && liveGit.dirtyFiles != null && registeredGit.dirtyFiles !== liveGit.dirtyFiles) {
    staleReasons.push(`working tree changed: ${registeredGit.dirtyFiles} -> ${liveGit.dirtyFiles} modified/untracked paths`);
  }

  // Build freshness: is the built ROM newer than every source and header?
  let buildFreshness = "unknown", newestSourceMtime = null, builtMtime = null, newerThanBuild = [];
  try {
    const builtRel = m.built?.rom ?? null;
    const builtAbs = builtRel ? project.abs(builtRel) : null;
    if (builtAbs && fs.existsSync(builtAbs)) {
      builtMtime = fs.statSync(builtAbs).mtimeMs;
      const roots = [m.splat?.srcPath, "include"].filter(Boolean).map((r) => project.abs(r));
      for (const r of roots) {
        for (const f of walkFiles(r)) {
          if (!/\.(c|h|s|inc)$/i.test(f)) continue;
          const mt = fs.statSync(f).mtimeMs;
          if (newestSourceMtime == null || mt > newestSourceMtime) newestSourceMtime = mt;
          if (mt > builtMtime && newerThanBuild.length < 12) newerThanBuild.push(path.relative(m.root, f));
        }
      }
      buildFreshness = newerThanBuild.length ? "stale" : "fresh";
      if (newerThanBuild.length) staleReasons.push(`${newerThanBuild.length}+ source/header files are newer than the built ROM`);
    }
  } catch { buildFreshness = "unknown"; }

  return {
    registeredGit, liveGit,
    manifestState: staleReasons.length ? "stale" : "current",
    buildFreshness,
    builtAt: builtMtime ? new Date(builtMtime).toISOString() : null,
    newestSourceAt: newestSourceMtime ? new Date(newestSourceMtime).toISOString() : null,
    ...(newerThanBuild.length ? { sourcesNewerThanBuild: newerThanBuild } : {}),
    staleReasons,
    ...(staleReasons.length ? { nextAction: `decomp({op:'refresh', project:'${m.id}'}) re-captures git state, the splat map, the compiler identity and the call graph WITHOUT deleting stored evidence.` } : {}),
  };
}

/** Every file under a directory, depth-first; missing dirs yield nothing. */
function* walkFiles(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}

/**
 * Compiler / assembler / asm-processor identities with content hashes. The
 * compiler is whatever the project's OWN build invokes (one TU's recipe,
 * classified); the identities hashed are the WASM modules romdev runs for it.
 */
export async function fingerprintToolchain(manifest, idoHint) {
  const root = manifest.root;
  const out = { compiler: null, assembler: null, objdump: null, objcopy: null, asmProcessor: null, binutilsPrefix: null, runsAs: "wasm" };
  let inv = null;
  try {
    const firstTu = firstTranslationUnit(root, manifest.splat.srcPath);
    if (firstTu) inv = await new Project(manifest).compileInvocation(firstTu);
  } catch { inv = null; }
  const cls = inv ? classifyInvocation(inv.compile) : null;
  const idoCmd = cls?.kind === "ido" ? cls.compiler : idoHint ?? null;
  const idoVersion = idoCmd ? (/(?:^|[/_-])(5\.3|7\.1)(?:[/_]|$)/.exec(idoCmd)?.[1] ?? null) : null;
  if (cls?.kind === "ido" || idoHint) {
    let wasm = null;
    try { wasm = path.join(idoDir(idoVersion ?? "5.3"), "cc.wasm"); } catch { wasm = null; }
    out.compiler = { kind: "ido", version: idoVersion, path: idoCmd, fromInvocation: !!cls, runsAs: wasm ? "wasm" : "missing",
      wasm: wasm ? { module: path.relative(path.dirname(path.dirname(path.dirname(wasm))), wasm), sha256: await sha256File(wasm) } : null };
  } else if (cls && toolName(cls.compiler)?.kind === "decomp-gcc") {
    const fam = toolName(cls.compiler).family;
    const files = programFiles(cls.compiler);
    out.compiler = { kind: "gcc", family: fam, path: cls.compiler, fromInvocation: true, runsAs: files.length ? "wasm" : "missing",
      wasm: files.length ? { modules: files.map((f) => path.basename(f)), sha256: sha256Text((await Promise.all(files.map((f) => sha256File(f)))).join(",")) } : null };
  } else if (cls) {
    out.compiler = { kind: cls.kind, path: cls.compiler, fromInvocation: true, runsAs: "unsupported",
      note: `romdev runs IDO as WASM; a '${cls.kind}' compiler step has no WASM equivalent yet` };
  }
  out.binutilsPrefix = binutilsPrefixFromAssembler(cls?.assembler) ?? "mips-linux-gnu-";
  for (const [key, tool] of [["assembler", "as"], ["objdump", "objdump"], ["objcopy", "objcopy"]]) {
    try {
      const glue = binutilsGlue(tool);
      const wasm = glue.replace(/\.mjs$/, ".wasm");
      out[key] = { name: `mips-linux-gnu-${tool}`, path: `mips-linux-gnu-${tool}`, runsAs: "wasm", module: path.basename(wasm), sha256: await sha256File(wasm) };
    } catch { out[key] = null; }
  }
  const ap = path.join(root, "tools", "asm-processor", "asm_processor.py");
  if (fs.existsSync(ap)) out.asmProcessor = { path: path.relative(root, ap), sha256: await sha256File(ap), runsAs: "js-port (src/decomp/asm-processor.js)" };
  return out;
}

export async function loadManifest(projectId) {
  const p = path.join(workspaceDir(projectId), "manifest.json");
  let text;
  try { text = await readFile(p, "utf8"); } catch { throw Object.assign(new Error(`no registered project '${projectId}' (expected ${p}). Register it: decomp({op:'import', project:'${projectId}', root:'/abs/path'}).`), { code: "PROJECT_NOT_REGISTERED" }); }
  return JSON.parse(text);
}

export async function listProjects() {
  let ids = [];
  try { ids = await readdir(DECOMP_HOME); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try { const m = JSON.parse(await readFile(path.join(DECOMP_HOME, id, "manifest.json"), "utf8")); out.push({ id: m.id, root: m.root, platform: m.platform, registeredAt: m.registeredAt, romSha1: m.rom.sha1 }); } catch {}
  }
  return out;
}

/** A loaded project: manifest + splat map + symbols + linker map (lazy). */
export class Project {
  constructor(manifest) { this.m = manifest; this._map = null; this._syms = null; this._ld = null; }
  static async open(projectId) { return new Project(await loadManifest(projectId)); }
  get root() { return this.m.root; }
  get id() { return this.m.id; }
  get ws() { return workspaceDir(this.m.id); }
  get env() { return projectEnv(this.m); }
  abs(p) { return path.resolve(this.root, p); }

  async map() {
    const file = this.abs(this.m.splat.yaml), identity = JSON.stringify(await fileIdentities([file]));
    if (!this._map || identity !== this._mapIdentity) { this._map = await loadSplatMap(file); this._mapIdentity = identity; }
    return this._map;
  }
  async symbolAddrs() {
    const files = this.m.splat.symbolAddrs.map((p) => this.abs(p));
    const identity = JSON.stringify(await fileIdentities(files));
    if (!this._syms || identity !== this._symsIdentity) { this._syms = await loadSymbolAddrs(files); this._symsIdentity = identity; }
    return this._syms;
  }
  async linkerMap() {
    const p = this.m.built?.map ? this.abs(this.m.built.map) : null;
    if (!p || !fs.existsSync(p)) { this._ld = null; this._ldIdentity = null; return null; }
    const identity = JSON.stringify(await fileIdentities([p]));
    if (!this._ld || identity !== this._ldIdentity) {
      this._ld = await loadLinkerMap(p);
      this._ldIdentity = identity;
    }
    return this._ld;
  }

  /**
   * Where a TU's object sections live, from the splat map alone: each of the
   * TU's subsegments (c / .data / .rodata / .bss, named like the TU) gives its
   * section's VRAM. The fallback when the ROM has not been linked here (no
   * linker map); a linker map, when present, always wins.
   * @returns {Array<{section:string, va:number, from:'splat'}>}
   */
  async splatSectionPlacement(tuRel) {
    if (!tuRel) return [];
    const map = await this.map();
    const src = this.m.splat.srcPath.replace(/\/+$/, "");
    const name = tuRel.replace(new RegExp("^" + src.replace(/[.*+?^${}()|[\]\\]/g, "\\  /** Resolve a function by symbol name or VA to full identity + provenance. */") + "/"), "").replace(/\.c$/, "");
    const out = [];
    const kinds = { c: ".text", asm: ".text", hasm: ".text", ".data": ".data", data: ".data", ".rodata": ".rodata", rodata: ".rodata", ".bss": ".bss", bss: ".bss" };
    for (const seg of map.segments ?? []) {
      for (const sub of seg.subsegments ?? []) {
        if (sub.name !== name || !kinds[sub.type]) continue;
        const va = sub.vram ?? (seg.vram != null ? (seg.vram + (sub.romStart - seg.romStart)) >>> 0 : null);
        if (va == null || out.some((o) => o.section === kinds[sub.type])) continue;
        out.push({ section: kinds[sub.type], va, from: "splat" });
      }
    }
    return out;
  }

  /** Resolve a function by symbol name or VA to full identity + provenance. */
  async resolveFunction({ symbol, va, segment }) {
    const map = await this.map();
    const ld = await this.linkerMap();
    const syms = await this.symbolAddrs();
    let name = symbol ?? null;
    let address = va != null ? (va >>> 0) : null;
    if (name && address == null) {
      const rec = ld?.symbols.get(name) ?? (syms.get(name) ? { va: syms.get(name).va } : null);
      if (!rec) {
        // Last resort: the extracted asm carries the VA.
        const hit = findFunctionSource(this.root, this.m.splat.srcPath, name)[0];
        if (hit?.asmPath && fs.existsSync(this.abs(hit.asmPath))) address = parseSplatAsm(fs.readFileSync(this.abs(hit.asmPath), "utf8")).va;
        if (address == null) throw Object.assign(new Error(`symbol '${name}' is not in the linker map, the symbol_addrs files, or any GLOBAL_ASM pragma under ${this.m.splat.srcPath}/`), { code: "UNKNOWN_SYMBOL" });
      } else address = rec.va;
    }
    if (address == null) throw new Error("resolveFunction: pass symbol or va");
    const r = map.resolveVa(address, { segment });
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code, candidates: r.candidates });
    const res = r.resolved;
    let symbolNote;
    if (!name && ld) {
      // Reverse lookup: the .text symbol whose range contains the VA. Overlays
      // share VAs, so restrict to objects that belong to the resolved segment's
      // subsegments; a hit from another overlay is reported, never assumed.
      const seg = map.segment(res.segment);
      const subNames = new Set((seg?.subsegments ?? []).map((x) => path.basename(x.name)));
      const inSeg = (obj) => subNames.has(path.basename(obj, ".o"));
      let best = null, other = null;
      for (const s of ld.symbols.values()) {
        if (s.section !== ".text" || !s.size || s.name.endsWith(".NON_MATCHING")) continue;
        if (!(address >= s.va && address < s.va + s.size)) continue;
        if (inSeg(s.object)) { if (!best || s.va > best.va) best = s; }
        else if (!other) other = s;
      }
      if (best) name = best.name;
      else if (other) symbolNote = `no symbol of segment '${res.segment}' covers ${hx(address)}; '${other.name}' (object ${other.object}) does in another overlay at the same VA - not adopted`;
    }
    const src = name ? findFunctionSource(this.root, this.m.splat.srcPath, name) : [];
    const ldRec = name ? ld?.symbols.get(name) ?? null : null;
    // The target asm: the pragma's path when the function is still asm; otherwise
    // splat's extracted .s still exists under asm/<ver>/nonmatchings/ (splat keeps
    // it after a match) - search by name. Neither → the ROM bytes are the target.
    let targetAsm = null;
    if (src[0]?.asmPath && fs.existsSync(this.abs(src[0].asmPath))) targetAsm = { path: src[0].asmPath, from: "pragma" };
    else if (name) {
      const found = findAsmByName(this.abs(this.m.splat.asmPath), name);
      if (found) targetAsm = { path: path.relative(this.root, found), from: "asm-dir" };
    }
    let asmInfo = null;
    if (targetAsm) asmInfo = parseSplatAsm(fs.readFileSync(this.abs(targetAsm.path), "utf8"));
    let size = asmInfo?.sizeBytes ?? ldRec?.size ?? syms.get(name)?.size ?? null;
    let sizeFrom = size != null ? (asmInfo ? "asm" : ldRec ? "linker-map" : "symbol_addrs") : null;
    if (size == null && name && src[0]?.tu) {
      // A fully matched function in a project whose ROM is not linked here yet:
      // the size the project's own build gave it, from the TU's built object.
      const obj = this.abs(path.join(this.m.splat.buildPath, src[0].tu.replace(/\.c$/, ".o")));
      if (fs.existsSync(obj)) {
        const { symbolTable } = await import("./mips-obj.js");
        const s = (await symbolTable({ objdump: "mips-linux-gnu-objdump", objPath: obj, cwd: this.root })).get(name);
        if (s?.size) { size = s.size; sizeFrom = "built-object"; }
      }
    }
    return {
      symbol: name, va: address, vaHex: hx(address), segment: res.segment, overlay: res.overlay, romOffset: res.romOffset, romOffsetHex: res.romOffsetHex,
      kind: res.kind, subsegment: res.subsegment, sizeBytes: size, ...(sizeFrom === "built-object" ? { sizeFrom } : {}),
      source: src.length ? { tu: src[0].tu, line: src[0].line, state: src[0].state, asmPath: src[0].asmPath, duplicates: src.length > 1 ? src.slice(1).map((s) => s.tu) : undefined } : null,
      object: ldRec ? ldRec.object : null,
      targetAsm,
      asmVaAgrees: asmInfo ? asmInfo.va === address : null,
      asmRomOffsetAgrees: asmInfo ? asmInfo.romOffset === res.romOffset : null,
      candidates: r.candidates.length > 1 ? r.candidates.map((c) => c.segment) : undefined,
      symbolNote,
    };
  }

  /** Bytes of a resolved ROM range + a hash and a short preview. */
  async romSlice(romOffset, length) {
    const fd = await import("node:fs/promises");
    const h = await fd.open(this.abs(this.m.rom.path));
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await h.read(buf, 0, length, romOffset);
      const out = buf.subarray(0, bytesRead);
      return { bytes: out, sha1: createHash("sha1").update(out).digest("hex"), preview: out.subarray(0, 16).toString("hex") };
    } finally { await h.close(); }
  }

  /** The project's Makefile, read by makefile.js (re-read when any makefile it included changes). */
  async makefile() {
    const b = this.m.build ?? {};
    const mkFile = this.abs(b.makefile ?? "Makefile");
    const identity = JSON.stringify(await fileIdentities([mkFile, ...(this._mkIncludes ?? [])]));
    if (!this._mk || identity !== this._mkIdentity) {
      const mk = await Makefile.load(this.root, { makefile: b.makefile ?? "Makefile", overrides: { VERBOSE: "1", COLOR: "0", ...(b.makeVariables ?? {}) } });
      this._mkIncludes = (mk.vars.get("MAKEFILE_LIST")?.value ?? "").split(/\s+/).filter(Boolean).map((f) => this.abs(f));
      this._mk = mk;
      this._mkIdentity = JSON.stringify(await fileIdentities([mkFile, ...this._mkIncludes]));
    }
    return this._mk;
  }

  /**
   * The exact compile invocation for a TU, from the project's own build
   * configuration: the manifest's declared recipe (build.recipes[tu], a list
   * of shell command lines or argv arrays) if present, else the recipe the
   * project's Makefile gives the TU's object (target- and pattern-specific
   * variables applied, as make would). Returns argv arrays, never a shell
   * string the caller must re-parse.
   */
  async compileInvocation(tuRel) {
    const objRel = path.join(this.m.splat.buildPath, tuRel.replace(/\.c$/, ".o"));
    const declared = this.m.build?.recipes?.[tuRel] ?? this.m.build?.recipes?.[objRel] ?? null;
    let lines, source;
    if (declared) {
      lines = declared.map((x) => (Array.isArray(x) ? x.map(shellQuote).join(" ") : String(x)));
      source = "manifest";
    } else {
      const mk = await this.makefile();
      const r = mk.recipeFor(objRel);
      if (!r || !r.lines.length) throw Object.assign(new Error(`the Makefile has no recipe for ${objRel}`), { code: "NO_COMPILE_RECIPE" });
      lines = r.lines.map((l) => l.command);
      source = "makefile";
    }
    const steps = [];
    for (const line of lines) {
      const parsed = parseShell(line);
      const single = parsed.length === 1 && parsed[0].pipeline.length === 1 && !parsed[0].pipeline[0].redirects.length ? parsed[0].pipeline[0].argv : null;
      if (!single) {
        // A compile pipeline (`gcc -E x.c | iconv ... | gcc -x c -c -o x.o -`):
        // the step is the whole line; argv is the stage that writes the object.
        const stages = parsed.length === 1 ? parsed[0].pipeline : null;
        const writer = stages?.find((c) => c.argv.includes(objRel) && ["decomp-gcc", "ido", "asm-processor"].includes(classifyCommand(c.argv, this.root).kind));
        if (writer) steps.push({ argv: writer.argv, line, role: "compile", kind: classifyCommand(writer.argv, this.root).kind, pipeline: true });
        else steps.push({ argv: null, line, role: "other" });
        continue;
      }
      const argv = single;
      const cls = classifyCommand(argv, this.root);
      if (cls.kind === "print" || cls.kind === "noop") continue;
      const isCompile = ["asm-processor", "ido", "decomp-gcc"].includes(cls.kind) && argv.includes(objRel);
      const role = isCompile ? "compile" : cls.kind === "syntax-check" ? "syntax-check" : argv.includes(objRel) ? "post" : "other";
      steps.push({ argv, role, kind: cls.kind });
    }
    const compile = steps.find((s) => s.role === "compile");
    if (!compile) throw new Error(`could not find the compile step for ${tuRel} in its recipe (${steps.map((s) => s.argv?.[0] ?? s.line).join(", ")})`);
    return { tu: tuRel, object: objRel, steps, compile: compile.argv, post: steps.filter((s) => s.role === "post").map((s) => s.argv),
      // A pipeline compile runs as its full line; its identity covers every stage.
      ...(compile.pipeline ? { compileLine: compile.line } : {}),
      recipe: lines, source, fingerprint: sha256Text(JSON.stringify(compile.pipeline ? compile.line : compile.argv)).slice(0, 16) };
  }

  /**
   * Header dependencies of a TU, from the WASM preprocessor (cc1 -MM -MG, the
   * same answer gcc -MM gave), memoised on the identities of every file the
   * TU can reach so an unchanged tree never re-runs it.
   */
  async tuDependencies(tuRel, compileArgv) {
    // -I dir / -Idir and -DX / -D X both occur in real Makefiles.
    const cppArgs = parseCppArgs(compileArgv.slice(1));
    const inc = cppArgs.includes.flatMap((d) => ["-I", d]);
    const defs = cppArgs.defines;
    const args = ["-MM", "-MG", "-nostdinc", ...inc, ...defs, "-D_LANGUAGE_C", "-x", "c", "-std=gnu89", "-fno-builtin", tuRel];
    const { includeClosure } = await import("./cpp.js");
    const closure = includeClosure(this.root, [tuRel], { includes: inc.filter((a) => a !== "-I") });
    const key = sha256Text(JSON.stringify({ args, files: await fileIdentities(closure.files) }));
    this._depMemo ??= new Map();
    if (this._depMemo.has(key)) return this._depMemo.get(key);
    const r = await preprocess({ cwd: this.root, args });
    const out = r.exitCode !== 0 || r.deps == null
      ? { ok: false, error: (r.log || `preprocessor exit ${r.exitCode}`).slice(0, 400), deps: [] }
      : { ok: true, deps: parseDepsText(r.deps, { exclude: [tuRel] }) };
    if (this._depMemo.size > 2000) this._depMemo.clear();
    this._depMemo.set(key, out);
    return out;
  }
}

function shellQuote(a) { return /^[\w@%+=:,./-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'"; }

/** Hash of a TU + all its header deps + the compile fingerprint: the cache key for contexts and objects. */
export async function dependencyHash(project, tuRel, invocation) {
  const deps = await project.tuDependencies(tuRel, invocation.compile);
  const h = createHash("sha256");
  h.update(invocation.fingerprint);
  h.update(await readFile(project.abs(tuRel)));
  const files = [];
  for (const d of deps.deps) {
    const p = project.abs(d);
    try { h.update(d); h.update(await readFile(p)); files.push(d); } catch { h.update("missing:" + d); }
  }
  return { hash: h.digest("hex").slice(0, 20), deps: files, depsOk: deps.ok, depsError: deps.error };
}

/** Find `<name>.s` under an asm tree (splat keeps extracted functions after they match). */
function findAsmByName(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const want = name + ".s";
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === want) return full;
    }
  }
  return null;
}

/** The first .c file under src/ (to capture a representative compile invocation). */
function firstTranslationUnit(root, srcDir) {
  const stack = [path.join(root, srcDir)];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const e of ents) { const full = path.join(d, e.name); if (e.isDirectory()) stack.push(full); else if (e.name.endsWith(".c") && !e.name.endsWith(".inc.c")) return path.relative(root, full); }
  }
  return null;
}

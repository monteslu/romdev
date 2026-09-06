// project.js — a registered matching-decompilation project: the manifest, its
// durable workspace, toolchain fingerprints, and the per-TU compile invocation
// captured from the project's OWN build system (never re-derived from a
// guessed flag set — the Makefile's per-file exceptions are the truth).
//
// Workspace: ~/.romdev/decomp/<projectId>/ (or $ROMDEV_DECOMP_HOME/<id>). It
// lives OUTSIDE the source checkout so nothing lands in the project's git
// status, and it survives server restarts:
//   manifest.json        the registered project (versioned; re-import bumps)
//   context/             preprocessed TU contexts, keyed by a dependency hash
//   targets/<func>/      target.s / target.o assembled from the extracted asm
//   candidates/<func>/   every candidate ever compared: source + result JSON
//   jobs/<jobId>/        bounded search runs (permuter dir, log, best)
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { run } from "./mips-obj.js";
import { loadSplatMap, loadSymbolAddrs, loadLinkerMap, findFunctionSource, parseSplatAsm, hx } from "./splat-map.js";
import { profileFor, readRomHeader, classifyInvocation, binutilsPrefixFromAssembler } from "./platform.js";

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

/** Environment the project's build wrapper establishes (unpacked binutils etc.). */
export function projectEnv(manifest) {
  const env = {};
  const tc = path.join(manifest.root, ".toolchains", "mips", "usr");
  if (fs.existsSync(path.join(tc, "bin"))) {
    env.PATH = path.join(tc, "bin") + ":" + process.env.PATH;
    env.LD_LIBRARY_PATH = path.join(tc, "lib", "x86_64-linux-gnu") + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
  }
  for (const [k, v] of Object.entries(manifest.build?.env ?? {})) env[k] = v;
  return env;
}

/**
 * Register (or re-register) a project. Reads the splat yaml, verifies the ROM
 * hash, fingerprints the toolchain, captures the build adapter, and writes the
 * manifest. Never modifies the project's sources.
 */
export async function importProject({ id, root, splatYaml, rom, expectedSha1, buildCommand, makeTarget, sourceDir, ido, notes }) {
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
  if (want && want.toLowerCase() !== romSha1) throw new Error(`base ROM sha1 ${romSha1} != expected ${want} (from ${expectedSha1 ? "argument" : "splat yaml"}). Wrong ROM — refusing to register.`);
  const romBuf = await readFile(romPath, { encoding: null });
  const splatPlatform = map.options.platform ?? "n64";
  const profile = profileFor(splatPlatform);
  const { byteOrder, header: romHeader } = readRomHeader(profile, romBuf);

  const buildCmd = buildCommand ?? (fs.existsSync(path.join(root, "tools", "matching-build.sh")) ? ["bash", "tools/matching-build.sh"] : ["make"]);
  const manifest = {
    manifestVersion: MANIFEST_VERSION, id, root, platform: profile.platform, splatPlatform, endian: profile.endian, platformVerified: profile.verified,
    platformNote: profile.verified ? undefined : `the ${splatPlatform} splat path shares the MIPS code with n64 but has not been run on a real ${profile.platform} checkout yet — treat verdicts as unproven until a known-matching function compares exact here`,
    registeredAt: new Date().toISOString(),
    splat: { yaml: path.relative(root, yamlPath), name: map.name, compiler: o.compiler ?? null, srcPath: sourceDir ?? o.src_path ?? "src", asmPath: o.asm_path ?? "asm", buildPath: o.build_path ?? "build",
      symbolAddrs: (o.symbol_addrs_path ? [].concat(o.symbol_addrs_path) : []), elfPath: o.elf_path ?? null, ldScript: o.ld_script_path ?? null, basename: o.basename ?? null },
    rom: { path: path.relative(root, romPath), sha1: romSha1, expectedSha1: want, bytes: romBuf.length, byteOrder, header: romHeader },
    build: { command: buildCmd, cwd: ".", finalTarget: makeTarget ?? null, env: {} },
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

async function gitState(root) {
  const head = await run("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  const dirty = await run("git", ["-C", root, "status", "--porcelain"]);
  return { head: head.code === 0 ? head.stdout.trim() : null, dirtyFiles: dirty.code === 0 ? dirty.stdout.split("\n").filter(Boolean).length : null };
}

/** Compiler / assembler / python identities with content hashes. */
export async function fingerprintToolchain(manifest, idoHint) {
  const env = projectEnv(manifest);
  const root = manifest.root;
  const profile = profileFor(manifest.splatPlatform ?? manifest.platform);
  const out = { compiler: null, assembler: null, objdump: null, objcopy: null, python: null, asmProcessor: null, binutilsPrefix: null };
  // The compiler is whatever the project's OWN build invokes: capture one TU's command and classify it.
  let cls = null;
  try {
    const firstTu = firstTranslationUnit(root, manifest.splat.srcPath);
    if (firstTu) { const inv = await new Project(manifest).compileInvocation(firstTu); cls = classifyInvocation(inv.compile); }
  } catch { cls = null; }
  const idoPath = idoHint ? path.resolve(root, idoHint) : path.join(root, "tools", "ido-static-recomp", "build", "5.3", "out", "cc");
  if (cls?.compiler) {
    const abs = path.isAbsolute(cls.compiler) ? cls.compiler : fs.existsSync(path.join(root, cls.compiler)) ? path.join(root, cls.compiler) : (await run("bash", ["-lc", `command -v ${cls.compiler}`], { env, cwd: root })).stdout.trim() || null;
    const ver = abs && cls.kind === "gcc" ? (await run(abs, ["--version"], { env, cwd: root })).stdout.split("\n")[0]?.trim() : null;
    out.compiler = { kind: cls.kind, path: abs ? path.relative(root, abs).replace(/^\.\.\//, "") : cls.compiler, version: cls.kind === "ido" ? (/\/(\d+\.\d+)\//.exec(cls.compiler)?.[1] ?? null) : ver, sha256: abs && fs.existsSync(abs) ? await sha256File(abs) : null, fromInvocation: true };
    if (cls.kind === "ido") { const subHead = await run("git", ["-C", path.join(root, "tools", "ido-static-recomp"), "rev-parse", "HEAD"]); out.compiler.recompCommit = subHead.code === 0 ? subHead.stdout.trim() : null; }
  } else if (fs.existsSync(idoPath)) {
    const rel = path.relative(root, idoPath);
    const subHead = await run("git", ["-C", path.join(root, "tools", "ido-static-recomp"), "rev-parse", "HEAD"]);
    out.compiler = { kind: "ido", version: /\/(\d+\.\d+)\//.exec(rel)?.[1] ?? null, path: rel, sha256: await sha256File(idoPath), recompCommit: subHead.code === 0 ? subHead.stdout.trim() : null };
  }
  // binutils: the prefix the build's assembler uses, else the first available one for the platform.
  const prefixes = [binutilsPrefixFromAssembler(cls?.assembler), ...profile.binutilsPrefixes].filter(Boolean);
  for (const prefix of prefixes) {
    const w = await run("bash", ["-lc", `command -v ${prefix}as`], { env, cwd: root });
    if (w.stdout.trim()) { out.binutilsPrefix = prefix; break; }
  }
  for (const [key, tool] of [["assembler", "as"], ["objdump", "objdump"], ["objcopy", "objcopy"]]) {
    const name = (out.binutilsPrefix ?? profile.binutilsPrefixes[0]) + tool;
    const w = await run("bash", ["-lc", `command -v ${name}`], { env, cwd: root });
    const p = w.stdout.trim();
    if (!p) { out[key] = null; continue; }
    const v = await run(p, ["--version"], { env });
    out[key] = { name, path: p, version: v.stdout.split("\n")[0]?.trim() ?? null, sha256: await sha256File(p) };
  }
  const py = fs.existsSync(path.join(root, ".venv", "bin", "python3")) ? path.join(root, ".venv", "bin", "python3") : "python3";
  const pv = await run(py, ["--version"], { env });
  out.python = { path: py, version: pv.stdout.trim() || pv.stderr.trim() };
  const ap = path.join(root, "tools", "asm-processor", "asm_processor.py");
  if (fs.existsSync(ap)) out.asmProcessor = { path: path.relative(root, ap), sha256: await sha256File(ap) };
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

  async map() { if (!this._map) this._map = await loadSplatMap(this.abs(this.m.splat.yaml)); return this._map; }
  async symbolAddrs() { if (!this._syms) this._syms = await loadSymbolAddrs(this.m.splat.symbolAddrs.map((p) => this.abs(p))); return this._syms; }
  async linkerMap() {
    if (!this._ld) {
      const p = this.m.built?.map ? this.abs(this.m.built.map) : null;
      if (!p || !fs.existsSync(p)) return null;
      this._ld = await loadLinkerMap(p);
    }
    return this._ld;
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
      else if (other) symbolNote = `no symbol of segment '${res.segment}' covers ${hx(address)}; '${other.name}' (object ${other.object}) does in another overlay at the same VA — not adopted`;
    }
    const src = name ? findFunctionSource(this.root, this.m.splat.srcPath, name) : [];
    const ldRec = name ? ld?.symbols.get(name) ?? null : null;
    // The target asm: the pragma's path when the function is still asm; otherwise
    // splat's extracted .s still exists under asm/<ver>/nonmatchings/ (splat keeps
    // it after a match) — search by name. Neither → the ROM bytes are the target.
    let targetAsm = null;
    if (src[0]?.asmPath && fs.existsSync(this.abs(src[0].asmPath))) targetAsm = { path: src[0].asmPath, from: "pragma" };
    else if (name) {
      const found = findAsmByName(this.abs(this.m.splat.asmPath), name);
      if (found) targetAsm = { path: path.relative(this.root, found), from: "asm-dir" };
    }
    let asmInfo = null;
    if (targetAsm) asmInfo = parseSplatAsm(fs.readFileSync(this.abs(targetAsm.path), "utf8"));
    const size = asmInfo?.sizeBytes ?? ldRec?.size ?? syms.get(name)?.size ?? null;
    return {
      symbol: name, va: address, vaHex: hx(address), segment: res.segment, overlay: res.overlay, romOffset: res.romOffset, romOffsetHex: res.romOffsetHex,
      kind: res.kind, subsegment: res.subsegment, sizeBytes: size,
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

  /**
   * The exact compile invocation for a TU, from the project's own build
   * system (`make --always-make --dry-run`). Returns argv arrays, never a shell
   * string the caller must re-parse.
   */
  async compileInvocation(tuRel) {
    const objRel = path.join(this.m.splat.buildPath, tuRel.replace(/\.c$/, ".o"));
    const r = await run("make", ["--always-make", "--dry-run", "VERBOSE=1", "COLOR=0", objRel], { cwd: this.root, env: this.env, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`make --dry-run ${objRel} failed: ${(r.stderr || r.stdout).slice(-600)}`);
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const shellSplit = (s) => (s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((t) => t.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
    const steps = [];
    for (const l of lines) {
      if (/^(mkdir|printf|echo|:)\b/.test(l) || l === ":") continue;
      const argv = shellSplit(l);
      if (!argv.length) continue;
      const isCompile = argv.some((a) => a === tuRel) && argv.some((a) => a === objRel) && !/^gcc$|^clang$|^cc$/.test(argv[0]) || (argv.some((a) => a === objRel) && argv.some((a) => /ido|\/cc$/.test(a)));
      const isCheck = /^(gcc|clang|cc)$/.test(argv[0]) && argv.includes("-fsyntax-only");
      const isPost = argv.some((a) => a === objRel) && !isCompile && !isCheck;
      steps.push({ argv, role: isCompile ? "compile" : isCheck ? "syntax-check" : isPost ? "post" : "other" });
    }
    const compile = steps.find((s) => s.role === "compile");
    if (!compile) throw new Error(`could not find the compile step for ${tuRel} in make's dry run (${steps.length} steps: ${steps.map((s) => s.argv[0]).join(", ")})`);
    return { tu: tuRel, object: objRel, steps, compile: compile.argv, post: steps.filter((s) => s.role === "post").map((s) => s.argv),
      fingerprint: sha256Text(JSON.stringify(compile.argv)).slice(0, 16) };
  }

  /** Header dependencies of a TU via the host preprocessor (-MM). */
  async tuDependencies(tuRel, compileArgv) {
    const inc = compileArgv.filter((a, i, arr) => a === "-I" ? true : arr[i - 1] === "-I").reduce((acc, a, i, arr) => { if (a !== "-I") acc.push("-I", a); return acc; }, []);
    const defs = compileArgv.filter((a) => /^-D/.test(a));
    const r = await run("gcc", ["-MM", "-MG", "-nostdinc", ...inc, ...defs, "-D_LANGUAGE_C", "-x", "c", "-std=gnu89", "-fno-builtin", tuRel], { cwd: this.root, env: this.env });
    if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 400), deps: [] };
    const deps = r.stdout.replace(/\\\n/g, " ").split(/\s+/).filter((t) => t && !t.endsWith(":") && t !== tuRel);
    return { ok: true, deps };
  }
}

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

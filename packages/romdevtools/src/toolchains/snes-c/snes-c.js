// snes-c.js — SNES C build pipeline.
//
// Two modes:
//
//   pvsneslib: true  (default, R18)
//     Idiomatic SNES homebrew. Link against the bundled PVSnesLib runtime
//     (precompiled .obj files for crt0, libm, libtcc, libc + headers). The
//     `<snes.h>` API works out of the box — consoleDrawText, bgSetGfxPtr,
//     setMode, WaitForVBlank, padsCurrent, etc. This is what every modern
//     SNES homebrew tutorial uses; default = idiomatic.
//
//   pvsneslib: false  (minimum-viable)
//     Bare-metal. Original minimum crt0 + hdr.asm; bare `int main(void)`
//     compiles, but the user writes everything else (DMA, OAM, VBlank, etc.)
//     against direct register addresses. Useful as a baseline for educational
//     work or when you want zero runtime dependencies. R16's original
//     behavior.
//
// Pipeline (both modes): tcc-65816 → wla-65816 → wlalink.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { runTcc816 } from "../tcc816/tcc816.js";
import { runWla65816, runWlalink } from "../wladx/wladx.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Minimum-viable runtime (R16, original code).
const MINIMAL_LIB_DIR = path.resolve(__dirname, "..", "..", "platforms", "snes", "lib", "c");
// PVSnesLib bundled runtime (R18). Headers + the .asm SOURCE for the runtime
// (crt0/libc/libm/libtcc) — assembled from source in-build, not linked from a
// prebuilt .obj black box.
const PVSNESLIB_DIR = path.resolve(__dirname, "..", "..", "platforms", "snes", "lib", "pvsneslib");
const PVSNESLIB_INCLUDE = path.join(PVSNESLIB_DIR, "include");
const PVSNESLIB_SOURCE_DIR = path.join(PVSNESLIB_DIR, "source");

/**
 * Assemble PVSnesLib's runtime objects (crt0_snes / libm / libtcc / libc) FROM
 * its own .asm/.c SOURCE, replicating its Makefile: a SLOWROM comp_defs, tcc
 * libc_c.c → asm, then wla each library .asm (each .include's hdr.asm + its
 * feature siblings). Cached per-process — these don't change between user
 * builds, but an edit to the vendored source busts the cache (keyed on bytes).
 *
 * @returns {Promise<{ok:boolean, objs?:Record<string,Uint8Array>, stage?:string, log?:string}>}
 */
let _pvSnesLibObjsCache = null;
async function assemblePvSnesLibObjs() {
  const { readdir } = await import("node:fs/promises");
  const srcDir = PVSNESLIB_SOURCE_DIR;
  // Load every .asm/.inc in source/ + include/ as wla includes (the lib .asm
  // files .include hdr.asm + ~14 feature siblings).
  const includes = {};
  for (const f of await readdir(srcDir)) {
    if (/\.(asm|inc|i)$/i.test(f)) includes[f] = await readFile(path.join(srcDir, f), "utf-8");
  }
  for (const f of await readdir(PVSNESLIB_INCLUDE)) {
    if (/\.(asm|inc|i|h)$/i.test(f)) includes[f] = await readFile(path.join(PVSNESLIB_INCLUDE, f), "utf-8");
  }
  // Cache key folds in the library source bytes so an edit rebuilds.
  const cacheKey = Object.entries(includes).map(([k, v]) => k + ":" + v.length).join("|");
  if (_pvSnesLibObjsCache && _pvSnesLibObjsCache.key === cacheKey) return _pvSnesLibObjsCache.val;

  // SLOWROM comp_defs (matches our default LoROM/SlowROM hdr.asm). Available as
  // an include in case any unit references it.
  includes["comp_defs.asm"] = "; HIROM / FASTROM definitions\n.SLOWROM\n";

  let log = "";
  // libc.asm .include's libc_c.asm — generated from libc_c.c via tcc.
  const libcC = await readFile(path.join(srcDir, "libc_c.c"), "utf-8");
  const tcc = await runTcc816({ source: libcC, headers: includes });
  if (tcc.exitCode !== 0 || !tcc.asmSource) {
    return { ok: false, stage: "tcc(libc_c.c)", log: log + (tcc.log || "") };
  }
  // tcc emits a leading `.include "hdr.asm"`. libc_c.asm is .include'd INTO
  // libc.asm, which already includes hdr.asm — so strip tcc's copy to avoid a
  // duplicate .MEMORYMAP ("can be defined only once"). (This mirrors the
  // PVSnesLib Makefile, which sed-strips the same hdr include.)
  includes["libc_c.asm"] = tcc.asmSource.replace(/^\s*\.include\s+"hdr\.asm".*$/im, "");

  // Each unit is assembled to its OWN .obj, and each .include's hdr.asm (the
  // memory map) — one .MEMORYMAP per independent obj, which is correct. wla
  // resolves comp_defs.asm (.SLOWROM → LoROM branch) inside hdr.asm.
  const objs = {};
  for (const unit of ["crt0_snes", "libm", "libtcc", "libc"]) {
    const src = includes[unit + ".asm"];
    if (!src) return { ok: false, stage: `missing ${unit}.asm`, log };
    const wla = await runWla65816({ source: src, includes, options: ["-d"] });
    if (wla.exitCode !== 0 || !wla.object) {
      return { ok: false, stage: `wla(${unit}.asm)`, log: log + (wla.log || "") };
    }
    objs[unit + ".obj"] = wla.object;
  }
  const val = { ok: true, objs };
  _pvSnesLibObjsCache = { key: cacheKey, val };
  return val;
}

/**
 * Compile + assemble + link a C source to a SNES ROM.
 *
 * @param {Object} args
 * @param {string} [args.source] main C source text (single-file shortcut)
 * @param {Record<string, string>} [args.sources] multi-file project: {name: contents}.
 *   Files ending in .c are passed to tcc; .asm / .s files are assembled by
 *   wla-65816 directly. All resulting .obj files get linked together by
 *   wlalink, plus the PVSnesLib runtime libs (when pvsneslib:true). The
 *   canonical idiomatic shape: {"main.c": "...", "data.asm": "..."}.
 *   Use this when your project provides data symbols (tilfont, palfont,
 *   font.pic incbin'd via .asm, etc.) that the C side references.
 * @param {Record<string, string>} [args.headers] virtual C headers (visible to tcc via -I/work)
 * @param {string[]} [args.tccOptions] extra tcc flags
 * @param {string[]} [args.wlaOptions] extra wla-65816 flags
 * @param {boolean} [args.pvsneslib=true] link against the bundled PVSnesLib runtime
 *   (default). Pass false for the minimum-viable bare-main path.
 * @returns {Promise<{ok:boolean, binary:Uint8Array|null, log:string, exitCode:number, stage:string}>}
 */
export async function buildSnesC(args) {
  const headers = args.headers ?? {};
  const tccOptions = args.tccOptions ?? [];
  const wlaOptions = args.wlaOptions ?? [];
  const binaryIncludes = args.binaryIncludes ?? {};
  const sources = normalizeSnesSources(args);
  const usePvSnesLib = args.pvsneslib !== false;
  if (usePvSnesLib) {
    return buildWithPvSnesLib({ sources, headers, tccOptions, wlaOptions, binaryIncludes });
  }
  return buildMinimal({ sources, headers, tccOptions, wlaOptions, binaryIncludes });
}

/**
 * Normalize the caller's source input into a single map of
 * `{ filename: contents }`. Accepts either `source` (single C file
 * shortcut → `main.c`) or `sources` (already a map). Validates that
 * exactly one .c file is present — multi-C-source builds need their
 * own linker layout work and aren't yet supported.
 *
 * @param {{source?:string, sources?:Record<string,string>}} args
 * @returns {Record<string, string>}
 */
function normalizeSnesSources(args) {
  if (args.source && args.sources) {
    throw new Error("buildSnesC: pass either `source` or `sources`, not both.");
  }
  if (args.sources) {
    const cFiles = Object.keys(args.sources).filter((n) => /\.c$/i.test(n));
    if (cFiles.length === 0) {
      throw new Error("buildSnesC: `sources` must include at least one .c file.");
    }
    // Multiple .c files ARE supported: buildWithPvSnesLib compiles each to its
    // own .obj (tcc→wla) and links them all (Stage 1 + Stage 3). The genre
    // scaffolds ship main.c + snes_sfx.c and rely on this.
    return args.sources;
  }
  if (typeof args.source === "string") {
    return { "main.c": args.source };
  }
  throw new Error("buildSnesC: missing `source` or `sources`.");
}

/**
 * PVSnesLib link path — idiomatic SNES C homebrew.
 *
 * tcc's output references `hdr.asm`. We use PVSnesLib's example-style
 * hdr.asm (LoROM SlowROM, 4 slots, full SNES header, NMI/IRQ vectors
 * pointing at the symbols defined in crt0_snes.obj).
 *
 * tcc emits identifiers like `{WLA_FILENAME}` in section names so each
 * translation unit gets unique sections; we pass `-x` to wla so that
 * substitution fires. (We do that in wla-65816.js unconditionally.)
 */
async function buildWithPvSnesLib({ sources, headers, tccOptions, wlaOptions, binaryIncludes = {} }) {
  let log = "";
  const pvsnesHeaders = await loadPvSnesLibHeaders();
  const pvsnesHdr = await readFile(path.join(PVSNESLIB_DIR, "include", "hdr.asm"), "utf-8");
  // wla can `.include "<sibling>.asm"` from same dir, so all sources need
  // to land at /work. The includes map below mounts each at /work/<name>.
  // We also expose user-provided .asm/.s files as wla `.include` sources
  // so user code can chain them.
  const asmSiblings = {};
  for (const [name, contents] of Object.entries(sources)) {
    if (/\.(asm|s)$/i.test(name)) asmSiblings[name] = contents;
  }
  // User-provided C headers + PVSnesLib's own headers go into the tcc include
  // map. tcc only looks in /work (we use `-I /work`) so a flat namespace works.
  const tccHeaders = { ...pvsnesHeaders, ...headers };

  /** @type {Record<string, Uint8Array>} */
  const userObjs = {};
  // ── Stage 1: build each .c via tcc → .asm → .obj ────────────────
  const cFiles = Object.keys(sources).filter((n) => /\.c$/i.test(n));
  for (const cName of cFiles) {
    const tcc = await runTcc816({
      source: sources[cName],
      headers: tccHeaders,
      options: tccOptions,
    });
    log += `--- tcc-65816 (${cName}) ---\n` + (tcc.log || "(ok)") + "\n";
    if (tcc.exitCode !== 0 || !tcc.asmSource) {
      return { ok: false, binary: null, log, exitCode: tcc.exitCode || 1, stage: `tcc-65816 (${cName})`, ...(tcc.crash ? { crash: tcc.crash } : {}) };
    }
    // KEEP tcc's `.include "hdr.asm"` — wla resolves it via the includes
    // map below. (We strip it from library .obj builds where libc.asm
    // already includes hdr.asm; user code includes hdr.asm directly.)
    const wla = await runWla65816({
      source: tcc.asmSource,
      includes: { "hdr.asm": pvsnesHdr, ...asmSiblings },
      options: wlaOptions,
    });
    log += `--- wla-65816 (${cName} → .obj) ---\n` + (wla.log || "(ok)") + "\n";
    if (wla.exitCode !== 0 || !wla.object) {
      return { ok: false, binary: null, log, exitCode: wla.exitCode || 1, stage: `wla-65816 (${cName})`, ...(wla.crash ? { crash: wla.crash } : {}) };
    }
    const objName = cName.replace(/\.c$/i, ".obj");
    userObjs[objName] = wla.object;
  }

  // ── Stage 2: assemble each user .asm / .s sibling directly ──────
  for (const asmName of Object.keys(asmSiblings)) {
    const wla = await runWla65816({
      source: asmSiblings[asmName],
      includes: { "hdr.asm": pvsnesHdr, ...asmSiblings },
      binaryIncludes,
      options: wlaOptions,
    });
    log += `--- wla-65816 (${asmName} → .obj) ---\n` + (wla.log || "(ok)") + "\n";
    if (wla.exitCode !== 0 || !wla.object) {
      return { ok: false, binary: null, log, exitCode: wla.exitCode || 1, stage: `wla-65816 (${asmName})`, ...(wla.crash ? { crash: wla.crash } : {}) };
    }
    const objName = asmName.replace(/\.(asm|s)$/i, ".obj");
    userObjs[objName] = wla.object;
  }

  // ── Stage 3: assemble PVSnesLib runtime FROM SOURCE, then link ──
  const pvObjs = await assemblePvSnesLibObjs();
  if (!pvObjs.ok) {
    return { ok: false, binary: null, log: log + (pvObjs.log || ""), exitCode: 1, stage: `pvsneslib runtime: ${pvObjs.stage}`, runtime: "pvsneslib" };
  }
  const crt0Obj = pvObjs.objs["crt0_snes.obj"];
  const libmObj = pvObjs.objs["libm.obj"];
  const libtccObj = pvObjs.objs["libtcc.obj"];
  const libcObj = pvObjs.objs["libc.obj"];

  // PVSnesLib's linkfile convention puts crt0 first (reset-vector tie-break),
  // then libm/libtcc/libc, then user code. wlalink's order matters for which
  // section "wins" when sections collide.
  const userObjLines = Object.keys(userObjs).map((n) => `/work/${n}`).join("\n");
  const linkfile =
    "[objects]\n" +
    "/work/crt0_snes.obj\n" +
    "/work/libm.obj\n" +
    "/work/libtcc.obj\n" +
    "/work/libc.obj\n" +
    userObjLines + "\n";

  const link = await runWlalink({
    objects: {
      "crt0_snes.obj": crt0Obj,
      "libm.obj":      libmObj,
      "libtcc.obj":    libtccObj,
      "libc.obj":      libcObj,
      ...userObjs,
    },
    linkfile,
    // -d: disable label-arith opts (PVSnesLib's library .obj files were
    //     built with -d so user link must match). -A: cart-size check.
    // -c: allow duplicate labels (PVSnesLib's libc has known dupes between
    //     consoles/input regs that they ship with -c). -b: program output.
    options: ["-d", "-A", "-c", "-b"],
  });
  log += "--- wlalink ---\n" + (link.log || "(ok)") + "\n";
  if (link.exitCode !== 0 || !link.binary) {
    return { ok: false, binary: null, log, exitCode: link.exitCode || 1, stage: "wlalink", ...(link.crash ? { crash: link.crash } : {}) };
  }

  return {
    ok: true,
    binary: link.binary,
    log,
    exitCode: 0,
    stage: "done",
    runtime: "pvsneslib",
  };
}

/**
 * Minimum-viable path (R16 original behavior). No PVSnesLib runtime;
 * bundled original crt0.asm + hdr.asm support a bare `int main()`.
 */
async function buildMinimal({ sources, headers, tccOptions, wlaOptions, _binaryIncludes = {} }) {
  let log = "";
  const hdrAsm  = await readFile(path.join(MINIMAL_LIB_DIR, "hdr.asm"),  "utf-8");
  const crt0Asm = await readFile(path.join(MINIMAL_LIB_DIR, "crt0.asm"), "utf-8");

  // User-provided sibling .asm/.s, mounted into wla's include path so they
  // can chain via `.include`.
  const asmSiblings = {};
  for (const [name, contents] of Object.entries(sources)) {
    if (/\.(asm|s)$/i.test(name)) asmSiblings[name] = contents;
  }

  /** @type {Record<string, Uint8Array>} */
  const userObjs = {};
  const cFiles = Object.keys(sources).filter((n) => /\.c$/i.test(n));
  for (const cName of cFiles) {
    const tcc = await runTcc816({ source: sources[cName], headers, options: tccOptions });
    log += `--- tcc-65816 (${cName}) ---\n` + (tcc.log || "(ok)") + "\n";
    if (tcc.exitCode !== 0 || !tcc.asmSource) {
      return { ok: false, binary: null, log, exitCode: tcc.exitCode || 1, stage: `tcc-65816 (${cName})`, ...(tcc.crash ? { crash: tcc.crash } : {}) };
    }
    const wla = await runWla65816({
      source: tcc.asmSource,
      includes: { "hdr.asm": hdrAsm, ...asmSiblings },
      options: wlaOptions,
    });
    log += `--- wla-65816 (${cName} → .obj) ---\n` + (wla.log || "(ok)") + "\n";
    if (wla.exitCode !== 0 || !wla.object) {
      return { ok: false, binary: null, log, exitCode: wla.exitCode || 1, stage: `wla-65816 (${cName})`, ...(wla.crash ? { crash: wla.crash } : {}) };
    }
    const objName = cName.replace(/\.c$/i, ".o");
    userObjs[objName] = wla.object;
  }

  for (const asmName of Object.keys(asmSiblings)) {
    const wla = await runWla65816({
      source: asmSiblings[asmName],
      includes: { "hdr.asm": hdrAsm, ...asmSiblings },
      options: wlaOptions,
    });
    log += `--- wla-65816 (${asmName} → .obj) ---\n` + (wla.log || "(ok)") + "\n";
    if (wla.exitCode !== 0 || !wla.object) {
      return { ok: false, binary: null, log, exitCode: wla.exitCode || 1, stage: `wla-65816 (${asmName})`, ...(wla.crash ? { crash: wla.crash } : {}) };
    }
    const objName = asmName.replace(/\.(asm|s)$/i, ".o");
    userObjs[objName] = wla.object;
  }

  // crt0 from our minimum-viable runtime.
  const wlaCrt0 = await runWla65816({
    source: crt0Asm,
    includes: { "hdr.asm": hdrAsm },
    options: wlaOptions,
  });
  log += "--- wla-65816 (crt0.asm) ---\n" + (wlaCrt0.log || "(ok)") + "\n";
  if (wlaCrt0.exitCode !== 0 || !wlaCrt0.object) {
    return { ok: false, binary: null, log, exitCode: wlaCrt0.exitCode || 1, stage: "wla-65816 (crt0)", ...(wlaCrt0.crash ? { crash: wlaCrt0.crash } : {}) };
  }

  const userObjLines = Object.keys(userObjs).map((n) => `/work/${n}`).join("\n");
  const linkfile = "[objects]\n/work/crt0.o\n" + userObjLines + "\n";
  const link = await runWlalink({
    objects: { "crt0.o": wlaCrt0.object, ...userObjs },
    linkfile,
    options: ["-d", "-b"],
  });
  log += "--- wlalink ---\n" + (link.log || "(ok)") + "\n";
  if (link.exitCode !== 0 || !link.binary) {
    return { ok: false, binary: null, log, exitCode: link.exitCode || 1, stage: "wlalink", ...(link.crash ? { crash: link.crash } : {}) };
  }

  return {
    ok: true,
    binary: link.binary,
    log,
    exitCode: 0,
    stage: "done",
    runtime: "minimal",
  };
}

/**
 * Load every PVSnesLib header into a `{name → contents}` map so tcc's
 * `#include <snes.h>` resolves them out of MEMFS. tcc-65816 searches
 * `-I` paths in order; we mount them all at /work alongside user code.
 *
 * Caches across calls within the process — pvsneslib headers don't
 * change at runtime.
 */
let _headerCache = null;
async function loadPvSnesLibHeaders() {
  if (_headerCache) return _headerCache;
  const { readdir } = await import("node:fs/promises");
  const out = {};
  /**
   * @param {string} dir
   * @param {string} prefix path-prefix mounted into MEMFS (relative to /work)
   */
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "hdr.asm") continue;  // not a C header; lives elsewhere
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, rel);
      } else if (e.isFile() && /\.(h|hpp|inc)$/i.test(e.name)) {
        out[rel] = await readFile(full, "utf-8");
      }
    }
  }
  await walk(PVSNESLIB_INCLUDE, "");
  _headerCache = out;
  return out;
}

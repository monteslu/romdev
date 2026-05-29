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
// PVSnesLib bundled runtime (R18). Pre-built .obj files + headers.
const PVSNESLIB_DIR = path.resolve(__dirname, "..", "..", "platforms", "snes", "lib", "pvsneslib");
const PVSNESLIB_INCLUDE = path.join(PVSNESLIB_DIR, "include");
const PVSNESLIB_OBJS_DIR = path.join(PVSNESLIB_DIR, "objs");

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
    if (cFiles.length > 1) {
      throw new Error(
        `buildSnesC: multiple .c files in sources (${cFiles.join(", ")}). ` +
        `Today only one .c file is supported per build — combine via #include or wait for ` +
        `multi-TU support. .asm/.s siblings work fine.`,
      );
    }
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

  // ── Stage 3: link user objs + PVSnesLib's pre-built .obj files ──
  const [crt0Obj, libmObj, libtccObj, libcObj] = await Promise.all([
    readFile(path.join(PVSNESLIB_OBJS_DIR, "crt0_snes.obj")),
    readFile(path.join(PVSNESLIB_OBJS_DIR, "libm.obj")),
    readFile(path.join(PVSNESLIB_OBJS_DIR, "libtcc.obj")),
    readFile(path.join(PVSNESLIB_OBJS_DIR, "libc.obj")),
  ]);

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
      "crt0_snes.obj": new Uint8Array(crt0Obj),
      "libm.obj":      new Uint8Array(libmObj),
      "libtcc.obj":    new Uint8Array(libtccObj),
      "libc.obj":      new Uint8Array(libcObj),
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
async function buildMinimal({ sources, headers, tccOptions, wlaOptions, binaryIncludes = {} }) {
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
  const { readdir, stat } = await import("node:fs/promises");
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

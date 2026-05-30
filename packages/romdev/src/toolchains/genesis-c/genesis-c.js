// genesis-c.js — Sega Genesis C build pipeline.
//
// Orchestrates the full chain through the worker pool:
//   cc1.wasm  — C source → m68k assembly
//   as.wasm   — assembly → .o ELF object
//   ld.wasm   — link user .o + sega.o + libmd.a + libgcc → .elf
//   objcopy.wasm — strip ELF down to raw .bin Genesis ROM
//
// Each WASM tool runs in a fresh worker (R12 subprocess isolation), so
// a crash in one stage doesn't take out the server.
//
// Two runtime modes:
//
//   sgdk: true  (default)  — idiomatic Genesis homebrew. Links against
//     the bundled SGDK runtime (libmd.a + sega.s crt0 + md.ld linker
//     script + full SGDK header tree). #include <genesis.h> works out
//     of the box; agents get VDP_drawText, SYS_doVBlankProcess,
//     SPR_addSprite, the canonical SGDK API every Genesis tutorial uses.
//
//   sgdk: false (minimum-viable) — bare gcc + newlib + libgcc only.
//     User writes everything against direct VDP register addresses.
//     Useful for educational / minimal builds. Bundles original-code
//     sega.s + genesis.ld instead of SGDK's.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  runCc1m68k,
  runM68kAs,
  runM68kLd,
  runM68kObjcopy,
} from "../m68k-elf-gcc/gcc.js";
import { runSjasm, runBintos } from "../sjasm/sjasm.js";
import { packAr } from "../common/ar.js";
import { resolveSdkArchive } from "../common/sdk-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MINIMAL_LIB_DIR = path.resolve(__dirname, "..", "..", "platforms", "genesis", "lib", "c");
const SGDK_LIB_DIR    = path.resolve(__dirname, "..", "..", "platforms", "genesis", "lib", "sgdk");
const SGDK_SRC_DIR    = path.join(SGDK_LIB_DIR, "src");
const SGDK_INC_DIR    = path.join(SGDK_LIB_DIR, "include");
const SGDK_RES_DIR    = path.join(SGDK_LIB_DIR, "res");

/**
 * Build the WHOLE SGDK runtime from its own source into a libmd.a, so Genesis
 * links source-built objects rather than a prebuilt black-box archive. Steps:
 *   1. sjasm each Z80 sound driver (.s80) → blob → bintos → generated .h + .s
 *      (these .h are what SGDK's C #includes; the .s embed the Z80 blobs).
 *   2. cc1+as every SGDK .c (57 files).
 *   3. as every SGDK .s (incl. the bintos-generated driver .s + libres.s).
 *   4. packAr the objects into libmd.a.
 * Cached per-process (keyed on source bytes so an edit to vendored SGDK
 * source rebuilds).
 *
 * @param {Record<string,string>} baseHeaders SGDK headers + sys headers
 * @param {string[]} cc1Options
 * @returns {Promise<{ok:boolean, libmd?:Uint8Array, stage?:string, log?:string}>}
 */
/** Read every SGDK source file (src/ + res/) into a {path:text} map for hashing the seed. */
async function readSgdkSources() {
  const { readdir } = await import("node:fs/promises");
  const out = {};
  async function walk(dir, rel = "") {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, sub);
      else if (/\.(c|s|s80|h|inc|i80|res)$/i.test(e.name)) out[dir + "/" + sub] = await readFile(full, "utf-8");
    }
  }
  await walk(SGDK_SRC_DIR);
  await walk(SGDK_RES_DIR);
  return out;
}

let _sgdkRuntimeCache = null;
async function compileSgdkRuntime(baseHeaders, cc1Options) {
  const { readdir } = await import("node:fs/promises");
  // Collect source files.
  const cFiles = [], sFiles = [], s80Files = [];
  const localHeaders = {};
  async function walk(dir, rel = "") {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(full, sub); continue; }
      // Skip optional extensions (ext/) — they pull in deps we don't vendor and
      // aren't part of the core libmd that genesis.h exposes.
      const norm = sub.replace(/\\/g, "/");
      const isExt = norm.startsWith("ext/") || norm.includes("/ext/");
      if (/\.(h|inc|i80)$/i.test(e.name)) { localHeaders[sub] = await readFile(full, "utf-8"); continue; }
      if (isExt) continue;
      // boot/sega.s is the crt0/header glue — the main build assembles it
      // separately (Stage D) with the generated rom_header.bin sibling, so it's
      // NOT part of the runtime archive. Skip both sega.s and rom_header.c here.
      if (/(^|\/)sega\.s$/i.test(norm) || /(^|\/)rom_header\.c$/i.test(norm)) continue;
      if (/\.c$/i.test(e.name)) cFiles.push({ full, sub });
      else if (/\.s$/i.test(e.name)) sFiles.push({ full, sub });
      else if (/\.s80$/i.test(e.name)) s80Files.push({ full, sub });
    }
  }
  await walk(SGDK_SRC_DIR);

  // Cache key from all source bytes.
  const allSrc = {};
  for (const f of [...cFiles, ...sFiles, ...s80Files]) allSrc[f.sub] = await readFile(f.full, "utf-8");
  const cacheKey = Object.entries(allSrc).map(([k, v]) => k + ":" + v.length).join("|");
  if (_sgdkRuntimeCache && _sgdkRuntimeCache.key === cacheKey) return _sgdkRuntimeCache.val;

  let log = "";
  const objects = {};
  let objIdx = 0;
  const addObj = (bytes) => { objects["o" + (objIdx++) + ".o"] = bytes; };

  // ── 1. Z80 drivers → generated .h (+ .s blobs) ──────────────────
  // The .i80 includes the drivers need live under include/snd/ (and some next
  // to the drivers in src/). Gather both, keyed by basename (how .s80 references
  // them: INCLUDE "z80_def.i80").
  const z80Includes = {};
  for (const [k, v] of Object.entries(localHeaders)) {
    if (/\.i80$/i.test(k)) z80Includes[path.basename(k)] = v;
  }
  async function loadI80From(dir, rel = "") {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await loadI80From(full);
      else if (/\.i80$/i.test(e.name)) z80Includes[e.name] = await readFile(full, "utf-8");
    }
  }
  await loadI80From(SGDK_INC_DIR);
  const driverAsm = {}; // generated bintos .s, keyed by basename
  for (const d of s80Files) {
    // Only the core sound drivers under snd/ are part of libmd. Optional
    // extensions (e.g. ext/minimusic) ship .z80 deps we don't vendor and
    // aren't #included by any SGDK .c — skip them.
    if (!d.sub.replace(/\\/g, "/").startsWith("snd/")) continue;
    const name = path.basename(d.sub).replace(/\.s80$/i, "");
    const sj = await runSjasm({ source: allSrc[d.sub], includes: z80Includes });
    if (!sj.ok) return { ok: false, stage: `sjasm(${d.sub})`, log: log + sj.log };
    const bt = await runBintos({ binary: sj.binary, name });
    if (!bt.ok) return { ok: false, stage: `bintos(${name})`, log: log + bt.log };
    // The generated .h is what SGDK C files #include as "src/.../drv_X.h" etc.
    // SGDK includes them by their src-relative path; expose by both basename
    // and the original sub-path with .s80→.h so #include resolves.
    baseHeaders[name + ".h"] = bt.h;
    baseHeaders[d.sub.replace(/\.s80$/i, ".h")] = bt.h;
    baseHeaders["src/" + d.sub.replace(/\.s80$/i, ".h")] = bt.h;
    driverAsm[name] = bt.s;
  }

  // libres.h is a generated artifact (vendored); make it includable as res/libres.h.
  try {
    const libresH = await readFile(path.join(SGDK_RES_DIR, "libres.h"), "utf-8");
    baseHeaders["res/libres.h"] = libresH;
    baseHeaders["libres.h"] = libresH;
  } catch { /* no libres — degraded */ }

  // ── 2. compile every SGDK .c ────────────────────────────────────
  const cHeaders = { ...baseHeaders, ...localHeaders };
  for (const c of cFiles) {
    const cc = await runCc1m68k({ source: allSrc[c.sub], headers: cHeaders, options: cc1Options });
    if (cc.exitCode !== 0 || !cc.asmSource) return { ok: false, stage: `sgdk cc1(${c.sub})`, log: log + (cc.log || "") };
    const as = await runM68kAs({ source: cc.asmSource });
    if (as.exitCode !== 0 || !as.object) return { ok: false, stage: `sgdk as(${c.sub})`, log: log + (as.log || "") };
    addObj(as.object);
  }

  // ── 3. assemble SGDK's own .s + the generated driver .s + libres.s ──
  // SGDK's hand-written .s use cpp macros (e.g. `func`/`endfunc` in asm_mac.i)
  // + `//` comments, so they're "assembler-with-cpp": preprocess via cc1 -E
  // (with __ASSEMBLER__ + SGDK headers) THEN assemble. The bintos-generated
  // driver .s and libres.s are plain GAS — assemble directly.
  const cppThenAs = async (text, label) => {
    const pp = await runCc1m68k({ source: text, headers: cHeaders, options: [...cc1Options, "-D__ASSEMBLER__=1", "-E"] });
    if (pp.exitCode !== 0 || !pp.asmSource) return { err: `sgdk cpp(${label})`, log: pp.log };
    const as = await runM68kAs({ source: pp.asmSource, options: ["--register-prefix-optional", "--bitwise-or"] });
    if (as.exitCode !== 0 || !as.object) return { err: `sgdk as(${label})`, log: as.log };
    return { obj: as.object };
  };
  const plainAs = async (text, label) => {
    const as = await runM68kAs({ source: text, options: ["--register-prefix-optional", "--bitwise-or"] });
    if (as.exitCode !== 0 || !as.object) return { err: `sgdk as(${label})`, log: as.log };
    return { obj: as.object };
  };
  for (const f of sFiles) {
    const r = await cppThenAs(allSrc[f.sub], f.sub);
    if (r.err) return { ok: false, stage: r.err, log: log + (r.log || "") };
    addObj(r.obj);
  }
  for (const [name, text] of Object.entries(driverAsm)) {
    const r = await plainAs(text, name + ".s");
    if (r.err) return { ok: false, stage: r.err, log: log + (r.log || "") };
    addObj(r.obj);
  }
  try {
    const libresS = await readFile(path.join(SGDK_RES_DIR, "libres.s"), "utf-8");
    const r = await plainAs(libresS, "libres.s");
    if (r.err) return { ok: false, stage: r.err, log: log + (r.log || "") };
    addObj(r.obj);
  } catch { /* no libres.s */ }

  const val = { ok: true, libmd: packAr(objects) };
  _sgdkRuntimeCache = { key: cacheKey, val };
  return val;
}

/**
 * Compile + assemble + link a C source to a Genesis ROM (.bin).
 *
 * @param {Object} args
 * @param {string} [args.source] single C source (shortcut)
 * @param {Record<string, string>} [args.sources] multi-file: {name: contents}
 * @param {Record<string, string>} [args.headers] virtual C headers
 * @param {Record<string, Uint8Array>} [args.binaryIncludes] sibling binary
 *   files (Uint8Array bytes). Visible to user .s files via `.incbin "name"`
 *   — used to embed pre-compiled audio blobs (e.g. XGM2 music .xgc) into
 *   the final ROM as labeled byte arrays.
 * @param {string[]} [args.cc1Options]
 * @param {boolean} [args.sgdk=true] link against bundled SGDK runtime
 *   (default). Pass false for the minimum-viable bare-main path.
 * @returns {Promise<{ok:boolean, binary:Uint8Array|null, log:string, exitCode:number, stage:string, runtime:string}>}
 */
export async function buildGenesisC(args) {
  const headers = args.headers ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  const cc1Options = args.cc1Options ?? ["-O2"];
  const sources = normalizeGenesisSources(args);
  const useSgdk = args.sgdk !== false;
  if (useSgdk) {
    return buildWithSgdk({ sources, headers, binaryIncludes, cc1Options, rebuildSdk: !!args.rebuildSdk, writeSeed: !!args.seedWrite });
  }
  return buildMinimal({ sources, headers, binaryIncludes, cc1Options });
}

/**
 * SGDK link path — idiomatic Genesis C homebrew.
 *
 * Pipeline:
 *   1. cc1 user.c → user.s  (with SGDK headers in -I path + SGDK_GCC defined)
 *   2. as user.s → user.o
 *   3. cc1 rom_header.c → rom_header.s, as → rom_header.o
 *   4. objcopy -O binary rom_header.o → rom_header.bin (256-byte header blob)
 *   5. as sega.s with /work/out/rom_header.bin sibling → sega.o
 *   6. ld user.o + sega.o + libmd.a + libgcc.a + libc.a → ELF
 *   7. objcopy -O binary → final .bin
 */
async function buildWithSgdk({ sources, headers, binaryIncludes, cc1Options, rebuildSdk = false, writeSeed = false }) {
  let log = "";
  // SGDK_GCC define + freestanding-style flags must be in cc1 invocations
  const sgdkCc1Options = [
    "-DSGDK_GCC",
    "-fno-builtin",
    "-fms-extensions",
    "-ffunction-sections",
    "-fdata-sections",
    ...cc1Options,
  ];

  // ── Stage A: gather SGDK headers (visible to tcc via tcc-style flat mount) ──
  // cc1's -iquote /work picks up sibling files mounted alongside main.c.
  // SGDK includes are placed under /work/sgdk-inc/ in MEMFS; user `#include <genesis.h>`
  // resolves via -I /work/sgdk-inc.
  const sgdkHeaders = await loadSgdkHeaders();
  const tccHeaders = { ...headers, ...sgdkHeaders };

  // ── Stage B: compile + assemble each user .c source ──
  /** @type {Record<string, Uint8Array>} */
  const userObjs = {};
  const cFiles = Object.keys(sources).filter((n) => /\.c$/i.test(n));
  for (const cName of cFiles) {
    const cc = await runCc1m68k({
      source: sources[cName],
      headers: tccHeaders,
      options: sgdkCc1Options,
    });
    log += `--- cc1 (${cName}) ---\n` + (cc.log || "(ok)") + "\n";
    if (cc.exitCode !== 0 || !cc.asmSource) {
      return { ok: false, binary: null, log, exitCode: cc.exitCode || 1, stage: `cc1 (${cName})`, runtime: "sgdk", ...(cc.crash ? { crash: cc.crash } : {}) };
    }
    const as = await runM68kAs({ source: cc.asmSource });
    log += `--- as (${cName} → .o) ---\n` + (as.log || "(ok)") + "\n";
    if (as.exitCode !== 0 || !as.object) {
      return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${cName})`, runtime: "sgdk", ...(as.crash ? { crash: as.crash } : {}) };
    }
    userObjs[cName.replace(/\.c$/i, ".o")] = as.object;
  }

  // ── Stage B': assemble user .s sibling files directly ──
  // User .s files may .incbin sibling binary blobs (e.g. xgm2 music) — pass
  // the same binaryIncludes map to each so the assembler can mount them.
  const asmFiles = Object.keys(sources).filter((n) => /\.(s|asm)$/i.test(n));
  for (const asmName of asmFiles) {
    const as = await runM68kAs({ source: sources[asmName], binaryIncludes });
    log += `--- as (${asmName}) ---\n` + (as.log || "(ok)") + "\n";
    if (as.exitCode !== 0 || !as.object) {
      return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${asmName})`, runtime: "sgdk", ...(as.crash ? { crash: as.crash } : {}) };
    }
    userObjs[asmName.replace(/\.(s|asm)$/i, ".o")] = as.object;
  }

  // ── Stage C: build rom_header.bin from SGDK's rom_header.c ──
  const romHeaderC = await readFile(path.join(SGDK_LIB_DIR, "rom_header.c"), "utf-8");
  const rhCc = await runCc1m68k({
    source: romHeaderC,
    headers: tccHeaders,
    options: sgdkCc1Options,
  });
  log += "--- cc1 (rom_header.c) ---\n" + (rhCc.log || "(ok)") + "\n";
  if (rhCc.exitCode !== 0 || !rhCc.asmSource) {
    return { ok: false, binary: null, log, exitCode: rhCc.exitCode || 1, stage: "cc1 (rom_header)", runtime: "sgdk", ...(rhCc.crash ? { crash: rhCc.crash } : {}) };
  }
  const rhAs = await runM68kAs({ source: rhCc.asmSource });
  log += "--- as (rom_header.s) ---\n" + (rhAs.log || "(ok)") + "\n";
  if (rhAs.exitCode !== 0 || !rhAs.object) {
    return { ok: false, binary: null, log, exitCode: rhAs.exitCode || 1, stage: "as (rom_header)", runtime: "sgdk", ...(rhAs.crash ? { crash: rhAs.crash } : {}) };
  }
  // Objcopy → raw header bin (256 bytes)
  const rhObjcopy = await runM68kObjcopy({ elf: rhAs.object });
  log += "--- objcopy (rom_header.o → .bin) ---\n" + (rhObjcopy.log || "(ok)") + "\n";
  if (rhObjcopy.exitCode !== 0 || !rhObjcopy.binary) {
    return { ok: false, binary: null, log, exitCode: rhObjcopy.exitCode || 1, stage: "objcopy (rom_header)", runtime: "sgdk", ...(rhObjcopy.crash ? { crash: rhObjcopy.crash } : {}) };
  }

  // ── Stage D: assemble sega.s with the just-built rom_header.bin as a sibling ──
  // sega.s `.incbin "out/rom_header.bin"` — we mount it at /work/out/rom_header.bin
  // via the worker's binaryFile facility. runM68kAs's includes map only handles text,
  // so we need to extend the as call to accept binary siblings.
  //
  // Note: we use `sega.preprocessed.s` (the cpp-expanded form). The raw sega.s
  // uses `#include <task_cst.h>` + `#define`d constants, which SGDK normally
  // expands via gcc's `-x assembler-with-cpp` driver mode. Our `runM68kAs`
  // wrapper calls `as` directly without cpp, so we ship the preprocessed
  // version as a build artifact (~7 KB) instead of running cpp at every build.
  const segaSrc = await readFile(path.join(SGDK_LIB_DIR, "sega.preprocessed.s"), "utf-8");
  const segaAs = await runM68kAs({
    source: segaSrc,
    binaryIncludes: { "out/rom_header.bin": rhObjcopy.binary },
    // SGDK assembles sega.s with the same -DSGDK_GCC etc. flags as C — pass them
    // via -Wa,--register-prefix-optional,--bitwise-or implicitly via cc1's driver.
    // Our as wrapper takes raw flags; the equivalent here is just --bitwise-or.
    options: ["--register-prefix-optional", "--bitwise-or"],
  });
  log += "--- as (sega.s) ---\n" + (segaAs.log || "(ok)") + "\n";
  if (segaAs.exitCode !== 0 || !segaAs.object) {
    return { ok: false, binary: null, log, exitCode: segaAs.exitCode || 1, stage: "as (sega.s)", runtime: "sgdk", ...(segaAs.crash ? { crash: segaAs.crash } : {}) };
  }

  // ── Stage D2: compile the SGDK runtime FROM SOURCE → libmd.a ──
  // (Z80 drivers via sjasm+bintos, all SGDK .c via m68k-gcc, libres + .s
  // assembled, packed into an archive. No prebuilt libmd.a black box.)
  // Seed by default (compiling SGDK from source is ~18s); rebuildSdk:true
  // recompiles; an edit to the vendored SGDK source without the flag is flagged.
  const sdkWarnings = [];
  const sgdkRes = await resolveSdkArchive({
    name: "SGDK",
    sources: await readSgdkSources(),
    seedPath: path.join(SGDK_LIB_DIR, "libmd.seed.a"),
    seedHashPath: path.join(SGDK_LIB_DIR, "libmd.seed.hash"),
    rebuild: rebuildSdk, writeSeed,
    compileFromSource: async () => {
      const r = await compileSgdkRuntime({ ...tccHeaders }, sgdkCc1Options);
      return r.ok ? { ok: true, archive: r.libmd } : r;
    },
  });
  if (!sgdkRes.ok) {
    return { ok: false, binary: null, log: log + (sgdkRes.log || ""), exitCode: 1, stage: `sgdk runtime: ${sgdkRes.stage}`, runtime: "sgdk" };
  }
  if (sgdkRes.sdkEditIgnored) sdkWarnings.push(sgdkRes.sdkEditIgnored);
  log += `--- SGDK runtime ${sgdkRes.fromSource ? "compiled from source" : "from prebuilt seed"} ---\n`;

  // ── Stage E: link everything ──
  const mdLd = await readFile(path.join(SGDK_LIB_DIR, "md.ld"), "utf-8");
  const [libgcc, libc, libm] = await Promise.all([
    readFile(path.join(MINIMAL_LIB_DIR, "libgcc.a")),
    readFile(path.join(MINIMAL_LIB_DIR, "libc.a")),
    readFile(path.join(MINIMAL_LIB_DIR, "libm.a")),
  ]);

  const ld = await runM68kLd({
    objects: { "sega.o": segaAs.object, ...userObjs },
    linkScript: mdLd,
    archives: {
      "libmd.a":  sgdkRes.archive,
      "libgcc.a": new Uint8Array(libgcc),
      "libc.a":   new Uint8Array(libc),
      "libm.a":   new Uint8Array(libm),
    },
    libraries: ["md", "gcc", "c"],
    libraryPaths: ["/work"],
    options: ["--no-warn-rwx-segments"],
  });
  log += "--- ld ---\n" + (ld.log || "(ok)") + "\n";
  if (ld.exitCode !== 0 || !ld.elf) {
    return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", runtime: "sgdk", ...(ld.crash ? { crash: ld.crash } : {}) };
  }

  // ── Stage F: extract raw ROM ──
  const objcopy = await runM68kObjcopy({ elf: ld.elf });
  log += "--- objcopy ---\n" + (objcopy.log || "(ok)") + "\n";
  if (objcopy.exitCode !== 0 || !objcopy.binary) {
    return { ok: false, binary: null, log, exitCode: objcopy.exitCode || 1, stage: "objcopy", runtime: "sgdk", ...(objcopy.crash ? { crash: objcopy.crash } : {}) };
  }

  return {
    ok: true,
    binary: objcopy.binary,
    log,
    exitCode: 0,
    stage: "done",
    runtime: "sgdk",
    ...(sdkWarnings.length ? { sdkEditIgnored: sdkWarnings } : {}),
  };
}

/**
 * Post-build finalize, mirroring what SGDK's makefile does after link
 * (`sizebnd -sizealign 131072` + a checksum fix). Without this, our raw
 * objcopy output is unaligned and carries a $0000 checksum — gpgx-WASM
 * tolerates it, but stricter loaders (RetroArch's Genesis Plus GX,
 * BlastEm, flashcarts) reject or misbehave. Two steps:
 *
 *   1. Pad to the next 128 KB boundary, minimum 512 KB. (SGDK uses a
 *      131072-byte alignment; 512 KB is a safe floor above the ~384 KB
 *      internal-table minimum.)
 *   2. Write the 16-bit checksum at $18E = sum of every big-endian word
 *      from $200 to end-of-ROM, mod $10000.
 *
 * @param {Uint8Array} bin raw ROM from objcopy
 * @returns {Uint8Array} padded + checksummed ROM
 */
export function finalizeGenesisRom(bin) {
  const ALIGN = 131072;          // 128 KB, matches SGDK's sizebnd -sizealign
  const MIN = 512 * 1024;        // floor; comfortably above the ~384 KB min
  let size = Math.max(bin.length, MIN);
  if (size % ALIGN !== 0) size = Math.ceil(size / ALIGN) * ALIGN;
  const out = new Uint8Array(size); // zero-filled
  out.set(bin);
  // Checksum: sum BE words from 0x200 to EOF (odd trailing byte ignored,
  // as on hardware). Header room ends at 0x200; everything before is the
  // vector table + header and is excluded by convention.
  let sum = 0;
  for (let i = 0x200; i + 1 < out.length; i += 2) {
    sum = (sum + ((out[i] << 8) | out[i + 1])) & 0xFFFF;
  }
  out[0x18e] = (sum >> 8) & 0xFF;
  out[0x18f] = sum & 0xFF;
  return out;
}

/**
 * Minimum-viable Genesis C path (no SGDK). R20 stage-1 behavior.
 * Same code path as before — only this implementation handles the
 * minimal sega.s / genesis.ld bundled under lib/c/.
 */
async function buildMinimal(args) {
  const { sources, headers, binaryIncludes, cc1Options } = args;
  let log = "";

  // ── Stage 1: compile each .c file via cc1 → .s ─────────────────
  /** @type {Record<string, Uint8Array>} */
  const userObjs = {};
  const cFiles = Object.keys(sources).filter((n) => /\.c$/i.test(n));
  for (const cName of cFiles) {
    const cc = await runCc1m68k({
      source: sources[cName],
      headers,
      options: cc1Options,
    });
    log += `--- cc1 (${cName}) ---\n` + (cc.log || "(ok)") + "\n";
    if (cc.exitCode !== 0 || !cc.asmSource) {
      return { ok: false, binary: null, log, exitCode: cc.exitCode || 1, stage: `cc1 (${cName})`, runtime: "minimal", ...(cc.crash ? { crash: cc.crash } : {}) };
    }
    // ── Stage 2: assemble that .s with m68k-elf-as ────────────────
    const as = await runM68kAs({ source: cc.asmSource });
    log += `--- as (${cName} → .o) ---\n` + (as.log || "(ok)") + "\n";
    if (as.exitCode !== 0 || !as.object) {
      return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${cName})`, runtime: "minimal", ...(as.crash ? { crash: as.crash } : {}) };
    }
    userObjs[cName.replace(/\.c$/i, ".o")] = as.object;
  }

  // ── Stage 2b: assemble each .s file directly ───────────────────
  const asmFiles = Object.keys(sources).filter((n) => /\.(s|asm)$/i.test(n));
  for (const asmName of asmFiles) {
    const as = await runM68kAs({ source: sources[asmName], binaryIncludes });
    log += `--- as (${asmName}) ---\n` + (as.log || "(ok)") + "\n";
    if (as.exitCode !== 0 || !as.object) {
      return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${asmName})`, runtime: "minimal", ...(as.crash ? { crash: as.crash } : {}) };
    }
    userObjs[asmName.replace(/\.(s|asm)$/i, ".o")] = as.object;
  }

  // ── Stage 3: assemble the bundled sega.s crt0 ───────────────────
  const sega = await readFile(path.join(MINIMAL_LIB_DIR, "sega.s"), "utf-8");
  const segaAs = await runM68kAs({ source: sega });
  log += "--- as (sega.s crt0) ---\n" + (segaAs.log || "(ok)") + "\n";
  if (segaAs.exitCode !== 0 || !segaAs.object) {
    return { ok: false, binary: null, log, exitCode: segaAs.exitCode || 1, stage: "as (sega.s)", runtime: "minimal", ...(segaAs.crash ? { crash: segaAs.crash } : {}) };
  }

  // ── Stage 4: link everything ────────────────────────────────────
  const linkScript = await readFile(path.join(MINIMAL_LIB_DIR, "genesis.ld"), "utf-8");
  const [libgcc, libc, libm] = await Promise.all([
    readFile(path.join(MINIMAL_LIB_DIR, "libgcc.a")),
    readFile(path.join(MINIMAL_LIB_DIR, "libc.a")),
    readFile(path.join(MINIMAL_LIB_DIR, "libm.a")),
  ]);

  const ld = await runM68kLd({
    objects: { "sega.o": segaAs.object, ...userObjs },
    linkScript,
    archives: {
      "libgcc.a": new Uint8Array(libgcc),
      "libc.a":   new Uint8Array(libc),
      "libm.a":   new Uint8Array(libm),
    },
    libraries: ["c", "gcc", "m"],
    libraryPaths: ["/work"],
    options: ["--no-warn-rwx-segments"],
  });
  log += "--- ld ---\n" + (ld.log || "(ok)") + "\n";
  if (ld.exitCode !== 0 || !ld.elf) {
    return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", runtime: "minimal", ...(ld.crash ? { crash: ld.crash } : {}) };
  }

  // ── Stage 5: extract raw binary ─────────────────────────────────
  const objcopy = await runM68kObjcopy({ elf: ld.elf });
  log += "--- objcopy ---\n" + (objcopy.log || "(ok)") + "\n";
  if (objcopy.exitCode !== 0 || !objcopy.binary) {
    return { ok: false, binary: null, log, exitCode: objcopy.exitCode || 1, stage: "objcopy", runtime: "minimal", ...(objcopy.crash ? { crash: objcopy.crash } : {}) };
  }

  return {
    ok: true,
    binary: objcopy.binary,
    log,
    exitCode: 0,
    stage: "done",
    runtime: "minimal",
  };
}

/** @param {{source?:string, sources?:Record<string,string>}} args */
function normalizeGenesisSources(args) {
  if (args.source && args.sources) {
    throw new Error("buildGenesisC: pass either `source` or `sources`, not both.");
  }
  if (args.sources) {
    const cFiles = Object.keys(args.sources).filter((n) => /\.c$/i.test(n));
    if (cFiles.length === 0) {
      throw new Error("buildGenesisC: `sources` must include at least one .c file.");
    }
    return args.sources;
  }
  if (typeof args.source === "string") {
    return { "main.c": args.source };
  }
  throw new Error("buildGenesisC: missing `source` or `sources`.");
}

/**
 * Walk SGDK's `include/` tree and return a `{name: contents}` map of every
 * `.h`/`.inc`/`.i` header. cc1 sees them via the worker pool's input-files
 * mount — same as the headers map the user provides.
 *
 * Cached at module level — SGDK headers don't change at runtime.
 */
let _sgdkHeaderCache = null;
async function loadSgdkHeaders() {
  if (_sgdkHeaderCache) return _sgdkHeaderCache;
  const { readdir } = await import("node:fs/promises");
  const out = {};
  /** @param {string} dir @param {string} prefix */
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      const relPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (e.isFile() && /\.(h|hpp|inc|i)$/i.test(e.name)) {
        out[relPath] = await readFile(fullPath, "utf-8");
      }
    }
  }
  await walk(path.join(SGDK_LIB_DIR, "include"), "");
  _sgdkHeaderCache = out;
  return out;
}

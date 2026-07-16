// gba-c.js — Game Boy Advance C build pipeline.
//
// Orchestrates the full chain through the worker pool:
//   cc1.wasm     — C source → ARM assembly (Thumb-interwork)
//   as.wasm      — assembly → .o ELF object
//   ld.wasm      — link user .o + gba_crt0.o + libgba.a + libgcc → .elf
//   objcopy.wasm — strip ELF down to raw .gba ROM
//
// Each WASM tool runs in a fresh worker (R12 subprocess isolation), so
// a crash in one stage doesn't take out the server.
//
// Two runtime modes:
//
//   libgba: true (default) — idiomatic GBA homebrew. Links against the
//     bundled libgba runtime (libgba.a + gba_crt0.s + gba_cart.ld + the
//     gba.h umbrella header). `#include <gba.h>` works out of the box;
//     agents get the canonical devkitARM API — BG / sprite / DMA /
//     interrupts / sound / input / BIOS calls. ONE caveat:
//     iprintf-style stdio output (libgba's console.c) is NOT included —
//     see src/platforms/gba/TROUBLESHOOTING.md and the long comment
//     block in scripts/build-libgba.sh for the trade-off rationale and
//     three workaround paths.
//
//   libgba: false (minimum-viable) — bare gcc + newlib only. User writes
//     against the raw GBA hardware registers (0x04000000-0x04000208).
//     Useful for educational builds or when you want zero SDK overhead.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";

import {
  runCc1arm,
  runArmAs,
  runArmLd,
  runArmObjcopy,
} from "../arm-none-eabi-gcc/gcc.js";
import { packAr } from "../common/ar.js";
import { resolveSdkArchive } from "../common/sdk-cache.js";
import { CBuild, BuildError } from "../common/c-build.js";
import { resolveToolBaseDir } from "../common/wasm-tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// The GBA C library tree ships in THIS package's share/ (the driver moved in
// with the tree so a standalone consumer — e.g. the gba-lua SDK — imports
// buildGbaC from "romdev-platform-gba" and drags in nothing else). Primary
// resolution is package self-reference; the fallback is this file's own
// package root (build/gba-c/ → two up). `sentinel` proves the dir is right.
const GBA_SHARE = path.join(
  resolveToolBaseDir({
    pkg: "romdev-platform-gba",
    sentinel: path.join("share", "gba", "lib", "libtonc", "gba_crt0.s"),
    localDir: path.resolve(__dirname, "..", ".."),
    label: "GBA C library tree (romdev-platform-gba/share)",
  }),
  "share", "gba", "lib",
);
const LIBGBA_DIR  = path.join(GBA_SHARE, "libgba");
const LIBTONC_DIR = path.join(GBA_SHARE, "libtonc");
const MAXMOD_DIR  = path.join(GBA_SHARE, "maxmod");
// Minimal libsysbase (devoptab_list[] + reentrant write/read routing) so
// newlib stdio (iprintf/printf) reaches a console device. Compiled from source
// and linked with both libtonc (tte_init_con) and libgba (consoleInit).
const SYSBASE_DIR = path.join(GBA_SHARE, "sysbase");

/**
 * Compile + assemble + link a C source to a GBA ROM (.gba).
 *
 * Three runtime modes:
 *
 *   runtime: "libtonc" (default) — idiomatic Tonc-tutorial-aligned
 *     GBA homebrew. Links against the bundled libtonc.a + Tonc Text
 *     Engine (TTE). `#include <tonc.h>` works; agents get
 *     `tte_init_chr4c`, `tte_write`, `tte_printf`, `tonccpy`,
 *     `REG_DISPCNT`, the canonical Tonc API every published GBA
 *     tutorial uses. Caveat: tte_iohook (iprintf auto-routing) is
 *     excluded — use `tte_printf` directly instead. R28.
 *
 *   runtime: "libgba" — devkitPro's libgba SDK. Different API
 *     surface (`SetMode`, `oamSet`, etc.), more "thin wrapper over
 *     hardware registers" style. Same iprintf caveat (console.c
 *     excluded). R24.
 *
 *   runtime: "none" — minimum-viable. Bare gcc + newlib only. User
 *     writes against raw GBA hardware registers. Smallest binaries.
 *
 * Legacy `libgba: true | false` arg still accepted for back-compat
 * with R24 (true → libgba, false → none). If both `runtime` and
 * `libgba` are present, `runtime` wins.
 *
 * @param {Object} args
 * @param {string} [args.source]
 * @param {Record<string, string>} [args.sources]
 * @param {Record<string, string>} [args.headers]
 * @param {Record<string, Uint8Array>} [args.binaryIncludes] virtual binary files mounted at /work/<name>.
 *   When `maxmod` is on AND a file named `soundbank.bin` is present, a tiny asm stub
 *   that `.incbin`s the soundbank under the global symbol `soundbank_bin` is auto-emitted.
 * @param {string[]} [args.cc1Options]
 * @param {"libtonc"|"libgba"|"none"} [args.runtime="libtonc"]
 * @param {boolean} [args.libgba] legacy flag — true = libgba, false = none
 * @returns {Promise<{ok:boolean, binary:Uint8Array|null, log:string, exitCode:number, stage:string, runtime:string}>}
 */
export async function buildGbaC(args) {
  const headers = args.headers ?? {};
  // -ffunction-sections/-fdata-sections give every function + global (incl.
  // `static` file-local ones) its own section, so the GNU ld map carries a
  // per-symbol `.bss.<name>`/`.data.<name>` line — that's what lets
  // symbols({op:'resolve'}) turn a static C global's name into an address on GBA
  // (same as SGDK does for Genesis). Pure metadata; no codegen change to what's kept.
  // -Wall -Wextra so the agent SEES warnings (unused vars, implicit decls,
  // sign-compare, etc.) — they're parsed into structured issues[]. Without these
  // gcc is silent and agents build blind. -Wno-unused-parameter keeps the common
  // intentional `(void)`-style scaffold params from being noise. Applied to USER
  // .c only (the libtonc/maxmod SDK is a prebuilt seed, not recompiled here).
  const cc1Options = args.cc1Options ?? ["-O2", "-mthumb", "-ffunction-sections", "-fdata-sections", "-Wall", "-Wextra", "-Wno-unused-parameter"];
  const sources = normalizeGbaSources(args);
  const binaryIncludes = args.binaryIncludes ?? {};

  // Resolve runtime: explicit args.runtime wins; otherwise legacy
  // libgba flag; otherwise default libtonc.
  let runtime = args.runtime;
  if (!runtime) {
    if (args.libgba === true)  runtime = "libgba";
    else if (args.libgba === false) runtime = "none";
    else runtime = "libtonc";
  }

  const opts = { sources, headers, cc1Options, binaryIncludes, maxmod: !!args.maxmod, rebuildSdk: !!args.rebuildSdk, writeSeed: !!args.seedWrite };
  if (runtime === "libtonc") return buildWithLibtonc(opts);
  if (runtime === "libgba")  return buildWithLibgba(opts);
  if (runtime === "none")    return buildMinimal(opts);
  throw new Error(`buildGbaC: unknown runtime '${runtime}' — expected 'libtonc' | 'libgba' | 'none'`);
}

function normalizeGbaSources(args) {
  if (args.sources) return args.sources;
  if (args.source) return { "main.c": args.source };
  throw new Error("buildGbaC: pass either `source` or `sources`");
}

/**
 * libtonc (the default) — Tonc-tutorial-aligned GBA homebrew.
 *
 * Same pipeline shape as buildWithLibgba but links against
 * libtonc.a + uses libtonc's headers (the ones from gbadev.net/tonc
 * — `tte_init_chr4c`, `tte_write`, `tonccpy`, etc.).
 *
 * Pipeline:
 *   1. cc1 each user .c → .s (with libtonc's include/ in the -I path)
 *   2. as each .s → .o
 *   3. as the bundled gba_crt0.s → gba_crt0.o
 *   4. as a tiny fake_heap_end stub (since we excluded libsysbase)
 *   5. ld user objects + gba_crt0.o + libtonc.a + libgcc.a + libc.a + libnosys.a → ELF
 *   6. objcopy -O binary → final .gba ROM
 */
async function buildWithLibtonc({ sources, headers, cc1Options, binaryIncludes = {}, maxmod = false, rebuildSdk = false, writeSeed = false }) {
  const cb = new CBuild();

  const crt0Src    = await readFile(path.join(LIBTONC_DIR, "gba_crt0.s"), "utf-8");
  const linkScript = await readFile(path.join(LIBTONC_DIR, "gba_cart.ld"), "utf-8");

  // Auto-emit a soundbank-embedding stub when the caller passes a
  // `soundbank.bin` binary include AND opts into maxmod. The stub
  // .incbin's the file under the canonical `soundbank_bin` symbol
  // expected by mmInitDefault. This mirrors the asm stub every
  // maxmod-examples Makefile generates with bin2s — we just do it
  // ourselves so users don't need to author it by hand.
  const hasSoundbank = maxmod && Object.prototype.hasOwnProperty.call(binaryIncludes, "soundbank.bin");
  if (hasSoundbank) {
    cb.note(`--- soundbank stub auto-emitted (.incbin "soundbank.bin") ---`);
  }

  const libtoncHeaders = await loadLibtoncHeaders();
  const sysHeaders     = await loadSysIncludeHeaders();
  // Maxmod headers (maxmod.h + mm_types.h) — only loaded when the
  // user opts into music with `maxmod: true`.
  const maxmodHeaders  = maxmod ? await loadMaxmodHeaders() : {};

  const libtoncCc1Options = [
    ...cc1Options,
    "-mthumb-interwork",
  ];

  try {
    // ── Stage A: compile each user .c → .s ─────────────────────────
    const objects = {};
    for (const [name, src] of Object.entries(sources)) {
      if (!name.endsWith(".c")) continue;
      const cc1 = await cb.stage(`cc1 (${name})`, () => runCc1arm({
        source: src,
        headers: { ...sysHeaders, ...libtoncHeaders, ...maxmodHeaders, ...headers },
        options: libtoncCc1Options,
      }), (r) => r.asmSource);
      const asm = await cb.stage(`as (${name})`, () => runArmAs({ source: cc1.asmSource }), (r) => r.object);
      objects[name.replace(/\.c$/, ".o")] = asm.object;
    }

    // ── Stage B: assemble gba_crt0.s ─────────────────────────────────
    const crt0As = await cb.stage("as (gba_crt0.s)", () => runArmAs({ source: crt0Src }), (r) => r.object);
    objects["gba_crt0.o"] = crt0As.object;

    // fake_heap_end + `end` stubs. The gba_cart.ld linker script
    // defines `__end__` (top of bss) but not the bare `end` symbol that
    // newlib's sbrk() references. We provide both `fake_heap_end` AND
    // `end` here as tiny data-section labels. Points at end of EWRAM.
    //
    // For real games you'd want sbrk to start the heap at __end__ and
    // track it dynamically — this stub gives a fixed bound which is
    // fine for the small allocations newlib does internally.
    const fakeHeapEndStub = await cb.stage("as (fake_heap_end stub)", () => runArmAs({
      source: `
      .section .data
      .global fake_heap_end
      .global end
      .align 2
      fake_heap_end:
        .word 0x02040000   /* end of EWRAM — 256 KB after 0x02000000 */
      end:
        .word 0x02000000   /* start of EWRAM — sbrk grows from here */
    `,
    }), (r) => r.object);
    objects["fake_heap_end.o"] = fakeHeapEndStub.object;

    // ── Stage B3: maxmod soundbank embedding stub ───────────────────
    if (hasSoundbank) {
      const soundbankStub = await cb.stage("as (soundbank.s)", () => runArmAs({
        source: `
        .section .rodata
        .align 2
        .global soundbank_bin
        .global soundbank_bin_size
        soundbank_bin:
          .incbin "soundbank.bin"
        soundbank_bin_end:
        .align 2
        soundbank_bin_size:
          .word soundbank_bin_end - soundbank_bin
      `,
        binaryIncludes: { "soundbank.bin": binaryIncludes["soundbank.bin"] },
      }), (r) => r.object);
      objects["soundbank.o"] = soundbankStub.object;
    }

    // ── Stage B4: resolve libtonc (and maxmod) — seed by default, or compile
    // from source when rebuildSdk is set. Edits to the vendored SDK source take
    // effect with rebuildSdk:true; without it, the fast prebuilt seed is used and
    // an edit is flagged (sdkEditIgnored), never silently dropped.
    const sdkWarnings = [];
    const toncRes = await sdkArchive({
      name: "libtonc",
      srcDirs: [path.join(LIBTONC_DIR, "src"), SYSBASE_DIR],
      seedBase: path.join(LIBTONC_DIR, "libtonc"),
      rebuild: rebuildSdk, writeSeed,
      compile: async () => {
        const r = await compileSdkObjects({
          key: "libtonc",
          srcDirs: [path.join(LIBTONC_DIR, "src"), SYSBASE_DIR],
          headers: { ...sysHeaders, ...libtoncHeaders, ...maxmodHeaders, ...headers },
        });
        return r.ok ? { ok: true, archive: packAr(r.objects) } : r;
      },
    });
    if (!toncRes.ok) {
      return { ok: false, binary: null, log: cb.log + (toncRes.log || ""), exitCode: 1, stage: toncRes.stage, runtime: "libtonc" };
    }
    if (toncRes.sdkEditIgnored) sdkWarnings.push(toncRes.sdkEditIgnored);
    cb.note(`--- libtonc ${toncRes.fromSource ? "compiled from source" : "from prebuilt seed"} ---`);

    let maxmodAr = null;
    if (maxmod) {
      const mmHeaders = await loadMaxmodAsmHeaders();
      const mmRes = await sdkArchive({
        name: "maxmod",
        srcDirs: [path.join(MAXMOD_DIR, "source"), path.join(MAXMOD_DIR, "source_gba")],
        seedBase: path.join(MAXMOD_DIR, "maxmod"),
        rebuild: rebuildSdk, writeSeed,
        compile: async () => {
          const r = await compileSdkObjects({
            key: "maxmod",
            srcDirs: [path.join(MAXMOD_DIR, "source"), path.join(MAXMOD_DIR, "source_gba")],
            headers: { ...sysHeaders, ...maxmodHeaders, ...mmHeaders },
            cppDefines: ["SYS_GBA=1"],
          });
          return r.ok ? { ok: true, archive: packAr(r.objects) } : r;
        },
      });
      if (!mmRes.ok) {
        return { ok: false, binary: null, log: cb.log + (mmRes.log || ""), exitCode: 1, stage: mmRes.stage, runtime: "libtonc" };
      }
      if (mmRes.sdkEditIgnored) sdkWarnings.push(mmRes.sdkEditIgnored);
      maxmodAr = mmRes.archive;
      cb.note(`--- maxmod ${mmRes.fromSource ? "compiled from source" : "from prebuilt seed"} ---`);
    }

    // ── Stage C: link ───────────────────────────────────────────────
    // crt*.o + libgcc/libc/libnosys are gcc/newlib toolchain runtime.
    const archives = {
      "libtonc.a":  toncRes.archive,
      "crti.o":     new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crti.o"))),
      "crtn.o":     new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crtn.o"))),
      "crtbegin.o": new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crtbegin.o"))),
      "crtend.o":   new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crtend.o"))),
    };
    if (maxmodAr) archives["libmm.a"] = maxmodAr;
    const targetLibs = await readTargetArchives();
    Object.assign(archives, targetLibs);

    // Wrap the libs in --start-group / --end-group so the linker
    // re-scans them for cross-references between libc → libgcc → libc
    // (libc/strtol uses __aeabi_uidiv from libgcc; libgcc may call back
    // into libc helpers). Without re-scan we get undefined references.
    const ld = await cb.stage("ld", () => runArmLd({
      objects,
      linkScript,
      archives,
      libraryPaths: ["/work"],
      libraries: [],   // explicit -l flags moved into options for ordering control
      options: [
        "/work/crti.o",
        "/work/crtbegin.o",
        // libtonc/maxmod archives are packed from compiled-from-source objects.
        "--start-group",
        "-ltonc",
        ...(maxmod ? ["-lmm"] : []),
        "-lc",
        "-lgcc",
        "-lnosys",
        "--end-group",
        "/work/crtend.o",
        "/work/crtn.o",
      ],
    }), (r) => r.elf);

    // ── Stage D: objcopy ────────────────────────────────────────────
    const objcopy = await cb.stage("objcopy", () => runArmObjcopy({ elf: ld.elf }), (r) => r.binary);

    return { ok: true, binary: objcopy.binary, log: cb.log, exitCode: 0, stage: "done", runtime: "libtonc", ...(ld.map ? { symbols: ld.map } : {}), ...(sdkWarnings.length ? { sdkEditIgnored: sdkWarnings } : {}) };
  } catch (e) {
    if (e instanceof BuildError) return e.toResult({ runtime: "libtonc" });
    throw e;
  }
}

/**
 * Idiomatic GBA path — link against libgba.
 *
 * Pipeline:
 *   1. cc1 each user .c → .s (with libgba's include/ in the -I path)
 *   2. as each .s → .o
 *   3. cc1+as the bundled gba_crt0.s → gba_crt0.o
 *   4. ld user objects + gba_crt0.o + libgba.a + libgcc.a + libc.a → ELF
 *   5. objcopy -O binary → final .gba ROM
 */
async function buildWithLibgba({ sources, headers, cc1Options, rebuildSdk = false, writeSeed = false }) {
  const cb = new CBuild();

  // Read the libgba bundle once (crt0 + linker script; the SDK itself is
  // compiled from source below, not linked from libgba.a).
  const crt0Src   = await readFile(path.join(LIBGBA_DIR, "gba_crt0.s"), "utf-8");
  const linkScript = await readFile(path.join(LIBGBA_DIR, "gba_cart.ld"), "utf-8");

  // Discover libgba's headers + the newlib + gcc system headers
  // (stdint.h, stddef.h, etc. that libgba's gba_types.h depends on).
  // Both get mounted at /work/... so cc1's `-iquote /work -I /work`
  // (from runCc1arm) picks them up via #include "..." AND <...>.
  const libgbaHeaders = await loadLibgbaHeaders();
  const sysHeaders = await loadSysIncludeHeaders();

  // libgba uses Thumb mode + interwork. -ffreestanding so cc1 doesn't
  // emit references to host-only stubs that newlib might not provide.
  const libgbaCc1Options = [
    ...cc1Options,
    "-mthumb-interwork",
  ];

  try {
    // ── Stage A: compile each user .c → .s ─────────────────────────
    const objects = {};
    for (const [name, src] of Object.entries(sources)) {
      if (!name.endsWith(".c")) continue;
      const cc1 = await cb.stage(`cc1 (${name})`, () => runCc1arm({
        source: src,
        headers: { ...sysHeaders, ...libgbaHeaders, ...headers },
        options: libgbaCc1Options,
      }), (r) => r.asmSource);
      const asm = await cb.stage(`as (${name})`, () => runArmAs({ source: cc1.asmSource }), (r) => r.object);
      objects[name.replace(/\.c$/, ".o")] = asm.object;
    }

    // ── Stage B: assemble gba_crt0.s ─────────────────────────────────
    const crt0As = await cb.stage("as (gba_crt0.s)", () => runArmAs({ source: crt0Src }), (r) => r.object);
    objects["gba_crt0.o"] = crt0As.object;

    // ── Stage B2: assemble fake_heap_end + `end` stubs ──────────────
    // devkitARM's libsysbase normally provides both `fake_heap_end`
    // (used by sbrk's heap tracking) and the linker script defines
    // `end` (start of heap). We excluded libsysbase so we provide
    // both as tiny data labels — gba_cart.ld defines `__end__` but not
    // bare `end` which newlib sbrk needs.
    const fakeHeapEndStub = await cb.stage("as (fake_heap_end stub)", () => runArmAs({
      source: `
      .section .data
      .global fake_heap_end
      .global end
      .align 2
      fake_heap_end:
        .word 0x02040000   /* end of EWRAM — 256 KB after 0x02000000 */
      end:
        .word 0x02000000   /* start of EWRAM — sbrk grows from here */
    `,
    }), (r) => r.object);
    objects["fake_heap_end.o"] = fakeHeapEndStub.object;

    // ── Stage B3: compile libgba (+ libsysbase) FROM SOURCE ─────────
    // Link libgba's own compiled objects, NOT a prebuilt libgba.a. Edit any
    // libgba source and it takes effect. libsysbase (gba_iosupport.c) gives the
    // devoptab routing so libgba's consoleInit() + iprintf work.
    const sdkWarnings = [];
    const gbaRes = await sdkArchive({
      name: "libgba",
      srcDirs: [path.join(LIBGBA_DIR, "src"), SYSBASE_DIR],
      seedBase: path.join(LIBGBA_DIR, "libgba"),
      rebuild: rebuildSdk, writeSeed,
      compile: async () => {
        const r = await compileSdkObjects({
          key: "libgba",
          srcDirs: [path.join(LIBGBA_DIR, "src"), SYSBASE_DIR],
          headers: { ...sysHeaders, ...libgbaHeaders, ...headers },
        });
        return r.ok ? { ok: true, archive: packAr(r.objects) } : r;
      },
    });
    if (!gbaRes.ok) {
      return { ok: false, binary: null, log: cb.log + (gbaRes.log || ""), exitCode: 1, stage: gbaRes.stage, runtime: "libgba" };
    }
    if (gbaRes.sdkEditIgnored) sdkWarnings.push(gbaRes.sdkEditIgnored);
    cb.note(`--- libgba ${gbaRes.fromSource ? "compiled from source" : "from prebuilt seed"} ---`);

    // ── Stage C: link ───────────────────────────────────────────────
    // libgba archive from seed/source; crt*.o + libgcc/libc/libnosys are toolchain.
    const archives = {
      "libgba.a":   gbaRes.archive,
      "crti.o":     new Uint8Array(await readFile(path.join(LIBGBA_DIR, "crti.o"))),
      "crtn.o":     new Uint8Array(await readFile(path.join(LIBGBA_DIR, "crtn.o"))),
      "crtbegin.o": new Uint8Array(await readFile(path.join(LIBGBA_DIR, "crtbegin.o"))),
      "crtend.o":   new Uint8Array(await readFile(path.join(LIBGBA_DIR, "crtend.o"))),
    };
    const targetLibs = await readTargetArchives();
    Object.assign(archives, targetLibs);

    // Link order matters for `-l` archives and crt*.o files. Standard
    // gcc-driver order: crti.o + crtbegin.o → user objects → libgba →
    // libc + libgcc + libnosys → crtend.o + crtn.o.
    // --start-group / --end-group forces ld to re-scan the libs so
    // libc → libgcc → libc cross-refs resolve (libc/strtol calls
    // __aeabi_uidiv in libgcc; libgcc may call back into libc).
    const ld = await cb.stage("ld", () => runArmLd({
      objects,
      linkScript,
      archives,
      libraryPaths: ["/work"],
      libraries: [],
      options: [
        "/work/crti.o",
        "/work/crtbegin.o",
        // libgba archive packed from compiled-from-source objects.
        "--start-group",
        "-lgba",
        "-lc",
        "-lgcc",
        "-lnosys",
        "--end-group",
        "/work/crtend.o",
        "/work/crtn.o",
      ],
    }), (r) => r.elf);

    // ── Stage D: objcopy ELF → raw .gba ─────────────────────────────
    const objcopy = await cb.stage("objcopy", () => runArmObjcopy({ elf: ld.elf }), (r) => r.binary);

    return {
      ok: true,
      binary: objcopy.binary,
      log: cb.log,
      exitCode: 0,
      stage: "done",
      runtime: "libgba",
      ...(ld.map ? { symbols: ld.map } : {}),
      ...(sdkWarnings.length ? { sdkEditIgnored: sdkWarnings } : {}),
    };
  } catch (e) {
    if (e instanceof BuildError) return e.toResult({ runtime: "libgba" });
    throw e;
  }
}

/**
 * Minimum-viable path — no libgba runtime. Caller writes against the
 * raw GBA registers. Useful for tiny tests or when you want zero SDK
 * overhead.
 *
 * Same shape as buildWithLibgba but skips crt0 + libgba.a. The user
 * must provide their own _start / main entry point.
 */
async function buildMinimal({ sources, headers, cc1Options }) {
  const cb = new CBuild();
  try {
    const objects = {};
    for (const [name, src] of Object.entries(sources)) {
      if (!name.endsWith(".c")) continue;
      const cc1 = await cb.stage(`cc1 (${name})`, () => runCc1arm({ source: src, headers, options: cc1Options }), (r) => r.asmSource);
      const asm = await cb.stage(`as (${name})`, () => runArmAs({ source: cc1.asmSource }), (r) => r.object);
      objects[name.replace(/\.c$/, ".o")] = asm.object;
    }

    // Minimum-viable linker script — single .text region at GBA cart base.
    const ld = await cb.stage("ld", () => runArmLd({
      objects,
      linkScript: `OUTPUT_FORMAT("elf32-littlearm")
ENTRY(main)
MEMORY { ROM (rx) : ORIGIN = 0x08000000, LENGTH = 32M }
SECTIONS { .text : { *(.text*) *(.rodata*) } > ROM }
`,
    }), (r) => r.elf);

    const objcopy = await cb.stage("objcopy", () => runArmObjcopy({ elf: ld.elf }), (r) => r.binary);

    return { ok: true, binary: objcopy.binary, log: cb.log, exitCode: 0, stage: "done", runtime: "minimal", ...(ld.map ? { symbols: ld.map } : {}) };
  } catch (e) {
    if (e instanceof BuildError) return e.toResult({ runtime: "minimal" });
    throw e;
  }
}

/**
 * Load every libtonc header file under include/ into a {name: contents}
 * map suitable for passing as `headers` to cc1. Cached per-process.
 */
let _libtoncHeadersCache = null;
async function loadLibtoncHeaders() {
  if (_libtoncHeadersCache) return _libtoncHeadersCache;
  const incDir = path.join(LIBTONC_DIR, "include");
  const out = {};
  async function walk(dir, rel = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const subRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, subRel);
      } else if (ent.isFile() && /\.(h|inc)$/i.test(ent.name)) {
        out[subRel] = await readFile(full, "utf-8");
      }
    }
  }
  await walk(incDir);
  _libtoncHeadersCache = out;
  return out;
}

let _maxmodHeadersCache = null;
async function loadMaxmodHeaders() {
  if (_maxmodHeadersCache) return _maxmodHeadersCache;
  const incDir = path.join(MAXMOD_DIR, "include");
  const out = {};
  const entries = await readdir(incDir);
  for (const name of entries) {
    if (/\.h$/i.test(name)) {
      out[name] = await readFile(path.join(incDir, name), "utf-8");
    }
  }
  _maxmodHeadersCache = out;
  return out;
}

/**
 * Maxmod's assembly include files (asm_include/*.inc) — the macro/struct/def
 * includes its .s sources pull in via #include. Needed to compile maxmod from
 * source. Keyed by bare name (how the .s files reference them). Cached.
 */
let _maxmodAsmHeadersCache = null;
async function loadMaxmodAsmHeaders() {
  if (_maxmodAsmHeadersCache) return _maxmodAsmHeadersCache;
  const out = {};
  const dir = path.join(MAXMOD_DIR, "asm_include");
  let entries;
  try { entries = await readdir(dir); } catch { entries = []; }
  for (const name of entries) {
    if (/\.(inc|h)$/i.test(name)) out[name] = await readFile(path.join(dir, name), "utf-8");
  }
  _maxmodAsmHeadersCache = out;
  return out;
}

/**
 * Load every libgba header file under include/ into a {name: contents}
 * map suitable for passing as `headers` to cc1. Cached per-process.
 */
let _libgbaHeadersCache = null;
async function loadLibgbaHeaders() {
  if (_libgbaHeadersCache) return _libgbaHeadersCache;
  const incDir = path.join(LIBGBA_DIR, "include");
  const out = {};
  async function walk(dir, rel = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const subRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, subRel);
      } else if (ent.isFile() && /\.(h|inc)$/i.test(ent.name)) {
        out[subRel] = await readFile(full, "utf-8");
      }
    }
  }
  await walk(incDir);
  _libgbaHeadersCache = out;
  return out;
}

/**
 * Load every newlib + gcc system header from the bundled sysinclude/
 * tree. cc1 doesn't search a default system path under our worker
 * setup, so we mount the headers into /work/ via the `headers` arg.
 *
 * About 159 files / 2.4 MB at the moment. Cached per-process.
 */
let _sysHeadersCache = null;
async function loadSysIncludeHeaders() {
  if (_sysHeadersCache) return _sysHeadersCache;
  const sysDir = path.join(LIBGBA_DIR, "sysinclude");
  const out = {};
  async function walk(dir, rel = "") {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const subRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, subRel);
      } else if (ent.isFile() && /\.(h|inc)$/i.test(ent.name)) {
        out[subRel] = await readFile(full, "utf-8");
      }
    }
  }
  await walk(sysDir);
  _sysHeadersCache = out;
  return out;
}

/**
 * Read libgcc.a + libc.a + libnosys.a from the native arm-none-eabi
 * install. These are ARM target archives so they don't care that they
 * were built natively. Cached per-process.
 */
let _targetArchivesCache = null;
async function readTargetArchives() {
  if (_targetArchivesCache) return _targetArchivesCache;
  // The 3 ARM target archives (libc/libnosys/libgcc) are bundled in the
  // platform lib dir — self-contained, like Genesis-C does it. (Previously
  // these were read from the 14 GB build/arm-toolchain/install tree; that
  // coupled the package to the build workspace. Copied into src so the GBA
  // package ships them itself — ~15 MB, the real GBA payload beyond wasm.)
  const archDir = path.join(GBA_SHARE, "arm-archives");
  const out = {};
  for (const name of ["libc.a", "libnosys.a", "libgcc.a"]) {
    try {
      out[name] = new Uint8Array(await readFile(path.join(archDir, name)));
    } catch (e) {
      // libnosys may not be present on every toolchain; skip if missing.
      if (name === "libnosys.a") continue;
      throw e;
    }
  }
  _targetArchivesCache = out;
  return out;
}

/**
 * Compile an SDK's OWN SOURCE TREE into a map of {objName: Uint8Array}, so the
 * SDK is built from the visible source we ship rather than linked from a
 * prebuilt .a black box. An agent can edit any SDK .c/.s and the change takes
 * effect on the next build (the per-process cache is keyed on the source bytes,
 * so an edit invalidates only what changed).
 *
 * Handles two source forms:
 *   - .c  → cc1 (C → asm) → as (asm → object)
 *   - .s  → cc1 -E (cpp: #include/#define) → as     (maxmod's GAS+cpp asm)
 *
 * @param {Object} a
 * @param {string} a.key cache key (sdk name + variant)
 * @param {string[]} a.srcDirs absolute dirs to scan for .c/.s
 * @param {Record<string,string>} a.headers headers map for cc1 (sys + sdk + src-local)
 * @param {string[]} [a.cppDefines] e.g. ["SYS_GBA=1"] applied to .s preprocessing
 * @param {string[]} [a.cc1Options]
 * @returns {Promise<{ok:boolean, objects?:Record<string,Uint8Array>, stage?:string, log?:string}>}
 */
const _sdkObjCache = new Map();
async function compileSdkObjects({ key, srcDirs, headers, cppDefines = [], cc1Options = [] }) {
  // Gather source files (preserve sub-path in the object name to avoid clashes).
  // Also collect .s/.inc files as AVAILABLE INCLUDES — GAS asm often #includes
  // sibling .s "type" files (e.g. libtonc's tte_types.s) and .inc macro files.
  const files = [];
  const localIncludes = {};
  for (const dir of srcDirs) {
    async function walk(d, rel = "") {
      let ents;
      try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        const sub = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(full, sub);
        else if (/\.(c|s)$/i.test(e.name)) {
          files.push({ full, sub });
          if (/\.s$/i.test(e.name)) localIncludes[e.name] = await readFile(full, "utf-8");
        } else if (/\.(inc|h)$/i.test(e.name)) {
          localIncludes[e.name] = await readFile(full, "utf-8");
        }
      }
    }
    await walk(dir);
  }
  headers = { ...headers, ...localIncludes };
  // Cache key folds in every source file's bytes so an edit busts the cache.
  const srcTexts = {};
  for (const f of files) srcTexts[f.sub] = await readFile(f.full, "utf-8");
  const cacheKey = key + "\0" + Object.entries(srcTexts).map(([k, v]) => k + ":" + v.length).join("|");
  if (_sdkObjCache.has(cacheKey)) return _sdkObjCache.get(cacheKey);

  const defineOpts = cppDefines.map((d) => "-D" + d);
  const objects = {};
  let log = "";
  let objIdx = 0;
  for (const f of files) {
    const src = srcTexts[f.sub];
    // Short, unique member name (ar short-name field is 16 bytes incl. the GNU
    // "/" terminator). Member names don't affect linking — only symbols do —
    // so a sequential id keeps every name well under the limit.
    const objName = "o" + (objIdx++) + ".o";
    let asmText;
    if (/\.c$/i.test(f.sub)) {
      const cc1 = await runCc1arm({ source: src, headers, options: [...cc1Options, "-mthumb-interwork"] });
      if (cc1.exitCode !== 0 || !cc1.asmSource) {
        return { ok: false, stage: `sdk cc1 (${f.sub})`, log: log + (cc1.log || "") };
      }
      asmText = cc1.asmSource;
    } else {
      // .s: GAS "assembler-with-cpp" — preprocess with cc1 -E (expands #include
      // of .inc/.s macro+type files + #define), then assemble. -D__ASSEMBLER__=1
      // so asm-only headers (e.g. libtonc tonc_asminc.h) take their asm branch.
      const pp = await runCc1arm({ source: src, headers, options: [...defineOpts, "-D__ASSEMBLER__=1", "-E"] });
      if (pp.exitCode !== 0 || !pp.asmSource) {
        return { ok: false, stage: `sdk cpp (${f.sub})`, log: log + (pp.log || "") };
      }
      asmText = pp.asmSource;
    }
    const as = await runArmAs({ source: asmText, includes: headers });
    if (as.exitCode !== 0 || !as.object) {
      return { ok: false, stage: `sdk as (${f.sub})`, log: log + (as.log || "") };
    }
    objects[objName] = as.object;
  }
  const result = { ok: true, objects };
  _sdkObjCache.set(cacheKey, result);
  return result;
}

/** Read every .c/.s source under the given dirs into a {relpath: text} map (for hashing). */
async function readSdkSources(srcDirs) {
  const out = {};
  for (const dir of srcDirs) {
    async function walk(d, rel = "") {
      let ents;
      try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        const sub = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(full, sub);
        else if (/\.(c|s|h|inc)$/i.test(e.name)) out[dir + "/" + sub] = await readFile(full, "utf-8");
      }
    }
    await walk(dir);
  }
  return out;
}

/**
 * Resolve an SDK archive with the seed/rebuild policy: use the prebuilt seed .a
 * by default (fast), compile from source when `rebuild` is set, and warn if the
 * vendored source was edited but not rebuilt. `compile` produces the archive
 * from source (compileSdkObjects + packAr).
 */
async function sdkArchive({ name, srcDirs, seedBase, rebuild, writeSeed, compile }) {
  const sources = await readSdkSources(srcDirs);
  return resolveSdkArchive({
    name,
    sources,
    seedPath: seedBase + ".seed.a",
    seedHashPath: seedBase + ".seed.hash",
    rebuild,
    writeSeed,
    compileFromSource: compile,
  });
}

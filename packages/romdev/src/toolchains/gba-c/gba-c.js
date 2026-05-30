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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIBGBA_DIR  = path.resolve(__dirname, "..", "..", "platforms", "gba", "lib", "libgba");
const LIBTONC_DIR = path.resolve(__dirname, "..", "..", "platforms", "gba", "lib", "libtonc");
const MAXMOD_DIR  = path.resolve(__dirname, "..", "..", "platforms", "gba", "lib", "maxmod");

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
  const cc1Options = args.cc1Options ?? ["-O2", "-mthumb"];
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

  const opts = { sources, headers, cc1Options, binaryIncludes, maxmod: !!args.maxmod };
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
async function buildWithLibtonc({ sources, headers, cc1Options, binaryIncludes = {}, maxmod = false }) {
  let log = "";

  const libtoncA   = new Uint8Array(await readFile(path.join(LIBTONC_DIR, "libtonc.a")));
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
    log += `--- soundbank stub auto-emitted (.incbin "soundbank.bin") ---\n`;
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

  // ── Stage A: compile each user .c → .s ─────────────────────────
  const objects = {};
  for (const [name, src] of Object.entries(sources)) {
    if (!name.endsWith(".c")) continue;
    const cc1 = await runCc1arm({
      source: src,
      headers: { ...sysHeaders, ...libtoncHeaders, ...maxmodHeaders, ...headers },
      options: libtoncCc1Options,
    });
    log += `--- cc1 (${name}) ---\n${cc1.log || "(ok)"}\n`;
    if (cc1.exitCode !== 0 || !cc1.asmSource) {
      return { ok: false, binary: null, log, exitCode: cc1.exitCode || 1, stage: `cc1 (${name})`, runtime: "libtonc", ...(cc1.crash ? { crash: cc1.crash } : {}) };
    }
    const asm = await runArmAs({ source: cc1.asmSource });
    log += `--- as (${name}) ---\n${asm.log || "(ok)"}\n`;
    if (asm.exitCode !== 0 || !asm.object) {
      return { ok: false, binary: null, log, exitCode: asm.exitCode || 1, stage: `as (${name})`, runtime: "libtonc", ...(asm.crash ? { crash: asm.crash } : {}) };
    }
    objects[name.replace(/\.c$/, ".o")] = asm.object;
  }

  // ── Stage B: assemble gba_crt0.s ─────────────────────────────────
  const crt0As = await runArmAs({ source: crt0Src });
  log += `--- as (gba_crt0.s) ---\n${crt0As.log || "(ok)"}\n`;
  if (crt0As.exitCode !== 0 || !crt0As.object) {
    return { ok: false, binary: null, log, exitCode: crt0As.exitCode || 1, stage: "as (gba_crt0.s)", runtime: "libtonc", ...(crt0As.crash ? { crash: crt0As.crash } : {}) };
  }
  objects["gba_crt0.o"] = crt0As.object;

  // fake_heap_end + `end` stubs. The gba_cart.ld linker script
  // defines `__end__` (top of bss) but not the bare `end` symbol that
  // newlib's sbrk() references. We provide both `fake_heap_end` AND
  // `end` here as tiny data-section labels. Points at end of EWRAM.
  //
  // For real games you'd want sbrk to start the heap at __end__ and
  // track it dynamically — this stub gives a fixed bound which is
  // fine for the small allocations newlib does internally.
  const fakeHeapEndStub = await runArmAs({
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
  });
  log += `--- as (fake_heap_end stub) ---\n${fakeHeapEndStub.log || "(ok)"}\n`;
  if (fakeHeapEndStub.exitCode !== 0 || !fakeHeapEndStub.object) {
    return { ok: false, binary: null, log, exitCode: fakeHeapEndStub.exitCode || 1, stage: "as (fake_heap_end stub)", runtime: "libtonc", ...(fakeHeapEndStub.crash ? { crash: fakeHeapEndStub.crash } : {}) };
  }
  objects["fake_heap_end.o"] = fakeHeapEndStub.object;

  // ── Stage B3: maxmod soundbank embedding stub ───────────────────
  if (hasSoundbank) {
    const soundbankStub = await runArmAs({
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
    });
    log += `--- as (soundbank.s) ---\n${soundbankStub.log || "(ok)"}\n`;
    if (soundbankStub.exitCode !== 0 || !soundbankStub.object) {
      return { ok: false, binary: null, log, exitCode: soundbankStub.exitCode || 1, stage: "as (soundbank.s)", runtime: "libtonc", ...(soundbankStub.crash ? { crash: soundbankStub.crash } : {}) };
    }
    objects["soundbank.o"] = soundbankStub.object;
  }

  // ── Stage C: link ───────────────────────────────────────────────
  const archives = {
    "libtonc.a":  libtoncA,
    "crti.o":     new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crti.o"))),
    "crtn.o":     new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crtn.o"))),
    "crtbegin.o": new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crtbegin.o"))),
    "crtend.o":   new Uint8Array(await readFile(path.join(LIBTONC_DIR, "crtend.o"))),
  };
  if (maxmod) {
    archives["libmm.a"] = new Uint8Array(await readFile(path.join(MAXMOD_DIR, "libmm.a")));
  }
  const targetLibs = await readTargetArchives();
  Object.assign(archives, targetLibs);

  // Wrap the libs in --start-group / --end-group so the linker
  // re-scans them for cross-references between libc → libgcc → libc
  // (libc/strtol uses __aeabi_uidiv from libgcc; libgcc may call back
  // into libc helpers). Without re-scan we get undefined references.
  const ld = await runArmLd({
    objects,
    linkScript,
    archives,
    libraryPaths: ["/work"],
    libraries: [],   // explicit -l flags moved into options for ordering control
    options: [
      "/work/crti.o",
      "/work/crtbegin.o",
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
  });
  log += `--- ld ---\n${ld.log || "(ok)"}\n`;
  if (ld.exitCode !== 0 || !ld.elf) {
    return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", runtime: "libtonc", ...(ld.crash ? { crash: ld.crash } : {}) };
  }

  // ── Stage D: objcopy ────────────────────────────────────────────
  const objcopy = await runArmObjcopy({ elf: ld.elf });
  log += `--- objcopy ---\n${objcopy.log || "(ok)"}\n`;
  if (objcopy.exitCode !== 0 || !objcopy.binary) {
    return { ok: false, binary: null, log, exitCode: objcopy.exitCode || 1, stage: "objcopy", runtime: "libtonc", ...(objcopy.crash ? { crash: objcopy.crash } : {}) };
  }

  return { ok: true, binary: objcopy.binary, log, exitCode: 0, stage: "done", runtime: "libtonc" };
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
async function buildWithLibgba({ sources, headers, cc1Options }) {
  let log = "";

  // Read the libgba bundle once.
  const libgbaA   = new Uint8Array(await readFile(path.join(LIBGBA_DIR, "libgba.a")));
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

  // ── Stage A: compile each user .c → .s ─────────────────────────
  const objects = {};
  for (const [name, src] of Object.entries(sources)) {
    if (!name.endsWith(".c")) continue;
    const cc1 = await runCc1arm({
      source: src,
      headers: { ...sysHeaders, ...libgbaHeaders, ...headers },
      options: libgbaCc1Options,
    });
    log += `--- cc1 (${name}) ---\n${cc1.log || "(ok)"}\n`;
    if (cc1.exitCode !== 0 || !cc1.asmSource) {
      return { ok: false, binary: null, log, exitCode: cc1.exitCode || 1, stage: `cc1 (${name})`, runtime: "libgba", ...(cc1.crash ? { crash: cc1.crash } : {}) };
    }
    const asm = await runArmAs({ source: cc1.asmSource });
    log += `--- as (${name}) ---\n${asm.log || "(ok)"}\n`;
    if (asm.exitCode !== 0 || !asm.object) {
      return { ok: false, binary: null, log, exitCode: asm.exitCode || 1, stage: `as (${name})`, runtime: "libgba", ...(asm.crash ? { crash: asm.crash } : {}) };
    }
    objects[name.replace(/\.c$/, ".o")] = asm.object;
  }

  // ── Stage B: assemble gba_crt0.s ─────────────────────────────────
  const crt0As = await runArmAs({ source: crt0Src });
  log += `--- as (gba_crt0.s) ---\n${crt0As.log || "(ok)"}\n`;
  if (crt0As.exitCode !== 0 || !crt0As.object) {
    return { ok: false, binary: null, log, exitCode: crt0As.exitCode || 1, stage: "as (gba_crt0.s)", runtime: "libgba", ...(crt0As.crash ? { crash: crt0As.crash } : {}) };
  }
  objects["gba_crt0.o"] = crt0As.object;

  // ── Stage B2: assemble fake_heap_end + `end` stubs ──────────────
  // devkitARM's libsysbase normally provides both `fake_heap_end`
  // (used by sbrk's heap tracking) and the linker script defines
  // `end` (start of heap). We excluded libsysbase so we provide
  // both as tiny data labels — gba_cart.ld defines `__end__` but not
  // bare `end` which newlib sbrk needs.
  const fakeHeapEndStub = await runArmAs({
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
  });
  log += `--- as (fake_heap_end stub) ---\n${fakeHeapEndStub.log || "(ok)"}\n`;
  if (fakeHeapEndStub.exitCode !== 0 || !fakeHeapEndStub.object) {
    return { ok: false, binary: null, log, exitCode: fakeHeapEndStub.exitCode || 1, stage: "as (fake_heap_end stub)", runtime: "libgba", ...(fakeHeapEndStub.crash ? { crash: fakeHeapEndStub.crash } : {}) };
  }
  objects["fake_heap_end.o"] = fakeHeapEndStub.object;

  // ── Stage C: link everything against libgba.a + libgcc.a ────────
  // We need:
  //   - crti.o + crtn.o          (gcc startup — defines _init/_fini)
  //   - crtbegin.o + crtend.o    (gcc C++ constructor/destructor scaffolding)
  //   - libgba.a                  (the SDK)
  //   - libgcc.a, libc.a, libnosys.a (newlib targets)
  // Pull all into MEMFS via `archives` (libgba.a is a real archive;
  // crt*.o are objects but the linker accepts both via archives map).
  const archives = {
    "libgba.a": libgbaA,
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
  const ld = await runArmLd({
    objects,
    linkScript,
    archives,
    libraryPaths: ["/work"],
    libraries: [],
    options: [
      "/work/crti.o",
      "/work/crtbegin.o",
      "--start-group",
      "-lgba",
      "-lc",
      "-lgcc",
      "-lnosys",
      "--end-group",
      "/work/crtend.o",
      "/work/crtn.o",
    ],
  });
  log += `--- ld ---\n${ld.log || "(ok)"}\n`;
  if (ld.exitCode !== 0 || !ld.elf) {
    return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", runtime: "libgba", ...(ld.crash ? { crash: ld.crash } : {}) };
  }

  // ── Stage D: objcopy ELF → raw .gba ─────────────────────────────
  const objcopy = await runArmObjcopy({ elf: ld.elf });
  log += `--- objcopy ---\n${objcopy.log || "(ok)"}\n`;
  if (objcopy.exitCode !== 0 || !objcopy.binary) {
    return { ok: false, binary: null, log, exitCode: objcopy.exitCode || 1, stage: "objcopy", runtime: "libgba", ...(objcopy.crash ? { crash: objcopy.crash } : {}) };
  }

  return {
    ok: true,
    binary: objcopy.binary,
    log,
    exitCode: 0,
    stage: "done",
    runtime: "libgba",
  };
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
  let log = "";
  const objects = {};
  for (const [name, src] of Object.entries(sources)) {
    if (!name.endsWith(".c")) continue;
    const cc1 = await runCc1arm({ source: src, headers, options: cc1Options });
    log += `--- cc1 (${name}) ---\n${cc1.log || "(ok)"}\n`;
    if (cc1.exitCode !== 0 || !cc1.asmSource) {
      return { ok: false, binary: null, log, exitCode: cc1.exitCode || 1, stage: `cc1 (${name})`, runtime: "minimal", ...(cc1.crash ? { crash: cc1.crash } : {}) };
    }
    const asm = await runArmAs({ source: cc1.asmSource });
    log += `--- as (${name}) ---\n${asm.log || "(ok)"}\n`;
    if (asm.exitCode !== 0 || !asm.object) {
      return { ok: false, binary: null, log, exitCode: asm.exitCode || 1, stage: `as (${name})`, runtime: "minimal", ...(asm.crash ? { crash: asm.crash } : {}) };
    }
    objects[name.replace(/\.c$/, ".o")] = asm.object;
  }

  // Minimum-viable linker script — single .text region at GBA cart base.
  const ld = await runArmLd({
    objects,
    linkScript: `OUTPUT_FORMAT("elf32-littlearm")
ENTRY(main)
MEMORY { ROM (rx) : ORIGIN = 0x08000000, LENGTH = 32M }
SECTIONS { .text : { *(.text*) *(.rodata*) } > ROM }
`,
  });
  log += `--- ld ---\n${ld.log || "(ok)"}\n`;
  if (ld.exitCode !== 0 || !ld.elf) {
    return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", runtime: "minimal", ...(ld.crash ? { crash: ld.crash } : {}) };
  }

  const objcopy = await runArmObjcopy({ elf: ld.elf });
  log += `--- objcopy ---\n${objcopy.log || "(ok)"}\n`;
  if (objcopy.exitCode !== 0 || !objcopy.binary) {
    return { ok: false, binary: null, log, exitCode: objcopy.exitCode || 1, stage: "objcopy", runtime: "minimal", ...(objcopy.crash ? { crash: objcopy.crash } : {}) };
  }

  return { ok: true, binary: objcopy.binary, log, exitCode: 0, stage: "done", runtime: "minimal" };
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
  const archDir = path.resolve(__dirname, "..", "..", "platforms", "gba", "lib", "arm-archives");
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

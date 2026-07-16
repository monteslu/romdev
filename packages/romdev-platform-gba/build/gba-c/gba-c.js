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
// ENV INJECTION (0.95.0, browser IDEs): pass `env` to run the identical
// pipeline in a non-node host (a Web Worker). All seams optional; omitting
// `env` gives the node behavior (worker pool + fs share reads):
//   env.runTool  — the 4 tool runs (see common/gcc-toolchain.js ToolJob);
//                  the host owns WASM instantiation + MEMFS mounting.
//   env.share    — the share/gba/lib tree as a {relPath: string|Uint8Array}
//                  manifest (stage it with common/share-fs.js
//                  buildShareManifest so key ORDER matches node — order
//                  feeds compile order → ar member order → ROM bytes).
//   env.hash     — async {name:text}→hex digest for the SDK seed check
//                  (browser: crypto.subtle; required when env is given).
//   env.sdkCache — optional {get(key), put(key,bytes)} rebuild cache.
// NO top-level node imports here — node bits load lazily on the default
// paths only, so a browser bundle can load this module untouched.
//
// Two runtime modes:
//
//   libgba: true (default) — idiomatic GBA homebrew. Links against the
//     bundled libgba runtime (libgba.a + gba_crt0.s + gba_cart.ld + the
//     gba.h umbrella header). `#include <gba.h>` works out of the box;
//     agents get the canonical devkitARM API — BG / sprite / DMA /
//     interrupts / sound / input / BIOS calls. ONE caveat:
//     iprintf-style stdio output (libgba's console.c) is NOT included —
//     see the GBA TROUBLESHOOTING doc and the long comment block in
//     scripts/build-libgba.sh for the trade-off rationale and
//     three workaround paths.
//
//   libgba: false (minimum-viable) — bare gcc + newlib only. User writes
//     against the raw GBA hardware registers (0x04000000-0x04000208).
//     Useful for educational builds or when you want zero SDK overhead.

import { makeArmGccTools } from "../arm-none-eabi-gcc/gcc.js";
import { packAr } from "../common/ar.js";
import { resolveSdkArchive, hashSources, nodeSdkIo } from "../common/sdk-cache.js";
import { CBuild, BuildError } from "../common/c-build.js";
import { mapShare, dirShare } from "../common/share-fs.js";

// ── environment resolution ──────────────────────────────────────────────────

/** Node default: resolve THIS package's share/gba/lib and wrap it. The GBA C
 *  library tree ships in this package's share/ so a standalone consumer —
 *  e.g. the gba-lua SDK — imports buildGbaC from "romdev-platform-gba" and
 *  drags in nothing else. Primary resolution is package self-reference; the
 *  fallback is this file's own package root (build/gba-c/ → two up). */
let _nodeShare = null;
let _nodeShareRoot = null;
async function defaultShare() {
  if (_nodeShare) return _nodeShare;
  const { resolveToolBaseDir } = await import("../common/wasm-tool.js");
  const path = (await import("node:path")).default;
  const base = resolveToolBaseDir({
    pkg: "romdev-platform-gba",
    sentinel: path.join("share", "gba", "lib", "libtonc", "gba_crt0.s"),
    localDir: new URL("../..", import.meta.url).href,
    label: "GBA C library tree (romdev-platform-gba/share)",
  });
  _nodeShareRoot = path.join(base, "share", "gba", "lib");
  _nodeShare = dirShare(_nodeShareRoot);
  return _nodeShare;
}

/** Resolve the build context (tools + share + sdk io) from an optional env. */
let _defaultTools = null;
async function buildCtx(env) {
  const tools = env?.runTool
    ? makeArmGccTools({ runTool: env.runTool })
    : (_defaultTools ??= makeArmGccTools());
  const share = env?.share
    ? (typeof env.share.text === "function" ? env.share : mapShare(env.share))
    : await defaultShare();
  // Seed + rebuild-cache io, addressed by share-RELATIVE paths (so the seed
  // hash is machine-independent — hashing absolute paths broke the seed check
  // every time the tree moved). writeSeed (the seed generator) is node-only.
  const io = {
    readSeed: async (rel) => { try { return await share.bytes(rel); } catch { return null; } },
    readSeedHash: async (rel) => { try { return (await share.text(rel)).trim(); } catch { return null; } },
    ...(env ? {} : {
      writeSeed: async (rel, bytes, hashRel, hash) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(_nodeShareRoot + "/" + rel, bytes);
        await writeFile(_nodeShareRoot + "/" + hashRel, hash + "\n");
      },
    }),
    hash: env?.hash ?? hashSources,
    ...(env?.sdkCache
      ? { cacheGet: (k) => env.sdkCache.get(k), cachePut: (k, b) => env.sdkCache.put(k, b) }
      : env ? {} : {
        cacheGet: async (k) => (await nodeSdkIo()).cacheGet(k),
        cachePut: async (k, b) => (await nodeSdkIo()).cachePut(k, b),
      }),
  };
  return { tools, share, io };
}

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
 * @param {Object} [args.env] injected environment (browser hosts) — see header
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

  const ctx = await buildCtx(args.env);
  const opts = { ...ctx, sources, headers, cc1Options, binaryIncludes, maxmod: !!args.maxmod, rebuildSdk: !!args.rebuildSdk, writeSeed: !!args.seedWrite };
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
async function buildWithLibtonc({ tools, share, io, sources, headers, cc1Options, binaryIncludes = {}, maxmod = false, rebuildSdk = false, writeSeed = false }) {
  const { runCc1arm, runArmAs, runArmLd, runArmObjcopy } = tools;
  const cb = new CBuild();

  const crt0Src    = await share.text("libtonc/gba_crt0.s");
  const linkScript = await share.text("libtonc/gba_cart.ld");

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

  const libtoncHeaders = await loadHeaderTree(share, "libtonc/include");
  const sysHeaders     = await loadHeaderTree(share, "libgba/sysinclude");
  // Maxmod headers (maxmod.h + mm_types.h) — only loaded when the
  // user opts into music with `maxmod: true`.
  const maxmodHeaders  = maxmod ? await loadFlatHeaders(share, "maxmod/include", /\.h$/i) : {};

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
      share, io,
      name: "libtonc",
      srcDirs: ["libtonc/src", "sysbase"],
      seedBase: "libtonc/libtonc",
      rebuild: rebuildSdk, writeSeed,
      compile: async () => {
        const r = await compileSdkObjects({
          share, tools,
          key: "libtonc",
          srcDirs: ["libtonc/src", "sysbase"],
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
      const mmHeaders = await loadFlatHeaders(share, "maxmod/asm_include", /\.(inc|h)$/i);
      const mmRes = await sdkArchive({
        share, io,
        name: "maxmod",
        srcDirs: ["maxmod/source", "maxmod/source_gba"],
        seedBase: "maxmod/maxmod",
        rebuild: rebuildSdk, writeSeed,
        compile: async () => {
          const r = await compileSdkObjects({
            share, tools,
            key: "maxmod",
            srcDirs: ["maxmod/source", "maxmod/source_gba"],
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
      "crti.o":     await share.bytes("libtonc/crti.o"),
      "crtn.o":     await share.bytes("libtonc/crtn.o"),
      "crtbegin.o": await share.bytes("libtonc/crtbegin.o"),
      "crtend.o":   await share.bytes("libtonc/crtend.o"),
    };
    if (maxmodAr) archives["libmm.a"] = maxmodAr;
    const targetLibs = await readTargetArchives(share);
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
async function buildWithLibgba({ tools, share, io, sources, headers, cc1Options, rebuildSdk = false, writeSeed = false }) {
  const { runCc1arm, runArmAs, runArmLd, runArmObjcopy } = tools;
  const cb = new CBuild();

  // Read the libgba bundle once (crt0 + linker script; the SDK itself is
  // compiled from source below, not linked from libgba.a).
  const crt0Src   = await share.text("libgba/gba_crt0.s");
  const linkScript = await share.text("libgba/gba_cart.ld");

  // Discover libgba's headers + the newlib + gcc system headers
  // (stdint.h, stddef.h, etc. that libgba's gba_types.h depends on).
  // Both get mounted at /work/... so cc1's `-iquote /work -I /work`
  // (from runCc1arm) picks them up via #include "..." AND <...>.
  const libgbaHeaders = await loadHeaderTree(share, "libgba/include");
  const sysHeaders = await loadHeaderTree(share, "libgba/sysinclude");

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
      share, io,
      name: "libgba",
      srcDirs: ["libgba/src", "sysbase"],
      seedBase: "libgba/libgba",
      rebuild: rebuildSdk, writeSeed,
      compile: async () => {
        const r = await compileSdkObjects({
          share, tools,
          key: "libgba",
          srcDirs: ["libgba/src", "sysbase"],
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
      "crti.o":     await share.bytes("libgba/crti.o"),
      "crtn.o":     await share.bytes("libgba/crtn.o"),
      "crtbegin.o": await share.bytes("libgba/crtbegin.o"),
      "crtend.o":   await share.bytes("libgba/crtend.o"),
    };
    const targetLibs = await readTargetArchives(share);
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
async function buildMinimal({ tools, sources, headers, cc1Options }) {
  const { runCc1arm, runArmAs, runArmLd, runArmObjcopy } = tools;
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

// ── share-tree readers (cached per share instance) ──────────────────────────

const _shareCaches = new WeakMap();
function shareCache(share) {
  let c = _shareCaches.get(share);
  if (!c) { c = new Map(); _shareCaches.set(share, c); }
  return c;
}

/**
 * Load every header (.h/.inc) under a share subtree into a {relName: contents}
 * map suitable for passing as `headers` to cc1 — keys relative to the subtree
 * root (e.g. "tonc.h", "sys/types.h"). Cached per share instance.
 */
async function loadHeaderTree(share, prefix) {
  const cache = shareCache(share);
  const key = "tree:" + prefix;
  if (cache.has(key)) return cache.get(key);
  const out = {};
  for (const rel of await share.list(prefix)) {
    if (!/\.(h|inc)$/i.test(rel)) continue;
    out[rel.slice(prefix.length + 1)] = await share.text(rel);
  }
  cache.set(key, out);
  return out;
}

/** Load headers from ONE directory level (no recursion into subdirs), keyed by
 *  bare filename — the maxmod include/asm_include shape. Cached. */
async function loadFlatHeaders(share, prefix, pattern) {
  const cache = shareCache(share);
  const key = "flat:" + prefix + ":" + pattern;
  if (cache.has(key)) return cache.get(key);
  const out = {};
  for (const rel of await share.list(prefix)) {
    const name = rel.slice(prefix.length + 1);
    if (name.includes("/") || !pattern.test(name)) continue;
    out[name] = await share.text(rel);
  }
  cache.set(key, out);
  return out;
}

/**
 * Read libgcc.a + libc.a + libnosys.a — the 3 ARM target archives bundled in
 * the share tree (self-contained, like Genesis-C does it; previously read from
 * the 14 GB build/arm-toolchain/install tree, which coupled the package to the
 * build workspace). Cached per share instance.
 */
async function readTargetArchives(share) {
  const cache = shareCache(share);
  if (cache.has("target-archives")) return cache.get("target-archives");
  const out = {};
  for (const name of ["libc.a", "libnosys.a", "libgcc.a"]) {
    try {
      out[name] = await share.bytes("arm-archives/" + name);
    } catch (e) {
      // libnosys may not be present on every toolchain; skip if missing.
      if (name === "libnosys.a") continue;
      throw e;
    }
  }
  cache.set("target-archives", out);
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
 * @param {Object} a.share share accessor
 * @param {Object} a.tools the 4 ARM tool runners
 * @param {string} a.key cache key (sdk name + variant)
 * @param {string[]} a.srcDirs share-relative dirs to scan for .c/.s
 * @param {Record<string,string>} a.headers headers map for cc1 (sys + sdk + src-local)
 * @param {string[]} [a.cppDefines] e.g. ["SYS_GBA=1"] applied to .s preprocessing
 * @param {string[]} [a.cc1Options]
 * @returns {Promise<{ok:boolean, objects?:Record<string,Uint8Array>, stage?:string, log?:string}>}
 */
const _sdkObjCache = new Map();
async function compileSdkObjects({ share, tools, key, srcDirs, headers, cppDefines = [], cc1Options = [] }) {
  const { runCc1arm, runArmAs } = tools;
  // Gather source files (preserve sub-path in the object name to avoid clashes).
  // Also collect .s/.inc files as AVAILABLE INCLUDES — GAS asm often #includes
  // sibling .s "type" files (e.g. libtonc's tte_types.s) and .inc macro files.
  const files = [];
  const localIncludes = {};
  for (const dir of srcDirs) {
    for (const rel of await share.list(dir)) {
      const sub = rel.slice(dir.length + 1);
      const base = sub.split("/").pop();
      if (/\.(c|s)$/i.test(base)) {
        files.push({ rel, sub });
        if (/\.s$/i.test(base)) localIncludes[base] = await share.text(rel);
      } else if (/\.(inc|h)$/i.test(base)) {
        localIncludes[base] = await share.text(rel);
      }
    }
  }
  headers = { ...headers, ...localIncludes };
  // Cache key folds in every source file's bytes so an edit busts the cache.
  const srcTexts = {};
  for (const f of files) srcTexts[f.sub] = await share.text(f.rel);
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

/** Read every .c/.s/.h/.inc source under the given share dirs into a
 *  {relpath: text} map (for hashing). Keys are share-RELATIVE (stable across
 *  machines and tree moves — hashing absolute paths broke the seed check). */
async function readSdkSources(share, srcDirs) {
  const out = {};
  for (const dir of srcDirs) {
    for (const rel of await share.list(dir)) {
      if (/\.(c|s|h|inc)$/i.test(rel)) out[rel] = await share.text(rel);
    }
  }
  return out;
}

/**
 * Resolve an SDK archive with the seed/rebuild policy: use the prebuilt seed .a
 * by default (fast), compile from source when `rebuild` is set, and warn if the
 * vendored source was edited but not rebuilt. `compile` produces the archive
 * from source (compileSdkObjects + packAr).
 */
async function sdkArchive({ share, io, name, srcDirs, seedBase, rebuild, writeSeed, compile }) {
  const sources = await readSdkSources(share, srcDirs);
  return resolveSdkArchive({
    name,
    sources,
    seedPath: seedBase + ".seed.a",
    seedHashPath: seedBase + ".seed.hash",
    rebuild,
    writeSeed,
    compileFromSource: compile,
    io,
  });
}

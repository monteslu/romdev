// sync32 — build a .s32 cart from C, entirely in WASM.
//
// sync32 is an RP2350 console: a game is a freestanding Cortex-M33 binary
// wrapped in a 64-byte header. The pipeline mirrors the SDK's sync32.mk:
//
//   cc1-arm   C        → ARM assembly     (-mcpu=cortex-m33 -mthumb, hard float)
//   as        assembly → object
//   ld        objects  → ELF              (crt0.o + ram.ld|xip.ld, --gc-sections)
//   objcopy   ELF      → flat binary
//   packS32   binary   → .s32             (the 64-byte header, in JS)
//
// TWO THINGS MAKE THIS CHEAP, and both were verified before writing it:
//
// 1. The ARM tools romdev already bundles for GBA are a full arm-none-eabi
//    gcc — they are not GBA-specific. Asked for `-mcpu=cortex-m33 -mthumb
//    -mfloat-abi=hard -mfpu=fpv5-sp-d16`, cc1 emits `.cpu cortex-m33 /
//    .arch armv8-m.main / .fpu fpv5-sp-d16` and as/ld accept it. So sync32
//    needs no new toolchain build — only its own flags and link script.
//
// 2. A sync32 cart links with NO libraries. The SDK is freestanding
//    (`-nostartfiles -ffreestanding`, no libc headers), and a natively-built
//    cart's ELF has zero undefined symbols and zero libgcc helpers. That
//    matters because the bundled ARM archives are ARMv4T (ARM7TDMI, for the
//    GBA) and would be link-incompatible with ARMv8-M — we simply never need
//    them. If a future cart does pull in a libgcc helper (a 64-bit divide,
//    say), the link fails with an undefined `__aeabi_*` symbol, and THAT is
//    the point at which an ARMv8-M libgcc has to be built. Nothing today
//    needs it.
//
// The SDK's crt0.S, ram.ld/xip.ld and sync32.h are shipped in
// romdev-platform-sync32 (see share/), so a cart builds from source text
// alone with no sibling checkout.

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { makeGccToolchain } from "../common/gcc-toolchain.js";
import { packS32 } from "./s32-format.js";
import { packS32Archive, buildInfoTxt, checkIconBmp } from "./s32-archive.js";

// Exactly the SDK's CFLAGS architecture flags (sync32.mk). Kept as one list so
// cc1 and as cannot disagree about the target — a mismatch there produces
// objects that link but fault on hardware.
const M33_FLAGS = [
  "-mcpu=cortex-m33",
  "-mthumb",
  "-mfloat-abi=hard",
  "-mfpu=fpv5-sp-d16",
];

// The rest of the SDK's CFLAGS. -fsingle-precision-constant matters: the M33's
// FPU is single-precision only (fpv5-SP), so an unsuffixed float literal would
// otherwise promote to double and drag in soft-float helpers we do not link.
// `-nostartfiles` is absent on purpose: it is a DRIVER option (gcc), not a cc1
// one, and cc1 rejects it outright ("valid for the driver but not for C"). Its
// effect is preserved anyway, because we drive ld ourselves with only the
// objects we built.
//
// `-ffreestanding` IS a cc1 option and MUST be kept. Without it gcc assumes a
// hosted environment and is free to synthesize libc calls: a struct/array
// initializer becomes a `bl memset`, which then fails to link against a cart
// that has no libc. (Measured: the same source compiles with only
// `__aeabi_uldivmod` undefined WITH the flag, and `memset` + `__aeabi_uldivmod`
// without it.) Dropping it alongside -nostartfiles was a real bug.
const SDK_CFLAGS = [
  "-O2",
  "-ffunction-sections",
  "-fdata-sections",
  "-fsingle-precision-constant",
  "-Wall",
  "-ffreestanding",
];

/**
 * The 4 WASM tool runners, pointed at the ARM toolchain that ships with the
 * GBA platform package (same binaries, different flags).
 * @param {import("../common/gcc-toolchain.js").GccToolchainEnv} [env]
 */
export function makeSync32Tools(env) {
  return makeGccToolchain({
    pkg: "romdev-platform-gba",
    label: "arm-none-eabi-gcc (cortex-m33)",
    glue: {
      cc1: "cc1-arm.mjs",
      as: "arm-none-eabi-as.mjs",
      ld: "arm-none-eabi-ld.mjs",
      objcopy: "arm-none-eabi-objcopy.mjs",
    },
    cc1Flags: M33_FLAGS,
    asFlags: M33_FLAGS,
    ldScriptName: "sync32.ld",
    outputName: "main.bin",
    defaultEndian: "little",
  }, env);
}

const tools = makeSync32Tools();
export const { runCc1: runCc1m33, runAs: runM33As, runLd: runM33Ld, runObjcopy: runM33Objcopy } = tools;

/**
 * Build a sync32 cart: C sources (+ the SDK's crt0/linker script/header) → .s32.
 *
 * @param {Object} args
 * @param {string} [args.source] single C source
 * @param {Record<string,string>} [args.sources] multi-file: name → contents
 * @param {Record<string,string>} [args.includes] headers visible to every unit
 * @param {string} args.crt0 crt0.S source (SDK)
 * @param {string} args.linkScript ram.ld or xip.ld (SDK)
 * @param {"ram"|"xip"} [args.mode]
 * @param {string} [args.title] shown by the launcher (16 bytes)
 * @param {string} [args.id] save-file key (8 bytes)
 * @param {"240"|"180"} [args.video]
 * @param {number} [args.api] minimum console API the game requires
 * @param {string[]} [args.options] extra cc1 flags (the SDK's CFLAGS_EXTRA)
 * @param {string[]} [args.linkOptions] extra ld flags (LDFLAGS_EXTRA)
 * @param {Record<string,Uint8Array|string>} [args.data] resource files the game
 *   reads through the disk API. Present ⇒ the ARCHIVE form is produced.
 * @param {Uint8Array} [args.icon] 16x16 24/32bpp BMP launcher icon (archive form)
 */
export async function buildSync32(args) {
  const {
    source, sources, includes = {}, crt0, linkScript,
    mode = "ram", title = "untitled", id, video = "240", api = 1,
    options = [], linkOptions = [], data, icon,
  } = args;

  if (!crt0) return fail("sync32 build needs the SDK's crt0.S (`crt0`)", "setup");
  if (!linkScript) return fail(`sync32 build needs the SDK's ${mode}.ld (\`linkScript\`)`, "setup");

  const units = sources && Object.keys(sources).length
    ? sources
    : (source ? { "main.c": source } : null);
  if (!units) return fail("sync32 build needs `source` or `sources`", "setup");

  let log = "";
  /** @type {Record<string, Uint8Array>} */
  const objects = {};

  // crt0 FIRST: it holds the vector table / _start, and the link script places
  // it at the image base. Assembling it through cc1 would be wrong (it is .S
  // assembly, not C), so it goes straight to `as`.
  const c0 = await runM33As({ source: crt0, includes });
  log += "--- as crt0.S ---\n" + c0.log;
  if (c0.exitCode !== 0 || !c0.object) return fail(log, "as", c0.exitCode);
  objects["crt0.o"] = c0.object;

  // One object per C translation unit, same as the SDK's single-command build
  // (which hands every .c to gcc at once).
  const allHeaders = { ...includes, ...Object.fromEntries(Object.entries(units).filter(([n]) => !/\.c$/i.test(n))) };
  for (const [name, text] of Object.entries(units)) {
    if (!/\.c$/i.test(name)) continue;
    const objName = name.replace(/\.c$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_") + ".o";
    const cc = await runCc1m33({ source: text, headers: allHeaders, options: [...SDK_CFLAGS, ...options] });
    log += `\n--- cc1 ${name} ---\n` + cc.log;
    if (cc.exitCode !== 0 || !cc.asmSource) return fail(log, "cc1", cc.exitCode, name);
    const as = await runM33As({ source: cc.asmSource, includes: allHeaders });
    log += `\n--- as ${name} ---\n` + as.log;
    if (as.exitCode !== 0 || !as.object) return fail(log, "as", as.exitCode, name);
    objects[objName] = as.object;
  }

  // libgcc: the compiler's own helper routines (64-bit divide, soft-float
  // doubles, ...). NOT libc — a cart still links no libc at all. It is last on
  // the link line, as libgcc always is, so it only pulls the members actually
  // referenced.
  //
  // It must be the ARMv8-M build: the ARM archives that ship for the GBA are
  // ARMv4T and would be silently link-incompatible with a Cortex-M33 object.
  // Absent, the link fails loudly on `__aeabi_*` rather than producing
  // something that faults on hardware.
  const archives = {};
  const libgcc = args.libgcc ?? loadBundledLibgcc();
  if (libgcc) archives["libgcc.a"] = libgcc;

  const ld = await runM33Ld({
    objects, linkScript, archives,
    // The archive is MOUNTED via `archives` but must also be NAMED on the
    // command line — runLd only lists `objects` there — and it has to come
    // AFTER the objects, because ld resolves an archive against the undefined
    // symbols it has seen so far.
    options: ["--gc-sections", ...(libgcc ? ["/work/libgcc.a"] : []), ...linkOptions],
  });
  log += "\n--- ld ---\n" + ld.log;
  if (ld.exitCode !== 0 || !ld.elf) return fail(log, "ld", ld.exitCode);

  const oc = await runM33Objcopy({ elf: ld.elf });
  log += "\n--- objcopy ---\n" + oc.log;
  const image = oc.binary ?? null;
  if (oc.exitCode !== 0 || !image) return fail(log, "objcopy", oc.exitCode);

  // The 64-byte header. Entry point comes from the ELF's `_start`, which is
  // why the ELF is kept rather than discarded after objcopy.
  let packed;
  try {
    packed = packS32({ image, elf: ld.elf, mode, title, id: id ?? deriveId(title), video, api });
  } catch (e) {
    return fail(log + "\n--- pack ---\n" + e.message, "pack", 1);
  }

  // THREE SHIPPING FORMS, and the caller picks by whether it passed resources.
  //
  // A bare .s32 is the executable alone. A game that reads files through the
  // disk API needs its namespace with it, which is the folder form
  // (main.s32e + info.txt + icon.bmp + resources) or that folder tarred into
  // one .s32. We emit the archive, because it is a single file the console
  // loads directly and `tar xf` recovers the folder from it.
  const hasData = data && Object.keys(data).length > 0;
  let binary = packed.bytes;
  let form = "executable";
  const notes = [];
  // `archive` (default when there are resources) is the single-file tar form.
  // `folder` writes the game directory instead: main.s32e plus the resources
  // beside it. BOTH are valid per the ABI, but they are not interchangeable at
  // load time — the libretro core reads a BARE EXECUTABLE and looks for a
  // sibling `<romname>/` data directory, and does NOT unpack a tar. So a cart
  // you intend to run through romdev's own emulator wants `form:'folder'`,
  // while `archive` is the shape you ship.
  const wantFolder = args.form === "folder";
  if (hasData && wantFolder) {
    const members = { "info.txt": toBytes(buildInfoTxt(title)) };
    if (icon) members["icon.bmp"] = icon;
    for (const [name, bytes] of Object.entries(data)) members[name.split("/").pop()] = toBytes(bytes);
    return {
      binary: packed.bytes,           // the bare executable
      dataFiles: members,             // written beside it as <romname>/
      elf: ld.elf, map: ld.map ?? "", log, exitCode: 0, stage: "done",
      imageBytes: image.length, entryOffset: packed.entryOffset, mode,
      form: "folder",
    };
  }
  if (hasData) {
    /** @type {Record<string, Uint8Array>} */
    const members = { "main.s32e": packed.bytes, "info.txt": toBytes(buildInfoTxt(title)) };
    if (icon) {
      // A bad icon is a WARNING, never a build failure: the launcher ignores
      // one it cannot read and draws its own (matching the SDK's s32pack).
      const why = checkIconBmp(icon);
      if (why) notes.push(`icon.bmp will be ignored by the launcher (${why})`);
      members["icon.bmp"] = icon;
    }
    for (const [name, bytes] of Object.entries(data)) {
      const base = name.split("/").pop();
      if (base === "main.s32e" || base === "info.txt" || base === ".s32id") {
        return fail(log + `\n--- pack ---\n'${base}' is a name the console owns inside a game namespace; rename the resource`, "pack", 1);
      }
      members[base] = toBytes(bytes);
    }
    try {
      binary = packS32Archive(members);
      form = "archive";
    } catch (e) {
      return fail(log + "\n--- pack ---\n" + e.message, "pack", 1);
    }
  }

  return {
    binary,
    elf: ld.elf,
    map: ld.map ?? "",
    log,
    exitCode: 0,
    stage: "done",
    imageBytes: image.length,
    entryOffset: packed.entryOffset,
    mode,
    form,
    ...(hasData ? { members: Object.keys(data).length + 2 + (icon ? 1 : 0) } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** Accept resource files as bytes or as text. */
function toBytes(v) {
  if (typeof v === "string") return new TextEncoder().encode(v);
  return v instanceof Uint8Array ? v : new Uint8Array(v);
}


/**
 * The bundled ARMv8-M libgcc, or null if this install does not ship one.
 *
 * Null is not fatal: a cart that never needs a helper routine links fine
 * without it, and one that does gets a clear `undefined reference to
 * __aeabi_*` naming exactly what is missing. Memoized — the archive is a few
 * MB and every build would otherwise re-read it.
 */
let _libgcc;
function loadBundledLibgcc() {
  if (_libgcc !== undefined) return _libgcc;
  try {
    const { sdk } = createRequire(import.meta.url)("romdev-platform-sync32");
    _libgcc = sdk?.libgcc && existsSync(sdk.libgcc) ? new Uint8Array(readFileSync(sdk.libgcc)) : null;
  } catch {
    _libgcc = null;
  }
  return _libgcc;
}

/** An 8-byte save key derived from the title, when the caller gives none. */
function deriveId(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "game";
  return (slug + "00").slice(0, 8);
}

function fail(log, stage, exitCode = 1, failedTU) {
  return { binary: null, log, exitCode: exitCode || 1, stage, ...(failedTU ? { failedTU } : {}) };
}

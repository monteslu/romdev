// mips-c — minimal C → MIPS binary builder for PS1 (and N64), the bare
// gcc+newlib+libgcc path (no SDK yet). Mirrors genesis-c.js's buildMinimal.
//
//   buildMipsC({ source, sources, headers, platform }) →
//     PS1: a runnable PS-EXE ('PS-X EXE' header + .text at 0x80010000)
//     N64: a flat .bin (boot glue is libdragon's job — minimal path for now)
//
// Pipeline per source: cc1 → as → (link all with crt0 + libc/libm/libgcc) →
// objcopy → wrap. Endianness from the platform (PS1 little / N64 big).

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCc1mips, runMipsAs, runMipsLd, runMipsObjcopy } from "../mips-elf-gcc/gcc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, "lib");

/** Wrap a raw .text image in a PS-EXE header (2048 bytes). The PS1 BIOS loads
 *  `t_size` bytes from the file (after the header) to `t_addr` and jumps to pc0. */
function wrapPsExe(text, loadAddr = 0x80010000, spBase = 0x801ffff0) {
  const hdr = new Uint8Array(2048);
  hdr.set(new TextEncoder().encode("PS-X EXE"), 0);
  const put = (o, v) => { hdr[o] = v & 0xff; hdr[o + 1] = (v >> 8) & 0xff; hdr[o + 2] = (v >> 16) & 0xff; hdr[o + 3] = (v >>> 24) & 0xff; };
  put(0x10, loadAddr);                       // pc0 (entry)
  put(0x18, loadAddr);                       // t_addr (load address)
  put(0x1c, (text.length + 3) & ~3);         // t_size
  put(0x30, spBase);                         // s_addr (stack base)
  const out = new Uint8Array(2048 + text.length);
  out.set(hdr, 0); out.set(text, 2048);
  return out;
}

// Minimal clean-room N64 IPL3 (assembled from lib/n64-ipl3.s): runs in SP DMEM at
// 0xA4000040 after the (HLE or real) PIF boot copies ROM[0x40..0xFFF] there. It
// PI-DMAs 1 MB from cart 0xB0001000 → RDRAM 0x80000400 and jumps to the game entry.
const N64_IPL3 = [
  0x3c08a460, 0x24090400, 0xad090000, 0x3c091000, 0x35291000, 0xad090004,
  0x3c09000f, 0x3529ffff, 0xad09000c, 0x8d0a0010, 0x314a0003, 0x1540fffd,
  0x00000000, 0x3c0b8000, 0x356b0400, 0x01600008, 0x00000000,
];

/** Wrap a raw .text image (linked at 0x80000400) in a bootable big-endian .z64:
 *  64-byte header (0x80371240 magic + entry) + IPL3 at 0x40 + game at 0x1000. The
 *  parallel_n64 HLE boot runs the IPL3, which copies the game to RDRAM and jumps. */
function wrapN64Rom(text, entry = 0x80000400) {
  const GAME_OFF = 0x1000;
  const size = GAME_OFF + ((text.length + 3) & ~3);
  const rom = new Uint8Array(size < 0x101000 ? 0x101000 : size); // ≥1MB (IPL3 copies 1MB)
  const be32 = (o, v) => { rom[o] = (v >>> 24) & 0xff; rom[o + 1] = (v >> 16) & 0xff; rom[o + 2] = (v >> 8) & 0xff; rom[o + 3] = v & 0xff; };
  // header: PI BSD config / magic, clock, entry, release
  be32(0x00, 0x80371240);          // magic (Z64, native big-endian)
  be32(0x04, 0x0000000f);          // clock rate
  be32(0x08, entry);               // boot entry (informational; IPL3 jumps explicitly)
  be32(0x0c, 0x00001444);          // release
  // name (0x20..0x33)
  const name = "ROMDEV HOMEBREW     ";
  for (let i = 0; i < 20; i++) rom[0x20 + i] = name.charCodeAt(i);
  be32(0x3c, 0x0000004e); // cartridge id "NE" placeholder + region
  // IPL3 at 0x40
  for (let i = 0; i < N64_IPL3.length; i++) be32(0x40 + i * 4, N64_IPL3[i]);
  // game at 0x1000
  rom.set(text, GAME_OFF);
  return rom;
}

/**
 * Build a minimal C program to a runnable PS1/N64 image.
 * @param {Object} args
 * @param {string} [args.source] single C source
 * @param {Record<string,string>} [args.sources] multi-file (name → text)
 * @param {Record<string,string>} [args.headers] virtual headers
 * @param {string} args.platform "ps1" | "n64"
 * @param {string[]} [args.cc1Options]
 */
export async function buildMipsC(args) {
  const platform = args.platform;
  const endian = platform === "ps1" ? "little" : "big";
  const cc1Options = [...(args.cc1Options ?? []), "-O2", "-G0", "-ffreestanding", "-fno-builtin", "-Wall"];
  const sources = args.sources ?? (args.source != null ? { "main.c": args.source } : {});

  // Auto-bundle the platform helper lib so `#include "n64.h"` / `#include "psx.h"`
  // just works (parity with the Dreamcast sh-c path that auto-bundles dc.h). The
  // header is added to the virtual headers; the matching .c is compiled + linked as
  // an extra source — UNLESS the caller already provides their own (caller wins, and
  // we skip auto-linking the .c if a same-named source is already present so there's
  // no duplicate-symbol clash). The helper lives in platforms/<platform>/lib/c/.
  const helperName = platform === "ps1" ? "psx" : platform === "n64" ? "n64" : null;
  const headers = { ...(args.headers ?? {}) };
  /** @type {Record<string,string>} */
  let autoHelperSrc = null;
  if (helperName) {
    const helperDir = path.join(__dirname, "..", "..", "platforms", platform, "lib", "c");
    const hPath = path.join(helperDir, `${helperName}.h`);
    const cPath = path.join(helperDir, `${helperName}.c`);
    if (headers[`${helperName}.h`] == null) {
      const hSrc = await readFile(hPath, "utf-8").catch(() => null);
      if (hSrc != null) headers[`${helperName}.h`] = hSrc;
    }
    const callerHasC = (args.sources && (args.sources[`${helperName}.c`] != null));
    if (!callerHasC) autoHelperSrc = await readFile(cPath, "utf-8").catch(() => null);
  }
  let log = "";

  /** @type {Record<string, Uint8Array>} */
  const userObjs = {};
  for (const cName of Object.keys(sources).filter((n) => /\.c$/i.test(n))) {
    const cc = await runCc1mips({ source: sources[cName], headers, options: cc1Options, endian });
    log += `--- cc1 (${cName}) ---\n${cc.log || "(ok)"}\n`;
    if (cc.exitCode !== 0 || !cc.asmSource) return { ok: false, binary: null, log, exitCode: cc.exitCode || 1, stage: `cc1 (${cName})`, ...(cc.crash ? { crash: cc.crash } : {}) };
    const as = await runMipsAs({ source: cc.asmSource, endian });
    log += `--- as (${cName}) ---\n${as.log || "(ok)"}\n`;
    if (as.exitCode !== 0 || !as.object) return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${cName})`, ...(as.crash ? { crash: as.crash } : {}) };
    userObjs[cName.replace(/\.c$/i, ".o")] = as.object;
  }
  // Auto-bundled helper .c (n64.c / psx.c) — compiled with the SAME headers so it can
  // see its own header, linked alongside the user objects. Skipped when the caller
  // supplied their own helper .c (callerHasC) above.
  if (autoHelperSrc != null) {
    const cc = await runCc1mips({ source: autoHelperSrc, headers, options: cc1Options, endian });
    log += `--- cc1 (${helperName}.c, bundled) ---\n${cc.log || "(ok)"}\n`;
    if (cc.exitCode !== 0 || !cc.asmSource) return { ok: false, binary: null, log, exitCode: cc.exitCode || 1, stage: `cc1 (${helperName}.c bundled)`, ...(cc.crash ? { crash: cc.crash } : {}) };
    const as = await runMipsAs({ source: cc.asmSource, endian });
    log += `--- as (${helperName}.c, bundled) ---\n${as.log || "(ok)"}\n`;
    if (as.exitCode !== 0 || !as.object) return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${helperName}.c bundled)` };
    userObjs[`${helperName}.o`] = as.object;
  }

  // raw .s sources too
  for (const sName of Object.keys(sources).filter((n) => /\.(s|asm)$/i.test(n))) {
    const as = await runMipsAs({ source: sources[sName], endian });
    log += `--- as (${sName}) ---\n${as.log || "(ok)"}\n`;
    if (as.exitCode !== 0 || !as.object) return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${sName})`, ...(as.crash ? { crash: as.crash } : {}) };
    userObjs[sName.replace(/\.(s|asm)$/i, ".o")] = as.object;
  }

  // crt0 (per platform)
  const crt0Name = platform === "ps1" ? "ps1-crt0.s" : "n64-crt0.s";
  const crt0Src = await readFile(path.join(LIB, crt0Name), "utf-8");
  const crt0As = await runMipsAs({ source: crt0Src, endian });
  log += `--- as (${crt0Name}) ---\n${crt0As.log || "(ok)"}\n`;
  if (crt0As.exitCode !== 0 || !crt0As.object) return { ok: false, binary: null, log, exitCode: crt0As.exitCode || 1, stage: "as (crt0)", ...(crt0As.crash ? { crash: crt0As.crash } : {}) };

  // softint.c — the few libgcc helpers (64-bit divide/mod) in plain C, so the
  // link doesn't need an endian-specific libgcc.a (the EL libgcc isn't bundled).
  const softSrc = await readFile(path.join(LIB, "softint.c"), "utf-8");
  const softCc = await runCc1mips({ source: softSrc, options: cc1Options, endian });
  const softAs = softCc.asmSource ? await runMipsAs({ source: softCc.asmSource, endian }) : { exitCode: 1 };
  if (softCc.exitCode !== 0 || softAs.exitCode !== 0 || !softAs.object) {
    return { ok: false, binary: null, log: log + (softCc.log || "") + (softAs.log || ""), exitCode: 1, stage: "softint" };
  }

  // link
  const ldName = platform === "ps1" ? "ps1.ld" : "n64.ld";
  const linkScript = await readFile(path.join(LIB, ldName), "utf-8");
  // newlib + libgcc are endian-specific: el/ (PS1 little) vs be/ (N64 big). libgcc
  // is only bundled for be/ — softint.c covers the EL case, so libgcc is optional.
  const libDir = path.join(LIB, endian === "little" ? "el" : "be");
  const [libc, libm] = await Promise.all([
    readFile(path.join(libDir, "libc.a")), readFile(path.join(libDir, "libm.a")),
  ]);
  const archives = { "libc.a": new Uint8Array(libc), "libm.a": new Uint8Array(libm) };
  const libraries = ["c", "m"];
  try {
    const libgcc = await readFile(path.join(libDir, "libgcc.a"));
    archives["libgcc.a"] = new Uint8Array(libgcc);
    libraries.unshift("gcc");
  } catch { /* no endian libgcc — softint.c provides the needed helpers */ }
  const ld = await runMipsLd({
    objects: { "crt0.o": crt0As.object, "softint.o": softAs.object, ...userObjs },
    linkScript, endian,
    archives,
    libraries,
    libraryPaths: ["/work"],
    options: ["--no-warn-rwx-segments"],
  });
  log += `--- ld ---\n${ld.log || "(ok)"}\n`;
  if (ld.exitCode !== 0 || !ld.elf) return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", ...(ld.crash ? { crash: ld.crash } : {}) };

  const oc = await runMipsObjcopy({ elf: ld.elf });
  log += `--- objcopy ---\n${oc.log || "(ok)"}\n`;
  if (oc.exitCode !== 0 || !oc.binary) return { ok: false, binary: null, log, exitCode: oc.exitCode || 1, stage: "objcopy", ...(oc.crash ? { crash: oc.crash } : {}) };

  const binary = platform === "ps1" ? wrapPsExe(oc.binary)
    : platform === "n64" ? wrapN64Rom(oc.binary)
    : oc.binary;
  return { ok: true, binary, log, exitCode: 0, stage: "done", ...(ld.map ? { symbols: ld.map } : {}) };
}

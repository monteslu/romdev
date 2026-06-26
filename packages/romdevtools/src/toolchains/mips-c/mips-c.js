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
  const headers = args.headers ?? {};
  const cc1Options = [...(args.cc1Options ?? []), "-O2", "-G0", "-ffreestanding", "-fno-builtin", "-Wall"];
  const sources = args.sources ?? (args.source != null ? { "main.c": args.source } : {});
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

  // link
  const ldName = platform === "ps1" ? "ps1.ld" : "n64.ld";
  const linkScript = await readFile(path.join(LIB, ldName), "utf-8");
  const [libgcc, libc, libm] = await Promise.all([
    readFile(path.join(LIB, "libgcc.a")), readFile(path.join(LIB, "libc.a")), readFile(path.join(LIB, "libm.a")),
  ]);
  const ld = await runMipsLd({
    objects: { "crt0.o": crt0As.object, ...userObjs },
    linkScript, endian,
    archives: { "libgcc.a": new Uint8Array(libgcc), "libc.a": new Uint8Array(libc), "libm.a": new Uint8Array(libm) },
    libraries: ["c", "gcc", "m"],
    libraryPaths: ["/work"],
    options: ["--no-warn-rwx-segments"],
  });
  log += `--- ld ---\n${ld.log || "(ok)"}\n`;
  if (ld.exitCode !== 0 || !ld.elf) return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", ...(ld.crash ? { crash: ld.crash } : {}) };

  const oc = await runMipsObjcopy({ elf: ld.elf });
  log += `--- objcopy ---\n${oc.log || "(ok)"}\n`;
  if (oc.exitCode !== 0 || !oc.binary) return { ok: false, binary: null, log, exitCode: oc.exitCode || 1, stage: "objcopy", ...(oc.crash ? { crash: oc.crash } : {}) };

  const binary = platform === "ps1" ? wrapPsExe(oc.binary) : oc.binary;
  return { ok: true, binary, log, exitCode: 0, stage: "done", ...(ld.map ? { symbols: ld.map } : {}) };
}

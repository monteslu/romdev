// sh-c — Dreamcast (SH-4) C build driver.
//
//   buildShC({ source | sources, headers }) → { ok, binary (ELF), log, symbols }
//
// gcc-the-driver can't fork/exec under emscripten, so we orchestrate the stages
// directly (cc1 → as → ld → objcopy-not-needed). The output is an ELF that Flycast's
// reios HLE BIOS boots directly (no GD-ROM/CDI image, no scrambling): reios_loadElf
// copies the PT_LOAD segments to their vaddr (0x8c010000) and jumps to _start.
//
// Bare path: a small crt0 sets the stack (top of 16 MB DC RAM), zeroes .bss, and
// calls main(). newlib libc/libm + libgcc are linked (SH-4, little-endian). The
// romdev DC helper (rom-games/dreamcast/.../dc.h) brings up the PowerVR2 framebuffer.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runCc1sh, runShAs, runShLd } from "../sh-elf-gcc/gcc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIB = path.join(__dirname, "lib");

/**
 * Compile + link Dreamcast SH-4 C to a bootable ELF.
 * @param {object} args
 * @param {string} [args.source] single C source (shorthand for sources["main.c"])
 * @param {Record<string,string>} [args.sources] name → source (.c and .s)
 * @param {Record<string,string>} [args.headers] name → header text
 * @param {string[]} [args.cc1Options] extra cc1 flags
 */
export async function buildShC(args) {
  const headers = args.headers ?? {};
  // -m4-single-only is passed by the cc1 wrapper; here the language/codegen knobs.
  const cc1Options = [...(args.cc1Options ?? []), "-O2", "-ffreestanding", "-fno-builtin", "-Wall"];
  const sources = args.sources ?? (args.source != null ? { "main.c": args.source } : {});
  let log = "";

  /** @type {Record<string, Uint8Array>} */
  const userObjs = {};
  for (const cName of Object.keys(sources).filter((n) => /\.c$/i.test(n))) {
    const cc = await runCc1sh({ source: sources[cName], headers, options: cc1Options });
    log += `--- cc1 (${cName}) ---\n${cc.log || "(ok)"}\n`;
    if (cc.exitCode !== 0 || !cc.asmSource)
      return { ok: false, binary: null, log, exitCode: cc.exitCode || 1, stage: `cc1 (${cName})`, ...(cc.crash ? { crash: cc.crash } : {}) };
    const as = await runShAs({ source: cc.asmSource });
    log += `--- as (${cName}) ---\n${as.log || "(ok)"}\n`;
    if (as.exitCode !== 0 || !as.object)
      return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${cName})`, ...(as.crash ? { crash: as.crash } : {}) };
    userObjs[cName.replace(/\.c$/i, ".o")] = as.object;
  }
  // raw .s sources too
  for (const sName of Object.keys(sources).filter((n) => /\.(s|asm)$/i.test(n))) {
    const as = await runShAs({ source: sources[sName] });
    log += `--- as (${sName}) ---\n${as.log || "(ok)"}\n`;
    if (as.exitCode !== 0 || !as.object)
      return { ok: false, binary: null, log, exitCode: as.exitCode || 1, stage: `as (${sName})`, ...(as.crash ? { crash: as.crash } : {}) };
    userObjs[sName.replace(/\.(s|asm)$/i, ".o")] = as.object;
  }

  // crt0 (stack + .bss clear + main()).
  const crt0Src = await readFile(path.join(LIB, "dc-crt0.s"), "utf-8");
  const crt0As = await runShAs({ source: crt0Src });
  log += `--- as (dc-crt0.s) ---\n${crt0As.log || "(ok)"}\n`;
  if (crt0As.exitCode !== 0 || !crt0As.object)
    return { ok: false, binary: null, log, exitCode: crt0As.exitCode || 1, stage: "as (crt0)", ...(crt0As.crash ? { crash: crt0As.crash } : {}) };

  // link: crt0 + user objects + newlib (libc/libm) + libgcc.
  const linkScript = await readFile(path.join(LIB, "dc.ld"), "utf-8");
  const [libc, libm, libgcc] = await Promise.all([
    readFile(path.join(LIB, "libc.a")),
    readFile(path.join(LIB, "libm.a")),
    readFile(path.join(LIB, "libgcc.a")),
  ]);
  const ld = await runShLd({
    objects: { "crt0.o": crt0As.object, ...userObjs },
    linkScript,
    archives: {
      "libc.a": new Uint8Array(libc),
      "libm.a": new Uint8Array(libm),
      "libgcc.a": new Uint8Array(libgcc),
    },
    libraries: ["c", "m", "gcc"],
    libraryPaths: ["/work"],
    options: ["--no-warn-rwx-segments"],
  });
  log += `--- ld ---\n${ld.log || "(ok)"}\n`;
  if (ld.exitCode !== 0 || !ld.elf)
    return { ok: false, binary: null, log, exitCode: ld.exitCode || 1, stage: "ld", ...(ld.crash ? { crash: ld.crash } : {}) };

  // The ELF IS the deliverable — reios boots it directly.
  return { ok: true, binary: ld.elf, log, exitCode: 0, stage: "done", ...(ld.map ? { symbols: ld.map } : {}) };
}

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
import { CBuild, BuildError } from "../common/c-build.js";

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
  // The bundled DC helper (dc.h) is auto-available so `#include "dc.h"` just works —
  // it brings up the PowerVR2 framebuffer (FB_R_CTRL/SIZE/SOF1 + SPG for 640x480 RGB565)
  // that Flycast presents. A caller-supplied "dc.h" wins (override the bundled one).
  const bundledDcH = await readFile(path.join(LIB, "dc.h"), "utf-8").catch(() => null);
  const headers = { ...(bundledDcH != null ? { "dc.h": bundledDcH } : {}), ...(args.headers ?? {}) };
  // -m4-single-only is passed by the cc1 wrapper; here the language/codegen knobs.
  // Default to -O1, NOT -O2: the sh-elf cc1.wasm build has an -O2-only pass that aborts
  // ("memory access out of bounds" during "Assembling functions") on common control
  // flow — e.g. an infinite loop that mutates locals through both `if`/`else` branches.
  // -O1 dodges it entirely and is plenty for DC homebrew. A user-supplied -O<level>
  // still wins (gcc honors the LAST -O, so only add a default when none is present).
  const userOpts = args.cc1Options ?? [];
  const hasOpt = userOpts.some((o) => /^-O/.test(o));
  const cc1Options = [...(hasOpt ? [] : ["-O1"]), ...userOpts, "-ffreestanding", "-fno-builtin", "-Wall"];
  const sources = args.sources ?? (args.source != null ? { "main.c": args.source } : {});
  const cb = new CBuild();
  const as = (source) => runShAs({ source });

  try {
    /** @type {Record<string, Uint8Array>} */
    const userObjs = {};
    for (const cName of Object.keys(sources).filter((n) => /\.c$/i.test(n))) {
      const cc = await cb.stage(`cc1 (${cName})`, () => runCc1sh({ source: sources[cName], headers, options: cc1Options }), (r) => r.asmSource);
      const ao = await cb.stage(`as (${cName})`, () => as(cc.asmSource), (r) => r.object);
      userObjs[cName.replace(/\.c$/i, ".o")] = ao.object;
    }
    // raw .s sources too
    for (const sName of Object.keys(sources).filter((n) => /\.(s|asm)$/i.test(n))) {
      const ao = await cb.stage(`as (${sName})`, () => as(sources[sName]), (r) => r.object);
      userObjs[sName.replace(/\.(s|asm)$/i, ".o")] = ao.object;
    }

    // crt0 (stack + .bss clear + main()).
    const crt0Src = await readFile(path.join(LIB, "dc-crt0.s"), "utf-8");
    const crt0As = await cb.stage("as (dc-crt0.s)", () => as(crt0Src), (r) => r.object);

    // link: crt0 + user objects + newlib (libc/libm) + libgcc.
    const linkScript = await readFile(path.join(LIB, "dc.ld"), "utf-8");
    const [libc, libm, libgcc] = await Promise.all([
      readFile(path.join(LIB, "libc.a")),
      readFile(path.join(LIB, "libm.a")),
      readFile(path.join(LIB, "libgcc.a")),
    ]);
    const ld = await cb.stage("ld", () => runShLd({
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
    }), (r) => r.elf);

    // The ELF IS the deliverable — reios boots it directly.
    return { ok: true, binary: ld.elf, log: cb.log, exitCode: 0, stage: "done", ...(ld.map ? { symbols: ld.map } : {}) };
  } catch (e) {
    if (e instanceof BuildError) return e.toResult();
    throw e;
  }
}

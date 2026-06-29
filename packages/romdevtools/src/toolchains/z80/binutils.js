// z80-elf binutils (as / ld / objcopy), compiled to WASM. The GNU assembler
// for BOTH plain Z80 (SMS/GG/MSX) and the Game Boy CPU (gbz80 / SM83) — select
// with `-march=z80` or `-march=gbz80`. Used to reassemble native objdump output
// byte-exact (the disassembler is the matching z80-elf-objdump). Ships in
// romdev-toolchain-sdcc alongside sdas/sdcc.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { runIsolated, textFile, binaryFile, getOutputBytes } from "../_worker/run.js";
import { makeGlueResolver } from "../common/wasm-tool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// z80-elf binutils ship in romdev-toolchain-sdcc (alongside sdas/sdcc); a local
// src/ copy is the dev fallback. Lazy + memoized: resolve each glue only on its
// first use, not at boot.
const z80Glue = makeGlueResolver({ pkg: "romdev-toolchain-sdcc", localDir: __dirname, label: "sdas" });

/** True if the z80 GNU assembler chain is available. */
export function z80GnuAvailable() {
  try { z80Glue("z80-elf-as.mjs"); z80Glue("z80-elf-ld.mjs"); z80Glue("z80-elf-objcopy.mjs"); return true; }
  catch { return false; }
}

/**
 * Assemble z80/gbz80 GNU-as source → ELF object.
 * @param {object} a
 * @param {string} a.source
 * @param {'z80'|'gbz80'} [a.march] target CPU flavor (default z80)
 * @returns {Promise<{ object: Uint8Array|null, log: string, exitCode: number }>}
 */
export async function runZ80As(a) {
  const march = a.march ?? "z80";
  const r = await runIsolated({
    gluePath: z80Glue("z80-elf-as.mjs"),
    argv: [`-march=${march}`, "/work/in.s", "-o", "/work/out.o"],
    inputFiles: [textFile("/work/in.s", a.source)],
    outputFiles: [{ vfsPath: "/work/out.o", encoding: "base64" }],
  });
  return { object: getOutputBytes(r, "/work/out.o"), log: r.log, exitCode: r.exitCode };
}

/**
 * Link a z80 ELF object with a linker script → ELF executable.
 * @param {object} a
 * @param {Record<string,Uint8Array>} a.objects
 * @param {string} a.linkScript
 * @returns {Promise<{ elf: Uint8Array|null, log: string, exitCode: number }>}
 */
export async function runZ80Ld(a) {
  const inputFiles = [textFile("/work/z80.ld", a.linkScript)];
  for (const [name, bytes] of Object.entries(a.objects)) inputFiles.push(binaryFile("/work/" + name, bytes));
  const r = await runIsolated({
    gluePath: z80Glue("z80-elf-ld.mjs"),
    argv: ["-T", "/work/z80.ld", "-o", "/work/main.elf", ...Object.keys(a.objects).map((n) => "/work/" + n)],
    inputFiles,
    outputFiles: [{ vfsPath: "/work/main.elf", encoding: "base64" }],
  });
  return { elf: getOutputBytes(r, "/work/main.elf"), log: r.log, exitCode: r.exitCode };
}

/**
 * Strip a z80 ELF to a raw binary.
 * @param {object} a
 * @param {Uint8Array} a.elf
 * @returns {Promise<{ binary: Uint8Array|null, log: string, exitCode: number }>}
 */
export async function runZ80Objcopy(a) {
  const r = await runIsolated({
    gluePath: z80Glue("z80-elf-objcopy.mjs"),
    argv: ["-O", "binary", "/work/main.elf", "/work/main.bin"],
    inputFiles: [binaryFile("/work/main.elf", a.elf)],
    outputFiles: [{ vfsPath: "/work/main.bin", encoding: "base64" }],
  });
  return { binary: getOutputBytes(r, "/work/main.bin"), log: r.log, exitCode: r.exitCode };
}

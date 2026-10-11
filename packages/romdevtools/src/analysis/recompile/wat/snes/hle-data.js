// The data ROMs snes9x's high-level chip emulation reads (DSP-1, DSP-3,
// ST010). Upstream snes9x embeds them as C tables (dsp1.cpp DSP1ROM and the
// DSP1_SinTable taken from it, dsp3.cpp DSP3_DataROM, seta010.cpp
// ST010_M7Scale and ST010_SinTable). They are the chips' own mask-ROM data,
// so romdev ships none of them: the tables are emptied when snes9x is built
// (scripts/recompile-gen/snes9x-chips/hle-data.mjs) and filled from a file
// the user supplies (glue/romdev_hledata.h, the same code in the snes9x core
// and in a recompiled cart's chip unit).
//
// The file is the chip's data ROM as emulators name and dump it (16-bit
// little-endian words), or the whole firmware (program ROM then data ROM).
// The snes9x core looks for it in its system directory; a recompiled cart
// is built with it (options.firmware), and the verifier gives the reference
// core the same file. The words the HLE reads must equal those of the chip
// snes9x was written against (FNV-1a 32 over that range): for the DSP-1 that
// is the DSP-1B's data ROM, which snes9x uses for every DSP-1 cart.
//
// Plain JS ESM + JSDoc.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * By loader.js coprocessor name. `id` is the number romdev_hledata.h takes
 * (snes9x's Settings.DSP, or 10 for the ST010); `used` the bytes of the data
 * ROM the HLE reads, from its start; `fnv` their FNV-1a 32.
 */
export const HLE_DATA = Object.freeze({
  "DSP-1": { id: 1, data: "dsp1b.data.rom", whole: "dsp1b.rom", dataSize: 0x800, programSize: 0x1800, used: 0x800, fnv: 0x4ce5ea75,
    what: "the DSP-1B's data ROM (snes9x runs every DSP-1 cart with the DSP-1B's tables)" },
  "DSP-3": { id: 3, data: "dsp3.data.rom", whole: "dsp3.rom", dataSize: 0x800, programSize: 0x1800, used: 0x800, fnv: 0xc460f315,
    what: "the DSP-3's data ROM" },
  ST010: { id: 10, data: "st010.data.rom", whole: "st010.rom", dataSize: 0x1000, programSize: 0xc000, used: 0x360, fnv: 0xe6fa7eed,
    what: "the ST010's data ROM (its mode 7 scale and sine tables)" },
});

/** @param {Uint8Array} b */
export function fnv1a(b) {
  let h = 0x811c9dc5;
  for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** @param {string|null|undefined} coprocessor */
export function hleDataFor(coprocessor) {
  return (coprocessor && HLE_DATA[coprocessor]) || null;
}

/** How to supply it, for refusals and tool descriptions. */
export function hleDataHint(coprocessor) {
  const h = HLE_DATA[coprocessor];
  return `${h.data} (${h.dataSize} bytes: ${h.what}), or ${h.whole} (${h.programSize + h.dataSize} bytes: the program ROM then the data ROM)`;
}

/**
 * Read and check a user's data ROM file for a chip.
 * @param {string} coprocessor  loader.js name ("DSP-1", "DSP-3", "ST010")
 * @param {string} file
 * @returns {{chip:string, name:string, sha1:string, length:number, bytes:Uint8Array, data:Uint8Array}}
 */
export function readHleData(coprocessor, file) {
  const h = HLE_DATA[coprocessor];
  if (!h) throw new Error(`snes recompile: the ${coprocessor} reads no data ROM`);
  if (!existsSync(file)) throw new Error(`snes recompile: options.firmware: no file at ${file}`);
  const bytes = new Uint8Array(readFileSync(file));
  let name, data;
  if (bytes.length === h.dataSize) { name = h.data; data = bytes; }
  else if (bytes.length === h.programSize + h.dataSize) { name = h.whole; data = bytes.subarray(h.programSize); }
  else throw new Error(`snes recompile: options.firmware ${file} is ${bytes.length} bytes; the ${coprocessor} needs ${hleDataHint(coprocessor)}`);
  const got = fnv1a(data.subarray(0, h.used));
  if (got !== h.fnv) {
    throw new Error(`snes recompile: options.firmware ${file} is not ${h.what}: the ${h.used} bytes snes9x's ${coprocessor} emulation reads hash to FNV-1a ${got.toString(16).padStart(8, "0")}, expected ${h.fnv.toString(16).padStart(8, "0")}`);
  }
  return { chip: coprocessor, name, sha1: createHash("sha1").update(bytes).digest("hex"), length: bytes.length, bytes, data };
}

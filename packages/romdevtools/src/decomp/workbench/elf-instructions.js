// elf-instructions.js - a true per-object instruction count read straight
// from ELF section bytes: trailing all-zero words after the delay slot of the
// final `jr $ra` are alignment filler, not code, when at least
// MINIMUM_ELIDED_RUN of them follow.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { ElfFormatError, asciiReplace } from "./elf.js";

export const JR_RA_WORD = 0x03E00008;
export const MINIMUM_ELIDED_RUN = 2;
export { ElfFormatError };

function sectionBytes(data, section) {
  if (data.length < 52 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) throw new ElfFormatError("not an ELF file (bad magic)");
  if (data[4] !== 1) throw new ElfFormatError(`only 32-bit ELF (EI_CLASS=1) is supported, got class ${data[4]}`);
  if (data[5] !== 2) throw new ElfFormatError(`only big-endian ELF (EI_DATA=2) is supported, got data encoding ${data[5]}`);
  const e_shoff = data.readUInt32BE(0x20), e_shentsize = data.readUInt16BE(0x2E), e_shnum = data.readUInt16BE(0x30), e_shstrndx = data.readUInt16BE(0x32);
  if (e_shoff === 0 || e_shnum === 0) throw new ElfFormatError("ELF file carries no section header table");
  const header = (i) => { const o = e_shoff + i * e_shentsize; return [data.readUInt32BE(o), data.readUInt32BE(o + 4), data.readUInt32BE(o + 16), data.readUInt32BE(o + 20)]; };
  const [, , so, ss] = header(e_shstrndx);
  const shstrtab = data.subarray(so, so + ss);
  const nameAt = (off) => { const end = shstrtab.indexOf(0, off); if (end < 0) throw new ValueErrorLike("subsection not found"); return asciiReplace(shstrtab.subarray(off, end)); };
  for (let i = 0; i < e_shnum; i++) {
    const [nameOff, type, off, size] = header(i);
    if (nameAt(nameOff) !== section) continue;
    if (type === 8) return Buffer.alloc(0);
    return data.subarray(off, off + size);
  }
  return null;
}

class ValueErrorLike extends Error { constructor(m) { super(m); this.name = "ValueError"; } }

/** One ELF section's raw bytes, or null when it is absent. */
export function readSection(p, section = ".text") { return sectionBytes(readFileSync(p), section); }

/** Count real instructions in raw section bytes, trimming trailing padding. */
export function trueInstructionCountFromBytes(raw) {
  const wordCount = Math.floor(raw.length / 4);
  const words = Array.from({ length: wordCount }, (_, i) => raw.readUInt32BE(i * 4));
  let lastReturn = null;
  words.forEach((w, i) => { if (w === JR_RA_WORD) lastReturn = i; });
  if (lastReturn === null || lastReturn + 2 >= wordCount) return wordCount;
  const trailing = words.slice(lastReturn + 2);
  if (trailing.length >= MINIMUM_ELIDED_RUN && trailing.every((w) => w === 0)) return lastReturn + 2;
  return wordCount;
}

/** The real (unpadded) instruction count of `section`, or null when absent/empty. */
export function trueInstructionCount(p, { section = ".text" } = {}) {
  const raw = readSection(p, section);
  if (!raw || !raw.length) return null;
  return trueInstructionCountFromBytes(Buffer.from(raw));
}

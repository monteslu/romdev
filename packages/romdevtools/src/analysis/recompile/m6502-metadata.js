// 6502 cycle and control-flow metadata for the IR exporter.
//
// The cycle table is EXTRACTED from fceumm by
// scripts/generate-6502-cycle-tables.mjs - the core romdev verifies against,
// never hand-authored from a datasheet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLES = JSON.parse(
  readFileSync(path.join(__dirname, "m6502-cycles.json"), "utf8"));

export const M6502_CYCLE_PROVENANCE = TABLES.provenance;

/** Instruction LENGTH by addressing mode, indexed by opcode. */
const LEN = new Uint8Array(256).fill(1);
{
  // Addressing modes drive length, and the 6502's opcode matrix is regular:
  // the low nibble and the bbb field of aaabbbcc select the mode.
  const two = [0x09, 0x05, 0x15, 0x01, 0x11, 0x29, 0x25, 0x35, 0x21, 0x31,
    0x49, 0x45, 0x55, 0x41, 0x51, 0x69, 0x65, 0x75, 0x61, 0x71,
    0xa9, 0xa5, 0xb5, 0xa1, 0xb1, 0xc9, 0xc5, 0xd5, 0xc1, 0xd1,
    0xe9, 0xe5, 0xf5, 0xe1, 0xf1, 0x85, 0x95, 0x81, 0x91,
    0x06, 0x16, 0x26, 0x36, 0x46, 0x56, 0x66, 0x76, 0xc6, 0xd6, 0xe6, 0xf6,
    0xa2, 0xa6, 0xb6, 0x86, 0x96, 0xa0, 0xa4, 0xb4, 0x84, 0x94,
    0xc0, 0xc4, 0xe0, 0xe4, 0x24,
    0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0];
  const three = [0x0d, 0x1d, 0x19, 0x2d, 0x3d, 0x39, 0x4d, 0x5d, 0x59,
    0x6d, 0x7d, 0x79, 0x8d, 0x9d, 0x99, 0xad, 0xbd, 0xb9,
    0xcd, 0xdd, 0xd9, 0xed, 0xfd, 0xf9,
    0x0e, 0x1e, 0x2e, 0x3e, 0x4e, 0x5e, 0x6e, 0x7e,
    0xce, 0xde, 0xee, 0xfe, 0xae, 0xbe, 0x8e, 0xac, 0xbc, 0x8c,
    0x2c, 0x4c, 0x6c, 0x20];
  for (const o of two) LEN[o] = 2;
  for (const o of three) LEN[o] = 3;
}

/** @param {Buffer|Uint8Array} b */
export function m6502Cycles(b) {
  const op = b[0];
  return op === undefined ? null : TABLES.base[op];
}

export function m6502Length(op) { return LEN[op]; }

const BRANCH = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]);

/**
 * @param {Buffer|Uint8Array} b bytes at the instruction
 * @param {number} addr its CPU address
 */
export function m6502Control(b, addr) {
  const op = b[0];
  const u16 = b[1] | (b[2] << 8);
  if (op === 0x4c) return { kind: "jump", target: u16, fallsThrough: false };
  if (op === 0x6c) return { kind: "jump_indirect", fallsThrough: false };
  if (op === 0x20) return { kind: "call", target: u16, fallsThrough: true };
  if (op === 0x60 || op === 0x40)
    return { kind: "return", fallsThrough: false };
  if (op === 0x00) return { kind: "call", target: 0xfffe, fallsThrough: true };
  if (BRANCH.has(op)) {
    const rel = (b[1] << 24) >> 24;            // signed
    return { kind: "branch", target: (addr + 2 + rel) & 0xffff,
             fallsThrough: true };
  }
  return { kind: "none", fallsThrough: true };
}

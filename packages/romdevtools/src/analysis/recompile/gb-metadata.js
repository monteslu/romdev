// LR35902 (Game Boy) cycle and control-flow metadata for the IR exporter.
//
// The cycle tables are EXTRACTED from gambatte, the core romdev verifies
// against, by scripts/generate-gb-cycle-tables.mjs - never hand-authored from
// a datasheet. That is what keeps a later "matches the reference" result from
// being circular.
//
// gambatte has no cycle table to read: it accumulates `cycleCounter += 4` at
// 62 inline sites, four cycles per memory access. The generator therefore
// walks the dispatch switch and resolves each case's macro invocations down
// to those sites. See that script's header for the method and its one
// unmeasurable case (halt).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLES = JSON.parse(
  readFileSync(path.join(__dirname, "gb-cycles.json"), "utf8"));

export const GB_CYCLE_PROVENANCE = TABLES.provenance;

/** Opcodes with no dispatch case: executing one freezes the real CPU. */
export const GB_ILLEGAL = new Set(TABLES.illegal);

/**
 * Cycles for the instruction starting at the front of `b`.
 * Returns null for an illegal opcode so the caller traps rather than
 * charging an invented cost.
 * @param {Buffer|Uint8Array} b
 */
export function gbCycles(b) {
  const op = b[0];
  if (op === undefined) return null;
  if (op === 0xcb) {
    const sub = b[1];
    return sub === undefined ? null : TABLES.cb[sub];
  }
  if (GB_ILLEGAL.has(op)) return null;
  return TABLES.base[op];
}

// Control flow, by opcode. The recompiler needs to know where a block ends
// and whether the next instruction is reachable.
const JP_NN = 0xc3, JP_HL = 0xe9, CALL_NN = 0xcd;
const RET = 0xc9, RETI = 0xd9, JR = 0x18, STOP = 0x10, HALT = 0x76;
const JR_CC = new Set([0x20, 0x28, 0x30, 0x38]);
const JP_CC = new Set([0xc2, 0xca, 0xd2, 0xda]);
const CALL_CC = new Set([0xc4, 0xcc, 0xd4, 0xdc]);
const RET_CC = new Set([0xc0, 0xc8, 0xd0, 0xd8]);
const RST = new Set([0xc7, 0xcf, 0xd7, 0xdf, 0xe7, 0xef, 0xf7, 0xff]);

/**
 * @param {Buffer|Uint8Array} b bytes at the instruction
 * @param {number} addr its CPU address
 * @returns {{kind:string, target?:number, fallsThrough:boolean}}
 */
export function gbControl(b, addr) {
  const op = b[0];
  const u8 = b[1], u16 = b[1] | (b[2] << 8);
  if (op === JP_NN) return { kind: "jump", target: u16, fallsThrough: false };
  if (op === JP_HL) return { kind: "jump_indirect", fallsThrough: false };
  if (op === CALL_NN) return { kind: "call", target: u16, fallsThrough: true };
  if (op === RET || op === RETI)
    return { kind: "return", fallsThrough: false };
  if (op === JR) {
    const rel = (u8 << 24) >> 24;             // signed
    return { kind: "jump", target: (addr + 2 + rel) & 0xffff,
             fallsThrough: false };
  }
  if (JR_CC.has(op)) {
    const rel = (u8 << 24) >> 24;
    return { kind: "branch", target: (addr + 2 + rel) & 0xffff,
             fallsThrough: true };
  }
  if (JP_CC.has(op)) return { kind: "branch", target: u16, fallsThrough: true };
  if (CALL_CC.has(op)) return { kind: "call", target: u16, fallsThrough: true };
  if (RET_CC.has(op)) return { kind: "return", fallsThrough: true };
  if (RST.has(op))
    return { kind: "call", target: op & 0x38, fallsThrough: true };
  // STOP and HALT continue after a wake; they do not end a block for the
  // recompiler's purposes.
  if (op === STOP || op === HALT) return { kind: "none", fallsThrough: true };
  if (GB_ILLEGAL.has(op)) return { kind: "illegal", fallsThrough: false };
  return { kind: "none", fallsThrough: true };
}

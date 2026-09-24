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

/**
 * IR windows for a Game Boy ROM: one per 16KB bank, each at the CPU address
 * the cartridge wiring shows it at. Bank 0 is fixed at $0000; every other
 * bank is only ever executed through the $4000-$7FFF window.
 *
 * This is what makes every record's `addr` a CPU address. The flat chunked
 * walk used before handed the decoder the FILE OFFSET as the start address,
 * which only coincides with the CPU address below $8000: above 64KB a record
 * at file offset $10006 carried addr 65542, and the decoder's PC-relative
 * `jr` target was that bogus address truncated to 16 bits (a 512KB MBC1
 * cart's `jr nz,$4003` exported as `nz,0x0003`, the RST area - 12,827 of its
 * 14,746 `jr` targets were wrong).
 *
 * @param {number} size ROM bytes
 * @param {{allOffsets?:boolean, fileOffset?:number, startAddress?:number, length?:number, bank?:number}} [o]
 */
export function gbWindows(size, { allOffsets = false, fileOffset, startAddress, length = 4096, bank } = {}) {
  const BANK = 0x4000;
  const cpuOf = (b) => (b === 0 ? 0 : BANK);
  if (allOffsets) {
    if (fileOffset != null || bank != null) throw new Error("allOffsets exports the whole ROM; do not also pass fileOffset or bank");
    return Array.from({ length: Math.ceil(size / BANK) }, (_, b) => ({
      off: b * BANK, length: Math.min(BANK, size - b * BANK), bank: b,
      addr: cpuOf(b), slot: b === 0 ? 0 : 1 }));
  }
  let off;
  if (fileOffset != null) off = fileOffset;
  else {
    // A CPU address in the ROM area: $0000-$3FFF is bank 0, $4000-$7FFF is
    // the switched window showing `bank` (default 1).
    const a = startAddress ?? 0;
    if (a >= 0x8000) throw new Error("startAddress is a Game Boy CPU address and must be in ROM ($0000-$7FFF); use fileOffset or allOffsets:true for physical ROM bytes");
    if (a + length > 0x8000) throw new Error("CPU window runs past $7FFF into VRAM; use fileOffset or allOffsets:true");
    const b = a < BANK ? 0 : (bank ?? 1);
    if (a < BANK && a + length > BANK) throw new Error("CPU window crosses from bank 0 into the switched window; split it or use fileOffset");
    off = a < BANK ? a : b * BANK + (a - BANK);
  }
  if (off >= size || off + length > size) throw new Error("window exceeds ROM size");
  const windows = [];
  for (let p = off; p < off + length;) {
    const b = Math.floor(p / BANK), local = p % BANK;
    const n = Math.min(BANK - local, off + length - p);
    windows.push({ off: p, length: n, bank: b, addr: cpuOf(b) + local, slot: b === 0 ? 0 : 1 });
    p += n;
  }
  return windows;
}

/**
 * Rewrite a `jr` operand from its bytes and its TRUE CPU address.
 *
 * `jr` is the LR35902's only PC-relative encoding: `18 dd` / `20|28|30|38 dd`,
 * target = addr + 2 + signed(dd), 16-bit. The decoder computes it from the
 * address it was handed, which for a secondary-alignment record is a batch
 * slot, not the instruction's address (a 32KB cart's $01DA `18 FA` came back as
 * $048C, unreachable by a two-byte jr). Everything else is absolute and
 * passes through untouched. Spelling matches the decoder's (`nz,0x0086`).
 *
 * @param {string} mnemonic lowercased
 * @param {string} ops decoder operand text
 * @param {number[]} bytes instruction bytes
 * @param {number} addr CPU address of the instruction
 */
export function gbFixOps(mnemonic, ops, bytes, addr) {
  if (mnemonic !== "jr" || bytes.length !== 2) return ops;
  const op = bytes[0];
  if (op !== JR && !JR_CC.has(op)) return ops;
  const t = (addr + 2 + ((bytes[1] << 24) >> 24)) & 0xffff;
  const tgt = "0x" + t.toString(16).padStart(4, "0");
  const cc = op === JR ? "" : ["nz", "z", "nc", "c"][(op >> 3) & 3];
  return cc ? `${cc},${tgt}` : tgt;
}

// NES mappers for the WAT backend.
//
// The cart has ONE dispatch arm per PRG byte offset (see index.js), so a
// mapper only has to say how the CPU address space reaches PRG and CHR. Every
// hook below is the ONLY place the emitted WAT differs by mapper; the CPU,
// PPU and frame loop never change. A new mapper is one entry in MAPPERS.
//
// Hooks (all return WAT text or plain values):
//   prgRead(n)        expression: the byte at CPU $8000-$FFFF, given
//                     `(local.get $a)` in $rd8. n = PRG size.
//   pcOffset(n)       expression: the PRG offset of the arm for the RUNTIME
//                     $pc (>= $8000), used by $step's dispatch and cycle fetch.
//   fixedByte(prg)    returns (addr) => byte|null: a ROM operand that cannot
//                     change at run time is folded to a constant; a banked
//                     window returns null and is read through $rd8.
//   armBase(n, off)   the canonical CPU address of PRG offset `off` (only its
//                     low byte and page parity matter: they decide a
//                     branch's static page-cross cost).
//   romWrite          statements run for a CPU write to $8000-$FFFF with
//                     `(local.get $a)` / `(local.get $v)` in scope; bank
//                     registers live here. A CHR bank switch memory.copy's the
//                     selected bank into the 8KB window at ppu.CHR, so the
//                     PPU never changes per mapper.
//   globals           extra (global ...) declarations for bank registers.
//
// Only mapper 0 (NROM) is implemented and verified (8 carts cycle-exact
// against fceumm). What 1/2/3 need, for whoever adds them:
//   2 (UxROM): $8000 window = bank reg, $C000 = last bank. pcOffset picks the
//      bank by pc bit 14; fixedByte folds only $C000-$FFFF; romWrite sets the
//      register (fceumm's bus-conflict rules apply).
//   3 (CNROM): PRG as NROM; romWrite copies the 8KB CHR bank into the window.
//   1 (MMC1):  serial shift register in romWrite; PRG modes as UxROM plus the
//      32KB and fixed-$8000 modes; 4KB CHR copies; mirroring becomes a
//      runtime global, so ntSel reads it.
//
// Plain JS ESM + JSDoc.

import { PRG } from "./ppu.js";

/**
 * @typedef {object} NesMapper
 * @property {number} id
 * @property {string} name
 * @property {(n: number) => string} prgRead
 * @property {(n: number) => string} pcOffset
 * @property {(prg: Uint8Array) => ((addr: number) => (number|null))} fixedByte
 * @property {(n: number, off: number) => number} armBase
 * @property {string} romWrite
 * @property {string} globals
 */

/** @type {Record<number, NesMapper>} */
export const MAPPERS = {
  0: {
    id: 0,
    name: "NROM",
    // A 16KB NROM-128 image appears at both $8000 and $C000; masking by the
    // PRG size folds the mirror.
    prgRead: (n) => `(i32.load8_u (i32.add (i32.const ${PRG})
        (i32.and (local.get $a) (i32.const ${Math.max(1, n) - 1}))))`,
    pcOffset: (n) => `(i32.and (global.get $pc) (i32.const ${n - 1}))`,
    fixedByte: (prg) => (addr) => prg[(addr - 0x8000) % prg.length],
    // Arms use the RUNTIME pc for fall-through/branches/pushes, so the base
    // only matters for static branch page-cross costs (identical in either
    // mirror) and for the arm comments.
    armBase: (n, off) => 0x10000 - n + off,
    romWrite: "",
    globals: "",
  },
};

/**
 * Nametable page select for header (fixed) mirroring: slot (0-3, local $slot)
 * -> CIRAM page 0/1. iNES flags6 bit 0: 0 = HORIZONTAL, 1 = VERTICAL.
 * @param {boolean} vertical
 */
export function ntSelFixed(vertical) {
  return vertical
    ? "(i32.and (local.get $slot) (i32.const 1))"
    : "(i32.shr_u (local.get $slot) (i32.const 1))";
}

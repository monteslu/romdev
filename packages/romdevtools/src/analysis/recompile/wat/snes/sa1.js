// The SA-1 coprocessor of a recompiled SNES cart, ported from snes9x
// (sa1.cpp, sa1cpu.cpp, the SA1_OPCODES build of cpuops.cpp, the SA-1 parts
// of memmap.cpp Map_SA1LoROMMap, ppu.cpp, dma.cpp and getset.h).
//
// A SECOND 65816 RUNNING FROM THE SAME ROM. The SA-1's code is statically
// compiled by the SAME arms as the S-CPU's (every ROM offset is an entry
// point, M/X width decided at run time), with its own register file: the
// cart swaps the SA-1's registers into the CPU globals for as long as it
// runs, and a global ($sacpu) sends the arms' bus accesses to the SA-1's
// memory map and memory speeds instead of the S-CPU's. The few places
// snes9x's SA1_OPCODES build differs from the S-CPU's instructions are
// applied after each SA-1 instruction ($sa1_step): CLI/SEI take effect at
// once, WAI stays on the WAI at TWO_CYCLES a turn, JML abs / JML [abs] cost
// one more cycle. Code outside ROM (I-RAM, BW-RAM) runs in the same
// generated RAM interpreter as the S-CPU's, fetching through the SA-1 map.
//
// CLOCKING exactly as snes9x schedules it: S9xSA1MainLoop runs after every
// S-CPU instruction and runs the SA-1 until SA1.Cycles reaches CPU.Cycles * 3
// (the line end takes H_Max * 3 off SA1.Cycles); a halted SA-1 ($2200 bits
// 5/6) gains 6 per S-CPU instruction instead. Interrupts (SA-1 NMI, timer,
// DMA and S-CPU-raised IRQs) are looked at once per call, before the run.
// The SA-1 timer, H/V counters, arithmetic unit, variable-length bit reader,
// normal DMA, character conversion 1 (the S-CPU DMA to $2118 from banks
// $40-$4F) and 2 (bitmap registers), BW-RAM bitmap views, the MMC bank
// registers and the S-CPU IRQ/NMI vector overrides are snes9x's.
//
// It plugs into coproc.js as a chip module: the board (Map_SA1LoROMMap),
// $chip_b_rd / $chip_b_wr (the S-CPU's $2200-$2FFF), $chip_dma (character
// conversion 1), $chip_line (the line end), $chip_vec (the S-CPU vector
// overrides), $chip_reset (S9xSA1Init) and CPU.IRQExternal ($irqext). The
// SA-1-only hooks (the bus of the swapped-in SA-1 in cpu-wat.js, the main
// loop call in frame-wat.js) are emitted for this board only.
//
// Memory, in the chip block lay.CHIP: FillRAM (snes9x Memory.FillRAM, 32KB:
// the SA-1 registers at $2200-$23FF and the 2KB I-RAM at $3000), the SA-1's
// block map (snes9x SA1.Map, in its own entry types), the character
// conversion buffer and a zero block (snes9x's ROM buffer past the image).
// BW-RAM is the cart's SRAM buffer (snes9x Memory.SRAM, 512KB).
//
// Plain JS ESM + JSDoc.

import { MAPTAB, ROM, WRAM } from "./layout.js";
import { mapMirror, MAP_TYPE } from "./memmap.js";

/** The coprocessor name loader.js reports for these carts, and snes9x's board. */
export const SA1_CHIP = "SA-1";
export const SA1_BOARD = "SA1LoROM";
/** index.js's arms per br_table shard (the SA-1 dispatches into the same shards). */
const SH = 1024;

/** Entry types of the SA-1's own block map (snes9x SA1.Map / SA1.WriteMap). */
export const SA1_TYPE = Object.freeze({
  NONE: 0,     // open bus, ONE_CYCLE (MAP_NONE, MAP_CPU)
  ROM: 1,      // pointer, read-only (a ROM block)
  RAM: 2,      // pointer, read/write (FillRAM: I-RAM)
  REG: 3,      // MAP_PPU: S9xGetSA1 / S9xSetSA1
  SA1RAM: 4,   // banks $40-$4F: SRAM + (addr & $3FFFF)
  BWRAM: 5,    // $6000-$7FFF: SA1.BWRAM (or the bitmap view per $2225 bit 7)
  BITMAP: 6,   // banks $60-$6F: MAP_BWRAM_BITMAP
});

/** Sizes of the SA-1's regions (appended above the rest of the cart's memory). */
const FILL_SZ = 0x8000;
const MAP_SZ = 0x8000;
const CCBUF_SZ = 0x10100;   // snes9x's &Memory.ROM[MAX_ROM_SIZE - 0x10000], plus the last character's overrun
const ZERO_SZ = 0x1000;

/** 64KB pages of the chip block. */
export const SA1_PAGES = Math.ceil((FILL_SZ + MAP_SZ + CCBUF_SZ + ZERO_SZ) / 0x10000);

/**
 * The SA-1's regions in the chip block at `base` (lay.CHIP).
 * @param {number} base
 */
export function sa1Regions(base) {
  const FILL = base;
  const MAP = FILL + FILL_SZ;
  const CCBUF = MAP + MAP_SZ;
  const ZERO = CCBUF + CCBUF_SZ;
  return { FILL, MAP, CCBUF, ZERO };
}

/**
 * Both block maps of snes9x's Map_SA1LoROMMap as the cart holds them: the
 * S-CPU's (the cart's MAPTAB format, u32 type + u32 base per 4KB block) and
 * the SA-1's (SA1_TYPE entries, same format).
 * @param {{romSize: number, SRAM: number, FILL: number}} o
 * @returns {{scpu: Uint8Array, sa1: Uint8Array}}
 */
export function sa1MemMaps({ romSize, SRAM, FILL }) {
  const scpu = new Uint8Array(4096 * 8), sa1 = new Uint8Array(4096 * 8);
  const ds = new DataView(scpu.buffer), da = new DataView(sa1.buffer);
  const setS = (p, t, b = 0) => { ds.setUint32(p * 8, t, true); ds.setUint32(p * 8 + 4, b >>> 0, true); };
  const setA = (p, t, b = 0) => { da.setUint32(p * 8, t, true); da.setUint32(p * 8 + 4, b >>> 0, true); };
  const each = (b0, b1, a0, a1, f) => {
    for (let c = b0; c <= b1; c++) for (let i = a0; i <= a1; i += 0x1000) f(c, i, (c << 4) | (i >> 12));
  };
  // map_System
  for (const [b0, b1] of [[0x00, 0x3f], [0x80, 0xbf]]) {
    each(b0, b1, 0x0000, 0x1fff, (c, i, p) => setS(p, MAP_TYPE.RAM, WRAM + i));
    each(b0, b1, 0x2000, 0x3fff, (c, i, p) => setS(p, MAP_TYPE.PPU));
    each(b0, b1, 0x4000, 0x5fff, (c, i, p) => setS(p, MAP_TYPE.CPU));
  }
  // map_lorom($00-$3F / $80-$BF, $8000-$FFFF), map_hirom_offset($C0-$FF, 0)
  each(0x00, 0x3f, 0x8000, 0xffff, (c, i, p) => setS(p, MAP_TYPE.ROM, ROM + mapMirror(romSize, (c & 0x7f) * 0x8000) - 0x8000 + i));
  each(0x80, 0xbf, 0x8000, 0xffff, (c, i, p) => setS(p, MAP_TYPE.ROM, ROM + mapMirror(romSize, (c & 0x7f) * 0x8000) - 0x8000 + i));
  each(0xc0, 0xff, 0x0000, 0xffff, (c, i, p) => setS(p, MAP_TYPE.ROM, ROM + mapMirror(romSize, (c - 0xc0) << 16) + i));
  // map_space($3000-$37FF, FillRAM): the whole $3000 block points into FillRAM
  for (const [b0, b1] of [[0x00, 0x3f], [0x80, 0xbf]]) {
    each(b0, b1, 0x3000, 0x3fff, (c, i, p) => setS(p, MAP_TYPE.RAM, FILL + i));
    // MAP_BWRAM: Memory.BWRAM + (addr & $7FFF) - $6000, BWRAM = SRAM until $2224 moves it
    each(b0, b1, 0x6000, 0x7fff, (c, i, p) => setS(p, MAP_TYPE.RAM, SRAM + i - 0x6000));
  }
  // map_space(c, c, 0, $FFFF, SRAM + (c & 3) * $10000) for c in $40-$4E ($4F stays unmapped)
  for (let c = 0x40; c < 0x4f; c++) each(c, c, 0x0000, 0xffff, (cc, i, p) => setS(p, MAP_TYPE.RAM, SRAM + (c & 3) * 0x10000 + i));
  // map_WRAM
  each(0x7e, 0x7f, 0x0000, 0xffff, (c, i, p) => setS(p, MAP_TYPE.RAM, WRAM + ((c - 0x7e) << 16) + i));

  // SA1.Map = a copy of Map, corrected for the SA-1.
  for (let p = 0; p < 4096; p++) {
    const t = ds.getUint32(p * 8, true), b = ds.getUint32(p * 8 + 4, true);
    const bank = p >> 4, blk = p & 15;
    const low = (bank & 0x7f) <= 0x3f && bank < 0xc0;
    let at = SA1_TYPE.NONE, ab = 0;
    if (t === MAP_TYPE.ROM) { at = SA1_TYPE.ROM; ab = b; }
    else if (t === MAP_TYPE.PPU) at = SA1_TYPE.REG;
    else if (t === MAP_TYPE.RAM && low && blk === 3) { at = SA1_TYPE.RAM; ab = b; }
    else if (t === MAP_TYPE.RAM && low && (blk === 6 || blk === 7)) at = SA1_TYPE.BWRAM;
    else if (t === MAP_TYPE.RAM && bank >= 0x7e && bank <= 0x7f) at = SA1_TYPE.NONE;
    else if (t === MAP_TYPE.RAM) { at = SA1_TYPE.RAM; ab = b; }
    setA(p, at, ab);
  }
  for (let c = 0; c < 0x400; c += 0x10) {
    for (const off of [0, 0x800]) {
      setA(c + off, SA1_TYPE.RAM, FILL + 0x3000);   // SA-1 $0000-$0FFF: FillRAM + $3000 (I-RAM)
      setA(c + off + 1, SA1_TYPE.NONE);
    }
  }
  for (let p = 0x400; p < 0x500; p++) setA(p, SA1_TYPE.SA1RAM);
  for (let p = 0x600; p < 0x700; p++) setA(p, SA1_TYPE.BITMAP);
  for (let p = 0x7e0; p < 0x800; p++) setA(p, SA1_TYPE.NONE);
  return { scpu, sa1 };
}

const F = (x) => `(i32.load8_u (i32.add (global.get $sa1_fill) ${typeof x === "number" ? `(i32.const ${x})` : x}))`;
const SETF = (x, v) => `(i32.store8 (i32.add (global.get $sa1_fill) ${typeof x === "number" ? `(i32.const ${x})` : x}) ${v})`;
const ORF = (x, bits) => SETF(x, `(i32.or ${F(x)} (i32.const ${bits}))`);
const ANDF = (x, bits) => SETF(x, `(i32.and ${F(x)} (i32.const ${bits}))`);

/** The S-CPU registers swapped with the SA-1's (the rest of the CPU state is the S-CPU's alone). */
const REGS = ["a", "x", "y", "s", "d", "db", "pc", "fn", "fv", "fm", "fx", "fd", "fi", "fz", "fc", "fe", "ms", "ob"];
/** S-CPU state the SA-1's instructions may touch and the S-CPU must get back. */
const SCPU_ONLY = ["db24", "cyc", "wai", "stp", "ichg"];

/**
 * The SA-1-only hooks in the S-CPU's code, emitted for the SA-1 board only
 * (every other cart's module is unchanged): the arms' bus while the SA-1 is
 * swapped in, and S9xSA1MainLoop after each S-CPU instruction.
 */
export const SA1_HOOKS = Object.freeze({
  /** $rd8: an SA-1 access goes to the SA-1's bus. */
  rd8: "(if (global.get $sacpu) (then (return (call $sa1_rd8 (local.get $a)))))",
  /** $wr8 */
  wr8: "(if (global.get $sacpu) (then (call $sa1_wr8 (local.get $a) (local.get $v)) (return)))",
  /** $rd8m (the interpreter's program fetch): the SA-1's code view (PCBase). */
  rd8m: "(if (global.get $sacpu) (then (return (call $sa1_fetch (local.get $a)))))",
  /** $fast2: S9xSA1GetWord / S9xSA1SetWord have no word fast path. */
  fast2: "(if (global.get $sacpu) (then (return (i32.const 0))))",
  /** $run_frame after each S-CPU instruction: the events it reached, then S9xSA1MainLoop. */
  afterStep: "(if (i32.and (i32.le_s (global.get $cyc) (i32.const 0)) (i32.eqz (global.get $stp))) (then (call $ev_process (call $evpos (call $hnow))) (call $ev_due))) (call $sa1_main)",
});

/** @param {import("./layout.js").SnesLayout & {CHIP: number}} lay */
function sa1GlobalsWat(lay) {
  const r = sa1Regions(lay.CHIP);
  const g = (n, v = 0, t = "i32") => `  (global $${n} (mut ${t}) (${t}.const ${v}))`;
  return [
    ";; ---- SA-1 (sa1.js) ----",
    g("sacpu"),
    `  (global $sa1_fill i32 (i32.const ${r.FILL}))`,
    `  (global $sa1_ccbuf i32 (i32.const ${r.CCBUF}))`,
    g("sa1_cyc"), g("sa1_prevcyc"), g("sa1_hc"), g("sa1_vc"), g("sa1_prevhc"),
    g("sa1_htpos"), g("sa1_vtpos"), g("sa1_tlast"), g("sa1_wait"), g("sa1_ccstep"),
    g("sa1_aop"), g("sa1_op1"), g("sa1_op2"), g("sa1_sum", 0, "i64"), g("sa1_ovf"),
    g("sa1_vbf", 4), g("sa1_vbp"), g("sa1_inchar"), g("sa1_bwram", lay.SRAM), g("sa1_bwbm"),
    ...REGS.map((n) => g(`sa1_${n}`)),
    ...[...REGS, ...SCPU_ONLY].map((n) => g(`sv_${n}`)),
  ].join("\n");
}

/**
 * The SA-1's WAT: bus, registers, units, scheduler, and the coproc.js hooks.
 * @param {import("./layout.js").SnesLayout & {CHIP: number, romlen: number, narms: number}} lay
 */
function sa1FuncsWat(lay) {
  const r = sa1Regions(lay.CHIP);
  const SRAM = lay.SRAM, MAP = r.MAP, ZERO = r.ZERO, FILL = r.FILL, CCBUF = r.CCBUF;
  const romEnd = ROM + lay.romlen;
  const mask = lay.sram;
  const swapIn = [
    ...REGS.map((n) => `(global.set $sv_${n} (global.get $${n})) (global.set $${n} (global.get $sa1_${n}))`),
    ...SCPU_ONLY.map((n) => `(global.set $sv_${n} (global.get $${n}))`),
    "(global.set $db24 (i32.shl (global.get $db) (i32.const 16)))",
    "(global.set $cyc (i32.sub (local.get $target) (global.get $sa1_cyc)))",
    "(global.set $wai (i32.const 0)) (global.set $stp (i32.const 0)) (global.set $ichg (i32.const 0))",
    "(global.set $sacpu (i32.const 1))",
  ].join("\n    ");
  const swapOut = [
    "(global.set $sa1_cyc (i32.sub (local.get $target) (global.get $cyc)))",
    ...REGS.map((n) => `(global.set $sa1_${n} (global.get $${n})) (global.set $${n} (global.get $sv_${n}))`),
    ...SCPU_ONLY.map((n) => `(global.set $${n} (global.get $sv_${n}))`),
    "(global.set $sacpu (i32.const 0))",
  ].join("\n    ");
  // snes9x SA-1 main loop wake-up: PC moves past the WAI
  const wake = "(if (global.get $sa1_wait) (then (global.set $sa1_wait (i32.const 0)) (global.set $pc (i32.or (i32.and (global.get $pc) (i32.const 0xFF0000)) (i32.and (i32.add (global.get $pc) (i32.const 1)) (i32.const 0xFFFF))))))";
  const bmRead = (base, idx) => `(if (result i32) (i32.eq (global.get $sa1_vbf) (i32.const 2))
        (then (i32.and (i32.shr_u (i32.load8_u (i32.add ${base} (i32.and (i32.shr_u ${idx} (i32.const 2)) (i32.const 0x3FFFF))))
                                  (i32.shl (i32.and ${idx} (i32.const 3)) (i32.const 1))) (i32.const 3)))
        (else (i32.and (i32.shr_u (i32.load8_u (i32.add ${base} (i32.and (i32.shr_u ${idx} (i32.const 1)) (i32.const 0x3FFFF))))
                                  (i32.shl (i32.and ${idx} (i32.const 1)) (i32.const 2))) (i32.const 15))))`;
  const bmWrite = (base, idx) => `(if (i32.eq (global.get $sa1_vbf) (i32.const 2))
        (then (local.set $p (i32.add ${base} (i32.and (i32.shr_u ${idx} (i32.const 2)) (i32.const 0x3FFFF))))
              (local.set $sh (i32.shl (i32.and ${idx} (i32.const 3)) (i32.const 1)))
              (i32.store8 (local.get $p) (i32.or (i32.and (i32.load8_u (local.get $p)) (i32.xor (i32.shl (i32.const 3) (local.get $sh)) (i32.const -1)))
                                                 (i32.shl (i32.and (local.get $v) (i32.const 3)) (local.get $sh)))))
        (else (local.set $p (i32.add ${base} (i32.and (i32.shr_u ${idx} (i32.const 1)) (i32.const 0x3FFFF))))
              (local.set $sh (i32.shl (i32.and ${idx} (i32.const 1)) (i32.const 2)))
              (i32.store8 (local.get $p) (i32.or (i32.and (i32.load8_u (local.get $p)) (i32.xor (i32.shl (i32.const 15) (local.get $sh)) (i32.const -1)))
                                                 (i32.shl (i32.and (local.get $v) (i32.const 15)) (local.get $sh))))))`;
  // character conversion bit shuffles (dma.cpp / S9xSA1CharConv2): p[k] = p[k] << 1 | (r >> bit) & 1
  const sh = (pExpr, k, bit) => `(i32.store8 offset=${k} ${pExpr} (i32.or (i32.shl (i32.load8_u offset=${k} ${pExpr}) (i32.const 1)) (i32.and (i32.shr_u (local.get $r) (i32.const ${bit})) (i32.const 1))))`;
  const P = "(local.get $p)";
  const cc1Inner = {
    2: [sh(P, 0, 0), sh(P, 1, 1), sh(P, 0, 2), sh(P, 1, 3), sh(P, 0, 4), sh(P, 1, 5), sh(P, 0, 6), sh(P, 1, 7)],
    4: [sh(P, 0, 0), sh(P, 1, 1), sh(P, 16, 2), sh(P, 17, 3), sh(P, 0, 4), sh(P, 1, 5), sh(P, 16, 6), sh(P, 17, 7)],
    8: [sh(P, 0, 0), sh(P, 1, 1), sh(P, 16, 2), sh(P, 17, 3), sh(P, 32, 4), sh(P, 33, 5), sh(P, 48, 6), sh(P, 49, 7)],
  };
  const cc2Inner = {
    2: [sh(P, 0, 0), sh(P, 1, 1)],
    4: [sh(P, 0, 0), sh(P, 1, 1), sh(P, 16, 2), sh(P, 17, 3)],
    8: [sh(P, 0, 0), sh(P, 1, 1), sh(P, 16, 2), sh(P, 17, 3), sh(P, 32, 4), sh(P, 33, 5), sh(P, 48, 6), sh(P, 49, 7)],
  };
  const cc1Depth = (d) => `
          ;; depth ${d}
          (local.set $i (i32.const 0))
          (block $od (loop $ol
            (br_if $od (i32.ge_s (local.get $i) (local.get $cnt)))
            (local.set $line (i32.add (local.get $base) (i32.mul (i32.sub (local.get $nch) (local.get $cc)) (i32.const ${d}))))
            (local.set $j (i32.const 0))
            (block $jd (loop $jl
              (br_if $jd (i32.ge_u (local.get $j) (local.get $cc)))
              (br_if $jd (i32.ge_s (i32.sub (local.get $p) (global.get $sa1_ccbuf)) (local.get $cnt)))
              (local.set $q (local.get $line))
              (local.set $l (i32.const 0))
              (block $ld (loop $ll
                (br_if $ld (i32.ge_u (local.get $l) (i32.const 8)))
                (local.set $b (i32.const 0))
                (block $bd (loop $bl
                  (br_if $bd (i32.ge_u (local.get $b) (i32.const ${d})))
                  (local.set $r (i32.load8_u (i32.add (local.get $q) (local.get $b))))
                  ${cc1Inner[d].join("\n                  ")}
                  (local.set $b (i32.add (local.get $b) (i32.const 1)))
                  (br $bl)))
                (local.set $p (i32.add (local.get $p) (i32.const 2)))
                (local.set $q (i32.add (local.get $q) (local.get $bpl)))
                (local.set $l (i32.add (local.get $l) (i32.const 1)))
                (br $ll)))
              ${d === 4 ? "(local.set $p (i32.add (local.get $p) (i32.const 16)))" : d === 8 ? "(local.set $p (i32.add (local.get $p) (i32.const 48)))" : ""}
              (local.set $line (i32.add (local.get $line) (i32.const ${d})))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br $jl)))
            (local.set $i (i32.add (local.get $i) (local.get $inc)))
            (local.set $base (i32.add (local.get $base) (local.get $clb)))
            (local.set $inc (local.get $clb))
            (local.set $cc (local.get $nch))
            (br $ol)))`;
  const cc2Depth = (d) => `
      ;; depth ${d}
      (local.set $l (i32.const 0))
      (block $ld (loop $ll
        (br_if $ld (i32.ge_u (local.get $l) (i32.const 8)))
        (local.set $b (i32.const 0))
        (block $bd (loop $bl
          (br_if $bd (i32.ge_u (local.get $b) (i32.const 8)))
          (local.set $r (i32.load8_u (i32.add (local.get $q) (local.get $b))))
          ${cc2Inner[d].join("\n          ")}
          (local.set $b (i32.add (local.get $b) (i32.const 1)))
          (br $bl)))
        (local.set $p (i32.add (local.get $p) (i32.const 2)))
        (local.set $q (i32.add (local.get $q) (i32.const 8)))
        (local.set $l (i32.add (local.get $l) (i32.const 1)))
        (br $ll)))`;

  return `
  ;; ======== SA-1 (sa1.js, from snes9x sa1.cpp / sa1cpu.cpp) ========

  ;; SA1.Cycles charge: the swapped-in SA-1 counts down $cyc, otherwise (the
  ;; variable-length reader run by an S-CPU register access) SA1.Cycles.
  (func $sa1_cost (param $n i32)
    (if (global.get $sacpu)
      (then (global.set $cyc (i32.sub (global.get $cyc) (local.get $n))))
      (else (global.set $sa1_cyc (i32.add (global.get $sa1_cyc) (local.get $n))))))
  (func $sa1_curms (result i32)
    (if (result i32) (global.get $sacpu) (then (global.get $ms)) (else (global.get $sa1_ms))))

  ;; S9xSA1SetPCBase's MemSpeed: TWO_CYCLES in banks $40-$7F/$C0-$FF's
  ;; $40-$7F half and at $6000-$7FFF of the low banks, ONE_CYCLE elsewhere.
  (func $sa1_speed (param $a i32) (result i32)
    (if (result i32) (i32.or (i32.eq (i32.and (local.get $a) (i32.const 0xC00000)) (i32.const 0x400000))
                             (i32.eq (i32.and (local.get $a) (i32.const 0x40E000)) (i32.const 0x6000)))
      (then (i32.const 12)) (else (i32.const 6))))

  ;; S9xSA1GetByte
  (func $sa1_rd8 (param $a i32) (result i32)
    (local $e i32) (local $v i32) (local $b i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $e (i32.add (i32.const ${MAP}) (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 3))))
    (block $done
      (block $bm (block $bw (block $sr (block $reg (block $ptr (block $none
        (br_table $none $ptr $ptr $reg $sr $bw $bm $none (i32.load (local.get $e))))
        ;; MAP_NONE / MAP_CPU: open bus
        (call $sa1_cost (i32.const 6))
        (local.set $v (if (result i32) (global.get $sacpu) (then (global.get $ob)) (else (global.get $sa1_ob))))
        (br $done))
        ;; a pointer block: SA1.MemSpeed
        (call $sa1_cost (call $sa1_curms))
        (local.set $v (i32.load8_u (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $a) (i32.const 0xFFF)))))
        (br $done))
        (call $sa1_cost (i32.const 6))
        (local.set $v (call $sa1_reg_rd (i32.and (local.get $a) (i32.const 0xFFFF))))
        (br $done))
        (call $sa1_cost (i32.const 12))
        (local.set $v (i32.load8_u (i32.add (i32.const ${SRAM}) (i32.and (local.get $a) (i32.const 0x3FFFF)))))
        (br $done))
      (call $sa1_cost (i32.const 12))
      (if (global.get $sa1_bwbm)
        (then (local.set $b (i32.sub (i32.and (local.get $a) (i32.const 0xFFFF)) (i32.const 0x6000)))
              (local.set $v ${bmRead("(global.get $sa1_bwram)", "(local.get $b)")}))
        (else (local.set $v (i32.load8_u (i32.add (global.get $sa1_bwram) (i32.and (local.get $a) (i32.const 0x1FFF)))))))
      (br $done))
      (call $sa1_cost (i32.const 12))
      (local.set $b (i32.sub (local.get $a) (i32.const 0x600000)))
      (local.set $v ${bmRead(`(i32.const ${SRAM})`, "(local.get $b)")}))
    (if (global.get $sacpu) (then (global.set $ob (local.get $v))))
    (local.get $v))

  ;; S9xSA1SetByte (no cycles: snes9x charges the SA-1's writes nothing)
  (func $sa1_wr8 (param $a i32) (param $v i32)
    (local $e i32) (local $b i32) (local $p i32) (local $sh i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (global.set $ob (local.get $v))
    (local.set $e (i32.add (i32.const ${MAP}) (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 3))))
    (block $bm (block $bw (block $sr (block $reg (block $ram (block $none
      (br_table $none $none $ram $reg $sr $bw $bm $none (i32.load (local.get $e))))
      (return))
      (i32.store8 (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $a) (i32.const 0xFFF))) (local.get $v))
      (return))
      (call $sa1_reg_wr (i32.and (local.get $a) (i32.const 0xFFFF)) (local.get $v))
      (return))
      (i32.store8 (i32.add (i32.const ${SRAM}) (i32.and (local.get $a) (i32.const 0x3FFFF))) (local.get $v))
      (return))
      (if (global.get $sa1_bwbm)
        (then (local.set $b (i32.sub (i32.and (local.get $a) (i32.const 0xFFFF)) (i32.const 0x6000)))
              ${bmWrite("(global.get $sa1_bwram)", "(local.get $b)")})
        (else (i32.store8 (i32.add (global.get $sa1_bwram) (i32.and (local.get $a) (i32.const 0x1FFF))) (local.get $v))))
      (return))
    (local.set $b (i32.sub (local.get $a) (i32.const 0x600000)))
    ${bmWrite(`(i32.const ${SRAM})`, "(local.get $b)")})

  ;; The SA-1's program fetch (SA1.PCBase): pointer blocks, BW-RAM at
  ;; SA1.BWRAM, banks $40-$4F at Memory.SRAM + (addr & $FFFF); anything else
  ;; is snes9x's slow path, read without side effects here.
  (func $sa1_fetch (param $a i32) (result i32)
    (local $e i32) (local $t i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $e (i32.add (i32.const ${MAP}) (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 3))))
    (local.set $t (i32.load (local.get $e)))
    (if (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 2)))
      (then (return (i32.load8_u (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $a) (i32.const 0xFFF)))))))
    (if (i32.eq (local.get $t) (i32.const 4))
      (then (return (i32.load8_u (i32.add (i32.const ${SRAM}) (i32.and (local.get $a) (i32.const 0xFFFF)))))))
    (if (i32.and (i32.eq (local.get $t) (i32.const 5)) (i32.eqz (global.get $sa1_bwbm)))
      (then (return (i32.load8_u (i32.add (global.get $sa1_bwram) (i32.and (local.get $a) (i32.const 0x1FFF)))))))
    (if (i32.eq (local.get $t) (i32.const 3))
      (then (return ${F("(i32.and (local.get $a) (i32.const 0x7FFF))")})))
    (global.get $ob))

  ;; S9xGetSA1 (either CPU)
  (func $sa1_reg_rd (param $x i32) (result i32)
    (local $v i32)
    (if (i32.eq (local.get $x) (i32.const 0x2300))
      (then (return (i32.or (i32.and ${F(0x2209)} (i32.const 0x5F)) (i32.and ${F(0x2300)} (i32.const 0xA0))))))
    (if (i32.eq (local.get $x) (i32.const 0x2301))
      (then (return (i32.or (i32.and ${F(0x2200)} (i32.const 0x0F)) (i32.and ${F(0x2301)} (i32.const 0xF0))))))
    (if (i32.eq (local.get $x) (i32.const 0x2302))
      (then (global.set $sa1_htpos (i32.and (i32.div_s (global.get $sa1_hc) (i32.const 4)) (i32.const 0xFFFF)))
            (global.set $sa1_vtpos (i32.and (global.get $sa1_vc) (i32.const 0xFFFF)))
            (return (i32.and (global.get $sa1_htpos) (i32.const 0xFF)))))
    (if (i32.eq (local.get $x) (i32.const 0x2303)) (then (return (i32.shr_u (global.get $sa1_htpos) (i32.const 8)))))
    (if (i32.eq (local.get $x) (i32.const 0x2304)) (then (return (i32.and (global.get $sa1_vtpos) (i32.const 0xFF)))))
    (if (i32.eq (local.get $x) (i32.const 0x2305)) (then (return (i32.shr_u (global.get $sa1_vtpos) (i32.const 8)))))
    (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2306)) (i32.le_u (local.get $x) (i32.const 0x230A)))
      (then (return (i32.wrap_i64 (i64.and (i64.shr_u (global.get $sa1_sum)
              (i64.extend_i32_u (i32.shl (i32.sub (local.get $x) (i32.const 0x2306)) (i32.const 3)))) (i64.const 0xFF))))))
    (if (i32.eq (local.get $x) (i32.const 0x230B))
      (then (return (if (result i32) (global.get $sa1_ovf) (then (i32.const 0x80)) (else (i32.const 0))))))
    (if (i32.eq (local.get $x) (i32.const 0x230D))
      (then (local.set $v ${F(0x230d)})
            (if (i32.and ${F(0x2258)} (i32.const 0x80)) (then (call $sa1_varlen (i32.const 1) (i32.const 0))))
            (return (local.get $v))))
    (if (i32.eq (local.get $x) (i32.const 0x230E)) (then (return (i32.const 0x23))))
    ${F("(local.get $x)")})

  ;; An S-CPU write to $2200-$2FFF (ppu.cpp: S9xSetSA1 up to $23FF, FillRAM above)
  (func $sa1_sreg_wr (param $x i32) (param $v i32)
    (if (i32.le_u (local.get $x) (i32.const 0x23FF))
      (then (call $sa1_reg_wr (local.get $x) (local.get $v)))
      (else ${SETF("(local.get $x)", "(local.get $v)")})))

  ;; the SA-1's PC, wherever it lives right now
  (func $sa1_setpc (param $v i32)
    (if (global.get $sacpu) (then (global.set $pc (local.get $v))) (else (global.set $sa1_pc (local.get $v)))))

  ;; S9xSA1SetBWRAMMemMap
  (func $sa1_bwmap (param $v i32)
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then (global.set $sa1_bwbm (i32.const 1))
            (global.set $sa1_bwram (i32.add (i32.const ${SRAM}) (i32.shl (i32.and (local.get $v) (i32.const 0x7F)) (i32.const 11)))))
      (else (global.set $sa1_bwbm (i32.const 0))
            (global.set $sa1_bwram (i32.add (i32.const ${SRAM}) (i32.shl (i32.and (local.get $v) (i32.const 0x1F)) (i32.const 13)))))))

  ;; One 4KB block of both maps pointed at ROM offset $off (S9xSetSA1MemMap):
  ;; past the image, snes9x's zero-filled ROM buffer.
  (func $sa1_setblk (param $p i32) (param $off i32)
    (local $es i32) (local $ea i32)
    (local.set $es (i32.add (i32.const ${MAPTAB}) (i32.shl (local.get $p) (i32.const 3))))
    (local.set $ea (i32.add (i32.const ${MAP}) (i32.shl (local.get $p) (i32.const 3))))
    (i32.store (local.get $ea) (i32.const 1))
    (if (i32.lt_u (local.get $off) (i32.const ${lay.romlen}))
      (then (i32.store (local.get $es) (i32.const 1))
            (i32.store offset=4 (local.get $es) (i32.add (i32.const ${ROM}) (local.get $off)))
            (i32.store offset=4 (local.get $ea) (i32.add (i32.const ${ROM}) (local.get $off))))
      (else (i32.store (local.get $es) (i32.const 2))
            (i32.store offset=4 (local.get $es) (i32.const ${ZERO}))
            (i32.store offset=4 (local.get $ea) (i32.const ${ZERO})))))

  ;; S9xSetSA1MemMap: MMC bank C/D/E/F ($2220-$2223)
  (func $sa1_mmc (param $which i32) (param $map i32)
    (local $k i32) (local $j i32) (local $start i32) (local $start2 i32) (local $sel i32)
    (local.set $start (i32.add (i32.shl (local.get $which) (i32.const 8)) (i32.const 0xC00)))
    (local.set $start2 (i32.shl (local.get $which) (i32.const 9)))
    (if (i32.ge_u (local.get $which) (i32.const 2)) (then (local.set $start2 (i32.add (local.get $start2) (i32.const 0x400)))))
    (local.set $k (i32.const 0))
    (block $kd (loop $kl
      (br_if $kd (i32.ge_u (local.get $k) (i32.const 16)))
      (local.set $j (i32.const 0))
      (block $jd (loop $jl
        (br_if $jd (i32.ge_u (local.get $j) (i32.const 16)))
        (call $sa1_setblk (i32.add (local.get $start) (i32.add (i32.shl (local.get $k) (i32.const 4)) (local.get $j)))
          (i32.add (i32.shl (i32.and (local.get $map) (i32.const 7)) (i32.const 20))
                   (i32.add (i32.shl (local.get $k) (i32.const 16)) (i32.shl (local.get $j) (i32.const 12)))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $jl)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $kl)))
    (local.set $sel (i32.and (if (result i32) (i32.and (local.get $map) (i32.const 0x80)) (then (local.get $map)) (else (local.get $which))) (i32.const 7)))
    (local.set $k (i32.const 0))
    (block $kd2 (loop $kl2
      (br_if $kd2 (i32.ge_u (local.get $k) (i32.const 32)))
      (local.set $j (i32.const 8))
      (block $jd2 (loop $jl2
        (br_if $jd2 (i32.ge_u (local.get $j) (i32.const 16)))
        (call $sa1_setblk (i32.add (local.get $start2) (i32.add (i32.shl (local.get $k) (i32.const 4)) (local.get $j)))
          (i32.add (i32.shl (local.get $sel) (i32.const 20))
                   (i32.add (i32.shl (local.get $k) (i32.const 15)) (i32.shl (i32.sub (local.get $j) (i32.const 8)) (i32.const 12)))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $jl2)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $kl2))))

  ;; $2224: Memory.BWRAM for the S-CPU's $6000-$7FFF (both 4KB blocks of
  ;; every bank $00-$3F / $80-$BF)
  (func $sa1_scpu_bwram (param $v i32)
    (local $c i32) (local $e i32) (local $base i32)
    (local.set $base (i32.add (i32.const ${SRAM}) (i32.shl (i32.and (local.get $v) (i32.const 0x1F)) (i32.const 13))))
    (local.set $c (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $c) (i32.const 0x80)))
      (local.set $e (i32.add (i32.const ${MAPTAB}) (i32.shl (i32.add (i32.shl (i32.add (local.get $c) (i32.shl (i32.shr_u (local.get $c) (i32.const 6)) (i32.const 6))) (i32.const 4)) (i32.const 6)) (i32.const 3))))
      (i32.store offset=4 (local.get $e) (local.get $base))
      (i32.store offset=12 (local.get $e) (i32.add (local.get $base) (i32.const 0x1000)))
      (local.set $c (i32.add (local.get $c) (i32.const 1)))
      (br $l))))

  ;; S9xSetSA1 (either CPU)
  (func $sa1_reg_wr (param $x i32) (param $v i32)
    (local $t i32) (local $d i32)
    (block $store
      (if (i32.eq (local.get $x) (i32.const 0x2200))
        (then
          ;; SA-1 reset: leaving reset (bit 5 was set) with bit 7 clear
          (if (i32.and (i32.eqz (i32.and (local.get $v) (i32.const 0x80))) (i32.ne (i32.and ${F(0x2200)} (i32.const 0x20)) (i32.const 0)))
            (then (call $sa1_setpc (i32.or ${F(0x2203)} (i32.shl ${F(0x2204)} (i32.const 8))))))
          (if (i32.and (local.get $v) (i32.const 0x80))
            (then ${ORF(0x2301, 0x80)}
                  (if (i32.and ${F(0x220a)} (i32.const 0x80)) (then ${ANDF(0x220b, 0x7f)}))))
          (if (i32.and (local.get $v) (i32.const 0x10))
            (then ${ORF(0x2301, 0x10)}
                  (if (i32.and ${F(0x220a)} (i32.const 0x10)) (then ${ANDF(0x220b, 0xef)}))))
          (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2201))
        (then
          (if (i32.and (i32.ne (i32.and (i32.xor (local.get $v) ${F(0x2201)}) (i32.const 0x80)) (i32.const 0))
                       (i32.ne (i32.and (i32.and ${F(0x2300)} (local.get $v)) (i32.const 0x80)) (i32.const 0)))
            (then ${ANDF(0x2202, 0x7f)} (global.set $irqext (i32.const 1))))
          (if (i32.and (i32.ne (i32.and (i32.xor (local.get $v) ${F(0x2201)}) (i32.const 0x20)) (i32.const 0))
                       (i32.ne (i32.and (i32.and ${F(0x2300)} (local.get $v)) (i32.const 0x20)) (i32.const 0)))
            (then ${ANDF(0x2202, 0xdf)} (global.set $irqext (i32.const 1))))
          (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2202))
        (then
          (if (i32.and (local.get $v) (i32.const 0x80)) (then ${ANDF(0x2300, 0x7f)}))
          (if (i32.and (local.get $v) (i32.const 0x20)) (then ${ANDF(0x2300, 0xdf)}))
          (if (i32.eqz (i32.and ${F(0x2300)} (i32.const 0xA0))) (then (global.set $irqext (i32.const 0))))
          (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2209))
        (then
          (if (i32.and (local.get $v) (i32.const 0x80))
            (then ${ORF(0x2300, 0x80)}
                  (if (i32.and ${F(0x2201)} (i32.const 0x80))
                    (then ${ANDF(0x2202, 0x7f)} (global.set $irqext (i32.const 1))))))
          (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x220A))
        (then
          ${[0x80, 0x40, 0x20, 0x10].map((b) => `(if (i32.and (i32.ne (i32.and (i32.xor (local.get $v) ${F(0x220a)}) (i32.const ${b})) (i32.const 0))
                       (i32.ne (i32.and (i32.and ${F(0x2301)} (local.get $v)) (i32.const ${b})) (i32.const 0)))
            (then ${ANDF(0x220b, 0xff ^ b)}))`).join("\n          ")}
          (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x220B))
        (then
          ${[0x80, 0x40, 0x20, 0x10].map((b) => `(if (i32.and (local.get $v) (i32.const ${b})) (then ${ANDF(0x2301, 0xff ^ b)}))`).join("\n          ")}
          (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2211))
        (then (global.set $sa1_hc (i32.const 0)) (global.set $sa1_vc (i32.const 0)) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2212))
        (then (global.set $sa1_htpos (i32.or (local.get $v) (i32.shl ${F(0x2213)} (i32.const 8)))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2213))
        (then (global.set $sa1_htpos (i32.or (i32.shl (local.get $v) (i32.const 8)) ${F(0x2212)})) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2214))
        (then (global.set $sa1_vtpos (i32.or (local.get $v) (i32.shl ${F(0x2215)} (i32.const 8)))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2215))
        (then (global.set $sa1_vtpos (i32.or (i32.shl (local.get $v) (i32.const 8)) ${F(0x2214)})) (br $store)))
      (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2220)) (i32.le_u (local.get $x) (i32.const 0x2223)))
        (then (call $sa1_mmc (i32.sub (local.get $x) (i32.const 0x2220)) (local.get $v)) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2224))
        (then (call $sa1_scpu_bwram (local.get $v)) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2225))
        (then (if (i32.ne (local.get $v) ${F(0x2225)}) (then (call $sa1_bwmap (local.get $v)))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2231))
        (then (if (i32.and (local.get $v) (i32.const 0x80)) (then (global.set $sa1_inchar (i32.const 0)))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2236))
        (then ${SETF(0x2236, "(local.get $v)")}
              (if (i32.eq (i32.and ${F(0x2230)} (i32.const 0xA4)) (i32.const 0x80))
                (then (call $sa1_dma))
                (else (if (i32.eq (i32.and ${F(0x2230)} (i32.const 0xB0)) (i32.const 0xB0))
                  (then (global.set $sa1_inchar (i32.const 1))
                        ${ORF(0x2300, 0x20)}
                        (if (i32.and ${F(0x2201)} (i32.const 0x20))
                          (then ${ANDF(0x2202, 0xdf)} (global.set $irqext (i32.const 1))))))))
              (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2237))
        (then ${SETF(0x2237, "(local.get $v)")}
              (if (i32.eq (i32.and ${F(0x2230)} (i32.const 0xA4)) (i32.const 0x84)) (then (call $sa1_dma)))
              (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x223F))
        (then (global.set $sa1_vbf (if (result i32) (i32.and (local.get $v) (i32.const 0x80)) (then (i32.const 2)) (else (i32.const 4)))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x224F))
        (then ${SETF(0x224f, "(local.get $v)")}
              (if (i32.eq (i32.and ${F(0x2230)} (i32.const 0xB0)) (i32.const 0xA0))
                (then (memory.copy (i32.add (global.get $sa1_ccbuf) (i32.shl (global.get $sa1_inchar) (i32.const 4)))
                                   (i32.add (global.get $sa1_fill) (i32.const 0x2240)) (i32.const 16))
                      (global.set $sa1_inchar (i32.and (i32.add (global.get $sa1_inchar) (i32.const 1)) (i32.const 7)))
                      (if (i32.eqz (i32.and (global.get $sa1_inchar) (i32.const 3))) (then (call $sa1_cc2)))))
              (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2250))
        (then (if (i32.and (local.get $v) (i32.const 2)) (then (global.set $sa1_sum (i64.const 0))))
              (global.set $sa1_aop (i32.and (local.get $v) (i32.const 3))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2251))
        (then (global.set $sa1_op1 (i32.or (i32.and (global.get $sa1_op1) (i32.const 0xFF00)) (local.get $v))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2252))
        (then (global.set $sa1_op1 (i32.or (i32.and (global.get $sa1_op1) (i32.const 0xFF)) (i32.shl (local.get $v) (i32.const 8)))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2253))
        (then (global.set $sa1_op2 (i32.or (i32.and (global.get $sa1_op2) (i32.const 0xFF00)) (local.get $v))) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2254))
        (then (global.set $sa1_op2 (i32.or (i32.and (global.get $sa1_op2) (i32.const 0xFF)) (i32.shl (local.get $v) (i32.const 8))))
              (call $sa1_arith) (br $store)))
      (if (i32.eq (local.get $x) (i32.const 0x2258))
        (then ${SETF(0x2258, "(local.get $v)")} (call $sa1_varlen (i32.const 1) (i32.const 0)) (return)))
      (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2259)) (i32.le_u (local.get $x) (i32.const 0x225B)))
        (then ${SETF("(local.get $x)", "(local.get $v)")}
              (global.set $sa1_vbp (i32.const 0))
              (call $sa1_varlen (i32.const 0) (i32.const 1)) (return))))
    (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2200)) (i32.le_u (local.get $x) (i32.const 0x22FF)))
      (then ${SETF("(local.get $x)", "(local.get $v)")})))

  ;; the arithmetic unit, at the $2254 write
  (func $sa1_arith
    (local $p i32) (local $dx i32) (local $rm i32) (local $qt i32)
    (local.set $p (i32.mul (i32.extend16_s (global.get $sa1_op1)) (i32.extend16_s (global.get $sa1_op2))))
    (if (i32.eqz (global.get $sa1_aop))
      (then (global.set $sa1_sum (i64.extend_i32_s (local.get $p)))
            (global.set $sa1_op2 (i32.const 0))
            (return)))
    (if (i32.eq (global.get $sa1_aop) (i32.const 1))
      (then
        (if (i32.eqz (global.get $sa1_op2))
          (then (global.set $sa1_sum (i64.const 0)))
          (else
            (local.set $dx (i32.add (i32.extend16_s (global.get $sa1_op1)) (i32.shl (global.get $sa1_op2) (i32.const 16))))
            (local.set $rm (i32.and (i32.rem_u (local.get $dx) (global.get $sa1_op2)) (i32.const 0xFFFF)))
            (local.set $qt (i32.and (i32.div_u (local.get $dx) (global.get $sa1_op2)) (i32.const 0xFFFF)))
            (global.set $sa1_sum (i64.extend_i32_s (i32.or (i32.shl (local.get $rm) (i32.const 16)) (local.get $qt))))))
        (global.set $sa1_op1 (i32.const 0))
        (global.set $sa1_op2 (i32.const 0))
        (return)))
    (global.set $sa1_sum (i64.add (global.get $sa1_sum) (i64.extend_i32_s (local.get $p))))
    (global.set $sa1_ovf (i64.ge_u (global.get $sa1_sum) (i64.const 0x10000000000)))
    (global.set $sa1_sum (i64.and (global.get $sa1_sum) (i64.const 0xFFFFFFFFFF)))
    (global.set $sa1_op2 (i32.const 0)))

  ;; S9xSA1ReadVariableLengthData(inc, no_shift)
  (func $sa1_varlen (param $inc i32) (param $noshift i32)
    (local $addr i32) (local $shift i32) (local $s i32) (local $data i32)
    (local.set $addr (i32.or ${F(0x2259)} (i32.or (i32.shl ${F(0x225a)} (i32.const 8)) (i32.shl ${F(0x225b)} (i32.const 16)))))
    (local.set $shift (i32.and ${F(0x2258)} (i32.const 15)))
    (if (local.get $noshift) (then (local.set $shift (i32.const 0)))
      (else (if (i32.eqz (local.get $shift)) (then (local.set $shift (i32.const 16))))))
    (local.set $s (i32.and (i32.add (local.get $shift) (global.get $sa1_vbp)) (i32.const 0xFF)))
    (if (i32.ge_u (local.get $s) (i32.const 16))
      (then (local.set $addr (i32.add (local.get $addr) (i32.shl (i32.shr_u (local.get $s) (i32.const 4)) (i32.const 1))))
            (local.set $s (i32.and (local.get $s) (i32.const 15)))))
    (local.set $data (i32.or (call $sa1_rd8 (local.get $addr)) (i32.shl (call $sa1_rd8 (i32.add (local.get $addr) (i32.const 1))) (i32.const 8))))
    (local.set $data (i32.or (local.get $data) (i32.shl (call $sa1_rd8 (i32.add (local.get $addr) (i32.const 2))) (i32.const 16))))
    (local.set $data (i32.or (local.get $data) (i32.shl (call $sa1_rd8 (i32.add (local.get $addr) (i32.const 3))) (i32.const 24))))
    (local.set $data (i32.shr_u (local.get $data) (local.get $s)))
    ${SETF(0x230c, "(local.get $data)")}
    ${SETF(0x230d, "(i32.shr_u (local.get $data) (i32.const 8))")}
    (if (local.get $inc)
      (then (global.set $sa1_vbp (i32.and (i32.add (global.get $sa1_vbp) (local.get $shift)) (i32.const 15)))
            ${SETF(0x2259, "(local.get $addr)")}
            ${SETF(0x225a, "(i32.shr_u (local.get $addr) (i32.const 8))")}
            ${SETF(0x225b, "(i32.shr_u (local.get $addr) (i32.const 16))")})))

  ;; S9xSA1DMA: normal DMA to I-RAM ($2236) or BW-RAM ($2237)
  (func $sa1_dma
    (local $src i32) (local $dst i32) (local $len i32) (local $s i32) (local $d i32) (local $e i32) (local $n i32)
    (local.set $src (i32.or ${F(0x2232)} (i32.or (i32.shl ${F(0x2233)} (i32.const 8)) (i32.shl ${F(0x2234)} (i32.const 16)))))
    (local.set $dst (i32.or ${F(0x2235)} (i32.or (i32.shl ${F(0x2236)} (i32.const 8)) (i32.shl ${F(0x2237)} (i32.const 16)))))
    (local.set $len (i32.or ${F(0x2238)} (i32.shl ${F(0x2239)} (i32.const 8))))
    (local.set $e (i32.and ${F(0x2230)} (i32.const 3)))
    (if (i32.eqz (local.get $e))
      (then (local.set $e (i32.add (i32.const ${MAP}) (i32.shl (i32.shr_u (i32.and (local.get $src) (i32.const 0xFFFFFF)) (i32.const 12)) (i32.const 3))))
            (if (i32.or (i32.eq (i32.load (local.get $e)) (i32.const 1)) (i32.eq (i32.load (local.get $e)) (i32.const 2)))
              (then (local.set $s (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $src) (i32.const 0xFFF)))))
              (else (local.set $s (i32.add (i32.const ${ROM}) (i32.and (local.get $src) (i32.const 0xFFFF)))))))
      (else (if (i32.eq (local.get $e) (i32.const 1))
        (then (local.set $src (i32.and (local.get $src) (i32.const ${mask})))
              (local.set $len (i32.and (local.get $len) (i32.const ${mask})))
              (local.set $s (i32.add (i32.const ${SRAM}) (local.get $src))))
        (else (local.set $src (i32.and (local.get $src) (i32.const 0x3FF)))
              (local.set $len (i32.and (local.get $len) (i32.const 0x3FF)))
              (local.set $s (i32.add (global.get $sa1_fill) (i32.add (i32.const 0x3000) (local.get $src))))))))
    (if (i32.and ${F(0x2230)} (i32.const 4))
      (then (local.set $dst (i32.and (local.get $dst) (i32.const ${mask})))
            (local.set $len (i32.and (local.get $len) (i32.const ${mask})))
            (local.set $d (i32.add (i32.const ${SRAM}) (local.get $dst))))
      (else (local.set $dst (i32.and (local.get $dst) (i32.const 0x3FF)))
            (local.set $len (i32.and (local.get $len) (i32.const 0x3FF)))
            (local.set $d (i32.add (global.get $sa1_fill) (i32.add (i32.const 0x3000) (local.get $dst))))))
    ;; (the ROM buffer is zero past the image)
    (if (i32.and (i32.ge_u (local.get $s) (i32.const ${ROM})) (i32.lt_u (local.get $s) (i32.const ${romEnd})))
      (then (local.set $n (i32.sub (i32.const ${romEnd}) (local.get $s)))
            (if (i32.gt_u (local.get $len) (local.get $n))
              (then (memory.copy (local.get $d) (local.get $s) (local.get $n))
                    (memory.fill (i32.add (local.get $d) (local.get $n)) (i32.const 0) (i32.sub (local.get $len) (local.get $n))))
              (else (memory.copy (local.get $d) (local.get $s) (local.get $len)))))
      (else (if (i32.eq (local.get $s) (i32.const ${ZERO}))
        (then (memory.fill (local.get $d) (i32.const 0) (local.get $len)))
        (else (memory.copy (local.get $d) (local.get $s) (local.get $len))))))
    ${ORF(0x2301, 0x20)}
    (if (i32.and ${F(0x220a)} (i32.const 0x20)) (then ${ANDF(0x220b, 0xdf)})))

  ;; S9xSA1CharConv2: four bitmap rows into one I-RAM character
  (func $sa1_cc2
    (local $dest i32) (local $off i32) (local $depth i32) (local $p i32) (local $q i32) (local $l i32) (local $b i32) (local $r i32)
    (local.set $dest (i32.or ${F(0x2235)} (i32.shl ${F(0x2236)} (i32.const 8))))
    (local.set $off (i32.eqz (i32.and (global.get $sa1_inchar) (i32.const 7))))
    (local.set $depth (i32.and ${F(0x2231)} (i32.const 3)))
    (local.set $depth (if (result i32) (i32.eqz (local.get $depth)) (then (i32.const 8))
      (else (if (result i32) (i32.eq (local.get $depth) (i32.const 1)) (then (i32.const 4)) (else (i32.const 2))))))
    (local.set $p (i32.add (global.get $sa1_fill) (i32.add (i32.const 0x3000)
      (i32.add (i32.and (local.get $dest) (i32.const 0x7FF)) (i32.mul (local.get $off) (i32.shl (local.get $depth) (i32.const 3)))))))
    (local.set $q (i32.add (global.get $sa1_ccbuf) (i32.shl (local.get $off) (i32.const 6))))
    (if (i32.eq (local.get $depth) (i32.const 2)) (then ${cc2Depth(2)} (return)))
    (if (i32.eq (local.get $depth) (i32.const 4)) (then ${cc2Depth(4)} (return)))
    ${cc2Depth(8)})

  ;; coproc.js $chip_dma = dma.cpp S9xDoDMA's SA-1 block: with character
  ;; conversion 1 on, a transfer to $2118 from banks $40-$4F converts its
  ;; bytes into the buffer; only a CPU -> PPU transfer then reads them (its A
  ;; address still walks as the channel says).
  (func $chip_dma (param $ch i32) (param $dmap i32) (param $src i32) (param $cnt i32) (result i32)
    (local $bport i32) (local $dir i32) (local $nch i32) (local $depth i32) (local $bpc i32) (local $bpl i32) (local $clb i32) (local $addr i32) (local $aa i32)
    (local $base i32) (local $p i32) (local $inc i32) (local $cc i32) (local $i i32) (local $j i32) (local $line i32)
    (local $q i32) (local $l i32) (local $b i32) (local $r i32) (local $bank i32)
    (local.set $bport (call $io_reg (i32.add (i32.const 0x4301) (i32.shl (local.get $ch) (i32.const 4)))))
    (local.set $dir (i32.and (local.get $dmap) (i32.const 0x80)))
    (local.set $bank (i32.and (i32.shr_u (local.get $src) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.eqz (i32.and (i32.and (i32.ne (global.get $sa1_inchar) (i32.const 0)) (i32.eq (local.get $bport) (i32.const 0x18)))
                          (i32.eq (i32.and (local.get $bank) (i32.const 0xF0)) (i32.const 0x40))))
      (then (return (i32.const 0))))
    (local.set $nch (i32.shl (i32.const 1) (i32.and (i32.shr_u ${F(0x2231)} (i32.const 2)) (i32.const 7))))
    (local.set $depth (i32.and ${F(0x2231)} (i32.const 3)))
    (local.set $depth (if (result i32) (i32.eqz (local.get $depth)) (then (i32.const 8))
      (else (if (result i32) (i32.eq (local.get $depth) (i32.const 1)) (then (i32.const 4)) (else (i32.const 2))))))
    (local.set $bpc (i32.shl (local.get $depth) (i32.const 3)))
    (local.set $bpl (i32.mul (local.get $depth) (local.get $nch)))
    (local.set $clb (i32.mul (local.get $bpc) (local.get $nch)))
    (local.set $aa (i32.and (local.get $src) (i32.const 0xFFFF)))
    (local.set $addr (i32.mul (i32.div_u (local.get $aa) (local.get $clb)) (local.get $clb)))
    ;; S9xGetBasePointer: banks $40-$4E map SRAM + (bank & 3) * $10000; $4F none (snes9x falls back to Memory.ROM)
    (local.set $base (if (result i32) (i32.eq (local.get $bank) (i32.const 0x4F))
      (then (i32.add (i32.const ${ROM}) (local.get $addr)))
      (else (i32.add (i32.add (i32.const ${SRAM}) (i32.shl (i32.and (local.get $bank) (i32.const 3)) (i32.const 16))) (local.get $addr)))))
    (local.set $p (global.get $sa1_ccbuf))
    (local.set $inc (i32.sub (local.get $clb) (i32.rem_u (local.get $aa) (local.get $clb))))
    (local.set $cc (i32.div_u (local.get $inc) (local.get $bpc)))
    (if (i32.eq (local.get $depth) (i32.const 2)) (then ${cc1Depth(2)}))
    (if (i32.eq (local.get $depth) (i32.const 4)) (then ${cc1Depth(4)}))
    (if (i32.eq (local.get $depth) (i32.const 8)) (then ${cc1Depth(8)}))
    (if (local.get $dir) (then (return (i32.const 0))))
    ;; the buffer is read at p = 0, p += inc (inc 0 / +1 / -1 by $43x0 bits 3 and 4)
    (global.set $sa1_ccstep (if (result i32) (i32.and (local.get $dmap) (i32.const 0x08)) (then (i32.const 0))
      (else (if (result i32) (i32.and (local.get $dmap) (i32.const 0x10)) (then (i32.const -1)) (else (i32.const 1))))))
    (global.set $cdma_src (local.get $src))
    (global.set $cdma_step (global.get $sa1_ccstep))
    (i32.const 1))
  (func $chip_dma_byte (param $i i32) (result i32)
    (i32.load8_u (i32.add (global.get $sa1_ccbuf) (i32.and (i32.mul (local.get $i) (global.get $sa1_ccstep)) (i32.const 0xFFFF)))))

  ;; coproc.js $chip_b_rd / $chip_b_wr: the S-CPU's $2200-$2FFF (ppu.cpp
  ;; S9xGetPPU / S9xSetPPU with Settings.SA1: S9xGetSA1, S9xSetSA1 up to
  ;; $23FF, FillRAM above). An (H)DMA reads open bus there and drops writes.
  (func $chip_b_rd (param $x i32) (result i32)
    (if (i32.or (i32.lt_u (local.get $x) (i32.const 0x2200)) (global.get $indma)) (then (return (i32.const -1))))
    (call $sa1_reg_rd (local.get $x)))
  (func $chip_b_wr (param $x i32) (param $v i32) (result i32)
    (if (i32.lt_u (local.get $x) (i32.const 0x2200)) (then (return (i32.const 0))))
    (if (i32.eqz (global.get $indma)) (then (call $sa1_sreg_wr (local.get $x) (local.get $v))))
    (i32.const 1))

  ;; coproc.js $chip_line: the line end's SA1.Cycles -= Timings.H_Max * 3
  (func $chip_line
    (global.set $sa1_cyc (i32.sub (global.get $sa1_cyc) (i32.mul (global.get $hmax) (i32.const 3)))))

  ;; coproc.js $chip_vec: S9xOpcode_IRQ / S9xOpcode_NMI with $2209 bit 6 /
  ;; bit 4: the vector comes from $220E / $220C at TWO_CYCLES, no read.
  (func $chip_vec (param $nmi i32) (result i32)
    (local $lo i32)
    (if (i32.eqz (i32.and ${F(0x2209)} (if (result i32) (local.get $nmi) (then (i32.const 0x10)) (else (i32.const 0x40)))))
      (then (return (i32.const 0))))
    (local.set $lo (if (result i32) (local.get $nmi) (then (i32.const 0x220C)) (else (i32.const 0x220E))))
    (global.set $ob ${F("(i32.add (local.get $lo) (i32.const 1))")})
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 12)))
    (call $ev_due)
    (global.set $pc (i32.or ${F("(local.get $lo)")} (i32.shl ${F("(i32.add (local.get $lo) (i32.const 1))")} (i32.const 8))))
    (i32.const 1))

  ;; S9xSA1UpdateTimer (HCounter / VCounter are int16, PrevCycles is not
  ;; moved by the line end: a line's -H_Max*3 shows up in the next delta)
  (func $sa1_timer
    (local $this i32) (local $hmx i32) (local $vmx i32)
    (global.set $sa1_prevhc (global.get $sa1_hc))
    (if (i32.and ${F(0x2210)} (i32.const 0x80))
      (then (local.set $hmx (i32.const 0x800)) (local.set $vmx (i32.const 0x200)))
      (else (local.set $hmx (i32.const 1364)) (local.set $vmx (i32.const ${lay.pal ? 312 : 262}))))
    (global.set $sa1_hc (i32.extend16_s (i32.add (global.get $sa1_hc) (i32.sub (global.get $sa1_cyc) (global.get $sa1_prevcyc)))))
    (if (i32.ge_s (global.get $sa1_hc) (local.get $hmx))
      (then (global.set $sa1_hc (i32.extend16_s (i32.sub (global.get $sa1_hc) (local.get $hmx))))
            (global.set $sa1_prevhc (i32.extend16_s (i32.sub (global.get $sa1_prevhc) (local.get $hmx))))
            (global.set $sa1_vc (i32.extend16_s (i32.add (global.get $sa1_vc) (i32.const 1))))
            (if (i32.ge_s (global.get $sa1_vc) (local.get $vmx)) (then (global.set $sa1_vc (i32.const 0))))))
    (global.set $sa1_prevcyc (global.get $sa1_cyc))
    (local.set $this (i32.and ${F(0x2210)} (i32.const 3)))
    (if (i32.and ${F(0x2210)} (i32.const 1))
      (then (if (i32.or (i32.ge_s (global.get $sa1_prevhc) (i32.shl (global.get $sa1_htpos) (i32.const 2)))
                        (i32.lt_s (global.get $sa1_hc) (i32.shl (global.get $sa1_htpos) (i32.const 2))))
              (then (local.set $this (i32.const 0))))))
    (if (i32.and ${F(0x2210)} (i32.const 2))
      (then (if (i32.ne (global.get $sa1_vc) (i32.shl (global.get $sa1_vtpos) (i32.const 2)))
              (then (local.set $this (i32.const 0))))))
    (if (i32.and (i32.eqz (global.get $sa1_tlast)) (i32.ne (local.get $this) (i32.const 0)))
      (then ${ORF(0x2301, 0x40)}
            (if (i32.and ${F(0x220a)} (i32.const 0x40)) (then ${ANDF(0x220b, 0xbf)}))))
    (global.set $sa1_tlast (local.get $this)))

  ;; the SA-1's IRQ / NMI entry (S9xOpcode_IRQ / S9xOpcode_NMI, SA1_OPCODES):
  ;; vector from $2207 / $2205
  (func $sa1_int (param $vec i32)
    (global.set $ms (call $sa1_speed (global.get $pc)))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.add (global.get $ms) (i32.const 6))))
    (if (i32.eqz (global.get $fe))
      (then (call $wr8 (global.get $s) (i32.shr_u (global.get $pc) (i32.const 16)))
            (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))
            (call $push16 (i32.and (global.get $pc) (i32.const 0xFFFF))))
      (else (call $push16e (i32.and (global.get $pc) (i32.const 0xFFFF)))))
    (call $push8 (call $packp))
    (global.set $fd (i32.const 0))
    (global.set $fi (i32.const 1))
    (global.set $ob ${F("(i32.add (local.get $vec) (i32.const 1))")})
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 12)))
    (global.set $pc (i32.or ${F("(local.get $vec)")} (i32.shl ${F("(i32.add (local.get $vec) (i32.const 1))")} (i32.const 8)))))

  ;; One SA-1 instruction: its arm (ROM) or the RAM interpreter (I-RAM,
  ;; BW-RAM), then what the SA1_OPCODES build does differently.
  (func $sa1_step
    (local $e i32) (local $b i32) (local $off i32) (local $id i32) (local $op i32)
    (global.set $ms (call $sa1_speed (global.get $pc)))
    (local.set $e (i32.add (i32.const ${MAP}) (i32.shl (i32.shr_u (i32.and (global.get $pc) (i32.const 0xFFFFFF)) (i32.const 12)) (i32.const 3))))
    (local.set $b (i32.load offset=4 (local.get $e)))
    (if (i32.and (i32.eq (i32.load (local.get $e)) (i32.const 1)) (i32.ne (local.get $b) (i32.const ${ZERO})))
      (then (local.set $off (i32.add (i32.sub (local.get $b) (i32.const ${ROM})) (i32.and (global.get $pc) (i32.const 0xFFF))))
            (local.set $op (i32.load8_u (i32.add (i32.const ${ROM}) (local.get $off))))
            (local.set $id (i32.load (i32.add (i32.const ${lay.PCTAB}) (i32.shl (local.get $off) (i32.const 2))))))
      (else (local.set $op (call $sa1_fetch (global.get $pc)))))
    ;; the opcode fetch leaves the opcode on the SA-1's bus (SA1OpenBus = Op)
    (global.set $ob (local.get $op))
    (if (local.get $id)
      (then (call $sa1_dispatch (i32.sub (local.get $id) (i32.const 1))))
      (else (call $istep)))
    ;; JML abs / JML [abs]: AddCycles(ONE_CYCLE) after the jump (SA1_OPCODES)
    (if (i32.or (i32.eq (local.get $op) (i32.const 0x5C)) (i32.eq (local.get $op) (i32.const 0xDC)))
      (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))))
    ;; WAI: SA1.WaitingForInterrupt, PC stays on the WAI, TWO_CYCLES a turn
    (if (global.get $wai)
      (then (global.set $wai (i32.const 0))
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))
            (global.set $pc (i32.or (i32.and (global.get $pc) (i32.const 0xFF0000)) (i32.and (i32.sub (global.get $pc) (i32.const 1)) (i32.const 0xFFFF))))
            (global.set $sa1_wait (i32.const 1))))
    ;; CLI / SEI: ClearIRQ() / SetIRQ() at once
    (if (global.get $ichg)
      (then (if (i32.and (global.get $ichg) (i32.const 1))
              (then (global.set $fi (i32.const 0)))
              (else (if (i32.and (global.get $ichg) (i32.const 2)) (then (global.set $fi (i32.const 1))))))
            (global.set $ichg (i32.const 0))))
    (global.set $stp (i32.const 0)))

  ;; S9xSA1MainLoop, after every S-CPU instruction
  (func $sa1_main
    (local $target i32)
    (if (i32.and ${F(0x2200)} (i32.const 0x60))
      (then (global.set $sa1_cyc (i32.add (global.get $sa1_cyc) (i32.const 6)))
            (call $sa1_timer)
            (return)))
    (local.set $target (i32.mul (call $hnow) (i32.const 3)))
    ${swapIn}
    (if (i32.and (i32.ne (i32.and ${F(0x2200)} (i32.const 0x10)) (i32.const 0)) (i32.eqz (i32.and ${F(0x220b)} (i32.const 0x10))))
      (then ${ORF(0x2301, 0x10)} ${ORF(0x220b, 0x10)} ${wake} (call $sa1_int (i32.const 0x2205)))
      (else (if (i32.eqz (global.get $fi))
        (then
          (if (i32.and (i32.ne (i32.and ${F(0x220a)} (i32.const 0x40)) (i32.const 0)) (i32.eqz (i32.and ${F(0x220b)} (i32.const 0x40))))
            (then ${ORF(0x2301, 0x40)} ${wake} (call $sa1_int (i32.const 0x2207)))
            (else (if (i32.and (i32.ne (i32.and ${F(0x220a)} (i32.const 0x20)) (i32.const 0)) (i32.eqz (i32.and ${F(0x220b)} (i32.const 0x20))))
              (then ${ORF(0x2301, 0x20)} ${wake} (call $sa1_int (i32.const 0x2207)))
              (else (if (i32.and (i32.ne (i32.and ${F(0x2200)} (i32.const 0x80)) (i32.const 0)) (i32.eqz (i32.and ${F(0x220b)} (i32.const 0x80))))
                (then ${ORF(0x2301, 0x80)} ${wake} (call $sa1_int (i32.const 0x2207))))))))))))
    (block $d (loop $l
      (br_if $d (i32.le_s (global.get $cyc) (i32.const 0)))
      (br_if $d (i32.and ${F(0x2200)} (i32.const 0x60)))
      (call $sa1_step)
      (br $l)))
    ${swapOut}
    (call $sa1_timer))

  ;; coproc.js $chip_reset = S9xSA1Init (at power-on, after S9xSoftResetPPU
  ;; filled FillRAM)
  (func $chip_reset
    (local $c i32)
    ;; FillRAM: each page holds its own number, some pages cleared (S9xSoftResetPPU)
    (local.set $c (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $c) (i32.const 0x80)))
      (memory.fill (i32.add (global.get $sa1_fill) (i32.shl (local.get $c) (i32.const 8))) (local.get $c) (i32.const 0x100))
      (local.set $c (i32.add (local.get $c) (i32.const 1)))
      (br $l)))
    (memory.fill (i32.add (global.get $sa1_fill) (i32.const 0x2100)) (i32.const 0) (i32.const 0x100))
    (memory.fill (i32.add (global.get $sa1_fill) (i32.const 0x4200)) (i32.const 0) (i32.const 0x100))
    (memory.fill (i32.add (global.get $sa1_fill) (i32.const 0x4000)) (i32.const 0) (i32.const 0x100))
    (memory.fill (i32.add (global.get $sa1_fill) (i32.const 0x1000)) (i32.const 0) (i32.const 0x1000))
    ${SETF(0x4201, "(i32.const 0xFF)")} ${SETF(0x4213, "(i32.const 0xFF)")}
    ${SETF(0x2126, "(i32.const 1)")} ${SETF(0x2128, "(i32.const 1)")}
    ;; S9xSA1Init
    (memory.fill (i32.add (global.get $sa1_fill) (i32.const 0x2200)) (i32.const 0) (i32.const 0x200))
    ${SETF(0x2200, "(i32.const 0x20)")}
    ${SETF(0x2221, "(i32.const 1)")} ${SETF(0x2222, "(i32.const 2)")} ${SETF(0x2223, "(i32.const 3)")}
    ${SETF(0x2228, "(i32.const 0x0F)")}
    (global.set $sa1_s (i32.const 0x01FF))
    (global.set $sa1_fm (i32.const 1)) (global.set $sa1_fx (i32.const 1))
    (global.set $sa1_fi (i32.const 1)) (global.set $sa1_fe (i32.const 1))
    (global.set $sa1_ms (i32.const 6))
    (global.set $sa1_vbf (i32.const 4))
    (global.set $sa1_bwram (i32.const ${SRAM}))
    (global.set $irqext (i32.const 0)))

  (func (export "dbg_sa1_pc") (result i32) (if (result i32) (global.get $sacpu) (then (global.get $pc)) (else (global.get $sa1_pc))))
  (func (export "dbg_sa1_cyc") (result i32) (global.get $sa1_cyc))
`;
}

/** @param {Uint8Array} bytes */
function esc(bytes) {
  let o = "";
  for (const v of bytes) o += "\\" + (v < 16 ? "0" : "") + v.toString(16);
  return o;
}

/**
 * $sa1_dispatch: arm id -> the shard function, the binary search index.js
 * emits in $step.
 * @param {number} nshards
 */
function dispatchWat(nshards, lo = 0, hi = nshards, indent = 4) {
  const pad = " ".repeat(indent);
  if (hi - lo === 1) return `${pad}(call $shard${lo} (i32.sub (local.get $id) (i32.const ${lo * SH}))) (return)`;
  const mid = (lo + hi) >> 1;
  return `${pad}(if (i32.lt_u (local.get $id) (i32.const ${mid * SH}))\n${pad}  (then\n` +
    dispatchWat(nshards, lo, mid, indent + 4) + `\n${pad}  )\n${pad}  (else\n` +
    dispatchWat(nshards, mid, hi, indent + 4) + `\n${pad}  ))`;
}

/**
 * The whole SA-1 WAT of a cart: globals, the SA-1's block map, the arm
 * dispatch, the functions.
 * @param {any} lay
 * @param {any} d  describe()
 */
function sa1Wat(lay, d) {
  const { sa1 } = sa1MemMaps({ romSize: d.romSize, SRAM: lay.SRAM, FILL: sa1Regions(lay.CHIP).FILL });
  return [
    sa1GlobalsWat(lay),
    `  (data (i32.const ${sa1Regions(lay.CHIP).MAP}) "${esc(sa1)}")`,
    `  (func $sa1_dispatch (param $id i32)\n${dispatchWat(Math.ceil(lay.narms / SH))}\n    (call $trap))`,
    sa1FuncsWat(lay),
  ].join("\n");
}

/**
 * The coproc.js chip module: InitROM's SA-1 ids ($3423 / $3523, loader.js
 * names them "SA-1"), Map_SA1LoROMMap for a LoROM image (snes9x takes the
 * SA-1 map in its LoROM branch only), the chip block, the WAT and the verify
 * regions (I-RAM and BW-RAM compared, not diagnostic).
 */
export const sa1 = {
  id: SA1_CHIP,
  boards: [SA1_BOARD],
  /** @param {{ hiRom: boolean, extended: string }} o */
  board: ({ hiRom, extended }) => (hiRom || extended !== "none" ? null : SA1_BOARD),
  pages: SA1_PAGES,
  /** the S-CPU's map: Map_SA1LoROMMap (map_System is already there, map_WRAM follows) */
  buildMap: (api, lay) => {
    if (api.map !== SA1_BOARD) return;
    const { scpu } = sa1MemMaps({ romSize: api.size, SRAM: lay.SRAM, FILL: sa1Regions(lay.CHIP).FILL });
    const dv = new DataView(scpu.buffer);
    for (let p = 0; p < 4096; p++) api.set(p, dv.getUint32(p * 8, true), dv.getUint32(p * 8 + 4, true));
  },
  wat: (lay, d) => (d.board === SA1_BOARD ? sa1Wat(lay, d) : ""),
  section: (d) => {
    if (d.board !== SA1_BOARD) return {};
    const lay = d.memory;
    const { FILL } = sa1Regions(lay.CHIP);
    const regions = {
      ...d.layout.regions,
      // I-RAM and the SA-1 registers: snes9x Memory.FillRAM $3000-$37FF / $2200-$23FF
      iram: { offset: FILL + 0x3000, length: 0x800, ref: "snes_fillram", refOffset: 0x3000 },
      sa1reg: { offset: FILL + 0x2200, length: 0x200, ref: "snes_fillram", refOffset: 0x2200 },
    };
    const diagnosticRegions = { ...d.layout.diagnosticRegions };
    // BW-RAM is the SA-1's working memory: compared (libretro's save_ram is its first SRAMSize bytes)
    if (diagnosticRegions.sram) {
      regions.bwram = { ...diagnosticRegions.sram, length: Math.min(diagnosticRegions.sram.length, 0x20000) };
      delete diagnosticRegions.sram;
    }
    return { regions, diagnosticRegions };
  },
};

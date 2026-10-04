// Coprocessor dispatch for the SNES WAT backend. snes9x reaches a cartridge
// chip through a handful of places, and the cart has one hook at each:
//
//   Memory.Map blocks of a chip type (MAP_C4, MAP_SPC7110_DRAM, ...)
//       -> MAP_TYPE.CHIP blocks, read by $chip_rd / written by $chip_wr
//   S9xGetCPU / S9xSetCPU's default case ($4000-$5FFF past the joypad and
//   $4200-$43FF registers, e.g. the S-DD1 and SPC7110 ports at $4800)
//       -> $chip_io_rd / $chip_io_wr (open bus / ignored without a chip)
//   S9xDoDMA's "custom chip DMA" (a decompressor feeding a transfer)
//       -> $chip_dma (does this channel read the chip?) and $chip_dma_byte
//   S9xReset's per-chip reset (S9xResetSDD1, S9xResetSPC7110, S9xInitC4)
//       -> $chip_reset, called by wc_init
//   the line end (HC_HCOUNTER_MAX_EVENT's S9xSuperFXExec)
//       -> $chip_line, before the APU catches up
//   S9xOpcode_IRQ / S9xOpcode_NMI's vector (the SA-1's $2209 overrides)
//       -> $chip_vec, before the vector read
//   CPU.IRQExternal (the SuperFX's IRQ on stop)
//       -> $irqext, taken by $run_frame with the H/V timer's line
//   the end of a frame (retro_run returns)
//       -> $chip_frame (the chip's state for the verifier's chipstate region)
//   the board map (Map_SDD1LoROMMap, Map_SPC7110HiROMMap, map_C4)
//       -> chip.board() names it, chip.buildMap() fills memmap.js's table
//   S9xGetWord / S9xSetWord's choice between one grouped access and two
//   byte accesses, where a chip's map types differ from its block types
//       -> chip.wordBus {readByByte, writeGrouped} bank ranges (cpu-wat.js $fast2)
//
// A chip module exports an object {id, board?, boards?, buildMap?, pages?,
// wordBus?, wat(lay, d), section?(d)}: `id` is loader.js's coprocessor name, `board`
// renames the board map and `boards` lists the names memmap.js does not
// know (buildMap(api, lay, d) builds those, or adds the chip's window to a
// known one), `wat` defines the $chip_* functions it implements and this
// file supplies the rest. Chip state lives in `lay.CHIP` (chip.pages * 64KB
// above everything else the cart places); `section` adds fields to the
// romdev.recompile section.
//
// Plain JS ESM + JSDoc.

import { superfx } from "./superfx.js";
import { sa1 } from "./sa1.js";
import { sdd1 } from "./sdd1.js";
import { cx4 } from "./cx4.js";
import { spc7110 } from "./spc7110.js";
import { SNES9X_HLE_CHIPS } from "./chips-snes9x.js";
import { msuWat } from "./msu1.js";
import { bsxChip } from "./bsx.js";
import { ARES_CHIPS } from "./chips-ares.js";

/** The chip modules (add one line per chip). */
const CHIP_LIST = [
  superfx,
  sa1,
  ...SNES9X_HLE_CHIPS,   // DSP-1..4, ST010/011/018, OBC1, S-RTC
  bsxChip,               // the Satellaview BIOS (and a BS cart run by it)
  sdd1,
  cx4,
  spc7110,
];

/** @type {Map<string, any>} loader.js coprocessor name -> chip module */
const CHIPS = new Map(CHIP_LIST.map((c) => [c.id, c]));
/** The chips that run on ares's code when the cart is built with their firmware (chips-ares.js). */
const ARES = new Map(ARES_CHIPS.map((c) => [c.id, c]));

/**
 * The chip module for a loader coprocessor name, or null. impl "ares" picks
 * the chip run on ares's code (a cart built with options.firmware).
 * @param {string|null|undefined} name
 * @param {string|null} [impl]
 */
export function chipFor(name, impl = null) {
  if (impl === "ares") return (name && ARES.get(name)) || null;
  return (name && CHIPS.get(name)) || null;
}

/** Whether the chip runs firmware the recompiler can only run on ares's code (it needs options.firmware). */
export function chipNeedsFirmware(name) { return !!name && ARES.has(name); }

/** Every $chip_* hook with its no-chip body, and the chip DMA globals. */
const DEFAULTS = {
  chip_rd: "(func $chip_rd (param $a i32) (result i32) (global.get $ob))",
  chip_wr: "(func $chip_wr (param $a i32) (param $v i32))",
  chip_io_rd: "(func $chip_io_rd (param $x i32) (result i32) (global.get $ob))",
  chip_io_wr: "(func $chip_io_wr (param $x i32) (param $v i32))",
  chip_reset: "(func $chip_reset)",
  chip_dma: "(func $chip_dma (param $ch i32) (param $p i32) (param $src i32) (param $cnt i32) (result i32) (i32.const 0))",
  chip_dma_byte: "(func $chip_dma_byte (param $i i32) (result i32) (i32.const 0))",
  // HC_HCOUNTER_MAX_EVENT's chip work before the line ends (S9xSuperFXExec)
  chip_line: "(func $chip_line)",
  // ppu.cpp S9xGetPPU / S9xSetPPU past the PPU's own registers: a chip's
  // register on the $2000-$3FFF bus (the S-RTC's $2800/$2801, the BS-X
  // $2188-$219F, the MSU-1 $2000-$2007). $x is the 16-bit address; a read
  // returns -1 and a write 0 when the address is not the chip's.
  chip_b_rd: "(func $chip_b_rd (param $x i32) (result i32) (i32.const -1))",
  chip_b_wr: "(func $chip_b_wr (param $x i32) (param $v i32) (result i32) (i32.const 0))",
  // S9xOpcode_IRQ / S9xOpcode_NMI's vector ($nmi 0 / 1): a chip that
  // supplies it (the SA-1's $220E / $220C) sets $pc and returns 1.
  chip_vec: "(func $chip_vec (param $nmi i32) (result i32) (i32.const 0))",
  // the end of a frame (where retro_run returns): a chip that serves its
  // internal state to the verifier writes it (chip-unit.js chipstateWat)
  chip_frame: "(func $chip_frame)",
};

/**
 * The coprocessor WAT of a cart: the chip's own functions plus a default for
 * every hook it leaves out.
 * @param {any} d  describe() of the cart
 * @param {any} lay  its layout
 */
export function chipWat(d, lay) {
  const chip = chipFor(d.coprocessor, d.chipImpl);
  const own = chip ? chip.wat(lay, d) : "";
  const parts = [
    "  ;; ---- coprocessor hooks (coproc.js) ----",
    "  (global $cdma (mut i32) (i32.const 0))       ;; this DMA reads the chip's buffer",
    "  (global $cdma_src (mut i32) (i32.const 0))   ;; its A address to start from",
    "  (global $cdma_step (mut i32) (i32.const 0))  ;; and how the A address walks",
    "  ;; CPU.IRQExternal: a chip's IRQ line into the S-CPU (the SuperFX's stop)",
    "  (global $irqext (mut i32) (i32.const 0))",
  ];
  for (const [name, body] of Object.entries(DEFAULTS)) {
    if (!new RegExp(`\\(func \\$${name}[\\s)]`).test(own)) parts.push("  " + body);
  }
  const text = parts.join("\n") + "\n" + own;
  const full = d.msu1 ? withMsu(text, lay, d) : text;
  return d.breakChip ? withBrokenChip(full) : full;
}

/**
 * options.breakChip, a MUST-FAIL CONTROL: every byte the CPU or a DMA reads
 * from the coprocessor ($chip_rd, $chip_io_rd, $chip_b_rd when the chip
 * answers, $chip_dma_byte) has bit 0 flipped, so a verifier that really
 * compares the chip's effects must reject the cart.
 * @param {string} text  the composed hooks
 */
function withBrokenChip(text) {
  for (const h of ["chip_rd", "chip_io_rd", "chip_b_rd", "chip_dma_byte"]) {
    text = text.replace(new RegExp(`\\(func \\$${h}([\\s)])`), `(func $${h}_unbroken$1`);
  }
  return text + `
  ;; options.breakChip (must-fail control): chip reads come back with bit 0 flipped
  (func $chip_rd (param $a i32) (result i32)
    (i32.xor (call $chip_rd_unbroken (local.get $a)) (i32.const 1)))
  (func $chip_io_rd (param $x i32) (result i32)
    (i32.xor (call $chip_io_rd_unbroken (local.get $x)) (i32.const 1)))
  (func $chip_b_rd (param $x i32) (result i32)
    (local $v i32)
    (local.set $v (call $chip_b_rd_unbroken (local.get $x)))
    (if (result i32) (i32.ge_s (local.get $v) (i32.const 0))
      (then (i32.xor (local.get $v) (i32.const 1))) (else (local.get $v))))
  (func $chip_dma_byte (param $i i32) (result i32)
    (i32.xor (call $chip_dma_byte_unbroken (local.get $i)) (i32.const 1)))`;
}

/**
 * An MSU-1 pack (msu1.js) beside whatever chip the cart has: ppu.cpp looks
 * at $2000-$2007 before any chip register, and S9xReset resets the MSU-1
 * along with the chip. The chip's (or default) $chip_b_rd / $chip_b_wr /
 * $chip_reset become the inner half of the composed ones.
 * @param {string} text  chipWat's hooks for the chip alone
 * @param {any} lay
 * @param {any} d
 */
function withMsu(text, lay, d) {
  for (const h of ["chip_b_rd", "chip_b_wr", "chip_reset"]) {
    text = text.replace(new RegExp(`\\(func \\$${h}([\\s)])`), `(func $${h}_chip$1`);
  }
  return text + msuWat(lay, d.msu1) + `
  (func $chip_b_rd (param $x i32) (result i32)
    (local $v i32)
    (local.set $v (call $msu_b_rd (local.get $x)))
    (if (i32.ge_s (local.get $v) (i32.const 0)) (then (return (local.get $v))))
    (call $chip_b_rd_chip (local.get $x)))
  (func $chip_b_wr (param $x i32) (param $v i32) (result i32)
    (if (call $msu_b_wr (local.get $x) (local.get $v)) (then (return (i32.const 1))))
    (call $chip_b_wr_chip (local.get $x) (local.get $v)))
  (func $chip_reset
    (call $msu_power)
    (call $chip_reset_chip))`;
}

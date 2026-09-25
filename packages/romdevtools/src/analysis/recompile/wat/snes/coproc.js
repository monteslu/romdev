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
//   CPU.IRQExternal (the SuperFX's IRQ on stop)
//       -> $irqext, taken by $run_frame with the H/V timer's line
//   the board map (Map_SDD1LoROMMap, Map_SPC7110HiROMMap, map_C4)
//       -> chip.board() names it, chip.buildMap() fills memmap.js's table
//
// A chip module exports an object {id, board?, boards?, buildMap?, pages?,
// wat(lay, d), section?(d)}: `id` is loader.js's coprocessor name, `board`
// renames the board map and `boards` lists the names memmap.js does not
// know (buildMap(api, lay, d) builds those, or adds the chip's window to a
// known one), `wat` defines the $chip_* functions it implements and this
// file supplies the rest. Chip state lives in `lay.CHIP` (chip.pages * 64KB
// above everything else the cart places); `section` adds fields to the
// romdev.recompile section.
//
// Plain JS ESM + JSDoc.

import { superfx } from "./superfx.js";

/** The chip modules (add one line per chip). */
const CHIP_LIST = [
  superfx,
];

/** @type {Map<string, any>} loader.js coprocessor name -> chip module */
const CHIPS = new Map(CHIP_LIST.map((c) => [c.id, c]));

/**
 * The chip module for a loader coprocessor name, or null.
 * @param {string|null|undefined} name
 */
export function chipFor(name) { return (name && CHIPS.get(name)) || null; }

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
};

/**
 * The coprocessor WAT of a cart: the chip's own functions plus a default for
 * every hook it leaves out.
 * @param {any} d  describe() of the cart
 * @param {any} lay  its layout
 */
export function chipWat(d, lay) {
  const chip = chipFor(d.coprocessor);
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
  return parts.join("\n") + "\n" + own;
}

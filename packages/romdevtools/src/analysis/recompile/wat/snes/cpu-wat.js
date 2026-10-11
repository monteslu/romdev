// CPU-side WAT of a recompiled SNES cart: register/flag globals, the memory
// map ($rd8/$wr8 with the LoROM decode, SRAM mirroring, the $4200-$43FF I/O
// block, general-purpose DMA and HDMA), and the RAM interpreter that runs
// code the game builds in WRAM (one LoROM cart builds an OAM-clear
// routine at $7F8000 during reset).
//
// The WAT bodies are carried over byte-for-byte from the earlier Python
// emitter (globals, memory, interpreter and its tables); the
// differential gate compares the whole emitted module against the Python
// emitter's. `lay` is the per-ROM layout from layout.js.
//
// Plain JS ESM + JSDoc.

import {
  WRAM, PPUREG, INPUT, MAPTAB, HDMAST, DPWATCH, DMALOG, DMALOG_N, DMALOG_STRIDE,
} from "./layout.js";
import { ppuGlobalsWat } from "./ppu-wat.js";
import { padAddr } from "../cart-abi.js";
import { SA1_BOARD, SA1_HOOKS } from "./sa1.js";

/**
 * A chip's exceptions to $fast2's block-type rule (coproc.js `wordBus`):
 * bank ranges whose 16-bit reads go byte by byte although the cart keeps
 * them as plain ROM (`readByByte`), and bank ranges of a chip window whose
 * 16-bit writes are one grouped access (`writeGrouped`: snes9x maps them
 * as ROM, so map_WriteProtectROM leaves MAP_NONE on the write side).
 * @param {{readByByte?: number[][], writeGrouped?: number[][]}|null|undefined} wb
 * @returns {string} WAT statements for $fast2 (locals $a, $want)
 */
export function wordBusWat(wb) {
  if (!wb) return "";
  const bank = "(i32.and (i32.shr_u (local.get $a) (i32.const 16)) (i32.const 0xFF))";
  const inRanges = (rs) => rs.map(([b0, b1]) => (b0 === b1
    ? `(i32.eq ${bank} (i32.const 0x${b0.toString(16)}))`
    : `(i32.le_u (i32.sub ${bank} (i32.const 0x${b0.toString(16)})) (i32.const ${b1 - b0}))`))
    .reduce((x, y) => `(i32.or ${x} ${y})`);
  let out = "";
  if (wb.readByByte?.length) out += `\n    (if (i32.and (i32.eq (local.get $want) (i32.const 1)) ${inRanges(wb.readByByte)}) (then (return (i32.const 0))))`;
  if (wb.writeGrouped?.length) out += `\n    (if (i32.and (i32.eq (local.get $want) (i32.const 2)) ${inRanges(wb.writeGrouped)}) (then (return (i32.const 1))))`;
  return out;
}

// emit_snes.py globals_wat() lines 205-297
/** @param {import("./layout.js").SnesLayout} lay */
export function globalsWat(lay) {
  return `
  (global $a (mut i32) (i32.const 0))
  (global $x (mut i32) (i32.const 0))
  (global $y (mut i32) (i32.const 0))
  (global $s (mut i32) (i32.const 0x01FF))
  (global $d (mut i32) (i32.const 0))
  (global $db (mut i32) (i32.const 0))
  (global $db24 (mut i32) (i32.const 0))
  (global $pc (mut i32) (i32.const 0))
  (global $fn (mut i32) (i32.const 0))
  (global $fv (mut i32) (i32.const 0))
  (global $fm (mut i32) (i32.const 1))
  (global $fx (mut i32) (i32.const 1))
  (global $fd (mut i32) (i32.const 0))
  (global $fi (mut i32) (i32.const 1))
  (global $fz (mut i32) (i32.const 0))
  (global $fc (mut i32) (i32.const 0))
  (global $fe (mut i32) (i32.const 1))
  (global $t (mut i32) (i32.const 0))
  (global $t2 (mut i32) (i32.const 0))
  (global $t3 (mut i32) (i32.const 0))
  (global $t4 (mut i32) (i32.const 0))
  (global $trapped (mut i32) (i32.const 0))
  (global $trappc (mut i32) (i32.const 0))
  (global $curpc (mut i32) (i32.const 0))
  (global $cyc (mut i32) (i32.const 0))
  (global $steps (mut i32) (i32.const 0))
  (global $vaddr (mut i32) (i32.const 0))
  (global $cgaddr (mut i32) (i32.const 0))
  (global $cglatch (mut i32) (i32.const 0))
  (global $oamaddr (mut i32) (i32.const 0))
  (global $scrlatch (mut i32) (i32.const 0))
  (global $nmiflag (mut i32) (i32.const 0))
  (global $nmien (mut i32) (i32.const 0))
  (global $ramsrc (mut i32) (i32.const 0))
  (global $lastrom (mut i32) (i32.const 0))
  (global $stkw (mut i32) (i32.const 0))
  (global $npc (mut i32) (i32.const 0))
  (global $ndp (mut i32) (i32.const 0))
  (global $stkwa (mut i32) (i32.const 0))
  ;; CHANGE DETECTOR on the decompressor's output pointer at direct page
  ;; $00-$02. A last-writer watch answers "who wrote this byte", which for
  ;; $00 is the caller at $BA3D setting it CORRECTLY - the corrupting store
  ;; is not the last one, so the watch never names it. What is wanted is the
  ;; FIRST writer that moves the pointer AWAY from the value the caller
  ;; installed, which is a different question and needs the old value.
  (global $ptrw (mut i32) (i32.const 0))   ;; pc of that writer
  (global $ptrwa (mut i32) (i32.const 0))  ;; address it wrote
  (global $ptrwv (mut i32) (i32.const 0))  ;; (new << 8) | old
  (global $ptrwy (mut i32) (i32.const 0))  ;; Y at the time
  (global $ptrarm (mut i32) (i32.const 0)) ;; armed when the pointer is built
  ;; COUNT of pointer changes seen while armed. Without it, \`$ptrw\` reading
  ;; a given pc cannot be told from "armed late and missed the real first
  ;; one": a detector has to be able to report how many times it fired, or
  ;; its single answer is unfalsifiable.
  (global $nptrw (mut i32) (i32.const 0))
  ;; Latched verdict for the FIRST decompression call only.
  (global $ptrw1 (mut i32) (i32.const 0))
  (global $ptrwv1 (mut i32) (i32.const 0))
  (global $ptrwy1 (mut i32) (i32.const 0))
  (global $nptrw1 (mut i32) (i32.const 0))
  (global $ninterp (mut i32) (i32.const 0))
  (global $napuw (mut i32) (i32.const 0))
  ;; The CPU data bus (snes9x OpenBus): the last byte read or written.
  (global $ob (mut i32) (i32.const 0))
  ;; Master clocks per access: $ms for the running code's region (set by
  ;; $step), $fastrom for ROM at $80-$FF ($420D bit 0), $indma while (H)DMA
  ;; moves bytes (it charges its own 8 per byte).
  (global $ms (mut i32) (i32.const 8))
  (global $fastrom (mut i32) (i32.const 8))
  (global $indma (mut i32) (i32.const 0))
  (global $wramdma (mut i32) (i32.const 0))
  (global $t5 (mut i32) (i32.const 0))
  (global $pad0 (mut i32) (i32.const 0))
  (global $pad1 (mut i32) (i32.const 0))
  (global $joylatch (mut i32) (i32.const 0))
  (global $jidx0 (mut i32) (i32.const 0))
  (global $jidx1 (mut i32) (i32.const 0))
  (global $scanline (mut i32) (i32.const 0))
  (global $nvram (mut i32) (i32.const 0))
  (global $npal (mut i32) (i32.const 0))
  (global $ndma (mut i32) (i32.const 0))
  (global $nnmi (mut i32) (i32.const 0))
  (global $nrw (mut i32) (i32.const 0))
  (global $irqline (mut i32) (i32.const 0))
  (global $nmipend (mut i32) (i32.const 0))
  (global $nmipos (mut i32) (i32.const 0))
  ;; A CLI (1), SEI (2) or vblank NMI enable (4) waiting for the next boundary.
  (global $ichg (mut i32) (i32.const 0))
  (global $started (mut i32) (i32.const 0))
  (global $evk (mut i32) (i32.const 0))
  (global $istart (mut i32) (i32.const 0))
  (global $iio (mut i32) (i32.const 0))
  (global $ifl (mut i32) (i32.const 0))
  ;; STP is re-executing (snes9x OpDB: PCw--, no cycles of its own)
  (global $stp (mut i32) (i32.const 0))
  (global $nmiearly (mut i32) (i32.const 0))
  (global $hmax (mut i32) (i32.const 1364))
  (global $refpos (mut i32) (i32.const 538))
  (global $linesrun (mut i32) (i32.const 0))
  (global $bv (mut i32) (i32.const 0))
  (global $bh (mut i32) (i32.const 0))
  (global $wai (mut i32) (i32.const 0))
  (global $hpos (mut i32) (i32.const 0))
  (global $segend (mut i32) (i32.const 0))
  ;; The H/V timer IRQ position (snes9x Timings.NextIRQTimer, $0FFFFFFF = none), the frame-end
  ;; flag, and a general DMA running (with the HDMA channels that ran
  ;; inside it, snes9x CPU.HDMARanInDMA).
  (global $ipos (mut i32) (i32.const 0x0FFFFFFF))
  ;; V_Max (262; 263 on an interlaced even field) and IPPU.Interlace
  (global $vmax (mut i32) (i32.const 262))
  (global $interlace (mut i32) (i32.const 0))
  ;; PPU.ScreenHeight (224, or 239 with $2133 bit 2)
  (global $sh (mut i32) (i32.const 224))
  (global $fdone (mut i32) (i32.const 0))
  (global $ingdma (mut i32) (i32.const 0))
  (global $hdmaran (mut i32) (i32.const 0))
  (global $hdmaon (mut i32) (i32.const 0))
  (global $hdmaended (mut i32) (i32.const 0))
` +
    ppuGlobalsWat(lay);
}

// emit_snes.py mem_wat() lines 318-856
/** @param {import("./layout.js").SnesLayout} lay */
export function memWat(lay) {
  // An SA-1 cart's second 65816 runs the same arms: while it is swapped in
  // ($sacpu) their accesses go to its bus (sa1.js). Other carts: nothing.
  const sa1 = lay.map === SA1_BOARD ? SA1_HOOKS : null;
  return `
  ;; Width helpers. M/X are 1 for 8-bit and 0 for 16-bit, so the mask is
  ;; $FF or $FFFF and the sign bit is 7 or 15.
  (func $wmask (param $f i32) (result i32)
    (if (result i32) (local.get $f) (then (i32.const 0xFF))
                                    (else (i32.const 0xFFFF))))
  (func $wsign (param $f i32) (result i32)
    (if (result i32) (local.get $f) (then (i32.const 7))
                                    (else (i32.const 15))))

  ;; Narrowing X clears the HIGH BYTES of X and Y. Hardware does this, and
  ;; without it an \`sep #$10\` after a 16-bit index load leaves X above $FF
  ;; and the next indexed read lands a bank away.
  (func $narrowx
    (if (global.get $fx) (then
      (global.set $x (i32.and (global.get $x) (i32.const 0xFF)))
      (global.set $y (i32.and (global.get $y) (i32.const 0xFF))))))

  ;; DB is kept twice: as the byte \`plb\`/\`phb\` move, and pre-shifted as the
  ;; base every data access adds. Recomputing the shift per access showed up
  ;; as real time in a 300-arm-per-line inner loop.
  (func $setdb (param $v i32)
    (global.set $db (i32.and (local.get $v) (i32.const 0xFF)))
    (global.set $db24 (i32.shl (global.get $db) (i32.const 16))))

  ;; CPU bus read through the snes9x-style block map (memmap.js): 4096
  ;; blocks of 4KB, each {type, base}. Every read leaves its byte on the
  ;; data bus ($ob, snes9x OpenBus); an unmapped address returns what is
  ;; already there.
  ;; An event inside an instruction: snes9x processes one as soon as an
  ;; access pushes CPU.Cycles past it, so an event the program fetch (or an
  ;; earlier access) crossed has happened before this access.
  (func $refresh_due
    (if (i32.and (i32.and (i32.ne (global.get $evk) (i32.const 0)) (i32.le_s (global.get $cyc) (i32.const 0)))
                 (i32.eqz (global.get $indma)))
      (then (call $ev_process (call $evpos (call $hnow)))
            (call $ev_due))))
  (func $event_after
    (call $ev_due))

  (func $rd8 (param $a i32) (result i32)
    (local $v i32)${sa1 ? "\n    " + sa1.rd8 : ""}
    (call $refresh_due)
    (local.set $v (call $rd8m (local.get $a)))
    (global.set $ob (local.get $v))
    ;; Each CPU access costs its region's speed, added AFTER the access
    ;; (snes9x addCyclesInMemoryAccess); (H)DMA charges its own. An event
    ;; the access carried the clock past fires right after it.
    (if (i32.eqz (global.get $indma))
      (then (global.set $cyc (i32.sub (global.get $cyc) (call $speed (i32.and (local.get $a) (i32.const 0xFFFFFF)))))
            (call $event_after)))
    ;; (an HDMA the event ran leaves its own byte on the bus afterwards)
    (local.get $v))

  (func $rd8m (param $a i32) (result i32)
    (local $e i32) (local $x i32) (local $c i32)${sa1 ? "\n    " + sa1.rd8m : ""}
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $e (i32.add (i32.const ${MAPTAB}) (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 3))))
    (local.set $x (i32.and (local.get $a) (i32.const 0xFFFF)))
    (block $none (block $chip (block $sramhi (block $sramlo (block $cpu (block $ppu (block $direct
      (br_table $none $direct $direct $ppu $cpu $sramlo $sramhi $chip $none (i32.load (local.get $e))))
      ;; ROM / RAM
      (return (i32.load8_u (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $a) (i32.const 0xFFF))))))
      ;; $2000-$3FFF: the B bus. A chip's register here first (coproc.js
      ;; $chip_b_rd: the MSU-1, S-RTC, BS-X ports), then $2100-$21FF, the
      ;; PPU/APU/WRAM-port registers.
      (local.set $c (call $chip_b_rd (local.get $x)))
      (if (i32.ge_s (local.get $c) (i32.const 0)) (then (return (local.get $c))))
      (if (i32.eq (i32.and (local.get $x) (i32.const 0xFF00)) (i32.const 0x2100))
        (then (return (call $ppu_read (i32.and (local.get $x) (i32.const 0xFF))))))
      (return (global.get $ob)))
      ;; $4000-$5FFF: controller ports and the CPU's registers.
      (if (i32.eq (i32.and (local.get $x) (i32.const 0xFFFE)) (i32.const 0x4016))
        (then (return (call $joyser_read (i32.and (local.get $x) (i32.const 1))))))
      (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x4200)) (i32.lt_u (local.get $x) (i32.const 0x4400)))
        (then (return (call $io_read (local.get $x)))))
      ;; the rest of $4000-$5FFF: a coprocessor's registers, else open bus (coproc.js)
      (return (call $chip_io_rd (local.get $x))))
      ;; LoROM SRAM: ((bank >> 1) | offset & $7FFF) & SRAMMask.
      (return (i32.load8_u (i32.add (i32.const ${lay.SRAM})
        (i32.and (i32.or (i32.shr_u (i32.and (local.get $a) (i32.const 0xFF0000)) (i32.const 1))
                         (i32.and (local.get $a) (i32.const 0x7FFF)))
                 (i32.const ${lay.sram}))))))
      ;; HiROM SRAM: (offset - $6000 + (bank & $1F) * $2000) & SRAMMask.
      (return (i32.load8_u (i32.add (i32.const ${lay.SRAM})
        (i32.and (i32.add (i32.sub (i32.and (local.get $a) (i32.const 0x7FFF)) (i32.const 0x6000))
                          (i32.shr_u (i32.and (local.get $a) (i32.const 0x1F0000)) (i32.const 3)))
                 (i32.const ${lay.sram}))))))
      ;; MAP_TYPE.CHIP: a coprocessor's window (coproc.js)
      (return (call $chip_rd (local.get $a))))
    (global.get $ob))

  ;; Is this 16-bit access ONE access of twice the speed, with a single
  ;; event check after both bytes (snes9x addCyclesInMemoryAccess_x2), or
  ;; two byte accesses with an event check after each? snes9x S9xGetWord /
  ;; S9xSetWord decide it by the block's map type, and it matters: a line
  ;; end that falls between the two bytes is processed 8 clocks later in
  ;; the grouped form, and the APU catches up to that position. A word that
  ;; straddles a 4KB block, and (H)DMA, always go byte by byte. Otherwise
  ;; the I/O handlers go byte by byte (MAP_CPU, MAP_PPU and every chip
  ;; window: DSP, C4, OBC1, Seta, BS-X, SPC7110 data), and everything else
  ;; is grouped: plain memory, the SRAM windows (MAP_LOROM_SRAM,
  ;; MAP_LOROM_SRAM_B, MAP_HIROM_SRAM, MAP_BWRAM) and MAP_NONE, which is
  ;; also what a write to write-protected ROM sees (map_WriteProtectROM).
  ;; $want is 1 for a read, 2 for a write. A chip whose snes9x map types do
  ;; not follow its cart block types says so (lay.wordBus, coproc.js).
  (func $fast2 (param $a i32) (param $want i32) (result i32)
    (local $t i32)${sa1 ? "\n    " + sa1.fast2 : ""}
    (if (i32.eq (i32.and (local.get $a) (i32.const 0xFFF)) (i32.const 0xFFF)) (then (return (i32.const 0))))
    (if (global.get $indma) (then (return (i32.const 0))))${wordBusWat(lay.wordBus)}
    (local.set $t (i32.load (i32.add (i32.const ${MAPTAB})
      (i32.shl (i32.shr_u (i32.and (local.get $a) (i32.const 0xFFFFFF)) (i32.const 12)) (i32.const 3)))))
    ;; MAP_TYPE PPU 3, CPU 4, CHIP 7 (memmap.js)
    (i32.eqz (i32.or (i32.or (i32.eq (local.get $t) (i32.const 3)) (i32.eq (local.get $t) (i32.const 4)))
                     (i32.eq (local.get $t) (i32.const 7)))))

  (func $rd16 (param $a i32) (result i32)
    (local $v i32)
    (if (call $fast2 (local.get $a) (i32.const 1))
      (then
        (call $refresh_due)
        (local.set $v (i32.or (call $rd8m (local.get $a))
                              (i32.shl (call $rd8m (i32.add (local.get $a) (i32.const 1))) (i32.const 8))))
        (global.set $ob (i32.shr_u (local.get $v) (i32.const 8)))
        (global.set $cyc (i32.sub (global.get $cyc) (i32.shl (call $speed (i32.and (local.get $a) (i32.const 0xFFFFFF))) (i32.const 1))))
        (call $event_after)
        (return (local.get $v))))
    (i32.or (call $rd8 (local.get $a))
            (i32.shl (call $rd8 (i32.add (local.get $a) (i32.const 1)))
                     (i32.const 8))))

  ;; One-byte push / pull: PushB / PullB, or in emulation mode PushBE /
  ;; PullBE (S stays in page 1).
  (func $push8 (param $v i32)
    (call $wr8 (global.get $s) (i32.and (local.get $v) (i32.const 0xFF)))
    (global.set $s (if (result i32) (global.get $fe)
      (then (i32.or (i32.and (global.get $s) (i32.const 0xFF00)) (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF))))
      (else (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF))))))
  (func $pull8 (result i32)
    (global.set $s (if (result i32) (global.get $fe)
      (then (i32.or (i32.and (global.get $s) (i32.const 0xFF00)) (i32.and (i32.add (global.get $s) (i32.const 1)) (i32.const 0xFF))))
      (else (i32.and (i32.add (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))))
    (call $rd8 (global.get $s)))
  ;; PushWE: SL--, S9xSetWord(w, S, WRAP_PAGE, WRITE_10), SL--.
  (func $push16e (param $v i32)
    (local $a i32)
    (local.set $a (i32.or (i32.and (global.get $s) (i32.const 0xFF00)) (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF))))
    (if (i32.eq (i32.and (local.get $a) (i32.const 0xFF)) (i32.const 0xFF))
      (then (call $wr8 (i32.and (local.get $a) (i32.const 0xFF00)) (i32.shr_u (local.get $v) (i32.const 8)))
            (call $wr8 (local.get $a) (i32.and (local.get $v) (i32.const 0xFF))))
      (else (if (call $fast2 (local.get $a) (i32.const 2))
        (then (call $wr16fast (local.get $a) (local.get $v)))
        (else (call $wr8 (i32.add (local.get $a) (i32.const 1)) (i32.shr_u (local.get $v) (i32.const 8)))
              (call $wr8 (local.get $a) (i32.and (local.get $v) (i32.const 0xFF)))))))
    (global.set $s (i32.or (i32.and (local.get $a) (i32.const 0xFF00)) (i32.and (i32.sub (local.get $a) (i32.const 1)) (i32.const 0xFF)))))
  ;; PullWE: SL++, S9xGetWord(S, WRAP_PAGE), SL++.
  (func $pull16e (result i32)
    (local $a i32) (local $v i32)
    (local.set $a (i32.or (i32.and (global.get $s) (i32.const 0xFF00)) (i32.and (i32.add (global.get $s) (i32.const 1)) (i32.const 0xFF))))
    (if (i32.eq (i32.and (local.get $a) (i32.const 0xFF)) (i32.const 0xFF))
      (then (local.set $v (call $rd8 (local.get $a)))
            (local.set $v (i32.or (local.get $v) (i32.shl (call $rd8 (i32.and (local.get $a) (i32.const 0xFF00))) (i32.const 8)))))
      (else (local.set $v (call $rd16 (local.get $a)))))
    (global.set $s (i32.or (i32.and (local.get $a) (i32.const 0xFF00)) (i32.and (i32.add (local.get $a) (i32.const 1)) (i32.const 0xFF))))
    (local.get $v))

  ;; snes9x PushW: S9xSetWord(w, S - 1, WRAP_BANK, WRITE_10), S -= 2.
  (func $push16 (param $v i32)
    (local $a i32)
    (local.set $a (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))
    (if (call $fast2 (local.get $a) (i32.const 2))
      (then (call $wr16fast (local.get $a) (local.get $v)))
      (else (call $wr8 (global.get $s) (i32.shr_u (local.get $v) (i32.const 8)))
            (call $wr8 (local.get $a) (i32.and (local.get $v) (i32.const 0xFF)))))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 2)) (i32.const 0xFFFF))))
  ;; snes9x PullW: S9xGetWord(S + 1, WRAP_BANK), S += 2.
  (func $pull16 (result i32)
    (local $a i32) (local $v i32)
    (local.set $a (i32.and (i32.add (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))
    (if (call $fast2 (local.get $a) (i32.const 1))
      (then (local.set $v (call $rd16 (local.get $a))))
      (else (local.set $v (i32.or (call $rd8 (local.get $a))
              (i32.shl (call $rd8 (i32.and (i32.add (local.get $a) (i32.const 1)) (i32.const 0xFFFF))) (i32.const 8))))))
    (global.set $s (i32.and (i32.add (global.get $s) (i32.const 2)) (i32.const 0xFFFF)))
    (local.get $v))

  (func $wr16fast (param $a i32) (param $v i32)
    (call $refresh_due)
    (call $wr8m (local.get $a) (local.get $v))
    (call $wr8m (i32.add (local.get $a) (i32.const 1)) (i32.shr_u (local.get $v) (i32.const 8)))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.shl (call $speed (i32.and (local.get $a) (i32.const 0xFFFFFF))) (i32.const 1))))
    (call $event_after))

  (func $rd24 (param $a i32) (result i32)
    (i32.or (call $rd16 (local.get $a))
            (i32.shl (call $rd8 (i32.add (local.get $a) (i32.const 2)))
                     (i32.const 16))))

  ;; Width-dispatched access. \`$f\` is the M or X flag: 1 = 8-bit.
  (func $rdw (param $a i32) (param $f i32) (result i32)
    (if (result i32) (local.get $f)
      (then (call $rd8 (local.get $a)))
      (else (call $rd16 (local.get $a)))))

  (func $wrw (param $a i32) (param $v i32) (param $f i32)
    (if (i32.and (i32.eqz (local.get $f)) (call $fast2 (local.get $a) (i32.const 2)))
      (then (call $wr16fast (local.get $a) (local.get $v)) (return)))
    (if (local.get $f)
      (then (call $wr8 (local.get $a) (local.get $v)))
      (else (call $wr8 (local.get $a) (local.get $v))
            (call $wr8 (i32.add (local.get $a) (i32.const 1))
                       (i32.shr_u (local.get $v) (i32.const 8))))))

  ;; A 16-bit read-modify-write stores the HIGH byte first (snes9x
  ;; S9xSetWord ... WRITE_10), then the low byte, which stays on the bus.
  (func $wrw10 (param $a i32) (param $v i32) (param $f i32)
    (if (i32.and (i32.eqz (local.get $f)) (call $fast2 (local.get $a) (i32.const 2)))
      (then (call $wr16fast (local.get $a) (local.get $v)) (return)))
    (if (local.get $f)
      (then (call $wr8 (local.get $a) (local.get $v)))
      (else (call $wr8 (i32.add (local.get $a) (i32.const 1))
                       (i32.shr_u (local.get $v) (i32.const 8)))
            (call $wr8 (local.get $a) (local.get $v)))))

  ;; snes9x memory_speed(): master clocks for one access at $a. ROM in
  ;; banks $80-$FF is FastROM ($ms6 = 6 when $420D bit 0 is set, else 8).
  (func $speed (param $a i32) (result i32)
    (if (i32.and (local.get $a) (i32.const 0x408000))
      (then (return (if (result i32) (i32.and (local.get $a) (i32.const 0x800000))
                      (then (global.get $fastrom)) (else (i32.const 8))))))
    (if (i32.and (i32.add (local.get $a) (i32.const 0x6000)) (i32.const 0x4000))
      (then (return (i32.const 8))))
    (if (i32.and (i32.sub (local.get $a) (i32.const 0x4000)) (i32.const 0x7E00))
      (then (return (i32.const 6))))
    (i32.const 12))

  (func $wr8 (param $a i32) (param $v i32)${sa1 ? "\n    " + sa1.wr8 : ""}
    (call $refresh_due)
    (call $wr8m (local.get $a) (local.get $v))
    ;; The access costs its region's speed, after the write (snes9x).
    (if (i32.eqz (global.get $indma))
      (then (global.set $cyc (i32.sub (global.get $cyc) (call $speed (i32.and (local.get $a) (i32.const 0xFFFFFF)))))
            (call $event_after))))

  (func $wr8m (param $a i32) (param $v i32)
    (local $bank i32) (local $x i32) (local $e i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (local.set $bank (i32.shr_u (local.get $a) (i32.const 16)))
    (local.set $x (i32.and (local.get $a) (i32.const 0xFFFF)))
    ;; DIRECT-PAGE WATCH, placed BEFORE the bank $7E/$7F fast path.
    ;;
    ;; $0E is reachable two ways that land on the SAME byte: as $00000E
    ;; through the bank $00-$3F low-RAM mirror, and as $7E000E directly.
    ;; The watch used to sit only on the mirror path, below the early
    ;; \`return\` for banks $7E/$7F - so a $7E-bank write was invisible to it.
    ;; That blind spot produced a flat contradiction that looked like a CPU
    ;; bug: the watch reported $0E's last write as $31 by \`inc $0E\`, while
    ;; memory held $30, for every watched byte off by exactly one. The
    ;; missing writer was never going to appear until the watch covered both
    ;; spellings of the address.
    (if (i32.and (i32.lt_u (local.get $x) (i32.const 0x20))
                 (i32.or (i32.eq (local.get $bank) (i32.const 0x7E))
                         (i32.le_u (i32.and (local.get $bank)
                                            (i32.const 0x7F))
                                   (i32.const 0x3F))))
      (then
        (i32.store (i32.add (i32.const ${DPWATCH})
          (i32.mul (local.get $x) (i32.const 8))) (global.get $curpc))
        (i32.store (i32.add (i32.add (i32.const ${DPWATCH})
          (i32.mul (local.get $x) (i32.const 8))) (i32.const 4))
          (i32.or (local.get $v) (i32.shl (local.get $bank) (i32.const 8))))
        (global.set $ndp (i32.add (global.get $ndp) (i32.const 1)))
        ;; First writer that CHANGES $00/$01/$02 once the pointer is ALREADY
        ;; the value the caller installed. Comparing against memory alone
        ;; would trip on $BA3B-$BA45 building the pointer in the first
        ;; place; the \`$ptrarm\` term waits until it is fully built, so what
        ;; is caught is a writer that tears down a good pointer.
        (if (i32.and (i32.lt_u (local.get $x) (i32.const 3))
                     (i32.and (global.get $ptrarm)
                              (i32.ne (local.get $v)
                                (i32.load8_u (i32.add
                                  (i32.const ${WRAM})
                                  (local.get $x))))))
          (then (global.set $nptrw
                  (i32.add (global.get $nptrw) (i32.const 1)))))
        (if (i32.and (i32.lt_u (local.get $x) (i32.const 3))
                     (i32.and (i32.and (i32.ne (global.get $ptrarm) (i32.const 0))
                                       (i32.eqz (global.get $ptrw)))
                              (i32.ne (local.get $v)
                                (i32.load8_u (i32.add
                                  (i32.const ${WRAM})
                                  (local.get $x))))))
          (then (global.set $ptrw (global.get $curpc))
                (global.set $ptrwa (local.get $x))
                (global.set $ptrwv (i32.or (i32.shl (local.get $v)
                                                    (i32.const 8))
                  (i32.load8_u (i32.add (i32.const ${WRAM})
                                        (local.get $x)))))
                (global.set $ptrwy (global.get $y))))
        ;; ARM ONCE, on the FIRST time the fully-built pointer appears, and
        ;; never again. Re-arming on every decompression call meant the
        ;; detector recorded a LATE teardown (the caller at $BA3D writing
        ;; over an already-corrupt $AB) instead of the first one. The first
        ;; corruption is the only one that is not itself a consequence.
        ;; Re-arm at the START of every decompression call, but LATCH the
        ;; first call's verdict separately. The pointer is rebuilt for each
        ;; call, so a detector that arms once reports whichever call happened
        ;; to be last; the first call is the only one not already running on
        ;; corrupted state.
        (if (i32.and (i32.eq (local.get $x) (i32.const 2))
                     (i32.eq (local.get $v) (i32.const 0x7E)))
          (then
            (if (i32.and (global.get $ptrarm) (i32.eqz (global.get $ptrw1)))
              (then (global.set $ptrw1 (i32.or (global.get $ptrw)
                                                (i32.const 0x1000000)))
                    (global.set $ptrwv1 (global.get $ptrwv))
                    (global.set $ptrwy1 (global.get $ptrwy))
                    (global.set $nptrw1 (global.get $nptrw))))
            (global.set $ptrarm (i32.const 1))
            (global.set $ptrw (i32.const 0))
            (global.set $nptrw (i32.const 0))))))
    ;; The written byte is what the data bus holds afterwards (snes9x
    ;; STA8 / STA16 leave OpenBus = the last byte stored).
    (global.set $ob (local.get $v))
    ;; WATCH THE STACK PAGE. A \`jsl\` frame that is correct at frame
    ;; 10 is gone by frame 25, so something writes $01F0-$01FF that
    ;; is not a push. Record the FIRST such writer that is not the
    ;; stack pointer itself.
    (if (i32.and (i32.le_u (i32.and (local.get $bank) (i32.const 0x7F)) (i32.const 0x3F))
                 (i32.and (i32.and (i32.ge_u (local.get $x) (i32.const 0x01F0))
                                   (i32.le_u (local.get $x) (i32.const 0x01FF)))
                          (i32.and (i32.eqz (global.get $stkw))
                                   (i32.ne (local.get $x) (global.get $s)))))
      (then (global.set $stkw (global.get $curpc))
            (global.set $stkwa (local.get $x))))
    (local.set $e (i32.add (i32.const ${MAPTAB}) (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 3))))
    (block $none (block $chip (block $sramhi (block $sramlo (block $cpu (block $ppu (block $ram
      (br_table $none $none $ram $ppu $cpu $sramlo $sramhi $chip $none (i32.load (local.get $e))))
      (i32.store8 (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $a) (i32.const 0xFFF))) (local.get $v))
      (return))
      ;; a chip's register on the B bus first (coproc.js $chip_b_wr)
      (if (call $chip_b_wr (local.get $x) (local.get $v)) (then (return)))
      (if (i32.eq (i32.and (local.get $x) (i32.const 0xFF00)) (i32.const 0x2100))
        (then (call $ppu_write (i32.and (local.get $x) (i32.const 0xFF)) (local.get $v))))
      (return))
      ;; $4016 bit 0 is the controller latch; $4017 writes do nothing.
      (if (i32.eq (local.get $x) (i32.const 0x4016))
        (then (call $joy_latch (i32.and (local.get $v) (i32.const 1))) (return)))
      (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x4200)) (i32.lt_u (local.get $x) (i32.const 0x4400)))
        (then (call $io_write (local.get $x) (local.get $v)) (return)))
      ;; the rest of $4000-$5FFF: a coprocessor's registers (coproc.js)
      (call $chip_io_wr (local.get $x) (local.get $v))
      (return))
      ;; SRAM writes need an SRAM (snes9x: if (Memory.SRAMMask)).
      ${lay.sram ? "" : ";; this cart has no SRAM: writes are dropped\n      (return)"}
      (i32.store8 (i32.add (i32.const ${lay.SRAM})
        (i32.and (i32.or (i32.shr_u (i32.and (local.get $a) (i32.const 0xFF0000)) (i32.const 1))
                         (i32.and (local.get $a) (i32.const 0x7FFF)))
                 (i32.const ${lay.sram}))) (local.get $v))
      (return))
      ${lay.sram ? "" : "(return)"}
      (i32.store8 (i32.add (i32.const ${lay.SRAM})
        (i32.and (i32.add (i32.sub (i32.and (local.get $a) (i32.const 0x7FFF)) (i32.const 0x6000))
                          (i32.shr_u (i32.and (local.get $a) (i32.const 0x1F0000)) (i32.const 3)))
                 (i32.const ${lay.sram}))) (local.get $v))
      (return))
      ;; MAP_TYPE.CHIP: a coprocessor's window (coproc.js)
      (call $chip_wr (local.get $a) (local.get $v))))

  ;; $4200-$43FF: interrupt enables, the multiply/divide unit, IRQ timers,
  ;; DMA and HDMA. The shadow at PPUREG+0x80 holds every written value, and
  ;; the result registers ($4214-$4217) are written INTO it by the unit so a
  ;; plain shadow read returns them.
  (func $io_write (param $r i32) (param $v i32)
    (local $p i32) (local $q i32) (local $old i32)
    (local.set $old (call $io_reg (local.get $r)))
    (i32.store8 (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF))) (local.get $v))
    ;; HTIME / VTIME: a changed value moves the timer (S9xUpdateIRQPositions).
    (if (i32.and (i32.ge_u (local.get $r) (i32.const 0x4207)) (i32.le_u (local.get $r) (i32.const 0x420A)))
      (then (if (i32.ne (local.get $v) (local.get $old))
              (then (call $irq_update (i32.ge_u (local.get $r) (i32.const 0x4209)))))
            (return)))
    (if (i32.eq (local.get $r) (i32.const 0x4200))
      (then
        (if (i32.eq (local.get $v) (local.get $old)) (then (return)))
        ;; Enabling NMI while the vblank flag is already set fires it.
        (if (i32.and (i32.and (i32.eqz (global.get $nmien))
                              (i32.ne (i32.and (local.get $v) (i32.const 0x80))
                                      (i32.const 0)))
                     (i32.and (i32.ne (global.get $nmiflag) (i32.const 0))
                              (i32.gt_u (global.get $scanline) (global.get $sh))))
          ;; snes9x sets Timings.IRQFlagChanging |= IRQ_TRIGGER_NMI: the NMI
          ;; becomes pending at the next boundary ($apply_ichg), so one more
          ;; instruction runs before it is taken.
          (then (global.set $ichg (i32.or (global.get $ichg) (i32.const 4)))))
        (global.set $nmien (i32.and (local.get $v) (i32.const 0x80)))
        (if (i32.eqz (i32.and (local.get $v) (i32.const 0x30)))
          (then (global.set $irqline (i32.const 0))))
        ;; "Only allow instantaneous IRQ if turning it completely on or off"
        (if (i32.ne (i32.and (local.get $v) (i32.const 0x30)) (i32.and (local.get $old) (i32.const 0x30)))
          (then (call $irq_update (i32.or (i32.eqz (i32.and (local.get $v) (i32.const 0x30)))
                                          (i32.eqz (i32.and (local.get $old) (i32.const 0x30)))))))
        (return)))
    ;; $4203 WRMPYB: unsigned 8x8 product into $4216/$4217.
    (if (i32.eq (local.get $r) (i32.const 0x4203))
      (then
        (local.set $p (i32.mul (call $io_reg (i32.const 0x4202)) (local.get $v)))
        (i32.store16 (i32.const ${PPUREG + 0x80 + 0x16}) (local.get $p))
        (return)))
    ;; $4206 WRDIVB: 16/8 divide. Quotient $4214/5, remainder $4216/7.
    ;; Divide by zero gives $FFFF and the dividend, as on hardware.
    (if (i32.eq (local.get $r) (i32.const 0x4206))
      (then
        (local.set $p (i32.load16_u (i32.const ${PPUREG + 0x80 + 0x04})))
        (if (i32.eqz (local.get $v))
          (then (i32.store16 (i32.const ${PPUREG + 0x80 + 0x14}) (i32.const 0xFFFF))
                (i32.store16 (i32.const ${PPUREG + 0x80 + 0x16}) (local.get $p)))
          (else (i32.store16 (i32.const ${PPUREG + 0x80 + 0x14})
                  (i32.div_u (local.get $p) (local.get $v)))
                (i32.store16 (i32.const ${PPUREG + 0x80 + 0x16})
                  (i32.rem_u (local.get $p) (local.get $v)))))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 0x420B))
      (then (call $dma_run (local.get $v)) (return)))
    ;; $4201 WRIO: bit 7 falling (while RDIO bit 7 is set) latches the H/V
    ;; counters; RDIO ($4213) reads back what was written.
    (if (i32.eq (local.get $r) (i32.const 0x4201))
      (then (if (i32.and (i32.eqz (i32.and (local.get $v) (i32.const 0x80)))
                         (i32.ne (i32.and (call $io_reg (i32.const 0x4213)) (i32.const 0x80)) (i32.const 0)))
              (then (call $latch_hv)))
            (call $io_set8 (i32.const 0x4213) (local.get $v))
            (return)))
    ;; $420D MEMSEL: FastROM speed for banks $80-$FF.
    (if (i32.eq (local.get $r) (i32.const 0x420D))
      (then (global.set $fastrom (if (result i32) (i32.and (local.get $v) (i32.const 1)) (then (i32.const 6)) (else (i32.const 8))))
            (return)))
    ;; $43xB and $43xF are one register.
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xFF8F)) (i32.const 0x430F))
      (then (call $io_set8 (i32.sub (local.get $r) (i32.const 4)) (local.get $v))))
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xFF8F)) (i32.const 0x430B))
      (then (call $io_set8 (i32.add (local.get $r) (i32.const 4)) (local.get $v))))
    ;; $420C HDMAEN takes effect at once: channels switch on or off
    ;; mid-frame, and a channel whose table already ended stays off
    ;; (snes9x PPU.HDMA = Byte & ~PPU.HDMAEnded).
    (if (i32.eq (local.get $r) (i32.const 0x420C))
      (then (global.set $hdmaon (i32.and (local.get $v)
              (i32.xor (global.get $hdmaended) (i32.const -1)))) (return)))
    ;; $43xA NLTRx sets the HDMA line counter and repeat flag.
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xFF8F)) (i32.const 0x430A))
      (then
        (local.set $p (i32.add (i32.const ${HDMAST})
          (i32.and (local.get $r) (i32.const 0x70))))
        (if (i32.and (local.get $v) (i32.const 0x7F))
          (then (i32.store8 offset=4 (local.get $p) (i32.and (local.get $v) (i32.const 0x7F)))
                (i32.store8 offset=5 (local.get $p) (i32.eqz (i32.and (local.get $v) (i32.const 0x80)))))
          (else (i32.store8 offset=4 (local.get $p) (i32.const 128))
                (i32.store8 offset=5 (local.get $p) (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)))))
        (return))))

  (func $io_read (param $r i32) (result i32)
    (local $v i32)
    ;; $43xA NLTRx reads the live line counter, bit 7 = NOT repeat.
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xFF8F)) (i32.const 0x430A))
      (then (local.set $v (i32.add (i32.const ${HDMAST}) (i32.and (local.get $r) (i32.const 0x70))))
            (return (i32.xor (i32.load8_u offset=4 (local.get $v))
              (if (result i32) (i32.load8_u offset=5 (local.get $v)) (then (i32.const 0)) (else (i32.const 0x80)))))))
    ;; $4210 RDNMI: bit 7 is the NMI flag, and READING IT CLEARS the flag.
    (if (i32.eq (local.get $r) (i32.const 0x4210))
      (then
            ;; A read that lands past the end of line 224 sees line 225's
            ;; flag (snes9x sets it inside the access); remember that it was
            ;; read so the line-225 start does not set it again.
            (call $beam)
            (if (i32.and (i32.eq (global.get $scanline) (global.get $sh)) (i32.eq (global.get $bv) (i32.add (global.get $sh) (i32.const 1))))
              (then (global.set $nmiflag (i32.const 0x80)) (global.set $nmiearly (i32.const 1))))
            (global.set $t4 (i32.or (i32.or (i32.const 2) (global.get $nmiflag))
                                    (i32.and (global.get $ob) (i32.const 0x70))))
            (global.set $nmiflag (i32.const 0))
            (return (global.get $t4))))
    ;; $4211 TIMEUP: bit 7 set when the H/V IRQ fired; reading acknowledges.
    (if (i32.eq (local.get $r) (i32.const 0x4211))
      (then (local.set $v (i32.or (i32.shl (global.get $irqline) (i32.const 7))
                                  (i32.and (global.get $ob) (i32.const 0x7F))))
            (global.set $irqline (i32.const 0))
            (return (local.get $v))))
    ;; $4212 HVBJOY (snes9x REGISTER_4212).
    (if (i32.eq (local.get $r) (i32.const 0x4212))
      (then
        (local.set $v (i32.const 0))
        (call $beam)
        (if (i32.and (i32.gt_u (global.get $bv) (global.get $sh))
                     (i32.lt_u (global.get $bv) (i32.add (global.get $sh) (i32.const 4))))
          (then (local.set $v (i32.const 1))))
        (if (i32.or (i32.ge_s (global.get $bh) (i32.const 1096))
                    (i32.lt_s (global.get $bh) (i32.const 4)))
          (then (local.set $v (i32.or (local.get $v) (i32.const 0x40)))))
        (if (i32.gt_u (global.get $bv) (global.get $sh))
          (then (local.set $v (i32.or (local.get $v) (i32.const 0x80)))))
        (return (i32.or (local.get $v) (i32.and (global.get $ob) (i32.const 0x3E))))))
    ;; snes9x S9xGetCPU: $4213-$421F and the DMA channel registers
    ;; $43x0-$43xB/$43xF read back; everything else in $4200-$43FF
    ;; (the write-only $4200-$420F, $4220-$42FF, $43xC-$43xE, $4380+) is
    ;; open bus. $43xF mirrors $43xB.
    (if (i32.and (i32.ge_u (local.get $r) (i32.const 0x4213)) (i32.le_u (local.get $r) (i32.const 0x421F)))
      (then (return (call $io_reg (local.get $r)))))
    (if (i32.and (i32.ge_u (local.get $r) (i32.const 0x4300)) (i32.lt_u (local.get $r) (i32.const 0x4380)))
      (then
        (local.set $v (i32.and (local.get $r) (i32.const 0xF)))
        (if (i32.le_u (local.get $v) (i32.const 0xB)) (then (return (call $io_reg (local.get $r)))))
        (if (i32.eq (local.get $v) (i32.const 0xF)) (then (return (call $io_reg (i32.sub (local.get $r) (i32.const 4))))))))
    (global.get $ob))

  ;; Position inside the current line in master clocks (1364 per line).
  (func $hnow (result i32)
    (i32.sub (global.get $segend) (global.get $cyc)))

  ;; The beam where this access happens: an instruction that started before
  ;; the end of a line can make its access after it, and snes9x processes
  ;; the line change inside the access (addCyclesInMemoryAccess), so a
  ;; position past 1364 is the next line. Sets $bv (line) and $bh (clock).
  (func $beam
    (global.set $bh (call $hnow))
    (global.set $bv (global.get $scanline))
    (if (i32.ge_s (global.get $bh) (global.get $hmax))
      (then (global.set $bh (i32.sub (global.get $bh) (global.get $hmax)))
            (global.set $bv (i32.add (global.get $bv) (i32.const 1)))
            (if (i32.ge_u (global.get $bv) (global.get $vmax)) (then (global.set $bv (i32.const 0)))))))

  ;; ---- Controllers (snes9x controls.cpp) ----------------------------------
  ;; Two joypads. $pad0/$pad1 hold snes9x's joypad[].buttons word (B Y Sel
  ;; Start Up Down Left Right in bits 15-8, A X L R in bits 7-4), sampled
  ;; from the wasmcart pads at the start of every frame the way libretro's
  ;; retro_run reports buttons before emulating. The pads are POSITIONAL:
  ;; wasmcart A (south) is SNES B, B (east) is SNES A, X (west) is SNES Y,
  ;; Y (north) is SNES X. Up+Down and Left+Right are filtered as snes9x does
  ;; with UpAndDown off (the later-reported Down / Right wins).
  (func $pad_word (param $b i32) (result i32)
    (local $j i32)
    ${[[0, 15], [1, 7], [2, 14], [3, 6], [4, 5], [5, 4], [6, 12], [7, 13], [8, 11], [9, 10], [10, 9], [11, 8]]
      .map(([w, sn]) => `(if (i32.and (local.get $b) (i32.const ${1 << w})) (then (local.set $j (i32.or (local.get $j) (i32.const ${1 << sn})))))`).join("\n    ")}
    (if (i32.and (local.get $j) (i32.const 0x400)) (then (local.set $j (i32.and (local.get $j) (i32.const 0xF7FF)))))
    (if (i32.and (local.get $j) (i32.const 0x100)) (then (local.set $j (i32.and (local.get $j) (i32.const 0xFDFF)))))
    (local.get $j))
  (func $pads_sample
    (global.set $pad0 (call $pad_word (i32.load16_u (i32.const ${padAddr(INPUT, 0)}))))
    (global.set $pad1 (call $pad_word (i32.load16_u (i32.const ${padAddr(INPUT, 1)})))))
  ;; S9xSetJoypadLatch: raising the latch rewinds both shift positions.
  (func $joy_latch (param $l i32)
    (if (i32.and (local.get $l) (i32.eqz (global.get $joylatch)))
      (then (global.set $jidx0 (i32.const 0)) (global.set $jidx1 (i32.const 0))))
    (global.set $joylatch (local.get $l)))
  ;; S9xReadJOYSERn for a joypad on port $n. Bits 7-2 are open bus, plus
  ;; $1C on $4017.
  (func $joyser_read (param $n i32) (result i32)
    (local $bits i32) (local $b i32) (local $i i32)
    (local.set $bits (i32.or (i32.and (global.get $ob) (i32.const 0xFC))
      (if (result i32) (local.get $n) (then (i32.const 0x1C)) (else (i32.const 0)))))
    (local.set $b (if (result i32) (local.get $n) (then (global.get $pad1)) (else (global.get $pad0))))
    (if (global.get $joylatch)
      (then (return (i32.or (local.get $bits) (i32.shr_u (local.get $b) (i32.const 15))))))
    (local.set $i (if (result i32) (local.get $n) (then (global.get $jidx1)) (else (global.get $jidx0))))
    (if (local.get $n) (then (global.set $jidx1 (i32.add (local.get $i) (i32.const 1))))
                       (else (global.set $jidx0 (i32.add (local.get $i) (i32.const 1)))))
    (if (i32.ge_u (local.get $i) (i32.const 16)) (then (return (i32.or (local.get $bits) (i32.const 1)))))
    (i32.or (local.get $bits) (i32.and (i32.shr_u (local.get $b) (i32.sub (i32.const 15) (local.get $i))) (i32.const 1))))
  ;; S9xDoAutoJoypad: latch pulse, then JOY1/JOY2 = the pads, JOY3/JOY4 = 0,
  ;; and the serial ports read past the end (all 1s) afterwards.
  (func $auto_joypad
    (call $joy_latch (i32.const 1))
    (call $joy_latch (i32.const 0))
    (i32.store16 (i32.const ${PPUREG + 0x80 + 0x18}) (global.get $pad0))
    (i32.store16 (i32.const ${PPUREG + 0x80 + 0x1A}) (global.get $pad1))
    (i32.store16 (i32.const ${PPUREG + 0x80 + 0x1C}) (i32.const 0))
    (i32.store16 (i32.const ${PPUREG + 0x80 + 0x1E}) (i32.const 0))
    (global.set $jidx0 (i32.const 16))
    (global.set $jidx1 (i32.const 16)))

  ;; The B-bus offset each transfer mode cycles through, 2 bits per step,
  ;; four steps per mode (modes 0-7): 0 | 01 | 00 | 0011 | 0123 | 0101 | 00 | 0011
  (func $dmaoff (param $mode i32) (param $k i32) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (i64.const 0x500044E450004400)
      (i64.extend_i32_u (i32.add (i32.shl (local.get $mode) (i32.const 3))
                                 (i32.shl (i32.and (local.get $k) (i32.const 3))
                                          (i32.const 1)))))
      (i64.const 3))))

  ;; GENERAL-PURPOSE DMA. $420B is a bitmask of channels to run.
  (func $dma_run (param $mask i32)
    (local $ch i32) (local $base i32) (local $mode i32) (local $bport i32)
    (local $src i32) (local $cnt i32) (local $i i32) (local $step i32)
    (local $dir i32) (local $k i32) (local $p i32) (local $abort i32)
    ;; Timings.DMACPUSync, once per $420B write that starts a channel.
    (if (i32.and (local.get $mask) (i32.const 0xFF))
      (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const ${lay.fixes?.dmaCpuSync ?? 18})))))
    (local.set $ch (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $ch) (i32.const 8)))
      (if (i32.and (local.get $mask) (i32.shl (i32.const 1) (local.get $ch)))
        (then
          (local.set $base (i32.add (i32.const 0x4300)
                                    (i32.shl (local.get $ch) (i32.const 4))))
          (local.set $p (call $io_reg (local.get $base)))
          (local.set $mode (i32.and (local.get $p) (i32.const 7)))
          (local.set $dir (i32.and (local.get $p) (i32.const 0x80)))
          (local.set $bport (call $io_reg (i32.add (local.get $base) (i32.const 1))))
          (local.set $src (i32.or
            (call $io_reg (i32.add (local.get $base) (i32.const 2)))
            (i32.or
              (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 3)))
                       (i32.const 8))
              (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 4)))
                       (i32.const 16)))))
          (local.set $cnt (i32.or
            (call $io_reg (i32.add (local.get $base) (i32.const 5)))
            (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 6)))
                     (i32.const 8))))
          (if (i32.eqz (local.get $cnt))
            (then (local.set $cnt (i32.const 0x10000))))
          ;; $43x0 bit 3 = fixed address, bit 4 = decrement (bit 3 wins).
          (local.set $step (i32.const 1))
          (if (i32.and (local.get $p) (i32.const 0x08))
            (then (local.set $step (i32.const 0)))
            (else (if (i32.and (local.get $p) (i32.const 0x10))
              (then (local.set $step (i32.const -1))))))
          (local.set $i (i32.const 0))
          (local.set $k (i32.const 0))
          ;; A coprocessor that feeds the transfer (S9xDoDMA's "custom chip
          ;; DMA", coproc.js): the bytes come from the chip's buffer and the
          ;; A address walks the way the chip sets it.
          (global.set $cdma (call $chip_dma (local.get $ch) (local.get $p) (local.get $src) (local.get $cnt)))
          (if (global.get $cdma)
            (then (local.set $src (global.get $cdma_src)) (local.set $step (global.get $cdma_step))))
          ;; snes9x S9xDoDMA: 8 master clocks per channel before its bytes.
          (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))
          (global.set $indma (i32.const 1))
          (global.set $ingdma (i32.const 1))
          (block $td (loop $tl
            (br_if $td (i32.ge_u (local.get $i) (local.get $cnt)))
            ;; snes9x CPU.InWRAMDMAorHDMA: a WRAM A-bus address cannot also
            ;; reach the WRAM port ($2180 writes dropped, reads open bus,
            ;; $2181-$2183 unchanged). CPU -> PPU: set per 4KB block of the
            ;; A address (bank $7E/$7F, or banks $00-$3F with the address
            ;; below $2000). PPU -> CPU: bank $7E/$7F, except to $217C-$2183
            ;; from banks $00-$3F, where each byte tests the address.
            (if (local.get $dir)
              (then (global.set $wramdma
                (if (result i32) (i32.and (i32.and (i32.gt_u (local.get $bport) (i32.const 0x7C)) (i32.le_u (local.get $bport) (i32.const 0x83)))
                                          (i32.eqz (i32.and (local.get $src) (i32.const 0x400000))))
                  (then (i32.lt_u (i32.and (local.get $src) (i32.const 0xFFFF)) (i32.const 0x2000)))
                  (else (i32.eq (i32.and (i32.shr_u (local.get $src) (i32.const 17)) (i32.const 0x7F)) (i32.const 0x3F))))))
              (else (if (i32.or (i32.eqz (local.get $i))
                                (i32.or (i32.and (i32.eq (local.get $step) (i32.const 1)) (i32.eqz (i32.and (local.get $src) (i32.const 0xFFF))))
                                        (i32.and (i32.eq (local.get $step) (i32.const -1)) (i32.eq (i32.and (local.get $src) (i32.const 0xFFF)) (i32.const 0xFFF)))))
                (then (global.set $wramdma
                  (i32.or (i32.eq (i32.and (i32.shr_u (local.get $src) (i32.const 17)) (i32.const 0x7F)) (i32.const 0x3F))
                          (i32.and (i32.eqz (i32.and (local.get $src) (i32.const 0x400000)))
                                   (i32.lt_u (i32.and (local.get $src) (i32.const 0xFFFF)) (i32.const 0x2000)))))))))
            (if (global.get $cdma) (then (global.set $wramdma (i32.const 0))))
            (if (i32.and (global.get $cdma) (i32.eqz (local.get $dir)))
              (then (call $wr8 (i32.or (i32.const 0x2100) (i32.and
                        (i32.add (local.get $bport) (call $dmaoff (local.get $mode) (local.get $k)))
                        (i32.const 0xFF)))
                      (call $chip_dma_byte (local.get $i))))
              (else (call $dma_byte (local.get $src)
                (i32.or (i32.const 0x2100) (i32.and
                  (i32.add (local.get $bport) (call $dmaoff (local.get $mode) (local.get $k)))
                  (i32.const 0xFF)))
                (local.get $dir))))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            ;; The A-bus address walks inside its BANK.
            (local.set $src (i32.or
              (i32.and (local.get $src) (i32.const 0xFF0000))
              (i32.and (i32.add (local.get $src) (local.get $step))
                       (i32.const 0xFFFF))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            ;; UPDATE_COUNTERS: the address ($43x2) and the count ($43x5)
            ;; the CPU and HDMA see move with every byte.
            (i32.store16 (i32.add (i32.const ${PPUREG + 0x80})
              (i32.and (i32.add (local.get $base) (i32.const 2)) (i32.const 0x1FF)))
              (local.get $src))
            (i32.store16 (i32.add (i32.const ${PPUREG + 0x80})
              (i32.and (i32.add (local.get $base) (i32.const 5)) (i32.const 0x1FF)))
              (i32.sub (local.get $cnt) (local.get $i)))
            ;; addCyclesInDMA: 8 per byte, then every event that reaches
            ;; (render, HDMA, refresh, line ends and the APU catch-up with
            ;; them, vblank). An HDMA that ran on this channel meanwhile
            ;; ends the transfer where it stands.
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))
            (call $ev_due)
            (if (i32.and (global.get $hdmaran) (i32.shl (i32.const 1) (local.get $ch)))
              (then (global.set $hdmaran (i32.const 0)) (local.set $abort (i32.const 1)) (br $td)))
            (global.set $hdmaran (i32.const 0))
            (br $tl)))
          (global.set $indma (i32.const 0))
          (global.set $ingdma (i32.const 0))
          (global.set $wramdma (i32.const 0))
          (global.set $cdma (i32.const 0))
          ;; S9xDoDMA's tail (not reached by an aborted transfer or the
          ;; refused WRAM -> $2180 one): an NMI that became pending during
          ;; the transfer triggers Timings.NMIDMADelay (24) after it.
          (if (i32.and (i32.and (global.get $nmipend) (i32.eqz (local.get $abort)))
                       (i32.eqz (i32.and (i32.and (i32.eq (i32.and (i32.shr_u (local.get $src) (i32.const 16)) (i32.const 0xFE)) (i32.const 0x7E))
                                                  (i32.eq (local.get $bport) (i32.const 0x80)))
                                         (i32.eqz (local.get $dir)))))
            (then (global.set $nmipos (i32.add (call $hnow) (i32.const 24)))))
          (local.set $abort (i32.const 0))
          (if (i32.lt_u (global.get $ndma) (i32.const ${DMALOG_N}))
            (then
              (local.set $base (i32.add (i32.const ${DMALOG})
                (i32.mul (global.get $ndma) (i32.const ${DMALOG_STRIDE}))))
              (i32.store (local.get $base) (i32.or (i32.const 0x2100) (local.get $bport)))
              (i32.store (i32.add (local.get $base) (i32.const 4))
                         (local.get $mode))
              (i32.store (i32.add (local.get $base) (i32.const 8))
                         (local.get $src))
              (i32.store (i32.add (local.get $base) (i32.const 12))
                         (local.get $cnt))
              (i32.store (i32.add (local.get $base) (i32.const 16))
                         (global.get $vaddr))
              (i32.store (i32.add (local.get $base) (i32.const 20))
                         (global.get $curpc))))
          (global.set $ndma (i32.add (global.get $ndma) (i32.const 1)))))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $l))))

  ;; A-bus access during (H)DMA (snes9x S9xGetByte / S9xSetByte with
  ;; InDMAorHDMA): the A bus cannot reach the B bus, so $21xx in banks
  ;; $00-$3F/$80-$BF reads open bus and drops writes; and the (H)DMA read
  ;; leaves the data bus (OpenBus) as it was, which only the CPU's own
  ;; instructions set.
  (func $dma_rd_a (param $a i32) (result i32)
    (local $ob i32) (local $v i32)
    (if (i32.eq (i32.and (local.get $a) (i32.const 0x40FF00)) (i32.const 0x2100))
      (then (return (global.get $ob))))
    (local.set $ob (global.get $ob))
    (local.set $v (call $rd8 (local.get $a)))
    (global.set $ob (local.get $ob))
    (local.get $v))
  (func $dma_wr_a (param $a i32) (param $v i32)
    (if (i32.eq (i32.and (local.get $a) (i32.const 0x40FF00)) (i32.const 0x2100))
      (then (return)))
    (call $wr8 (local.get $a) (local.get $v)))
  ;; One DMA byte between A-bus $src and B-bus $b (snes9x S9xDoDMA).
  (func $dma_byte (param $src i32) (param $b i32) (param $dir i32)
    (if (local.get $dir)
      (then (call $dma_wr_a (local.get $src) (call $rd8 (local.get $b))))
      (else (call $wr8 (local.get $b) (call $dma_rd_a (local.get $src))))))

  (func $io_reg (param $r i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF)))))

  ;; ---- HDMA (snes9x dma.cpp S9xStartHDMA / S9xDoHDMA / HDMAReadLineCount)
  ;; The channel state lives where snes9x keeps it and the CPU can see it:
  ;; the table address in $43x8/9 (A2A), the indirect address in $43x5/6
  ;; (DAS), and the line counter / repeat flag behind $43xA. HDMAST+ch*16
  ;; holds +4 line counter, +5 repeat, +6 do-transfer.
  ;; S9xGetWord during (H)DMA: no data-bus change, except that a word
  ;; split across a 4KB block leaves its first byte there.
  (func $dma_rd16 (param $a i32) (result i32)
    (local $lo i32)
    (local.set $lo (call $dma_rd_a (local.get $a)))
    (if (i32.eq (i32.and (local.get $a) (i32.const 0xFFF)) (i32.const 0xFFF))
      (then (global.set $ob (local.get $lo))))
    (i32.or (local.get $lo) (i32.shl (call $dma_rd_a (i32.and (i32.add (local.get $a) (i32.const 1)) (i32.const 0xFFFFFF))) (i32.const 8))))

  (func $hdma_linecount (param $ch i32) (result i32)
    (local $st i32) (local $base i32) (local $bank i32) (local $ad i32)
    (local $line i32)
    (local.set $st (i32.add (i32.const ${HDMAST}) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $base (i32.add (i32.const 0x4300) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $bank (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 4)))
                              (i32.const 16)))
    (local.set $ad (call $io_reg16 (i32.add (local.get $base) (i32.const 8))))
    (local.set $line (call $dma_rd_a (i32.or (local.get $bank) (local.get $ad))))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))
    (if (i32.eqz (local.get $line))
      (then
        (i32.store8 (i32.add (local.get $st) (i32.const 5)) (i32.const 0))
        (i32.store8 (i32.add (local.get $st) (i32.const 4)) (i32.const 128))
        ;; A terminated indirect channel still loads its indirect address,
        ;; one byte further on when a later channel is still running.
        (if (i32.and (call $io_reg (local.get $base)) (i32.const 0x40))
          (then
            (if (i32.and (global.get $hdmaon) (i32.shl (i32.const 0xFE) (local.get $ch)))
              (then (local.set $ad (i32.and (i32.add (local.get $ad) (i32.const 1)) (i32.const 0xFFFF)))
                    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 16))))
              (else (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))))
            (call $io_set16 (i32.add (local.get $base) (i32.const 5))
              (call $dma_rd16 (i32.or (local.get $bank) (local.get $ad))))
            (local.set $ad (i32.and (i32.add (local.get $ad) (i32.const 1)) (i32.const 0xFFFF)))))
        (call $io_set16 (i32.add (local.get $base) (i32.const 8))
          (i32.and (i32.add (local.get $ad) (i32.const 1)) (i32.const 0xFFFF)))
        (return (i32.const 0))))
    (if (i32.eq (local.get $line) (i32.const 0x80))
      (then (i32.store8 (i32.add (local.get $st) (i32.const 5)) (i32.const 1))
            (i32.store8 (i32.add (local.get $st) (i32.const 4)) (i32.const 128)))
      (else (i32.store8 (i32.add (local.get $st) (i32.const 5))
              (i32.eqz (i32.and (local.get $line) (i32.const 0x80))))
            (i32.store8 (i32.add (local.get $st) (i32.const 4))
              (i32.and (local.get $line) (i32.const 0x7F)))))
    (local.set $ad (i32.and (i32.add (local.get $ad) (i32.const 1)) (i32.const 0xFFFF)))
    (i32.store8 (i32.add (local.get $st) (i32.const 6)) (i32.const 1))
    (if (i32.and (call $io_reg (local.get $base)) (i32.const 0x40))
      (then
        (global.set $cyc (i32.sub (global.get $cyc) (i32.const 16)))
        (call $io_set16 (i32.add (local.get $base) (i32.const 5))
          (call $dma_rd16 (i32.or (local.get $bank) (local.get $ad))))
        (local.set $ad (i32.and (i32.add (local.get $ad) (i32.const 2)) (i32.const 0xFFFF)))))
    (call $io_set16 (i32.add (local.get $base) (i32.const 8)) (local.get $ad))
    (i32.const 1))

  (func $io_reg16 (param $r i32) (result i32)
    (i32.load16_u (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF)))))
  (func $io_set8 (param $r i32) (param $v i32)
    (i32.store8 (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF))) (local.get $v)))
  (func $io_set16 (param $r i32) (param $v i32)
    (i32.store16 (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF))) (local.get $v)))

  ;; S9xStartHDMA, at line 0.
  (func $hdma_init
    (local $ch i32) (local $base i32) (local $sv i32)
    (global.set $hdmaon (call $io_reg (i32.const 0x420C)))
    (global.set $hdmaended (i32.const 0))
    (if (global.get $hdmaon) (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const ${lay.fixes?.dmaCpuSync ?? 18})))))
    ;; (H)DMA state is saved around it: this can run inside a general DMA.
    (local.set $sv (i32.or (global.get $indma) (i32.shl (global.get $wramdma) (i32.const 1))))
    (global.set $indma (i32.const 1))
    (global.set $wramdma (i32.const 0))
    (local.set $ch (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $ch) (i32.const 8)))
      (local.set $base (i32.add (i32.const 0x4300) (i32.shl (local.get $ch) (i32.const 4))))
      (if (i32.and (global.get $hdmaon) (i32.shl (i32.const 1) (local.get $ch)))
        (then
          (call $io_set16 (i32.add (local.get $base) (i32.const 8))
            (call $io_reg16 (i32.add (local.get $base) (i32.const 2))))
          (if (i32.eqz (call $hdma_linecount (local.get $ch)))
            (then (global.set $hdmaon (i32.and (global.get $hdmaon)
                    (i32.xor (i32.shl (i32.const 1) (local.get $ch)) (i32.const -1))))
                  (global.set $hdmaended (i32.or (global.get $hdmaended)
                    (i32.shl (i32.const 1) (local.get $ch)))))))
        (else (i32.store8 (i32.add (i32.const ${HDMAST + 6}) (i32.shl (local.get $ch) (i32.const 4)))
                          (i32.const 0))))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $l)))
    (global.set $indma (i32.and (local.get $sv) (i32.const 1)))
    (global.set $wramdma (i32.shr_u (local.get $sv) (i32.const 1)))
    ;; CPU.HDMARanInDMA = CPU.InDMA ? PPU.HDMA : 0
    (global.set $hdmaran (if (result i32) (global.get $ingdma) (then (global.get $hdmaon)) (else (i32.const 0)))))

  ;; S9xDoHDMA, once per visible line.
  ;; HDMA's InWRAMDMAorHDMA test for a source address.
  (func $hdma_inwram (param $a i32) (result i32)
    (i32.or (i32.eq (i32.and (i32.shr_u (local.get $a) (i32.const 17)) (i32.const 0x7F)) (i32.const 0x3F))
            (i32.and (i32.eqz (i32.and (local.get $a) (i32.const 0x400000)))
                     (i32.lt_u (i32.and (local.get $a) (i32.const 0xFFFF)) (i32.const 0x2000)))))
  ;; S9xGetMemPointer is not NULL: ROM / RAM blocks, and SRAM whose mask
  ;; covers a whole 4KB block.
  (func $hdma_direct (param $a i32) (result i32)
    (local $t i32)
    (local.set $t (i32.load (i32.add (i32.const ${MAPTAB}) (i32.shl (i32.shr_u (i32.and (local.get $a) (i32.const 0xFFFFFF)) (i32.const 12)) (i32.const 3)))))
    (if (result i32) (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 2)))
      (then (i32.const 1))
      (else (i32.and (i32.or (i32.eq (local.get $t) (i32.const 5)) (i32.eq (local.get $t) (i32.const 6)))
                     (i32.eq (i32.and (i32.const ${lay.sram}) (i32.const 0xFFF)) (i32.const 0xFFF))))))

  (func $hdma_do
    (local $ch i32) (local $st i32) (local $base i32) (local $p i32)
    (local $mode i32) (local $n i32) (local $k i32) (local $src i32)
    (local $ind i32) (local $bb i32) (local $lc i32) (local $breg i32) (local $sv i32)
    (local $slow i32) (local $aa i32) (local $v i32)
    (if (i32.eqz (global.get $hdmaon)) (then (return)))
    ;; CPU.HDMARanInDMA = CPU.InDMA ? byte : 0
    (global.set $hdmaran (if (result i32) (global.get $ingdma) (then (global.get $hdmaon)) (else (i32.const 0))))
    ;; Timings.DMACPUSync per HDMA line.
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const ${lay.fixes?.dmaCpuSync ?? 18})))
    (local.set $sv (i32.or (global.get $indma) (i32.shl (global.get $wramdma) (i32.const 1))))
    (global.set $indma (i32.const 1))
    (global.set $wramdma (i32.const 0))
    (local.set $ch (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $ch) (i32.const 8)))
      (if (i32.and (global.get $hdmaon) (i32.shl (i32.const 1) (local.get $ch)))
        (then
          (local.set $st (i32.add (i32.const ${HDMAST}) (i32.shl (local.get $ch) (i32.const 4))))
          (local.set $base (i32.add (i32.const 0x4300) (i32.shl (local.get $ch) (i32.const 4))))
          (local.set $p (call $io_reg (local.get $base)))
          (local.set $mode (i32.and (local.get $p) (i32.const 7)))
          (local.set $ind (i32.and (local.get $p) (i32.const 0x40)))
          ;; HDMA_ModeByteCounts ${'(1, 2, 2, 4, 4, 4, 2, 4)'}
          (local.set $n (i32.and (i32.shr_u (i32.const 0x42444221)
                                  (i32.shl (local.get $mode) (i32.const 2))) (i32.const 15)))
          (local.set $bb (call $io_reg (i32.add (local.get $base) (i32.const 1))))
          (if (i32.load8_u (i32.add (local.get $st) (i32.const 6)))
            (then${lay.fixes?.uniracers ? `
              ;; snes9x per-title fix (SNESGameFixes.Uniracers): an HDMA
              ;; transfer to $2104 first resets the OAM address to $10C.
              (if (i32.eq (local.get $bb) (i32.const 4))
                (then (global.set $oamaddr (i32.const 0x10C)) (global.set $oamflip (i32.const 0))))` : ""}
              (local.set $src (if (result i32) (local.get $ind)
                (then (i32.or (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 7)))
                                       (i32.const 16))
                              (call $io_reg16 (i32.add (local.get $base) (i32.const 5)))))
                (else (i32.or (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 4)))
                                       (i32.const 16))
                              (call $io_reg16 (i32.add (local.get $base) (i32.const 8)))))))
              (global.set $inhdma (i32.const 1))
              ;; snes9x S9xDoHDMA paths: a transfer whose bytes cross a 4KB
              ;; block, or a reverse one, goes byte by byte (InWRAMDMAorHDMA
              ;; per byte address); otherwise the flag is set once from the
              ;; transfer's address, and a direct-memory source is read
              ;; through HDMAMemPointers (mode 1 leaves its second byte on
              ;; the data bus).
              (local.set $slow (i32.or (i32.ne (i32.and (local.get $p) (i32.const 0x80)) (i32.const 0))
                (i32.ge_u (i32.add (i32.and (local.get $src) (i32.const 0xFFF)) (local.get $n)) (i32.const 0x1000))))
              (global.set $wramdma (call $hdma_inwram (local.get $src)))
              (local.set $k (i32.const 0))
              (block $kd (loop $kl
                (br_if $kd (i32.ge_u (local.get $k) (local.get $n)))
                (local.set $breg (i32.or (i32.const 0x2100) (i32.and
                  (i32.add (local.get $bb) (call $dmaoff (local.get $mode) (local.get $k)))
                  (i32.const 0xFF))))
                (local.set $aa (i32.or (i32.and (local.get $src) (i32.const 0xFF0000))
                  (i32.and (i32.add (local.get $src) (local.get $k)) (i32.const 0xFFFF))))
                (if (local.get $slow) (then (global.set $wramdma (call $hdma_inwram (local.get $aa)))))
                (if (i32.eqz (i32.and (local.get $p) (i32.const 0x80)))
                  (then (local.set $v (call $dma_rd_a (local.get $aa)))
                        (if (i32.and (i32.and (i32.eq (local.get $mode) (i32.const 1)) (i32.eq (local.get $k) (i32.const 1)))
                                     (i32.and (i32.eqz (local.get $slow)) (call $hdma_direct (local.get $aa))))
                          (then (global.set $ob (local.get $v))))
                        (call $wr8 (local.get $breg) (local.get $v)))
                  ;; Reverse HDMA: B bus to A bus.
                  (else (call $dma_wr_a (local.get $aa) (call $rd8 (local.get $breg)))))
                (local.set $k (i32.add (local.get $k) (i32.const 1)))
                (br $kl)))
              (global.set $inhdma (i32.const 0))
              (global.set $cyc (i32.sub (global.get $cyc) (i32.shl (local.get $n) (i32.const 3))))))))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $l)))
    (local.set $ch (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $ch) (i32.const 8)))
      (if (i32.and (global.get $hdmaon) (i32.shl (i32.const 1) (local.get $ch)))
        (then
          (local.set $st (i32.add (i32.const ${HDMAST}) (i32.shl (local.get $ch) (i32.const 4))))
          (local.set $base (i32.add (i32.const 0x4300) (i32.shl (local.get $ch) (i32.const 4))))
          (local.set $p (call $io_reg (local.get $base)))
          (local.set $mode (i32.and (local.get $p) (i32.const 7)))
          (local.set $n (i32.and (i32.shr_u (i32.const 0x42444221)
                                  (i32.shl (local.get $mode) (i32.const 2))) (i32.const 15)))
          (if (i32.load8_u (i32.add (local.get $st) (i32.const 6)))
            (then
              (if (i32.and (local.get $p) (i32.const 0x40))
                (then (call $io_set16 (i32.add (local.get $base) (i32.const 5))
                        (i32.add (call $io_reg16 (i32.add (local.get $base) (i32.const 5))) (local.get $n))))
                (else (call $io_set16 (i32.add (local.get $base) (i32.const 8))
                        (i32.add (call $io_reg16 (i32.add (local.get $base) (i32.const 8))) (local.get $n)))))))
          (i32.store8 (i32.add (local.get $st) (i32.const 6))
            (i32.eqz (i32.load8_u (i32.add (local.get $st) (i32.const 5)))))
          (local.set $lc (i32.sub (i32.load8_u (i32.add (local.get $st) (i32.const 4))) (i32.const 1)))
          (i32.store8 (i32.add (local.get $st) (i32.const 4)) (local.get $lc))
          (if (i32.and (local.get $lc) (i32.const 0xFF))
            (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))))
          (if (i32.eqz (i32.and (local.get $lc) (i32.const 0xFF)))
            (then
              (if (i32.eqz (call $hdma_linecount (local.get $ch)))
                (then
                  (global.set $hdmaon (i32.and (global.get $hdmaon)
                    (i32.xor (i32.shl (i32.const 1) (local.get $ch)) (i32.const -1))))
                  (global.set $hdmaended (i32.or (global.get $hdmaended)
                    (i32.shl (i32.const 1) (local.get $ch))))
                  (i32.store8 (i32.add (local.get $st) (i32.const 6)) (i32.const 0))))))))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $l2)))
    (global.set $indma (i32.and (local.get $sv) (i32.const 1)))
    (global.set $wramdma (i32.shr_u (local.get $sv) (i32.const 1))))

  (func $trap
    (global.set $trapped (i32.const 1))
    (global.set $trappc (global.get $curpc)))
`;
}


// The RAM interpreter: lower.js generates it from the same lowering as the
// arms (interpWat there), so RAM code runs exactly what a ROM arm would.
/** @param {import("./layout.js").SnesLayout} _lay */
export function interpWat(_lay) {
  return `
  ;; One interpreted instruction: the generated $interp charges it as an
  ;; arm does (program bytes, internal cycles, conditional ones) and runs
  ;; the arm body.
  (func $istep
    (call $interp))

  ;; Fetch the byte at PC+k without disturbing PC (the fetch is charged by
  ;; the generated code, not here).
  (func $ifetch (param $k i32) (result i32)
    (call $rd8m (i32.or
      (i32.and (global.get $pc) (i32.const 0xFF0000))
      (i32.and (i32.add (global.get $pc) (local.get $k))
               (i32.const 0xFFFF)))))

  ;; P as a byte, NVMXDIZC (the trace ring records it).
  (func $packp (result i32)
    (i32.or (i32.shl (global.get $fn) (i32.const 7)) (i32.or
      (i32.shl (global.get $fv) (i32.const 6)) (i32.or
      (i32.shl (global.get $fm) (i32.const 5)) (i32.or
      (i32.shl (global.get $fx) (i32.const 4)) (i32.or
      (i32.shl (global.get $fd) (i32.const 3)) (i32.or
      (i32.shl (global.get $fi) (i32.const 2)) (i32.or
      (i32.shl (global.get $fz) (i32.const 1)) (global.get $fc)))))))))

  ;; snes9x decimal-mode ADC/SBC.
  (func $adc_dec (param $v i32) (param $sub i32)
    (local $a i32) (local $r i32) (local $c i32) (local $top i32)
    (local.set $a (i32.and (global.get $a) (call $wmask (global.get $fm))))
    (if (local.get $sub) (then (local.set $v (i32.xor (local.get $v) (call $wmask (global.get $fm))))))
    (local.set $c (global.get $fc))
    ;; low nibble
    (local.set $r (i32.add (i32.add (i32.and (local.get $a) (i32.const 0xF)) (i32.and (local.get $v) (i32.const 0xF))) (local.get $c)))
    (if (local.get $sub)
      (then (if (i32.lt_u (local.get $r) (i32.const 0x10)) (then (local.set $r (i32.sub (local.get $r) (i32.const 6))))))
      (else (if (i32.gt_u (local.get $r) (i32.const 9)) (then (local.set $r (i32.add (local.get $r) (i32.const 6)))))))
    (local.set $c (i32.gt_s (local.get $r) (i32.const 0xF)))
    (local.set $r (i32.add (i32.add (i32.add (i32.and (local.get $a) (i32.const 0xF0)) (i32.and (local.get $v) (i32.const 0xF0)))
                                    (i32.and (local.get $r) (i32.const 0xF))) (i32.shl (local.get $c) (i32.const 4))))
    (if (i32.eqz (global.get $fm)) (then
      ;; 16-bit: two more nibbles before the top one.
      (if (local.get $sub)
        (then (if (i32.lt_s (local.get $r) (i32.const 0x100)) (then (local.set $r (i32.sub (local.get $r) (i32.const 0x60))))))
        (else (if (i32.gt_s (local.get $r) (i32.const 0x9F)) (then (local.set $r (i32.add (local.get $r) (i32.const 0x60)))))))
      (local.set $c (i32.gt_s (local.get $r) (i32.const 0xFF)))
      (local.set $r (i32.add (i32.add (i32.add (i32.and (local.get $a) (i32.const 0xF00)) (i32.and (local.get $v) (i32.const 0xF00)))
                                      (i32.and (local.get $r) (i32.const 0xFF))) (i32.shl (local.get $c) (i32.const 8))))
      (if (local.get $sub)
        (then (if (i32.lt_s (local.get $r) (i32.const 0x1000)) (then (local.set $r (i32.sub (local.get $r) (i32.const 0x600))))))
        (else (if (i32.gt_s (local.get $r) (i32.const 0x9FF)) (then (local.set $r (i32.add (local.get $r) (i32.const 0x600)))))))
      (local.set $c (i32.gt_s (local.get $r) (i32.const 0xFFF)))
      (local.set $r (i32.add (i32.add (i32.add (i32.and (local.get $a) (i32.const 0xF000)) (i32.and (local.get $v) (i32.const 0xF000)))
                                      (i32.and (local.get $r) (i32.const 0xFFF))) (i32.shl (local.get $c) (i32.const 12))))))
    (local.set $top (if (result i32) (global.get $fm) (then (i32.const 0x80)) (else (i32.const 0x8000))))
    ;; V: operands agree in sign and the result's sign differs.
    (global.set $fv (i32.and (i32.eqz (i32.and (i32.xor (local.get $a) (local.get $v)) (local.get $top)))
                             (i32.ne (i32.and (i32.xor (local.get $a) (local.get $r)) (local.get $top)) (i32.const 0))))
    ;; top nibble: ADC > $9F / $9FFF adds $60 / $6000; SBC < $100 / $10000 subtracts it.
    (if (local.get $sub)
      (then (if (i32.lt_s (local.get $r) (if (result i32) (global.get $fm) (then (i32.const 0x100)) (else (i32.const 0x10000))))
              (then (local.set $r (i32.sub (local.get $r) (if (result i32) (global.get $fm) (then (i32.const 0x60)) (else (i32.const 0x6000))))))))
      (else (if (i32.gt_s (local.get $r) (if (result i32) (global.get $fm) (then (i32.const 0x9F)) (else (i32.const 0x9FFF))))
              (then (local.set $r (i32.add (local.get $r) (if (result i32) (global.get $fm) (then (i32.const 0x60)) (else (i32.const 0x6000)))))))))
    (global.set $fc (i32.gt_s (local.get $r) (call $wmask (global.get $fm))))
    (global.set $a (if (result i32) (global.get $fm)
      (then (i32.or (i32.and (global.get $a) (i32.const 0xFF00)) (i32.and (local.get $r) (i32.const 0xFF))))
      (else (i32.and (local.get $r) (i32.const 0xFFFF)))))
    (local.set $r (i32.and (local.get $r) (call $wmask (global.get $fm))))
    (global.set $fz (i32.eqz (local.get $r)))
    (global.set $fn (i32.ne (i32.and (local.get $r) (local.get $top)) (i32.const 0))))

`;
}

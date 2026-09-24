// CPU-side WAT of a recompiled SNES cart: register/flag globals, the memory
// map ($rd8/$wr8 with the LoROM decode, SRAM mirroring, the $4200-$43FF I/O
// block, general-purpose DMA and HDMA), and the RAM interpreter that runs
// code the game builds in WRAM (one LoROM cart builds an OAM-clear
// routine at $7F8000 during reset).
//
// The WAT bodies are carried over byte-for-byte from sms-wat's emit_snes.py
// (globals_wat, mem_wat) and m65816.py (interp_wat, interp_tables_wat); the
// differential gate compares the whole emitted module against the Python
// emitter's. `lay` is the per-ROM layout from layout.js.
//
// Plain JS ESM + JSDoc.

import {
  WRAM, SRAMB, PPUREG, INPUT, MAPTAB, ICOST, OPTAB, HDMAST, DPWATCH, DMALOG, DMALOG_N, DMALOG_STRIDE,
} from "./layout.js";
import { ppuGlobalsWat } from "./ppu-wat.js";

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
  (global $nmiearly (mut i32) (i32.const 0))
  (global $hmax (mut i32) (i32.const 1364))
  (global $refpos (mut i32) (i32.const 538))
  (global $linesrun (mut i32) (i32.const 0))
  (global $bv (mut i32) (i32.const 0))
  (global $bh (mut i32) (i32.const 0))
  (global $wai (mut i32) (i32.const 0))
  (global $hpos (mut i32) (i32.const 0))
  (global $segend (mut i32) (i32.const 0))
  ;; The H/V timer IRQ position in this line (99999 = none), the frame-end
  ;; flag, and a general DMA running (with the HDMA channels that ran
  ;; inside it, snes9x CPU.HDMARanInDMA).
  (global $ipos (mut i32) (i32.const 99999))
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
    (local $v i32)
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
    (local $e i32) (local $x i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $e (i32.add (i32.const ${MAPTAB}) (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 3))))
    (local.set $x (i32.and (local.get $a) (i32.const 0xFFFF)))
    (block $none (block $sramhi (block $sramlo (block $cpu (block $ppu (block $direct
      (br_table $none $direct $direct $ppu $cpu $sramlo $sramhi $none (i32.load (local.get $e))))
      ;; ROM / RAM
      (return (i32.load8_u (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $a) (i32.const 0xFFF))))))
      ;; $2000-$3FFF: the B bus. $2100-$21FF are the PPU/APU/WRAM-port registers.
      (if (i32.eq (i32.and (local.get $x) (i32.const 0xFF00)) (i32.const 0x2100))
        (then (return (call $ppu_read (i32.and (local.get $x) (i32.const 0xFF))))))
      (return (global.get $ob)))
      ;; $4000-$5FFF: controller ports and the CPU's registers.
      (if (i32.eq (i32.and (local.get $x) (i32.const 0xFFFE)) (i32.const 0x4016))
        (then (return (call $joyser_read (i32.and (local.get $x) (i32.const 1))))))
      (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x4200)) (i32.lt_u (local.get $x) (i32.const 0x4400)))
        (then (return (call $io_read (local.get $x)))))
      (return (global.get $ob)))
      ;; LoROM SRAM: ((bank >> 1) | offset & $7FFF) & SRAMMask.
      (return (i32.load8_u (i32.add (i32.const ${SRAMB})
        (i32.and (i32.or (i32.shr_u (i32.and (local.get $a) (i32.const 0xFF0000)) (i32.const 1))
                         (i32.and (local.get $a) (i32.const 0x7FFF)))
                 (i32.const ${lay.sram}))))))
      ;; HiROM SRAM: (offset - $6000 + (bank & $1F) * $2000) & SRAMMask.
      (return (i32.load8_u (i32.add (i32.const ${SRAMB})
        (i32.and (i32.add (i32.sub (i32.and (local.get $a) (i32.const 0x7FFF)) (i32.const 0x6000))
                          (i32.shr_u (i32.and (local.get $a) (i32.const 0x1F0000)) (i32.const 3)))
                 (i32.const ${lay.sram}))))))
    (global.get $ob))

  ;; snes9x S9xGetWord / S9xSetWord take a FAST PATH when both bytes are
  ;; plain memory in one 4KB block: one access of twice the speed, and the
  ;; event check after both bytes (addCyclesInMemoryAccess_x2). Anything
  ;; else - I/O, SRAM windows handled byte by byte, a word that straddles a
  ;; block - goes byte by byte. $want is 1 for ROM or RAM (reads), 2 for RAM
  ;; only (writes: ROM is write-protected, so it is not a plain block there).
  (func $fast2 (param $a i32) (param $want i32) (result i32)
    (local $t i32)
    (if (i32.eq (i32.and (local.get $a) (i32.const 0xFFF)) (i32.const 0xFFF)) (then (return (i32.const 0))))
    (if (global.get $indma) (then (return (i32.const 0))))
    (local.set $t (i32.load (i32.add (i32.const ${MAPTAB})
      (i32.shl (i32.shr_u (i32.and (local.get $a) (i32.const 0xFFFFFF)) (i32.const 12)) (i32.const 3)))))
    (if (result i32) (i32.eq (local.get $want) (i32.const 1))
      (then (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 2))))
      (else (i32.eq (local.get $t) (i32.const 2)))))

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

  (func $wr8 (param $a i32) (param $v i32)
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
    (block $none (block $sramhi (block $sramlo (block $cpu (block $ppu (block $ram
      (br_table $none $none $ram $ppu $cpu $sramlo $sramhi $none (i32.load (local.get $e))))
      (i32.store8 (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $a) (i32.const 0xFFF))) (local.get $v))
      (return))
      (if (i32.eq (i32.and (local.get $x) (i32.const 0xFF00)) (i32.const 0x2100))
        (then (call $ppu_write (i32.and (local.get $x) (i32.const 0xFF)) (local.get $v))))
      (return))
      ;; $4016 bit 0 is the controller latch; $4017 writes do nothing.
      (if (i32.eq (local.get $x) (i32.const 0x4016))
        (then (call $joy_latch (i32.and (local.get $v) (i32.const 1))) (return)))
      (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x4200)) (i32.lt_u (local.get $x) (i32.const 0x4400)))
        (then (call $io_write (local.get $x) (local.get $v))))
      (return))
      ;; SRAM writes need an SRAM (snes9x: if (Memory.SRAMMask)).
      ${lay.sram ? "" : ";; this cart has no SRAM: writes are dropped\n      (return)"}
      (i32.store8 (i32.add (i32.const ${SRAMB})
        (i32.and (i32.or (i32.shr_u (i32.and (local.get $a) (i32.const 0xFF0000)) (i32.const 1))
                         (i32.and (local.get $a) (i32.const 0x7FFF)))
                 (i32.const ${lay.sram}))) (local.get $v))
      (return))
      ${lay.sram ? "" : "(return)"}
      (i32.store8 (i32.add (i32.const ${SRAMB})
        (i32.and (i32.add (i32.sub (i32.and (local.get $a) (i32.const 0x7FFF)) (i32.const 0x6000))
                          (i32.shr_u (i32.and (local.get $a) (i32.const 0x1F0000)) (i32.const 3)))
                 (i32.const ${lay.sram}))) (local.get $v))
      (return)))

  ;; $4200-$43FF: interrupt enables, the multiply/divide unit, IRQ timers,
  ;; DMA and HDMA. The shadow at PPUREG+0x80 holds every written value, and
  ;; the result registers ($4214-$4217) are written INTO it by the unit so a
  ;; plain shadow read returns them.
  (func $io_write (param $r i32) (param $v i32)
    (local $p i32) (local $q i32)
    (i32.store8 (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF))) (local.get $v))
    (if (i32.eq (local.get $r) (i32.const 0x4200))
      (then
        ;; Enabling NMI while the vblank flag is already set fires it.
        (if (i32.and (i32.and (i32.eqz (global.get $nmien))
                              (i32.ne (i32.and (local.get $v) (i32.const 0x80))
                                      (i32.const 0)))
                     (i32.and (i32.ne (global.get $nmiflag) (i32.const 0))
                              (i32.ge_u (global.get $scanline) (i32.const 225))))
          ;; snes9x sets Timings.IRQFlagChanging |= IRQ_TRIGGER_NMI: the NMI
          ;; becomes pending at the next boundary ($apply_ichg), so one more
          ;; instruction runs before it is taken.
          (then (global.set $ichg (i32.or (global.get $ichg) (i32.const 4)))))
        (global.set $nmien (i32.and (local.get $v) (i32.const 0x80)))
        (if (i32.eqz (i32.and (local.get $v) (i32.const 0x30)))
          (then (global.set $irqline (i32.const 0))))
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
            (if (i32.and (i32.eq (global.get $scanline) (i32.const 224)) (i32.eq (global.get $bv) (i32.const 225)))
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
        (if (i32.and (i32.ge_u (global.get $bv) (i32.const 225))
                     (i32.lt_u (global.get $bv) (i32.const 228)))
          (then (local.set $v (i32.const 1))))
        (if (i32.or (i32.ge_s (global.get $bh) (i32.const 1096))
                    (i32.lt_s (global.get $bh) (i32.const 4)))
          (then (local.set $v (i32.or (local.get $v) (i32.const 0x40)))))
        (if (i32.ge_u (global.get $bv) (i32.const 225))
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
            (if (i32.eq (global.get $bv) (i32.const 262)) (then (global.set $bv (i32.const 0)))))))

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
    (global.set $pad0 (call $pad_word (i32.load16_u (i32.const ${INPUT}))))
    (global.set $pad1 (call $pad_word (i32.load16_u (i32.const ${INPUT + 16})))))
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
      (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 18)))))
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
          ;; snes9x S9xDoDMA: 8 master clocks per channel before its bytes.
          (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))
          (global.set $indma (i32.const 1))
          (global.set $ingdma (i32.const 1))
          ;; snes9x inWRAM_DMA: a WRAM A-bus address cannot also reach the
          ;; WRAM port $2180 (the write is dropped / the read is open bus).
          (global.set $wramdma (if (result i32) (local.get $dir)
            (then (i32.eq (i32.and (i32.shr_u (local.get $src) (i32.const 17)) (i32.const 0x7F)) (i32.const 0x3F)))
            (else (i32.or (i32.eq (i32.and (i32.shr_u (local.get $src) (i32.const 17)) (i32.const 0x7F)) (i32.const 0x3F))
                          (i32.and (i32.eqz (i32.and (local.get $src) (i32.const 0x400000)))
                                   (i32.lt_u (i32.and (local.get $src) (i32.const 0xFFFF)) (i32.const 0x2000)))))))
          (block $td (loop $tl
            (br_if $td (i32.ge_u (local.get $i) (local.get $cnt)))
            (call $dma_byte (local.get $src)
              (i32.or (i32.const 0x2100) (i32.and
                (i32.add (local.get $bport) (call $dmaoff (local.get $mode) (local.get $k)))
                (i32.const 0xFF)))
              (local.get $dir))
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

  ;; One DMA byte between A-bus $src and B-bus $b (snes9x S9xDoDMA): the
  ;; A bus cannot address the B bus, so an A-bus $21xx reads open bus and
  ;; is not written.
  (func $dma_byte (param $src i32) (param $b i32) (param $dir i32)
    (local $ab i32)
    (local.set $ab (i32.eq (i32.and (local.get $src) (i32.const 0x40FF00)) (i32.const 0x2100)))
    (if (local.get $dir)
      (then (local.set $b (call $rd8 (local.get $b)))
            (if (i32.eqz (local.get $ab)) (then (call $wr8 (local.get $src) (local.get $b)))))
      (else (call $wr8 (local.get $b)
              (if (result i32) (local.get $ab) (then (global.get $ob)) (else (call $rd8 (local.get $src))))))))

  (func $io_reg (param $r i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF)))))

  ;; ---- HDMA (snes9x dma.cpp S9xStartHDMA / S9xDoHDMA / HDMAReadLineCount)
  ;; The channel state lives where snes9x keeps it and the CPU can see it:
  ;; the table address in $43x8/9 (A2A), the indirect address in $43x5/6
  ;; (DAS), and the line counter / repeat flag behind $43xA. HDMAST+ch*16
  ;; holds +4 line counter, +5 repeat, +6 do-transfer.
  (func $hdma_linecount (param $ch i32) (result i32)
    (local $st i32) (local $base i32) (local $bank i32) (local $ad i32)
    (local $line i32)
    (local.set $st (i32.add (i32.const ${HDMAST}) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $base (i32.add (i32.const 0x4300) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $bank (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 4)))
                              (i32.const 16)))
    (local.set $ad (call $io_reg16 (i32.add (local.get $base) (i32.const 8))))
    (local.set $line (call $rd8 (i32.or (local.get $bank) (local.get $ad))))
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
              (call $rd16 (i32.or (local.get $bank) (local.get $ad))))
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
          (call $rd16 (i32.or (local.get $bank) (local.get $ad))))
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
    (if (global.get $hdmaon) (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 18)))))
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
  (func $hdma_do
    (local $ch i32) (local $st i32) (local $base i32) (local $p i32)
    (local $mode i32) (local $n i32) (local $k i32) (local $src i32)
    (local $ind i32) (local $bb i32) (local $lc i32) (local $breg i32) (local $sv i32)
    (if (i32.eqz (global.get $hdmaon)) (then (return)))
    ;; CPU.HDMARanInDMA = CPU.InDMA ? byte : 0
    (global.set $hdmaran (if (result i32) (global.get $ingdma) (then (global.get $hdmaon)) (else (i32.const 0))))
    ;; Timings.DMACPUSync per HDMA line.
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 18)))
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
            (then
              (local.set $src (if (result i32) (local.get $ind)
                (then (i32.or (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 7)))
                                       (i32.const 16))
                              (call $io_reg16 (i32.add (local.get $base) (i32.const 5)))))
                (else (i32.or (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 4)))
                                       (i32.const 16))
                              (call $io_reg16 (i32.add (local.get $base) (i32.const 8)))))))
              (global.set $inhdma (i32.const 1))
              (local.set $k (i32.const 0))
              (block $kd (loop $kl
                (br_if $kd (i32.ge_u (local.get $k) (local.get $n)))
                (local.set $breg (i32.or (i32.const 0x2100) (i32.and
                  (i32.add (local.get $bb) (call $dmaoff (local.get $mode) (local.get $k)))
                  (i32.const 0xFF))))
                (if (i32.eqz (i32.and (local.get $p) (i32.const 0x80)))
                  (then (call $wr8 (local.get $breg)
                          (call $rd8 (i32.or (i32.and (local.get $src) (i32.const 0xFF0000))
                            (i32.and (i32.add (local.get $src) (local.get $k)) (i32.const 0xFFFF))))))
                  ;; Reverse HDMA: B bus to A bus.
                  (else (call $wr8 (i32.or (i32.and (local.get $src) (i32.const 0xFF0000))
                            (i32.and (i32.add (local.get $src) (local.get $k)) (i32.const 0xFFFF)))
                          (call $rd8 (local.get $breg)))))
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

// m65816.py interp_wat() lines 343-952
/** @param {import("./layout.js").SnesLayout} lay */
export function interpWat(_lay) {
  return `
  ;; One interpreted instruction, charged the way an arm is: the program
  ;; bytes at the code region's speed and the static internal cycles
  ;; (ICOST, from lower.js cycles()) before it runs, its data accesses as
  ;; they happen, one more cycle for a direct page off a page boundary and
  ;; for a taken branch.
  (func $istep
    (local $op i32) (local $lf i32) (local $n i32) (local $pc0 i32)
    (local.set $pc0 (global.get $pc))
    (local.set $op (call $rd8m (global.get $pc)))
    (local.set $lf (i32.load8_u (i32.add (i32.const ${ICOST}) (i32.shl (local.get $op) (i32.const 1)))))
    (local.set $n (i32.and (local.get $lf) (i32.const 7)))
    (if (i32.and (i32.ne (i32.and (local.get $lf) (i32.const 0x80)) (i32.const 0)) (i32.eqz (global.get $fm)))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    (if (i32.and (i32.ne (i32.and (local.get $lf) (i32.const 0x40)) (i32.const 0)) (i32.eqz (global.get $fx)))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.add
      (i32.mul (global.get $ms) (local.get $n))
      (i32.mul (i32.and (i32.load8_u offset=1 (i32.add (i32.const ${ICOST}) (i32.shl (local.get $op) (i32.const 1)))) (i32.const 0x7F)) (i32.const 6)))))
    (if (i32.and (i32.ne (i32.and (local.get $lf) (i32.const 0x20)) (i32.const 0)) (i32.ne (i32.and (global.get $d) (i32.const 0xFF)) (i32.const 0)))
      (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))))
    (call $interp)
    (if (i32.and (i32.ne (i32.and (local.get $lf) (i32.const 0x10)) (i32.const 0))
                 (i32.ne (global.get $pc) (i32.or (i32.and (local.get $pc0) (i32.const 0xFF0000))
                                                  (i32.and (i32.add (local.get $pc0) (i32.const 2)) (i32.const 0xFFFF)))))
      (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6))))))

  ;; Fetch the byte at PC+k without disturbing PC (the fetch is charged by
  ;; $istep, not here).
  (func $ifetch (param $k i32) (result i32)
    (call $rd8m (i32.or
      (i32.and (global.get $pc) (i32.const 0xFF0000))
      (i32.and (i32.add (global.get $pc) (local.get $k))
               (i32.const 0xFFFF)))))

  ;; Advance PC by n, wrapping INSIDE the bank - the 65816's PC does not
  ;; carry into the program bank.
  (func $ipc (param $n i32)
    (global.set $pc (i32.or
      (i32.and (global.get $pc) (i32.const 0xFF0000))
      (i32.and (i32.add (global.get $pc) (local.get $n))
               (i32.const 0xFFFF)))))

  (func $interp
    (local $op i32) (local $ea i32) (local $u8 i32) (local $u16 i32)
    (local $u24 i32) (local $v i32) (local $r i32) (local $n i32)
    (local $d i32) (local $w i32)
    (local.set $op (call $ifetch (i32.const 0)))
    (local.set $u8  (call $ifetch (i32.const 1)))
    (local.set $u16 (i32.or (local.get $u8)
      (i32.shl (call $ifetch (i32.const 2)) (i32.const 8))))
    (local.set $u24 (i32.or (local.get $u16)
      (i32.shl (call $ifetch (i32.const 3)) (i32.const 16))))

    ;; ---- implied and single-byte opcodes -----------------------------
    (if (i32.eq (local.get $op) (i32.const 0xEA))   ;; nop
      (then (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x18))
      (then (global.set $fc (i32.const 0)) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x38))
      (then (global.set $fc (i32.const 1)) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x58))
      (then (global.set $ichg (i32.or (global.get $ichg) (i32.const 1))) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x78))
      (then (global.set $ichg (i32.or (global.get $ichg) (i32.const 2))) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xB8))
      (then (global.set $fv (i32.const 0)) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xD8))
      (then (global.set $fd (i32.const 0)) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xF8))
      (then (global.set $fd (i32.const 1)) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xFB))   ;; xce
      (then (local.set $v (global.get $fc))
            (global.set $fc (global.get $fe))
            (global.set $fe (local.get $v))
            (if (global.get $fe) (then
              (global.set $fm (i32.const 1)) (global.set $fx (i32.const 1))
              (call $narrowx)))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xEB))   ;; xba
      (then (global.set $a (i32.or
               (i32.shr_u (global.get $a) (i32.const 8))
               (i32.and (i32.shl (global.get $a) (i32.const 8))
                        (i32.const 0xFF00))))
            (call $setnz (global.get $a) (i32.const 1))
            (call $ipc (i32.const 1)) (return)))
    ;; rep / sep
    (if (i32.or (i32.eq (local.get $op) (i32.const 0xC2))
                (i32.eq (local.get $op) (i32.const 0xE2)))
      (then
        (local.set $v (i32.eq (local.get $op) (i32.const 0xE2)))
        (if (i32.and (local.get $u8) (i32.const 0x80))
          (then (global.set $fn (local.get $v))))
        (if (i32.and (local.get $u8) (i32.const 0x40))
          (then (global.set $fv (local.get $v))))
        (if (i32.and (local.get $u8) (i32.const 0x20))
          (then (global.set $fm (local.get $v))))
        (if (i32.and (local.get $u8) (i32.const 0x10))
          (then (global.set $fx (local.get $v)) (call $narrowx)))
        (if (i32.and (local.get $u8) (i32.const 0x08))
          (then (global.set $fd (local.get $v))))
        (if (i32.and (local.get $u8) (i32.const 0x04))
          (then (global.set $fi (local.get $v))))
        (if (i32.and (local.get $u8) (i32.const 0x02))
          (then (global.set $fz (local.get $v))))
        (if (i32.and (local.get $u8) (i32.const 0x01))
          (then (global.set $fc (local.get $v))))
        (call $ipc (i32.const 2)) (return)))

    ;; ---- register transfers -------------------------------------------
    (if (i32.eq (local.get $op) (i32.const 0xAA))   ;; tax
      (then (global.set $x (i32.and (global.get $a)
                                    (call $wmask (global.get $fx))))
            (call $setnz (global.get $x) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xA8))   ;; tay
      (then (global.set $y (i32.and (global.get $a)
                                    (call $wmask (global.get $fx))))
            (call $setnz (global.get $y) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x8A))   ;; txa
      (then (call $seta (global.get $x))
            (call $setnz (global.get $a) (global.get $fm))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x98))   ;; tya
      (then (call $seta (global.get $y))
            (call $setnz (global.get $a) (global.get $fm))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x9B))   ;; txy
      (then (global.set $y (i32.and (global.get $x)
                                    (call $wmask (global.get $fx))))
            (call $setnz (global.get $y) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xBB))   ;; tyx
      (then (global.set $x (i32.and (global.get $y)
                                    (call $wmask (global.get $fx))))
            (call $setnz (global.get $x) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xBA))   ;; tsx
      (then (global.set $x (i32.and (global.get $s)
                                    (call $wmask (global.get $fx))))
            (call $setnz (global.get $x) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x9A))   ;; txs
      (then (global.set $s (global.get $x))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x1B))   ;; tcs
      (then (global.set $s (global.get $a))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x3B))   ;; tsc
      (then (global.set $a (global.get $s))
            (call $setnz (global.get $a) (i32.const 0))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x5B))   ;; tcd
      (then (global.set $d (global.get $a))
            (call $setnz (global.get $d) (i32.const 0))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x7B))   ;; tdc
      (then (global.set $a (global.get $d))
            (call $setnz (global.get $a) (i32.const 0))
            (call $ipc (i32.const 1)) (return)))

    ;; ---- inc/dec of index registers and the accumulator ---------------
    (if (i32.or (i32.eq (local.get $op) (i32.const 0xE8))
                (i32.eq (local.get $op) (i32.const 0xCA)))   ;; inx / dex
      (then (global.set $x (i32.and (i32.add (global.get $x)
              (if (result i32) (i32.eq (local.get $op) (i32.const 0xE8))
                (then (i32.const 1)) (else (i32.const -1))))
              (call $wmask (global.get $fx))))
            (call $setnz (global.get $x) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.or (i32.eq (local.get $op) (i32.const 0xC8))
                (i32.eq (local.get $op) (i32.const 0x88)))   ;; iny / dey
      (then (global.set $y (i32.and (i32.add (global.get $y)
              (if (result i32) (i32.eq (local.get $op) (i32.const 0xC8))
                (then (i32.const 1)) (else (i32.const -1))))
              (call $wmask (global.get $fx))))
            (call $setnz (global.get $y) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.or (i32.eq (local.get $op) (i32.const 0x1A))
                (i32.eq (local.get $op) (i32.const 0x3A)))   ;; inc a / dec a
      (then (local.set $r (i32.and (i32.add
               (i32.and (global.get $a) (call $wmask (global.get $fm)))
               (if (result i32) (i32.eq (local.get $op) (i32.const 0x1A))
                 (then (i32.const 1)) (else (i32.const -1))))
               (call $wmask (global.get $fm))))
            (call $seta (local.get $r))
            (call $setnz (local.get $r) (global.get $fm))
            (call $ipc (i32.const 1)) (return)))

    ;; ---- stack ---------------------------------------------------------
    (if (i32.eq (local.get $op) (i32.const 0x48))   ;; pha
      (then (call $ipush (global.get $a) (global.get $fm))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xDA))   ;; phx
      (then (call $ipush (global.get $x) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x5A))   ;; phy
      (then (call $ipush (global.get $y) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x0B))   ;; phd
      (then (call $ipush (global.get $d) (i32.const 0))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x8B))   ;; phb
      (then (call $ipush (global.get $db) (i32.const 1))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x4B))   ;; phk
      (then (call $ipush (i32.shr_u (global.get $pc) (i32.const 16))
                         (i32.const 1))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x08))   ;; php
      (then (call $ipush (call $packp) (i32.const 1))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xF4))   ;; pea
      (then (call $ipush (local.get $u16) (i32.const 0))
            (call $ipc (i32.const 3)) (return)))
    ;; PEI IS TWO BYTES, not three: its operand is a DIRECT-PAGE offset, and
    ;; only the 16-bit value it reads from there is pushed. Advancing 3 put
    ;; the interpreter one byte into the next instruction.
    (if (i32.eq (local.get $op) (i32.const 0xD4))   ;; pei
      (then (call $ipush (call $rd16 (call $idp (local.get $u8)))
                         (i32.const 0))
            (call $ipc (i32.const 2)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x68))   ;; pla
      (then (local.set $v (call $ipull (global.get $fm)))
            (call $seta (local.get $v))
            (call $setnz (local.get $v) (global.get $fm))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xFA))   ;; plx
      (then (global.set $x (call $ipull (global.get $fx)))
            (call $setnz (global.get $x) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x7A))   ;; ply
      (then (global.set $y (call $ipull (global.get $fx)))
            (call $setnz (global.get $y) (global.get $fx))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x2B))   ;; pld
      (then (global.set $d (call $ipull (i32.const 0)))
            (call $setnz (global.get $d) (i32.const 0))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xAB))   ;; plb
      (then (local.set $v (call $ipull (i32.const 1)))
            (call $setdb (local.get $v))
            (call $setnz (local.get $v) (i32.const 1))
            (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x28))   ;; plp
      (then (call $unpackp (call $ipull (i32.const 1)))
            (call $ipc (i32.const 1)) (return)))

    ;; ---- returns --------------------------------------------------------
    (if (i32.eq (local.get $op) (i32.const 0x60))   ;; rts
      (then (global.set $pc (i32.or
               (i32.and (global.get $pc) (i32.const 0xFF0000))
               (i32.and (i32.add (call $ipull (i32.const 0)) (i32.const 1))
                        (i32.const 0xFFFF))))
            ;; Op60: the last internal cycle comes after the pull.
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))
            (return)))
    (if (i32.eq (local.get $op) (i32.const 0x6B))   ;; rtl
      (then (local.set $v (i32.and (i32.add (call $ipull (i32.const 0))
                                            (i32.const 1))
                                   (i32.const 0xFFFF)))
            (global.set $pc (i32.or
              (i32.shl (call $ipull (i32.const 1)) (i32.const 16))
              (local.get $v)))
            (return)))
    (if (i32.eq (local.get $op) (i32.const 0x40))   ;; rti
      (then (call $unpackp (call $ipull (i32.const 1)))
            (local.set $v (call $ipull (i32.const 0)))
            (global.set $pc (i32.or
              (i32.shl (call $ipull (i32.const 1)) (i32.const 16))
              (local.get $v)))
            (return)))

    ;; ---- jumps and calls -------------------------------------------------
    (if (i32.eq (local.get $op) (i32.const 0x4C))   ;; jmp abs
      (then (global.set $pc (i32.or
               (i32.and (global.get $pc) (i32.const 0xFF0000))
               (local.get $u16))) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x5C))   ;; jml long
      (then (global.set $pc (local.get $u24)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x6C))   ;; jmp (abs)
      (then (global.set $pc (i32.or
               (i32.and (global.get $pc) (i32.const 0xFF0000))
               (call $rd16 (local.get $u16)))) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x7C))   ;; jmp (abs,x)
      (then (global.set $pc (i32.or
               (i32.and (global.get $pc) (i32.const 0xFF0000))
               (call $rd16 (i32.or
                 (i32.and (global.get $pc) (i32.const 0xFF0000))
                 (i32.and (i32.add (local.get $u16) (global.get $x))
                          (i32.const 0xFFFF)))))) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xDC))   ;; jml [abs]
      (then (global.set $pc (call $rd24 (local.get $u16))) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x20))   ;; jsr abs
      (then (call $ipush (i32.and (i32.add (global.get $pc) (i32.const 2))
                                  (i32.const 0xFFFF)) (i32.const 0))
            (global.set $pc (i32.or
              (i32.and (global.get $pc) (i32.const 0xFF0000))
              (local.get $u16))) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x22))   ;; jsl long
      (then (call $ipush (i32.shr_u (global.get $pc) (i32.const 16))
                         (i32.const 1))
            (call $ipush (i32.and (i32.add (global.get $pc) (i32.const 3))
                                  (i32.const 0xFFFF)) (i32.const 0))
            (global.set $pc (local.get $u24)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xFC))   ;; jsr (abs,x)
      (then (call $ipush (i32.and (i32.add (global.get $pc) (i32.const 2))
                                  (i32.const 0xFFFF)) (i32.const 0))
            (global.set $pc (i32.or
              (i32.and (global.get $pc) (i32.const 0xFF0000))
              (call $rd16 (i32.or
                (i32.and (global.get $pc) (i32.const 0xFF0000))
                (i32.and (i32.add (local.get $u16) (global.get $x))
                         (i32.const 0xFFFF)))))) (return)))

    ;; ---- block move, one byte per step as the hardware does it ----------
    ;; MVN/MVP operand bytes are (dest bank, src bank). The instruction
    ;; re-executes (pc does not advance) until A wraps to $FFFF.
    (if (i32.or (i32.eq (local.get $op) (i32.const 0x54))
                (i32.eq (local.get $op) (i32.const 0x44)))
      (then
        (call $setdb (local.get $u8))
        (call $wr8 (i32.or (i32.shl (local.get $u8) (i32.const 16))
                           (global.get $y))
          (call $rd8 (i32.or (i32.shl (i32.and (i32.shr_u (local.get $u16)
                                                          (i32.const 8))
                                               (i32.const 0xFF))
                                      (i32.const 16))
                             (global.get $x))))
        (local.set $v (if (result i32) (i32.eq (local.get $op) (i32.const 0x54))
          (then (i32.const 1)) (else (i32.const -1))))
        (global.set $x (i32.and (i32.add (global.get $x) (local.get $v))
                                (call $wmask (global.get $fx))))
        (global.set $y (i32.and (i32.add (global.get $y) (local.get $v))
                                (call $wmask (global.get $fx))))
        (global.set $a (i32.and (i32.sub (global.get $a) (i32.const 1))
                                (i32.const 0xFFFF)))
        ;; Op54/Op44 end with AddCycles(TWO_CYCLES), after the byte moved.
        (global.set $cyc (i32.sub (global.get $cyc) (i32.const 12)))
        (if (i32.eq (global.get $a) (i32.const 0xFFFF))
          (then (call $ipc (i32.const 3))))
        (return)))
    (if (i32.eq (local.get $op) (i32.const 0x62))   ;; per
      (then (call $ipush (i32.and (i32.add (i32.add (global.get $pc)
                                                    (i32.const 3))
                                           (local.get $u16))
                                  (i32.const 0xFFFF)) (i32.const 0))
            (call $ipc (i32.const 3)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x42))   ;; wdm: 2-byte no-op
      (then (call $ipc (i32.const 2)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0xCB))   ;; wai, see lower()
      (then (global.set $wai (i32.const 1)) (call $ipc (i32.const 1)) (return)))

    ;; ---- relative branches ------------------------------------------------
    (if (i32.eq (local.get $op) (i32.const 0x82))   ;; brl
      (then (call $ipc (i32.add (i32.const 3)
               (i32.shr_s (i32.shl (local.get $u16) (i32.const 16))
                          (i32.const 16)))) (return)))
    (local.set $d (i32.shr_s (i32.shl (local.get $u8) (i32.const 24))
                             (i32.const 24)))
    (local.set $r (i32.const -1))
    (if (i32.eq (local.get $op) (i32.const 0x80))
      (then (local.set $r (i32.const 1))))
    (if (i32.eq (local.get $op) (i32.const 0x10))
      (then (local.set $r (i32.eqz (global.get $fn)))))
    (if (i32.eq (local.get $op) (i32.const 0x30))
      (then (local.set $r (global.get $fn))))
    (if (i32.eq (local.get $op) (i32.const 0x50))
      (then (local.set $r (i32.eqz (global.get $fv)))))
    (if (i32.eq (local.get $op) (i32.const 0x70))
      (then (local.set $r (global.get $fv))))
    (if (i32.eq (local.get $op) (i32.const 0x90))
      (then (local.set $r (i32.eqz (global.get $fc)))))
    (if (i32.eq (local.get $op) (i32.const 0xB0))
      (then (local.set $r (global.get $fc))))
    (if (i32.eq (local.get $op) (i32.const 0xD0))
      (then (local.set $r (i32.eqz (global.get $fz)))))
    (if (i32.eq (local.get $op) (i32.const 0xF0))
      (then (local.set $r (global.get $fz))))
    (if (i32.ne (local.get $r) (i32.const -1))
      (then (call $ipc (i32.add (i32.const 2)
               (if (result i32) (local.get $r) (then (local.get $d))
                                               (else (i32.const 0)))))
            (return)))

    ;; ---- everything with an addressing mode -------------------------------
    ;; $ea is the effective address, $n the instruction length, $w the width
    ;; flag (1 = 8-bit). -1 in $n means "not an addressed opcode", and -2
    ;; means an IMMEDIATE, whose value is already in $u8/$u16.
    (local.set $n (call $iaddr (local.get $op) (local.get $u8)
                               (local.get $u16) (local.get $u24)))
    (if (i32.lt_s (local.get $n) (i32.const 0))
      (then (call $trap) (return)))
    (local.set $ea (global.get $t3))
    (local.set $w (global.get $t4))

    ;; The opcode's high 3 bits and low 2 give the operation for the regular
    ;; grid; the irregular ones were all handled above.
    (local.set $v (i32.const 0))
    (if (global.get $t2)              ;; immediate: value, not address
      (then (local.set $v (if (result i32) (local.get $w)
              (then (local.get $u8)) (else (local.get $u16)))))
      ;; Stores (operation ids 4-7: sta stx sty stz) do not read their
      ;; target: a read of an I/O register has side effects ($2139 moves the
      ;; VRAM address, $4210 clears the NMI flag) and costs a bus cycle.
      (else (if (i32.gt_u (i32.sub (i32.load8_u (i32.add (i32.const ${OPTAB}) (local.get $op))) (i32.const 4)) (i32.const 3))
              (then (local.set $v (call $rdw (local.get $ea) (local.get $w)))))))

    ;; lda / ldx / ldy
    (if (call $isop (local.get $op) (i32.const 0xA9) (i32.const 1))
      (then (call $seta (local.get $v))
            (call $setnz (local.get $v) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0xA2) (i32.const 2))
      (then (global.set $x (local.get $v))
            (call $setnz (local.get $v) (global.get $fx))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0xA0) (i32.const 3))
      (then (global.set $y (local.get $v))
            (call $setnz (local.get $v) (global.get $fx))
            (call $ipc (local.get $n)) (return)))
    ;; sta / stx / sty / stz
    (if (call $isop (local.get $op) (i32.const 0x85) (i32.const 4))
      (then (call $wrw (local.get $ea) (global.get $a) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0x86) (i32.const 5))
      (then (call $wrw (local.get $ea) (global.get $x) (global.get $fx))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0x84) (i32.const 6))
      (then (call $wrw (local.get $ea) (global.get $y) (global.get $fx))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0x64) (i32.const 7))
      (then (call $wrw (local.get $ea) (i32.const 0) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    ;; and / ora / eor
    (if (call $isop (local.get $op) (i32.const 0x29) (i32.const 8))
      (then (local.set $r (i32.and
               (i32.and (global.get $a) (call $wmask (global.get $fm)))
               (local.get $v)))
            (call $seta (local.get $r))
            (call $setnz (local.get $r) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0x09) (i32.const 9))
      (then (local.set $r (i32.or
               (i32.and (global.get $a) (call $wmask (global.get $fm)))
               (local.get $v)))
            (call $seta (local.get $r))
            (call $setnz (local.get $r) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0x49) (i32.const 10))
      (then (local.set $r (i32.xor
               (i32.and (global.get $a) (call $wmask (global.get $fm)))
               (local.get $v)))
            (call $seta (local.get $r))
            (call $setnz (local.get $r) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    ;; adc / sbc
    (if (call $isop (local.get $op) (i32.const 0x69) (i32.const 11))
      (then (call $iadc (local.get $v) (i32.const 0))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0xE9) (i32.const 12))
      (then (call $iadc (local.get $v) (i32.const 1))
            (call $ipc (local.get $n)) (return)))
    ;; cmp / cpx / cpy
    (if (call $isop (local.get $op) (i32.const 0xC9) (i32.const 13))
      (then (call $icmp (global.get $a) (local.get $v) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0xE0) (i32.const 14))
      (then (call $icmp (global.get $x) (local.get $v) (global.get $fx))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0xC0) (i32.const 15))
      (then (call $icmp (global.get $y) (local.get $v) (global.get $fx))
            (call $ipc (local.get $n)) (return)))
    ;; bit
    (if (call $isop (local.get $op) (i32.const 0x89) (i32.const 16))
      (then
        (global.set $fz (i32.eqz (i32.and
          (i32.and (global.get $a) (call $wmask (global.get $fm)))
          (local.get $v))))
        ;; BIT #imm touches Z ONLY; the addressed forms also set N and V
        ;; from the OPERAND's top two bits.
        (if (i32.eqz (global.get $t2)) (then
          (global.set $fn (i32.and (i32.shr_u (local.get $v)
            (call $wsign (global.get $fm))) (i32.const 1)))
          (global.set $fv (i32.and (i32.shr_u (local.get $v)
            (i32.sub (call $wsign (global.get $fm)) (i32.const 1)))
            (i32.const 1)))))
        (call $ipc (local.get $n)) (return)))
    ;; inc / dec on memory
    (if (call $isop (local.get $op) (i32.const 0xE6) (i32.const 17))
      (then (local.set $r (i32.and (i32.add (local.get $v) (i32.const 1))
                                   (call $wmask (global.get $fm))))
            (call $wrw (local.get $ea) (local.get $r) (global.get $fm))
            (call $setnz (local.get $r) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0xC6) (i32.const 18))
      (then (local.set $r (i32.and (i32.sub (local.get $v) (i32.const 1))
                                   (call $wmask (global.get $fm))))
            (call $wrw (local.get $ea) (local.get $r) (global.get $fm))
            (call $setnz (local.get $r) (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    ;; asl / lsr / rol / ror, memory or accumulator
    (if (call $isop (local.get $op) (i32.const 0x0A) (i32.const 19))
      (then (call $ishift (local.get $op) (local.get $ea) (local.get $v)
                          (local.get $n)) (return)))
    ;; tsb / trb
    (if (call $isop (local.get $op) (i32.const 0x04) (i32.const 20))
      (then (global.set $fz (i32.eqz (i32.and (local.get $v)
               (i32.and (global.get $a) (call $wmask (global.get $fm))))))
            (call $wrw (local.get $ea) (i32.or (local.get $v)
               (i32.and (global.get $a) (call $wmask (global.get $fm))))
               (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (if (call $isop (local.get $op) (i32.const 0x14) (i32.const 21))
      (then (global.set $fz (i32.eqz (i32.and (local.get $v)
               (i32.and (global.get $a) (call $wmask (global.get $fm))))))
            (call $wrw (local.get $ea) (i32.and (local.get $v)
               (i32.xor (i32.and (global.get $a)
                                 (call $wmask (global.get $fm)))
                        (i32.const -1)))
               (global.get $fm))
            (call $ipc (local.get $n)) (return)))
    (call $trap))

  ;; A is narrow-preserving: an 8-bit write keeps B, the high byte.
  (func $seta (param $v i32)
    (global.set $a (if (result i32) (global.get $fm)
      (then (i32.or (i32.and (global.get $a) (i32.const 0xFF00))
                    (i32.and (local.get $v) (i32.const 0xFF))))
      (else (i32.and (local.get $v) (i32.const 0xFFFF))))))

  (func $setnz (param $v i32) (param $f i32)
    (local.set $v (i32.and (local.get $v) (call $wmask (local.get $f))))
    (global.set $fz (i32.eqz (local.get $v)))
    (global.set $fn (i32.and (i32.shr_u (local.get $v)
      (call $wsign (local.get $f))) (i32.const 1))))

  (func $ipush (param $v i32) (param $f i32)
    (if (i32.eqz (local.get $f))
      (then (call $wr8 (i32.and (global.get $s) (i32.const 0xFFFF))
                       (i32.shr_u (local.get $v) (i32.const 8)))
            (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1))
                                    (i32.const 0xFFFF)))))
    (call $wr8 (i32.and (global.get $s) (i32.const 0xFFFF)) (local.get $v))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1))
                            (i32.const 0xFFFF))))

  (func $ipull (param $f i32) (result i32)
    (local $v i32)
    (global.set $s (i32.and (i32.add (global.get $s) (i32.const 1))
                            (i32.const 0xFFFF)))
    (local.set $v (call $rd8 (i32.and (global.get $s) (i32.const 0xFFFF))))
    (if (i32.eqz (local.get $f))
      (then (global.set $s (i32.and (i32.add (global.get $s) (i32.const 1))
                                    (i32.const 0xFFFF)))
            (local.set $v (i32.or (local.get $v)
              (i32.shl (call $rd8 (i32.and (global.get $s)
                                           (i32.const 0xFFFF)))
                       (i32.const 8))))))
    (local.get $v))

  (func $packp (result i32)
    (i32.or (i32.shl (global.get $fn) (i32.const 7)) (i32.or
    (i32.shl (global.get $fv) (i32.const 6)) (i32.or
    (i32.shl (global.get $fm) (i32.const 5)) (i32.or
    (i32.shl (global.get $fx) (i32.const 4)) (i32.or
    (i32.shl (global.get $fd) (i32.const 3)) (i32.or
    (i32.shl (global.get $fi) (i32.const 2)) (i32.or
    (i32.shl (global.get $fz) (i32.const 1)) (global.get $fc)))))))))

  (func $unpackp (param $v i32)
    (global.set $fn (i32.and (i32.shr_u (local.get $v) (i32.const 7)) (i32.const 1)))
    (global.set $fv (i32.and (i32.shr_u (local.get $v) (i32.const 6)) (i32.const 1)))
    (global.set $fm (i32.and (i32.shr_u (local.get $v) (i32.const 5)) (i32.const 1)))
    (global.set $fx (i32.and (i32.shr_u (local.get $v) (i32.const 4)) (i32.const 1)))
    (global.set $fd (i32.and (i32.shr_u (local.get $v) (i32.const 3)) (i32.const 1)))
    (global.set $fi (i32.and (i32.shr_u (local.get $v) (i32.const 2)) (i32.const 1)))
    (global.set $fz (i32.and (i32.shr_u (local.get $v) (i32.const 1)) (i32.const 1)))
    (global.set $fc (i32.and (local.get $v) (i32.const 1)))
    (call $narrowx))

  (func $idp (param $o i32) (result i32)
    (i32.and (i32.add (global.get $d) (local.get $o)) (i32.const 0xFFFF)))

  ;; Decimal-mode ADC/SBC (snes9x cpumacro.h ADC/SBC, CheckDecimal branch):
  ;; nibble by nibble with the +6/-6 corrections, V from the result before
  ;; the top-nibble correction, 8- or 16-bit by M. $v is the raw operand.
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

  (func $iadc (param $v i32) (param $sub i32)
    (local $t i32) (local $acc i32)
    (if (global.get $fd) (then (call $adc_dec (local.get $v) (local.get $sub)) (return)))
    (if (local.get $sub)
      (then (local.set $v (i32.xor (local.get $v)
                                   (call $wmask (global.get $fm))))))
    (local.set $acc (i32.and (global.get $a) (call $wmask (global.get $fm))))
    (local.set $t (i32.add (i32.add (local.get $acc) (local.get $v))
                           (global.get $fc)))
    (global.set $fv (i32.and (i32.shr_u (i32.and
      (i32.xor (local.get $acc) (i32.xor (local.get $v) (i32.const -1)))
      (i32.xor (local.get $acc) (local.get $t)))
      (call $wsign (global.get $fm))) (i32.const 1)))
    (global.set $fc (i32.gt_u (local.get $t) (call $wmask (global.get $fm))))
    (call $seta (local.get $t))
    (call $setnz (local.get $t) (global.get $fm)))

  (func $icmp (param $reg i32) (param $v i32) (param $f i32)
    (local.set $reg (i32.and (local.get $reg) (call $wmask (local.get $f))))
    (global.set $fc (i32.ge_u (local.get $reg) (local.get $v)))
    (call $setnz (i32.sub (local.get $reg) (local.get $v)) (local.get $f)))

  (func $ishift (param $op i32) (param $ea i32) (param $v i32) (param $n i32)
    (local $c i32) (local $r i32) (local $acc i32)
    (local.set $acc (i32.or (i32.eq (local.get $op) (i32.const 0x0A))
                    (i32.or (i32.eq (local.get $op) (i32.const 0x2A))
                    (i32.or (i32.eq (local.get $op) (i32.const 0x4A))
                            (i32.eq (local.get $op) (i32.const 0x6A))))))
    (if (local.get $acc)
      (then (local.set $v (i32.and (global.get $a)
                                   (call $wmask (global.get $fm))))))
    ;; The operation is the opcode's top nibble: $0x asl, $2x rol, $4x lsr,
    ;; $6x ror.
    (if (i32.lt_u (i32.and (local.get $op) (i32.const 0xF0)) (i32.const 0x40))
      (then     ;; asl or rol - shift LEFT, carry out of the sign bit
        (local.set $c (i32.and (i32.shr_u (local.get $v)
          (call $wsign (global.get $fm))) (i32.const 1)))
        (local.set $r (i32.shl (local.get $v) (i32.const 1)))
        (if (i32.eq (i32.and (local.get $op) (i32.const 0xF0))
                    (i32.const 0x20))
          (then (local.set $r (i32.or (local.get $r) (global.get $fc))))))
      (else     ;; lsr or ror - shift RIGHT, carry out of bit 0
        (local.set $c (i32.and (local.get $v) (i32.const 1)))
        (local.set $r (i32.shr_u (local.get $v) (i32.const 1)))
        (if (i32.eq (i32.and (local.get $op) (i32.const 0xF0))
                    (i32.const 0x60))
          (then (local.set $r (i32.or (local.get $r)
            (i32.shl (global.get $fc)
                     (call $wsign (global.get $fm)))))))))
    (local.set $r (i32.and (local.get $r) (call $wmask (global.get $fm))))
    (global.set $fc (local.get $c))
    (if (local.get $acc)
      (then (call $seta (local.get $r)))
      (else (call $wrw (local.get $ea) (local.get $r) (global.get $fm))))
    (call $setnz (local.get $r) (global.get $fm))
    (call $ipc (local.get $n)))
`;
}

// m65816.py interp_tables_wat() lines 955-1049
/** @param {import("./layout.js").SnesLayout} lay */
export function interpTablesWat(lay, opbase, modebase) {
  return `
  ;; Does \`op\` perform operation \`id\`? The \`base\` parameter is ignored - it
  ;; documents at the call site which opcode the id stands for.
  (func $isop (param $op i32) (param $base i32) (param $id i32) (result i32)
    (i32.eq (i32.load8_u (i32.add (i32.const ${opbase}) (local.get $op)))
            (local.get $id)))

  ;; Compute the effective address into $t3, the operand width flag into $t4
  ;; and an "is immediate" marker into $t2; return the instruction LENGTH, or
  ;; -1 for an opcode with no addressing mode this handles.
  (func $iaddr (param $op i32) (param $u8 i32) (param $u16 i32)
               (param $u24 i32) (result i32)
    (local $m i32) (local $w i32) (local $idx i32)
    (local.set $m (i32.load8_u (i32.add (i32.const ${modebase}) (local.get $op))))
    (global.set $t2 (i32.const 0))
    (global.set $t3 (i32.const 0))
    ;; WIDTH. Index operations use X, everything else uses M. \`ldx\`/\`stx\`/
    ;; \`cpx\`/\`ldy\`/\`sty\`/\`cpy\` are the index set; the table of operation ids
    ;; says which.
    (local.set $idx (i32.load8_u (i32.add (i32.const ${opbase}) (local.get $op))))
    (local.set $w (global.get $fm))
    (if (i32.or (i32.eq (local.get $idx) (i32.const 2))   ;; ldx
        (i32.or (i32.eq (local.get $idx) (i32.const 3))   ;; ldy
        (i32.or (i32.eq (local.get $idx) (i32.const 5))   ;; stx
        (i32.or (i32.eq (local.get $idx) (i32.const 6))   ;; sty
        (i32.or (i32.eq (local.get $idx) (i32.const 14))  ;; cpx
                (i32.eq (local.get $idx) (i32.const 15))))))) ;; cpy
      (then (local.set $w (global.get $fx))))
    (global.set $t4 (local.get $w))

    (if (i32.eq (local.get $m) (i32.const 18))     ;; accumulator
      (then (return (i32.const 1))))
    ;; IMMEDIATE. Its LENGTH is what the flag in force says, which is the one
    ;; place a static arm has to commit and this does not.
    (if (i32.or (i32.eq (local.get $m) (i32.const 1))
                (i32.eq (local.get $m) (i32.const 2)))
      (then (global.set $t2 (i32.const 1))
            (return (if (result i32) (local.get $w)
              (then (i32.const 2)) (else (i32.const 3))))))
    (if (i32.eq (local.get $m) (i32.const 3))      ;; dp
      (then (global.set $t3 (call $idp (local.get $u8))) (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 4))      ;; dp,x
      (then (global.set $t3 (i32.and (i32.add (call $idp (local.get $u8))
               (global.get $x)) (i32.const 0xFFFF))) (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 5))      ;; dp,y
      (then (global.set $t3 (i32.and (i32.add (call $idp (local.get $u8))
               (global.get $y)) (i32.const 0xFFFF))) (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 6))      ;; (dp)
      (then (global.set $t3 (i32.add (global.get $db24)
               (call $rd16 (call $idp (local.get $u8))))) (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 7))      ;; (dp,x)
      (then (global.set $t3 (i32.add (global.get $db24)
               (call $rd16 (i32.and (i32.add (call $idp (local.get $u8))
                 (global.get $x)) (i32.const 0xFFFF))))) (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 8))      ;; (dp),y
      (then (global.set $t3 (i32.add (i32.add (global.get $db24)
               (call $rd16 (call $idp (local.get $u8)))) (global.get $y)))
            (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 9))      ;; [dp] - bank from POINTER
      (then (global.set $t3 (call $rd24 (call $idp (local.get $u8))))
            (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 10))     ;; [dp],y
      (then (global.set $t3 (i32.and (i32.add
               (call $rd24 (call $idp (local.get $u8))) (global.get $y))
               (i32.const 0xFFFFFF))) (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 11))     ;; abs
      (then (global.set $t3 (i32.add (global.get $db24) (local.get $u16)))
            (return (i32.const 3))))
    (if (i32.eq (local.get $m) (i32.const 12))     ;; abs,x
      (then (global.set $t3 (i32.add (i32.add (global.get $db24)
               (local.get $u16)) (global.get $x))) (return (i32.const 3))))
    (if (i32.eq (local.get $m) (i32.const 13))     ;; abs,y
      (then (global.set $t3 (i32.add (i32.add (global.get $db24)
               (local.get $u16)) (global.get $y))) (return (i32.const 3))))
    (if (i32.eq (local.get $m) (i32.const 14))     ;; long
      (then (global.set $t3 (local.get $u24)) (return (i32.const 4))))
    (if (i32.eq (local.get $m) (i32.const 15))     ;; long,x
      (then (global.set $t3 (i32.and (i32.add (local.get $u24)
               (global.get $x)) (i32.const 0xFFFFFF))) (return (i32.const 4))))
    (if (i32.eq (local.get $m) (i32.const 16))     ;; dp,s - always bank 0
      (then (global.set $t3 (i32.and (i32.add (global.get $s) (local.get $u8))
               (i32.const 0xFFFF))) (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 17))     ;; (dp,s),y
      (then (global.set $t3 (i32.add (i32.add (global.get $db24)
               (call $rd16 (i32.and (i32.add (global.get $s) (local.get $u8))
                 (i32.const 0xFFFF)))) (global.get $y)))
            (return (i32.const 2))))
    (i32.const -1))
`;
}

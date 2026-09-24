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
  WRAM, ROM, SRAMB, PPUREG, HDMAST, DPWATCH, DMALOG, DMALOG_N, DMALOG_STRIDE,
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
  (global $napucc (mut i32) (i32.const 0))
  (global $napub (mut i32) (i32.const 0))
  ;; IPL boot-ROM state. See hw_snes.apu_wat(): $apuph is the IPL's own
  ;; program position, $apuptr its ARAM destination pointer ($00/$01) and
  ;; $apuctr its Y register. Nothing here advances on a clock.
  (global $apuph (mut i32) (i32.const 0))
  ;; A 16-bit \`sta $2140\` writes port 0 then port 1; $apupend holds the
  ;; port-0 value until port 1 lands so the IPL sees one whole store.
  (global $apupend (mut i32) (i32.const 0))
  (global $apupendv (mut i32) (i32.const 0))
  ;; Set when the IPL hands control to the uploaded driver; the driver's
  ;; $AA/$BB re-arm runs on the CPU's next port write, not immediately.
  (global $apurearm (mut i32) (i32.const 0))
  (global $apuptr (mut i32) (i32.const 0))
  (global $apuctr (mut i32) (i32.const 0))
  (global $wwide (mut i32) (i32.const 0))
  (global $scanline (mut i32) (i32.const 0))
  (global $nvram (mut i32) (i32.const 0))
  (global $npal (mut i32) (i32.const 0))
  (global $ndma (mut i32) (i32.const 0))
  (global $nnmi (mut i32) (i32.const 0))
  (global $nrw (mut i32) (i32.const 0))
  (global $irqline (mut i32) (i32.const 0))
  (global $nmipend (mut i32) (i32.const 0))
  (global $wai (mut i32) (i32.const 0))
  (global $hpos (mut i32) (i32.const 0))
  (global $segend (mut i32) (i32.const 0))
  (global $hdmaon (mut i32) (i32.const 0))
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

  (func $rd8 (param $a i32) (result i32)
    (local $bank i32) (local $x i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $bank (i32.shr_u (local.get $a) (i32.const 16)))
    (local.set $x (i32.and (local.get $a) (i32.const 0xFFFF)))
    ;; $7E-$7F: 128KB of work RAM, flat.
    (if (i32.and (i32.ge_u (local.get $bank) (i32.const 0x7E))
                 (i32.le_u (local.get $bank) (i32.const 0x7F)))
      (then (return (i32.load8_u (i32.add (i32.const ${WRAM})
        (i32.add (i32.shl (i32.sub (local.get $bank) (i32.const 0x7E))
                          (i32.const 16)) (local.get $x)))))))
    ;; Banks $00-$3F and $80-$BF mirror the first 8KB of work RAM at $0000,
    ;; and carry the hardware ports at $2100-$21FF and $4200-$43FF.
    (if (i32.le_u (i32.and (local.get $bank) (i32.const 0x7F))
                  (i32.const 0x3F))
      (then
        (if (i32.lt_u (local.get $x) (i32.const 0x2000))
          (then (return (i32.load8_u (i32.add (i32.const ${WRAM})
                                              (local.get $x))))))
        (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2100))
                     (i32.lt_u (local.get $x) (i32.const 0x2200)))
          (then (return (call $ppu_read (i32.and (local.get $x)
                                                 (i32.const 0xFF))))))
        (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x4200))
                     (i32.lt_u (local.get $x) (i32.const 0x4400)))
          (then (return (call $io_read (local.get $x)))))))
    ;; Everything at $8000 and above is ROM, under the LoROM map.
    (if (i32.ge_u (local.get $x) (i32.const 0x8000))
      (then (return (i32.load8_u (i32.add (i32.const ${ROM})
        (i32.rem_u (i32.add (i32.shl (i32.and (local.get $bank)
                                              (i32.const 0x7F))
                                     (i32.const 15))
                            (i32.sub (local.get $x) (i32.const 0x8000)))
                   (i32.const ${lay.romlen})))))))
    ;; Banks $70-$7D are cartridge SRAM on a LoROM board.
    (if (i32.and (i32.ge_u (i32.and (local.get $bank) (i32.const 0x7F))
                           (i32.const 0x70))
                 (i32.lt_u (i32.and (local.get $bank) (i32.const 0x7F))
                           (i32.const 0x7E)))
      (then (return (i32.load8_u (i32.add (i32.const ${SRAMB})
        (i32.and (local.get $x) (i32.const ${lay.sram})))))))
    (i32.const 0))

  (func $rd16 (param $a i32) (result i32)
    (i32.or (call $rd8 (local.get $a))
            (i32.shl (call $rd8 (i32.add (local.get $a) (i32.const 1)))
                     (i32.const 8))))

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
    ;; Publish the ACCESS WIDTH for the duration of this store. The APU
    ;; handshake needs it: the cart writes the block flag to $2141 with an
    ;; 8-BIT store and streams data through $2140 with a 16-BIT store that
    ;; hits $2141 as a side effect. The two are indistinguishable by port
    ;; or by value (data bytes are often 0 or 1), and six attempts to tell
    ;; them apart downstream each broke a working transfer. The width is
    ;; known HERE and nowhere later.
    (global.set $wwide (i32.eqz (local.get $f)))
    (if (local.get $f)
      (then (call $wr8 (local.get $a) (local.get $v)))
      (else (call $wr8 (local.get $a) (local.get $v))
            (call $wr8 (i32.add (local.get $a) (i32.const 1))
                       (i32.shr_u (local.get $v) (i32.const 8)))))
    (global.set $wwide (i32.const 0)))

  (func $wr8 (param $a i32) (param $v i32)
    (local $bank i32) (local $x i32)
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
                     (i32.and (i32.and (global.get $ptrarm)
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
    (if (i32.and (i32.ge_u (local.get $bank) (i32.const 0x7E))
                 (i32.le_u (local.get $bank) (i32.const 0x7F)))
      (then (i32.store8 (i32.add (i32.const ${WRAM})
        (i32.add (i32.shl (i32.sub (local.get $bank) (i32.const 0x7E))
                          (i32.const 16)) (local.get $x))) (local.get $v))
            (return)))
    (if (i32.le_u (i32.and (local.get $bank) (i32.const 0x7F))
                  (i32.const 0x3F))
      (then
        (if (i32.lt_u (local.get $x) (i32.const 0x2000))
          (then
            ;; WATCH THE STACK PAGE. A \`jsl\` frame that is correct at frame
            ;; 10 is gone by frame 25, so something writes $01F0-$01FF that
            ;; is not a push. Record the FIRST such writer that is not the
            ;; stack pointer itself.
            (if (i32.and (i32.and (i32.ge_u (local.get $x) (i32.const 0x01F0))
                                  (i32.le_u (local.get $x) (i32.const 0x01FF)))
                         (i32.and (i32.eqz (global.get $stkw))
                                  (i32.ne (local.get $x) (global.get $s))))
              (then (global.set $stkw (global.get $curpc))
                    (global.set $stkwa (local.get $x))))
            ;; The $00-$1F watch now lives at the TOP of $wr8, above the
            ;; bank $7E/$7F fast path, so it sees both spellings of these
            ;; addresses. It used to sit here, where it could only ever see
            ;; the bank $00-$3F mirror.
            (i32.store8 (i32.add (i32.const ${WRAM})
                              (local.get $x)) (local.get $v)) (return)))
        (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2100))
                     (i32.lt_u (local.get $x) (i32.const 0x2200)))
          (then (call $ppu_write (i32.and (local.get $x) (i32.const 0xFF))
                                 (local.get $v)) (return)))
        (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x4200))
                     (i32.lt_u (local.get $x) (i32.const 0x4400)))
          (then (call $io_write (local.get $x) (local.get $v)) (return)))))
    (if (i32.and (i32.ge_u (i32.and (local.get $bank) (i32.const 0x7F))
                           (i32.const 0x70))
                 (i32.lt_u (i32.and (local.get $bank) (i32.const 0x7F))
                           (i32.const 0x7E)))
      (then (i32.store8 (i32.add (i32.const ${SRAMB})
        (i32.and (local.get $x) (i32.const ${lay.sram}))) (local.get $v))
            (return))))

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
          (then (global.set $nmipend (i32.const 1))))
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
      (then (call $dma_run (local.get $v)) (return))))

  (func $io_read (param $r i32) (result i32)
    (local $v i32)
    ;; $4210 RDNMI: bit 7 is the NMI flag, and READING IT CLEARS the flag.
    (if (i32.eq (local.get $r) (i32.const 0x4210))
      (then (global.set $t4 (i32.or (i32.const 2) (global.get $nmiflag)))
            (global.set $nmiflag (i32.const 0))
            (return (global.get $t4))))
    ;; $4211 TIMEUP: bit 7 set when the H/V IRQ fired; reading acknowledges.
    (if (i32.eq (local.get $r) (i32.const 0x4211))
      (then (local.set $v (i32.shl (global.get $irqline) (i32.const 7)))
            (global.set $irqline (i32.const 0))
            (return (local.get $v))))
    ;; $4212 HVBJOY (snes9x REGISTER_4212).
    (if (i32.eq (local.get $r) (i32.const 0x4212))
      (then
        (local.set $v (i32.const 0))
        (if (i32.and (i32.ge_u (global.get $scanline) (i32.const 225))
                     (i32.lt_u (global.get $scanline) (i32.const 228)))
          (then (local.set $v (i32.const 1))))
        (if (i32.or (i32.ge_s (call $hnow) (i32.const 137))
                    (i32.lt_s (call $hnow) (i32.const 1)))
          (then (local.set $v (i32.or (local.get $v) (i32.const 0x40)))))
        (if (i32.ge_u (global.get $scanline) (i32.const 225))
          (then (local.set $v (i32.or (local.get $v) (i32.const 0x80)))))
        (return (local.get $v))))
    ;; Controller ports: nothing pressed (verification runs are input-free).
    (if (i32.and (i32.ge_u (local.get $r) (i32.const 0x4218))
                 (i32.le_u (local.get $r) (i32.const 0x421F)))
      (then (return (i32.const 0))))
    (i32.load8_u (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF)))))

  ;; Position inside the current line, in the 8-master-clock units the
  ;; scanline budget uses (170 per line).
  (func $hnow (result i32)
    (i32.sub (global.get $segend) (global.get $cyc)))

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
    (local $dir i32) (local $k i32) (local $p i32)
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
          (block $td (loop $tl
            (br_if $td (i32.ge_u (local.get $i) (local.get $cnt)))
            (if (local.get $dir)
              (then (call $wr8 (local.get $src)
                      (call $rd8 (i32.or (i32.const 0x2100) (i32.and
                        (i32.add (local.get $bport)
                                 (call $dmaoff (local.get $mode) (local.get $k)))
                        (i32.const 0xFF))))))
              (else (call $wr8
                (i32.or (i32.const 0x2100) (i32.and
                  (i32.add (local.get $bport)
                           (call $dmaoff (local.get $mode) (local.get $k)))
                  (i32.const 0xFF)))
                (call $rd8 (local.get $src)))))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            ;; The A-bus address walks inside its BANK.
            (local.set $src (i32.or
              (i32.and (local.get $src) (i32.const 0xFF0000))
              (i32.and (i32.add (local.get $src) (local.get $step))
                       (i32.const 0xFFFF))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $tl)))
          ;; After a transfer the count reads 0 and the address has advanced.
          (i32.store16 (i32.add (i32.const ${PPUREG + 0x80})
            (i32.and (i32.add (local.get $base) (i32.const 2)) (i32.const 0x1FF)))
            (local.get $src))
          (i32.store16 (i32.add (i32.const ${PPUREG + 0x80})
            (i32.and (i32.add (local.get $base) (i32.const 5)) (i32.const 0x1FF)))
            (i32.const 0))
          ;; 8 master clocks per byte = one unit of the scanline budget.
          (global.set $cyc (i32.sub (global.get $cyc)
                                    (i32.add (local.get $cnt) (i32.const 2))))
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

  (func $io_reg (param $r i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${PPUREG + 0x80})
      (i32.and (local.get $r) (i32.const 0x1FF)))))

  ;; ---- HDMA (snes9x dma.cpp S9xStartHDMA / S9xDoHDMA) -----------------
  ;; Per channel, HDMAST+ch*16: +0 table address (u16), +2 indirect address
  ;; (u16), +4 line counter, +5 repeat, +6 do-transfer.
  (func $hdma_linecount (param $ch i32) (result i32)
    (local $st i32) (local $base i32) (local $bank i32) (local $ad i32)
    (local $line i32)
    (local.set $st (i32.add (i32.const ${HDMAST}) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $base (i32.add (i32.const 0x4300) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $bank (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 4)))
                              (i32.const 16)))
    (local.set $ad (i32.load16_u (local.get $st)))
    (local.set $line (call $rd8 (i32.or (local.get $bank) (local.get $ad))))
    (if (i32.eqz (local.get $line))
      (then
        (i32.store8 (i32.add (local.get $st) (i32.const 5)) (i32.const 0))
        (i32.store8 (i32.add (local.get $st) (i32.const 4)) (i32.const 128))
        (i32.store16 (local.get $st) (i32.add (local.get $ad) (i32.const 1)))
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
        (i32.store16 (i32.add (local.get $st) (i32.const 2))
          (call $rd16 (i32.or (local.get $bank) (local.get $ad))))
        (local.set $ad (i32.and (i32.add (local.get $ad) (i32.const 2)) (i32.const 0xFFFF)))))
    (i32.store16 (local.get $st) (local.get $ad))
    (i32.const 1))

  (func $hdma_init
    (local $ch i32)
    (global.set $hdmaon (call $io_reg (i32.const 0x420C)))
    (local.set $ch (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $ch) (i32.const 8)))
      (i32.store8 (i32.add (i32.const ${HDMAST + 6}) (i32.shl (local.get $ch) (i32.const 4)))
                  (i32.const 0))
      (if (i32.and (global.get $hdmaon) (i32.shl (i32.const 1) (local.get $ch)))
        (then
          (i32.store16 (i32.add (i32.const ${HDMAST}) (i32.shl (local.get $ch) (i32.const 4)))
            (i32.or (call $io_reg (i32.add (i32.const 0x4302) (i32.shl (local.get $ch) (i32.const 4))))
                    (i32.shl (call $io_reg (i32.add (i32.const 0x4303)
                                (i32.shl (local.get $ch) (i32.const 4)))) (i32.const 8))))
          (if (i32.eqz (call $hdma_linecount (local.get $ch)))
            (then (global.set $hdmaon (i32.and (global.get $hdmaon)
                    (i32.xor (i32.shl (i32.const 1) (local.get $ch)) (i32.const -1))))))))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $l))))

  (func $hdma_do
    (local $ch i32) (local $st i32) (local $base i32) (local $p i32)
    (local $mode i32) (local $n i32) (local $k i32) (local $src i32)
    (local $ind i32) (local $bb i32) (local $lc i32)
    (if (i32.eqz (global.get $hdmaon)) (then (return)))
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
                              (i32.load16_u (i32.add (local.get $st) (i32.const 2)))))
                (else (i32.or (i32.shl (call $io_reg (i32.add (local.get $base) (i32.const 4)))
                                       (i32.const 16))
                              (i32.load16_u (local.get $st))))))
              (global.set $inhdma (i32.const 1))
              (local.set $k (i32.const 0))
              (block $kd (loop $kl
                (br_if $kd (i32.ge_u (local.get $k) (local.get $n)))
                (if (i32.eqz (i32.and (local.get $p) (i32.const 0x80)))
                  (then (call $wr8 (i32.or (i32.const 0x2100) (i32.and
                          (i32.add (local.get $bb) (call $dmaoff (local.get $mode) (local.get $k)))
                          (i32.const 0xFF)))
                          (call $rd8 (i32.or (i32.and (local.get $src) (i32.const 0xFF0000))
                            (i32.and (i32.add (local.get $src) (local.get $k)) (i32.const 0xFFFF)))))))
                (local.set $k (i32.add (local.get $k) (i32.const 1)))
                (br $kl)))
              (global.set $inhdma (i32.const 0))
              (global.set $cyc (i32.sub (global.get $cyc) (local.get $n)))))))
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
                (then (i32.store16 (i32.add (local.get $st) (i32.const 2))
                        (i32.add (i32.load16_u (i32.add (local.get $st) (i32.const 2))) (local.get $n))))
                (else (i32.store16 (local.get $st)
                        (i32.add (i32.load16_u (local.get $st)) (local.get $n)))))))
          (i32.store8 (i32.add (local.get $st) (i32.const 6))
            (i32.eqz (i32.load8_u (i32.add (local.get $st) (i32.const 5)))))
          (local.set $lc (i32.sub (i32.load8_u (i32.add (local.get $st) (i32.const 4))) (i32.const 1)))
          (i32.store8 (i32.add (local.get $st) (i32.const 4)) (local.get $lc))
          (if (i32.eqz (i32.and (local.get $lc) (i32.const 0xFF)))
            (then
              (if (i32.eqz (call $hdma_linecount (local.get $ch)))
                (then
                  (global.set $hdmaon (i32.and (global.get $hdmaon)
                    (i32.xor (i32.shl (i32.const 1) (local.get $ch)) (i32.const -1))))
                  (i32.store8 (i32.add (local.get $st) (i32.const 6)) (i32.const 0))))))))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $l2))))

  (func $trap
    (global.set $trapped (i32.const 1))
    (global.set $trappc (global.get $curpc)))
`;
}

// m65816.py interp_wat() lines 343-952
/** @param {import("./layout.js").SnesLayout} lay */
export function interpWat(lay) {
  return `
  ;; Fetch the byte at PC+k without disturbing PC.
  (func $ifetch (param $k i32) (result i32)
    (call $rd8 (i32.or
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
      (then (global.set $fi (i32.const 0)) (call $ipc (i32.const 1)) (return)))
    (if (i32.eq (local.get $op) (i32.const 0x78))
      (then (global.set $fi (i32.const 1)) (call $ipc (i32.const 1)) (return)))
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
      (else (local.set $v (call $rdw (local.get $ea) (local.get $w)))))

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

  (func $iadc (param $v i32) (param $sub i32)
    (local $t i32) (local $acc i32)
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

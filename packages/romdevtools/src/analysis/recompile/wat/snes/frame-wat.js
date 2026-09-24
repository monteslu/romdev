// Frame-level WAT of a recompiled SNES cart: the $step dispatcher (ROM pc
// -> arm through PCTAB, RAM pcs to the interpreter, the ROM pc ring), the
// arm-map initialiser, the wasmcart ABI exports (wc_get_info with inputPtr
// AND timePtr filled, wc_init, wc_render), NMI/IRQ entry, the scanline loop
// (render at HC 512, HDMA at HC 1106, the H/V timer IRQ) and the dbg_*
// exports and PROBE mirror the verify tooling reads.
//
// The WAT bodies are carried over byte-for-byte from sms-wat's
// emit_snes.py build(); the differential gate compares the whole emitted
// module against the Python emitter's.
//
// Plain JS ESM + JSDoc.

import {
  FB_W, FB_H, WRAM, PPUREG, INPUT, PROBE, ITRACE, PCRING, PCRING_N,
  REGWATCH, REGWATCH_N, REGWATCH_STRIDE,
} from "./layout.js";

/**
 * REGISTER WATCH probe: records (A, X, Y, P, $8D, D, [$00]) each time
 * execution reaches the 16-bit ROM address `pc` (option `regwatchPc`).
 * @param {number} pc
 */
export function regwatchWat(pc) {
  return `
    ;; REGISTER WATCH at $${(pc).toString(16).toUpperCase().padStart(4, '0')}. Records (A, X, Y, P, $8D) each
    ;; time execution reaches that address, so the VALUE behind a branch
    ;; divergence can be read out and compared with snes9x rather than
    ;; guessed from which way the branch went.
    (if (i32.and (i32.eq (i32.and (global.get $pc) (i32.const 0xFFFF))
                         (i32.const ${pc}))
                 (i32.lt_u (global.get $nrw) (i32.const ${REGWATCH_N})))
      (then
        (i32.store (i32.add (i32.const ${REGWATCH})
          (i32.mul (global.get $nrw) (i32.const ${REGWATCH_STRIDE}))) (global.get $a))
        (i32.store (i32.add (i32.add (i32.const ${REGWATCH})
          (i32.mul (global.get $nrw) (i32.const ${REGWATCH_STRIDE}))) (i32.const 4))
          (global.get $x))
        (i32.store (i32.add (i32.add (i32.const ${REGWATCH})
          (i32.mul (global.get $nrw) (i32.const ${REGWATCH_STRIDE}))) (i32.const 8))
          (global.get $y))
        (i32.store (i32.add (i32.add (i32.const ${REGWATCH})
          (i32.mul (global.get $nrw) (i32.const ${REGWATCH_STRIDE}))) (i32.const 12))
          (i32.or (i32.or (global.get $fm) (i32.shl (global.get $fx)
                                                    (i32.const 1)))
                  (i32.or (i32.shl (global.get $fz) (i32.const 2))
                          (i32.shl (global.get $fc) (i32.const 3)))))
        (i32.store (i32.add (i32.add (i32.const ${REGWATCH})
          (i32.mul (global.get $nrw) (i32.const ${REGWATCH_STRIDE}))) (i32.const 16))
          (i32.load16_u (i32.add (i32.const ${WRAM}) (i32.const 0x8D))))
        ;; D, and the 24-bit pointer the indirect-long stores go through.
        ;; Read through $rd24 at the SAME effective address the instruction
        ;; uses ($d + 0), not at absolute $0000: if D is the thing that is
        ;; wrong, reading the fixed address would hide it.
        (i32.store (i32.add (i32.add (i32.const ${REGWATCH})
          (i32.mul (global.get $nrw) (i32.const ${REGWATCH_STRIDE}))) (i32.const 20))
          (global.get $d))
        (i32.store (i32.add (i32.add (i32.const ${REGWATCH})
          (i32.mul (global.get $nrw) (i32.const ${REGWATCH_STRIDE}))) (i32.const 24))
          (call $rd24 (i32.and (global.get $d) (i32.const 0xFFFF))))
        (global.set $nrw (i32.add (global.get $nrw) (i32.const 1)))))`;
}

/**
 * options.traceEntries: the register ring entry for the instruction about to
 * run, written beside the ROM pc ring entry (same cursor, same filter). The
 * registers are the state the instruction starts from, as snes9x's dispatch
 * hook sees them.
 * @param {import("./layout.js").SnesLayout & {REGRING:number, REGRING_N:number}} lay
 */
function regRingWat(lay) {
  const at = `(i32.add (i32.const ${lay.REGRING}) (i32.shl (i32.and (global.get $npc) (i32.const ${lay.REGRING_N - 1})) (i32.const 5)))`;
  const two = (lo, hi) => `(i32.or (global.get $${lo}) (i32.shl (global.get $${hi}) (i32.const 16)))`;
  return `
                    (i32.store ${at} (global.get $pc))
                    (i32.store offset=4 ${at} ${two("a", "x")})
                    (i32.store offset=8 ${at} ${two("y", "s")})
                    (i32.store offset=12 ${at} ${two("d", "db")})
                    (i32.store offset=16 ${at} (i32.or (call $packp) (i32.shl (global.get $fe) (i32.const 8))))`;
}

/**
 * The $step function head, up to the shard dispatch.
 * @param {string} regwatch  regwatchWat() output or ''
 * @param {string} pcringExcl  WAT i32 condition: pc is outside every skipped range
 * @param {import("./layout.js").SnesLayout} lay
 */
export function stepHeadWat(regwatch, pcringExcl, lay) {
  return `
  (func $step
    (local $id i32) (local $bank i32) (local $off i32)
    ;; WAI: halted until an interrupt; burn the rest of the segment.
    (if (global.get $wai) (then (global.set $cyc (i32.const 0)) (return)))
    (global.set $curpc (global.get $pc))
    (local.set $bank (i32.and (i32.shr_u (global.get $pc) (i32.const 16))
                              (i32.const 0x7F)))
    (local.set $off (i32.and (global.get $pc) (i32.const 0xFFFF)))
    ;; CODE IN RAM. A static recompiler has no arm for it, because the bytes
    ;; do not exist until the game writes them: one LoROM cart BUILDS a
    ;; 380-byte OAM-clear routine at $7F8000 during its reset handler (the
    ;; \`lda #$F0A9 / sta $7F8000\` at $802A and the loop that follows) and
    ;; then \`jml\`s into it. With nothing here the cart trapped at $7F8000
    ;; after half a million instructions with 7,734 VRAM bytes uploaded and
    ;; nothing on screen.
    ;;
    ;; So: a small INTERPRETER, used only when the PC is outside ROM. It
    ;; shares every register, flag and memory routine with the compiled
    ;; arms, so control passes back and forth freely - a \`jsl\` from RAM into
    ;; ROM lands on a compiled arm and its \`rtl\` comes back here.
    ;; WORK RAM IS BANKS $7E AND $7F ONLY - a CLOSED range, not \`>= $7E\`.
    ;; Banks $80-$FF are the FAST MIRROR of $00-$7F, which is where most SNES
    ;; code actually runs (\`jml $808423\` is the first thing a 3MB cart
    ;; does), so an open-ended test sent every one of those to the
    ;; interpreter. The interpreter does not charge $cyc, so the scanline
    ;; budget never drained and \`wc_render\` never returned: that cart
    ;; "hung" for nine minutes on a single frame while \`dbg_step\` ran at
    ;; 30,675 steps/ms, which is what made this look like an infinite loop in
    ;; the game rather than a dispatch bug.
    ;; Record the last pc that was genuinely in ROM. Testing $off alone is
    ;; wrong: bank $7F offset $8000 passes an "off >= 0x8000" test while
    ;; being WRAM, so the probe recorded the RAM address as its own caller.
    (if (i32.and (i32.ge_u (local.get $off) (i32.const 0x8000))
                 (i32.lt_u (i32.and (i32.shr_u (global.get $pc) (i32.const 16))
                                    (i32.const 0x7F))
                           (i32.const 0x7E)))
      (then (global.set $lastrom (global.get $pc))
            ;; ROM pc ring. The excluded ranges come from PCRING_SKIP above:
            ;; each is a boot loop that runs thousands of times and would
            ;; fill the ring by itself.
            ;;
            ;; CIRCULAR, and FROZEN ON TRAP, so it holds the pcs leading UP
            ;; TO the fault. A fill-once ring answers "where did the cart
            ;; start", which is the question that is already settled: the
            ;; first 16,347 ROM instructions match snes9x exactly, and the
            ;; ring ran out 13,000 instructions before the trap at $3738
            ;; with the cart still executing correct code. The approach to
            ;; the fault is the part nothing could see.
            ;;
            ;; NOTE this ring records ROM pcs ONLY - it sits inside the
            ;; "bank < $7E and off >= $8000" guard - so a \`jsl $7F8000\` and
            ;; the whole RAM routine it calls are INVISIBLE here. A
            ;; reference trace compared against this one must be filtered
            ;; the same way, or the first call into RAM reads as a
            ;; divergence that is purely an artefact of the comparison.
            ;; The \`$trapped\` term FREEZES the ring at the fault: the cart
            ;; keeps being stepped afterwards, and a circular ring left
            ;; running would overwrite the approach with post-mortem noise.
            (if (i32.and (i32.eqz (global.get $trapped)) ${pcringExcl})
              (then (i32.store (i32.add (i32.const ${PCRING})
                      (i32.mul (i32.rem_u (global.get $npc)
                                          (i32.const ${PCRING_N}))
                               (i32.const 4)))
                      (global.get $pc))${lay.REGRING != null ? regRingWat(lay) : ""}
                    (global.set $npc
                      (i32.add (global.get $npc) (i32.const 1)))))))
    (if (i32.or (i32.lt_u (local.get $off) (i32.const 0x8000))
                (i32.and (i32.ge_u (i32.and (i32.shr_u (global.get $pc)
                                                       (i32.const 16))
                                            (i32.const 0xFF))
                                   (i32.const 0x7E))
                         (i32.le_u (i32.and (i32.shr_u (global.get $pc)
                                                       (i32.const 16))
                                            (i32.const 0xFF))
                                   (i32.const 0x7F))))
      (then
            ;; Remember where a jump into RAM came FROM. The destination
            ;; alone ("pc = $3738") says nothing about which instruction
            ;; produced it, and a bad pointer is always built somewhere else.
            ;; $curpc is the arm currently executing, which once control has
            ;; already left ROM is the RAM address itself - useless for
            ;; naming the caller. $lastrom is the last ROM pc seen, which is
            ;; the instruction that actually made the jump.
            (if (i32.eqz (global.get $ramsrc))
              (then (global.set $ramsrc (global.get $lastrom))))
            ;; Interpreter trace ring: (pc, opcode, S) for the first 64
            ;; interpreted instructions. A stack that ends 9 bytes low after
            ;; a routine containing NO push/pull opcodes means the
            ;; interpreter pushed something on its own; only a per-instruction
            ;; record names which one.
            (if (i32.lt_u (global.get $ninterp) (i32.const 160))
              (then
                (i32.store (i32.add (i32.const ${ITRACE})
                  (i32.mul (global.get $ninterp) (i32.const 12)))
                  (global.get $pc))
                (i32.store (i32.add (i32.add (i32.const ${ITRACE})
                  (i32.mul (global.get $ninterp) (i32.const 12))) (i32.const 4))
                  (call $rd8 (global.get $pc)))
                (i32.store (i32.add (i32.add (i32.const ${ITRACE})
                  (i32.mul (global.get $ninterp) (i32.const 12))) (i32.const 8))
                  (global.get $s))))
            (call $interp)
            (global.set $ninterp (i32.add (global.get $ninterp) (i32.const 1)))
            ;; THE INTERPRETER MUST CHARGE CYCLES TOO. Without this, any
            ;; loop running out of RAM spins forever inside wc_render,
            ;; because the scanline budget only drains in the compiled arms.
            ;; A flat 6 is an average, not a per-opcode cost - the arms carry
            ;; the real figures, and RAM code is a rounding error next to
            ;; them.
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))
            (return)))
${regwatch}
    (local.set $off (i32.rem_u
      (i32.add (i32.shl (local.get $bank) (i32.const 15))
               (i32.sub (local.get $off) (i32.const 0x8000)))
      (i32.const ${lay.romlen})))
    (local.set $id (i32.load (i32.add (i32.const ${lay.PCTAB})
      (i32.mul (local.get $off) (i32.const 4)))))
    ;; No arm at this offset: interpret it rather than trap. $interp traps
    ;; on anything it cannot execute, so a wild pc still stops the cart.
    (if (i32.eqz (local.get $id))
      (then (call $interp)
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))
            (return)))
    (local.set $id (i32.sub (local.get $id) (i32.const 1)))
`;
}

/**
 * $initmap, the ABI exports, interrupts, the scanline loop and dbg_* exports.
 * @param {import("./layout.js").SnesLayout} lay
 */
export function frameWat(lay) {
  return `
  (func $initmap
    (local $i i32) (local $p i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${lay.narms})))
      (local.set $p (i32.add (i32.const ${lay.PACKED})
                             (i32.mul (local.get $i) (i32.const 8))))
      (i32.store (i32.add (i32.const ${lay.PCTAB})
        (i32.mul (i32.load (local.get $p)) (i32.const 4)))
        (i32.load (i32.add (local.get $p) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func (export "wc_get_info") (result i32)
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 0))  (i32.const 3))
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 4))  (i32.const ${FB_W}))
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 8))  (i32.const ${FB_H}))
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 12)) (i32.const ${lay.FB}))
    ;; inputPtr (WCInfo field 7, byte 28). MUST be a real address: the host
    ;; writes 64 bytes of pad state here every frame WITHOUT checking for
    ;; zero, so leaving it 0 scribbles over WASM offset 0 - the SNES direct
    ;; page - and corrupts $00-$3F between frames.
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 28)) (i32.const ${INPUT}))
    ;; timePtr (WCInfo field 10, byte 40). THE SAME CONTRACT AS inputPtr.
    ;; \`CartHost._writeTime\` stores two f64 and a u32 through this pointer
    ;; every frame with NO zero check (unlike hostInfoPtr/pointerPtr/keysPtr,
    ;; which are all validated), so leaving it 0 writes 20 bytes over WASM
    ;; offset 0 every frame:
    ;;   bytes  0-7  timeMs (f64)   bytes 8-15 deltaMs (f64)
    ;;   bytes 16-19 frame  (u32)
    ;; On the NES cart that was NES $0000-$0013 - the zero page - and it held
    ;; one cart's PPUCTRL shadow at $10, so PPUCTRL tracked the host frame
    ;; counter instead of holding $90 and the background base cycled through
    ;; all four nametables. Fixing it took that cart from 58.68% to 100.00%.
    ;; MUST be 8-byte aligned: the host writes f64 via a Float64Array index.
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 40)) (i32.add (i32.const ${lay.ABI}) (i32.const 0x180)))
    (i32.const ${lay.ABI}))

  (func (export "wc_init")
    (call $initmap)
    (global.set $s (i32.const 0x01FF))
    (global.set $fi (i32.const 1))
    (global.set $fm (i32.const 1))
    (global.set $fx (i32.const 1))
    (global.set $fe (i32.const 1))
    (call $setdb (i32.const 0))
    ;; The SPC700's IPL ROM holds $AA/$BB in ports 0/1 from its own reset.
    ;; The boot code's first act is to compare against exactly that.
    (i32.store8 (i32.const 198912) (i32.const 0xAA))
    (i32.store8 (i32.const 198913) (i32.const 0xBB))
    ;; RESET vector at $FFFC in bank 0, which on a LoROM board is the last
    ;; word of the first 32KB slice.
    (global.set $pc (call $rd16 (i32.const 0xFFFC))))

  (func $nmi
    (global.set $wai (i32.const 0))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))
    (global.set $nnmi (i32.add (global.get $nnmi) (i32.const 1)))
    ;; Native-mode NMI pushes PB, the 16-bit PC and P, then vectors through
    ;; $FFEA. The bank byte goes FIRST - pushing it last leaves the \`rti\`
    ;; reassembling the address out of the wrong two bytes.
    (call $wr8 (global.get $s) (i32.shr_u (global.get $pc) (i32.const 16)))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1))
                            (i32.const 0xFFFF)))
    (call $wr8 (global.get $s)
      (i32.and (i32.shr_u (global.get $pc) (i32.const 8)) (i32.const 0xFF)))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1))
                            (i32.const 0xFFFF)))
    (call $wr8 (global.get $s) (i32.and (global.get $pc) (i32.const 0xFF)))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1))
                            (i32.const 0xFFFF)))
    (call $wr8 (global.get $s) (i32.or
      (i32.shl (global.get $fn) (i32.const 7)) (i32.or
      (i32.shl (global.get $fv) (i32.const 6)) (i32.or
      (i32.shl (global.get $fm) (i32.const 5)) (i32.or
      (i32.shl (global.get $fx) (i32.const 4)) (i32.or
      (i32.shl (global.get $fd) (i32.const 3)) (i32.or
      (i32.shl (global.get $fi) (i32.const 2)) (i32.or
      (i32.shl (global.get $fz) (i32.const 1)) (global.get $fc)))))))))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1))
                            (i32.const 0xFFFF)))
    (global.set $fi (i32.const 1))
    (global.set $fd (i32.const 0))
    (global.set $pc (call $rd16 (i32.const 0xFFEA))))

  ;; Run the CPU until the line position reaches $t (170 units per line).
  ;; An instruction or DMA that overshoots leaves a debt carried in $hpos,
  ;; so a long DMA really does cost the lines it spans.
  (func $run_to (param $t i32)
    (global.set $segend (local.get $t))
    (global.set $cyc (i32.sub (local.get $t) (global.get $hpos)))
    (block $d (loop $l
      (br_if $d (global.get $trapped))
      (if (global.get $nmipend)
        (then (global.set $nmipend (i32.const 0)) (call $nmi)))
      (if (i32.and (global.get $irqline) (i32.eqz (global.get $fi)))
        (then (call $irq)))
      (br_if $d (i32.le_s (global.get $cyc) (i32.const 0)))
      (call $step)
      (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
      (br $l)))
    (global.set $hpos (i32.sub (local.get $t) (global.get $cyc))))

  (func $irq
    (global.set $wai (i32.const 0))
    (call $wr8 (global.get $s) (i32.shr_u (global.get $pc) (i32.const 16)))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))
    (call $wr8 (global.get $s)
      (i32.and (i32.shr_u (global.get $pc) (i32.const 8)) (i32.const 0xFF)))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))
    (call $wr8 (global.get $s) (i32.and (global.get $pc) (i32.const 0xFF)))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))
    (call $wr8 (global.get $s) (i32.or
      (i32.shl (global.get $fn) (i32.const 7)) (i32.or
      (i32.shl (global.get $fv) (i32.const 6)) (i32.or
      (i32.shl (global.get $fm) (i32.const 5)) (i32.or
      (i32.shl (global.get $fx) (i32.const 4)) (i32.or
      (i32.shl (global.get $fd) (i32.const 3)) (i32.or
      (i32.shl (global.get $fi) (i32.const 2)) (i32.or
      (i32.shl (global.get $fz) (i32.const 1)) (global.get $fc)))))))))
    (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))
    (global.set $fi (i32.const 1))
    (global.set $fd (i32.const 0))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))
    (global.set $pc (call $rd16 (i32.const 0xFFEE))))

  ;; H/V timer IRQ position on line $ln in scanline units, or 999.
  (func $irqpos (param $ln i32) (result i32)
    (local $en i32) (local $vt i32) (local $ht i32) (local $p i32)
    (local.set $en (i32.and (call $io_reg (i32.const 0x4200)) (i32.const 0x30)))
    (if (i32.eqz (local.get $en)) (then (return (i32.const 999))))
    (local.set $vt (i32.or (call $io_reg (i32.const 0x4209))
      (i32.shl (i32.and (call $io_reg (i32.const 0x420A)) (i32.const 1)) (i32.const 8))))
    (local.set $ht (i32.or (call $io_reg (i32.const 0x4207))
      (i32.shl (i32.and (call $io_reg (i32.const 0x4208)) (i32.const 1)) (i32.const 8))))
    (local.set $p (i32.shr_u (i32.add (i32.shl (local.get $ht) (i32.const 2)) (i32.const 14))
                             (i32.const 3)))
    (if (i32.eq (local.get $en) (i32.const 0x20))
      (then (return (if (result i32) (i32.eq (local.get $ln) (local.get $vt))
        (then (i32.const 1)) (else (i32.const 999))))))
    (if (i32.gt_u (local.get $p) (i32.const 169)) (then (return (i32.const 999))))
    (if (i32.eq (local.get $en) (i32.const 0x10)) (then (return (local.get $p))))
    (if (result i32) (i32.eq (local.get $ln) (local.get $vt))
      (then (local.get $p)) (else (i32.const 999))))

  ;; One segment of a line: run to $t, firing the timer IRQ on the way if it
  ;; falls inside. Returns the IRQ position still pending.
  (func $seg (param $t i32) (param $ip i32) (result i32)
    (if (i32.le_s (local.get $ip) (local.get $t))
      (then (call $run_to (local.get $ip))
            (global.set $irqline (i32.const 1))
            (local.set $ip (i32.const 999))))
    (call $run_to (local.get $t))
    (local.get $ip))

  (func $line (param $ln i32)
    (local $ip i32)
    (global.set $scanline (local.get $ln))
    (if (i32.eqz (local.get $ln))
      (then (global.set $nmiflag (i32.const 0))
            (global.set $cyc (i32.const 0))
            (call $hdma_init)
            (global.set $hpos (i32.sub (global.get $hpos) (global.get $cyc)))))
    (if (i32.eq (local.get $ln) (i32.const 1))
      (then (global.set $mosstart (i32.const 0))))
    (if (i32.eq (local.get $ln) (i32.const 225))
      (then
        (global.set $nmiflag (i32.const 0x80))
        (global.set $hdmaon (i32.const 0))
        (global.set $maxbright (i32.and (i32.load8_u (i32.const ${PPUREG}))
                                        (i32.const 15)))
        (if (i32.eqz (global.get $fblank)) (then (call $oam_vblank_reset)))
        (if (i32.and (i32.ne (global.get $nmien) (i32.const 0))
                     (i32.eqz (global.get $trapped)))
          (then (global.set $nmipend (i32.const 1))))))
    (local.set $ip (call $irqpos (local.get $ln)))
    ;; snes9x renders a row at HC 512 of line V (row V-1): 64 units.
    (local.set $ip (call $seg (i32.const 64) (local.get $ip)))
    (if (i32.and (i32.ge_u (local.get $ln) (i32.const 1))
                 (i32.le_u (local.get $ln) (i32.const ${FB_H})))
      (then (call $render_row (i32.sub (local.get $ln) (i32.const 1)))))
    ;; HDMA at HC 1106 (138 units), for lines 0-224.
    (local.set $ip (call $seg (i32.const 138) (local.get $ip)))
    (if (i32.le_u (local.get $ln) (i32.const 224))
      (then (global.set $cyc (i32.const 0))
            (call $hdma_do)
            (global.set $hpos (i32.sub (global.get $hpos) (global.get $cyc)))))
    (drop (call $seg (i32.const 170) (local.get $ip)))
    (global.set $hpos (i32.sub (global.get $hpos) (i32.const 170))))

  (func (export "wc_render")
    (local $ln i32) (local $i i32)
    (local.set $ln (i32.const 0))
    (block $fd (loop $fl
      (br_if $fd (i32.ge_u (local.get $ln) (i32.const 262)))
      (call $line (local.get $ln))
      (local.set $ln (i32.add (local.get $ln) (i32.const 1)))
      (br $fl)))
    ;; LIVENESS PROBE BLOCK at $3F000, mirrored every frame.
    ;; Globals are invisible to a host: \`wasm read\` reads LINEAR
    ;; MEMORY, so a counter kept only in a global cannot be seen through the
    ;; real wasmcart host - which is exactly the introspection needed to tell
    ;; "the cart is stuck" from "the cart never ran".
    (i32.store (i32.const ${PROBE + 0}) (global.get $steps))
    (i32.store (i32.const ${PROBE + 4}) (global.get $nvram))
    (i32.store (i32.const ${PROBE + 8}) (global.get $trapped))
    (i32.store (i32.const ${PROBE + 12}) (global.get $trappc))
    (i32.store (i32.const ${PROBE + 16}) (global.get $pc))
    (i32.store (i32.const ${PROBE + 20}) (global.get $nnmi))
    (i32.store (i32.const ${PROBE + 24}) (global.get $ndma))
    (i32.store (i32.const ${PROBE + 28}) (global.get $npal))
    (i32.store (i32.const ${PROBE + 32}) (global.get $ramsrc))
    (i32.store (i32.const ${PROBE + 36}) (global.get $s))
    (i32.store (i32.const ${PROBE + 40}) (global.get $ninterp))
    (i32.store (i32.const ${PROBE + 44}) (global.get $napuw))
    (i32.store (i32.const ${PROBE + 48}) (global.get $napucc))
    (i32.store (i32.const ${PROBE + 52}) (global.get $apuph))
    (i32.store (i32.const ${PROBE + 56}) (global.get $stkw))
    (i32.store (i32.const ${PROBE + 60}) (global.get $stkwa))
    ;; The circular pc ring's WRITE CURSOR. Without it the ring is a bag of
    ;; pcs with no order: the oldest entry is at $npc % PCRING_N, not at 0,
    ;; and reading it as a flat array splices the newest pcs in front of the
    ;; oldest at an arbitrary point.
    (i32.store (i32.const ${PROBE + 64}) (global.get $npc))
    (i32.store (i32.const ${PROBE + 68}) (global.get $nrw))
    (i32.store (i32.const ${PROBE + 72}) (global.get $ptrw))
    (i32.store (i32.const ${PROBE + 76}) (global.get $ptrwa))
    (i32.store (i32.const ${PROBE + 80}) (global.get $ptrwv))
    (i32.store (i32.const ${PROBE + 84}) (global.get $ptrwy))
    (i32.store (i32.const ${PROBE + 88}) (global.get $ptrarm))
    (i32.store (i32.const ${PROBE + 92}) (global.get $nptrw))
    (i32.store (i32.const ${PROBE + 96}) (global.get $ptrw1))
    (i32.store (i32.const ${PROBE + 100}) (global.get $ptrwv1))
    (i32.store (i32.const ${PROBE + 104}) (global.get $ptrwy1))
    (i32.store (i32.const ${PROBE + 108}) (global.get $nptrw1))
    ;; IPL BOOT-ROM STATE, appended at the true end of the block.
    ;; Twice now a new field was parked on an offset that a LATER line in
    ;; this same mirror already used - PROBE+56/60 ($stkw/$stkwa) and then
    ;; PROBE+72..80 ($ptrw/$ptrwa/$ptrwv) - and both times the field read
    ;; back as a clean zero rather than as an error, which reads exactly
    ;; like "the IPL never ran". _check_probe_layout() guards the REGIONS;
    ;; nothing guards offsets inside one, so the rule is: append, and keep
    ;; PROBE_N equal to the highest offset used, divided by four, plus one.
    (i32.store (i32.const ${PROBE + 112}) (global.get $napub))
    (i32.store (i32.const ${PROBE + 116}) (global.get $apuptr))
    (i32.store (i32.const ${PROBE + 120}) (global.get $apuctr))
    )

  (func (export "dbg_pc") (result i32) (global.get $pc))
  (func (export "dbg_curpc") (result i32) (global.get $curpc))
  (func (export "dbg_trapped") (result i32) (global.get $trapped))
  (func (export "dbg_trappc") (result i32) (global.get $trappc))
  (func (export "dbg_steps") (result i32) (global.get $steps))
  (func (export "dbg_step") (call $step))
  (func (export "dbg_a") (result i32) (global.get $a))
  (func (export "dbg_x") (result i32) (global.get $x))
  (func (export "dbg_y") (result i32) (global.get $y))
  (func (export "dbg_s") (result i32) (global.get $s))
  (func (export "dbg_d") (result i32) (global.get $d))
  (func (export "dbg_db") (result i32) (global.get $db))
  (func (export "dbg_fm") (result i32) (global.get $fm))
  (func (export "dbg_fx") (result i32) (global.get $fx))
  (func (export "dbg_fe") (result i32) (global.get $fe))
  (func (export "dbg_vaddr") (result i32) (global.get $vaddr))
  (func (export "dbg_nvram") (result i32) (global.get $nvram))
  (func (export "dbg_npal") (result i32) (global.get $npal))
  (func (export "dbg_ndma") (result i32) (global.get $ndma))
  (func (export "dbg_nnmi") (result i32) (global.get $nnmi))
  (func (export "dbg_apuph") (result i32) (global.get $apuph))
  (func (export "dbg_apuptr") (result i32) (global.get $apuptr))
  (func (export "dbg_apuctr") (result i32) (global.get $apuctr))
  (func (export "dbg_napuw") (result i32) (global.get $napuw))
  (func (export "dbg_napub") (result i32) (global.get $napub))
  (func (export "dbg_scanline") (result i32) (global.get $scanline))
  (func (export "dbg_cyc") (result i32) (global.get $cyc))
  ;; Run ONE scanline of the frame loop, so a hang inside wc_render can be
  ;; located a line at a time instead of by waiting on the whole frame.
  (func (export "dbg_line") (param $ln i32)
    (call $line (local.get $ln)))
`;
}

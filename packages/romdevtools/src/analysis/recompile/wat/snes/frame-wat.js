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
  FB_W, FB_H, WRAM, PPUREG, INPUT, PROBE, ITRACE, PCRING, PCRING_N, MAPTAB, ROM, SRAMB, HDMAST, AUDIO, AUDIO_FRAMES, ICOST,
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
          (i32.or (call $rd8m (i32.and (global.get $d) (i32.const 0xFFFF)))
            (i32.or (i32.shl (call $rd8m (i32.and (i32.add (global.get $d) (i32.const 1)) (i32.const 0xFFFF))) (i32.const 8))
                    (i32.shl (call $rd8m (i32.and (i32.add (global.get $d) (i32.const 2)) (i32.const 0xFFFF))) (i32.const 16)))))
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
                    (i32.store offset=16 ${at} (i32.or (call $packp) (i32.shl (global.get $fe) (i32.const 8))))
                    (i32.store offset=20 ${at} (i32.add (i32.mul (global.get $scanline) (global.get $hmax)) (call $hnow)))`;
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
    (local $id i32) (local $bank i32) (local $off i32) (local $e i32) (local $isrom i32)
    ;; WAI: snes9x leaves the PC on the WAI and executes it again every
    ;; turn of the main loop (an opcode fetch and an internal cycle) until an
    ;; interrupt wakes it, so the wait advances 14 clocks at a time.
    (if (global.get $wai)
      (then (global.set $cyc (i32.sub (global.get $cyc) (i32.add (global.get $ms) (i32.const 6))))
            (return)))
    (global.set $curpc (global.get $pc))
    (global.set $istart (call $hnow))
    (local.set $bank (i32.and (i32.shr_u (global.get $pc) (i32.const 16))
                              (i32.const 0x7F)))
    (local.set $off (i32.and (global.get $pc) (i32.const 0xFFFF)))
    ;; Where the pc points, by the CPU bus map: only a ROM block has arms.
    (local.set $e (i32.add (i32.const ${MAPTAB})
      (i32.shl (i32.shr_u (i32.and (global.get $pc) (i32.const 0xFFFFFF)) (i32.const 12)) (i32.const 3))))
    (local.set $isrom (i32.eq (i32.load (local.get $e)) (i32.const 1)))
    ;; snes9x CPU.MemSpeed: what each program byte of this instruction costs.
    (global.set $ms (call $speed (i32.and (global.get $pc) (i32.const 0xFFFFFF))))
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
    ;; The ring keeps ROM pcs at $8000+ (the verify ops' "snesLoRom" filter
    ;; leaves the same ones out of the reference stream).
    (if (i32.and (local.get $isrom) (i32.ge_u (local.get $off) (i32.const 0x8000)))
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
    (if (i32.eqz (local.get $isrom))
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
                  (call $rd8m (global.get $pc)))
                (i32.store (i32.add (i32.add (i32.const ${ITRACE})
                  (i32.mul (global.get $ninterp) (i32.const 12))) (i32.const 8))
                  (global.get $s))))
            ;; $istep charges the interpreted instruction as an arm would
            ;; be charged: without it a loop in RAM never drains the line.
            (call $istep)
            (global.set $ninterp (i32.add (global.get $ninterp) (i32.const 1)))
            (return)))
${regwatch}
    ;; ROM file offset of the pc: the block's base plus the offset in it.
    (local.set $off (i32.add (i32.sub (i32.load offset=4 (local.get $e)) (i32.const ${ROM}))
                             (i32.and (global.get $pc) (i32.const 0xFFF))))
    (local.set $id (i32.load (i32.add (i32.const ${lay.PCTAB})
      (i32.mul (local.get $off) (i32.const 4)))))
    ;; No arm at this offset: interpret it rather than trap. $interp traps
    ;; on anything it cannot execute, so a wild pc still stops the cart.
    (if (i32.eqz (local.get $id))
      (then (call $istep)
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
    ;; audioPtr / audioCap / audioWritePtr and audio_sample_rate: the S-DSP's
    ;; 32040 Hz stereo int16 ring (apu-wat.js $apu_out).
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 16)) (i32.const ${AUDIO}))
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 20)) (i32.const ${AUDIO_FRAMES}))
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 24)) (i32.const ${lay.ABI + 0x100}))
    (i32.store (i32.add (i32.const ${lay.ABI}) (i32.const 52)) (i32.const 32040))
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
    (local $i i32)
    (call $initmap)
    ;; snes9x S9xReset: work RAM powers on as $55 (cpu.cpp memset), not zero.
    ;; Games that read a byte before writing it see $55.
    (memory.fill (i32.const ${WRAM}) (i32.const 0x55) (i32.const 0x20000))
    ;; snes9x ClearSRAM: cartridge SRAM powers on as $60.
    (memory.fill (i32.const ${SRAMB}) (i32.const 0x60) (i32.const 0x8000))
    ;; snes9x S9xResetPPU / S9xResetDMA register state that the cart keeps
    ;; in its shadow: WRIO/RDIO $FF, both windows empty (left 1 > right 0),
    ;; the H/V IRQ positions $1FF, every DMA channel register $FF and each
    ;; HDMA line counter $7F without repeat.
    (i32.store8 (i32.const ${PPUREG + 0x80 + 0x01}) (i32.const 0xFF))
    (i32.store8 (i32.const ${PPUREG + 0x80 + 0x13}) (i32.const 0xFF))
    (i32.store16 (i32.const ${PPUREG + 0x80 + 0x07}) (i32.const 0x1FF))
    (i32.store16 (i32.const ${PPUREG + 0x80 + 0x09}) (i32.const 0x1FF))
    (i32.store8 (i32.const ${PPUREG + 0x26}) (i32.const 1))
    (i32.store8 (i32.const ${PPUREG + 0x28}) (i32.const 1))
    (memory.fill (i32.const ${PPUREG + 0x80 + 0x100}) (i32.const 0xFF) (i32.const 0x80))
    (local.set $i (i32.const 0))
    (block $hd (loop $hl
      (br_if $hd (i32.ge_u (local.get $i) (i32.const 8)))
      (i32.store8 (i32.add (i32.const ${HDMAST + 4}) (i32.shl (local.get $i) (i32.const 4))) (i32.const 0x7F))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $hl)))
    (global.set $s (i32.const 0x01FF))
    (global.set $fi (i32.const 1))
    (global.set $fm (i32.const 1))
    (global.set $fx (i32.const 1))
    (global.set $fe (i32.const 1))
    (call $setdb (i32.const 0))
    ;; snes9x S9xSoftResetCPU: CPU.Cycles = 182, "the cycle count just after
    ;; the jump to the Reset Vector", and then its own S9xGetWord($FFFC)
    ;; charges the vector read (two ROM bytes, 16): the first instruction
    ;; starts 198 master clocks into line 0 while the APU's reference is 0.
    (global.set $hpos (i32.const 198))
    ;; APU power-on: the SPC700 starts in its IPL ROM, which puts $AA/$BB in
    ;; ports 0/1 a few hundred SPC clocks later.
    (call $apu_power)
    ;; RESET vector at $FFFC in bank 0, which on a LoROM board is the last
    ;; word of the first 32KB slice.
    (global.set $pc (call $rd16 (i32.const 0xFFFC))))

  (func $nmi
    (global.set $wai (i32.const 0))
    ;; snes9x S9xOpcode_NMI: an opcode fetch and an internal cycle, then the
    ;; pushes and the vector read (charged by $wr8/$rd8).
    (global.set $cyc (i32.sub (global.get $cyc) (i32.add (global.get $ms) (i32.const 6))))
    ;; (one AddCycles: an event it reaches happens right here)
    (call $ev_due)
    (global.set $nnmi (i32.add (global.get $nnmi) (i32.const 1)))
    ;; Native-mode NMI pushes PB, the 16-bit PC and P, then vectors through
    ;; $FFEA. The bank byte goes FIRST - pushing it last leaves the \`rti\`
    ;; reassembling the address out of the wrong two bytes.
    ;; (Emulation mode pushes no bank and uses the $FFFA vector.)
    (if (i32.eqz (global.get $fe)) (then
      (call $wr8 (global.get $s) (i32.shr_u (global.get $pc) (i32.const 16)))
      (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1))
                              (i32.const 0xFFFF)))))
    ;; PushW(PC): one word access (snes9x S9xOpcode_NMI).
    (call $push16 (i32.and (global.get $pc) (i32.const 0xFFFF)))
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
    (global.set $pc (call $rd16 (if (result i32) (global.get $fe) (then (i32.const 0xFFFA)) (else (i32.const 0xFFEA))))))

  ;; Run the CPU until the frame ends (snes9x S9xMainLoop). Time is the
  ;; position in the current line, $hnow = $segend - $cyc, where $segend is
  ;; the next event ($evk); every charge lowers $cyc, and an event is
  ;; processed as soon as the clock reaches it: inside the access or DMA
  ;; byte that carried it there, or here at the instruction boundary. The
  ;; line-end event moves to the next line itself, so an instruction or a
  ;; DMA can run across any number of lines and every event on the way
  ;; happens where snes9x has it (the APU catch-up at each line end among
  ;; them). The frame ends at the first boundary after vblank begins
  ;; (SCAN_KEYS_FLAG), after that boundary's NMI and IRQ checks.
  (func $run_frame
    (block $d (loop $l
      ;; A trapped cart runs no code; time still passes to the frame end.
      (if (i32.and (global.get $trapped) (i32.gt_s (global.get $cyc) (i32.const 0)))
        (then (global.set $cyc (i32.const 0))))
      ;; Events the last instruction's fetch or internal cycles crossed.
      (if (i32.le_s (global.get $cyc) (i32.const 0))
        (then (call $ev_process (call $evpos (call $hnow)))
              (call $ev_due)))
      ;; snes9x S9xMainLoop: a pending NMI is taken at the first instruction
      ;; boundary at or past its trigger position; WAI wakes 14 clocks later
      ;; (TWO_CYCLES + half a dot), and the events that crosses happen then.
      (if (i32.and (global.get $nmipend) (i32.ge_s (call $hnow) (global.get $nmipos)))
        (then (global.set $nmipend (i32.const 0))
              (if (global.get $wai) (then (global.set $wai (i32.const 0))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 14)))
                (call $ev_due)))
              (call $apply_ichg)
              (call $nmi)))
      ;; The H/V timer (snes9x Timings.NextIRQTimer) is looked at here only.
      (if (i32.ge_s (call $hnow) (global.get $ipos))
        (then (global.set $ipos (i32.const 99999))
              (global.set $irqline (i32.const 1))))
      ;; An IRQ line wakes WAI even with I set.
      (if (i32.and (global.get $irqline) (global.get $wai))
        (then (global.set $wai (i32.const 0))
              (global.set $cyc (i32.sub (global.get $cyc) (i32.const 14)))
              (call $ev_due)))
      (if (i32.and (global.get $irqline) (i32.eqz (global.get $fi)))
        (then (call $apply_ichg) (call $irq)))
      ;; CLI / SEI change I one instruction late (snes9x IRQFlagChanging):
      ;; the check above still saw the old flag.
      (call $apply_ichg)
      (br_if $d (global.get $fdone))
      (if (i32.gt_s (global.get $cyc) (i32.const 0))
        (then (if (i32.eqz (global.get $trapped))
          (then (call $step)
                (global.set $steps (i32.add (global.get $steps) (i32.const 1)))))))
      (br $l))))

  ;; snes9x CHECK_FOR_IRQ_CHANGE: Timings.IRQFlagChanging applied at the
  ;; boundary. Bit 0 CLI, bit 1 SEI, bit 2 an NMI enabled during vblank
  ;; (IRQ_TRIGGER_NMI: pending from here, triggered 6 clocks on).
  (func $apply_ichg
    (if (global.get $ichg)
      (then (if (i32.and (global.get $ichg) (i32.const 4))
              (then (global.set $nmipend (i32.const 1))
                    (global.set $nmipos (i32.add (call $hnow) (i32.const 6)))))
            (if (i32.and (global.get $ichg) (i32.const 1))
              (then (global.set $fi (i32.const 0)))
              (else (if (i32.and (global.get $ichg) (i32.const 2))
                (then (global.set $fi (i32.const 1))))))
            (global.set $ichg (i32.const 0)))))

  (func $irq
    (global.set $wai (i32.const 0))
    ;; snes9x S9xOpcode_IRQ: an opcode fetch and an internal cycle (one
    ;; AddCycles, so an event it reaches happens right here), then the
    ;; pushes and the vector read (charged by $wr8/$rd16).
    (global.set $cyc (i32.sub (global.get $cyc) (i32.add (global.get $ms) (i32.const 6))))
    (call $ev_due)
    (if (i32.eqz (global.get $fe)) (then
      (call $wr8 (global.get $s) (i32.shr_u (global.get $pc) (i32.const 16)))
      (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))))
    (call $push16 (i32.and (global.get $pc) (i32.const 0xFFFF)))
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
    (global.set $pc (call $rd16 (if (result i32) (global.get $fe) (then (i32.const 0xFFFE)) (else (i32.const 0xFFEE))))))

  ;; H/V timer IRQ position on line $ln in master clocks, or 99999
  ;; (snes9x S9xUpdateIRQPositions: HTIME dots x 4 + IRQTriggerCycles 14,
  ;; minus a dot at HTIME 0, plus half a dot past dots 322 and 326; a V-only
  ;; IRQ fires at 14 - 4).
  (func $irqpos (param $ln i32) (result i32)
    (local $en i32) (local $vt i32) (local $ht i32) (local $p i32)
    (local.set $en (i32.and (call $io_reg (i32.const 0x4200)) (i32.const 0x30)))
    (if (i32.eqz (local.get $en)) (then (return (i32.const 99999))))
    (local.set $vt (i32.or (call $io_reg (i32.const 0x4209))
      (i32.shl (i32.and (call $io_reg (i32.const 0x420A)) (i32.const 1)) (i32.const 8))))
    (local.set $ht (i32.or (call $io_reg (i32.const 0x4207))
      (i32.shl (i32.and (call $io_reg (i32.const 0x4208)) (i32.const 1)) (i32.const 8))))
    (local.set $p (i32.add (i32.shl (local.get $ht) (i32.const 2)) (i32.const 14)))
    (if (i32.eqz (local.get $ht)) (then (local.set $p (i32.sub (local.get $p) (i32.const 4)))))
    (if (i32.gt_u (local.get $ht) (i32.const 322)) (then (local.set $p (i32.add (local.get $p) (i32.const 2)))))
    (if (i32.gt_u (local.get $ht) (i32.const 326)) (then (local.set $p (i32.add (local.get $p) (i32.const 2)))))
    (if (i32.eq (local.get $en) (i32.const 0x20))
      (then (return (if (result i32) (i32.eq (local.get $ln) (local.get $vt))
        (then (i32.const 10)) (else (i32.const 99999))))))
    (if (i32.ge_u (local.get $p) (global.get $hmax)) (then (return (i32.const 99999))))
    (if (i32.eq (local.get $en) (i32.const 0x10)) (then (return (local.get $p))))
    (if (result i32) (i32.eq (local.get $ln) (local.get $vt))
      (then (local.get $p)) (else (i32.const 99999))))

  ;; The next event after kind $k (0 = the line has just begun) in this
  ;; line, snes9x S9xReschedule without its no-op events: HDMA table
  ;; reload at HC 20 (line 0 only), row render at HC 512 (row V-1), DRAM
  ;; refresh (40 clocks) at HC 534/538, HDMA at HC 1106 (lines 0-224), and
  ;; the line end, where the APU catches up and the DSP with it
  ;; (S9xAPUEndScanline). The CPU's position does not move.
  (func $ev_sched (param $k i32)
    (local $h i32) (local $t i32)
    (local.set $h (call $hnow))
    (local.set $k (if (result i32) (i32.and (i32.eqz (local.get $k)) (i32.ne (global.get $scanline) (i32.const 0)))
      (then (i32.const 2)) (else (i32.add (local.get $k) (i32.const 1)))))
    (local.set $t (if (result i32) (i32.eq (local.get $k) (i32.const 1)) (then (i32.const 20))
      (else (if (result i32) (i32.eq (local.get $k) (i32.const 2)) (then (i32.const 512))
      (else (if (result i32) (i32.eq (local.get $k) (i32.const 3)) (then (global.get $refpos))
      (else (if (result i32) (i32.eq (local.get $k) (i32.const 4)) (then (i32.const 1106))
      (else (global.get $hmax))))))))))
    (global.set $evk (local.get $k))
    (global.set $segend (local.get $t))
    (global.set $cyc (i32.sub (local.get $t) (local.get $h))))

  ;; snes9x S9xDoHEventProcessing for the due event, the CPU at $p. The
  ;; line end rebases the clock and starts the next line.
  (func $ev_process (param $p i32)
    (local $k i32) (local $ln i32)
    (local.set $k (global.get $evk))
    (if (i32.and (i32.eq (local.get $k) (i32.const 5)) (i32.eq (global.get $scanline) (i32.const 224)))
      (then (i32.store (i32.const ${PROBE + 124}) (local.get $p))
            (i32.store (i32.const ${PROBE + 128}) (global.get $istart))
            (i32.store (i32.const ${PROBE + 132}) (global.get $curpc))))
    (call $event_do (local.get $k) (local.get $p))
    (if (i32.ne (local.get $k) (i32.const 5))
      (then (call $ev_sched (local.get $k)) (return)))
    (call $apu_newline (global.get $hmax))
    (global.set $segend (i32.sub (global.get $segend) (global.get $hmax)))
    (global.set $nmipos (i32.sub (global.get $nmipos) (global.get $hmax)))
    ;; A timer position this line never reached stays due (NextIRQTimer
    ;; -= H_Max), so a DMA that ran past it still raises it afterwards.
    (if (i32.ne (global.get $ipos) (i32.const 99999))
      (then (global.set $ipos (i32.sub (global.get $ipos) (global.get $hmax)))))
    (local.set $ln (i32.add (global.get $scanline) (i32.const 1)))
    (if (i32.eq (local.get $ln) (i32.const 262)) (then (local.set $ln (i32.const 0))))
    (call $line_begin (local.get $ln))
    (if (i32.eq (global.get $ipos) (i32.const 99999))
      (then (global.set $ipos (call $irqpos (local.get $ln)))))
    ;; VBlank begins: libretro's frame is over (SCAN_KEYS_FLAG).
    (if (i32.eq (local.get $ln) (i32.const 225))
      (then (global.set $fdone (i32.const 1))
            (call $apu_flush)))
    (call $ev_sched (i32.const 0)))

  ;; Every event the clock has reached (snes9x: while (CPU.Cycles >=
  ;; CPU.NextEvent) S9xDoHEventProcessing()).
  (func $ev_due
    (block $d (loop $l
      (br_if $d (i32.or (i32.eqz (global.get $evk)) (i32.gt_s (global.get $cyc) (i32.const 0))))
      (call $ev_process (call $hnow))
      (br $l))))

  ;; Where an event at $segend was processed, given the CPU is now at $p and
  ;; the crossing happened in the running instruction's fetch or leading
  ;; internal cycles (the line-end APU sync position depends on it).
  (func $evpos (param $p i32) (result i32)
    (local $st i32) (local $n i32) (local $fe i32) (local $ie i32) (local $t i32)
    (local $io i32)
    (local.set $t (global.get $segend))
    (local.set $n (call $fetch_len))
    (local.set $io (i32.and (global.get $iio) (i32.const 0x7F)))
    (local.set $st (global.get $istart))
    (if (i32.ge_s (local.get $st) (local.get $t)) (then (return (local.get $p))))
    (local.set $fe (i32.add (local.get $st) (i32.mul (local.get $n) (global.get $ms))))
    ;; snes9x's opcode fetch adds its cycles without looking at events
    ;; (S9xMainLoop), and the operand bytes are one AddCycles (Immediate8/16,
    ;; AbsoluteLong; MVN/MVP read theirs one Immediate8 at a time): a
    ;; crossing anywhere in the fetch is seen after the operand, or after
    ;; the first internal cycles of a one-byte opcode.
    (if (i32.ge_s (local.get $fe) (local.get $t))
      (then (if (i32.and (global.get $ifl) (i32.const 0x08))
              (then (return (if (result i32) (i32.ge_s (i32.add (local.get $st) (i32.shl (global.get $ms) (i32.const 1))) (local.get $t))
                (then (i32.add (local.get $st) (i32.shl (global.get $ms) (i32.const 1)))) (else (local.get $fe))))))
            (if (i32.gt_u (local.get $n) (i32.const 1)) (then (return (local.get $fe))))
            (if (i32.and (global.get $iio) (i32.const 0x80))
              (then (return (i32.add (local.get $fe) (i32.mul (local.get $io) (i32.const 6))))))
            (if (local.get $io) (then (return (i32.add (local.get $fe) (i32.const 6)))))
            (return (local.get $p))))
    ;; ... or in its leading internal cycles: 6 clocks each, or all of them
    ;; at once where snes9x adds them in one AddCycles.
    (local.set $ie (i32.add (local.get $fe) (i32.mul (local.get $io) (i32.const 6))))
    (if (i32.ge_s (local.get $ie) (local.get $t))
      (then (if (i32.and (global.get $iio) (i32.const 0x80)) (then (return (local.get $ie))))
            (return (i32.add (local.get $fe)
              (i32.mul (i32.const 6) (i32.div_s (i32.add (i32.sub (local.get $t) (local.get $fe)) (i32.const 5)) (i32.const 6)))))))
    (local.get $p))

  ;; The work of event $k with the CPU at position $p (in this line).
  (func $event_do (param $k i32) (param $p i32)
    (if (i32.eq (local.get $k) (i32.const 1)) (then (call $hdma_init) (return)))
    (if (i32.eq (local.get $k) (i32.const 2))
      (then (if (i32.and (i32.ge_u (global.get $scanline) (i32.const 1))
                         (i32.le_u (global.get $scanline) (i32.const ${FB_H})))
              (then (call $render_row (i32.sub (global.get $scanline) (i32.const 1)))))
            (return)))
    (if (i32.eq (local.get $k) (i32.const 3))
      (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 40))) (return)))
    (if (i32.eq (local.get $k) (i32.const 4))
      (then (if (i32.le_u (global.get $scanline) (i32.const 224)) (then (call $hdma_do))) (return)))
    (if (i32.eq (local.get $k) (i32.const 5))
      (then (call $apu_sync (local.get $p)) (call $d_sync))))

  ;; Program bytes of the instruction at $curpc (ICOST, M/X as they are now).
  (func $fetch_len (result i32)
    (local $op i32) (local $lf i32) (local $n i32)
    (local.set $op (call $rd8m (global.get $curpc)))
    (local.set $lf (i32.load8_u (i32.add (i32.const ${ICOST}) (i32.shl (local.get $op) (i32.const 1)))))
    (local.set $n (i32.and (local.get $lf) (i32.const 7)))
    (if (i32.and (i32.ne (i32.and (local.get $lf) (i32.const 0x80)) (i32.const 0)) (i32.eqz (global.get $fm)))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    (if (i32.and (i32.ne (i32.and (local.get $lf) (i32.const 0x40)) (i32.const 0)) (i32.eqz (global.get $fx)))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    ;; (the static internal cycle count, for $evpos)
    (global.set $iio (i32.load8_u offset=1 (i32.add (i32.const ${ICOST}) (i32.shl (local.get $op) (i32.const 1)))))
    (global.set $ifl (local.get $lf))
    (local.get $n))

  (func $line_begin (param $ln i32)
    (global.set $scanline (local.get $ln))
    ;; snes9x's H_Max event for the new line: line 240 of an odd field is one
    ;; dot short (1360), and the 5A22 v2 DRAM refresh alternates between HC
    ;; 534 and 538 every line except that one (538 after power-on).
    (if (i32.and (i32.eq (local.get $ln) (i32.const 240)) (i32.ne (global.get $field) (i32.const 0)))
      (then (global.set $hmax (i32.const 1360)))
      (else (global.set $hmax (i32.const 1364))
            (if (global.get $linesrun)
              (then (global.set $refpos (if (result i32) (i32.eq (global.get $refpos) (i32.const 534))
                                          (then (i32.const 538)) (else (i32.const 534))))))))
    (global.set $linesrun (i32.const 1))
    (if (i32.eqz (local.get $ln))
      (then (global.set $nmiflag (i32.const 0))
            (global.set $rto (i32.const 0))
            ;; snes9x flips $213F bit 7 (the field) every time V wraps to 0,
            ;; interlaced or not; power-on starts at V=0 without a wrap.
            (if (global.get $nframes) (then (global.set $field (i32.xor (global.get $field) (i32.const 0x80)))))
            (global.set $nframes (i32.add (global.get $nframes) (i32.const 1)))))
    (if (i32.eq (local.get $ln) (i32.const 1))
      (then (global.set $mosstart (i32.const 0))))
    ;; snes9x runs the automatic joypad read as line ScreenHeight + 3 begins.
    (if (i32.and (i32.eq (local.get $ln) (i32.const 227))
                 (i32.and (call $io_reg (i32.const 0x4200)) (i32.const 1)))
      (then (call $auto_joypad)))
    (if (i32.eq (local.get $ln) (i32.const 225))
      (then
        (global.set $nmiflag (if (result i32) (global.get $nmiearly) (then (i32.const 0)) (else (i32.const 0x80))))
        (global.set $nmiearly (i32.const 0))
        (global.set $maxbright (i32.and (i32.load8_u (i32.const ${PPUREG}))
                                        (i32.const 15)))
        (if (i32.eqz (global.get $fblank)) (then (call $oam_vblank_reset)))
        (if (i32.and (i32.ne (global.get $nmien) (i32.const 0))
                     (i32.eqz (global.get $trapped)))
          (then (global.set $nmipend (i32.const 1))
                ;; snes9x Timings.NMITriggerPos = 6 + 6
                (global.set $nmipos (i32.const 12)))))))

  (func (export "wc_render")
    (local $ln i32) (local $i i32)
    ;; libretro retro_run reports the pads before it emulates the frame.
    (call $pads_sample)
    ;; A libretro snes9x frame (retro_run -> S9xMainLoop) ends when the
    ;; picture is complete, at the start of vblank (line 225): the first
    ;; call runs from power-on, every later one from where the last left
    ;; off. So the NMI and the automatic joypad read come at the START of a
    ;; call, as they do in the reference, and input given before a call is
    ;; read inside it.
    (if (i32.eqz (global.get $started))
      (then (global.set $started (i32.const 1))
            (call $line_begin (i32.const 0))
            (global.set $ipos (call $irqpos (i32.const 0)))
            (global.set $segend (i32.const 0))
            (global.set $cyc (i32.sub (i32.const 0) (global.get $hpos)))
            (call $ev_sched (i32.const 0))))
    (global.set $fdone (i32.const 0))
    (call $run_frame)
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
    (i32.store (i32.const ${PROBE + 48}) (global.get $apu_nsmp))
    (i32.store (i32.const ${PROBE + 52}) (global.get $s_pc))
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
    (i32.store (i32.const ${PROBE + 112}) (global.get $apu_nout))
    (i32.store (i32.const ${PROBE + 116}) (global.get $s_clock))
    (i32.store (i32.const ${PROBE + 120}) (global.get $d_phase))
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
  (func (export "dbg_spcpc") (result i32) (global.get $s_pc))
  (func (export "dbg_nspc") (result i32) (global.get $apu_nsmp))
  (func (export "dbg_nsamples") (result i32) (global.get $apu_nout))
  (func (export "dbg_napuw") (result i32) (global.get $napuw))
  (func (export "dbg_scanline") (result i32) (global.get $scanline))
  (func (export "dbg_cyc") (result i32) (global.get $cyc))
`;
}

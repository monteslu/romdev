// GBA system for the WAT cart: bus, I/O, scheduler, video timing, timers,
// DMA, sound FIFOs, save chips, interrupts and the BIOS calls, ported from
// mGBA 0.11 (src/gba/*.c, src/core/timing.c, src/arm/arm.c) so the cart runs
// on the reference's clock, cycle for cycle.
//
// Each WAT function names the mGBA function it ports. Deviations are listed
// where they exist; everything else follows the C statement by statement,
// including its quirks (a byte store to palette RAM is charged twice, a DMA
// never reads through a region boundary mid-transfer, the HBlank IRQ is
// requested six cycles early). Quirks are behaviour the reference has, and a
// frame-exact cart has to have them too.
//
// The WAT text is the text of the earlier Python emitter, carried over
// mechanically (the differential gate compares the two emitters' output).
//
// Plain JS ESM + JSDoc.

// Event ids. Priority order == id order, as the ids are assigned in
// ascending mGBA priority, so "earliest (when, priority)" == "earliest
// (when, id)".
export const EV_IRQ = 0, EV_VIDEO = 1, EV_FRAME = 2, EV_SAMPLE = 3, EV_TM0 = 4, EV_TM1 = 5,
  EV_TM2 = 6, EV_TM3 = 7, EV_DMA = 8, EV_DUST = 9, EV_SIO = 10;
export const NEV = 11;
// The PSG frame sequencer (every 4 * (DMG_FREQ >> 9) = 32768 cycles) and the
// audio sample event (every 1024) produce no state the CPU can see, but they
// ARE events: a halted CPU skips to the next event, and the frame boundary
// lands wherever that skip lands.
export const AUDIO_FRAME_CYCLES = 32768;
export const AUDIO_SAMPLE_CYCLES = 1024;

export const VIDEO_HDRAW = 1008;
export const VIDEO_HBLANK = 224;
export const VIDEO_TOTAL_LENGTH = 280896;
export const IRQ_DELAY = 7;

// savedata types (mGBA's enum SavedataType)
export const SAVE_AUTODETECT = -1, SAVE_FORCE_NONE = 0, SAVE_SRAM = 1, SAVE_FLASH512 = 2,
  SAVE_FLASH1M = 3, SAVE_EEPROM = 4, SAVE_EEPROM512 = 5, SAVE_SRAM512 = 6;

/** @param {number} n */
const range = (n) => Array.from({ length: n }, (_, i) => i);

/**
 * WAT source for the whole system.
 * @param {Record<string, number>} L linear-memory layout (see index.js)
 * @param {number} rom_size
 * @param {number|null} idle_loop mGBA override idle-loop address, or null
 * @param {number} savetype
 * @returns {string}
 */
export function sysWat(L, rom_size, idle_loop, savetype) {
  const EW = L.EWRAM, IW = L.IWRAM, IO = L.IO, PAL = L.PAL, VR = L.VRAM, OAM = L.OAM;
  const BIOS = L.BIOS, ROM = L.ROM, REGS = L.REGS, BANK = L.BANK, WS = L.WS;
  const EVW = L.EVWHEN, EVA = L.EVACT;
  const DMA = L.DMA, TMR = L.TIMER, SAVE = L.SAVE, WAVE = L.WAVE;
  // DMA struct: 10 words per channel
  const [D_REG, D_SRC, D_DST, D_CNT, D_NSRC, D_NDST, D_NCNT, D_WHEN, D_CYC] = range(9).map((k) => 4 * k);
  const DS = 40;
  // timer struct: 4 words
  const T_RELOAD = 0, T_LAST = 4, T_FLAGS = 8;
  const idle = idle_loop != null ? idle_loop : 0xFFFFFFFF;
  let rom_mask = 1;
  while (rom_mask < rom_size) rom_mask *= 2;
  rom_mask -= 1;
  // GBALoadROM's size rules. A 1 MiB image is mirrored 4 times (romSize
  // 4 MiB: carts that run NES games in an emulator rely on it). An image whose size is not a power
  // of two is "a bad dump or homebrew": mGBA emulates a flash cart, copying
  // it into a zeroed 32 MiB ROM, so every read past the image is 0 instead of
  // the out-of-bounds address pattern.
  const nesMirror = rom_size === 0x100000;
  const flashCart = (rom_size & (rom_size - 1)) !== 0;
  const romEnd = nesMirror ? 0x400000 : flashCart ? 0x2000000 : rom_size;
  const romIdx = nesMirror ? 0xFFFFF : 0x1FFFFFF;
  // an in-range read past the image (flash cart zero padding) -> 0
  const romLd = (w, a, m) => flashCart
    ? `(if (result i32) (i32.lt_u (i32.and ${a} (i32.const ${m})) (i32.const ${rom_size})) (then (${w} (i32.add (i32.const ${ROM}) (i32.and ${a} (i32.const ${m}))))) (else (i32.const 0)))`
    : `(${w} (i32.add (i32.const ${ROM}) (i32.and ${a} (i32.const ${m & romIdx}))))`;
    return `
  ;; ======================= CPU state (arm.c) ============================
  (global $pc (mut i32) (i32.const 0))       ;; next instruction to execute
  (global $exec (mut i32) (i32.const 0))     ;; the instruction executing now
  (global $thumb (mut i32) (i32.const 0))    ;; executionMode
  (global $n (mut i32) (i32.const 0)) (global $z (mut i32) (i32.const 0))
  (global $c (mut i32) (i32.const 0)) (global $v (mut i32) (i32.const 0))
  (global $ctl (mut i32) (i32.const 0x1F))   ;; cpsr bits 0-7
  (global $spsr (mut i32) (i32.const 0))
  (global $priv (mut i32) (i32.const 0x1F))  ;; cpu->privilegeMode
  (global $shop (mut i32) (i32.const 0)) (global $shc (mut i32) (i32.const 0))
  (global $cc (mut i32) (i32.const 0))       ;; currentCycles of the instruction
  (global $cycles (mut i32) (i32.const 0))   ;; cpu->cycles
  (global $nextEvent (mut i32) (i32.const 0))
  (global $halted (mut i32) (i32.const 0))
  ;; memory (memory.c)
  (global $areg (mut i32) (i32.const -1))    ;; memory->activeRegion
  (global $aseq16 (mut i32) (i32.const 0)) (global $anon16 (mut i32) (i32.const 0))
  (global $aseq32 (mut i32) (i32.const 0)) (global $anon32 (mut i32) (i32.const 0))
  (global $prefetch (mut i32) (i32.const 0))
  (global $lpp (mut i32) (i32.const 0))      ;; lastPrefetchedPc
  (global $biosPrefetch (mut i32) (i32.const 0))
  ;; the instruction pipeline for code in RAM (arm.c ARMStep/ThumbStep:
  ;; prefetch[0]/[1]). Tag = address | thumb, -1 = empty.
  (global $pfa0 (mut i32) (i32.const -1)) (global $pfw0 (mut i32) (i32.const 0))
  (global $pfa1 (mut i32) (i32.const -1)) (global $pfw1 (mut i32) (i32.const 0))
  (global $haltPending (mut i32) (i32.const 0))
  (global $bus (mut i32) (i32.const 0))
  (global $performingDMA (mut i32) (i32.const 0))
  (global $cpuBlocked (mut i32) (i32.const 0))
  (global $earlyExit (mut i32) (i32.const 0))
  (global $activeDMA (mut i32) (i32.const -1))
  (global $dmaTR (mut i32) (i32.const 0))    ;; dmaTransferRegister
  (global $dmaPC (mut i32) (i32.const 0))
  (global $biosStall (mut i32) (i32.const 0))
  ;; timing (core/timing.c)
  (global $master (mut i32) (i32.const 0))   ;; masterCycles
  ;; video (video.c)
  (global $vcount (mut i32) (i32.const 0))
  (global $vcb (mut i32) (i32.const 0))      ;; 0 -> _startHblank next, 1 -> _startHdraw
  (global $frameCounter (mut i32) (i32.const 0))
  (global $stallMask (mut i32) (i32.const 0))
  ;; keys
  (global $keysActive (mut i32) (i32.const 0))
  (global $keysLast (mut i32) (i32.const 0x400))
  ;; audio (audio.c): only the parts that move the CPU's clock
  (global $aEnable (mut i32) (i32.const 0))
  (global $chALR (mut i32) (i32.const 0)) (global $chBLR (mut i32) (i32.const 0))
  (global $chATimer (mut i32) (i32.const 0)) (global $chBTimer (mut i32) (i32.const 0))
  (global $chAWrite (mut i32) (i32.const 0)) (global $chARead (mut i32) (i32.const 0))
  (global $chBWrite (mut i32) (i32.const 0)) (global $chBRead (mut i32) (i32.const 0))
  (global $chARem (mut i32) (i32.const 0)) (global $chBRem (mut i32) (i32.const 0))
  (global $chADma (mut i32) (i32.const 1)) (global $chBDma (mut i32) (i32.const 2))
  (global $ch3bank (mut i32) (i32.const 0))
  ;; sio (sio.c, no driver attached)
  (global $siocnt (mut i32) (i32.const 0))
  (global $rcnt (mut i32) (i32.const 0x8000))
  (global $siomode (mut i32) (i32.const -1))
  ;; savedata (savedata.c)
  (global $saveType (mut i32) (i32.const ${savetype}))
  (global $flashState (mut i32) (i32.const 0))
  (global $saveCmd (mut i32) (i32.const 0))
  (global $flashBank (mut i32) (i32.const 0))
  (global $settling (mut i32) (i32.const 0))
  (global $eepRead (mut i32) (i32.const 0))
  (global $eepWrite (mut i32) (i32.const 0))
  (global $eepBits (mut i32) (i32.const 0))

  ;; ======================= scheduler (core/timing.c) =====================
  ;; mTimingSchedule: when is relative to now; stored absolute (masterCycles).
  (func $schedule (param $id i32) (param $when i32)
    (local $ne i32)
    (local.set $ne (i32.add (local.get $when) (global.get $cycles)))
    (i32.store (i32.add (i32.const ${EVW}) (i32.shl (local.get $id) (i32.const 2)))
               (i32.add (local.get $ne) (global.get $master)))
    (i32.store (i32.add (i32.const ${EVA}) (i32.shl (local.get $id) (i32.const 2))) (i32.const 1))
    (if (i32.lt_s (local.get $ne) (global.get $nextEvent))
      (then (global.set $nextEvent (local.get $ne)))))

  (func $deschedule (param $id i32)
    (i32.store (i32.add (i32.const ${EVA}) (i32.shl (local.get $id) (i32.const 2))) (i32.const 0)))

  (func $scheduled (param $id i32) (result i32)
    (i32.load (i32.add (i32.const ${EVA}) (i32.shl (local.get $id) (i32.const 2)))))

  (func $now (result i32)   ;; mTimingCurrentTime
    (i32.add (global.get $master) (global.get $cycles)))

  (func $until (param $id i32) (result i32)   ;; mTimingUntil
    (i32.sub (i32.sub (i32.load (i32.add (i32.const ${EVW}) (i32.shl (local.get $id) (i32.const 2))))
                      (global.get $master)) (global.get $cycles)))

  ;; The earliest scheduled event by (when - master, priority); -1 if none.
  (func $first (result i32)
    (local $i i32) (local $best i32) (local $bw i32) (local $w i32)
    (local.set $best (i32.const -1))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${NEV})))
      (if (i32.load (i32.add (i32.const ${EVA}) (i32.shl (local.get $i) (i32.const 2))))
        (then
          (local.set $w (i32.sub (i32.load (i32.add (i32.const ${EVW}) (i32.shl (local.get $i) (i32.const 2))))
                                 (global.get $master)))
          (if (i32.or (i32.lt_s (local.get $best) (i32.const 0))
                      (i32.lt_s (local.get $w) (local.get $bw)))
            (then (local.set $best (local.get $i)) (local.set $bw (local.get $w))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.get $best))

  (func $tick (param $cyc i32) (result i32)   ;; mTimingTick
    (local $id i32) (local $w i32)
    (global.set $master (i32.add (global.get $master) (local.get $cyc)))
    (block $d (loop $l
      (local.set $id (call $first))
      (br_if $d (i32.lt_s (local.get $id) (i32.const 0)))
      (local.set $w (i32.sub (i32.load (i32.add (i32.const ${EVW}) (i32.shl (local.get $id) (i32.const 2))))
                             (global.get $master)))
      (if (i32.gt_s (local.get $w) (i32.const 0)) (then (return (local.get $w))))
      (call $deschedule (local.get $id))
      (call $event (local.get $id) (i32.sub (i32.const 0) (local.get $w)))
      (br $l)))
    (global.get $nextEvent))

  (func $event (param $id i32) (param $late i32)
    (block $b10 (block $b9 (block $b8 (block $b7 (block $b6 (block $b5 (block $b4 (block $b3 (block $b2 (block $b1 (block $b0
      (br_table $b0 $b1 $b2 $b3 $b4 $b5 $b6 $b7 $b8 $b9 $b10 (local.get $id)))
      (call $trigger_irq (local.get $late)) (return))
      (if (global.get $vcb) (then (call $start_hdraw (local.get $late))) (else (call $start_hblank (local.get $late))))
      (return))
      (call $au_frame_event (local.get $late))
      (call $schedule (i32.const ${EV_FRAME}) (i32.sub (i32.const ${AUDIO_FRAME_CYCLES}) (local.get $late))) (return))
      (call $au_sample_event (local.get $late))
      (call $schedule (i32.const ${EV_SAMPLE}) (i32.sub (i32.const ${AUDIO_SAMPLE_CYCLES}) (local.get $late))) (return))
      (call $timer_update (i32.const 0) (local.get $late)) (return))
      (call $timer_update (i32.const 1) (local.get $late)) (return))
      (call $timer_update (i32.const 2) (local.get $late)) (return))
      (call $timer_update (i32.const 3) (local.get $late)) (return))
      (call $dma_event (local.get $late)) (return))
      (return))   ;; savedata dust: _ashesToAshes does nothing
    (call $sio_finish (local.get $late)))

  ;; GBAProcessEvents
  (func $process_events
    (local $ne i32) (local $cyc i32)
    (global.set $bus (call $prefetch1))
    (local.set $ne (global.get $nextEvent))
    (block $out (loop $l
      (br_if $out (i32.lt_s (global.get $cycles) (local.get $ne)))
      (global.set $nextEvent (i32.const 0x7FFFFFFF))
      (local.set $ne (i32.const 0))
      (loop $blk
        (local.set $cyc (global.get $cycles))
        (global.set $cycles (i32.const 0))
        (local.set $ne (call $tick (if (result i32) (i32.lt_s (local.get $cyc) (local.get $ne))
                                     (then (local.get $ne)) (else (local.get $cyc)))))
        (br_if $blk (i32.and (global.get $cpuBlocked) (i32.eqz (global.get $earlyExit)))))
      (global.set $nextEvent (local.get $ne))
      (if (global.get $halted)
        (then
          (global.set $cycles (local.get $ne))
          (br_if $out (i32.or (i32.eqz (i32.load16_u (i32.const ${IO + 0x208})))
                              (i32.eqz (i32.load16_u (i32.const ${IO + 0x200})))))))
      (br_if $out (global.get $earlyExit))
      (br $l)))
    (global.set $earlyExit (i32.const 0))
    (if (global.get $cpuBlocked) (then (global.set $cycles (global.get $nextEvent)))))

  ;; gba->bus = prefetch[1] (| prefetch[1] << 16 in Thumb). prefetch[1] is
  ;; the word/halfword the pipeline fetched at gprs[PC].
  (func $prefetch1 (result i32)
    (local $v i32)
    (if (global.get $thumb)
      (then (local.set $v (call $fetch16 (i32.add (global.get $pc) (i32.const 2))))
            (return (i32.or (local.get $v) (i32.shl (local.get $v) (i32.const 16))))))
    (call $fetch32 (i32.add (global.get $pc) (i32.const 4))))

  ;; ======================= CPU helpers (arm.c, isa-inlines.h) ============
  (func $bank_of (param $m i32) (result i32)   ;; ARMSelectBank
    (if (i32.eq (local.get $m) (i32.const 0x11)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $m) (i32.const 0x12)) (then (return (i32.const 2))))
    (if (i32.eq (local.get $m) (i32.const 0x13)) (then (return (i32.const 3))))
    (if (i32.eq (local.get $m) (i32.const 0x17)) (then (return (i32.const 4))))
    (if (i32.eq (local.get $m) (i32.const 0x1B)) (then (return (i32.const 5))))
    (i32.const 0))

  ;; ARMSetPrivilegeMode. Bank layout: 6 banks x 7 words (sp, lr, r8-r12),
  ;; then 6 banked SPSRs.
  (func $set_priv (param $m i32)
    (local $ob i32) (local $nb i32) (local $of i32) (local $nf i32) (local $i i32)
    (if (i32.eq (local.get $m) (global.get $priv)) (then (return)))
    (local.set $nb (call $bank_of (local.get $m)))
    (local.set $ob (call $bank_of (global.get $priv)))
    (if (i32.ne (local.get $nb) (local.get $ob))
      (then
        (if (i32.or (i32.eq (local.get $m) (i32.const 0x11)) (i32.eq (global.get $priv) (i32.const 0x11)))
          (then
            (local.set $of (i32.eq (local.get $ob) (i32.const 1)))
            (local.set $nf (i32.eq (local.get $nb) (i32.const 1)))
            (local.set $i (i32.const 0))
            (block $d (loop $l
              (br_if $d (i32.ge_u (local.get $i) (i32.const 5)))
              (i32.store (i32.add (i32.const ${BANK}) (i32.shl (i32.add (i32.mul (local.get $of) (i32.const 7))
                                                                        (i32.add (local.get $i) (i32.const 2))) (i32.const 2)))
                         (i32.load (i32.add (i32.const ${REGS + 32}) (i32.shl (local.get $i) (i32.const 2)))))
              (i32.store (i32.add (i32.const ${REGS + 32}) (i32.shl (local.get $i) (i32.const 2)))
                         (i32.load (i32.add (i32.const ${BANK}) (i32.shl (i32.add (i32.mul (local.get $nf) (i32.const 7))
                                                                                  (i32.add (local.get $i) (i32.const 2))) (i32.const 2)))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $l)))))
        (i32.store (i32.add (i32.const ${BANK}) (i32.mul (local.get $ob) (i32.const 28))) (i32.load (i32.const ${REGS + 52})))
        (i32.store (i32.add (i32.const ${BANK + 4}) (i32.mul (local.get $ob) (i32.const 28))) (i32.load (i32.const ${REGS + 56})))
        (i32.store (i32.const ${REGS + 52}) (i32.load (i32.add (i32.const ${BANK}) (i32.mul (local.get $nb) (i32.const 28)))))
        (i32.store (i32.const ${REGS + 56}) (i32.load (i32.add (i32.const ${BANK + 4}) (i32.mul (local.get $nb) (i32.const 28)))))
        (i32.store (i32.add (i32.const ${BANK + 168}) (i32.shl (local.get $ob) (i32.const 2))) (global.get $spsr))
        (global.set $spsr (i32.load (i32.add (i32.const ${BANK + 168}) (i32.shl (local.get $nb) (i32.const 2)))))))
    (global.set $priv (local.get $m)))

  (func $pack_cpsr (result i32)
    (i32.or (i32.or (i32.or (i32.shl (global.get $n) (i32.const 31)) (i32.shl (global.get $z) (i32.const 30)))
                    (i32.or (i32.shl (global.get $c) (i32.const 29)) (i32.shl (global.get $v) (i32.const 28))))
            (global.get $ctl)))

  (func $unpack_cpsr (param $p i32)
    (global.set $n (i32.shr_u (local.get $p) (i32.const 31)))
    (global.set $z (i32.and (i32.shr_u (local.get $p) (i32.const 30)) (i32.const 1)))
    (global.set $c (i32.and (i32.shr_u (local.get $p) (i32.const 29)) (i32.const 1)))
    (global.set $v (i32.and (i32.shr_u (local.get $p) (i32.const 28)) (i32.const 1)))
    (global.set $ctl (i32.and (local.get $p) (i32.const 0xFF))))

  ;; _ARMSetMode
  (func $set_exec_mode (param $t i32)
    (if (i32.eq (local.get $t) (global.get $thumb)) (then (return)))
    (global.set $thumb (local.get $t))
    (global.set $ctl (i32.or (i32.and (global.get $ctl) (i32.const -33)) (i32.shl (local.get $t) (i32.const 5))))
    (global.set $nextEvent (global.get $cycles)))

  ;; _ARMReadCPSR: mode from T, privilege from the mode bits, then the IRQ test.
  (func $read_cpsr
    (call $set_exec_mode (i32.and (i32.shr_u (global.get $ctl) (i32.const 5)) (i32.const 1)))
    (call $set_priv (i32.and (global.get $ctl) (i32.const 31)))
    (call $test_irq (i32.const 0)))

  ;; cpsr = spsr; _ARMReadCPSR
  (func $cpsr_from_spsr
    (call $unpack_cpsr (global.get $spsr))
    (call $read_cpsr))

  ;; MSR/MSRI to the cpsr (isa-arm.c)
  (func $msr_cpsr (param $op i32) (param $mask i32)
    (local $p i32)
    (local.set $p (call $pack_cpsr))
    (if (i32.and (local.get $mask) (i32.const 0xF0000000))
      (then (local.set $p (i32.or (i32.and (local.get $p) (i32.const 0x0FFFFFFF))
                                  (i32.and (local.get $op) (i32.const 0xF0000000))))))
    (if (i32.and (local.get $mask) (i32.const 0x20))
      (then (local.set $p (i32.or (i32.and (local.get $p) (i32.const -33))
                                  (i32.and (local.get $op) (i32.const 0x20))))))
    (if (i32.and (i32.ne (global.get $priv) (i32.const 0x10)) (i32.ne (i32.and (local.get $mask) (i32.const 0xCF)) (i32.const 0)))
      (then
        (call $set_priv (i32.or (i32.and (local.get $op) (i32.const 15)) (i32.const 16)))
        (local.set $p (i32.or (i32.and (local.get $p) (i32.const -208))
                              (i32.and (local.get $op) (i32.const 0xCF))))))
    (call $unpack_cpsr (local.get $p))
    (call $read_cpsr)
    ;; A Thumb switch through MSR (prefetch[0] = nop, pc += 2) is not
    ;; modelled; no BIOS or tested game path takes it.
    (if (global.get $thumb) (then (unreachable))))

  (func $msr_spsr (param $op i32) (param $mask i32)
    (local.set $mask (i32.and (local.get $mask) (i32.const 0xF00000EF)))
    (global.set $spsr (i32.or (i32.or (i32.and (global.get $spsr) (i32.xor (local.get $mask) (i32.const -1)))
                                      (i32.and (local.get $op) (local.get $mask))) (i32.const 0x10))))

  ;; GBASetActiveRegion
  (func $set_active_region (param $a i32)
    (local $nr i32)
    (local.set $nr (i32.shr_u (local.get $a) (i32.const 24)))
    ;; idle loop removal (IDLE_LOOP_REMOVE with a known loop address)
    (if (i32.ne (global.get $areg) (i32.const 0))
      (then
        (if (i32.eq (local.get $a) (i32.const ${idle}))
          (then
            (if (global.get $haltPending)
              (then (global.set $haltPending (i32.const 0)) (call $halt))
              (else (global.set $haltPending (i32.const 1))))))))
    (global.set $lpp (i32.const 0))
    (if (i32.eq (local.get $nr) (global.get $areg))
      (then
        (if (i32.or (i32.lt_u (local.get $nr) (i32.const 8))
                    (i32.lt_u (i32.and (local.get $a) (i32.const 0x1FFFFFF)) (i32.const ${romEnd})))
          (then (return)))))
    (if (i32.eqz (global.get $areg))
      (then (global.set $biosPrefetch (call $fetch32 (i32.add (global.get $exec) (i32.const 8))))))
    (global.set $areg (local.get $nr))
    (block $ok
      (br_if $ok (i32.eqz (local.get $nr)))
      (br_if $ok (i32.eq (local.get $nr) (i32.const 2)))
      (br_if $ok (i32.eq (local.get $nr) (i32.const 3)))
      (br_if $ok (i32.and (i32.ge_u (local.get $nr) (i32.const 5)) (i32.le_u (local.get $nr) (i32.const 7))))
      (br_if $ok (i32.and (i32.and (i32.ge_u (local.get $nr) (i32.const 8)) (i32.le_u (local.get $nr) (i32.const 13)))
                          (i32.lt_u (i32.and (local.get $a) (i32.const 0x1FFFFFF)) (i32.const ${romEnd}))))
      ;; "Jumped to invalid address": activeRegion = -1 and the cycle tables
      ;; are then read at index -1, which mGBA does not guard. Treat as a
      ;; trap so a wrong jump is loud rather than silently re-timed.
      (global.set $areg (i32.const -1))
      (call $trap_invalid (local.get $a))
      (return))
    (call $load_active_ws))

  (func $load_active_ws
    (global.set $aseq32 (i32.load8_s (i32.add (i32.const ${WS + 768}) (global.get $areg))))
    (global.set $aseq16 (i32.load8_s (i32.add (i32.const ${WS + 256}) (global.get $areg))))
    (global.set $anon32 (i32.load8_s (i32.add (i32.const ${WS + 512}) (global.get $areg))))
    (global.set $anon16 (i32.load8_s (i32.add (i32.const ${WS}) (global.get $areg)))))

  ;; regions 2-7 (EWRAM..OAM): memory code can be written to. ROM and BIOS
  ;; never change, so their instructions are dispatched by address.
  (func $pipe_region (param $a i32) (result i32)
    (i32.lt_u (i32.sub (i32.shr_u (local.get $a) (i32.const 24)) (i32.const 2)) (i32.const 6)))

  ;; ARMWritePC/ThumbWritePC load prefetch[0] and [1] from the target AT
  ;; THE BRANCH (a store the branch target makes to its own next word does
  ;; not change what runs)
  (func $pipe_fill (param $p i32) (param $t i32)
    (if (i32.eqz (call $pipe_region (local.get $p)))
      (then (global.set $pfa0 (i32.const -1)) (return)))
    (global.set $pfa0 (i32.or (local.get $p) (local.get $t)))
    (global.set $pfa1 (i32.add (global.get $pfa0) (i32.const 4)))
    (if (local.get $t)
      (then (global.set $pfa1 (i32.add (global.get $pfa0) (i32.const 2)))
            (global.set $pfw0 (call $fetch16 (local.get $p)))
            (global.set $pfw1 (call $fetch16 (i32.add (local.get $p) (i32.const 2)))))
      (else (global.set $pfw0 (call $fetch32 (local.get $p)))
            (global.set $pfw1 (call $fetch32 (i32.add (local.get $p) (i32.const 4)))))))

  ;; The word/halfword executed at $e when it is in RAM, through the pipeline:
  ;; it was fetched when gprs[PC] reached it (two instructions earlier, or at
  ;; the branch), not now. A store the running code makes to the next two
  ;; instructions is not seen (the pipeline already holds them), as in mGBA.
  (func $pipe_word (param $e i32) (result i32)
    (local $t i32) (local $w i32) (local $v i32)
    (local.set $t (global.get $thumb))
    (local.set $w (if (result i32) (local.get $t) (then (i32.const 2)) (else (i32.const 4))))
    (if (i32.ne (global.get $pfa0) (i32.or (local.get $e) (local.get $t)))
      (then (call $pipe_fill (local.get $e) (local.get $t))))
    (local.set $v (global.get $pfw0))
    (global.set $pfa0 (global.get $pfa1))
    (global.set $pfw0 (global.get $pfw1))
    (global.set $pfa1 (i32.add (global.get $pfa0) (local.get $w)))
    (global.set $pfw1 (if (result i32) (local.get $t)
      (then (call $fetch16 (i32.add (local.get $e) (i32.const 4))))
      (else (call $fetch32 (i32.add (local.get $e) (i32.const 8))))))
    (local.get $v))

  ;; ThumbWritePC / ARMWritePC: -> cycles. $pc becomes the target.
  (func $thumb_write_pc (result i32)
    (local $p i32)
    (local.set $p (i32.and (i32.load (i32.const ${REGS + 60})) (i32.const -2)))
    (call $set_active_region (local.get $p))
    (call $pipe_fill (local.get $p) (i32.const 1))
    (i32.store (i32.const ${REGS + 60}) (i32.add (local.get $p) (i32.const 2)))
    (global.set $pc (local.get $p))
    (i32.add (i32.add (i32.const 2) (global.get $anon16)) (global.get $aseq16)))

  (func $arm_write_pc (result i32)
    (local $p i32)
    (local.set $p (i32.and (i32.load (i32.const ${REGS + 60})) (i32.const -2)))
    (call $set_active_region (local.get $p))
    (call $pipe_fill (i32.and (local.get $p) (i32.const -4)) (i32.const 0))
    (i32.store (i32.const ${REGS + 60}) (i32.add (local.get $p) (i32.const 4)))
    (global.set $pc (i32.and (local.get $p) (i32.const -4)))
    (i32.add (i32.add (i32.const 2) (global.get $anon32)) (global.get $aseq32)))

  ;; ARMRaiseIRQ. Runs BETWEEN instructions, where gprs[PC] = $pc + width.
  (func $raise_irq_cpu
    (local $saved i32) (local $w i32)
    (if (i32.and (global.get $ctl) (i32.const 0x80)) (then (return)))
    (local.set $saved (call $pack_cpsr))
    (call $set_priv (i32.const 0x12))
    (global.set $ctl (i32.or (i32.and (global.get $ctl) (i32.const -32)) (i32.const 0x12)))
    (i32.store (i32.const ${REGS + 56}) (i32.add (global.get $pc) (i32.const 4)))
    (i32.store (i32.const ${REGS + 60}) (i32.const 0x18))
    (call $set_exec_mode (i32.const 0))
    (global.set $cycles (i32.add (global.get $cycles) (call $arm_write_pc)))
    (global.set $spsr (local.get $saved))
    (global.set $ctl (i32.or (global.get $ctl) (i32.const 0x80)))
    (global.set $halted (i32.const 0)))

  ;; ARMRaiseSWI / ARMRaiseUndefined: called from INSIDE an instruction,
  ;; where gprs[PC] = exec + 2*width, so lr = exec + width.
  (func $raise_exc (param $mode i32) (param $vec i32)
    (local $saved i32)
    (local.set $saved (call $pack_cpsr))
    (call $set_priv (local.get $mode))
    (global.set $ctl (i32.or (i32.and (global.get $ctl) (i32.const -32)) (local.get $mode)))
    (i32.store (i32.const ${REGS + 56})
      (i32.sub (i32.load (i32.const ${REGS + 60}))
               (if (result i32) (global.get $thumb) (then (i32.const 2)) (else (i32.const 4)))))
    (i32.store (i32.const ${REGS + 60}) (local.get $vec))
    (call $set_exec_mode (i32.const 0))
    (global.set $cycles (i32.add (global.get $cycles) (call $arm_write_pc)))
    (global.set $spsr (local.get $saved))
    (global.set $ctl (i32.or (global.get $ctl) (i32.const 0x80))))

  (func $raise_swi (call $raise_exc (i32.const 0x13) (i32.const 8)))
  (func $raise_undef (call $raise_exc (i32.const 0x1B) (i32.const 4)))

  ;; GBAIllegal
  (func $illegal (param $op i32)
    (if (i32.and (global.get $thumb) (i32.eq (i32.and (local.get $op) (i32.const 0xFFC0)) (i32.const 0xE800)))
      (then (return)))
    (call $raise_undef))

  ;; ARM_WAIT_SMUL / ARM_WAIT_UMUL -> the stall to add to currentCycles
  (func $mul_wait_s (param $r i32) (param $w i32) (result i32)
    (local.set $w (i32.add (local.get $w)
      (if (result i32) (i32.or (i32.eq (i32.and (local.get $r) (i32.const 0xFFFFFF00)) (i32.const 0xFFFFFF00))
                               (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFFFF00))))
        (then (i32.const 1))
        (else (if (result i32) (i32.or (i32.eq (i32.and (local.get $r) (i32.const 0xFFFF0000)) (i32.const 0xFFFF0000))
                                       (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFF0000))))
          (then (i32.const 2))
          (else (if (result i32) (i32.or (i32.eq (i32.and (local.get $r) (i32.const 0xFF000000)) (i32.const 0xFF000000))
                                         (i32.eqz (i32.and (local.get $r) (i32.const 0xFF000000))))
            (then (i32.const 3)) (else (i32.const 4)))))))))
    (call $stall (local.get $w)))

  (func $mul_wait_u (param $r i32) (param $w i32) (result i32)
    (local.set $w (i32.add (local.get $w)
      (if (result i32) (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFFFF00))) (then (i32.const 1))
        (else (if (result i32) (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFF0000))) (then (i32.const 2))
          (else (if (result i32) (i32.eqz (i32.and (local.get $r) (i32.const 0xFF000000))) (then (i32.const 3))
            (else (i32.const 4)))))))))
    (call $stall (local.get $w)))

  ;; ======================= bus (memory.c) ================================
  ;; Raw instruction fetch: the bytes the pipeline would load, no side effects.
  (func $fetch_lin (param $a i32) (result i32)
    (local $r i32)
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (if (i32.eqz (local.get $r)) (then (return (i32.add (i32.const ${BIOS}) (i32.and (local.get $a) (i32.const 0x3FFF))))))
    (if (i32.eq (local.get $r) (i32.const 2)) (then (return (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFF))))))
    (if (i32.eq (local.get $r) (i32.const 3)) (then (return (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFF))))))
    (if (i32.eq (local.get $r) (i32.const 5)) (then (return (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FF))))))
    (if (i32.eq (local.get $r) (i32.const 6))
      (then (return (i32.add (i32.const ${VR})
        (if (result i32) (i32.and (local.get $a) (i32.const 0x10000))
          (then (i32.add (i32.const 0x10000) (i32.and (local.get $a) (i32.const 0x7FFF))))
          (else (i32.and (local.get $a) (i32.const 0xFFFF))))))))
    (if (i32.eq (local.get $r) (i32.const 7)) (then (return (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FF))))))
    (if (i32.and (i32.ge_u (local.get $r) (i32.const 8)) (i32.le_u (local.get $r) (i32.const 13)))
      (then (return (i32.add (i32.const ${ROM}) (i32.and (local.get $a) (i32.const ${rom_mask}))))))
    (i32.const ${L.DEADBEEF}))

  (func $fetch16 (param $a i32) (result i32) (i32.load16_u (call $fetch_lin (i32.and (local.get $a) (i32.const -2)))))
  (func $fetch32 (param $a i32) (result i32) (i32.load (call $fetch_lin (i32.and (local.get $a) (i32.const -4)))))

  ;; GBALoadBad: the open bus - the DMA's last word right after/while a
  ;; DMA runs, otherwise the pipeline's prefetch[1] (Thumb: per region).
  (func $load_bad (result i32)
    (local $v i32) (local $p i32) (local $p0 i32) (local $r i32)
    (local.set $p (i32.load (i32.const ${REGS + 60})))
    (if (i32.or (i32.ne (global.get $performingDMA) (i32.const 0))
                (i32.eq (i32.sub (local.get $p) (global.get $dmaPC))
                        (if (result i32) (global.get $thumb) (then (i32.const 2)) (else (i32.const 4)))))
      (then (return (global.get $bus))))
    (if (i32.eqz (global.get $thumb)) (then (return (call $fetch32 (local.get $p)))))
    (local.set $v (call $fetch16 (local.get $p)))
    (local.set $p0 (call $fetch16 (i32.sub (local.get $p) (i32.const 2))))
    (local.set $r (i32.shr_u (local.get $p) (i32.const 24)))
    (if (i32.or (i32.eqz (local.get $r)) (i32.eq (local.get $r) (i32.const 7)))
      (then (return (i32.or (i32.shl (local.get $v) (i32.const 16)) (local.get $p0)))))
    (if (i32.eq (local.get $r) (i32.const 3))
      (then (return (if (result i32) (i32.and (local.get $p) (i32.const 2))
        (then (i32.or (i32.shl (local.get $v) (i32.const 16)) (local.get $p0)))
        (else (i32.or (local.get $v) (i32.shl (local.get $p0) (i32.const 16))))))))
    (i32.or (local.get $v) (i32.shl (local.get $v) (i32.const 16))))

  ;; GBAMemoryStall (prefetch buffer)
  (func $stall (param $wait i32) (result i32)
    (local $prev i32) (local $dist i32) (local $maxl i32) (local $s i32) (local $st i32) (local $loads i32)
    (if (i32.or (i32.lt_s (global.get $areg) (i32.const 8)) (i32.eqz (global.get $prefetch)))
      (then (return (local.get $wait))))
    (local.set $dist (i32.sub (global.get $lpp) (i32.load (i32.const ${REGS + 60}))))
    (local.set $maxl (i32.const 8))
    (if (i32.lt_u (local.get $dist) (i32.const 16))
      (then (local.set $prev (i32.shr_u (local.get $dist) (i32.const 1)))
            (local.set $maxl (i32.sub (local.get $maxl) (local.get $prev)))))
    (local.set $s (global.get $aseq16))
    (local.set $st (i32.add (local.get $s) (i32.const 1)))
    (local.set $loads (i32.const 1))
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.and (i32.lt_s (local.get $st) (local.get $wait)) (i32.lt_s (local.get $loads) (local.get $maxl)))))
      (local.set $st (i32.add (local.get $st) (i32.add (local.get $s) (i32.const 1))))
      (local.set $loads (i32.add (local.get $loads) (i32.const 1)))
      (br $l)))
    (global.set $lpp (i32.add (i32.load (i32.const ${REGS + 60}))
      (i32.shl (i32.sub (i32.add (local.get $loads) (local.get $prev)) (i32.const 1)) (i32.const 1))))
    (if (i32.gt_s (local.get $st) (local.get $wait)) (then (local.set $wait (local.get $st))))
    (local.set $wait (i32.sub (local.get $wait) (i32.sub (global.get $anon16) (local.get $s))))
    (i32.sub (local.get $wait) (local.get $st)))

  ;; GBAMemoryStallVRAM
  (func $stall_vram (param $wait i32) (param $extra i32) (result i32)
    (local $until i32) (local $period i32) (local $st i32) (local $i i32) (local $e i32)
    (local.set $until (call $until (i32.const ${EV_VIDEO})))
    (local.set $period (i32.and (i32.sub (i32.const 0) (local.get $until)) (i32.const 31)))
    (local.set $st (local.get $until))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 16)))
      (local.set $e (i32.load16_u (i32.add (i32.const ${L.VSTALL}) (i32.shl (i32.and (i32.add (local.get $period) (local.get $i)) (i32.const 31)) (i32.const 1)))))
      (if (i32.eqz (i32.and (local.get $e) (global.get $stallMask)))
        (then
          (if (i32.eqz (local.get $extra)) (then (local.set $st (local.get $i)) (br $d)))
          (local.set $extra (i32.sub (local.get $extra) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.set $st (i32.sub (local.get $st) (local.get $wait)))
    (if (i32.lt_s (local.get $st) (i32.const 0)) (then (return (i32.const 0))))
    (local.get $st))

  (func $vram_stall_region (param $a i32) (result i32)
    ;; (address & 0x1FFFF) < (mode >= 3 ? 0x14000 : 0x10000)
    (i32.lt_u (i32.and (local.get $a) (i32.const 0x1FFFF))
      (if (result i32) (i32.ge_u (i32.and (i32.load16_u (i32.const ${IO})) (i32.const 7)) (i32.const 3))
        (then (i32.const 0x14000)) (else (i32.const 0x10000)))))

  ;; VRAM byte offset for an access (mirroring), or -1 for the bitmap-mode hole.
  (func $vram_off (param $a i32) (result i32)
    (if (i32.ge_u (i32.and (local.get $a) (i32.const 0x1FFFF)) (i32.const 0x18000))
      (then
        (if (i32.and (i32.eq (i32.and (local.get $a) (i32.const 0x1C000)) (i32.const 0x18000))
                     (i32.ge_u (i32.and (i32.load16_u (i32.const ${IO})) (i32.const 7)) (i32.const 3)))
          (then (return (i32.const -1))))
        (return (i32.and (local.get $a) (i32.const 0x17FFF)))))
    (i32.and (local.get $a) (i32.const 0x1FFFF)))

  (func $ws (param $table i32) (param $r i32) (result i32)
    (i32.load8_s (i32.add (i32.add (i32.const ${WS}) (i32.shl (local.get $table) (i32.const 8))) (local.get $r))))

  (func $rom_oob (param $a i32) (result i32)
    (i32.ge_u (i32.and (local.get $a) (i32.const 0x1FFFFFF)) (i32.const ${romEnd})))

  ;; GBALoad32
  (func $ld32 (param $a i32) (param $cnt i32) (result i32)
    (local $v i32) (local $w i32) (local $r i32) (local $o i32)
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (block $done
      (block $bad (block $sram (block $cart (block $oam (block $vram (block $pal (block $io (block $iw (block $ew (block $bios
        (br_table $bios $bad $ew $iw $io $pal $vram $oam $cart $cart $cart $cart $cart $cart $sram $sram $bad
          (if (result i32) (i32.gt_u (local.get $r) (i32.const 15)) (then (i32.const 16)) (else (local.get $r)))))
        ;; LOAD_BIOS
        (if (i32.lt_u (local.get $a) (i32.const 0x4000))
          (then (local.set $v (if (result i32) (i32.eqz (global.get $areg))
                  (then (i32.load (i32.add (i32.const ${BIOS}) (i32.and (local.get $a) (i32.const 0x3FFC)))))
                  (else (global.get $biosPrefetch)))))
          (else (local.set $v (call $load_bad))))
        (br $done))
        (local.set $v (i32.load (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFC)))))
        (local.set $w (call $ws (i32.const 2) (i32.const 2)))
        (br $done))
        (local.set $v (i32.load (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFC)))))
        (br $done))
        (local.set $v (i32.or (call $io_read (i32.and (local.get $a) (i32.const 0xFFFFFC)))
                              (i32.shl (call $io_read (i32.or (i32.and (local.get $a) (i32.const 0xFFFFFE)) (i32.const 2))) (i32.const 16))))
        (br $done))
        (local.set $v (i32.load (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FC)))))
        (local.set $w (call $ws (i32.const 2) (i32.const 5)))
        (br $done))
        (local.set $o (call $vram_off (local.get $a)))
        (local.set $v (if (result i32) (i32.lt_s (local.get $o) (i32.const 0)) (then (i32.const 0))
          (else (i32.load (i32.add (i32.const ${VR}) (i32.and (local.get $o) (i32.const -4)))))))
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.and (i32.ne (global.get $stallMask) (i32.const 0)) (call $vram_stall_region (local.get $a)))
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 1))))))
        (br $done))
        (local.set $v (i32.load (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FC)))))
        (br $done))
        ;; LOAD_CART
        (local.set $w (call $ws (i32.const 2) (local.get $r)))
        (if (call $rom_oob (i32.and (local.get $a) (i32.const -4)))
          (then (local.set $v (i32.or (i32.and (i32.shr_u (i32.and (local.get $a) (i32.const -4)) (i32.const 1)) (i32.const 0xFFFF))
                                      (i32.shl (i32.shr_u (i32.add (i32.and (local.get $a) (i32.const -4)) (i32.const 2)) (i32.const 1)) (i32.const 16)))))
          (else (local.set $v ${romLd("i32.load", "(local.get $a)", 0x1FFFFFC)})))
        (br $done))
        ;; LOAD_SRAM
        (local.set $w (call $ws (i32.const 0) (local.get $r)))
        (local.set $v (call $ld8 (local.get $a) (i32.const 0)))
        (local.set $v (i32.mul (local.get $v) (i32.const 0x01010101)))
        (br $done))
      (local.set $v (call $load_bad)))
    (if (local.get $cnt)
      (then
        (local.set $w (i32.add (local.get $w) (i32.const 2)))
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w)))))
    (i32.rotr (local.get $v) (i32.shl (i32.and (local.get $a) (i32.const 3)) (i32.const 3))))

  ;; GBALoad16
  (func $ld16 (param $a i32) (param $cnt i32) (result i32)
    (local $v i32) (local $w i32) (local $r i32) (local $o i32)
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (block $done
      (block $bad (block $sram (block $rom2ex (block $cart (block $oam (block $vram (block $pal (block $io (block $iw (block $ew (block $bios
        (br_table $bios $bad $ew $iw $io $pal $vram $oam $cart $cart $cart $cart $cart $rom2ex $sram $sram $bad
          (if (result i32) (i32.gt_u (local.get $r) (i32.const 15)) (then (i32.const 16)) (else (local.get $r)))))
        (if (i32.lt_u (local.get $a) (i32.const 0x4000))
          (then (local.set $v (if (result i32) (i32.eqz (global.get $areg))
                  (then (i32.load16_u (i32.add (i32.const ${BIOS}) (i32.and (local.get $a) (i32.const 0x3FFE)))))
                  (else (i32.and (i32.shr_u (global.get $biosPrefetch) (i32.shl (i32.and (local.get $a) (i32.const 2)) (i32.const 3))) (i32.const 0xFFFF))))))
          (else (local.set $v (i32.and (i32.shr_u (call $load_bad) (i32.shl (i32.and (local.get $a) (i32.const 2)) (i32.const 3))) (i32.const 0xFFFF)))))
        (br $done))
        (local.set $v (i32.load16_u (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFE)))))
        (local.set $w (call $ws (i32.const 0) (i32.const 2)))
        (br $done))
        (local.set $v (i32.load16_u (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFE)))))
        (br $done))
        (local.set $v (call $io_read (i32.and (local.get $a) (i32.const 0xFFFFFE))))
        (br $done))
        (local.set $v (i32.load16_u (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FE)))))
        (br $done))
        (local.set $o (call $vram_off (local.get $a)))
        (if (i32.lt_s (local.get $o) (i32.const 0)) (then (local.set $v (i32.const 0)) (br $done)))
        (local.set $v (i32.load16_u (i32.add (i32.const ${VR}) (i32.and (local.get $o) (i32.const -2)))))
        (if (i32.and (i32.ne (global.get $stallMask) (i32.const 0)) (call $vram_stall_region (local.get $a)))
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 0))))))
        (br $done))
        (local.set $v (i32.load16_u (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FE)))))
        (br $done))
        (local.set $w (call $ws (i32.const 0) (local.get $r)))
        (local.set $v (if (result i32) (call $rom_oob (i32.and (local.get $a) (i32.const -2)))
          (then (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0xFFFF)))
          (else ${romLd("i32.load16_u", "(local.get $a)", 0x1FFFFFE)})))
        (br $done))
        ;; ROM2_EX: the EEPROM when there is one
        (local.set $w (call $ws (i32.const 0) (local.get $r)))
        (if (i32.or (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM})) (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM512})))
          (then (local.set $v (call $eeprom_read)) (br $done)))
        (local.set $v (if (result i32) (call $rom_oob (i32.and (local.get $a) (i32.const -2)))
          (then (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0xFFFF)))
          (else ${romLd("i32.load16_u", "(local.get $a)", 0x1FFFFFE)})))
        (br $done))
        (local.set $w (call $ws (i32.const 0) (local.get $r)))
        (local.set $v (call $ld8 (local.get $a) (i32.const 0)))
        (local.set $v (i32.or (local.get $v) (i32.shl (local.get $v) (i32.const 8))))
        (br $done))
      (local.set $v (i32.and (i32.shr_u (call $load_bad) (i32.shl (i32.and (local.get $a) (i32.const 2)) (i32.const 3))) (i32.const 0xFFFF))))
    (if (local.get $cnt)
      (then
        (local.set $w (i32.add (local.get $w) (i32.const 2)))
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w)))))
    (i32.rotr (local.get $v) (i32.shl (i32.and (local.get $a) (i32.const 1)) (i32.const 3))))

  ;; GBALoad8
  (func $ld8 (param $a i32) (param $cnt i32) (result i32)
    (local $v i32) (local $w i32) (local $r i32) (local $o i32)
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (block $done
      (block $bad (block $sram (block $cart (block $oam (block $vram (block $pal (block $io (block $iw (block $ew (block $bios
        (br_table $bios $bad $ew $iw $io $pal $vram $oam $cart $cart $cart $cart $cart $cart $sram $sram $bad
          (if (result i32) (i32.gt_u (local.get $r) (i32.const 15)) (then (i32.const 16)) (else (local.get $r)))))
        (if (i32.lt_u (local.get $a) (i32.const 0x4000))
          (then (local.set $v (if (result i32) (i32.eqz (global.get $areg))
                  (then (i32.load8_u (i32.add (i32.const ${BIOS}) (local.get $a))))
                  (else (i32.and (i32.shr_u (global.get $biosPrefetch) (i32.shl (i32.and (local.get $a) (i32.const 3)) (i32.const 3))) (i32.const 0xFF))))))
          (else (local.set $v (i32.and (i32.shr_u (call $load_bad) (i32.shl (i32.and (local.get $a) (i32.const 3)) (i32.const 3))) (i32.const 0xFF)))))
        (br $done))
        (local.set $v (i32.load8_u (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFF)))))
        (local.set $w (call $ws (i32.const 0) (i32.const 2)))
        (br $done))
        (local.set $v (i32.load8_u (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFF)))))
        (br $done))
        (local.set $v (i32.and (i32.shr_u (call $io_read (i32.and (local.get $a) (i32.const 0xFFFE)))
                                          (i32.shl (i32.and (local.get $a) (i32.const 1)) (i32.const 3))) (i32.const 0xFF)))
        (br $done))
        (local.set $v (i32.load8_u (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FF)))))
        (br $done))
        (local.set $o (call $vram_off (local.get $a)))
        (if (i32.lt_s (local.get $o) (i32.const 0)) (then (local.set $v (i32.const 0)) (br $done)))
        (local.set $v (i32.load8_u (i32.add (i32.const ${VR}) (local.get $o))))
        (if (global.get $stallMask)
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 0))))))
        (br $done))
        (local.set $v (i32.load8_u (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FF)))))
        (br $done))
        (local.set $w (call $ws (i32.const 0) (local.get $r)))
        (local.set $v (if (result i32) (call $rom_oob (local.get $a))
          (then (i32.and (i32.shr_u (i32.shr_u (local.get $a) (i32.const 1)) (i32.shl (i32.and (local.get $a) (i32.const 1)) (i32.const 3))) (i32.const 0xFF)))
          (else ${romLd("i32.load8_u", "(local.get $a)", 0x1FFFFFF)})))
        (br $done))
        (local.set $w (call $ws (i32.const 0) (local.get $r)))
        (local.set $v (call $sram_read8 (local.get $a)))
        (br $done))
      (local.set $v (i32.and (i32.shr_u (call $load_bad) (i32.shl (i32.and (local.get $a) (i32.const 3)) (i32.const 3))) (i32.const 0xFF))))
    (if (local.get $cnt)
      (then
        (local.set $w (i32.add (local.get $w) (i32.const 2)))
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w)))))
    (local.get $v))

  ;; the SRAM-region byte read (GBALoad8's SRAM case, autodetect included)
  (func $sram_read8 (param $a i32) (result i32)
    (if (i32.eq (global.get $saveType) (i32.const ${SAVE_AUTODETECT}))
      (then (call $save_init (i32.const ${SAVE_SRAM}))))
    (if (i32.eq (global.get $performingDMA) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.eq (global.get $saveType) (i32.const ${SAVE_SRAM}))
      (then (return (i32.load8_u (i32.add (i32.const ${SAVE}) (i32.and (local.get $a) (i32.const 0x7FFF)))))))
    (if (i32.or (i32.eq (global.get $saveType) (i32.const ${SAVE_FLASH512})) (i32.eq (global.get $saveType) (i32.const ${SAVE_FLASH1M})))
      (then (return (call $flash_read (i32.and (local.get $a) (i32.const 0xFFFF))))))
    ;; a tilt sensor cart (gpio.js; -1 without one)
    (if (i32.ge_s (call $tilt_read (local.get $a)) (i32.const 0)) (then (return (call $tilt_read (local.get $a)))))
    (if (i32.eq (global.get $saveType) (i32.const ${SAVE_SRAM512}))
      (then (return (i32.load8_u (i32.add (i32.const ${SAVE}) (i32.and (local.get $a) (i32.const 0xFFFF)))))))
    (i32.const 0xFF))

  ;; GBAStore32
  (func $st32 (param $a i32) (param $v i32) (param $cnt i32)
    (local $w i32) (local $r i32) (local $o i32)
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (block $done
      (block $bad (block $sram (block $cart (block $oam (block $vram (block $pal (block $io (block $iw (block $ew
        (br_table $bad $bad $ew $iw $io $pal $vram $oam $cart $cart $cart $cart $cart $cart $sram $sram $bad
          (if (result i32) (i32.gt_u (local.get $r) (i32.const 15)) (then (i32.const 16)) (else (local.get $r)))))
        (i32.store (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFC))) (local.get $v))
        (local.set $w (call $ws (i32.const 2) (i32.const 2)))
        (br $done))
        (i32.store (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFC))) (local.get $v))
        (br $done))
        (call $io_write32 (i32.and (local.get $a) (i32.const 0xFFFFFC)) (local.get $v))
        (br $done))
        (i32.store (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FC))) (local.get $v))
        (local.set $w (call $ws (i32.const 2) (i32.const 5)))
        (br $done))
        (local.set $o (call $vram_off (local.get $a)))
        (if (i32.ge_s (local.get $o) (i32.const 0))
          (then (i32.store (i32.add (i32.const ${VR}) (i32.and (local.get $o) (i32.const -4))) (local.get $v))))
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.and (i32.ne (global.get $stallMask) (i32.const 0)) (call $vram_stall_region (local.get $a)))
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 1))))))
        (br $done))
        (i32.store (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FC))) (local.get $v))
        (br $done))
        (local.set $w (call $ws (i32.const 2) (local.get $r)))
        (br $done))
        (call $st8 (local.get $a) (i32.shr_u (local.get $v) (i32.shl (i32.and (local.get $a) (i32.const 3)) (i32.const 3))) (local.get $cnt))
        (br $done))
      (nop))
    (if (local.get $cnt)
      (then
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w))))))

  ;; GBAStore16
  (func $st16 (param $a i32) (param $v i32) (param $cnt i32)
    (local $w i32) (local $r i32) (local $o i32)
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFFFF)))
    (block $done
      (block $bad (block $sram (block $rom2ex (block $cart (block $oam (block $vram (block $pal (block $io (block $iw (block $ew
        (br_table $bad $bad $ew $iw $io $pal $vram $oam $cart $cart $cart $cart $cart $rom2ex $sram $sram $bad
          (if (result i32) (i32.gt_u (local.get $r) (i32.const 15)) (then (i32.const 16)) (else (local.get $r)))))
        (i32.store16 (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFE))) (local.get $v))
        (local.set $w (call $ws (i32.const 0) (i32.const 2)))
        (br $done))
        (i32.store16 (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFE))) (local.get $v))
        (br $done))
        (call $io_write (i32.and (local.get $a) (i32.const 0xFFFFFE)) (local.get $v))
        (br $done))
        (i32.store16 (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FE))) (local.get $v))
        (br $done))
        (local.set $o (call $vram_off (local.get $a)))
        (if (i32.lt_s (local.get $o) (i32.const 0)) (then (br $done)))
        (i32.store16 (i32.add (i32.const ${VR}) (i32.and (local.get $o) (i32.const -2))) (local.get $v))
        (if (i32.and (i32.ne (global.get $stallMask) (i32.const 0)) (call $vram_stall_region (local.get $a)))
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 0))))))
        (br $done))
        (i32.store16 (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FE))) (local.get $v))
        (br $done))
        ;; ROM0: the GPIO port (gpio.js; a no-op without a GPIO device)
        (if (i32.eq (local.get $r) (i32.const 8))
          (then
            (local.set $o (i32.and (local.get $a) (i32.const 0xFFFFFE)))
            (if (i32.or (i32.eq (local.get $o) (i32.const 0xC4)) (i32.or (i32.eq (local.get $o) (i32.const 0xC6)) (i32.eq (local.get $o) (i32.const 0xC8))))
              (then (call $gpio_write (local.get $o) (local.get $v))))))
        (br $done))   ;; no matrix/AGBPrint on these carts
        ;; ROM2_EX: EEPROM
        (if (i32.eq (global.get $saveType) (i32.const ${SAVE_AUTODETECT}))
          (then (call $save_init (i32.const ${SAVE_EEPROM512}))))
        (if (i32.or (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM})) (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM512})))
          (then (call $eeprom_write (local.get $v) (i32.const 1))))
        (br $done))
        (if (i32.and (local.get $a) (i32.const 1)) (then (local.set $v (i32.shr_u (local.get $v) (i32.const 8)))))
        (call $st8 (local.get $a) (local.get $v) (local.get $cnt))
        (br $done))
      (nop))
    (if (local.get $cnt)
      (then
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w))))))

  ;; GBAStore8
  (func $st8 (param $a i32) (param $v i32) (param $cnt i32)
    (local $w i32) (local $r i32) (local $o i32)
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (block $done
      (block $bad (block $sram (block $oam (block $vram (block $pal (block $io (block $iw (block $ew
        (br_table $bad $bad $ew $iw $io $pal $vram $oam $bad $bad $bad $bad $bad $bad $sram $sram $bad
          (if (result i32) (i32.gt_u (local.get $r) (i32.const 15)) (then (i32.const 16)) (else (local.get $r)))))
        (i32.store8 (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFF))) (local.get $v))
        (local.set $w (call $ws (i32.const 0) (i32.const 2)))
        (br $done))
        (i32.store8 (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFF))) (local.get $v))
        (br $done))
        (call $io_write8 (i32.and (local.get $a) (i32.const 0xFFFFFF)) (local.get $v))
        (br $done))
        (call $st16 (i32.and (local.get $a) (i32.const -2)) (i32.mul (local.get $v) (i32.const 0x101)) (local.get $cnt))
        (br $done))
        (if (i32.ge_u (i32.and (local.get $a) (i32.const 0x1FFFF))
              (if (result i32) (i32.ge_u (i32.and (i32.load16_u (i32.const ${IO})) (i32.const 7)) (i32.const 3))
                (then (i32.const 0x14000)) (else (i32.const 0x10000))))
          (then (br $done)))
        (i32.store16 (i32.add (i32.const ${VR}) (i32.and (local.get $a) (i32.const 0x1FFFE))) (i32.mul (local.get $v) (i32.const 0x101)))
        (if (global.get $stallMask)
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 0))))))
        (br $done))
        (br $done))   ;; Cannot Store8 to OAM
        (call $sram_write8 (local.get $a) (local.get $v))
        (local.set $w (call $ws (i32.const 0) (i32.const 14)))
        (br $done))
      (nop))
    (if (local.get $cnt)
      (then
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w))))))

  (func $sram_write8 (param $a i32) (param $v i32)
    (if (i32.eq (global.get $saveType) (i32.const ${SAVE_AUTODETECT}))
      (then (call $save_init (if (result i32) (i32.eq (local.get $a) (i32.const 0x0E005555))
                                (then (i32.const ${SAVE_FLASH512})) (else (i32.const ${SAVE_SRAM}))))))
    (if (i32.or (i32.eq (global.get $saveType) (i32.const ${SAVE_FLASH512})) (i32.eq (global.get $saveType) (i32.const ${SAVE_FLASH1M})))
      (then (call $flash_write (i32.and (local.get $a) (i32.const 0xFFFF)) (local.get $v)) (return)))
    (if (i32.eq (global.get $saveType) (i32.const ${SAVE_SRAM}))
      (then (i32.store8 (i32.add (i32.const ${SAVE}) (i32.and (local.get $a) (i32.const 0x7FFF))) (local.get $v)) (return)))
    (if (call $tilt_write (local.get $a) (local.get $v)) (then (return)))
    (if (i32.eq (global.get $saveType) (i32.const ${SAVE_SRAM512}))
      (then (i32.store8 (i32.add (i32.const ${SAVE}) (i32.and (local.get $a) (i32.const 0xFFFF))) (local.get $v)))))

  ;; GBALoadMultiple. dir: 0 IA, 1 IB, 2 DA, 3 DB. Registers land in REGS.
  (func $ldm (param $a i32) (param $mask i32) (param $dir i32) (param $cnt i32) (result i32)
    (local $off i32) (local $pop i32) (local $mis i32) (local $r i32) (local $w i32) (local $i i32) (local $v i32) (local $o i32)
    (local.set $off (i32.const 4))
    (if (i32.and (local.get $dir) (i32.const 2))
      (then (local.set $off (i32.const -4))
            (local.set $pop (i32.popcnt (local.get $mask)))
            (local.set $a (i32.sub (local.get $a) (i32.sub (i32.shl (local.get $pop) (i32.const 2)) (i32.const 4))))))
    (if (i32.and (local.get $dir) (i32.const 1)) (then (local.set $a (i32.add (local.get $a) (local.get $off)))))
    (local.set $mis (i32.and (local.get $a) (i32.const 3)))
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (if (i32.lt_u (local.get $r) (i32.const 14)) (then (local.set $a (i32.and (local.get $a) (i32.const -4)))))
    (local.set $w (i32.sub (call $ws (i32.const 3) (local.get $r)) (call $ws (i32.const 2) (local.get $r))))
    (if (i32.eqz (local.get $mask))
      (then
        (local.set $v (call $lsm_load (local.get $a) (local.get $r) (local.get $w)))
        (local.set $w (global.get $lsmw))
        (i32.store (i32.const ${REGS + 60}) (local.get $v))
        (local.set $w (i32.add (local.get $w) (i32.const 16)))
        (local.set $a (i32.add (local.get $a) (i32.const 64)))))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 16)))
      (if (i32.and (local.get $mask) (i32.shl (i32.const 1) (local.get $i)))
        (then
          (local.set $v (call $lsm_load (local.get $a) (local.get $r) (local.get $w)))
          (local.set $w (global.get $lsmw))
          (i32.store (i32.add (i32.const ${REGS}) (i32.shl (local.get $i) (i32.const 2))) (local.get $v))
          (local.set $w (i32.add (local.get $w) (i32.const 1)))
          (local.set $a (i32.add (local.get $a) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (if (local.get $cnt)
      (then
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w)))))
    (if (i32.and (local.get $dir) (i32.const 1)) (then (local.set $a (i32.sub (local.get $a) (local.get $off)))))
    (if (i32.and (local.get $dir) (i32.const 2))
      (then (local.set $a (i32.sub (local.get $a) (i32.add (i32.shl (local.get $pop) (i32.const 2)) (i32.const 4))))))
    (i32.or (local.get $a) (local.get $mis)))

  (global $lsmw (mut i32) (i32.const 0))
  ;; One LDM_LOOP word through the region macro of the STARTING address's
  ;; region (mGBA picks the region once for the whole transfer). $w is the
  ;; transfer's running wait, which the macros add to (and the VRAM stall
  ;; is computed from); the new running wait comes back in $lsmw.
  (func $lsm_load (param $a i32) (param $r i32) (param $w i32) (result i32)
    (local $v i32) (local $o i32)
    (global.set $lsmw (local.get $w))
    (if (i32.eqz (local.get $r))
      (then (return (if (result i32) (i32.lt_u (local.get $a) (i32.const 0x4000))
        (then (if (result i32) (i32.eqz (global.get $areg))
          (then (i32.load (i32.add (i32.const ${BIOS}) (i32.and (local.get $a) (i32.const 0x3FFC)))))
          (else (global.get $biosPrefetch))))
        (else (call $load_bad))))))
    (if (i32.eq (local.get $r) (i32.const 2))
      (then (global.set $lsmw (i32.add (local.get $w) (call $ws (i32.const 3) (i32.const 2))))
            (return (i32.load (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFC)))))))
    (if (i32.eq (local.get $r) (i32.const 3))
      (then (return (i32.load (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFC)))))))
    (if (i32.eq (local.get $r) (i32.const 4))
      (then (return (i32.or (call $io_read (i32.and (local.get $a) (i32.const 0xFFFFFC)))
                            (i32.shl (call $io_read (i32.or (i32.and (local.get $a) (i32.const 0xFFFFFE)) (i32.const 2))) (i32.const 16))))))
    (if (i32.eq (local.get $r) (i32.const 5))
      (then (global.set $lsmw (i32.add (local.get $w) (call $ws (i32.const 3) (i32.const 5))))
            (return (i32.load (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FC)))))))
    (if (i32.eq (local.get $r) (i32.const 6))
      (then
        (local.set $o (call $vram_off (local.get $a)))
        (local.set $v (if (result i32) (i32.lt_s (local.get $o) (i32.const 0)) (then (i32.const 0))
          (else (i32.load (i32.add (i32.const ${VR}) (i32.and (local.get $o) (i32.const -4)))))))
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.and (i32.ne (global.get $stallMask) (i32.const 0)) (call $vram_stall_region (local.get $a)))
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 1))))))
        (global.set $lsmw (local.get $w))
        (return (local.get $v))))
    (if (i32.eq (local.get $r) (i32.const 7))
      (then (return (i32.load (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FC)))))))
    (if (i32.and (i32.ge_u (local.get $r) (i32.const 8)) (i32.le_u (local.get $r) (i32.const 13)))
      (then
        (global.set $lsmw (i32.add (local.get $w) (call $ws (i32.const 3) (local.get $r))))
        (return (if (result i32) (call $rom_oob (i32.and (local.get $a) (i32.const -4)))
          (then (i32.or (i32.and (i32.shr_u (i32.and (local.get $a) (i32.const -4)) (i32.const 1)) (i32.const 0xFFFF))
                        (i32.shl (i32.shr_u (i32.add (i32.and (local.get $a) (i32.const -4)) (i32.const 2)) (i32.const 1)) (i32.const 16))))
          (else ${romLd("i32.load", "(local.get $a)", 0x1FFFFFC)})))))
    (if (i32.or (i32.eq (local.get $r) (i32.const 14)) (i32.eq (local.get $r) (i32.const 15)))
      (then
        ;; LOAD_SRAM ASSIGNS the wait: \`wait = waitstatesNonseq16[region]\`
        (global.set $lsmw (call $ws (i32.const 0) (local.get $r)))
        (return (i32.mul (call $ld8 (local.get $a) (i32.const 0)) (i32.const 0x01010101)))))
    (call $load_bad))

  ;; GBAStoreMultiple
  (func $stm (param $a i32) (param $mask i32) (param $dir i32) (param $cnt i32) (result i32)
    (local $off i32) (local $pop i32) (local $mis i32) (local $r i32) (local $w i32) (local $i i32) (local $v i32)
    (local.set $off (i32.const 4))
    (if (i32.and (local.get $dir) (i32.const 2))
      (then (local.set $off (i32.const -4))
            (local.set $pop (i32.popcnt (local.get $mask)))
            (local.set $a (i32.sub (local.get $a) (i32.sub (i32.shl (local.get $pop) (i32.const 2)) (i32.const 4))))))
    (if (i32.and (local.get $dir) (i32.const 1)) (then (local.set $a (i32.add (local.get $a) (local.get $off)))))
    (local.set $mis (i32.and (local.get $a) (i32.const 3)))
    (local.set $r (i32.shr_u (local.get $a) (i32.const 24)))
    (if (i32.lt_u (local.get $r) (i32.const 14)) (then (local.set $a (i32.and (local.get $a) (i32.const -4)))))
    (local.set $w (i32.sub (call $ws (i32.const 3) (local.get $r)) (call $ws (i32.const 2) (local.get $r))))
    (if (i32.eqz (local.get $mask))
      (then
        (local.set $v (i32.add (i32.load (i32.const ${REGS + 60}))
                               (if (result i32) (global.get $thumb) (then (i32.const 2)) (else (i32.const 4)))))
        (local.set $w (call $lsm_store (local.get $a) (local.get $r) (local.get $v) (local.get $cnt) (local.get $w)))
        (local.set $w (i32.add (local.get $w) (i32.const 16)))
        (local.set $a (i32.add (local.get $a) (i32.const 64)))))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 16)))
      (if (i32.and (local.get $mask) (i32.shl (i32.const 1) (local.get $i)))
        (then
          (local.set $v (i32.load (i32.add (i32.const ${REGS}) (i32.shl (local.get $i) (i32.const 2)))))
          (if (i32.eq (local.get $i) (i32.const 15)) (then (local.set $v (i32.add (local.get $v) (i32.const 4)))))
          (local.set $w (call $lsm_store (local.get $a) (local.get $r) (local.get $v) (local.get $cnt) (local.get $w)))
          (local.set $w (i32.add (local.get $w) (i32.const 1)))
          (local.set $a (i32.add (local.get $a) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (if (local.get $cnt)
      (then
        (if (i32.lt_u (local.get $a) (i32.const 0x08000000)) (then (local.set $w (call $stall (local.get $w)))))
        (global.set $cc (i32.add (global.get $cc) (local.get $w)))))
    (if (i32.and (local.get $dir) (i32.const 1)) (then (local.set $a (i32.sub (local.get $a) (local.get $off)))))
    (if (i32.and (local.get $dir) (i32.const 2))
      (then (local.set $a (i32.sub (local.get $a) (i32.add (i32.shl (local.get $pop) (i32.const 2)) (i32.const 4))))))
    (i32.or (local.get $a) (local.get $mis)))

  ;; One STM_LOOP word: takes and returns the transfer's running wait.
  (func $lsm_store (param $a i32) (param $r i32) (param $v i32) (param $cnt i32) (param $w i32) (result i32)
    (local $o i32)
    (if (i32.eq (local.get $r) (i32.const 2))
      (then (i32.store (i32.add (i32.const ${EW}) (i32.and (local.get $a) (i32.const 0x3FFFC))) (local.get $v))
            (return (i32.add (local.get $w) (call $ws (i32.const 3) (i32.const 2))))))
    (if (i32.eq (local.get $r) (i32.const 3))
      (then (i32.store (i32.add (i32.const ${IW}) (i32.and (local.get $a) (i32.const 0x7FFC))) (local.get $v))
            (return (local.get $w))))
    (if (i32.eq (local.get $r) (i32.const 4))
      (then (call $io_write32 (i32.and (local.get $a) (i32.const 0xFFFFFC)) (local.get $v)) (return (local.get $w))))
    (if (i32.eq (local.get $r) (i32.const 5))
      (then (i32.store (i32.add (i32.const ${PAL}) (i32.and (local.get $a) (i32.const 0x3FC))) (local.get $v))
            (return (i32.add (local.get $w) (call $ws (i32.const 3) (i32.const 5))))))
    (if (i32.eq (local.get $r) (i32.const 6))
      (then
        (local.set $o (call $vram_off (local.get $a)))
        (if (i32.ge_s (local.get $o) (i32.const 0))
          (then (i32.store (i32.add (i32.const ${VR}) (i32.and (local.get $o) (i32.const -4))) (local.get $v))))
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (if (i32.and (i32.ne (global.get $stallMask) (i32.const 0)) (call $vram_stall_region (local.get $a)))
          (then (local.set $w (i32.add (local.get $w) (call $stall_vram (local.get $w) (i32.const 1))))))
        (return (local.get $w))))
    (if (i32.eq (local.get $r) (i32.const 7))
      (then (i32.store (i32.add (i32.const ${OAM}) (i32.and (local.get $a) (i32.const 0x3FC))) (local.get $v))
            (return (local.get $w))))
    (if (i32.and (i32.ge_u (local.get $r) (i32.const 8)) (i32.le_u (local.get $r) (i32.const 13)))
      (then (return (i32.add (local.get $w) (call $ws (i32.const 3) (local.get $r))))))
    (if (i32.or (i32.eq (local.get $r) (i32.const 14)) (i32.eq (local.get $r) (i32.const 15)))
      (then (call $st8 (local.get $a) (i32.shr_u (local.get $v) (i32.shl (i32.and (local.get $a) (i32.const 3)) (i32.const 3))) (local.get $cnt))
            (return (local.get $w))))
    (local.get $w))

  ;; GBAAdjustWaitstates (WAITCNT)
  (func $adjust_waitstates (param $p i32)
    (local $sram i32) (local $ws0 i32) (local $ws0s i32) (local $ws1 i32) (local $ws1s i32) (local $ws2 i32) (local $ws2s i32)
    (local $i i32) (local $n i32) (local $s i32)
    (local.set $sram (i32.load8_s (i32.add (i32.const ${L.ROMWS}) (i32.and (local.get $p) (i32.const 3)))))
    (local.set $ws0 (i32.load8_s (i32.add (i32.const ${L.ROMWS}) (i32.and (i32.shr_u (local.get $p) (i32.const 2)) (i32.const 3)))))
    (local.set $ws0s (i32.load8_s (i32.add (i32.const ${L.ROMWSS}) (i32.and (i32.shr_u (local.get $p) (i32.const 4)) (i32.const 1)))))
    (local.set $ws1 (i32.load8_s (i32.add (i32.const ${L.ROMWS}) (i32.and (i32.shr_u (local.get $p) (i32.const 5)) (i32.const 3)))))
    (local.set $ws1s (i32.load8_s (i32.add (i32.const ${L.ROMWSS + 2}) (i32.and (i32.shr_u (local.get $p) (i32.const 7)) (i32.const 1)))))
    (local.set $ws2 (i32.load8_s (i32.add (i32.const ${L.ROMWS}) (i32.and (i32.shr_u (local.get $p) (i32.const 8)) (i32.const 3)))))
    (local.set $ws2s (i32.load8_s (i32.add (i32.const ${L.ROMWSS + 4}) (i32.and (i32.shr_u (local.get $p) (i32.const 10)) (i32.const 1)))))
    ;; SRAM 14/15
    (call $setws (i32.const 14) (local.get $sram) (local.get $sram) (i32.add (i32.shl (local.get $sram) (i32.const 1)) (i32.const 1)) (i32.add (i32.shl (local.get $sram) (i32.const 1)) (i32.const 1)))
    (call $setws (i32.const 15) (local.get $sram) (local.get $sram) (i32.add (i32.shl (local.get $sram) (i32.const 1)) (i32.const 1)) (i32.add (i32.shl (local.get $sram) (i32.const 1)) (i32.const 1)))
    (call $setrom (i32.const 8) (local.get $ws0) (local.get $ws0s))
    (call $setrom (i32.const 10) (local.get $ws1) (local.get $ws1s))
    (call $setrom (i32.const 12) (local.get $ws2) (local.get $ws2s))
    (global.set $prefetch (i32.and (local.get $p) (i32.const 0x4000)))
    (if (i32.ge_s (global.get $areg) (i32.const 0)) (then (call $load_active_ws)))
    (call $dma_recalc_cycles))

  (func $setrom (param $r i32) (param $n i32) (param $s i32)
    (call $setws (local.get $r) (local.get $n) (local.get $s)
      (i32.add (i32.add (local.get $n) (i32.const 1)) (local.get $s))
      (i32.add (i32.shl (local.get $s) (i32.const 1)) (i32.const 1)))
    (call $setws (i32.add (local.get $r) (i32.const 1)) (local.get $n) (local.get $s)
      (i32.add (i32.add (local.get $n) (i32.const 1)) (local.get $s))
      (i32.add (i32.shl (local.get $s) (i32.const 1)) (i32.const 1))))

  (func $setws (param $r i32) (param $n16 i32) (param $s16 i32) (param $n32 i32) (param $s32 i32)
    (i32.store8 (i32.add (i32.const ${WS}) (local.get $r)) (local.get $n16))
    (i32.store8 (i32.add (i32.const ${WS + 256}) (local.get $r)) (local.get $s16))
    (i32.store8 (i32.add (i32.const ${WS + 512}) (local.get $r)) (local.get $n32))
    (i32.store8 (i32.add (i32.const ${WS + 768}) (local.get $r)) (local.get $s32)))

  ;; GBAAdjustEWRAMWaitstates
  (func $adjust_ewram (param $p i32)
    (local $w i32)
    (local.set $w (i32.sub (i32.const 15) (i32.and (i32.shr_u (local.get $p) (i32.const 8)) (i32.const 15))))
    (if (local.get $w)
      (then
        (call $setws (i32.const 2) (local.get $w) (local.get $w)
          (i32.add (i32.shl (local.get $w) (i32.const 1)) (i32.const 1))
          (i32.add (i32.shl (local.get $w) (i32.const 1)) (i32.const 1)))
        (if (i32.ge_s (global.get $areg) (i32.const 0)) (then (call $load_active_ws))))))

  ;; ======================= I/O (io.c) ====================================
  (func $io16 (param $o i32) (result i32) (i32.load16_u (i32.add (i32.const ${IO}) (local.get $o))))
  (func $io16w (param $o i32) (param $v i32) (i32.store16 (i32.add (i32.const ${IO}) (local.get $o)) (local.get $v)))

  (func $read_const (param $a i32) (result i32)   ;; GBAIOIsReadConstant
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x08)) (i32.le_u (local.get $a) (i32.const 0x0E))) (then (return (i32.const 1))))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x48)) (i32.or (i32.eq (local.get $a) (i32.const 0x4A))
          (i32.or (i32.eq (local.get $a) (i32.const 0x50)) (i32.eq (local.get $a) (i32.const 0x52))))) (then (return (i32.const 1))))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x60)) (i32.le_u (local.get $a) (i32.const 0x82)))
      (then (return (i32.or (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x60)) (i32.eq (local.get $a) (i32.const 0x62)))
                                    (i32.or (i32.eq (local.get $a) (i32.const 0x64)) (i32.eq (local.get $a) (i32.const 0x68))))
                            (i32.or (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x6C)) (i32.eq (local.get $a) (i32.const 0x70)))
                                            (i32.or (i32.eq (local.get $a) (i32.const 0x72)) (i32.eq (local.get $a) (i32.const 0x74))))
                                    (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x78)) (i32.eq (local.get $a) (i32.const 0x7C)))
                                            (i32.or (i32.eq (local.get $a) (i32.const 0x80)) (i32.eq (local.get $a) (i32.const 0x82)))))))))
    (if (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x102)) (i32.eq (local.get $a) (i32.const 0x106)))
                (i32.or (i32.eq (local.get $a) (i32.const 0x10A)) (i32.eq (local.get $a) (i32.const 0x10E)))) (then (return (i32.const 1))))
    (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x130)) (i32.eq (local.get $a) (i32.const 0x132)))
            (i32.eq (local.get $a) (i32.const 0x200))))

  ;; GBAIORead. $a is the offset from $04000000 (even, up to 24 bits).
  (func $io_read (param $a i32) (result i32)
    (local $in i32) (local $rl i32) (local $ud i32)
    (if (i32.eqz (call $read_const (local.get $a))) (then (global.set $haltPending (i32.const 0))))
    ;; timers: reading takes 1N+1I, removed up front (cyclesLate = 2)
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x100)) (i32.le_u (local.get $a) (i32.const 0x10C)))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 3)))
              (then (call $timer_update_register (i32.shr_u (i32.sub (local.get $a) (i32.const 0x100)) (i32.const 2)) (i32.const 2))
                    (return (call $io16 (local.get $a)))))))
    (if (i32.eq (local.get $a) (i32.const 0x130))
      (then
        (local.set $in (global.get $keysActive))
        (local.set $rl (i32.and (local.get $in) (i32.const 0x30)))
        (local.set $ud (i32.and (local.get $in) (i32.const 0xC0)))
        (local.set $in (i32.and (local.get $in) (i32.const 0x30F)))
        (if (i32.ne (local.get $rl) (i32.const 0x30)) (then (local.set $in (i32.or (local.get $in) (local.get $rl)))))
        (if (i32.ne (local.get $ud) (i32.const 0xC0)) (then (local.set $in (i32.or (local.get $in) (local.get $ud)))))
        (call $io16w (i32.const 0x130) (i32.xor (local.get $in) (i32.const 0x3FF)))
        (return (call $io16 (i32.const 0x130)))))
    (if (i32.eq (local.get $a) (i32.const 0x128)) (then (return (global.get $siocnt))))
    (if (i32.eq (local.get $a) (i32.const 0x134)) (then (return (global.get $rcnt))))
    ;; write-only registers read the open bus
    (if (i32.or (i32.and (i32.ge_u (local.get $a) (i32.const 0x10)) (i32.le_u (local.get $a) (i32.const 0x46)))
                (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x4C)) (i32.eq (local.get $a) (i32.const 0x54)))
                        (i32.and (i32.ge_u (local.get $a) (i32.const 0xA0)) (i32.le_u (local.get $a) (i32.const 0xA6)))))
      (then (return (call $load_bad))))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0xB0)) (i32.le_u (local.get $a) (i32.const 0xDE)))
      (then
        (local.set $in (i32.rem_u (i32.sub (local.get $a) (i32.const 0xB0)) (i32.const 12)))
        (if (i32.lt_u (local.get $in) (i32.const 8)) (then (return (call $load_bad))))
        (if (i32.eq (local.get $in) (i32.const 8)) (then (return (i32.const 0))))
        (return (call $io16 (local.get $a)))))
    (if (i32.eq (local.get $a) (i32.const 0x20A)) (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x150)) (i32.eq (local.get $a) (i32.const 0x152)))
      (then (call $io16w (i32.const 0x158) (i32.and (call $io16 (i32.const 0x158)) (i32.const -3)))
            (return (call $io16 (local.get $a)))))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x90)) (i32.le_u (local.get $a) (i32.const 0x9E)))
      (then (return (call $wave_read (local.get $a)))))
    ;; sound registers read zero while the sound circuit is off
    (if (call $is_sound_psg (local.get $a))
      (then (if (i32.eqz (i32.and (call $io16 (i32.const 0x84)) (i32.const 0x80))) (then (return (i32.const 0))))
            (return (call $io16 (local.get $a)))))
    (if (call $is_readable (local.get $a)) (then (return (call $io16 (local.get $a)))))
    (if (call $is_unused_zero (local.get $a)) (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x800)) (i32.eq (local.get $a) (i32.const 0x802)))
      (then (return (call $io16 (i32.add (local.get $a) (i32.const -1520))))))   ;; + 0x210 - 0x800
    (call $load_bad))

  (func $is_sound_psg (param $a i32) (result i32)
    (i32.or (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x60)) (i32.eq (local.get $a) (i32.const 0x62)))
                    (i32.or (i32.eq (local.get $a) (i32.const 0x64)) (i32.eq (local.get $a) (i32.const 0x68))))
            (i32.or (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x6C)) (i32.eq (local.get $a) (i32.const 0x70)))
                            (i32.or (i32.eq (local.get $a) (i32.const 0x72)) (i32.eq (local.get $a) (i32.const 0x74))))
                    (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x78)) (i32.eq (local.get $a) (i32.const 0x7C)))
                            (i32.eq (local.get $a) (i32.const 0x80))))))

  (func $is_readable (param $a i32) (result i32)
    (if (i32.le_u (local.get $a) (i32.const 0x0E)) (then (return (i32.const 1))))
    (if (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x48)) (i32.eq (local.get $a) (i32.const 0x4A)))
                (i32.or (i32.eq (local.get $a) (i32.const 0x50)) (i32.eq (local.get $a) (i32.const 0x52)))) (then (return (i32.const 1))))
    (if (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x82)) (i32.eq (local.get $a) (i32.const 0x84)))
                (i32.eq (local.get $a) (i32.const 0x88))) (then (return (i32.const 1))))
    (if (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x102)) (i32.eq (local.get $a) (i32.const 0x106)))
                (i32.or (i32.eq (local.get $a) (i32.const 0x10A)) (i32.eq (local.get $a) (i32.const 0x10E)))) (then (return (i32.const 1))))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x120)) (i32.le_u (local.get $a) (i32.const 0x12A))) (then (return (i32.const 1))))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x132)) (i32.eq (local.get $a) (i32.const 0x140))) (then (return (i32.const 1))))
    (if (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x154)) (i32.eq (local.get $a) (i32.const 0x156)))
                (i32.eq (local.get $a) (i32.const 0x158))) (then (return (i32.const 1))))
    (if (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x200)) (i32.eq (local.get $a) (i32.const 0x202)))
                (i32.or (i32.eq (local.get $a) (i32.const 0x204)) (i32.eq (local.get $a) (i32.const 0x208)))) (then (return (i32.const 1))))
    (i32.eq (local.get $a) (i32.const 0x300)))

  (func $is_unused_zero (param $a i32) (result i32)
    (i32.or (i32.or (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x66)) (i32.eq (local.get $a) (i32.const 0x6A)))
                            (i32.or (i32.eq (local.get $a) (i32.const 0x6E)) (i32.eq (local.get $a) (i32.const 0x76))))
                    (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x7A)) (i32.eq (local.get $a) (i32.const 0x7E)))
                            (i32.or (i32.eq (local.get $a) (i32.const 0x86)) (i32.eq (local.get $a) (i32.const 0x8A)))))
            (i32.or (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x136)) (i32.eq (local.get $a) (i32.const 0x142)))
                            (i32.or (i32.eq (local.get $a) (i32.const 0x15A)) (i32.eq (local.get $a) (i32.const 0x206))))
                    (i32.eq (local.get $a) (i32.const 0x302)))))

  ;; wave RAM, banked (GBAAudioRead/WriteWaveRAM)
  (func $wave_bank (result i32)
    (if (result i32) (i32.eqz (global.get $aEnable)) (then (i32.const 1))
      (else (i32.eqz (global.get $ch3bank)))))
  (func $wave_read (param $a i32) (result i32)
    (call $au_wave_run)   ;; audio.js: ch3 plays (rotates the wave RAM) up to now
    (i32.load16_u (i32.add (i32.const ${WAVE}) (i32.add (i32.shl (call $wave_bank) (i32.const 4))
                                                      (i32.sub (local.get $a) (i32.const 0x90))))))
  (func $wave_write32 (param $a i32) (param $v i32)
    (call $au_wave_run)   ;; audio.js
    (i32.store (i32.add (i32.const ${WAVE}) (i32.add (i32.shl (call $wave_bank) (i32.const 4))
                                                   (i32.sub (local.get $a) (i32.const 0x90)))) (local.get $v)))

  ;; the video register masks of GBAVideoSoftwareRendererWriteVideoRegister
  (func $video_mask (param $a i32) (param $v i32) (result i32)
    (if (i32.eqz (local.get $a)) (then (return (i32.and (local.get $v) (i32.const 0xFFF7)))))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x08)) (i32.eq (local.get $a) (i32.const 0x0A)))
      (then (return (i32.and (local.get $v) (i32.const 0xDFFF)))))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x10)) (i32.le_u (local.get $a) (i32.const 0x1E)))
      (then (return (i32.and (local.get $v) (i32.const 0x1FF)))))
    (if (i32.eq (local.get $a) (i32.const 0x50)) (then (return (i32.and (local.get $v) (i32.const 0x3FFF)))))
    (if (i32.eq (local.get $a) (i32.const 0x52)) (then (return (i32.and (local.get $v) (i32.const 0x1F1F)))))
    (if (i32.eq (local.get $a) (i32.const 0x54))
      (then (local.set $v (i32.and (local.get $v) (i32.const 0x1F)))
            (return (if (result i32) (i32.gt_u (local.get $v) (i32.const 0x10)) (then (i32.const 0x10)) (else (local.get $v))))))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x48)) (i32.eq (local.get $a) (i32.const 0x4A)))
      (then (return (i32.and (local.get $v) (i32.const 0x3F3F)))))
    (local.get $v))

  ;; GBAIOWrite
  (func $io_write (param $a i32) (param $v i32)
    (local $ch i32) (local $k i32)
    (local.set $v (i32.and (local.get $v) (i32.const 0xFFFF)))
    (if (i32.and (i32.lt_u (local.get $a) (i32.const 0x60))
                 (i32.or (i32.gt_u (local.get $a) (i32.const 6)) (i32.lt_u (local.get $a) (i32.const 4))))
      (then
        (call $io16w (local.get $a) (call $video_mask (local.get $a) (local.get $v)))
        (call $video_reg_written (local.get $a))
        (return)))
    (if (i32.and (i32.and (i32.ge_u (local.get $a) (i32.const 0x60)) (i32.le_u (local.get $a) (i32.const 0x80)))
                 (i32.eqz (global.get $aEnable)))
      (then (return)))
    (if (i32.eq (local.get $a) (i32.const 4))
      (then (call $io16w (i32.const 4) (i32.or (i32.and (call $io16 (i32.const 4)) (i32.const 7))
                                              (i32.and (local.get $v) (i32.const 0xFFF8))))
            (return)))
    (if (i32.eq (local.get $a) (i32.const 6)) (then (return)))
    ;; sound (only the stored masks and the FIFO/DMA plumbing matter here)
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x60)) (i32.le_u (local.get $a) (i32.const 0x88)))
      (then
        (call $au_io_write (local.get $a) (local.get $v))   ;; audio.js: the GBAAudioWrite* calls
        (if (i32.eq (local.get $a) (i32.const 0x60)) (then (local.set $v (i32.and (local.get $v) (i32.const 0x7F)))))
        (if (i32.eq (local.get $a) (i32.const 0x62)) (then (local.set $v (i32.and (local.get $v) (i32.const 0xFFC0)))))
        (if (i32.eq (local.get $a) (i32.const 0x64)) (then (local.set $v (i32.and (local.get $v) (i32.const 0x4000)))))
        (if (i32.eq (local.get $a) (i32.const 0x68)) (then (local.set $v (i32.and (local.get $v) (i32.const 0xFFC0)))))
        (if (i32.eq (local.get $a) (i32.const 0x6C)) (then (local.set $v (i32.and (local.get $v) (i32.const 0x4000)))))
        (if (i32.eq (local.get $a) (i32.const 0x70))
          (then (global.set $ch3bank (i32.and (i32.shr_u (local.get $v) (i32.const 6)) (i32.const 1)))
                (local.set $v (i32.and (local.get $v) (i32.const 0xE0)))))
        (if (i32.eq (local.get $a) (i32.const 0x72)) (then (local.set $v (i32.and (local.get $v) (i32.const 0xE000)))))
        (if (i32.eq (local.get $a) (i32.const 0x74)) (then (local.set $v (i32.and (local.get $v) (i32.const 0x4000)))))
        (if (i32.eq (local.get $a) (i32.const 0x78)) (then (local.set $v (i32.and (local.get $v) (i32.const 0xFF00)))))
        (if (i32.eq (local.get $a) (i32.const 0x7C)) (then (local.set $v (i32.and (local.get $v) (i32.const 0x40FF)))))
        (if (i32.eq (local.get $a) (i32.const 0x80)) (then (local.set $v (i32.and (local.get $v) (i32.const 0xFF77)))))
        (if (i32.eq (local.get $a) (i32.const 0x82))
          (then (call $write_soundcnt_hi (local.get $v)) (local.set $v (i32.and (local.get $v) (i32.const 0x770F)))))
        (if (i32.eq (local.get $a) (i32.const 0x84))
          (then (call $write_soundcnt_x (local.get $v))
                (local.set $v (i32.or (i32.and (local.get $v) (i32.const 0x80))
                                      (i32.and (call $io16 (i32.const 0x84)) (i32.const 0xF))))))
        (if (i32.eq (local.get $a) (i32.const 0x88)) (then (local.set $v (i32.and (local.get $v) (i32.const 0xC3FE)))))
        (call $io16w (local.get $a) (local.get $v))
        (return)))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x90)) (i32.le_u (local.get $a) (i32.const 0xA6)))
      (then
        (if (i32.and (local.get $a) (i32.const 2))
          (then (call $io_write32 (i32.sub (local.get $a) (i32.const 2))
                  (i32.or (call $io16 (i32.sub (local.get $a) (i32.const 2))) (i32.shl (local.get $v) (i32.const 16)))))
          (else (call $io_write32 (local.get $a)
                  (i32.or (i32.shl (call $io16 (i32.add (local.get $a) (i32.const 2))) (i32.const 16)) (local.get $v)))))
        (return)))
    ;; DMA
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0xB0)) (i32.le_u (local.get $a) (i32.const 0xDE)))
      (then
        (local.set $ch (i32.div_u (i32.sub (local.get $a) (i32.const 0xB0)) (i32.const 12)))
        (local.set $k (i32.rem_u (i32.sub (local.get $a) (i32.const 0xB0)) (i32.const 12)))
        (if (i32.lt_u (local.get $k) (i32.const 8))
          (then
            (if (i32.and (local.get $a) (i32.const 2))
              (then (call $io_write32 (i32.sub (local.get $a) (i32.const 2))
                      (i32.or (call $io16 (i32.sub (local.get $a) (i32.const 2))) (i32.shl (local.get $v) (i32.const 16)))))
              (else (call $io_write32 (local.get $a)
                      (i32.or (i32.shl (call $io16 (i32.add (local.get $a) (i32.const 2))) (i32.const 16)) (local.get $v)))))
            (return)))
        (if (i32.eq (local.get $k) (i32.const 8))
          (then (call $dma_write_cnt_lo (local.get $ch)
                  (if (result i32) (i32.eq (local.get $ch) (i32.const 3)) (then (local.get $v)) (else (i32.and (local.get $v) (i32.const 0x3FFF)))))
                (call $io16w (local.get $a) (local.get $v)) (return)))
        (call $io16w (local.get $a) (call $dma_write_cnt_hi (local.get $ch) (local.get $v)))
        (return)))
    ;; timers
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x100)) (i32.le_u (local.get $a) (i32.const 0x10E)))
      (then
        (local.set $ch (i32.shr_u (i32.sub (local.get $a) (i32.const 0x100)) (i32.const 2)))
        (if (i32.eqz (i32.and (local.get $a) (i32.const 2)))
          (then (i32.store (i32.add (i32.const ${TMR + T_RELOAD}) (i32.shl (local.get $ch) (i32.const 4))) (local.get $v))
                (return)))
        (local.set $v (i32.and (local.get $v) (i32.const 0xC7)))
        (call $timer_write_hi (local.get $ch) (local.get $v))
        (call $io16w (local.get $a) (local.get $v))
        (return)))
    ;; SIO
    (if (i32.eq (local.get $a) (i32.const 0x128))
      (then (local.set $v (i32.and (local.get $v) (i32.const 0x7FFF)))
            (call $sio_write_siocnt (local.get $v)) (call $io16w (local.get $a) (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x134))
      (then (local.set $v (i32.and (local.get $v) (i32.const 0xC1FF)))
            (call $sio_write_rcnt (local.get $v)) (call $io16w (local.get $a) (local.get $v)) (return)))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x154)) (i32.eq (local.get $a) (i32.const 0x156)))
      (then (call $io16w (i32.const 0x158) (i32.or (call $io16 (i32.const 0x158)) (i32.const 8)))))
    (if (i32.or (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x120)) (i32.eq (local.get $a) (i32.const 0x122)))
                        (i32.or (i32.eq (local.get $a) (i32.const 0x12A)) (i32.eq (local.get $a) (i32.const 0x140))))
                (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x150)) (i32.eq (local.get $a) (i32.const 0x152)))
                        (i32.or (i32.eq (local.get $a) (i32.const 0x154)) (i32.or (i32.eq (local.get $a) (i32.const 0x156))
                                                                                  (i32.eq (local.get $a) (i32.const 0x158))))))
      (then (call $io16w (local.get $a) (call $sio_write_reg (local.get $a) (local.get $v))) (return)))
    ;; interrupts and misc
    (if (i32.eq (local.get $a) (i32.const 0x132))
      (then
        (local.set $v (i32.and (local.get $v) (i32.const 0xC3FF)))
        (if (i32.lt_u (global.get $keysLast) (i32.const 0x400))
          (then (global.set $keysLast (i32.and (global.get $keysLast)
                  (i32.or (call $io16 (i32.const 0x132)) (i32.xor (local.get $v) (i32.const -1)))))))
        (call $io16w (i32.const 0x132) (local.get $v))
        (call $test_keypad_irq)
        (return)))
    (if (i32.eq (local.get $a) (i32.const 0x204))
      (then (local.set $v (i32.and (local.get $v) (i32.const 0x5FFF)))
            (call $adjust_waitstates (local.get $v))
            (call $io16w (local.get $a) (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x200))
      (then (call $io16w (i32.const 0x200) (local.get $v)) (call $test_irq (i32.const 1)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x202))
      (then (call $io16w (i32.const 0x202) (i32.and (call $io16 (i32.const 0x202)) (i32.xor (local.get $v) (i32.const -1))))
            (call $test_irq (i32.const 1)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x208))
      (then (call $io16w (i32.const 0x208) (i32.and (local.get $v) (i32.const 1))) (call $test_irq (i32.const 1)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x20A)) (then (call $io16w (local.get $a) (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x300))
      (then
        (if (i32.ne (global.get $areg) (i32.const 0)) (then (return)))
        (if (call $io16 (i32.const 0x300))
          (then (if (i32.and (local.get $v) (i32.const 0x8000)) (then (call $stop)) (else (call $halt)))))
        (call $io16w (i32.const 0x300) (i32.and (local.get $v) (i32.const 0x7FFF)))
        (return)))
    (if (i32.eq (local.get $a) (i32.const 0x802))
      (then (local.set $v (i32.and (local.get $v) (i32.const 0xFF00)))
            (call $adjust_ewram (local.get $v))
            (call $io16w (i32.const 0x212) (local.get $v)) (return)))
    (if (i32.ge_u (local.get $a) (i32.const 0x20A)) (then (return)))
    (call $io16w (local.get $a) (local.get $v)))

  ;; GBAIOWrite8: the PSG byte cases store their own masks; everything else
  ;; merges into the halfword and goes through GBAIOWrite.
  (func $io_write8 (param $a i32) (param $v i32)
    (local $s i32) (local $h i32)
    (if (i32.gt_u (local.get $a) (i32.const 0x400)) (then (return)))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x62)) (i32.le_u (local.get $a) (i32.const 0x7D)))
      (then
        (if (call $io8_psg (local.get $a) (local.get $v)) (then (return)))))
    (local.set $s (i32.shl (i32.and (local.get $a) (i32.const 1)) (i32.const 3)))
    (local.set $h (i32.or (i32.shl (local.get $v) (local.get $s))
                          (i32.and (call $io16 (i32.and (local.get $a) (i32.const 0x3FE)))
                                   (i32.xor (i32.shl (i32.const 0xFF) (local.get $s)) (i32.const -1)))))
    (call $io_write (i32.and (local.get $a) (i32.const -2)) (local.get $h)))

  ;; the byte-wide PSG register writes (GBAIOWrite8's sound cases) -> 1 if handled
  (func $io8_psg (param $a i32) (param $v i32) (result i32)
    (call $au_io_write8 (local.get $a) (local.get $v))   ;; audio.js
    (if (i32.eq (local.get $a) (i32.const 0x62))
      (then (call $io16w (i32.const 0x62) (i32.or (i32.and (call $io16 (i32.const 0x62)) (i32.const 0xFF00)) (i32.and (local.get $v) (i32.const 0xC0)))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x63))
      (then (call $io16w (i32.const 0x62) (i32.or (i32.and (call $io16 (i32.const 0x62)) (i32.const 0xC0)) (i32.shl (local.get $v) (i32.const 8)))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x64)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x65))
      (then (call $io16w (i32.const 0x64) (i32.shl (i32.and (local.get $v) (i32.const 0x40)) (i32.const 8))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x68))
      (then (call $io16w (i32.const 0x68) (i32.or (i32.and (call $io16 (i32.const 0x68)) (i32.const 0xFF00)) (i32.and (local.get $v) (i32.const 0xC0)))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x69))
      (then (call $io16w (i32.const 0x68) (i32.or (i32.and (call $io16 (i32.const 0x68)) (i32.const 0xC0)) (i32.shl (local.get $v) (i32.const 8)))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x6C)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x6D))
      (then (call $io16w (i32.const 0x6C) (i32.shl (i32.and (local.get $v) (i32.const 0x40)) (i32.const 8))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x72)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x73))
      (then (call $io16w (i32.const 0x72) (i32.shl (i32.and (local.get $v) (i32.const 0xE0)) (i32.const 8))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x74)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x75))
      (then (call $io16w (i32.const 0x74) (i32.shl (i32.and (local.get $v) (i32.const 0x40)) (i32.const 8))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x78)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x79))
      (then (call $io16w (i32.const 0x78) (i32.shl (local.get $v) (i32.const 8))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x7C))
      (then (call $io16w (i32.const 0x7C) (i32.or (i32.and (call $io16 (i32.const 0x7C)) (i32.const 0x4000)) (local.get $v))) (return (i32.const 1))))
    (if (i32.eq (local.get $a) (i32.const 0x7D))
      (then (call $io16w (i32.const 0x7C) (i32.or (i32.and (call $io16 (i32.const 0x7C)) (i32.const 0xFF)) (i32.shl (i32.and (local.get $v) (i32.const 0x40)) (i32.const 8)))) (return (i32.const 1))))
    (i32.const 0))

  ;; GBAIOWrite32
  (func $io_write32 (param $a i32) (param $v i32)
    (local $ch i32) (local $k i32)
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x90)) (i32.le_u (local.get $a) (i32.const 0x9C)))
      (then (call $wave_write32 (local.get $a) (local.get $v))
            (call $io16w (local.get $a) (local.get $v))
            (call $io16w (i32.add (local.get $a) (i32.const 2)) (i32.shr_u (local.get $v) (i32.const 16)))
            (return)))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0xA0)) (i32.eq (local.get $a) (i32.const 0xA4)))
      (then (call $au_fifo_write (i32.eq (local.get $a) (i32.const 0xA4)) (local.get $v))   ;; audio.js
            (call $fifo_write (i32.eq (local.get $a) (i32.const 0xA4)))
            (call $io16w (local.get $a) (local.get $v))
            (call $io16w (i32.add (local.get $a) (i32.const 2)) (i32.shr_u (local.get $v) (i32.const 16)))
            (return)))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0xB0)) (i32.le_u (local.get $a) (i32.const 0xDC)))
      (then
        (local.set $ch (i32.div_u (i32.sub (local.get $a) (i32.const 0xB0)) (i32.const 12)))
        (local.set $k (i32.rem_u (i32.sub (local.get $a) (i32.const 0xB0)) (i32.const 12)))
        (if (i32.eqz (local.get $k))
          (then (local.set $v (call $dma_write_sad (local.get $ch) (local.get $v)))
                (call $io16w (local.get $a) (local.get $v))
                (call $io16w (i32.add (local.get $a) (i32.const 2)) (i32.shr_u (local.get $v) (i32.const 16)))
                (return)))
        (if (i32.eq (local.get $k) (i32.const 4))
          (then (local.set $v (call $dma_write_dad (local.get $ch) (local.get $v)))
                (call $io16w (local.get $a) (local.get $v))
                (call $io16w (i32.add (local.get $a) (i32.const 2)) (i32.shr_u (local.get $v) (i32.const 16)))
                (return)))))
    (call $io_write (local.get $a) (i32.and (local.get $v) (i32.const 0xFFFF)))
    (call $io_write (i32.or (local.get $a) (i32.const 2)) (i32.shr_u (local.get $v) (i32.const 16))))

  ;; ======================= interrupts (gba.c) ============================
  (func $raise_irq (param $irq i32) (param $late i32)   ;; GBARaiseIRQ
    (call $io16w (i32.const 0x202) (i32.or (call $io16 (i32.const 0x202)) (i32.shl (i32.const 1) (local.get $irq))))
    (call $test_irq (local.get $late)))

  (func $test_irq (param $late i32)   ;; GBATestIRQ
    (if (i32.and (call $io16 (i32.const 0x200)) (call $io16 (i32.const 0x202)))
      (then (if (i32.eqz (call $scheduled (i32.const ${EV_IRQ})))
              (then (call $schedule (i32.const ${EV_IRQ}) (i32.sub (i32.const ${IRQ_DELAY}) (local.get $late))))))))

  (func $trigger_irq (param $late i32)   ;; _triggerIRQ
    (global.set $halted (i32.const 0))
    (if (i32.eqz (i32.and (call $io16 (i32.const 0x200)) (call $io16 (i32.const 0x202)))) (then (return)))
    (if (i32.and (i32.ne (call $io16 (i32.const 0x208)) (i32.const 0))
                 (i32.eqz (i32.and (global.get $ctl) (i32.const 0x80))))
      (then (call $raise_irq_cpu))))

  (func $halt   ;; GBAHalt
    (global.set $nextEvent (global.get $cycles))
    (global.set $halted (i32.const 1)))

  (func $stop   ;; GBAStop (no sleep callback here)
    (global.set $nextEvent (global.get $cycles)))

  (func $test_keypad_irq   ;; GBATestKeypadIRQ
    (local $kl i32) (local $cnt i32) (local $and i32)
    (local.set $kl (global.get $keysLast))
    (local.set $cnt (call $io16 (i32.const 0x132)))
    (if (i32.eqz (i32.and (local.get $cnt) (i32.const 0x4000))) (then (return)))
    (global.set $keysLast (global.get $keysActive))
    (local.set $and (i32.and (local.get $cnt) (i32.const 0x8000)))
    (local.set $cnt (i32.and (local.get $cnt) (i32.const 0x3FF)))
    (if (i32.and (i32.ne (local.get $and) (i32.const 0))
                 (i32.eq (local.get $cnt) (i32.and (global.get $keysActive) (local.get $cnt))))
      (then
        (if (i32.eq (local.get $kl) (global.get $keysActive)) (then (return)))
        (call $raise_irq (i32.const 12) (i32.const 0))
        (return)))
    (if (i32.and (i32.eqz (local.get $and)) (i32.ne (i32.and (global.get $keysActive) (local.get $cnt)) (i32.const 0)))
      (then (call $raise_irq (i32.const 12) (i32.const 0)) (return)))
    (global.set $keysLast (i32.const 0x400)))

  ;; ======================= video timing (video.c) ========================
  (func $calc_stall_mask (param $dc i32) (result i32)   ;; _calculateStallMask
    (local $m i32) (local $mode i32) (local $i i32)
    (if (i32.and (local.get $dc) (i32.const 0x80)) (then (return (i32.const 0))))
    (local.set $mode (i32.and (local.get $dc) (i32.const 7)))
    (if (i32.le_u (local.get $mode) (i32.const 1))
      (then
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $i) (if (result i32) (local.get $mode) (then (i32.const 2)) (else (i32.const 4)))))
          (if (i32.and (local.get $dc) (i32.shl (i32.const 0x100) (local.get $i)))
            (then (local.set $m (i32.or (local.get $m)
              (i32.shl (if (result i32) (i32.and (call $io16 (i32.add (i32.const 8) (i32.shl (local.get $i) (i32.const 1)))) (i32.const 0x80))
                          (then (i32.const 0x10)) (else (i32.const 0x11))) (local.get $i))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (if (i32.and (i32.eq (local.get $mode) (i32.const 1)) (i32.ne (i32.and (local.get $dc) (i32.const 0x400)) (i32.const 0)))
          (then (local.set $m (i32.or (local.get $m) (i32.const 0x100)))))
        (return (local.get $m))))
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then
        (if (i32.and (local.get $dc) (i32.const 0x400)) (then (local.set $m (i32.or (local.get $m) (i32.const 0x100)))))
        (if (i32.and (local.get $dc) (i32.const 0x800)) (then (local.set $m (i32.or (local.get $m) (i32.const 0x200)))))
        (return (local.get $m))))
    (if (i32.le_u (local.get $mode) (i32.const 5))
      (then (if (i32.and (local.get $dc) (i32.const 0x400)) (then (return (i32.const 0x400))))))
    (i32.const 0))

  (func $start_hdraw (param $late i32)   ;; _startHdraw
    (local $ds i32)
    (global.set $vcb (i32.const 0))
    (call $schedule (i32.const ${EV_VIDEO}) (i32.sub (i32.const ${VIDEO_HDRAW}) (local.get $late)))
    (global.set $vcount (i32.add (global.get $vcount) (i32.const 1)))
    (if (i32.eq (global.get $vcount) (i32.const 228)) (then (global.set $vcount (i32.const 0))))
    (call $io16w (i32.const 6) (global.get $vcount))
    (if (i32.lt_u (global.get $vcount) (i32.const 160))
      (then (global.set $stallMask (call $calc_stall_mask (call $io16 (i32.const 0))))))
    (local.set $ds (i32.and (call $io16 (i32.const 4)) (i32.const -3)))
    (if (i32.eq (global.get $vcount) (i32.shr_u (local.get $ds) (i32.const 8)))
      (then (local.set $ds (i32.or (local.get $ds) (i32.const 4)))
            (if (i32.and (local.get $ds) (i32.const 0x20))
              (then (call $raise_irq (i32.const 2) (local.get $late)))))
      (else (local.set $ds (i32.and (local.get $ds) (i32.const -5)))))
    (call $io16w (i32.const 4) (local.get $ds))
    (if (i32.eqz (global.get $vcount)) (then (call $test_keypad_irq)))
    (if (i32.eq (global.get $vcount) (i32.const 160))
      (then
        (call $io16w (i32.const 4) (i32.or (local.get $ds) (i32.const 1)))
        (call $frame_finish)
        (call $dma_run_vblank (i32.sub (i32.const 0) (local.get $late)))
        (if (i32.and (local.get $ds) (i32.const 8)) (then (call $raise_irq (i32.const 0) (local.get $late))))
        (global.set $frameCounter (i32.add (global.get $frameCounter) (i32.const 1)))
        (global.set $earlyExit (i32.const 1))))
    (if (i32.eq (global.get $vcount) (i32.const 227))
      (then (call $io16w (i32.const 4) (i32.and (local.get $ds) (i32.const -2))))))

  (func $start_hblank (param $late i32)   ;; _startHblank
    (local $ds i32)
    (global.set $vcb (i32.const 1))
    (call $schedule (i32.const ${EV_VIDEO}) (i32.sub (i32.const ${VIDEO_HBLANK}) (local.get $late)))
    (local.set $ds (i32.or (call $io16 (i32.const 4)) (i32.const 2)))
    (if (i32.lt_u (global.get $vcount) (i32.const 160))
      (then (call $gba_render_line (global.get $vcount))))
    (if (i32.lt_u (global.get $vcount) (i32.const 160))
      (then (call $dma_run_hblank (i32.sub (i32.const 0) (local.get $late)))))
    (if (i32.and (i32.ge_u (global.get $vcount) (i32.const 2)) (i32.lt_u (global.get $vcount) (i32.const 162)))
      (then (call $dma_run_display_start (i32.sub (i32.const 0) (local.get $late)))))
    (if (i32.and (local.get $ds) (i32.const 0x10))
      (then (call $raise_irq (i32.const 1) (i32.sub (local.get $late) (i32.const 6)))))
    (global.set $stallMask (i32.const 0))
    (call $io16w (i32.const 4) (local.get $ds)))

  ;; ======================= timers (timer.c) ==============================
  (func $tf (param $t i32) (result i32) (i32.load (i32.add (i32.const ${TMR + T_FLAGS}) (i32.shl (local.get $t) (i32.const 4)))))
  ;; flags: bits 0-3 prescaleBits, bit 4 countUp, bit 5 doIrq, bit 6 enable

  (func $timer_update_register (param $t i32) (param $late i32)   ;; GBATimerUpdateRegister
    (local $f i32) (local $pb i32) (local $now i32) (local $mask i32) (local $inc i32) (local $rel i32) (local $lo i32)
    (local.set $f (call $tf (local.get $t)))
    (if (i32.or (i32.eqz (i32.and (local.get $f) (i32.const 0x40))) (i32.ne (i32.and (local.get $f) (i32.const 0x10)) (i32.const 0)))
      (then (return)))
    (local.set $pb (i32.and (local.get $f) (i32.const 15)))
    (local.set $now (i32.sub (call $now) (local.get $late)))
    (local.set $mask (i32.sub (i32.shl (i32.const 1) (local.get $pb)) (i32.const 1)))
    (local.set $now (i32.and (local.get $now) (i32.xor (local.get $mask) (i32.const -1))))
    (local.set $inc (i32.sub (local.get $now) (i32.load (i32.add (i32.const ${TMR + T_LAST}) (i32.shl (local.get $t) (i32.const 4))))))
    (i32.store (i32.add (i32.const ${TMR + T_LAST}) (i32.shl (local.get $t) (i32.const 4))) (local.get $now))
    (local.set $inc (i32.shr_s (local.get $inc) (local.get $pb)))
    (local.set $lo (i32.add (i32.const 0x100) (i32.shl (local.get $t) (i32.const 2))))
    (local.set $inc (i32.add (local.get $inc) (call $io16 (local.get $lo))))
    (local.set $rel (i32.load (i32.add (i32.const ${TMR + T_RELOAD}) (i32.shl (local.get $t) (i32.const 4)))))
    (block $d (loop $l
      (br_if $d (i32.lt_s (local.get $inc) (i32.const 0x10000)))
      (local.set $inc (i32.sub (local.get $inc) (i32.sub (i32.const 0x10000) (local.get $rel))))
      (br $l)))
    (call $io16w (local.get $lo) (local.get $inc))
    (local.set $inc (i32.shl (i32.sub (i32.const 0x10000) (local.get $inc)) (local.get $pb)))
    (local.set $now (i32.add (local.get $now) (local.get $inc)))
    (local.set $now (i32.and (local.get $now) (i32.xor (local.get $mask) (i32.const -1))))
    (call $deschedule (i32.add (i32.const ${EV_TM0}) (local.get $t)))
    (call $schedule (i32.add (i32.const ${EV_TM0}) (local.get $t)) (i32.sub (local.get $now) (call $now))))

  (func $timer_update (param $t i32) (param $late i32)   ;; GBATimerUpdate
    (local $f i32) (local $nf i32) (local $lo i32)
    (local.set $f (call $tf (local.get $t)))
    (if (i32.and (local.get $f) (i32.const 0x10))
      (then (call $io16w (i32.add (i32.const 0x100) (i32.shl (local.get $t) (i32.const 2)))
              (i32.load (i32.add (i32.const ${TMR + T_RELOAD}) (i32.shl (local.get $t) (i32.const 4))))))
      (else (call $timer_update_register (local.get $t) (local.get $late))))
    (if (i32.and (local.get $f) (i32.const 0x20))
      (then (call $raise_irq (i32.add (i32.const 3) (local.get $t)) (local.get $late))))
    (if (i32.and (global.get $aEnable) (i32.lt_u (local.get $t) (i32.const 2)))
      (then
        (if (i32.and (i32.ne (global.get $chALR) (i32.const 0)) (i32.eq (global.get $chATimer) (local.get $t)))
          (then (call $fifo_sample (i32.const 0) (local.get $late))))
        (if (i32.and (i32.ne (global.get $chBLR) (i32.const 0)) (i32.eq (global.get $chBTimer) (local.get $t)))
          (then (call $fifo_sample (i32.const 1) (local.get $late))))))
    (if (i32.lt_u (local.get $t) (i32.const 3))
      (then
        (local.set $nf (call $tf (i32.add (local.get $t) (i32.const 1))))
        (if (i32.eq (i32.and (local.get $nf) (i32.const 0x50)) (i32.const 0x50))
          (then
            (local.set $lo (i32.add (i32.const 0x104) (i32.shl (local.get $t) (i32.const 2))))
            (call $io16w (local.get $lo) (i32.and (i32.add (call $io16 (local.get $lo)) (i32.const 1)) (i32.const 0xFFFF)))
            (if (i32.eqz (call $io16 (local.get $lo)))
              (then (call $timer_update (i32.add (local.get $t) (i32.const 1)) (local.get $late)))))))))

  (func $timer_write_hi (param $t i32) (param $ctl i32)   ;; GBATimerWriteTMCNT_HI
    (local $of i32) (local $nf i32) (local $pb i32) (local $resched i32) (local $mask i32)
    (call $timer_update_register (local.get $t) (i32.const 0))
    (local.set $pb (i32.load8_u (i32.add (i32.const ${L.PRESCALE}) (i32.and (local.get $ctl) (i32.const 3)))))
    (local.set $of (call $tf (local.get $t)))
    (local.set $nf (i32.or (i32.or (local.get $pb)
                                   (i32.shl (i32.and (i32.ne (local.get $t) (i32.const 0)) (i32.ne (i32.and (local.get $ctl) (i32.const 4)) (i32.const 0))) (i32.const 4)))
                           (i32.or (i32.shl (i32.ne (i32.and (local.get $ctl) (i32.const 0x40)) (i32.const 0)) (i32.const 5))
                                   (i32.shl (i32.ne (i32.and (local.get $ctl) (i32.const 0x80)) (i32.const 0)) (i32.const 6)))))
    (i32.store (i32.add (i32.const ${TMR + T_FLAGS}) (i32.shl (local.get $t) (i32.const 4))) (local.get $nf))
    (if (i32.ne (i32.and (local.get $of) (i32.const 0x40)) (i32.and (local.get $nf) (i32.const 0x40)))
      (then (local.set $resched (i32.const 1))
            (if (i32.and (local.get $nf) (i32.const 0x40))
              (then (call $io16w (i32.add (i32.const 0x100) (i32.shl (local.get $t) (i32.const 2)))
                      (i32.load (i32.add (i32.const ${TMR + T_RELOAD}) (i32.shl (local.get $t) (i32.const 4))))))))
      (else (if (i32.ne (i32.and (local.get $of) (i32.const 0x10)) (i32.and (local.get $nf) (i32.const 0x10)))
        (then (local.set $resched (i32.const 1)))
        (else (if (i32.ne (i32.and (local.get $of) (i32.const 15)) (i32.and (local.get $nf) (i32.const 15)))
          (then (local.set $resched (i32.const 1))))))))
    (if (local.get $resched)
      (then
        (call $deschedule (i32.add (i32.const ${EV_TM0}) (local.get $t)))
        (if (i32.eq (i32.and (local.get $nf) (i32.const 0x50)) (i32.const 0x40))
          (then
            (local.set $mask (i32.sub (i32.shl (i32.const 1) (local.get $pb)) (i32.const 1)))
            (i32.store (i32.add (i32.const ${TMR + T_LAST}) (i32.shl (local.get $t) (i32.const 4)))
              (i32.and (call $now) (i32.xor (local.get $mask) (i32.const -1))))
            (call $timer_update_register (local.get $t) (i32.const 0)))))))

  ;; ======================= DMA (dma.c) ===================================
  (func $dp (param $ch i32) (param $f i32) (result i32)
    (i32.add (i32.add (i32.const ${DMA}) (i32.mul (local.get $ch) (i32.const ${DS}))) (local.get $f)))

  (func $dma_write_sad (param $ch i32) (param $a i32) (result i32)   ;; GBADMAWriteSAD
    (local $ok i32)
    (local.set $ok (i32.ge_u (local.get $a) (i32.const 0x02000000)))
    (if (i32.and (i32.eqz (local.get $ch))
                 (i32.and (i32.ge_u (local.get $a) (i32.const 0x08000000)) (i32.lt_u (local.get $a) (i32.const 0x0E000000))))
      (then (local.set $ok (i32.const 0))))
    (i32.store (call $dp (local.get $ch) (i32.const ${D_SRC}))
      (if (result i32) (local.get $ok) (then (i32.and (local.get $a) (i32.const 0x0FFFFFFE))) (else (i32.const 0))))
    (i32.load (call $dp (local.get $ch) (i32.const ${D_SRC}))))

  (func $dma_write_dad (param $ch i32) (param $a i32) (result i32)   ;; GBADMAWriteDAD
    (local.set $a (i32.and (local.get $a) (i32.const 0x0FFFFFFE)))
    (if (i32.or (i32.eq (local.get $ch) (i32.const 3)) (i32.lt_u (local.get $a) (i32.const 0x08000000)))
      (then (i32.store (call $dp (local.get $ch) (i32.const ${D_DST})) (local.get $a))))
    (i32.load (call $dp (local.get $ch) (i32.const ${D_DST}))))

  (func $dma_write_cnt_lo (param $ch i32) (param $c i32)
    (i32.store (call $dp (local.get $ch) (i32.const ${D_CNT}))
      (if (result i32) (local.get $c) (then (local.get $c))
        (else (if (result i32) (i32.eq (local.get $ch) (i32.const 3)) (then (i32.const 0x10000)) (else (i32.const 0x4000)))))))

  (func $dma_write_cnt_hi (param $ch i32) (param $ctl i32) (result i32)   ;; GBADMAWriteCNT_HI
    (local $was i32) (local $w i32)
    (local.set $was (i32.and (i32.load (call $dp (local.get $ch) (i32.const ${D_REG}))) (i32.const 0x8000)))
    (local.set $ctl (i32.and (local.get $ctl) (if (result i32) (i32.lt_u (local.get $ch) (i32.const 3)) (then (i32.const 0xF7E0)) (else (i32.const 0xFFE0)))))
    (i32.store (call $dp (local.get $ch) (i32.const ${D_REG})) (local.get $ctl))
    (if (i32.and (i32.eqz (local.get $was)) (i32.ne (i32.and (local.get $ctl) (i32.const 0x8000)) (i32.const 0)))
      (then
        (local.set $w (i32.shl (i32.const 2) (i32.and (i32.shr_u (local.get $ctl) (i32.const 10)) (i32.const 1))))
        (i32.store (call $dp (local.get $ch) (i32.const ${D_NSRC}))
          (i32.and (i32.load (call $dp (local.get $ch) (i32.const ${D_SRC}))) (i32.sub (i32.const 0) (local.get $w))))
        (i32.store (call $dp (local.get $ch) (i32.const ${D_NDST}))
          (i32.and (i32.load (call $dp (local.get $ch) (i32.const ${D_DST}))) (i32.sub (i32.const 0) (local.get $w))))
        (call $dma_schedule (local.get $ch))))
    (i32.load16_u (call $dp (local.get $ch) (i32.const ${D_REG}))))

  (func $dma_schedule (param $ch i32)   ;; GBADMASchedule
    (local $t i32)
    (local.set $t (i32.and (i32.shr_u (i32.load (call $dp (local.get $ch) (i32.const ${D_REG}))) (i32.const 12)) (i32.const 3)))
    (if (i32.eqz (local.get $t))
      (then
        (i32.store (call $dp (local.get $ch) (i32.const ${D_WHEN})) (i32.add (call $now) (i32.const 3)))
        (i32.store (call $dp (local.get $ch) (i32.const ${D_NCNT})) (i32.load (call $dp (local.get $ch) (i32.const ${D_CNT}))))))
    (if (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 2))) (then (return)))
    (if (i32.eq (local.get $t) (i32.const 3))
      (then
        (if (i32.eqz (local.get $ch)) (then (return)))
        (if (i32.lt_u (local.get $ch) (i32.const 3)) (then (call $fifo_schedule_dma (local.get $ch))))))
    (call $dma_update))

  (func $dma_run_timed (param $timing i32) (param $cyc i32)   ;; GBADMARunHblank / Vblank
    (local $i i32) (local $found i32) (local $r i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 4)))
      (local.set $r (i32.load (call $dp (local.get $i) (i32.const ${D_REG}))))
      (if (i32.and (i32.and (i32.ne (i32.and (local.get $r) (i32.const 0x8000)) (i32.const 0))
                            (i32.eq (i32.and (i32.shr_u (local.get $r) (i32.const 12)) (i32.const 3)) (local.get $timing)))
                   (i32.eqz (i32.load (call $dp (local.get $i) (i32.const ${D_NCNT})))))
        (then
          (i32.store (call $dp (local.get $i) (i32.const ${D_WHEN})) (i32.add (i32.add (call $now) (i32.const 3)) (local.get $cyc)))
          (i32.store (call $dp (local.get $i) (i32.const ${D_NCNT})) (i32.load (call $dp (local.get $i) (i32.const ${D_CNT}))))
          (local.set $found (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (if (local.get $found) (then (call $dma_update))))

  (func $dma_run_hblank (param $cyc i32) (call $dma_run_timed (i32.const 2) (local.get $cyc)))
  (func $dma_run_vblank (param $cyc i32) (call $dma_run_timed (i32.const 1) (local.get $cyc)))

  (func $dma_run_display_start (param $cyc i32)   ;; GBADMARunDisplayStart
    (local $r i32)
    (local.set $r (i32.load (call $dp (i32.const 3) (i32.const ${D_REG}))))
    (if (i32.and (i32.and (i32.ne (i32.and (local.get $r) (i32.const 0x8000)) (i32.const 0))
                          (i32.eq (i32.and (local.get $r) (i32.const 0x3000)) (i32.const 0x3000)))
                 (i32.eqz (i32.load (call $dp (i32.const 3) (i32.const ${D_NCNT})))))
      (then
        (i32.store (call $dp (i32.const 3) (i32.const ${D_WHEN})) (i32.add (i32.add (call $now) (i32.const 3)) (local.get $cyc)))
        (i32.store (call $dp (i32.const 3) (i32.const ${D_NCNT})) (i32.load (call $dp (i32.const 3) (i32.const ${D_CNT}))))
        (call $dma_update))))

  (func $dma_event (param $late i32)   ;; _dmaEvent
    (local $ch i32) (local $r i32) (local $norep i32)
    (local.set $ch (global.get $activeDMA))
    (if (i32.eq (i32.load (call $dp (local.get $ch) (i32.const ${D_NCNT}))) (i32.load (call $dp (local.get $ch) (i32.const ${D_CNT}))))
      (then (i32.store (call $dp (local.get $ch) (i32.const ${D_WHEN})) (call $now))))
    (if (i32.and (i32.load (call $dp (local.get $ch) (i32.const ${D_NCNT}))) (i32.const 0xFFFFF))
      (then (call $dma_service (local.get $ch)) (return)))
    (i32.store (call $dp (local.get $ch) (i32.const ${D_NCNT})) (i32.const 0))
    (local.set $r (i32.load (call $dp (local.get $ch) (i32.const ${D_REG}))))
    (local.set $norep (i32.eqz (i32.and (local.get $r) (i32.const 0x200))))
    (if (i32.eqz (i32.and (local.get $r) (i32.const 0x3000))) (then (local.set $norep (i32.const 1))))
    (if (i32.and (i32.and (i32.eq (local.get $ch) (i32.const 3)) (i32.eq (i32.and (local.get $r) (i32.const 0x3000)) (i32.const 0x3000)))
                 (i32.eq (global.get $vcount) (i32.const 161)))
      (then (local.set $norep (i32.const 1))))
    (if (local.get $norep)
      (then
        (local.set $r (i32.and (local.get $r) (i32.const 0x7FFF)))
        (i32.store (call $dp (local.get $ch) (i32.const ${D_REG})) (local.get $r))
        (call $io16w (i32.add (i32.const 0xBA) (i32.mul (local.get $ch) (i32.const 12)))
          (i32.and (call $io16 (i32.add (i32.const 0xBA) (i32.mul (local.get $ch) (i32.const 12)))) (i32.const 0x7FE0)))))
    (if (i32.eq (i32.and (i32.shr_u (local.get $r) (i32.const 5)) (i32.const 3)) (i32.const 3))
      (then (i32.store (call $dp (local.get $ch) (i32.const ${D_NDST})) (i32.load (call $dp (local.get $ch) (i32.const ${D_DST}))))))
    (if (i32.and (local.get $r) (i32.const 0x4000))
      (then (call $raise_irq (i32.add (i32.const 8) (local.get $ch)) (local.get $late))))
    (call $dma_update))

  (func $dma_update   ;; GBADMAUpdate
    (local $i i32) (local $now i32) (local $least i32) (local $t i32) (local $r i32)
    (local.set $now (call $now))
    (global.set $activeDMA (i32.const -1))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 4)))
      (local.set $r (i32.load (call $dp (local.get $i) (i32.const ${D_REG}))))
      (if (i32.and (i32.ne (i32.and (local.get $r) (i32.const 0x8000)) (i32.const 0))
                   (i32.ne (i32.load (call $dp (local.get $i) (i32.const ${D_NCNT}))) (i32.const 0)))
        (then
          (local.set $t (i32.sub (i32.load (call $dp (local.get $i) (i32.const ${D_WHEN}))) (local.get $now)))
          (if (i32.or (i32.eq (global.get $activeDMA) (i32.const -1)) (i32.lt_s (local.get $t) (local.get $least)))
            (then (local.set $least (local.get $t)) (global.set $activeDMA (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (if (i32.ge_s (global.get $activeDMA) (i32.const 0))
      (then
        (global.set $dmaPC (i32.load (i32.const ${REGS + 60})))
        (call $deschedule (i32.const ${EV_DMA}))
        (call $schedule (i32.const ${EV_DMA})
          (i32.sub (i32.load (call $dp (global.get $activeDMA) (i32.const ${D_WHEN}))) (local.get $now))))
      (else (global.set $cpuBlocked (i32.const 0)))))

  (func $dma_service (param $ch i32)   ;; GBADMAService
    (local $r i32) (local $w i32) (local $src i32) (local $dst i32) (local $sr i32) (local $dr i32) (local $cyc i32)
    (local $soff i32) (local $doff i32) (local $i i32) (local $t i32) (local $iw i32)
    (local.set $r (i32.load (call $dp (local.get $ch) (i32.const ${D_REG}))))
    (local.set $w (i32.shl (i32.const 2) (i32.and (i32.shr_u (local.get $r) (i32.const 10)) (i32.const 1))))
    (local.set $src (i32.load (call $dp (local.get $ch) (i32.const ${D_NSRC}))))
    (local.set $dst (i32.load (call $dp (local.get $ch) (i32.const ${D_NDST}))))
    (local.set $sr (i32.shr_u (local.get $src) (i32.const 24)))
    (local.set $dr (i32.shr_u (local.get $dst) (i32.const 24)))
    (local.set $cyc (i32.const 2))
    (global.set $cpuBlocked (i32.const 1))
    (global.set $performingDMA (i32.or (i32.const 1) (i32.shl (local.get $ch) (i32.const 1))))
    (if (i32.eq (i32.load (call $dp (local.get $ch) (i32.const ${D_CNT}))) (i32.load (call $dp (local.get $ch) (i32.const ${D_NCNT}))))
      (then
        (if (i32.eq (local.get $w) (i32.const 4))
          (then (local.set $cyc (i32.add (local.get $cyc) (i32.add (call $wsr (i32.const 2) (local.get $sr)) (call $wsr (i32.const 2) (local.get $dr)))))
                (i32.store (call $dp (local.get $ch) (i32.const ${D_CYC})) (i32.add (call $wsr (i32.const 3) (local.get $sr)) (call $wsr (i32.const 3) (local.get $dr)))))
          (else (local.set $cyc (i32.add (local.get $cyc) (i32.add (call $wsr (i32.const 0) (local.get $sr)) (call $wsr (i32.const 0) (local.get $dr)))))
                (i32.store (call $dp (local.get $ch) (i32.const ${D_CYC})) (i32.add (call $wsr (i32.const 1) (local.get $sr)) (call $wsr (i32.const 1) (local.get $dr)))))))
      (else
        (if (i32.or (i32.eqz (i32.and (local.get $src) (i32.const 0x00FFFFFC))) (i32.eqz (i32.and (local.get $dst) (i32.const 0x00FFFFFC))))
          (then (i32.store (call $dp (local.get $ch) (i32.const ${D_CYC}))
                  (if (result i32) (i32.eq (local.get $w) (i32.const 4))
                    (then (i32.add (call $wsr (i32.const 3) (local.get $sr)) (call $wsr (i32.const 3) (local.get $dr))))
                    (else (i32.add (call $wsr (i32.const 1) (local.get $sr)) (call $wsr (i32.const 1) (local.get $dr))))))))
        (local.set $cyc (i32.add (local.get $cyc) (i32.load (call $dp (local.get $ch) (i32.const ${D_CYC})))))))
    (i32.store (call $dp (local.get $ch) (i32.const ${D_WHEN})) (i32.add (i32.load (call $dp (local.get $ch) (i32.const ${D_WHEN}))) (local.get $cyc)))
    (if (i32.eq (local.get $w) (i32.const 4))
      (then
        (if (local.get $src) (then (global.set $dmaTR (call $ld32 (local.get $src) (i32.const 0)))))
        (call $st32 (local.get $dst) (global.get $dmaTR) (i32.const 0)))
      (else
        (if (i32.and (i32.eq (local.get $sr) (i32.const 13))
                     (i32.or (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM})) (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM512}))))
          (then (global.set $dmaTR (i32.mul (call $eeprom_read) (i32.const 0x10001))))
          (else (if (local.get $src)
            (then (global.set $dmaTR (call $ld16 (local.get $src) (i32.const 0)))
                  (global.set $dmaTR (i32.or (global.get $dmaTR) (i32.shl (global.get $dmaTR) (i32.const 16))))))))
        (if (i32.eq (local.get $dr) (i32.const 13))
          (then
            (if (i32.eq (global.get $saveType) (i32.const ${SAVE_AUTODETECT})) (then (call $save_init (i32.const ${SAVE_EEPROM512}))))
            (if (i32.or (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM512})) (i32.eq (global.get $saveType) (i32.const ${SAVE_EEPROM})))
              (then (call $eeprom_write (global.get $dmaTR) (i32.load (call $dp (local.get $ch) (i32.const ${D_NCNT})))))))
          (else (call $st16 (local.get $dst) (global.get $dmaTR) (i32.const 0))))))
    (global.set $bus (global.get $dmaTR))
    (if (i32.and (i32.and (i32.ge_u (local.get $src) (i32.const 0x08000000)) (i32.lt_u (local.get $src) (i32.const 0x0E000000)))
                 (i32.lt_u (i32.and (i32.shr_u (local.get $r) (i32.const 7)) (i32.const 3)) (i32.const 3)))
      (then (local.set $soff (local.get $w)))
      (else (local.set $soff (i32.mul (i32.load8_s (i32.add (i32.const ${L.DMAOFF}) (i32.and (i32.shr_u (local.get $r) (i32.const 7)) (i32.const 3))))
                                      (local.get $w)))))
    (local.set $doff (i32.mul (i32.load8_s (i32.add (i32.const ${L.DMAOFF}) (i32.and (i32.shr_u (local.get $r) (i32.const 5)) (i32.const 3))))
                              (local.get $w)))
    (if (local.get $src)
      (then (i32.store (call $dp (local.get $ch) (i32.const ${D_NSRC})) (i32.add (i32.load (call $dp (local.get $ch) (i32.const ${D_NSRC}))) (local.get $soff)))))
    (i32.store (call $dp (local.get $ch) (i32.const ${D_NDST})) (i32.add (i32.load (call $dp (local.get $ch) (i32.const ${D_NDST}))) (local.get $doff)))
    (i32.store (call $dp (local.get $ch) (i32.const ${D_NCNT})) (i32.sub (i32.load (call $dp (local.get $ch) (i32.const ${D_NCNT}))) (i32.const 1)))
    (global.set $performingDMA (i32.const 0))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 4)))
      (if (i32.and (i32.ne (i32.and (i32.load (call $dp (local.get $i) (i32.const ${D_REG}))) (i32.const 0x8000)) (i32.const 0))
                   (i32.ne (i32.load (call $dp (local.get $i) (i32.const ${D_NCNT}))) (i32.const 0)))
        (then
          (local.set $t (i32.sub (i32.load (call $dp (local.get $i) (i32.const ${D_WHEN})))
                                 (i32.load (call $dp (local.get $ch) (i32.const ${D_WHEN})))))
          (if (i32.lt_s (local.get $t) (i32.const 0))
            (then (i32.store (call $dp (local.get $i) (i32.const ${D_WHEN})) (i32.load (call $dp (local.get $ch) (i32.const ${D_WHEN}))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (if (i32.eqz (i32.load (call $dp (local.get $ch) (i32.const ${D_NCNT}))))
      (then
        (i32.store (call $dp (local.get $ch) (i32.const ${D_NCNT})) (i32.const 0x80000000))
        (if (i32.or (i32.lt_u (local.get $sr) (i32.const 8)) (i32.lt_u (local.get $dr) (i32.const 8)))
          (then (i32.store (call $dp (local.get $ch) (i32.const ${D_WHEN})) (i32.add (i32.load (call $dp (local.get $ch) (i32.const ${D_WHEN}))) (i32.const 2)))))))
    (call $dma_update))

  ;; waitstate table lookup by region, as the C indexes it (region = address >> 24)
  (func $wsr (param $table i32) (param $r i32) (result i32)
    (if (i32.gt_u (local.get $r) (i32.const 255)) (then (return (i32.const 0))))
    (i32.load8_s (i32.add (i32.add (i32.const ${WS}) (i32.shl (local.get $table) (i32.const 8))) (local.get $r))))

  (func $dma_recalc_cycles   ;; GBADMARecalculateCycles
    (local $i i32) (local $r i32) (local $sr i32) (local $dr i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 4)))
      (local.set $r (i32.load (call $dp (local.get $i) (i32.const ${D_REG}))))
      (if (i32.and (local.get $r) (i32.const 0x8000))
        (then
          (local.set $sr (i32.shr_u (i32.load (call $dp (local.get $i) (i32.const ${D_NSRC}))) (i32.const 24)))
          (local.set $dr (i32.shr_u (i32.load (call $dp (local.get $i) (i32.const ${D_NDST}))) (i32.const 24)))
          (i32.store (call $dp (local.get $i) (i32.const ${D_CYC}))
            (if (result i32) (i32.and (local.get $r) (i32.const 0x400))
              (then (i32.add (call $wsr (i32.const 3) (local.get $sr)) (call $wsr (i32.const 3) (local.get $dr))))
              (else (i32.add (call $wsr (i32.const 1) (local.get $sr)) (call $wsr (i32.const 1) (local.get $dr))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  ;; ======================= sound FIFOs (audio.c) =========================
  (func $write_soundcnt_hi (param $v i32)   ;; GBAAudioWriteSOUNDCNT_HI
    (global.set $chALR (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 3)))
    (global.set $chATimer (i32.and (i32.shr_u (local.get $v) (i32.const 10)) (i32.const 1)))
    (global.set $chBLR (i32.and (i32.shr_u (local.get $v) (i32.const 12)) (i32.const 3)))
    (global.set $chBTimer (i32.and (i32.shr_u (local.get $v) (i32.const 14)) (i32.const 1)))
    (if (i32.and (local.get $v) (i32.const 0x0800)) (then (global.set $chAWrite (i32.const 0)) (global.set $chARead (i32.const 0))))
    (if (i32.and (local.get $v) (i32.const 0x8000)) (then (global.set $chBWrite (i32.const 0)) (global.set $chBRead (i32.const 0)))))

  (func $write_soundcnt_x (param $v i32)   ;; GBAAudioWriteSOUNDCNT_X
    (local $i i32)
    (global.set $aEnable (i32.and (i32.shr_u (local.get $v) (i32.const 7)) (i32.const 1)))
    (if (i32.eqz (global.get $aEnable))
      (then
        (local.set $i (i32.const 0x60))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $i) (i32.const 0x82)))
          (call $io16w (local.get $i) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 2)))
          (br $l)))
        (global.set $ch3bank (i32.const 0))
        (call $io16w (i32.const 0x82) (i32.and (call $io16 (i32.const 0x82)) (i32.const 0xFF00))))))

  (func $fifo_write (param $b i32)   ;; GBAAudioWriteFIFO: the ring advances
    (if (local.get $b)
      (then (global.set $chBWrite (i32.and (i32.add (global.get $chBWrite) (i32.const 1)) (i32.const 7))))
      (else (global.set $chAWrite (i32.and (i32.add (global.get $chAWrite) (i32.const 1)) (i32.const 7))))))

  (func $fifo_schedule_dma (param $ch i32)   ;; GBAAudioScheduleFifoDma
    (local $r i32) (local $d i32)
    (local.set $r (i32.load (call $dp (local.get $ch) (i32.const ${D_REG}))))
    (local.set $r (i32.or (i32.and (local.get $r) (i32.const -97)) (i32.const 0x40)))   ;; dest control FIXED
    (local.set $r (i32.or (local.get $r) (i32.const 0x400)))                            ;; width 32
    (i32.store (call $dp (local.get $ch) (i32.const ${D_REG})) (local.get $r))
    (local.set $d (i32.load (call $dp (local.get $ch) (i32.const ${D_DST}))))
    (if (i32.eq (local.get $d) (i32.const 0x040000A0)) (then (global.set $chADma (local.get $ch)) (return)))
    (if (i32.eq (local.get $d) (i32.const 0x040000A4)) (then (global.set $chBDma (local.get $ch)))))

  (func $fifo_sample (param $id i32) (param $late i32)   ;; GBAAudioSampleFIFO
    (local $wr i32) (local $rd i32) (local $size i32) (local $src i32) (local $rem i32)
    (if (local.get $id)
      (then (local.set $wr (global.get $chBWrite)) (local.set $rd (global.get $chBRead))
            (local.set $src (global.get $chBDma)) (local.set $rem (global.get $chBRem)))
      (else (local.set $wr (global.get $chAWrite)) (local.set $rd (global.get $chARead))
            (local.set $src (global.get $chADma)) (local.set $rem (global.get $chARem))))
    (local.set $size (if (result i32) (i32.ge_s (local.get $wr) (local.get $rd))
      (then (i32.sub (local.get $wr) (local.get $rd)))
      (else (i32.add (i32.sub (i32.const 8) (local.get $rd)) (local.get $wr)))))
    (if (i32.and (i32.gt_s (i32.sub (i32.const 8) (local.get $size)) (i32.const 4)) (i32.gt_s (local.get $src) (i32.const 0)))
      (then
        (if (i32.eq (i32.and (i32.load (call $dp (local.get $src) (i32.const ${D_REG}))) (i32.const 0x3000)) (i32.const 0x3000))
          (then
            (i32.store (call $dp (local.get $src) (i32.const ${D_WHEN})) (i32.sub (call $now) (local.get $late)))
            (i32.store (call $dp (local.get $src) (i32.const ${D_NCNT})) (i32.const 4))
            (call $dma_recalc_cycles)
            (call $dma_schedule (local.get $src))))))
    (if (i32.and (i32.eqz (local.get $rem)) (i32.ne (local.get $size) (i32.const 0)))
      (then (call $au_fifo_load (local.get $id) (local.get $rd))   ;; audio.js: internalSample
            (local.set $rem (i32.const 4))
            (local.set $rd (i32.and (i32.add (local.get $rd) (i32.const 1)) (i32.const 7)))))
    (call $au_fifo_fill (local.get $id) (local.get $rem))   ;; audio.js: the sample slots
    (if (local.get $rem) (then (local.set $rem (i32.sub (local.get $rem) (i32.const 1)))))
    (if (local.get $id)
      (then (global.set $chBRead (local.get $rd)) (global.set $chBRem (local.get $rem)))
      (else (global.set $chARead (local.get $rd)) (global.set $chARem (local.get $rem)))))

  ;; ======================= SIO (sio.c, no driver) ========================
  (func $sio_switch_mode   ;; _switchMode
    (local $m i32)
    (local.set $m (i32.shr_u (i32.or (i32.and (global.get $rcnt) (i32.const 0xC000)) (i32.and (global.get $siocnt) (i32.const 0x3000))) (i32.const 12)))
    (local.set $m (if (result i32) (i32.lt_u (local.get $m) (i32.const 8)) (then (i32.and (local.get $m) (i32.const 3))) (else (i32.and (local.get $m) (i32.const 12)))))
    (if (i32.ne (local.get $m) (global.get $siomode))
      (then (global.set $siomode (local.get $m))
            (if (i32.eq (local.get $m) (i32.const 2))
              (then (global.set $rcnt (i32.and (global.get $rcnt) (i32.const -5))))))))

  (func $sio_write_rcnt (param $v i32)   ;; GBASIOWriteRCNT
    (global.set $rcnt (i32.or (i32.and (global.get $rcnt) (i32.const 0x1FF)) (i32.and (local.get $v) (i32.const 0xC000))))
    (call $sio_switch_mode)
    (if (i32.eq (global.get $siomode) (i32.const 8))
      (then (global.set $rcnt (i32.or (i32.and (global.get $rcnt) (i32.const 0xC000)) (i32.and (local.get $v) (i32.const 0x1FF)))))
      (else (global.set $rcnt (i32.or (i32.and (global.get $rcnt) (i32.const 0xC00F)) (i32.and (local.get $v) (i32.const 0x1F0)))))))

  (func $sio_transfer_cycles (result i32)   ;; GBASIOTransferCycles, 0 devices
    (if (i32.eq (global.get $siomode) (i32.const 2))
      (then (return (i32.load (i32.add (i32.const ${L.SIOCYC}) (i32.shl (i32.and (global.get $siocnt) (i32.const 3)) (i32.const 2)))))))
    (if (i32.eqz (global.get $siomode))
      (then (return (if (result i32) (i32.and (global.get $siocnt) (i32.const 2)) (then (i32.const 64)) (else (i32.const 512))))))
    (if (i32.eq (global.get $siomode) (i32.const 1))
      (then (return (if (result i32) (i32.and (global.get $siocnt) (i32.const 2)) (then (i32.const 256)) (else (i32.const 2048))))))
    (i32.const 0))

  (func $sio_start
    (call $deschedule (i32.const ${EV_SIO}))
    (call $schedule (i32.const ${EV_SIO}) (call $sio_transfer_cycles)))

  (func $sio_write_siocnt (param $v i32)   ;; GBASIOWriteSIOCNT (dummy driver)
    (if (i32.and (i32.xor (local.get $v) (global.get $siocnt)) (i32.const 0x3000))
      (then (global.set $siocnt (i32.and (local.get $v) (i32.const 0x3000))) (call $sio_switch_mode)))
    (if (i32.eq (global.get $siomode) (i32.const 2))
      (then
        (local.set $v (i32.and (local.get $v) (i32.const 0xFF83)))
        (local.set $v (i32.or (local.get $v) (i32.const 4)))         ;; slave (no devices)
        (local.set $v (i32.and (local.get $v) (i32.const -49)))       ;; id 0
        (local.set $v (i32.or (local.get $v) (i32.and (global.get $siocnt) (i32.const 0xFC))))
        (global.set $rcnt (i32.or (global.get $rcnt) (i32.const 1)))
        (if (i32.and (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)) (i32.eqz (i32.and (global.get $siocnt) (i32.const 0x80))))
          (then
            (call $io16w (i32.const 0x120) (i32.const 0xFFFF)) (call $io16w (i32.const 0x122) (i32.const 0xFFFF))
            (call $io16w (i32.const 0x124) (i32.const 0xFFFF)) (call $io16w (i32.const 0x126) (i32.const 0xFFFF))
            (global.set $rcnt (i32.and (global.get $rcnt) (i32.const -2)))
            (call $sio_start)))
        (local.set $v (i32.or (local.get $v) (i32.const 8)))))        ;; FillReady
    (if (i32.le_u (global.get $siomode) (i32.const 1))
      (then
        (if (i32.and (local.get $v) (i32.const 1)) (then (global.set $rcnt (i32.or (global.get $rcnt) (i32.const 1)))))
        (if (i32.and (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)) (i32.eqz (i32.and (global.get $siocnt) (i32.const 0x80))))
          (then (call $sio_start)))
        (local.set $v (i32.or (local.get $v) (i32.const 4)))))        ;; FillSi
    (global.set $siocnt (local.get $v)))

  (func $sio_write_reg (param $a i32) (param $v i32) (result i32)   ;; GBASIOWriteRegister
    (local $h i32)
    (local.set $h (i32.const 0))
    (if (i32.eq (global.get $siomode) (i32.const 12))
      (then (if (i32.or (i32.or (i32.eq (local.get $a) (i32.const 0x12A)) (i32.eq (local.get $a) (i32.const 0x154)))
                        (i32.eq (local.get $a) (i32.const 0x156))) (then (local.set $h (i32.const 1))))
            (if (i32.eq (local.get $a) (i32.const 0x140))
              (then (local.set $h (i32.const 1))
                    (local.set $v (i32.or (i32.and (local.get $v) (i32.const 0x40))
                      (i32.and (i32.and (call $io16 (i32.const 0x140)) (i32.xor (i32.and (local.get $v) (i32.const 7)) (i32.const -1))) (i32.const -65))))))
            (if (i32.eq (local.get $a) (i32.const 0x158))
              (then (local.set $h (i32.const 1))
                    (local.set $v (i32.or (i32.and (local.get $v) (i32.const 0x30)) (i32.and (call $io16 (i32.const 0x158)) (i32.const -49))))))))
    (if (i32.le_u (global.get $siomode) (i32.const 3))
      (then
        (if (i32.eq (local.get $a) (i32.const 0x140))
          (then (local.set $h (i32.const 1))
                (local.set $v (i32.or (i32.and (local.get $v) (i32.const 0x40))
                  (i32.and (i32.and (call $io16 (i32.const 0x140)) (i32.xor (i32.and (local.get $v) (i32.const 7)) (i32.const -1))) (i32.const -65))))))
        (if (i32.and (i32.eq (local.get $a) (i32.const 0x12A)) (i32.ne (global.get $siomode) (i32.const 2))) (then (local.set $h (i32.const 1))))
        (if (i32.and (i32.eq (local.get $a) (i32.const 0x12A)) (i32.eq (global.get $siomode) (i32.const 2))) (then (local.set $h (i32.const 1))))
        (if (i32.and (i32.eq (global.get $siomode) (i32.const 1)) (i32.or (i32.eq (local.get $a) (i32.const 0x120)) (i32.eq (local.get $a) (i32.const 0x122))))
          (then (local.set $h (i32.const 1))))))
    (if (i32.eqz (local.get $h)) (then (return (call $io16 (local.get $a)))))
    (local.get $v))

  (func $sio_finish (param $late i32)   ;; _sioFinish with no driver: zero data
    (if (i32.eq (global.get $siomode) (i32.const 2))
      (then
        (call $io16w (i32.const 0x120) (i32.const 0)) (call $io16w (i32.const 0x122) (i32.const 0))
        (call $io16w (i32.const 0x124) (i32.const 0)) (call $io16w (i32.const 0x126) (i32.const 0))
        (global.set $siocnt (i32.and (global.get $siocnt) (i32.const -129)))
        (global.set $siocnt (i32.and (global.get $siocnt) (i32.const -49)))
        (global.set $rcnt (i32.or (global.get $rcnt) (i32.const 1)))
        (if (i32.and (global.get $siocnt) (i32.const 0x4000)) (then (call $raise_irq (i32.const 7) (local.get $late))))
        (return)))
    (if (i32.eqz (global.get $siomode))
      (then (global.set $siocnt (i32.and (global.get $siocnt) (i32.const -129)))
            (call $io16w (i32.const 0x12A) (i32.const 0))
            (if (i32.and (global.get $siocnt) (i32.const 0x4000)) (then (call $raise_irq (i32.const 7) (local.get $late))))
            (return)))
    (if (i32.eq (global.get $siomode) (i32.const 1))
      (then (global.set $siocnt (i32.and (global.get $siocnt) (i32.const -129)))
            (call $io16w (i32.const 0x120) (i32.const 0)) (call $io16w (i32.const 0x122) (i32.const 0))
            (if (i32.and (global.get $siocnt) (i32.const 0x4000)) (then (call $raise_irq (i32.const 7) (local.get $late)))))))

  ;; ======================= save chips (savedata.c) =======================
  (func $save_init (param $t i32)
    (local $i i32) (local $n i32)
    (if (i32.ne (global.get $saveType) (i32.const ${SAVE_AUTODETECT})) (then (return)))
    (global.set $saveType (local.get $t))
    (local.set $n (i32.const 0x20000))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store8 (i32.add (i32.const ${SAVE}) (local.get $i)) (i32.const 0xFF))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $bank_base (result i32)
    (i32.add (i32.const ${SAVE}) (i32.shl (global.get $flashBank) (i32.const 16))))

  (func $flash_read (param $a i32) (result i32)   ;; GBASavedataReadFlash
    (if (i32.eq (global.get $saveCmd) (i32.const 0x90))
      (then
        (if (i32.lt_u (local.get $a) (i32.const 2))
          (then (return (i32.and (i32.shr_u (if (result i32) (i32.eq (global.get $saveType) (i32.const ${SAVE_FLASH512}))
                                               (then (i32.const 0x1B32)) (else (i32.const 0x1362)))
                                             (i32.shl (local.get $a) (i32.const 3))) (i32.const 0xFF)))))))
    (if (i32.and (call $scheduled (i32.const ${EV_DUST})) (i32.eq (i32.shr_u (local.get $a) (i32.const 12)) (global.get $settling)))
      (then (return (i32.and (i32.xor (i32.load8_u (i32.add (call $bank_base) (local.get $a))) (i32.const 0x80)) (i32.const 0x80)))))
    (i32.load8_u (i32.add (call $bank_base) (local.get $a))))

  (func $flash_write (param $a i32) (param $v i32)   ;; GBASavedataWriteFlash
    (local $i i32) (local $n i32) (local $s i32)
    (if (i32.eqz (global.get $flashState))
      (then
        (if (i32.eq (global.get $saveCmd) (i32.const 0xA0))
          (then (i32.store8 (i32.add (call $bank_base) (local.get $a)) (local.get $v))
                (global.set $saveCmd (i32.const 0))
                (call $deschedule (i32.const ${EV_DUST}))
                (call $schedule (i32.const ${EV_DUST}) (i32.const 650))
                (return)))
        (if (i32.eq (global.get $saveCmd) (i32.const 0xB0))
          (then (if (i32.and (i32.eqz (local.get $a)) (i32.lt_u (local.get $v) (i32.const 2)))
                  (then (if (i32.and (i32.ne (local.get $v) (i32.const 0)) (i32.eq (global.get $saveType) (i32.const ${SAVE_FLASH512})))
                          (then (global.set $saveType (i32.const ${SAVE_FLASH1M}))))
                        (global.set $flashBank (local.get $v))))
                (global.set $saveCmd (i32.const 0))
                (return)))
        (if (i32.and (i32.eq (local.get $a) (i32.const 0x5555)) (i32.eq (local.get $v) (i32.const 0xAA)))
          (then (global.set $flashState (i32.const 1))))
        (return)))
    (if (i32.eq (global.get $flashState) (i32.const 1))
      (then (global.set $flashState (if (result i32) (i32.and (i32.eq (local.get $a) (i32.const 0x2AAA)) (i32.eq (local.get $v) (i32.const 0x55)))
                                      (then (i32.const 2)) (else (i32.const 0))))
            (return)))
    (global.set $flashState (i32.const 0))
    (if (i32.eq (local.get $a) (i32.const 0x5555))
      (then
        (if (i32.eqz (global.get $saveCmd))
          (then (if (i32.or (i32.or (i32.eq (local.get $v) (i32.const 0x80)) (i32.eq (local.get $v) (i32.const 0x90)))
                            (i32.or (i32.eq (local.get $v) (i32.const 0xA0)) (i32.eq (local.get $v) (i32.const 0xB0))))
                  (then (global.set $saveCmd (local.get $v))))
                (return)))
        (if (i32.eq (global.get $saveCmd) (i32.const 0x80))
          (then (if (i32.eq (local.get $v) (i32.const 0x10))
                  (then (local.set $n (if (result i32) (i32.eq (global.get $saveType) (i32.const ${SAVE_FLASH1M})) (then (i32.const 0x20000)) (else (i32.const 0x10000))))
                        (block $d (loop $l
                          (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
                          (i32.store8 (i32.add (i32.const ${SAVE}) (local.get $i)) (i32.const 0xFF))
                          (local.set $i (i32.add (local.get $i) (i32.const 1)))
                          (br $l)))))
                (global.set $saveCmd (i32.const 0))
                (return)))
        (if (i32.eq (global.get $saveCmd) (i32.const 0x90))
          (then (if (i32.eq (local.get $v) (i32.const 0xF0)) (then (global.set $saveCmd (i32.const 0)))) (return)))
        (global.set $saveCmd (i32.const 0))
        (return)))
    (if (i32.eq (global.get $saveCmd) (i32.const 0x80))
      (then (if (i32.eq (local.get $v) (i32.const 0x30))
              (then
                (global.set $settling (i32.shr_u (local.get $a) (i32.const 12)))
                (call $deschedule (i32.const ${EV_DUST}))
                (call $schedule (i32.const ${EV_DUST}) (i32.const 30000))
                (local.set $s (i32.and (local.get $a) (i32.const 0xF000)))
                (block $d2 (loop $l2
                  (br_if $d2 (i32.ge_u (local.get $i) (i32.const 0x1000)))
                  (i32.store8 (i32.add (i32.add (call $bank_base) (local.get $s)) (local.get $i)) (i32.const 0xFF))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $l2)))
                (global.set $saveCmd (i32.const 0)))))))

  (func $eeprom_write (param $v i32) (param $size i32)   ;; GBASavedataWriteEEPROM
    (local $cur i32) (local $bit i32)
    (if (i32.eq (global.get $saveCmd) (i32.const 1))
      (then (global.set $saveCmd (i32.or (i32.shl (global.get $saveCmd) (i32.const 1)) (i32.and (local.get $v) (i32.const 1))))
            (if (i32.eq (global.get $saveCmd) (i32.const 2)) (then (global.set $eepWrite (i32.const 0))) (else (global.set $eepRead (i32.const 0))))
            (return)))
    (if (i32.eq (global.get $saveCmd) (i32.const 2))
      (then
        (if (i32.gt_u (local.get $size) (i32.const 65))
          (then (global.set $eepWrite (i32.or (i32.shl (global.get $eepWrite) (i32.const 1)) (i32.shl (i32.and (local.get $v) (i32.const 1)) (i32.const 6))))
                (return)))
        (if (i32.eq (local.get $size) (i32.const 1)) (then (global.set $saveCmd (i32.const 0)) (return)))
        (if (i32.lt_u (i32.shr_u (global.get $eepWrite) (i32.const 3)) (i32.const 0x2000))
          (then
            (if (i32.ge_u (i32.shr_u (global.get $eepWrite) (i32.const 3)) (i32.const 0x200)) (then (global.set $saveType (i32.const ${SAVE_EEPROM}))))
            (local.set $bit (i32.sub (i32.const 7) (i32.and (global.get $eepWrite) (i32.const 7))))
            (local.set $cur (i32.load8_u (i32.add (i32.const ${SAVE}) (i32.shr_u (global.get $eepWrite) (i32.const 3)))))
            (local.set $cur (i32.and (local.get $cur) (i32.xor (i32.shl (i32.const 1) (local.get $bit)) (i32.const -1))))
            (local.set $cur (i32.or (local.get $cur) (i32.shl (i32.and (local.get $v) (i32.const 1)) (local.get $bit))))
            (i32.store8 (i32.add (i32.const ${SAVE}) (i32.shr_u (global.get $eepWrite) (i32.const 3))) (local.get $cur))
            (call $deschedule (i32.const ${EV_DUST}))
            (call $schedule (i32.const ${EV_DUST}) (i32.const 115000))
            (global.set $eepWrite (i32.add (global.get $eepWrite) (i32.const 1)))))
        (return)))
    (if (i32.eq (global.get $saveCmd) (i32.const 3))
      (then
        (if (i32.gt_u (local.get $size) (i32.const 1))
          (then (global.set $eepRead (i32.shl (global.get $eepRead) (i32.const 1)))
                (if (i32.and (local.get $v) (i32.const 1)) (then (global.set $eepRead (i32.or (global.get $eepRead) (i32.const 0x40))))))
          (else (global.set $eepBits (i32.const 68)) (global.set $saveCmd (i32.const 4))))
        (return)))
    (global.set $saveCmd (i32.and (local.get $v) (i32.const 1))))

  (func $eeprom_read (result i32)   ;; GBASavedataReadEEPROM
    (local $step i32) (local $a i32)
    (if (i32.ne (global.get $saveCmd) (i32.const 4))
      (then (return (i32.eqz (call $scheduled (i32.const ${EV_DUST}))))))
    (global.set $eepBits (i32.sub (global.get $eepBits) (i32.const 1)))
    (if (i32.lt_s (global.get $eepBits) (i32.const 64))
      (then
        (local.set $step (i32.sub (i32.const 63) (global.get $eepBits)))
        (local.set $a (i32.shr_u (i32.add (global.get $eepRead) (local.get $step)) (i32.const 3)))
        (if (i32.ge_u (local.get $a) (i32.const 0x200)) (then (global.set $saveType (i32.const ${SAVE_EEPROM}))))
        (if (i32.ge_u (local.get $a) (i32.const 0x2000)) (then (return (i32.const 0xFF))))
        (if (i32.eqz (global.get $eepBits)) (then (global.set $saveCmd (i32.const 0))))
        (return (i32.and (i32.shr_u (i32.load8_u (i32.add (i32.const ${SAVE}) (local.get $a)))
                                    (i32.sub (i32.const 7) (i32.and (local.get $step) (i32.const 7)))) (i32.const 1)))))
    (i32.const 0))
`;
}

/**
 * GBASwi16 (bios.c) and the C helpers it calls. The rest of the BIOS
 * (IntrWait, CpuSet, the IRQ dispatcher, SoftReset...) is mGBA's HLE BIOS
 * binary, executed as ARM code at $00000000 like the reference does.
 * @param {Record<string, number>} L
 * @returns {string}
 */
export function swiWat(L) {
  const REGS = L.REGS, IO = L.IO, SINTAB = L.SINTAB;
  /** @param {number} n */
  const r = (n) => `(i32.load (i32.const ${REGS + 4 * n}))`;
  /** @param {number} n @param {string} e */
  const w = (n, e) => `(i32.store (i32.const ${REGS + 4 * n}) ${e})`;
  /** @param {number[][]} pairs */
  const st16s = (pairs) => pairs.map(([o, v]) => `        (call $st16 (i32.const ${0x04000000 + o}) (i32.const ${v}) (i32.const 0))
`).join('');
    return `
  (func $swi16 (param $imm i32)
    (local $stall i32)
    (if (i32.eq (local.get $imm) (i32.const 0xF0)) (then ${w(11, `(global.get $biosStall)`)} (return)))
    (if (i32.eq (local.get $imm) (i32.const 0xFA)) (then (return)))
    (block $sw
      (block $stub (block $b2a (block $b1f (block $b19 (block $b18 (block $b16 (block $b14 (block $b13 (block $b11 (block $b10
      (block $b0f (block $b0e (block $b0d (block $b0b (block $b0a (block $b09 (block $b08 (block $b07 (block $b06 (block $b04
      (block $b03 (block $b02 (block $b01 (block $b00
        (br_table $b00 $b01 $b02 $b03 $b04 $b04 $b06 $b07 $b08 $b09 $b0a $b0b $b0b $b0d $b0e $b0f $b10 $b11 $b11 $b13 $b14 $b14
                  $b16 $b16 $b18 $b19 $stub $stub $stub $stub $stub $b1f $stub $stub $stub $stub $stub $stub $stub $stub $stub $stub $b2a $stub
          (if (result i32) (i32.gt_u (local.get $imm) (i32.const 0x2A)) (then (i32.const 0x2B)) (else (local.get $imm)))))
        (call $raise_swi) (br $sw))                                   ;; 00 SoftReset
        (call $register_ram_reset) (br $sw))                          ;; 01
        (call $raise_swi) (return))                                   ;; 02 Halt
        (call $stop) (br $sw))                                        ;; 03 Stop
        (call $raise_swi) (return))                                   ;; 04/05 IntrWait
        (local.set $stall (i32.const 1)) (call $bios_div ${r(0)} ${r(1)}) (br $sw))       ;; 06
        (local.set $stall (i32.const 1)) (call $bios_div ${r(1)} ${r(0)}) (br $sw))       ;; 07
        (local.set $stall (i32.const 1)) ${w(0, `(call $bios_sqrt ${r(0)})`)} (br $sw))  ;; 08
        (local.set $stall (i32.const 1)) (call $bios_arctan_swi) (br $sw))              ;; 09
        (local.set $stall (i32.const 1))                                                ;; 0A
        ${w(0, `(i32.and (call $bios_arctan2 ${r(0)} ${r(1)}) (i32.const 0xFFFF))`)}
        ${w(3, `(i32.const 0x170)`)} (br $sw))
        (call $raise_swi) (return))                                   ;; 0B/0C CpuSet/CpuFastSet
        ${w(0, `(i32.const 0xBAAE187F)`)} ${w(1, `(i32.const 1)`)} ${w(3, `(i32.const 0x4000)`)} (br $sw))   ;; 0D
        (call $bios_bgaffine) (br $sw))                               ;; 0E
        (call $bios_objaffine) (br $sw))                              ;; 0F
        (if (i32.lt_u ${r(0)} (i32.const 0x02000000)) (then (br $sw)))  ;; 10 BitUnPack
        (call $bios_bitunpack) (br $sw))
        (if (i32.eqz (i32.and ${r(0)} (i32.const 0x0E000000))) (then (br $sw)))   ;; 11/12 LZ77
        (local.set $stall (i32.const 1))
        (call $bios_lz77 (if (result i32) (i32.eq (local.get $imm) (i32.const 0x11)) (then (i32.const 1)) (else (i32.const 2))))
        (br $sw))
        (if (i32.eqz (i32.and ${r(0)} (i32.const 0x0E000000))) (then (br $sw)))   ;; 13 Huffman
        (call $bios_huffman) (br $sw))
        (if (i32.eqz (i32.and ${r(0)} (i32.const 0x0E000000))) (then (br $sw)))   ;; 14/15 RL
        (call $bios_rl (if (result i32) (i32.eq (local.get $imm) (i32.const 0x14)) (then (i32.const 1)) (else (i32.const 2))))
        (br $sw))
        (if (i32.eqz (i32.and ${r(0)} (i32.const 0x0E000000))) (then (br $sw)))   ;; 16/17 Diff8
        (call $bios_unfilter (i32.const 1) (if (result i32) (i32.eq (local.get $imm) (i32.const 0x16)) (then (i32.const 1)) (else (i32.const 2))))
        (br $sw))
        (if (i32.eqz (i32.and ${r(0)} (i32.const 0x0E000000))) (then (br $sw)))   ;; 18 Diff16
        (call $bios_unfilter (i32.const 2) (i32.const 2)) (br $sw))
        (br $sw))                                                     ;; 19 SoundBias: stub
        (call $bios_midikey2freq) (br $sw))                           ;; 1F MidiKey2Freq
        (call $raise_swi) (return))                                   ;; 2A SoundDriverGetJumpList
      (br $sw))                                                       ;; stub
    (if (local.get $stall)
      (then
        (if (i32.ge_u (global.get $biosStall) (i32.const 18))
          (then
            (global.set $biosStall (i32.sub (global.get $biosStall) (i32.const 18)))
            (global.set $cycles (i32.add (global.get $cycles) (i32.and (global.get $biosStall) (i32.const 3))))
            (global.set $biosStall (i32.and (global.get $biosStall) (i32.const -4)))
            (call $raise_swi))
          (else
            (global.set $cycles (i32.add (global.get $cycles) (global.get $biosStall)))
            (local.set $stall (i32.const 0))))))
    (if (i32.eqz (local.get $stall))
      (then
        (global.set $cycles (i32.add (global.get $cycles) (i32.add (i32.const 45) (global.get $anon16))))
        (global.set $cycles (i32.add (global.get $cycles)
          (if (result i32) (global.get $thumb)
            (then (i32.add (global.get $anon16) (global.get $aseq16)))
            (else (i32.add (global.get $anon32) (global.get $aseq32))))))))
    (global.set $biosPrefetch (i32.const 0xE3A02004)))

  ;; _MidiKey2Freq: r0 = key / exp2f((180 - r1 - r2/256) / 12), float math
  ;; as the C evaluates it, with musl's exp2f (romdev's mGBA is an
  ;; emscripten build; glibc's exp2f is the same ARM algorithm).
  (func $bios_midikey2freq
    (local $key i32) (local $old i32)
    (local.set $old (global.get $areg))
    (global.set $areg (i32.const 0))
    (local.set $key (call $ld32 (i32.add ${r(0)} (i32.const 4)) (i32.const 0)))
    (global.set $areg (local.get $old))
    ${w(0, `(i32.trunc_sat_f32_s (f32.div (f32.convert_i32_u (local.get $key))
      (call $exp2f (f32.div (f32.sub (f32.sub (f32.const 180) (f32.convert_i32_s ${r(1)}))
                                     (f32.div (f32.convert_i32_s ${r(2)}) (f32.const 256)))
                            (f32.const 12)))))`)})

  (func $exp2f (param $x f32) (result f32)
    (local $xd f64) (local $kd f64) (local $ki i64) (local $r f64) (local $t i64) (local $s f64)
    (local $z f64) (local $r2 f64) (local $y f64)
    (local.set $xd (f64.promote_f32 (local.get $x)))
    (local.set $kd (f64.add (local.get $xd) (f64.const 0x1.8p+47)))
    (local.set $ki (i64.reinterpret_f64 (local.get $kd)))
    (local.set $kd (f64.sub (local.get $kd) (f64.const 0x1.8p+47)))
    (local.set $r (f64.sub (local.get $xd) (local.get $kd)))
    (local.set $t (i64.add (i64.load (i32.add (i32.const ${L.EXP2FTAB}) (i32.shl (i32.wrap_i64 (i64.rem_u (local.get $ki) (i64.const 32))) (i32.const 3))))
                           (i64.shl (local.get $ki) (i64.const 47))))
    (local.set $s (f64.reinterpret_i64 (local.get $t)))
    (local.set $z (f64.add (f64.mul (f64.const 0x1.c6af84b912394p-5) (local.get $r)) (f64.const 0x1.ebfce50fac4f3p-3)))
    (local.set $r2 (f64.mul (local.get $r) (local.get $r)))
    (local.set $y (f64.add (f64.mul (f64.const 0x1.62e42ff0c52d6p-1) (local.get $r)) (f64.const 1)))
    (local.set $y (f64.add (f64.mul (local.get $z) (local.get $r2)) (local.get $y)))
    (local.set $y (f64.mul (local.get $y) (local.get $s)))
    (f32.demote_f64 (local.get $y)))

  ;; _Div
  (func $bios_div (param $num i32) (param $den i32)
    (local $loops i32)
    (if (i32.eqz (local.get $den))
      (then ${w(0, `(if (result i32) (i32.lt_s (local.get $num) (i32.const 0)) (then (i32.const -1)) (else (i32.const 1)))`)}
            ${w(1, `(local.get $num)`)} ${w(3, `(i32.const 1)`)})
      (else (if (i32.and (i32.eq (local.get $den) (i32.const -1)) (i32.eq (local.get $num) (i32.const 0x80000000)))
        (then ${w(0, `(i32.const 0x80000000)`)} ${w(1, `(i32.const 0)`)} ${w(3, `(i32.const 0x80000000)`)})
        (else
          ${w(0, `(i32.div_s (local.get $num) (local.get $den))`)}
          ${w(1, `(i32.rem_s (local.get $num) (local.get $den))`)}
          ${w(3, `(if (result i32) (i32.lt_s ${r(0)} (i32.const 0)) (then (i32.sub (i32.const 0) ${r(0)})) (else ${r(0)}))`)}))))
    (local.set $loops (i32.sub (i32.clz (local.get $den)) (i32.clz (local.get $num))))
    (if (i32.lt_s (local.get $loops) (i32.const 1)) (then (local.set $loops (i32.const 1))))
    (global.set $biosStall (i32.add (i32.add (i32.const 4) (i32.mul (i32.const 13) (local.get $loops))) (i32.const 7))))

  ;; _Sqrt (with its cycle count)
  (func $bios_sqrt (param $x i32) (result i32)
    (local $cyc i32) (local $lower i32) (local $upper i32) (local $bound i32) (local $accum i32) (local $old i32) (local $ob i32)
    (if (i32.eqz (local.get $x)) (then (global.set $biosStall (i32.const 53)) (return (i32.const 0))))
    (local.set $cyc (i32.const 15))
    (local.set $upper (local.get $x))
    (local.set $bound (i32.const 1))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $bound) (local.get $upper)))
      (local.set $upper (i32.shr_u (local.get $upper) (i32.const 1)))
      (local.set $bound (i32.shl (local.get $bound) (i32.const 1)))
      (local.set $cyc (i32.add (local.get $cyc) (i32.const 6)))
      (br $l)))
    (block $out (loop $main
      (local.set $cyc (i32.add (local.get $cyc) (i32.const 6)))
      (local.set $upper (local.get $x))
      (local.set $accum (i32.const 0))
      (local.set $lower (local.get $bound))
      (block $d1 (loop $l1
        (local.set $cyc (i32.add (local.get $cyc) (i32.const 5)))
        (local.set $old (local.get $lower))
        (if (i32.le_u (local.get $lower) (i32.shr_u (local.get $upper) (i32.const 1)))
          (then (local.set $lower (i32.shl (local.get $lower) (i32.const 1)))))
        (br_if $d1 (i32.ge_u (local.get $old) (i32.shr_u (local.get $upper) (i32.const 1))))
        (br $l1)))
      (block $d2 (loop $l2
        (local.set $cyc (i32.add (local.get $cyc) (i32.const 8)))
        (local.set $accum (i32.shl (local.get $accum) (i32.const 1)))
        (if (i32.ge_u (local.get $upper) (local.get $lower))
          (then (local.set $accum (i32.add (local.get $accum) (i32.const 1)))
                (local.set $upper (i32.sub (local.get $upper) (local.get $lower)))))
        (br_if $d2 (i32.eq (local.get $lower) (local.get $bound)))
        (local.set $lower (i32.shr_u (local.get $lower) (i32.const 1)))
        (br $l2)))
      (local.set $ob (local.get $bound))
      (local.set $bound (i32.shr_u (i32.add (local.get $bound) (local.get $accum)) (i32.const 1)))
      (if (i32.ge_u (local.get $bound) (local.get $ob))
        (then (local.set $bound (local.get $ob)) (br $out)))
      (br $main)))
    (global.set $biosStall (local.get $cyc))
    (local.get $bound))

  (func $mulw (param $r i32) (result i32)   ;; _mulWait
    (if (result i32) (i32.or (i32.eq (i32.and (local.get $r) (i32.const 0xFFFFFF00)) (i32.const 0xFFFFFF00))
                             (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFFFF00))))
      (then (i32.const 1))
      (else (if (result i32) (i32.or (i32.eq (i32.and (local.get $r) (i32.const 0xFFFF0000)) (i32.const 0xFFFF0000))
                                     (i32.eqz (i32.and (local.get $r) (i32.const 0xFFFF0000))))
        (then (i32.const 2))
        (else (if (result i32) (i32.or (i32.eq (i32.and (local.get $r) (i32.const 0xFF000000)) (i32.const 0xFF000000))
                                       (i32.eqz (i32.and (local.get $r) (i32.const 0xFF000000))))
          (then (i32.const 3)) (else (i32.const 4))))))))

  (global $atan_a (mut i32) (i32.const 0))
  (global $atan_b (mut i32) (i32.const 0))
  ;; _ArcTan: result (i*b)>>16 (as int16 by the caller), a and b left behind,
  ;; cycles into biosStall.
  (func $bios_atan (param $i i32) (result i32)
    (local $a i32) (local $b i32) (local $cyc i32)
    (local.set $cyc (i32.add (i32.const 37) (call $mulw (i32.mul (local.get $i) (local.get $i)))))
    (local.set $a (i32.sub (i32.const 0) (i32.shr_s (i32.mul (local.get $i) (local.get $i)) (i32.const 14))))
    (local.set $cyc (i32.add (local.get $cyc) (call $mulw (i32.mul (i32.const 0xA9) (local.get $a)))))
    (local.set $b (i32.add (i32.shr_s (i32.mul (i32.const 0xA9) (local.get $a)) (i32.const 14)) (i32.const 0x390)))
` + ['0x91C', '0xFB6', '0x16AA', '0x2081', '0x3651', '0xA2F9'].map((k) => `    (local.set $cyc (i32.add (local.get $cyc) (call $mulw (i32.mul (local.get $b) (local.get $a)))))
    (local.set $b (i32.add (i32.shr_s (i32.mul (local.get $b) (local.get $a)) (i32.const 14)) (i32.const ${k})))
`).join('') + `    (global.set $atan_a (local.get $a))
    (global.set $atan_b (local.get $b))
    (global.set $biosStall (local.get $cyc))
    (i32.shr_s (i32.mul (local.get $i) (local.get $b)) (i32.const 16)))

  (func $bios_arctan_swi
    ${w(0, `(i32.extend16_s (call $bios_atan ${r(0)}))`)}
    ${w(1, `(global.get $atan_a)`)}
    ${w(3, `(global.get $atan_b)`)})

  ;; _ArcTan2 (r1 <- a from the inner ArcTan when one runs)
  (func $bios_arctan2 (param $x i32) (param $y i32) (result i32)
    (if (i32.eqz (local.get $y))
      (then (global.set $biosStall (i32.const 11))
            (return (if (result i32) (i32.ge_s (local.get $x) (i32.const 0)) (then (i32.const 0)) (else (i32.const 0x8000))))))
    (if (i32.eqz (local.get $x))
      (then (global.set $biosStall (i32.const 11))
            (return (if (result i32) (i32.ge_s (local.get $y) (i32.const 0)) (then (i32.const 0x4000)) (else (i32.const 0xC000))))))
    (if (i32.ge_s (local.get $y) (i32.const 0))
      (then
        (if (i32.ge_s (local.get $x) (i32.const 0))
          (then (if (i32.ge_s (local.get $x) (local.get $y))
                  (then (return (call $atan2_leg (i32.div_s (i32.shl (local.get $y) (i32.const 14)) (local.get $x)) (i32.const 0))))))
          (else (if (i32.ge_s (i32.sub (i32.const 0) (local.get $x)) (local.get $y))
                  (then (return (call $atan2_leg (i32.div_s (i32.shl (local.get $y) (i32.const 14)) (local.get $x)) (i32.const 0x8000)))))))
        (return (i32.sub (i32.const 0x4000) (call $atan2_leg (i32.div_s (i32.shl (local.get $x) (i32.const 14)) (local.get $y)) (i32.const 0))))))
    (if (i32.le_s (local.get $x) (i32.const 0))
      (then (if (i32.gt_s (i32.sub (i32.const 0) (local.get $x)) (i32.sub (i32.const 0) (local.get $y)))
              (then (return (call $atan2_leg (i32.div_s (i32.shl (local.get $y) (i32.const 14)) (local.get $x)) (i32.const 0x8000))))))
      (else (if (i32.ge_s (local.get $x) (i32.sub (i32.const 0) (local.get $y)))
              (then (return (call $atan2_leg (i32.div_s (i32.shl (local.get $y) (i32.const 14)) (local.get $x)) (i32.const 0x10000)))))))
    (i32.sub (i32.const 0xC000) (call $atan2_leg (i32.div_s (i32.shl (local.get $x) (i32.const 14)) (local.get $y)) (i32.const 0))))

  ;; one _ArcTan call inside _ArcTan2: int16 result + offset, r1 <- a
  (func $atan2_leg (param $i i32) (param $add i32) (result i32)
    (local $res i32)
    (local.set $res (i32.extend16_s (call $bios_atan (local.get $i))))
    ${w(1, `(global.get $atan_a)`)}
    (i32.add (local.get $res) (local.get $add)))

  ;; _RegisterRamReset
  (func $register_ram_reset
    (local $reg i32) (local $i i32)
    (local.set $reg ${r(0)})
    (call $st16 (i32.const 0x04000000) (i32.const 0x80) (i32.const 0))
    (if (i32.and (local.get $reg) (i32.const 1)) (then (memory.fill (i32.const ${L.EWRAM}) (i32.const 0) (i32.const 0x40000))))
    (if (i32.and (local.get $reg) (i32.const 2)) (then (memory.fill (i32.const ${L.IWRAM}) (i32.const 0) (i32.const 0x7E00))))
    (if (i32.and (local.get $reg) (i32.const 4)) (then (memory.fill (i32.const ${L.PAL}) (i32.const 0) (i32.const 0x400))))
    (if (i32.and (local.get $reg) (i32.const 8)) (then (memory.fill (i32.const ${L.VRAM}) (i32.const 0) (i32.const 0x18000))))
    (if (i32.and (local.get $reg) (i32.const 16)) (then (memory.fill (i32.const ${L.OAM}) (i32.const 0) (i32.const 0x400))))
    (if (i32.and (local.get $reg) (i32.const 32))
      (then
        (call $st16 (i32.const 0x04000128) (i32.const 0) (i32.const 0))
        (call $st16 (i32.const 0x04000134) (i32.const 0x8000) (i32.const 0))
        (call $st16 (i32.const 0x0400012A) (i32.const 0) (i32.const 0))
        (call $st16 (i32.const 0x04000140) (i32.const 0) (i32.const 0))
        (call $st32 (i32.const 0x04000150) (i32.const 0) (i32.const 0))
        (call $st32 (i32.const 0x04000154) (i32.const 0) (i32.const 0))))
    (if (i32.and (local.get $reg) (i32.const 64))
      (then
` + st16s([0x60, 0x62, 0x64, 0x68, 0x6C, 0x70, 0x72, 0x74, 0x78, 0x7C, 0x80, 0x82, 0x84].map((o) => [o, 0])) + `        (call $st16 (i32.const 0x04000088) (i32.const 0x200) (i32.const 0))
        (memory.fill (i32.const ${L.WAVE}) (i32.const 0) (i32.const 32))))
    (if (i32.and (local.get $reg) (i32.const 128))
      (then
` + st16s([[0x04, 0], [0x06, 0], [0x08, 0], [0x0A, 0], [0x0C, 0], [0x0E, 0]]
    .concat(range(8).map((k) => [0x10 + 2 * k, 0]))
    .concat([[0x20, 0x100], [0x22, 0], [0x24, 0], [0x26, 0x100]])) + `        (call $st32 (i32.const 0x04000028) (i32.const 0) (i32.const 0))
        (call $st32 (i32.const 0x0400002C) (i32.const 0) (i32.const 0))
` + st16s([[0x30, 0x100], [0x32, 0], [0x34, 0], [0x36, 0x100]]) + `        (call $st32 (i32.const 0x04000038) (i32.const 0) (i32.const 0))
        (call $st32 (i32.const 0x0400003C) (i32.const 0) (i32.const 0))
` + st16s([[0x40, 0], [0x42, 0], [0x44, 0], [0x46, 0], [0x48, 0], [0x4A, 0], [0x4C, 0], [0x50, 0], [0x52, 0], [0x54, 0]]
    .concat(range(4).flatMap((ch) => [0, 2, 4, 6, 8, 10].map((k) => [0xB0 + 12 * ch + k, 0])))
    .concat(range(8).map((k) => [0x100 + 2 * k, 0]))
    .concat([[0x200, 0], [0x202, 0xFFFF], [0x204, 0], [0x208, 0]])) + `))
    ;; (the renderer reset for 0x9C re-reads the registers; our renderer
    ;; reads the I/O page live, so there is nothing to redo)
    )

  ;; ---- decompressors (bios.c) -------------------------------------------
  ;; _unLz77: the only one that times itself (&cycles), into biosStall.
  (func $bios_lz77 (param $width i32)
    (local $src i32) (local $dst i32) (local $rem i32) (local $bh i32) (local $br i32)
    (local $disp i32) (local $bytes i32) (local $byte i32) (local $hw i32) (local $block i32) (local $savecc i32)
    (local.set $savecc (global.get $cc))
    (global.set $cc (i32.const 20))
    (local.set $src ${r(0)})
    (local.set $dst ${r(1)})
    (local.set $rem (i32.shr_u (i32.and (call $ld32 (local.get $src) (i32.const 1)) (i32.const 0xFFFFFF00)) (i32.const 8)))
    (local.set $src (i32.add (local.get $src) (i32.const 4)))
    (block $d (loop $l
      (br_if $d (i32.le_s (local.get $rem) (i32.const 0)))
      (global.set $cc (i32.add (global.get $cc) (i32.const 14)))
      (if (local.get $br)
        (then
          (global.set $cc (i32.add (global.get $cc) (i32.const 18)))
          (if (i32.and (local.get $bh) (i32.const 0x80))
            (then
              (local.set $block (i32.or (call $ld8 (i32.add (local.get $src) (i32.const 1)) (i32.const 1))
                                        (i32.shl (call $ld8 (local.get $src) (i32.const 1)) (i32.const 8))))
              (local.set $src (i32.add (local.get $src) (i32.const 2)))
              (local.set $disp (i32.sub (i32.sub (local.get $dst) (i32.and (local.get $block) (i32.const 0xFFF))) (i32.const 1)))
              (local.set $bytes (i32.add (i32.shr_u (local.get $block) (i32.const 12)) (i32.const 3)))
              (block $bd (loop $bl
                (br_if $bd (i32.eqz (local.get $bytes)))
                (local.set $bytes (i32.sub (local.get $bytes) (i32.const 1)))
                (global.set $cc (i32.add (global.get $cc) (i32.const 10)))
                (if (local.get $rem) (then (local.set $rem (i32.sub (local.get $rem) (i32.const 1)))))
                (if (i32.eq (local.get $width) (i32.const 2))
                  (then
                    (local.set $byte (i32.extend16_s (call $ld16 (i32.and (local.get $disp) (i32.const -2)) (i32.const 1))))
                    (local.set $byte (i32.shr_s (local.get $byte) (i32.shl (i32.and (local.get $disp) (i32.const 1)) (i32.const 3))))
                    (if (i32.and (local.get $dst) (i32.const 1))
                      (then (local.set $hw (i32.or (local.get $hw) (i32.shl (local.get $byte) (i32.const 8))))
                            (call $st16 (i32.xor (local.get $dst) (i32.const 1)) (local.get $hw) (i32.const 1)))
                      (else (local.set $hw (i32.and (local.get $byte) (i32.const 0xFF)))))
                    (global.set $cc (i32.add (global.get $cc) (i32.const 4))))
                  (else
                    (call $st8 (local.get $dst) (call $ld8 (local.get $disp) (i32.const 1)) (i32.const 1))))
                (local.set $disp (i32.add (local.get $disp) (i32.const 1)))
                (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
                (br $bl))))
            (else
              (local.set $byte (call $ld8 (local.get $src) (i32.const 1)))
              (local.set $src (i32.add (local.get $src) (i32.const 1)))
              (if (i32.eq (local.get $width) (i32.const 2))
                (then (if (i32.and (local.get $dst) (i32.const 1))
                        (then (local.set $hw (i32.or (local.get $hw) (i32.shl (local.get $byte) (i32.const 8))))
                              (call $st16 (i32.xor (local.get $dst) (i32.const 1)) (local.get $hw) (i32.const 1)))
                        (else (local.set $hw (local.get $byte)))))
                (else (call $st8 (local.get $dst) (local.get $byte) (i32.const 1))))
              (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
              (local.set $rem (i32.sub (local.get $rem) (i32.const 1)))))
          (local.set $bh (i32.shl (local.get $bh) (i32.const 1)))
          (local.set $br (i32.sub (local.get $br) (i32.const 1))))
        (else
          (local.set $bh (call $ld8 (local.get $src) (i32.const 1)))
          (local.set $src (i32.add (local.get $src) (i32.const 1)))
          (local.set $br (i32.const 8))))
      (br $l)))
    ${w(0, `(local.get $src)`)} ${w(1, `(local.get $dst)`)} ${w(3, `(i32.const 0)`)}
    (global.set $biosStall (global.get $cc))
    (global.set $cc (local.get $savecc)))

  ;; _unHuffman
  (func $bios_huffman
    (local $src i32) (local $dst i32) (local $hdr i32) (local $rem i32) (local $bits i32) (local $ts i32)
    (local $block i32) (local $tree i32) (local $np i32) (local $node i32) (local $br i32) (local $rb i32)
    (local $seen i32) (local $bs i32) (local $next i32)
    (local.set $src (i32.and ${r(0)} (i32.const -4)))
    (local.set $dst ${r(1)})
    (local.set $hdr (call $ld32 (local.get $src) (i32.const 0)))
    (local.set $rem (i32.shr_u (local.get $hdr) (i32.const 8)))
    (local.set $bits (i32.and (local.get $hdr) (i32.const 15)))
    (if (i32.eqz (local.get $bits)) (then (local.set $bits (i32.const 8))))
    (if (i32.or (i32.ne (i32.rem_u (i32.const 32) (local.get $bits)) (i32.const 0)) (i32.eq (local.get $bits) (i32.const 1)))
      (then (return)))
    (local.set $ts (i32.add (i32.shl (call $ld8 (i32.add (local.get $src) (i32.const 4)) (i32.const 0)) (i32.const 1)) (i32.const 1)))
    (local.set $tree (i32.add (local.get $src) (i32.const 5)))
    (local.set $src (i32.add (i32.add (local.get $src) (i32.const 5)) (local.get $ts)))
    (local.set $np (local.get $tree))
    (local.set $node (call $ld8 (local.get $np) (i32.const 0)))
    (block $d (loop $l
      (br_if $d (i32.le_s (local.get $rem) (i32.const 0)))
      (local.set $bs (call $ld32 (local.get $src) (i32.const 0)))
      (local.set $src (i32.add (local.get $src) (i32.const 4)))
      (local.set $br (i32.const 32))
      (block $bd (loop $bl
        (br_if $bd (i32.or (i32.le_s (local.get $br) (i32.const 0)) (i32.le_s (local.get $rem) (i32.const 0))))
        (local.set $next (i32.add (i32.add (i32.and (local.get $np) (i32.const -2))
                                           (i32.shl (i32.and (local.get $node) (i32.const 0x3F)) (i32.const 1))) (i32.const 2)))
        (block $cont
          (block $leaf
            (if (i32.lt_s (local.get $bs) (i32.const 0))
              (then (if (i32.and (local.get $node) (i32.const 0x40))
                      (then (local.set $rb (call $ld8 (i32.add (local.get $next) (i32.const 1)) (i32.const 0))) (br $leaf))
                      (else (local.set $np (i32.add (local.get $next) (i32.const 1)))
                            (local.set $node (call $ld8 (local.get $np) (i32.const 0))) (br $cont))))
              (else (if (i32.and (local.get $node) (i32.const 0x80))
                      (then (local.set $rb (call $ld8 (local.get $next) (i32.const 0))) (br $leaf))
                      (else (local.set $np (local.get $next))
                            (local.set $node (call $ld8 (local.get $np) (i32.const 0))) (br $cont))))))
          (local.set $block (i32.or (local.get $block)
            (i32.shl (i32.and (local.get $rb) (i32.sub (i32.shl (i32.const 1) (local.get $bits)) (i32.const 1))) (local.get $seen))))
          (local.set $seen (i32.add (local.get $seen) (local.get $bits)))
          (local.set $np (local.get $tree))
          (local.set $node (call $ld8 (local.get $np) (i32.const 0)))
          (if (i32.eq (local.get $seen) (i32.const 32))
            (then (local.set $seen (i32.const 0))
                  (call $st32 (local.get $dst) (local.get $block) (i32.const 0))
                  (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
                  (local.set $rem (i32.sub (local.get $rem) (i32.const 4)))
                  (local.set $block (i32.const 0)))))
        (local.set $br (i32.sub (local.get $br) (i32.const 1)))
        (local.set $bs (i32.shl (local.get $bs) (i32.const 1)))
        (br $bl)))
      (br $l)))
    ${w(0, `(local.get $src)`)} ${w(1, `(local.get $dst)`)})

  ;; _unRl
  (func $bios_rl (param $width i32)
    (local $src i32) (local $dst i32) (local $rem i32) (local $pad i32) (local $bh i32) (local $block i32) (local $hw i32) (local $byte i32)
    (local.set $src ${r(0)})
    (local.set $rem (i32.shr_u (i32.and (call $ld32 (i32.and (local.get $src) (i32.const -4)) (i32.const 0)) (i32.const 0xFFFFFF00)) (i32.const 8)))
    (local.set $pad (i32.and (i32.sub (i32.const 4) (local.get $rem)) (i32.const 3)))
    (local.set $src (i32.add (local.get $src) (i32.const 4)))
    (local.set $dst ${r(1)})
    (block $d (loop $l
      (br_if $d (i32.le_s (local.get $rem) (i32.const 0)))
      (local.set $bh (call $ld8 (local.get $src) (i32.const 0)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (if (i32.and (local.get $bh) (i32.const 0x80))
        (then
          (local.set $bh (i32.add (i32.and (local.get $bh) (i32.const 0x7F)) (i32.const 3)))
          (local.set $block (call $ld8 (local.get $src) (i32.const 0)))
          (local.set $src (i32.add (local.get $src) (i32.const 1)))
          (block $cd (loop $cl
            (br_if $cd (i32.or (i32.eqz (local.get $bh)) (i32.eqz (local.get $rem))))
            (local.set $bh (i32.sub (local.get $bh) (i32.const 1)))
            (local.set $rem (i32.sub (local.get $rem) (i32.const 1)))
            (if (i32.eq (local.get $width) (i32.const 2))
              (then (if (i32.and (local.get $dst) (i32.const 1))
                      (then (local.set $hw (i32.or (local.get $hw) (i32.shl (local.get $block) (i32.const 8))))
                            (call $st16 (i32.xor (local.get $dst) (i32.const 1)) (local.get $hw) (i32.const 0)))
                      (else (local.set $hw (local.get $block)))))
              (else (call $st8 (local.get $dst) (local.get $block) (i32.const 0))))
            (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
            (br $cl))))
        (else
          (local.set $bh (i32.add (local.get $bh) (i32.const 1)))
          (block $ud (loop $ul
            (br_if $ud (i32.or (i32.eqz (local.get $bh)) (i32.eqz (local.get $rem))))
            (local.set $bh (i32.sub (local.get $bh) (i32.const 1)))
            (local.set $rem (i32.sub (local.get $rem) (i32.const 1)))
            (local.set $byte (call $ld8 (local.get $src) (i32.const 0)))
            (local.set $src (i32.add (local.get $src) (i32.const 1)))
            (if (i32.eq (local.get $width) (i32.const 2))
              (then (if (i32.and (local.get $dst) (i32.const 1))
                      (then (local.set $hw (i32.or (local.get $hw) (i32.shl (local.get $byte) (i32.const 8))))
                            (call $st16 (i32.xor (local.get $dst) (i32.const 1)) (local.get $hw) (i32.const 0)))
                      (else (local.set $hw (local.get $byte)))))
              (else (call $st8 (local.get $dst) (local.get $byte) (i32.const 0))))
            (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
            (br $ul)))))
      (br $l)))
    (if (i32.eq (local.get $width) (i32.const 2))
      (then
        (if (i32.and (local.get $dst) (i32.const 1))
          (then (local.set $pad (i32.sub (local.get $pad) (i32.const 1))) (local.set $dst (i32.add (local.get $dst) (i32.const 1)))))
        (block $pd (loop $pl
          (br_if $pd (i32.le_s (local.get $pad) (i32.const 0)))
          (call $st16 (local.get $dst) (i32.const 0) (i32.const 0))
          (local.set $pad (i32.sub (local.get $pad) (i32.const 2)))
          (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
          (br $pl))))
      (else
        (block $pd2 (loop $pl2
          (br_if $pd2 (i32.eqz (local.get $pad)))
          (local.set $pad (i32.sub (local.get $pad) (i32.const 1)))
          (call $st8 (local.get $dst) (i32.const 0) (i32.const 0))
          (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
          (br $pl2)))))
    ${w(0, `(local.get $src)`)} ${w(1, `(local.get $dst)`)})

  ;; _unFilter
  (func $bios_unfilter (param $inw i32) (param $outw i32)
    (local $src i32) (local $dst i32) (local $rem i32) (local $hw i32) (local $old i32) (local $new i32)
    (local.set $src (i32.and ${r(0)} (i32.const -4)))
    (local.set $dst ${r(1)})
    (local.set $rem (i32.shr_u (call $ld32 (local.get $src) (i32.const 0)) (i32.const 8)))
    (local.set $src (i32.add (local.get $src) (i32.const 4)))
    (block $d (loop $l
      (br_if $d (i32.le_s (local.get $rem) (i32.const 0)))
      (local.set $new (if (result i32) (i32.eq (local.get $inw) (i32.const 1))
        (then (call $ld8 (local.get $src) (i32.const 0))) (else (call $ld16 (local.get $src) (i32.const 0)))))
      (local.set $new (i32.and (i32.add (local.get $new) (local.get $old)) (i32.const 0xFFFF)))
      (if (i32.gt_s (local.get $outw) (local.get $inw))
        (then
          (local.set $hw (i32.and (i32.or (i32.shr_u (local.get $hw) (i32.const 8)) (i32.shl (local.get $new) (i32.const 8))) (i32.const 0xFFFF)))
          (if (i32.and (local.get $src) (i32.const 1))
            (then (call $st16 (local.get $dst) (local.get $hw) (i32.const 0))
                  (local.set $dst (i32.add (local.get $dst) (local.get $outw)))
                  (local.set $rem (i32.sub (local.get $rem) (local.get $outw))))))
        (else (if (i32.eq (local.get $outw) (i32.const 1))
          (then (call $st8 (local.get $dst) (local.get $new) (i32.const 0))
                (local.set $dst (i32.add (local.get $dst) (local.get $outw)))
                (local.set $rem (i32.sub (local.get $rem) (local.get $outw))))
          (else (call $st16 (local.get $dst) (local.get $new) (i32.const 0))
                (local.set $dst (i32.add (local.get $dst) (local.get $outw)))
                (local.set $rem (i32.sub (local.get $rem) (local.get $outw)))))))
      (local.set $old (local.get $new))
      (local.set $src (i32.add (local.get $src) (local.get $inw)))
      (br $l)))
    ${w(0, `(local.get $src)`)} ${w(1, `(local.get $dst)`)})

  ;; _unBitPack
  (func $bios_bitunpack
    (local $src i32) (local $dst i32) (local $info i32) (local $len i32) (local $sw i32) (local $dw i32) (local $bias i32)
    (local $in i32) (local $out i32) (local $rem i32) (local $eaten i32) (local $sc i32)
    (local.set $src ${r(0)})
    (local.set $dst ${r(1)})
    (local.set $info ${r(2)})
    (local.set $len (call $ld16 (local.get $info) (i32.const 0)))
    (local.set $sw (call $ld8 (i32.add (local.get $info) (i32.const 2)) (i32.const 0)))
    (local.set $dw (call $ld8 (i32.add (local.get $info) (i32.const 3)) (i32.const 0)))
    (if (i32.eqz (i32.or (i32.or (i32.eq (local.get $sw) (i32.const 1)) (i32.eq (local.get $sw) (i32.const 2)))
                         (i32.or (i32.eq (local.get $sw) (i32.const 4)) (i32.eq (local.get $sw) (i32.const 8)))))
      (then (return)))
    (if (i32.eqz (i32.or (i32.or (i32.or (i32.eq (local.get $dw) (i32.const 1)) (i32.eq (local.get $dw) (i32.const 2)))
                                 (i32.or (i32.eq (local.get $dw) (i32.const 4)) (i32.eq (local.get $dw) (i32.const 8))))
                         (i32.or (i32.eq (local.get $dw) (i32.const 16)) (i32.eq (local.get $dw) (i32.const 32)))))
      (then (return)))
    (local.set $bias (call $ld32 (i32.add (local.get $info) (i32.const 4)) (i32.const 0)))
    (block $d (loop $l
      (br_if $d (i32.and (i32.eqz (local.get $len)) (i32.eqz (local.get $rem))))
      (if (i32.eqz (local.get $rem))
        (then (local.set $in (call $ld8 (local.get $src) (i32.const 0)))
              (local.set $rem (i32.const 8))
              (local.set $src (i32.add (local.get $src) (i32.const 1)))
              (local.set $len (i32.sub (local.get $len) (i32.const 1)))))
      (local.set $sc (i32.and (local.get $in) (i32.sub (i32.shl (i32.const 1) (local.get $sw)) (i32.const 1))))
      (local.set $in (i32.and (i32.shr_u (local.get $in) (local.get $sw)) (i32.const 0xFF)))
      (if (i32.or (i32.ne (local.get $sc) (i32.const 0)) (i32.lt_s (local.get $bias) (i32.const 0)))
        (then (local.set $sc (i32.add (local.get $sc) (i32.and (local.get $bias) (i32.const 0x7FFFFFFF))))))
      (local.set $rem (i32.sub (local.get $rem) (local.get $sw)))
      (local.set $out (i32.or (local.get $out) (i32.shl (local.get $sc) (local.get $eaten))))
      (local.set $eaten (i32.add (local.get $eaten) (local.get $dw)))
      (if (i32.eq (local.get $eaten) (i32.const 32))
        (then (call $st32 (local.get $dst) (local.get $out) (i32.const 0))
              (local.set $eaten (i32.const 0))
              (local.set $out (i32.const 0))
              (local.set $dst (i32.add (local.get $dst) (i32.const 4)))))
      (br $l)))
    ${w(0, `(local.get $src)`)} ${w(1, `(local.get $dst)`)})

  ;; ---- affine BIOS calls ------------------------------------------------
  (func $bsin (param $t i32) (result f32)
    (f32.load (i32.add (i32.const ${SINTAB}) (i32.shl (i32.and (i32.shr_u (local.get $t) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
  (func $bcos (param $t i32) (result f32)
    (f32.load (i32.add (i32.const ${SINTAB + 1024}) (i32.shl (i32.and (i32.shr_u (local.get $t) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
  (func $f2i (param $v f32) (result i32) (i32.trunc_sat_f32_s (local.get $v)))

  (func $bios_bgaffine   ;; _BgAffineSet
    (local $i i32) (local $off i32) (local $dst i32) (local $th i32)
    (local $ox f32) (local $oy f32) (local $cx f32) (local $cy f32) (local $sx f32) (local $sy f32)
    (local $a f32) (local $b f32) (local $c f32) (local $d f32) (local $rx f32) (local $ry f32)
    (local.set $i ${r(2)})
    (local.set $off ${r(0)})
    (local.set $dst ${r(1)})
    (block $done (loop $l
      (br_if $done (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (local.set $ox (f32.div (f32.convert_i32_s (call $ld32 (local.get $off) (i32.const 0))) (f32.const 256)))
      (local.set $oy (f32.div (f32.convert_i32_s (call $ld32 (i32.add (local.get $off) (i32.const 4)) (i32.const 0))) (f32.const 256)))
      (local.set $cx (f32.convert_i32_s (i32.extend16_s (call $ld16 (i32.add (local.get $off) (i32.const 8)) (i32.const 0)))))
      (local.set $cy (f32.convert_i32_s (i32.extend16_s (call $ld16 (i32.add (local.get $off) (i32.const 10)) (i32.const 0)))))
      (local.set $sx (f32.div (f32.convert_i32_s (i32.extend16_s (call $ld16 (i32.add (local.get $off) (i32.const 12)) (i32.const 0)))) (f32.const 256)))
      (local.set $sy (f32.div (f32.convert_i32_s (i32.extend16_s (call $ld16 (i32.add (local.get $off) (i32.const 14)) (i32.const 0)))) (f32.const 256)))
      (local.set $th (call $ld16 (i32.add (local.get $off) (i32.const 16)) (i32.const 0)))
      (local.set $off (i32.add (local.get $off) (i32.const 20)))
      (local.set $a (call $bcos (local.get $th))) (local.set $d (local.get $a))
      (local.set $b (call $bsin (local.get $th))) (local.set $c (local.get $b))
      (local.set $a (f32.mul (local.get $a) (local.get $sx)))
      (local.set $b (f32.mul (local.get $b) (f32.neg (local.get $sx))))
      (local.set $c (f32.mul (local.get $c) (local.get $sy)))
      (local.set $d (f32.mul (local.get $d) (local.get $sy)))
      (local.set $rx (f32.sub (local.get $ox) (f32.add (f32.mul (local.get $a) (local.get $cx)) (f32.mul (local.get $b) (local.get $cy)))))
      (local.set $ry (f32.sub (local.get $oy) (f32.add (f32.mul (local.get $c) (local.get $cx)) (f32.mul (local.get $d) (local.get $cy)))))
      (call $st16 (local.get $dst) (call $f2i (f32.mul (local.get $a) (f32.const 256))) (i32.const 0))
      (call $st16 (i32.add (local.get $dst) (i32.const 2)) (call $f2i (f32.mul (local.get $b) (f32.const 256))) (i32.const 0))
      (call $st16 (i32.add (local.get $dst) (i32.const 4)) (call $f2i (f32.mul (local.get $c) (f32.const 256))) (i32.const 0))
      (call $st16 (i32.add (local.get $dst) (i32.const 6)) (call $f2i (f32.mul (local.get $d) (f32.const 256))) (i32.const 0))
      (call $st32 (i32.add (local.get $dst) (i32.const 8)) (call $f2i (f32.mul (local.get $rx) (f32.const 256))) (i32.const 0))
      (call $st32 (i32.add (local.get $dst) (i32.const 12)) (call $f2i (f32.mul (local.get $ry) (f32.const 256))) (i32.const 0))
      (local.set $dst (i32.add (local.get $dst) (i32.const 16)))
      (br $l))))

  (func $bios_objaffine   ;; _ObjAffineSet
    (local $i i32) (local $off i32) (local $dst i32) (local $diff i32) (local $th i32)
    (local $sx f32) (local $sy f32) (local $a f32) (local $b f32) (local $c f32) (local $d f32)
    (local.set $i ${r(2)})
    (local.set $off ${r(0)})
    (local.set $dst ${r(1)})
    (local.set $diff ${r(3)})
    (block $done (loop $l
      (br_if $done (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (local.set $sx (f32.div (f32.convert_i32_s (i32.extend16_s (call $ld16 (local.get $off) (i32.const 0)))) (f32.const 256)))
      (local.set $sy (f32.div (f32.convert_i32_s (i32.extend16_s (call $ld16 (i32.add (local.get $off) (i32.const 2)) (i32.const 0)))) (f32.const 256)))
      (local.set $th (call $ld16 (i32.add (local.get $off) (i32.const 4)) (i32.const 0)))
      (local.set $off (i32.add (local.get $off) (i32.const 8)))
      (local.set $a (call $bcos (local.get $th))) (local.set $d (local.get $a))
      (local.set $b (call $bsin (local.get $th))) (local.set $c (local.get $b))
      (local.set $a (f32.mul (local.get $a) (local.get $sx)))
      (local.set $b (f32.mul (local.get $b) (f32.neg (local.get $sx))))
      (local.set $c (f32.mul (local.get $c) (local.get $sy)))
      (local.set $d (f32.mul (local.get $d) (local.get $sy)))
      (call $st16 (local.get $dst) (call $f2i (f32.mul (local.get $a) (f32.const 256))) (i32.const 0))
      (call $st16 (i32.add (local.get $dst) (local.get $diff)) (call $f2i (f32.mul (local.get $b) (f32.const 256))) (i32.const 0))
      (call $st16 (i32.add (local.get $dst) (i32.shl (local.get $diff) (i32.const 1))) (call $f2i (f32.mul (local.get $c) (f32.const 256))) (i32.const 0))
      (call $st16 (i32.add (local.get $dst) (i32.mul (local.get $diff) (i32.const 3))) (call $f2i (f32.mul (local.get $d) (f32.const 256))) (i32.const 0))
      (local.set $dst (i32.add (local.get $dst) (i32.shl (local.get $diff) (i32.const 2))))
      (br $l))))
`;
}

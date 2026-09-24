// Game Boy / Game Boy Color whole-ROM WAT emitter: one dispatch arm per ROM
// offset, sharded br_table dispatch, a pc -> arm table built at init from a
// packed list, the gambatte-derived machine model (hw-gbc.js) and the CGB or
// DMG PPU.
//
// Ported from sms-wat src/emit_gb.py (the "NEW" machine model it builds for
// every CGB and DMG cart). The WAT this produces is identical to the Python
// emitter's for every verified cart; that differential is the port's gate.
import { lower } from "./lower.js";
import * as H from "./hw-gb.js";
import * as P from "./hw-gbc.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { IOREG, OAM, FB_W, FB_H, GBFB } = H;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cycle costs come from romdev's EXTRACTED table (generated from gambatte by
// scripts/generate-gb-cycle-tables.mjs), never hand-authored here. A flat
// per-instruction cost was the frame-phase bug on SMS and the boot stall on
// Genesis.
const CYC = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "gb-cycles.json"), "utf8"));
const CYCLES = CYC.base, CB_CYCLES = CYC.cb;

/** ROM image base in linear memory. */
export const ROMIMG = H.ROM;
// Liveness probe, mirrored into LINEAR MEMORY because a host cannot see wasm
// GLOBALS. 0x20000 is a clean hole: IOREG ends at 0x10000, WRAMX banks end at
// 0x20000, GBFB starts at 0x30000, the ROM image at 0x40000.
export const PROBE = 0x20000;
/** Arms per dispatch shard. */
const SH = 1024;

/**
 * Probe block field map (byte offsets from PROBE), for hosts and the verify
 * op. u32 little-endian unless noted.
 */
export const PROBE_FIELDS = {
  frames: 0, steps: 4, trapped: 8, trappc: 12, pc: 16,
  oamdmaCount: 20, oamdmaLastPage: 24,
  trapRombank: 28, trapCurpc: 32, trapPc: 36, trapFrame: 40, trapSteps: 44,
  trapSp: 48, trapBanklo: 52, trapBankhi: 56, trapPcRingCursor: 60, trapBankRingCursor: 64,
  hdmaStarts: 72, a: 80, sp: 112, rombank: 116, ime: 120,
  pcRingCursor: 124, hitCounters: 128, divcnt: 172, div: 176, speed: 180, svbk: 184, vbk: 188, halted: 192, line: 196,
  irqCounts: 200, dupeFrames: 224, templateRuns: 228, ramInterpRuns: 232,
  writeCount: 1008, watchMatches: 1016, watchRing: 1024, rtcRegs: 3840,
  lcdToggleCount: 0xDFC, lcdToggleLog: 0xE00, pcRing: 4096,
};

/** The CPU address a ROM file offset is executed at (bank 0 at $0000, others at $4000). */
export function cpuAddr(off) {
  return off < 0x4000 ? off : 0x4000 + (off % 0x4000);
}

/**
 * Linear-memory layout for a ROM of `romLen` bytes. EVERYTHING ABOVE THE ROM
 * IMAGE IS PLACED AFTER IT, BY ITS ACTUAL SIZE: fixed constants sized for a
 * 64KB cart put a 512KB cart's framebuffer inside its own ROM image
 * and the title-screen copy loop read back pixels.
 * @param {number} romLen
 */
export function gbLayout(romLen) {
  const romEnd = ROMIMG + Math.max(0x10000, romLen);
  const FB = (romEnd + 0xFFFF) & ~0xFFFF;          // XRGB8888 framebuffer, page-aligned
  const ABI = FB + FB_W * FB_H * 4 + 0x1000;
  const PCTAB = ABI + 0x1000;
  // The pc index space is the WHOLE ROM, not the 16-bit CPU map: arms are
  // keyed by ROM offset, and on a banked cart $4000-$7FFF maps to a
  // different offset per bank.
  const PCSPAN = Math.max(0x10000, romLen);
  const PACKED = PCTAB + PCSPAN * 4 + 0x1000;
  // A layout bug is silent - it reads as corrupt graphics, not as an error -
  // so the regions are checked against each other at BUILD time, every build.
  const regs = [["PROBE", PROBE, PROBE + 4096 + 2048 * 16], ["ROM", ROMIMG, romEnd],
    ["FB", FB, ABI], ["PCTAB", PCTAB, PCTAB + PCSPAN * 4]];
  const others = [["ROM", ROMIMG, romEnd], ["FB", FB, ABI],
    ["PCTAB", PCTAB, PCTAB + PCSPAN * 4], ["VRAM/IO", 0, 0x10000]];
  for (const [n, lo, hi] of regs) {
    for (const [n2, lo2, hi2] of others) {
      if (n !== n2 && lo < hi2 && lo2 < hi) {
        throw new Error(`gb LAYOUT OVERLAP: ${n} [0x${lo.toString(16)},0x${hi.toString(16)}) overlaps ${n2} [0x${lo2.toString(16)},0x${hi2.toString(16)}) for a ${romLen}-byte ROM. This corrupts graphics silently - refusing to build.`);
      }
    }
  }
  return { romEnd, FB, ABI, PCTAB, PCSPAN, PACKED, INPUT: ABI + 0x100, TIME: ABI + 0x180 };
}

/**
 * The options.traceEntries ring stores for the instruction about to run: the
 * registers it starts from, as gambatte's dispatch hook records them.
 * @param {{cursor:number, offset:number, entries:number}} big
 */
function bigRingWat(big) {
  const pair = (hi, lo) => `(i32.or (i32.shl (global.get $${hi}) (i32.const 8)) (global.get $${lo}))`;
  return `
    (local.set $tr (i32.add (i32.const ${big.offset})
      (i32.shl (i32.and (i32.load (i32.const ${big.cursor})) (i32.const ${big.entries - 1})) (i32.const 5))))
    (i32.store (i32.const ${big.cursor}) (i32.add (i32.load (i32.const ${big.cursor})) (i32.const 1)))
    (i32.store (local.get $tr) (global.get $pc))
    (i32.store offset=4 (local.get $tr) (global.get $rombank))
    (i32.store offset=8 (local.get $tr) (global.get $sp))
    (i32.store offset=12 (local.get $tr) ${pair("h", "l")})
    (i32.store offset=16 (local.get $tr) ${pair("b", "c")})
    (i32.store offset=20 (local.get $tr) ${pair("d", "e")})
    (i32.store offset=24 (local.get $tr) ${pair("a", "f")})`;
}

/** RAM-code provenance table base and the page count, given the arm count. */
export function gbOriginAndPages(L, nArms) {
  const ORIGIN = (L.PACKED + nArms * 8 + 0x1000 + 0xFFF) & ~0xFFF;
  const pages = Math.floor((ORIGIN + 0x8080 * 4 + 0xFFFF) / 65536) + 1;
  return { ORIGIN, pages };
}

/** options.traceEntries: the whole-frame ring's entry size and maximum length. */
export const BIGRING_STRIDE = 32;
export const BIGRING_MAX = 65536;

/**
 * options.traceEntries: where the whole-frame instruction ring goes (above
 * everything gbOriginAndPages placed, so the default map is untouched) and
 * the page count with it. A u32 count of entries written at `cursor`, then
 * the entries (32 bytes): {pc, rombank, sp, hl, bc, de, a<<8|f}, written for
 * EVERY dispatched instruction, before the RAM interpreter takes the ones it
 * runs (the default ring records compiled arms only, so an HRAM routine such
 * as an OAM DMA wait loop is missing from it).
 * @param {number} romLen
 * @param {number} nArms  arm count (one per ROM offset)
 * @param {number} entries  a power of two, 1024 to BIGRING_MAX
 */
export function gbBigRing(romLen, nArms, entries) {
  if (!Number.isInteger(entries) || entries < 1024 || entries > BIGRING_MAX || (entries & (entries - 1))) {
    throw new Error(`gb recompile: options.traceEntries must be a power of two from 1024 to ${BIGRING_MAX}, got ${entries}`);
  }
  const { pages } = gbOriginAndPages(gbLayout(romLen), nArms);
  const cursor = pages * 65536;
  const offset = cursor + 256;
  return { cursor, offset, entries, stride: BIGRING_STRIDE, pages: pages + Math.ceil((256 + entries * BIGRING_STRIDE) / 65536) };
}

const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, "0");
const watBytes = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += "\\" + (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
};

// gambatte's table carries the TAKEN cost of a conditional; not taken is
// cheaper by this much (jr/jp cc 4, call/ret cc 12), refunded on the
// fall-through path.
const NOT_TAKEN = new Map();
for (const o of [0x20, 0x28, 0x30, 0x38, 0xC2, 0xCA, 0xD2, 0xDA]) NOT_TAKEN.set(o, 4);
for (const o of [0xC4, 0xCC, 0xD4, 0xDC, 0xC0, 0xC8, 0xD0, 0xD8]) NOT_TAKEN.set(o, 12);

const cyclesForOp = (op) => CYCLES[op] || 4;

function globalsWat() {
  const regs = ["a", "b", "c", "d", "e", "h", "l", "f"].map((r) => `(global $${r} (mut i32) (i32.const 0))`).join(" ");
  return `
  ${regs}
  (global $sp (mut i32) (i32.const 0xFFFE))
  (global $pc (mut i32) (i32.const 0x100))
  (global $ime (mut i32) (i32.const 0))
  (global $halted (mut i32) (i32.const 0))
  (global $tmp (mut i32) (i32.const 0))
  (global $tmp2 (mut i32) (i32.const 0))
  (global $tmp3 (mut i32) (i32.const 0))
  (global $tmp8 (mut i32) (i32.const 0))
  (global $trapped (mut i32) (i32.const 0))
  (global $trappc (mut i32) (i32.const 0))
  (global $curpc (mut i32) (i32.const 0))
  (global $lastid (mut i32) (i32.const 0))
  (global $cyc (mut i32) (i32.const 0))
  (global $steps (mut i32) (i32.const 0))
  (global $rombank (mut i32) (i32.const 1))
  ;; MBC1 keeps the bank number in TWO registers: $2000-$3FFF holds the low 5
  ;; bits and $4000-$5FFF the upper 2, combined per $6000-$7FFF's mode bit.
  (global $banklo (mut i32) (i32.const 1))
  (global $bankhi (mut i32) (i32.const 0))
  (global $bankmode (mut i32) (i32.const 0))
  (global $rambank (mut i32) (i32.const 0))
  (global $ly (mut i32) (i32.const 0))
  (global $lybase (mut i32) (i32.const 0))
  ;; low nibble of $FF00: 1 = released (active low). No input is
  ;; wired to this cart yet, so every button reads released.
  (global $joyp (mut i32) (i32.const 0x0F))
`;
}

/** OAM DMA and the trap recorder. */
function commonWat() {
  return `
  (func $oamdma (param $page i32)
    (local $i i32)
    (i32.store (i32.const ${PROBE + 20})
      (i32.add (i32.load (i32.const ${PROBE + 20})) (i32.const 1)))
    (i32.store (i32.const ${PROBE + 24}) (local.get $page))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 160)))
      (i32.store8 (i32.add (i32.const ${OAM}) (local.get $i))
        (call $rd8 (i32.add (i32.shl (local.get $page) (i32.const 8))
                            (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $trap
    ;; Record the FIRST trap only, with its banking context - a later trap
    ;; overwrites the evidence of what actually went wrong.
    (if (i32.eqz (global.get $trapped))
      (then
        (i32.store (i32.const ${PROBE + 28}) (global.get $rombank))
        (i32.store (i32.const ${PROBE + 32}) (global.get $curpc))
        (i32.store (i32.const ${PROBE + 36}) (global.get $pc))
        (i32.store (i32.const ${PROBE + 40}) (i32.load (i32.const ${PROBE + 0})))
        (i32.store (i32.const ${PROBE + 44}) (global.get $steps))
        (i32.store (i32.const ${PROBE + 48}) (global.get $sp))
        (i32.store (i32.const ${PROBE + 52}) (global.get $banklo))
        (i32.store (i32.const ${PROBE + 56}) (global.get $bankhi))
        ;; Freeze the pc ring's write cursor so the run-up to the FIRST trap
        ;; survives; later traps would otherwise overwrite the evidence.
        (i32.store (i32.const ${PROBE + 60}) (i32.load (i32.const ${PROBE + 124})))
        (i32.store (i32.const ${PROBE + 64}) (i32.load (i32.const ${PROBE + 764})))))
    (global.set $trapped (i32.const 1))
    (global.set $trappc (global.get $curpc)))
`;
}

/**
 * $step: EI delay, HALT/STOP, interrupt dispatch after every instruction and
 * the DIV/TIMA timer (gambatte-derived for CGB and DMG alike).
 */
function stepWat(cgb) {
  const IO = IOREG;
  // CGB: leaving HALT costs 4 cycles (gambatte Memory::event,
  // intevent_interrupts: `if (isCgb()) cc += 4`).
  return `
  ;; frame hand-off phase (see the frame loop): $irqonly runs $step's
  ;; interrupt check without an instruction; $resume re-enters a line
  ;; without its start events; $blitnow marks a blit due after line 144's
  ;; start events.
  (global $irqonly (mut i32) (i32.const 0))
  (global $resume (mut i32) (i32.const 0))
  (global $blitnow (mut i32) (i32.const 0))
  ;; absolute cycle a pending TIMA interrupt is requested at (0 = none)
  (global $timairq (mut i32) (i32.const 0))

  ;; LCD-OFF frame events at their exact cycle. gambatte schedules the next
  ;; blank-frame event 70224<<speed cycles after the last and hands the
  ;; frame out as soon as the instruction crossing it completes; checking
  ;; only at line ends handed it out up to a line late, with the CPU state
  ;; sampled a line late too. $offcd counts from the current line's start,
  ;; so the cycles spent into the line are subtracted here. 1 = hand out a
  ;; blank frame now.
  (func $offevent (result i32)
    (if (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))
      (then (return (i32.const 0))))
    (if (i32.gt_s (global.get $offcd) (i32.sub (global.get $linelen) (global.get $cyc)))
      (then (return (i32.const 0))))
    (global.set $offcd (i32.add (global.get $offcd)
      (i32.shl (i32.const 70224) (global.get $speed))))
    (if (global.get $blanklcd) (then (call $ppu_blank) (return (i32.const 1))))
    (global.set $blanklcd (i32.const 1))
    (i32.const 0))

  (func $irq (param $m i32)
    (i32.store8 (i32.const ${IO + 0x0F})
      (i32.or (i32.load8_u (i32.const ${IO + 0x0F})) (local.get $m))))

  (func $step
    (local $c0 i32) (local $pend i32) (local $bit i32) (local $per i32) (local $t i32)
    (local.set $c0 (global.get $cyc))
    (if (global.get $eipend)
      (then (global.set $ime (i32.const 1)) (global.set $eipend (i32.const 0))))
    (if (global.get $halted)
      (then
        (if (i32.and (i32.load8_u (i32.const ${IO + 0xFF}))
                     (i32.and (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 0x1F)))
          (then (global.set $halted (i32.const 0)) (global.set $stopcd (i32.const 0))${cgb ? ' (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))' : ''})
          (else
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
            ;; STOP's timed wake-up (see $stop)
            (if (i32.gt_s (global.get $stopcd) (i32.const 0))
              (then
                (global.set $stopcd (i32.sub (global.get $stopcd) (i32.const 4)))
                (if (i32.le_s (global.get $stopcd) (i32.const 0))
                  (then (global.set $halted (i32.const 0)))))))))
      (else (if (i32.eqz (global.get $irqonly)) (then (call $exec)))))
    ;; A RAM copy of BANKED code ran as its ROM arm (see _ramcode). Its next
    ;; pc is a $4000-window address; if the RAM byte at pc+bias came from
    ;; exactly that ROM byte, execution is still inside the copy - move it
    ;; back to RAM. Anything else (a ret to a real caller) is left alone.
    (if (global.get $ramexec)
      (then
        (global.set $ramexec (i32.const 0))
        (if (i32.lt_u (global.get $pc) (i32.const 0x8000))
          (then
            (local.set $per (i32.and (i32.add (global.get $pc) (global.get $rambias))
                                     (i32.const 0xFFFF)))
            (if (i32.and (i32.ge_u (local.get $per) (i32.const 0xC000))
                  (i32.eq (call $get_origin (local.get $per))
                          (i32.add (i32.add (global.get $ramobase)
                                            (i32.and (global.get $pc) (i32.const 0x3FFF)))
                                   (i32.const 1))))
              (then (global.set $pc (local.get $per))))))))
    ;; ---- DIV / TIMA for the instruction, BEFORE the interrupt check: a
    ;; TIMA overflow inside this instruction requests its interrupt at that
    ;; cycle, and gambatte takes it before the next instruction.
    (call $tick (i32.add (i32.sub (local.get $c0) (global.get $cyc)) (global.get $cycbias)))
    (global.set $cycbias (i32.const 0))
    (local.set $c0 (global.get $cyc))
    ;; ---- interrupt dispatch ----
    (local.set $pend (i32.and (i32.load8_u (i32.const ${IO + 0xFF}))
                              (i32.and (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 0x1F))))
    (if (i32.and (global.get $ime) (i32.ne (local.get $pend) (i32.const 0)))
      (then
        (local.set $bit (i32.ctz (local.get $pend)))
        (i32.store8 (i32.const ${IO + 0x0F})
          (i32.and (i32.load8_u (i32.const ${IO + 0x0F}))
                   (i32.xor (i32.shl (i32.const 1) (local.get $bit)) (i32.const 0xFF))))
        (global.set $ime (i32.const 0))
        (global.set $halted (i32.const 0))
        (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
        (call $wr8 (global.get $sp) (i32.and (global.get $pc) (i32.const 0xFF)))
        (call $wr8 (i32.and (i32.add (global.get $sp) (i32.const 1)) (i32.const 0xFFFF))
                   (i32.shr_u (global.get $pc) (i32.const 8)))
        (global.set $pc (i32.add (i32.const 0x40) (i32.shl (local.get $bit) (i32.const 3))))
        (global.set $cyc (i32.sub (global.get $cyc) (i32.const 20)))
        (i32.store (i32.add (i32.const ${PROBE + 200}) (i32.shl (local.get $bit) (i32.const 2)))
          (i32.add (i32.load (i32.add (i32.const ${PROBE + 200}) (i32.shl (local.get $bit) (i32.const 2))))
                   (i32.const 1)))))
    ;; the dispatch's own 20 cycles
    (call $tick (i32.sub (local.get $c0) (global.get $cyc))))

  (func $tick (param $t i32)
    (local $per i32) (local $bit i32) (local $pend i32)
    ;; ---- DIV / TIMA, in CPU cycles ----
    (global.set $rres (i32.add (global.get $rres) (i32.shr_u (local.get $t) (global.get $speed))))
    (global.set $divcnt (i32.and (i32.add (global.get $divcnt) (local.get $t)) (i32.const 0xFFFF)))
    ;; TIMA ticks when the ABSOLUTE cycle counter crosses a multiple of
    ;; 2^k, k = 10/4/6/8 by TAC (gambatte tima.cpp: lastUpdate_ is aligned to
    ;; cc, not to DIV). $abscc starts at gambatte's power-on $102A0.
    (local.set $per (global.get $abscc))
    (global.set $abscc (i32.add (global.get $abscc) (local.get $t)))
    (if (i32.and (i32.load8_u (i32.const ${IO + 0x07})) (i32.const 4))
      (then
        (local.set $bit (i32.load8_u (i32.add (i32.const ${IO + 0x1F0})
          (i32.and (i32.load8_u (i32.const ${IO + 0x07})) (i32.const 3)))))
        (local.set $pend (i32.sub (i32.shr_u (global.get $abscc) (local.get $bit))
                                  (i32.shr_u (local.get $per) (local.get $bit))))
        (block $d (loop $l
          (br_if $d (i32.le_s (local.get $pend) (i32.const 0)))
          (local.set $pend (i32.sub (local.get $pend) (i32.const 1)))
          (if (i32.ge_u (i32.load8_u (i32.const ${IO + 0x05})) (i32.const 0xFF))
            (then
              (i32.store8 (i32.const ${IO + 0x05}) (i32.load8_u (i32.const ${IO + 0x06})))
              ;; the interrupt is requested 3 cycles after the overflow tick
              ;; (gambatte tima.cpp: next irq event = lastUpdate + ... + 3)
              (global.set $timairq (i32.add (i32.shl (i32.add (i32.shr_u (local.get $per) (local.get $bit))
                                                               (i32.sub (i32.sub (i32.shr_u (global.get $abscc) (local.get $bit))
                                                                                 (i32.shr_u (local.get $per) (local.get $bit)))
                                                                        (local.get $pend)))
                                                      (local.get $bit))
                                             (i32.const 3))))
            (else
              (i32.store8 (i32.const ${IO + 0x05})
                (i32.add (i32.load8_u (i32.const ${IO + 0x05})) (i32.const 1)))))
          (br $l)))))
    ;; a serial transfer finishing inside this span
    (if (i32.and (i32.ne (global.get $serev) (i32.const 0))
                 (i32.ge_s (i32.sub (global.get $abscc) (global.get $serev)) (i32.const 0)))
      (then (call $serupd (global.get $abscc))))
    (if (i32.and (i32.ne (global.get $timairq) (i32.const 0))
                 (i32.ge_s (i32.sub (global.get $abscc) (global.get $timairq)) (i32.const 0)))
      (then
        (global.set $timairq (i32.const 0))
        (i32.store8 (i32.const ${IO + 0x0F})
          (i32.or (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 4))))))
`;
}

/**
 * Power-on state as gambatte's initstate.cpp sets it (not a boot ROM's).
 * CGB: A = $11, PPU 164 cycles into line 144, DIV $1E with $A0 into its tick,
 * BG palette RAM all $7FFF, OBJ palette RAM its fixed dump. DMG:
 * cycleCounter $102A0+$8D2C = $18FCC, PPU at line 153 + 396, DIV $AB.
 */
function initWat(cgb) {
  // gambatte clears SRAM to $FF on first load (clearSram) - both modes
  const sram = `(memory.fill (i32.const ${P.CRAMX}) (i32.const 0xFF) (i32.const 0x8000))`;
  const { BGPAL } = P;
  if (!cgb) {
    return `
    (global.set $ln (i32.const 153))
    (global.set $cyc (i32.const ${456 - 396}))
    (global.set $divcnt (i32.const 0xABCC))
    (global.set $abscc (i32.const 0x18FCC))
    ${sram}
    (i32.store (i32.const ${IOREG + 0x1F0}) (i32.const 0x0806040A))
`;
  }
  const init = P.cgbObjpInit();
  let objp = "";
  for (let i = 0; i < 64; i += 4) objp += `(i32.store (i32.const ${P.OBJPAL + i}) (i32.const ${init.readUInt32LE(i)}))`;
  return `
    (global.set $a (i32.const 0x11))
    ;; gambatte starts a CGB 164 cycles into line 144 with DIV at $1E and
    ;; $A0 cycles into its next tick (initstate.cpp: cycleCounter $102A0,
    ;; DIV register $1C, divLastUpdate 0).
    (global.set $cyc (i32.const ${456 - 164}))
    (global.set $divcnt (i32.const 0x1EA0))
    (memory.fill (i32.const ${BGPAL}) (i32.const 0xFF) (i32.const 64))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 32)))
      (i32.store8 (i32.add (i32.const ${BGPAL + 1}) (i32.shl (local.get $i) (i32.const 1)))
                  (i32.const 0x7F))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ${objp}
    (i32.store8 (i32.const ${IOREG + 0x55}) (i32.const 0xFF))
    ${sram}
    ;; TAC clock select -> TIMA tick shift (gambatte timaClock {10,4,6,8})
    (i32.store (i32.const ${IOREG + 0x1F0}) (i32.const 0x0806040A))
`;
}

/**
 * The frame loop: a PERSISTENT line counter that returns at VBlank start, the
 * way gambatte hands a frame to libretro (LCD-on restarts the PPU at line 0
 * and moves the frame boundary), with libretro's frame-dupe rule. Each line:
 * LYC/mode-2/VBlank STAT sources at its start, the scanline drawn during
 * mode 3, the HBlank STAT source and one HDMA block, then the rest.
 */
function frameWat() {
  const IO = IOREG;
  return `
    ;; LIBRETRO FRAME DUPES. gambatte's retro_run first checks
    ;; samples_count / 35112 against frames_count and, if emulated time is
    ;; AHEAD of the host frame count, returns WITHOUT RUNNING (a dupe frame).
    ;; A frame is handed out only at a blit, so a long gap between blits (the
    ;; LCD off, or the skipped first mode-1 after switching it on) is paid
    ;; back with dupes. One GBC cart's counter went one frame ahead of the
    ;; reference at every LCD toggle until this was modelled.
    (if (i32.ge_s (global.get $rres) (i32.const 70224))
      (then
        (global.set $rres (i32.sub (global.get $rres) (i32.const 70224)))
        (i32.store (i32.const ${PROBE + 0})
          (i32.add (i32.load (i32.const ${PROBE + 0})) (i32.const 1)))
        (i32.store (i32.const ${PROBE + 224})
          (i32.add (i32.load (i32.const ${PROBE + 224})) (i32.const 1)))
        (return)))
    (local.set $i (i32.const 0))
    (block $fd (loop $fl
      ;; A frame handed out MID-LINE (the blit at line 144 after its start
      ;; events, or a blank LCD-off frame) resumes here without redoing the
      ;; line's start: its events already happened before the hand-off.
      (if (global.get $resume)
        (then (global.set $resume (i32.const 0)))
        (else
      ;; ---- line start: $ln, with this line's budget already in $cyc ----
      (global.set $lcdrestart (i32.const 0))
      (global.set $linelen (i32.shl (i32.const 456) (global.get $speed)))
      (global.set $ly (if (result i32)
        (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))
        (then (global.get $ln)) (else (i32.const 0))))
      (if (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))
        (then
          ;; LYC=0 MATCHES ON LINE 153: LY reads 0 for (nearly) all of line
          ;; 153 (gambatte video.cpp compares 153 as 0), so the LYC=0 STAT
          ;; interrupt fires a line early and line 0 raises no new edge.
          (if (i32.or
                (i32.and (i32.eq (global.get $ly) (i32.load8_u (i32.const ${IO + 0x45})))
                         (i32.or (i32.ne (global.get $ly) (i32.const 0))
                                 (i32.eqz (i32.and (i32.load8_u (i32.const ${IO + 0x41})) (i32.const 4)))))
                (i32.and (i32.eq (global.get $ly) (i32.const 153))
                         (i32.eqz (i32.load8_u (i32.const ${IO + 0x45})))))
            (then
              (i32.store8 (i32.const ${IO + 0x41})
                (i32.or (i32.load8_u (i32.const ${IO + 0x41})) (i32.const 4)))
              (if (i32.and (i32.load8_u (i32.const ${IO + 0x41})) (i32.const 0x40))
                (then (call $irq (i32.const 2)))))
            (else (if (i32.eq (global.get $ly) (i32.load8_u (i32.const ${IO + 0x45})))
              (then (nop))
              (else
              (i32.store8 (i32.const ${IO + 0x41})
                (i32.and (i32.load8_u (i32.const ${IO + 0x41})) (i32.const 0xFB)))))))
          (if (i32.lt_u (global.get $ln) (i32.const 144))
            (then (if (i32.and (i32.load8_u (i32.const ${IO + 0x41})) (i32.const 0x20))
                    (then (call $irq (i32.const 2))))))
          (if (i32.eq (global.get $ln) (i32.const 144))
            (then
              (call $irq (i32.const 1))
              (if (i32.and (i32.load8_u (i32.const ${IO + 0x41})) (i32.const 0x10))
                (then (call $irq (i32.const 2))))))))
      (if (i32.eqz (global.get $ln)) (then (global.set $wline (i32.const 0))))
      ;; An interrupt the line's start just requested is taken NOW, before
      ;; the next instruction: gambatte dispatches at the event's cycle
      ;; (Memory::event intevent_interrupts), so the stacked return address
      ;; is the pc the CPU stopped at, not the one after it.
      (if (i32.and (global.get $ime)
            (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0xFF}))
                             (i32.and (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 0x1F)))
                    (i32.const 0)))
        (then (global.set $irqonly (i32.const 1)) (call $step) (global.set $irqonly (i32.const 0))))
      ;; THE FRAME HAND-OFF, AT gambatte's POINT: its blit event runs every
      ;; event due at that cycle (the VBlank request and its dispatch) before
      ;; retro_run returns, so the CPU is handed out inside the interrupt
      ;; entry. The line-end code below only marks the blit; it happens here,
      ;; after line 144's start, and the next frame resumes this line.
      (if (global.get $blitnow)
        (then (global.set $blitnow (i32.const 0)) (global.set $resume (i32.const 1)) (br $fd)))))
      ;; ---- mode 2 (OAM scan, 80 dots) ----
      (local.set $i (i32.sub (global.get $linelen) (i32.shl (i32.const 80) (global.get $speed))))
      (block $d0 (loop $l0
        (br_if $d0 (i32.le_s (global.get $cyc) (local.get $i)))
        (br_if $d0 (global.get $trapped))
        (br_if $d0 (global.get $lcdrestart))
        (call $step)
        (if (call $offevent) (then (global.set $resume (i32.const 1)) (br $fd)))
        (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
        (br $l0)))
      (br_if $fl (global.get $lcdrestart))
      ;; DRAW AT MODE 3, not at the start of the line: a raster effect that
      ;; writes palette RAM from an interrupt landing in mode 2 (a sky
      ;; gradient, one colour per line from STAT) changes the line on
      ;; hardware; drawn at line start the whole gradient sat one line late.
      ;; The line is drawn in segments as mode 3 runs (hw_gbc $ppu_catch):
      ;; open it here, close it at the end of mode 3.
      (if (i32.lt_u (global.get $ln) (i32.const 144))
        (then (global.set $rxnext (i32.const 0))))
      ;; ---- mode 3 ----
      (local.set $i (i32.sub (global.get $linelen) (i32.shl (i32.const 252) (global.get $speed))))
      (block $d (loop $l
        (br_if $d (i32.le_s (global.get $cyc) (local.get $i)))
        (br_if $d (global.get $trapped))
        (br_if $d (global.get $lcdrestart))
        (call $step)
        (if (call $offevent) (then (global.set $resume (i32.const 1)) (br $fd)))
        (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
        (br $l)))
      (if (global.get $lcdrestart)
        (then (global.set $rxnext (i32.const 160)) (br $fl)))
      (if (i32.lt_u (global.get $ln) (i32.const 144))
        (then
          (call $ppu_catch (i32.const 160))
          (global.set $rxnext (i32.const 160))
          (if (global.get $winflag)
            (then (global.set $wline (i32.add (global.get $wline) (i32.const 1)))
                  (global.set $winflag (i32.const 0))))))
      ;; ---- HBlank: STAT source and one HDMA block ----
      (if (i32.and (i32.lt_u (global.get $ln) (i32.const 144))
                   (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))
                           (i32.const 0)))
        (then
          (if (i32.and (i32.load8_u (i32.const ${IO + 0x41})) (i32.const 0x08))
            (then (call $irq (i32.const 2))))
          (if (global.get $hdma_on) (then (call $hdma_block)))
          ;; the HBlank STAT request is taken before the next instruction too
          (if (i32.and (global.get $ime)
                (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0xFF}))
                                 (i32.and (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 0x1F)))
                        (i32.const 0)))
            (then (global.set $irqonly (i32.const 1)) (call $step) (global.set $irqonly (i32.const 0))))))
      (block $d2 (loop $l2
        (br_if $d2 (i32.le_s (global.get $cyc) (i32.const 0)))
        (br_if $d2 (global.get $trapped))
        (br_if $d2 (global.get $lcdrestart))
        (call $step)
        (if (call $offevent) (then (global.set $resume (i32.const 1)) (br $fd)))
        (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
        (br $l2)))
      (br_if $fl (global.get $lcdrestart))
      ;; ---- line end ----
      (global.set $ln (i32.add (global.get $ln) (i32.const 1)))
      (if (i32.ge_u (global.get $ln) (i32.const 154)) (then (global.set $ln (i32.const 0))))
      (global.set $cyc (i32.add (global.get $cyc) (global.get $linelen)))
      ;; ---- frame hand-off, gambatte's intevent_blit rules ----
      (if (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))
        (then
          (if (i32.eq (global.get $ln) (i32.const 144))
            (then
              (if (global.get $skipnext)
                (then (global.set $skipnext (i32.const 0)))
                (else
                  (if (global.get $blanklcd) (then (call $ppu_blank)))
                  (global.set $blanklcd (i32.const 0))
                  (global.set $blitnow (i32.const 1)))))))
        (else
          (global.set $offcd (i32.sub (global.get $offcd) (global.get $linelen)))
          (if (i32.le_s (global.get $offcd) (i32.const 0))
            (then
              (global.set $offcd (i32.add (global.get $offcd)
                (i32.shl (i32.const 70224) (global.get $speed))))
              (if (global.get $blanklcd)
                (then (call $ppu_blank) (br $fd))
                (else (global.set $blanklcd (i32.const 1))))))))
      (br $fl)))
    (global.set $rres (i32.sub (global.get $rres) (i32.const 70224)))
    (i32.store (i32.const ${PROBE + 0})
      (i32.add (i32.load (i32.const ${PROBE + 0})) (i32.const 1)))
    (i32.store (i32.const ${PROBE + 4})  (global.get $steps))
    (i32.store (i32.const ${PROBE + 8})  (global.get $trapped))
    (i32.store (i32.const ${PROBE + 12}) (global.get $trappc))
    (i32.store (i32.const ${PROBE + 16}) (global.get $pc))
    (i32.store (i32.const ${PROBE + 80}) (global.get $a))
    (i32.store (i32.const ${PROBE + 112}) (global.get $sp))
    (i32.store (i32.const ${PROBE + 116}) (global.get $rombank))
    (i32.store (i32.const ${PROBE + 120}) (global.get $ime))
    (i32.store (i32.const ${PROBE + 176}) (i32.and (i32.shr_u (global.get $divcnt) (i32.const 8)) (i32.const 0xFF)))
    (i32.store (i32.const ${PROBE + 172}) (global.get $divcnt))
    (i32.store (i32.const ${PROBE + 180}) (global.get $speed))
    (i32.store (i32.const ${PROBE + 184}) (global.get $svbk))
    (i32.store (i32.const ${PROBE + 188}) (global.get $vbk))
    (i32.store (i32.const ${PROBE + 192}) (global.get $halted))
    (i32.store (i32.const ${PROBE + 196}) (global.get $ln))
    (return)
`;
}

/** pc in RAM -> the ROM offset whose arm runs it, by provenance (hw-gbc $origin_note). */
function ramCodeWat(PCSPAN) {
  return `(block $rc (result i32)
          (local.set $rs (call $get_origin (global.get $pc)))
          (if (i32.eqz (local.get $rs)) (then (br $rc (i32.const ${PCSPAN}))))
          ;; EVERY byte of the instruction must still carry its ROM origin: a
          ;; game that copies a routine and then PATCHES an operand (one GBC
          ;; cart rewrites \`ld de,$0448\` in its WRAM copy) keeps provenance on
          ;; the opcode byte only, and running the ROM arm would use the
          ;; ROM's operand. That is a trap, never a silent wrong answer.
          (if (i32.eqz (call $ram_bytes_intact (global.get $pc) (local.get $rs)))
            (then (br $rc (i32.const ${PCSPAN}))))
          (local.set $rs (i32.sub (local.get $rs) (i32.const 1)))
          ;; Run the ROM arm whatever bank is mapped now, and let $step carry
          ;; the fall-through BACK INTO RAM ($ramexec) so the next instruction
          ;; is checked against the RAM bytes again. Running a bank-0 copy "in
          ;; place" was wrong: a cart can copy a routine to WRAM and patch
          ;; an operand further down, and the in-place run never saw it.
          (global.set $ramexec (i32.const 1))
          (global.set $ramobase (i32.and (local.get $rs) (i32.const -16384)))
          (global.set $pc (if (result i32) (i32.lt_u (local.get $rs) (i32.const 0x4000))
            (then (local.get $rs))
            (else (i32.or (i32.const 0x4000) (i32.and (local.get $rs) (i32.const 0x3FFF))))))
          (global.set $rambias (i32.sub (global.get $curpc) (global.get $pc)))
          (local.get $rs))`;
}

/**
 * Instruction length per opcode byte, MEASURED from this ROM's own decoded
 * block index (the modal length of records starting with that byte), not
 * typed in. Ties go to the length seen first, in block-index order.
 */
function opLenTable(img, blocks) {
  const by = new Map();
  for (const [o, v] of blocks) {
    if (o < img.length && v.m !== "?" && v.m !== "defb") {
      let c = by.get(img[o]);
      if (!c) { c = new Map(); by.set(img[o], c); }
      c.set(v.n, (c.get(v.n) || 0) + 1);
    }
  }
  const out = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    const c = by.get(b);
    if (!c) { out[b] = 1; continue; }
    let best = null, bn = -1;
    for (const [n, k] of c) if (k > bn) { best = n; bn = k; }
    out[b] = best;
  }
  return out;
}

// ---- RAM interpreter templates -----------------------------------------
// A byte-for-byte copy of ROM code runs as its ROM arm (provenance). An
// instruction whose OPERAND the game patched in RAM (one cart rewrites the
// DMA page in its HRAM routine, another a `ld de,nn` in WRAM) cannot:
// its immediates must come from RAM. One template arm per opcode is lowered
// by lower() itself with SENTINEL immediates, and the sentinel constants are
// then swapped for globals the interpreter fills from memory. Every template
// is checked: no sentinel may survive, and an opcode with operands must end
// up reading them. Control flow (jp/jr/call/ret/rst) is interpreted in
// hw-gbc $ram_interp instead; add sp,e8 / ld hl,sp+e8 are left out (their
// lowering folds the operand into flag constants) and trap if patched.
const CONTROL = new Set(["jp", "jr", "call", "ret", "reti", "rst"]);
const REP = [["(i32.const 42435)", "(global.get $imm16)"],
  ["(i32.const 42436)", "(i32.and (i32.add (global.get $imm16) (i32.const 1)) (i32.const 0xFFFF))"],
  ["(i32.const 65445)", "(i32.add (i32.const 0xFF00) (global.get $imm8))"],
  ["(i32.const 165)", "(global.get $imm8)"]];

function ramTemplates(img, blocks) {
  const seen = new Map(), seenCb = new Map();
  for (const [o, v] of blocks) {
    if (o + 1 >= img.length || v.m === "?" || v.m === "defb") continue;
    const op = img[o];
    if (op === 0xCB) { if (!seenCb.has(img[o + 1])) seenCb.set(img[o + 1], v); }
    else if (!seen.has(op)) seen.set(op, v);
  }
  const out = new Map(), cbout = new Map();
  for (const [op, v] of seen) {
    const m = v.m, o = v.o ?? "", n = v.n;
    if (CONTROL.has(m) || op === 0xE8 || op === 0xF8) continue;
    const o2 = n === 2 ? o.replace(/\$[0-9A-Fa-f]+/g, "$$A5")
      : n === 3 ? o.replace(/\$[0-9A-Fa-f]+/g, "$$A5C3") : o;
    let body, flow;
    try { [body, flow] = lower(m, o2, 0, 0); } catch { continue; }
    if (flow !== null) continue;
    if (n === 1 && REP.some(([a]) => body.includes(a))) {
      throw new Error(`gb template ${hex(op, 2)}: sentinel constant in an operand-free op`);
    }
    for (const [a, b] of REP) body = body.split(a).join(b);
    // STOP's second byte is not an operand (it is skipped).
    if (n > 1 && m !== "stop" && !body.includes("$imm")) throw new Error(`gb template ${hex(op, 2)} ${m} ${o2}: operand not substituted`);
    if (["42435", "42436", "65445", " 165)"].some((t) => body.includes(t))) {
      throw new Error(`gb template ${hex(op, 2)}: sentinel survived`);
    }
    out.set(op, [body, n, cyclesForOp(op)]);
  }
  for (const [op2, v] of seenCb) {
    let body, flow;
    try { [body, flow] = lower(v.m, v.o ?? "", 0, 0); } catch { continue; }
    if (flow === null) cbout.set(op2, [body, 2, CB_CYCLES[op2] || 8]);
  }
  return [out, cbout];
}

function templateTable(name, d) {
  const arms = [...d.keys()].sort((a, b) => a - b);
  const lines = [`  (func $${name} (param $op i32) (result i32)`];
  for (let i = arms.length - 1; i >= 0; i--) lines.push(`    (block $t${i}`);
  lines.push("    (block $tdef");
  const sel = new Array(256).fill("$tdef");
  arms.forEach((op, i) => { sel[op] = `$t${i}`; });
  lines.push("      (br_table " + sel.join(" ") + " $tdef (local.get $op))");
  lines.push("    ) (return (i32.const 0))");
  arms.forEach((op) => {
    const [body, n, cyc] = d.get(op);
    lines.push(`    ) ;; ${hex(op, 2)}`);
    lines.push(`    ${body} (global.set $cyc (i32.sub (global.get $cyc) (i32.const ${cyc}))) (return (i32.const ${n}))`);
  });
  lines.push("    (i32.const 0))");
  return lines.join("\n");
}

function ramTemplatesWat(img, blocks) {
  const [t, tcb] = ramTemplates(img, blocks);
  return templateTable("tmpl", t) + "\n" + templateTable("tmpl_cb", tcb) + `
  ;; run the instruction at $pc from RAM through a template; 1 if handled
  (func $tmpl_run (param $op i32) (result i32)
    (local $n i32)
    (global.set $imm8 (call $rd8 (i32.and (i32.add (global.get $pc) (i32.const 1)) (i32.const 0xFFFF))))
    (global.set $imm16 (i32.or (global.get $imm8)
      (i32.shl (call $rd8 (i32.and (i32.add (global.get $pc) (i32.const 2)) (i32.const 0xFFFF)))
               (i32.const 8))))
    (local.set $n (if (result i32) (i32.eq (local.get $op) (i32.const 0xCB))
      (then (call $tmpl_cb (global.get $imm8)))
      (else (call $tmpl (local.get $op)))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    (global.set $pc (i32.and (i32.add (global.get $curpc) (local.get $n)) (i32.const 0xFFFF)))
    (i32.store (i32.const ${PROBE + 228}) (i32.add (i32.load (i32.const ${PROBE + 228})) (i32.const 1)))
    (i32.const 1))
`;
}

/** Debug-only reachability counters and pc stop (options.hits / options.stopAt). */
function hitCounters(hits, stopAt) {
  const stop = stopAt
    ? `    (if (i32.and (i32.eq (global.get $curpc) (i32.const ${stopAt.pc})) (i32.ge_u (i32.load (i32.const ${PROBE})) (i32.const ${stopAt.fromFrame ?? 0}))) (then (call $trap) (return)))\n`
    : "";
  if (!hits.length) return stop;
  return hits.slice(0, 64).map((a, i) =>
    `    (if (i32.eq (global.get $curpc) (i32.const ${a})) (then `
    + `(i32.store (i32.const ${PROBE + 128 + 4 * i}) `
    + `(i32.add (i32.load (i32.const ${PROBE + 128 + 4 * i})) (i32.const 1)))))\n`).join("") + stop;
}

/**
 * Emit the whole cart as WAT text chunks of ONE (module ...). Joined with no
 * separator they are the module.
 * @param {Uint8Array} img ROM bytes
 * @param {Map<number,{m:string,o:string,n:number}>} blocks block index (blocks.js)
 * @param {{cgb:boolean, mbc:string, watch?:[number,number], hits?:number[], stopAt?:{pc:number, fromFrame?:number}, stats?:object}} o
 */
export function* emitGbWat(img, blocks, o) {
  const cgb = o.cgb;
  const IMGLEN = img.length;
  const L = gbLayout(IMGLEN);
  const { FB, ABI, PCTAB, PCSPAN, PACKED } = L;
  const [WATCH_LO, WATCH_HI] = o.watch ?? [0x10000, 0];
  const addrs = [...blocks.keys()].sort((a, b) => a - b);
  const { ORIGIN, pages: basePages } = gbOriginAndPages(L, addrs.length);
  const big = o.traceEntries != null ? gbBigRing(IMGLEN, addrs.length, o.traceEntries) : null;
  const pages = big ? big.pages : basePages;
  const mask = Math.max(1, IMGLEN) - 1;

  const cyclesFor = (off) => {
    if (off >= IMGLEN) return 4;
    const op = img[off];
    if (op === 0xCB) return off + 1 < IMGLEN ? CB_CYCLES[img[off + 1]] : 8;
    return CYCLES[op] || 4;
  };
  const refund = (off) => (off >= IMGLEN || !NOT_TAKEN.has(img[off])) ? ""
    : ` (global.set $cyc (i32.add (global.get $cyc) (i32.const ${NOT_TAKEN.get(img[off])})))`;

  // DMG shades as RGBA words, MEASURED from gambatte's own output: a grey
  // ramp (255, 165, 82, 0), not the classic green LCD.
  const shadeBytes = [];
  for (const c0 of [0xFFFFFBFF, 0xFFA5A2A5, 0xFF525152, 0xFF000000]) {
    const c = (0xFF000000 | ((c0 & 0xFF) << 16) | (c0 & 0xFF00) | ((c0 >>> 16) & 0xFF)) >>> 0;
    shadeBytes.push(c & 0xFF, (c >>> 8) & 0xFF, (c >>> 16) & 0xFF, c >>> 24);
  }

  let first = true;
  const part = (s) => { const r = first ? s : "\n" + s; first = false; return r; };

  yield part(`(module\n  (memory (export "memory") ${pages})`);
  yield part(globalsWat());
  yield part(P.globalsWat());
  yield part(P.memWat({ imgLen: IMGLEN, mbc: o.mbc, romimg: ROMIMG, probe: PROBE,
    watchLo: WATCH_LO, watchHi: WATCH_HI, padptr: ABI + 0x100, origin: ORIGIN, cgb }));
  yield part(commonWat());
  yield part(`  (data (i32.const ${IOREG + 0x100}) "${watBytes(shadeBytes)}")`);
  yield part(H.paletteWat());
  yield part(H.renderWat());
  yield part(cgb ? P.renderWat(FB) : P.dmgRenderWat(FB));
  yield part(P.initstateDataWat(cgb));
  yield part(`  (data (i32.const ${P.OPLEN}) "${watBytes(opLenTable(img, blocks))}")`);
  yield part(ramTemplatesWat(img, blocks));

  // ---- one arm per ROM offset ----
  let ok = 0, bad = 0, broken = 0;
  const bodyFor = (a) => {
    const rec = blocks.get(a);
    // THE FALLTHROUGH ADDRESS IS A CPU ADDRESS, NOT A ROM OFFSET: `$pc` holds
    // what the CPU sees and `$exec` maps pc -> offset through `$rombank`.
    // Handing it `a + n` is only right in bank 0 (a banked `call` pushed a
    // non-16-bit return address and a banked cart returned into the header logo).
    const nxt = cpuAddr(a + rec.n);
    let body, flow;
    try { [body, flow] = lower(rec.m, rec.o ?? "", cpuAddr(a), nxt); ok++; }
    catch { body = "(call $trap)"; flow = null; bad++; }
    if (o.breakArm != null && cpuAddr(a) === o.breakArm) {
      // DEBUG / MUST-FAIL CONTROL (options.breakArm): flip bit 0 of L after the instruction
      body += " (global.set $l (i32.xor (global.get $l) (i32.const 1)))";
      broken++;
    }
    let tail;
    if (flow === null) tail = `(global.set $pc (i32.const ${nxt}))`;
    else if (flow.kind === "jp") tail = `(global.set $pc (i32.const ${flow.target}))`;
    else if (flow.kind === "jp_ind") tail = `(global.set $pc ${flow.expr})`;
    else if (flow.kind === "ret_expr") tail = "(global.set $pc (global.get $tmp))";
    else if (flow.kind === "jp_cc") {
      tail = `(if ${flow.cond} `
        + `(then (global.set $pc (i32.const ${flow.target})))`
        + ` (else (global.set $pc (i32.const ${flow.next}))${refund(a)}))`;
    } else if (flow.kind === "call_cc") {
      tail = `(if ${flow.cond} (then ${flow.push} `
        + `(global.set $pc (i32.const ${flow.target})))`
        + ` (else (global.set $pc (i32.const ${flow.next}))${refund(a)}))`;
    } else if (flow.kind === "ret_cc") {
      tail = `(if ${flow.cond} (then ${flow.pop} `
        + "(global.set $pc (global.get $tmp)))"
        + ` (else (global.set $pc (i32.const ${flow.next}))${refund(a)}))`;
    } else tail = `(global.set $pc (i32.const ${nxt}))`;
    return `${body} ${tail} (global.set $cyc (i32.sub (global.get $cyc) (i32.const ${cyclesFor(a)})))`;
  };

  const nShards = Math.ceil(addrs.length / SH);
  for (let si = 0; si < nShards; si++) {
    const sh = addrs.slice(si * SH, (si + 1) * SH);
    const lines = [`  (func $shard${si} (param $id i32)`];
    // Blocks are OPENED in reverse so `br $sN` lands on arm N.
    for (let i = sh.length - 1; i >= 0; i--) lines.push(`    (block $s${i}`);
    lines.push("    (block $sdef");
    lines.push("      (br_table " + sh.map((_, i) => `$s${i}`).join(" ") + " $sdef (local.get $id))");
    // `br $sN` resumes just AFTER $sN's closing paren. Closing $sdef first
    // lands the DEFAULT there, then each `) ;; $sN` close is followed by arm
    // N's body. (Emitting the bodies naively ran every instruction as its
    // NEIGHBOUR.)
    lines.push("    ) (call $trap) (return)");
    sh.forEach((a, i) => {
      lines.push(`    ) ;; $s${i} @ ${hex(a, 4)}`);
      lines.push(`    ${bodyFor(a)} (return)`);
    });
    lines.push("    (call $trap))");
    yield part(lines.join("\n"));
  }

  const dispatch = [];
  for (let si = 0; si < nShards; si++) {
    dispatch.push(`    (if (i32.lt_u (local.get $id) (i32.const ${(si + 1) * SH})) (then `
      + `(call $shard${si} (i32.sub (local.get $id) (i32.const ${si * SH}))) (return)))`);
  }
  const RAMCODE = ramCodeWat(PCSPAN);
  yield part(`
  (func $exec
    (local $id i32)
    (local $rs i32)${big ? "\n    (local $tr i32)" : ""}
    ;; LY must be LIVE inside a line, not only between lines: a game that
    ;; polls \`ldh a,($44)\` until LY == N spins forever if the value is
    ;; constant for the whole 456-cycle line it polls in (shocklobster does
    ;; exactly this and uploaded no graphics at all).
    ;;
    ;; $cyc counts DOWN from 456 within the current line, so the line is
    ;; $lybase plus however much of it has been consumed. Deriving it here
    ;; keeps LY correct for any caller - including dbg_step - without a
    ;; second clock that can disagree with the frame loop's cycle spend.
    ;; An earlier version ticked a flat 4 cycles per instruction here and
    ;; drifted against the real per-instruction costs, which cost Flappyboy
    ;; its exact match.
    
    (global.set $curpc (global.get $pc))${big ? bigRingWat(big) : ""}
    (if (i32.ge_u (global.get $pc) (i32.const 0x8000)) (then (if (call $ram_interp) (then (return)))))
    ;; pc -> ROM OFFSET. $0000-$3FFF is fixed bank 0; $4000-$7FFF is the
    ;; switched bank, so its offset depends on $rombank. Above $8000 the pc
    ;; is RAM/HRAM, which only HRAM_CODE aliases cover.
    (local.set $id (if (result i32)
      (i32.lt_u (global.get $pc) (i32.const 0x4000))
      (then (global.get $pc))
      (else (if (result i32) (i32.lt_u (global.get $pc) (i32.const 0x8000))
        (then (i32.and
                (i32.add (i32.mul (global.get $rombank) (i32.const 0x4000))
                         (i32.sub (global.get $pc) (i32.const 0x4000)))
                (i32.const ${mask})))
        (else ${RAMCODE})))))
    (if (i32.ge_u (local.get $id) (i32.const ${PCSPAN}))
      (then (call $trap) (return)))
    (local.set $id (i32.load (i32.add (i32.const ${PCTAB})
      (i32.mul (local.get $id) (i32.const 4)))))
    (if (i32.eqz (local.get $id)) (then (call $trap) (return)))
    (local.set $id (i32.sub (local.get $id) (i32.const 1)))
    (global.set $lastid (local.get $id))
    ;; Ring of the last 1024 dispatched pcs PAIRED WITH THE ROM BANK AND SP,
    ;; in LINEAR memory so a host can read it - a cart global would be
    ;; invisible to a host reading linear memory only. A trap tells you WHERE
    ;; execution died; this tells you how it got there, which bank and what
    ;; the stack pointer was doing, which is the part a trap address alone
    ;; cannot give. SP is in the slot because a \`ret\` to a plausible-looking
    ;; wrong address is a STACK question, and pc+bank alone cannot answer it.
    (local.set $rs (i32.add (i32.const ${PROBE + 4096})
      (i32.mul (i32.and (i32.load (i32.const ${PROBE + 124})) (i32.const 2047))
               (i32.const 16))))
    (i32.store (local.get $rs) (global.get $pc))
    (i32.store (i32.add (local.get $rs) (i32.const 4)) (global.get $rombank))
    (i32.store (i32.add (local.get $rs) (i32.const 8)) (global.get $sp))
    (i32.store (i32.add (local.get $rs) (i32.const 12))
      (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
    (i32.store (i32.const ${PROBE + 124})
      (i32.add (i32.load (i32.const ${PROBE + 124})) (i32.const 1)))
` + hitCounters(o.hits ?? [], o.stopAt ?? null) + dispatch.join("\n") + "\n    (call $trap))");
  yield part(stepWat(cgb));

  // pc table entries: arm id i+1 at its ROM offset
  const tab = new Uint8Array(addrs.length * 8);
  const dv = new DataView(tab.buffer);
  addrs.forEach((a, i) => { dv.setUint32(i * 8, a, true); dv.setUint32(i * 8 + 4, i + 1, true); });
  yield part(`  (data (i32.const ${PACKED}) "${watBytes(tab)}")`);
  const ents = { length: addrs.length };
  yield part(`
  (func $initmap
    (local $i i32) (local $p i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${ents.length})))
      (local.set $p (i32.add (i32.const ${PACKED}) (i32.mul (local.get $i) (i32.const 8))))
      (i32.store (i32.add (i32.const ${PCTAB})
        (i32.mul (i32.load (local.get $p)) (i32.const 4)))
        (i32.load (i32.add (local.get $p) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func (export "wc_get_info") (result i32)
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 0))  (i32.const 3))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 4))  (i32.const ${FB_W}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 8))  (i32.const ${FB_H}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 12)) (i32.const ${FB}))
    ;; inputPtr (WCInfo field 7, byte 28). MUST be a real address: the host
    ;; writes 64 bytes of pad state here EVERY FRAME without checking for
    ;; zero, so leaving it 0 scribbles over WASM linear offset 0. On the
    ;; SNES and NES carts that offset is work RAM and the corruption was
    ;; the whole black screen; here it lands on unused space, but a probe
    ;; or a map change would make it fatal. ABI+0x100 is past the 48-byte
    ;; WCInfo struct and inside the block already reserved for it.
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 28))
               (i32.add (i32.const ${ABI}) (i32.const 0x100)))
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
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 40)) (i32.add (i32.const ${ABI}) (i32.const 0x180)))
    (i32.const ${ABI}))

  (func (export "wc_init")
    (local $i i32)
    (call $initmap)
    ;; Post-boot register state the DMG boot ROM leaves behind. A cart that
    ;; starts from zeroed registers takes a different path through its own
    ;; init and can stall before it ever draws.
    (global.set $a (i32.const 0x01)) (global.set $f (i32.const 0xB0))
    (global.set $b (i32.const 0x00)) (global.set $c (i32.const 0x13))
    (global.set $d (i32.const 0x00)) (global.set $e (i32.const 0xD8))
    (global.set $h (i32.const 0x01)) (global.set $l (i32.const 0x4D))
    (global.set $sp (i32.const 0xFFFE))
    (global.set $pc (i32.const 0x100))
    ;; LCDC/BGP as the boot ROM leaves them: display on, BG on, tiles at $8000.
    (i32.store8 (i32.const ${IOREG + 0x40}) (i32.const 0x91))
    (i32.store8 (i32.const ${IOREG + 0x47}) (i32.const 0xFC))
    ${initWat(cgb)})

  (func (export "wc_render")
    (local $i i32) (local $ln i32)
    ${frameWat()}
    ;; A DMG frame is 70,224 cycles: 154 scanlines of 456. Stepping a fixed
    ;; instruction count instead of spending cycles is what stalled the
    ;; Genesis carts for a whole session.
    (local.set $ln (i32.const 0))
    (block $fd (loop $fl
      (br_if $fd (i32.ge_u (local.get $ln) (i32.const 154)))
      ;; DRAW BEFORE RUNNING THE LINE'S CYCLES.
      ;;
      ;; Rendering after meant each scanline was drawn with the registers as
      ;; they stood at the line's END, so a mid-frame SCX/SCY/LCDC change
      ;; landed one line early. On hardware the line is fetched during those
      ;; cycles, so the state that matters is the state at the START.
      (if (i32.lt_u (local.get $ln) (i32.const ${FB_H}))
        (then (call $gb_render_line (local.get $ln))))
      (global.set $lybase (local.get $ln))
      (global.set $ly (local.get $ln))
      (global.set $cyc (i32.const 456))
      (block $d (loop $l
        (br_if $d (i32.le_s (global.get $cyc) (i32.const 0)))
        (br_if $d (global.get $trapped))
        (call $step)
        (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
        (br $l)))
      ;; vblank starts at line 144: raise IF bit 0 and vector if IME is set.
      (if (i32.eq (local.get $ln) (i32.const 144))
        (then
          (i32.store8 (i32.const ${IOREG + 0x0F})
            (i32.or (i32.load8_u (i32.const ${IOREG + 0x0F}))
                    (i32.const 1)))
          (if (i32.and (global.get $ime)
                       (i32.and (i32.load8_u (i32.const ${IOREG + 0xFF}))
                                (i32.const 1)))
            (then
              (global.set $ime (i32.const 0))
              (global.set $halted (i32.const 0))
              (i32.store8 (i32.const ${IOREG + 0x0F})
                (i32.and (i32.load8_u (i32.const ${IOREG + 0x0F}))
                         (i32.const 0xFE)))
              (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2))
                                       (i32.const 0xFFFF)))
              (call $wr8 (global.get $sp)
                (i32.and (global.get $pc) (i32.const 0xFF)))
              (call $wr8 (i32.and (i32.add (global.get $sp) (i32.const 1))
                                  (i32.const 0xFFFF))
                (i32.shr_u (global.get $pc) (i32.const 8)))
              (global.set $pc (i32.const 0x40))))))
      (local.set $ln (i32.add (local.get $ln) (i32.const 1)))
      (br $fl)))
    ;; Mirror liveness into LINEAR memory - globals are invisible to a host.
    (i32.store (i32.const ${PROBE + 0})
      (i32.add (i32.load (i32.const ${PROBE + 0})) (i32.const 1)))
    (i32.store (i32.const ${PROBE + 4})  (global.get $steps))
    (i32.store (i32.const ${PROBE + 8})  (global.get $trapped))
    (i32.store (i32.const ${PROBE + 12}) (global.get $trappc))
    (i32.store (i32.const ${PROBE + 16}) (global.get $pc))
    ;; Registers mirrored into LINEAR memory at PROBE+80. The cart exports
    ;; dbg_b/dbg_c/..., but romdev's \`wasm\` tool has no op that CALLS an
    ;; arbitrary export (conformance|info|exports|debugState|events|read|
    ;; write|save), and \`debugState\` needs the WC_FLAG_DEBUG ABI this cart
    ;; does not implement. wasm read ops see linear memory only, so a
    ;; register that stays in a wasm GLOBAL is invisible through the host -
    ;; the same reason the liveness counters are mirrored above.
    (i32.store (i32.const ${PROBE + 80}) (global.get $a))
    (i32.store (i32.const ${PROBE + 84}) (global.get $b))
    (i32.store (i32.const ${PROBE + 88}) (global.get $c))
    (i32.store (i32.const ${PROBE + 92}) (global.get $d))
    (i32.store (i32.const ${PROBE + 96}) (global.get $e))
    (i32.store (i32.const ${PROBE + 100}) (global.get $h))
    (i32.store (i32.const ${PROBE + 104}) (global.get $l))
    (i32.store (i32.const ${PROBE + 108}) (global.get $f))
    (i32.store (i32.const ${PROBE + 112}) (global.get $sp))
    (i32.store (i32.const ${PROBE + 116}) (global.get $rombank))
    (i32.store (i32.const ${PROBE + 120}) (global.get $ime))
    ;; indexed -> RGBA
    (local.set $i (i32.const 0))
    (block $pd (loop $pl
      (br_if $pd (i32.ge_u (local.get $i) (i32.const ${FB_W*FB_H})))
      (i32.store (i32.add (i32.const ${FB}) (i32.mul (local.get $i) (i32.const 4)))
        (call $gb_shade (i32.load8_u (i32.add (i32.const ${GBFB})
                                              (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pl))))

  (func (export "dbg_pc") (result i32) (global.get $pc))
  (func (export "dbg_curpc") (result i32) (global.get $curpc))
  (func (export "dbg_trapped") (result i32) (global.get $trapped))
  (func (export "dbg_trappc") (result i32) (global.get $trappc))
  (func (export "dbg_steps") (result i32) (global.get $steps))
  (func (export "dbg_step") (call $step))
  (func (export "dbg_lastid") (result i32) (global.get $lastid))
  (func (export "dbg_a") (result i32) (global.get $a))
  (func (export "dbg_b") (result i32) (global.get $b))
  (func (export "dbg_c") (result i32) (global.get $c))
  (func (export "dbg_d") (result i32) (global.get $d))
  (func (export "dbg_e") (result i32) (global.get $e))
  (func (export "dbg_h") (result i32) (global.get $h))
  (func (export "dbg_l") (result i32) (global.get $l))
  (func (export "dbg_ime") (result i32) (global.get $ime))
  (func (export "dbg_halted") (result i32) (global.get $halted))
  (func (export "dbg_f") (result i32) (global.get $f))
  (func (export "dbg_sp") (result i32) (global.get $sp))
  (func (export "dbg_ly") (result i32) (global.get $ly))
  (func (export "dbg_bank") (result i32) (global.get $rombank))
`);
  yield part(`  (data (i32.const ${ROMIMG}) "${watBytes(img)}")`);
  yield part(")");
  if (o.breakArm != null && !broken) throw new Error(`gb recompile: options.breakArm $${o.breakArm.toString(16)} is not an instruction address of this cart`);
  if (o.stats) Object.assign(o.stats, { arms: addrs.length, lowered: ok, trapped: bad, shards: nShards, pages, origin: ORIGIN, ...(broken ? { brokenArms: broken } : {}) });
}

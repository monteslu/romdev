// Game Boy / Game Boy Color whole-ROM WAT emitter: one dispatch arm per ROM
// offset, sharded br_table dispatch, a pc -> arm table built at init from a
// packed list, the gambatte-derived machine model (hw-gbc.js) and the CGB or
// DMG PPU.
//
// Ported from the earlier Python emitter (the "NEW" machine model it builds for
// every CGB and DMG cart). The WAT this produces is identical to the Python
// emitter's for every verified cart; that differential is the port's gate.
import { lower } from "./lower.js";
import * as H from "./hw-gb.js";
import * as P from "./hw-gbc.js";
import { ppuShadowWat } from "./ppu-shadow.js";
import * as A from "./apu.js";
import { assertHostSpans, WC_ABI_VERSION } from "../cart-abi.js";
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
export /** mode-3 prediction scratch: the line's sprite X list (10 bytes) */
const M3SPR = 0x11480;
// the gambatte PPU timing shadow (ppu-shadow.js): its sprite list and the
// line sprite maps
const GPSPX = 0x11600, GPMAP = 0x11610, GPMAP2 = 0x11620;
// its SpriteMapper: the OamReader's position buffer (80) and sizes (40), the
// per-line counts (144) and maps (144 x 10)
const GPBUF = 0x11700, GPSZ = 0x11750, GPNUM = 0x11780, GPSMAP = 0x11810;
// its renderer's sprite-list fields and CGB OAM-id table (0x11E00-0x11E68)
const GPSCR = 0x11E00;

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
  // The host-written spans (ABI v4: 80 bytes of pads at ABI+0x100, the
  // clock at ABI+0x180) against each other and everything around them.
  assertHostSpans({ who: "gb", info: ABI, input: ABI + 0x100, time: ABI + 0x180,
    audio: A.APU_LAYOUT.ring, audioBytes: A.APU_LAYOUT.ringCap * 4, audioWrite: A.APU_LAYOUT.writeCursor,
    others: [["VRAM/IO", 0, 0x10000], ["PROBE", PROBE, 4096 + 2048 * 16], ["ROM", ROMIMG, romEnd - ROMIMG], ["FB", FB, FB_W * FB_H * 4],
      ["PCTAB", PCTAB, PCSPAN * 4], ["APU state", A.APU, 0x10], ["APU buffers", A.APU_LAYOUT.mute, A.APU_LAYOUT.ring - A.APU_LAYOUT.mute]] });
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
    (i32.store offset=24 (local.get $tr) ${pair("a", "f")})
    (i32.store offset=28 (local.get $tr) (global.get $abscc))`;
}

/** RAM-code provenance table base and the page count, given the arm count. */
export function gbOriginAndPages(L, nArms) {
  const ORIGIN = (L.PACKED + nArms * 8 + 0x1000 + 0xFFF) & ~0xFFF;
  // cart RAM banks 4-15 (gambatte allocates 16 banks for header codes 4/5)
  const CRAMHI = (ORIGIN + 0x8080 * 4 + 0xFFF) & ~0xFFF;
  const pages = Math.floor((CRAMHI + P.CRAMHI_BYTES + 0xFFFF) / 65536) + 1;
  return { ORIGIN, CRAMHI, pages };
}

/** options.traceEntries: the whole-frame ring's entry size and maximum length. */
export const BIGRING_STRIDE = 32;
export const BIGRING_MAX = 1 << 22;

/**
 * options.traceEntries: where the whole-frame instruction ring goes (above
 * everything gbOriginAndPages placed, so the default map is untouched) and
 * the page count with it. A u32 count of entries written at `cursor`, then
 * the entries (32 bytes): {pc, rombank, sp, hl, bc, de, a<<8|f, clock}, written for
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
  ;; the DMG halt bug: the next opcode is fetched without advancing pc
  (global $hbug (mut i32) (i32.const 0))
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
  ;; absolute cycle of the next TIMA interrupt (0 = timer off), and the
  ;; lazy timer's last update and reload time (see $tupd)
  (global $timairq (mut i32) (i32.const 0))
  ;; the cycle the last timer interrupt was requested at
  (global $tirqat (mut i32) (i32.const 0))
  ;; $ifsync: events looked at this many cycles into the instruction, and
  ;; a line-144 VBlank request already made by an IF access
  (global $ahead (mut i32) (i32.const 0))
  (global $m1early (mut i32) (i32.const 0))
  (global $tlast (mut i32) (i32.const 0))
  (global $tmat (mut i32) (i32.const 0))
  (global $tmaon (mut i32) (i32.const 0))

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

  (global $m2done (mut i32) (i32.const 0))
  ;; gambatte LCD statReg_ (the last STAT written) and the event model
  (global $statreg (mut i32) (i32.const 0))
  (global $tly (mut i32) (i32.const 0))
  (global $tttn (mut i32) (i32.const 0))
  (global $lyct (mut i32) (i32.const -1))
  (global $lycr (mut i32) (i32.const 0))
  (global $lycs (mut i32) (i32.const 0))
  (global $lycrs (mut i32) (i32.const 0))
  (global $lycss (mut i32) (i32.const 0))
  (global $m2t (mut i32) (i32.const -1))
  (global $m2s (mut i32) (i32.const 0))
  (global $m1s (mut i32) (i32.const 0))
  (global $m0s (mut i32) (i32.const 0))
  (global $m0l (mut i32) (i32.const 0))
  (global $m0arm (mut i32) (i32.const 0))
  (global $m0next (mut i32) (i32.const 0))
  (global $onet (mut i32) (i32.const -1))
  (global $m0done (mut i32) (i32.const 1))
  (global $hdmadone (mut i32) (i32.const 1))
  (global $hdmaforce (mut i32) (i32.const 0))
  ;; this line's mode-3 end (xpos 167) in video dots from the line start, and
  ;; the HBlank STAT / HDMA event times in CPU cycles from the line start
  (global $m0dot (mut i32) (i32.const 252))
  (global $m0irqat (mut i32) (i32.const 0))
  (global $hdmaat (mut i32) (i32.const 0))
  (global $wemaster (mut i32) (i32.const 0))

  ;; gambatte ppu.cpp's mode-3 PREDICTION for the current line: video
  ;; cycles from the line start until the pixel pipeline reaches xpos
  ;; \$target. m3StartLineCycle 83, then M3Start (SCX&7 + 1 - cgb), then
  ;; M3Loop::Tile (one per pixel, +6 where the window starts, and the
  ;; sprite fetch penalties of addSpriteCycles over the line's sprites in X
  ;; order).
  (func $m3predict (param $target i32) (result i32)
    (local $lcdc i32) (local $scx7 i32) (local $c i32) (local $nwx i32) (local $wx i32)
    (local $h i32) (local $n i32) (local $i i32) (local $y i32) (local $x i32) (local $j i32)
    (local $first i32) (local $prev i32) (local $fno i32) (local $k i32)
    (local.set $lcdc (i32.load8_u (i32.const ${IO + 0x40})))
    (local.set $scx7 (i32.and (i32.load8_u (i32.const ${IO + 0x43})) (i32.const 7)))
    (local.set $c (i32.add (i32.add (i32.const ${83 + 1}) (local.get $scx7)) (local.get $target)))
    ${cgb ? '(local.set $c (i32.sub (local.get $c) (i32.const 1)))' : ''}
    (local.set $nwx (i32.const 0xFF))
    (local.set $wx (i32.load8_u (i32.const ${IO + 0x4B})))
    (if (i32.and (i32.and (i32.lt_u (local.get $wx) (local.get $target))
                          (i32.ne (i32.and (local.get $lcdc) (i32.const 0x20)) (i32.const 0)))
                 (i32.and (i32.or (global.get $wemaster)
                                  (i32.eq (i32.load8_u (i32.const ${IO + 0x4A})) (global.get $ln)))
                          ${cgb ? '(i32.const 1)' : '(i32.ne (local.get $wx) (i32.const 166))'}))
      (then (local.set $nwx (local.get $wx)) (local.set $c (i32.add (local.get $c) (i32.const 6)))))
    ${cgb ? '' : '(if (i32.eqz (i32.and (local.get $lcdc) (i32.const 2))) (then (return (local.get $c))))'}
    ;; an OAM DMA hides every sprite from the PPU (startOamDma)
    (if (i32.lt_u (global.get $dmapos) (i32.const 0xA0)) (then (return (local.get $c))))
    ;; the line's sprites: up to 10 in OAM order, stable-sorted by X
    (local.set $h (if (result i32) (i32.and (local.get $lcdc) (i32.const 4)) (then (i32.const 16)) (else (i32.const 8))))
    (local.set $i (i32.const 0))
    (block $sd (loop $sl
      (br_if $sd (i32.ge_u (local.get $i) (i32.const 40)))
      (br_if $sd (i32.ge_u (local.get $n) (i32.const 10)))
      (local.set $y (i32.load8_u (i32.add (i32.const ${OAM}) (i32.shl (local.get $i) (i32.const 2)))))
      (if (i32.lt_u (i32.sub (global.get $ln) (i32.sub (local.get $y) (i32.const 16))) (local.get $h))
        (then
          (local.set $x (i32.load8_u (i32.add (i32.const ${OAM + 1}) (i32.shl (local.get $i) (i32.const 2)))))
          ;; insertion: after every earlier entry with x <= this x
          (local.set $j (local.get $n))
          (block $id (loop $il
            (br_if $id (i32.eqz (local.get $j)))
            (br_if $id (i32.le_u (i32.load8_u (i32.add (i32.const ${M3SPR - 1}) (local.get $j))) (local.get $x)))
            (i32.store8 (i32.add (i32.const ${M3SPR}) (local.get $j))
              (i32.load8_u (i32.add (i32.const ${M3SPR - 1}) (local.get $j))))
            (local.set $j (i32.sub (local.get $j) (i32.const 1)))
            (br $il)))
          (i32.store8 (i32.add (i32.const ${M3SPR}) (local.get $j)) (local.get $x))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sl)))
    (if (i32.eqz (local.get $n)) (then (return (local.get $c))))
    (local.set $first (i32.and (i32.sub (i32.const 8) (local.get $scx7)) (i32.const 7)))
    (local.set $prev (i32.and (i32.sub (i32.const 0) (local.get $first)) (i32.const -8)))
    (local.set $fno (if (result i32) (i32.lt_u (local.get $scx7) (i32.const 5)) (then (local.get $scx7)) (else (i32.const 5))))
    (local.set $x (i32.load8_u (i32.const ${M3SPR})))
    (if (i32.and (i32.lt_s (i32.add (local.get $fno) (local.get $x)) (i32.const 5))
                 (i32.le_u (local.get $x) (local.get $nwx)))
      (then (local.set $c (i32.add (local.get $c) (i32.sub (i32.const 11) (i32.add (local.get $fno) (local.get $x)))))
            (local.set $k (i32.const 1))))
    (if (i32.lt_s (local.get $nwx) (local.get $target))
      (then
        (local.set $k (call $m3spr (local.get $k) (local.get $n) (local.get $nwx) (local.get $first) (local.get $prev)))
        (local.set $first (i32.add (local.get $nwx) (i32.const 1)))
        (local.set $prev (i32.const 1))))
    (local.set $k (call $m3spr (local.get $k) (local.get $n) (local.get $target) (local.get $first) (local.get $prev)))
    (i32.add (local.get $c) (global.get $m3acc)))

  (global $m3acc (mut i32) (i32.const 0))
  ;; addSpriteCycles: sprites from $k with X <= $max; the penalties go to
  ;; $m3acc (reset by $m3setup); returns the next sprite
  (func $m3spr (param $k i32) (param $n i32) (param $max i32) (param $first i32) (param $prev i32) (result i32)
    (local $x i32) (local $d i32) (local $tile i32) (local $c i32)
    (block $d0 (loop $l0
      (br_if $d0 (i32.ge_u (local.get $k) (local.get $n)))
      (local.set $x (i32.load8_u (i32.add (i32.const ${M3SPR}) (local.get $k))))
      (br_if $d0 (i32.gt_u (local.get $x) (local.get $max)))
      (local.set $c (i32.const 6))
      (local.set $d (i32.and (i32.sub (local.get $x) (local.get $first)) (i32.const 7)))
      (local.set $tile (i32.and (i32.sub (local.get $x) (local.get $first)) (i32.const -8)))
      (if (i32.and (i32.lt_u (local.get $d) (i32.const 5)) (i32.ne (local.get $tile) (local.get $prev)))
        (then (local.set $c (i32.sub (i32.const 11) (local.get $d)))))
      (local.set $prev (local.get $tile))
      (global.set $m3acc (i32.add (global.get $m3acc) (local.get $c)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l0)))
    (local.get $k))

  ;; per visible line: the mode-0 time and the HBlank STAT / HDMA event times
  (func $m3setup
    (local $x166 i32) (local $ls i32) (local $t i32)
    (if (i32.or (i32.ge_u (global.get $ln) (i32.const 144))
                (i32.eqz (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))))
      (then (global.set $m0done (i32.const 1)) (global.set $hdmadone (i32.const 1))
            (global.set $m0dot (i32.const 252)) (return)))
    ;; weMaster: the window is live from the line where LY == WY (checked at
    ;; the end of the previous line and after the LY change), from line 0 on
    (if (i32.eqz (global.get $ln))
      (then (global.set $wemaster (i32.and (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x20)) (i32.const 0))
                                           (i32.eqz (i32.load8_u (i32.const ${IO + 0x4A}))))))
      (else (if (i32.and (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x20)) (i32.const 0))
                         (i32.or (i32.eq (i32.load8_u (i32.const ${IO + 0x4A})) (global.get $ln))
                                 (i32.eq (i32.load8_u (i32.const ${IO + 0x4A})) (i32.sub (global.get $ln) (i32.const 1)))))
              (then (global.set $wemaster (i32.const 1))))))
    ;; the gambatte PPU shadow: run it to the line start
    (call $gp_update (i32.sub (i32.add (global.get $abscc) (global.get $cyc)) (global.get $linelen)))
    (global.set $m0inval (i32.const 0))
    (global.set $m3acc (i32.const 0))
    (global.set $m0dot (call $m3predict (i32.const 167)))
    (global.set $m3acc (i32.const 0))
    (local.set $x166 (call $m3predict (i32.const 166)))
    ;; double speed: the PPU runs m2_ds_offset (3) video cycles behind LY
    ;; (ppu.cpp: vcycs = videoCycles - ds * m2_ds_offset)
    (global.set $m0dot (i32.add (global.get $m0dot) (i32.mul (global.get $speed) (i32.const 3))))
    (local.set $x166 (i32.add (local.get $x166) (i32.mul (global.get $speed) (i32.const 3))))
    (global.set $m0irqat (i32.add (i32.shl (local.get $x166) (global.get $speed))
                                  (i32.sub (i32.const ${cgb ? 1 : 0}) (global.get $speed))))
;; gambatte predicts from its PPU's state, not from the line start: the
    ;; shadow's word wins (the two differ where the PPU is not where a fresh
    ;; line would put it, e.g. the line after a speed switch)
    (if (i32.ge_u (global.get $gpst) (i32.const 3))
      (then
        (local.set $ls (i32.sub (i32.add (global.get $abscc) (global.get $cyc)) (global.get $linelen)))
        (local.set $t (i32.shr_s (i32.sub (call $gp_predict (i32.const 167)) (local.get $ls)) (global.get $speed)))
        (global.set $m0dot (local.get $t))
        (global.set $m0irqat (i32.sub (i32.add (call $gp_predict (i32.const 166)) (i32.sub (i32.const ${cgb ? 1 : 0}) (global.get $speed)))
                                      (local.get $ls)))))
    (global.set $hdmaat (i32.add (i32.shl (global.get $m0dot) (global.get $speed))
                                 (i32.sub (i32.const 1) (global.get $speed))))
    (global.set $m0done (i32.const 0))
    ;; a flag (0/1): the candidate tests AND it with (eqz $m0done), and the
    ;; STAT bit value 8 AND 1 is 0 - the line's mode-0 event never fired
    (global.set $m0arm (i32.ne (global.get $m0next) (i32.const 0)))
    (global.set $hdmadone (i32.const 0)))
  ;; LCD::mode3CyclesChange: a register the mode-3 length depends on
  ;; changed; the rest of the CURRENT line is re-predicted from the PPU
  ;; shadow's state (a shadow already on the next line's mode 2 leaves it:
  ;; that line's start predicts it). The mode-0 STAT event moves only while
  ;; it is still ahead, as does the HDMA block.
  (func $gp_m3change
    (local $ls i32) (local $t i32)
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))) (then (return)))
    (if (i32.lt_u (global.get $gpst) (i32.const 3)) (then (return)))
    (if (i32.ge_u (global.get $ln) (i32.const 144)) (then (return)))
    (local.set $ls (i32.sub (global.get $gptime) (i32.shl (i32.const 456) (global.get $gpds))))
    ;; nextM0Time_ is only invalidated: the next access that needs the
    ;; line's mode-0 time predicts it from the PPU state THEN ($m0sync), not
    ;; now, except with an HBlank DMA pending, which predicts at once
    (global.set $m0inval (i32.const 1))
    (if (i32.and (i32.eqz (global.get $hdmadone)) (i32.ne (global.get $hdma_on) (i32.const 0)))
      (then (global.set $m0inval (i32.const 0))
            (global.set $m0dot (i32.shr_s (i32.sub (call $gp_predict (i32.const 167)) (local.get $ls)) (global.get $speed)))))
    (if (i32.eqz (global.get $m0done))
      (then (global.set $m0irqat (i32.sub (i32.add (call $gp_predict (i32.const 166)) (i32.sub (i32.const ${cgb ? 1 : 0}) (global.get $speed)))
                                          (local.get $ls)))))
    (if (i32.and (i32.eqz (global.get $hdmadone)) (i32.ne (global.get $hdma_on) (i32.const 0)))
      (then (global.set $hdmaat (i32.add (i32.shl (global.get $m0dot) (global.get $speed))
                                         (i32.sub (i32.const 1) (global.get $speed)))))))
  ;; LCD::m0TimeOfCurrentLine after an invalidation: predict from the PPU
  ;; state at the access cycle; a prediction past this line means its mode 0
  ;; has happened (lastM0Time)
  (global $m0inval (mut i32) (i32.const 0))
  (func $m0sync (param $cc i32)
    (local $t i32) (local $ls i32)
    ;; the PPU's own events (a sprite-map rebuild) due by cc run first
    (call $gp_update (local.get $cc))
    (if (i32.eqz (global.get $m0inval)) (then (return)))
    (global.set $m0inval (i32.const 0))
    (local.set $ls (i32.sub (global.get $gptime) (i32.shl (i32.const 456) (global.get $gpds))))
    (local.set $t (call $gp_predict (i32.const 167)))
    (if (i32.lt_s (i32.sub (local.get $t) (global.get $gptime)) (i32.const 0))
      (then (global.set $m0dot (i32.shr_s (i32.sub (local.get $t) (local.get $ls)) (global.get $speed))))
      (else (if (i32.ge_s (i32.sub (global.get $gplastm0) (local.get $ls)) (i32.const 0))
        (then (global.set $m0dot (i32.shr_s (i32.sub (global.get $gplastm0) (local.get $ls)) (global.get $speed))))))))
  (global $lyc0done (mut i32) (i32.const 0))

  ;; STAT events that fall INSIDE a line (gambatte video.cpp):
  ;; mode 2 for lines 1..143 four cycles before the line starts
  ;; (mode2IrqSchedule, doMode2IrqEvent), and LYC=0 eight video cycles into
  ;; line 153 (lyc_irq.cpp schedule). Checked after every instruction; a
  ;; request is taken before the next instruction.
  ;; ---- the LCD's STAT/LYC event model, ported from gambatte video.cpp,
  ;; lyc_irq.cpp and m0_irq.h. Event times are ABSOLUTE ($abscc = gambatte's
  ;; cycleCounter); the LY change is the cart's line start, so lytime =
  ;; $abscc + $cyc. Latched registers ($lycr/$lycs, $m2s, $m1s, $m0s/$m0l)
  ;; follow gambatte's latch rules for writes close to an event.
  ;; DIS = never.

  ;; LY and lytime as gambatte's LY counter has them at cycle $cc (past the
  ;; cart's line end, LY has already advanced): LY returned, lytime in $tly
  (func $lyat (param $cc i32) (result i32)
    (local $ly i32)
    (global.set $tly (i32.add (global.get $abscc) (global.get $cyc)))
    (local.set $ly (global.get $ln))
    (if (i32.ge_s (i32.sub (local.get $cc) (global.get $tly)) (i32.const 0))
      (then
        (global.set $tly (i32.add (global.get $tly) (global.get $linelen)))
        (local.set $ly (i32.add (local.get $ly) (i32.const 1)))
        (if (i32.ge_u (local.get $ly) (i32.const 154)) (then (local.set $ly (i32.const 0))))))
    (local.get $ly))

  ;; LyCounter::nextFrameCycle
  (func $nfc (param $fc i32) (param $cc i32) (result i32)
    (local $ly i32) (local $tmp i32)
    (local.set $ly (call $lyat (local.get $cc)))
    (local.set $tmp (i32.add (global.get $tly)
      (i32.shl (i32.add (i32.mul (i32.sub (i32.const 153) (local.get $ly)) (i32.const 456)) (local.get $fc))
               (global.get $speed))))
    (if (i32.gt_u (i32.sub (local.get $tmp) (local.get $cc)) (i32.shl (i32.const 70224) (global.get $speed)))
      (then (local.set $tmp (i32.sub (local.get $tmp) (i32.shl (i32.const 70224) (global.get $speed))))))
    (local.get $tmp))

  ;; lyc_irq.cpp schedule()
  (func $lycsched (param $st i32) (param $lyc i32) (param $cc i32) (result i32)
    (if (result i32) (i32.and (i32.ne (i32.and (local.get $st) (i32.const 0x40)) (i32.const 0))
                              (i32.lt_u (local.get $lyc) (i32.const 154)))
      (then (call $nfc (if (result i32) (local.get $lyc)
                          (then (i32.mul (local.get $lyc) (i32.const 456)))
                          (else (i32.const ${153 * 456 + 8})))
                       (local.get $cc)))
      (else (i32.const -1))))

  (func $minu (param $a i32) (param $b i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $a) (local.get $b)) (then (local.get $a)) (else (local.get $b))))

  ;; LycIrq::regChange
  (func $lycregchange (param $st i32) (param $lyc i32) (param $cc i32)
    (local $src i32) (local $d i32)
    (local.set $src (call $lycsched (local.get $st) (local.get $lyc) (local.get $cc)))
    (global.set $lycss (local.get $st))
    (global.set $lycrs (local.get $lyc))
    (global.set $lyct (call $minu (global.get $lyct) (local.get $src)))
    (local.set $d (i32.sub (global.get $lyct) (local.get $cc)))
    ${cgb ? `(if (i32.or (i32.gt_u (local.get $d) (i32.const 8))
                (i32.and (i32.ne (local.get $src) (global.get $lyct))
                         (i32.gt_u (local.get $d) (i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2))))))
      (then (global.set $lycr (local.get $lyc))))
    (if (i32.gt_u (local.get $d) (i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2))))
      (then (global.set $lycs (local.get $st))))` : `(if (i32.or (i32.gt_u (local.get $d) (i32.const 4)) (i32.ne (local.get $src) (global.get $lyct)))
      (then (global.set $lycr (local.get $lyc))))
    (if (i32.or (i32.gt_u (local.get $d) (i32.const 4)) (i32.ne (global.get $lycr) (i32.const 0)))
      (then (global.set $lycs (local.get $st))))
    (global.set $lycs (i32.or (i32.and (global.get $lycs) (i32.const 0x40)) (i32.and (local.get $st) (i32.const 0xBF))))`})

  ;; video.cpp mode2IrqSchedule
  (func $m2sched (param $st i32) (param $cc i32) (result i32)
    (local $ly i32) (local $next i32)
    (if (i32.eqz (i32.and (local.get $st) (i32.const 0x20))) (then (return (i32.const -1))))
    (local.set $ly (call $lyat (local.get $cc)))
    (local.set $next (i32.sub (global.get $tly) (local.get $cc)))
    (if (i32.or (i32.or (i32.ge_u (local.get $ly) (i32.const 143))
                        (i32.and (i32.eq (local.get $ly) (i32.const 142)) (i32.le_u (local.get $next) (i32.const 4))))
                (i32.ne (i32.and (local.get $st) (i32.const 0x08)) (i32.const 0)))
      (then (local.set $next (i32.add (local.get $next)
              (i32.mul (i32.sub (i32.const 153) (local.get $ly)) (global.get $linelen)))))
      (else
        (if (i32.le_u (local.get $next) (i32.const 4)) (then (local.set $next (i32.add (local.get $next) (global.get $linelen)))))
        (local.set $next (i32.sub (local.get $next) (i32.const 4)))))
    (i32.add (local.get $cc) (local.get $next)))

  ;; (re)start every LCD event at LCD enable or power-on (lcdcChange,
  ;; loadState): the latches take the written registers
  (func $lcdevreset (param $cc i32) (param $enable i32)
    (global.set $lycss (global.get $statreg))
    (global.set $lycrs (i32.load8_u (i32.const ${IO + 0x45})))
    (global.set $lycs (global.get $lycss))
    (global.set $lycr (global.get $lycrs))
    (global.set $m0s (global.get $statreg))
    (global.set $m0l (global.get $lycr))
    (global.set $m1s (global.get $statreg))
    (global.set $m2s (global.get $statreg))
    (if (i32.and (local.get $enable)
          (i32.and (i32.eqz (global.get $lycr)) (i32.ne (i32.and (global.get $statreg) (i32.const 0x40)) (i32.const 0))))
      (then (call $irq (i32.const 2))))
    (global.set $lyct (call $minu (call $lycsched (global.get $lycs) (global.get $lycr) (local.get $cc))
                                  (call $lycsched (global.get $lycss) (global.get $lycrs) (local.get $cc))))
    (global.set $m2t (call $m2sched (global.get $statreg) (local.get $cc)))
    (global.set $onet (i32.const -1)))

  ;; the start of LY's line, and the mode-0 time, at cycle $cc (for the
  ;; write handlers below): this line's predicted mode 0
  (func $m0timeat (param $cc i32) (result i32)
    (call $m0sync (local.get $cc))
    (drop (call $lyat (local.get $cc)))
    (i32.add (i32.sub (global.get $tly) (global.get $linelen)) (i32.shl (global.get $m0dot) (global.get $speed))))

  ;; the pending mode-0 STAT event's time, or DIS
  (func $m0evt (result i32)
    (if (result i32) (i32.and (i32.eqz (global.get $m0done)) (global.get $m0arm))
      (then (i32.add (i32.sub (i32.add (global.get $abscc) (global.get $cyc)) (global.get $linelen)) (global.get $m0irqat)))
      (else (i32.const -1))))

  ;; getLycCmpLy: LY for the LYC compare (153 compares as 0 after its first
  ;; 8 cycles) -> returned; its time to the next change in $tttn
  (func $lyccmp (param $cc i32) (result i32)
    (local $ly i32)
    (local.set $ly (call $lyat (local.get $cc)))
    (global.set $tttn (i32.sub (global.get $tly) (local.get $cc)))
    (if (i32.eq (local.get $ly) (i32.const 153))
      (then
        (if (i32.gt_s (i32.sub (global.get $tttn) (i32.shl (i32.const 448) (global.get $speed))) (i32.const 0))
          (then (global.set $tttn (i32.sub (global.get $tttn) (i32.shl (i32.const 448) (global.get $speed)))))
          (else (local.set $ly (i32.const 0))
                (global.set $tttn (i32.add (global.get $tttn) (global.get $linelen)))))))
    (local.get $ly))

  ;; $FF41 written at $cc: LCD::lcdstatChange
  (func $statwrite (param $data i32) (param $cc i32)
    (local $old i32) (local $ttn i32) (local $ly i32) (local $cly i32) (local $lycp i32) (local $m1t i32) (local $irq i32)
    (local.set $old (global.get $statreg))
    (global.set $statreg (local.get $data))
    (call $lycregchange (local.get $data) (global.get $lycrs) (local.get $cc))
    (if (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))
      (then
        (local.set $ly (call $lyat (local.get $cc)))
        (local.set $ttn (i32.sub (global.get $tly) (local.get $cc)))
        (local.set $cly (call $lyccmp (local.get $cc)))
        ${cgb ? `(if (i32.and (local.get $data) (i32.and (i32.xor (local.get $old) (i32.const -1)) (i32.const 0x78)))
          (then
            (local.set $lycp (i32.and (i32.eq (local.get $cly) (global.get $lycr))
                                      (i32.gt_s (global.get $tttn) (i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2))))))
            (if (i32.eqz (i32.and (local.get $lycp) (i32.ne (i32.and (local.get $old) (i32.const 0x40)) (i32.const 0))))
              (then
                (if (i32.lt_u (local.get $ly) (i32.const 144))
                  (then
                    (if (i32.or (i32.lt_u (i32.add (local.get $cc) (i32.shl (global.get $speed) (i32.const 1))) (call $m0timeat (local.get $cc)))
                                (i32.le_s (local.get $ttn) (i32.const 4)))
                      (then (if (i32.and (local.get $lycp) (i32.ne (i32.and (local.get $data) (i32.const 0x40)) (i32.const 0)))
                              (then (local.set $irq (i32.const 1)))))
                      (else (if (i32.eqz (i32.and (local.get $old) (i32.const 0x08)))
                              (then (if (i32.or (i32.ne (i32.and (local.get $data) (i32.const 0x08)) (i32.const 0))
                                                (i32.and (local.get $lycp) (i32.ne (i32.and (local.get $data) (i32.const 0x40)) (i32.const 0))))
                                      (then (local.set $irq (i32.const 1)))))))))
                  (else (if (i32.eqz (i32.and (local.get $old) (i32.const 0x10)))
                    (then
                      (if (i32.and (i32.ne (i32.and (local.get $data) (i32.const 0x10)) (i32.const 0))
                                   (i32.or (i32.lt_u (local.get $ly) (i32.const 153))
                                           (i32.gt_s (local.get $ttn) (i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2))))))
                        (then (local.set $irq (i32.const 1)))
                        (else (if (i32.and (local.get $lycp) (i32.ne (i32.and (local.get $data) (i32.const 0x40)) (i32.const 0)))
                                (then (local.set $irq (i32.const 1))))))))))))
            (if (i32.and (i32.and (i32.eq (i32.and (local.get $data) (i32.const 0x28)) (i32.const 0x20))
                                  (i32.eqz (i32.and (local.get $old) (i32.const 0x20))))
                         (i32.or (i32.and (i32.le_s (local.get $ttn) (i32.const 4)) (i32.lt_u (local.get $ly) (i32.const 143)))
                                 (i32.and (i32.eq (local.get $ttn) (i32.const 912)) (i32.lt_u (local.get $ly) (i32.const 144)))))
              (then (local.set $irq (i32.const 1))))))` : `(if (i32.lt_u (local.get $ly) (i32.const 144))
          (then
            (if (i32.lt_u (i32.add (local.get $cc) (i32.const 1)) (call $m0timeat (local.get $cc)))
              (then (if (i32.and (i32.eq (local.get $cly) (global.get $lycr)) (i32.eqz (i32.and (local.get $old) (i32.const 0x40))))
                      (then (local.set $irq (i32.const 1)))))
              (else (if (i32.and (i32.eqz (i32.and (local.get $old) (i32.const 0x08)))
                                 (i32.eqz (i32.and (i32.eq (local.get $cly) (global.get $lycr)) (i32.ne (i32.and (local.get $old) (i32.const 0x40)) (i32.const 0)))))
                      (then (local.set $irq (i32.const 1)))))))
          (else (if (i32.and (i32.eqz (i32.and (local.get $old) (i32.const 0x10)))
                             (i32.eqz (i32.and (i32.eq (local.get $cly) (global.get $lycr)) (i32.ne (i32.and (local.get $old) (i32.const 0x40)) (i32.const 0)))))
                  (then (local.set $irq (i32.const 1))))))`}
        (if (local.get $irq) (then (call $irq (i32.const 2))))
        ;; enabling mode 0 with no mode-0 event pending arms one at the next
        ;; xpos-166 time (predictedNextXposTime): this line's when it is
        ;; still ahead of the write, else the next line's
        (if (i32.and (i32.ne (i32.and (local.get $data) (i32.const 0x08)) (i32.const 0))
                     (i32.eq (call $m0evt) (i32.const -1)))
          (then (global.set $m0arm (i32.const 1)) (global.set $m0next (i32.const 0x08))
                (if (i32.ge_s (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (call $ioff)) (global.get $m0irqat))
                  (then (global.set $m0done (i32.const 1))))))
        (global.set $m2t (call $m2sched (local.get $data) (local.get $cc)))))
    ;; the mode 2 / mode 1 / mode 0 sources latch the new STAT unless their
    ;; event is (almost) due
    (global.set $m2s (if (result i32) (i32.gt_u (i32.sub (global.get $m2t) (local.get $cc)) ${cgb ? '(i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2)))' : '(i32.const 0)'})
      (then (local.get $data))
      (else (i32.or (i32.and (global.get $m2s) (i32.const 0x10)) (i32.and (local.get $data) (i32.const 0xEF))))))
    (local.set $m1t (if (result i32) (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))
      (then (call $nfc (i32.const ${144 * 456}) (local.get $cc))) (else (i32.const -1))))
    (global.set $m1s (if (result i32) (i32.gt_u (i32.sub (local.get $m1t) (local.get $cc)) ${cgb ? '(i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2)))' : '(i32.const 0)'})
      (then (local.get $data))
      (else (i32.or (i32.and (global.get $m1s) (i32.const 0x08)) (i32.and (local.get $data) (i32.const 0xF7))))))
    (if (i32.gt_u (i32.sub (call $m0evt) (local.get $cc)) (i32.const ${cgb ? 2 : 0}))
      (then (global.set $m0s (local.get $data)))))

  ;; $FF45 written at $cc: LCD::lycRegChange
  (func $lycwrite (param $data i32) (param $cc i32)
    (local $old i32) (local $ttn i32) (local $ly i32) (local $cly i32) (local $m0t i32)
    (local.set $old (global.get $lycr))
    (if (i32.eq (local.get $data) (local.get $old)) (then (return)))
    (local.set $m0t (call $m0evt))
    (if (i32.gt_u (i32.sub (local.get $m0t) (local.get $cc)) ${cgb ? '(i32.sub (i32.const 6) (global.get $speed))' : '(i32.const 1)'})
      (then (global.set $m0l (local.get $data))))
    (call $lycregchange (global.get $lycss) (local.get $data) (local.get $cc))
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))) (then (return)))
    (local.set $ly (call $lyat (local.get $cc)))
    (local.set $ttn (i32.sub (global.get $tly) (local.get $cc)))
    (if (i32.and (i32.and (i32.ne (i32.and (global.get $statreg) (i32.const 0x40)) (i32.const 0))
                          (i32.lt_u (local.get $data) (i32.const 154)))
                 (if (result i32) (i32.lt_u (local.get $ly) (i32.const 144))
                   (then (i32.or (i32.or (i32.eqz (i32.and (global.get $statreg) (i32.const 0x08)))
                                         (i32.lt_u (local.get $cc) (call $m0timeat (local.get $cc))))
                                 (i32.le_s (local.get $ttn) (i32.const ${cgb ? 8 : 4}))))
                   (else (i32.or (i32.eqz (i32.and (global.get $statreg) (i32.const 0x10)))
                                 ${cgb ? '(i32.and (i32.and (i32.eq (local.get $ly) (i32.const 153)) (i32.le_s (local.get $ttn) (i32.const 4))) (i32.eqz (global.get $speed)))' : '(i32.const 0)'}))))
      (then
        (local.set $cly (call $lyccmp (local.get $cc)))
        (if (i32.le_s (global.get $tttn) (i32.const ${cgb ? 8 : 4}))
          (then (local.set $cly
            (if (result i32) (i32.or (i32.ne (local.get $old) (local.get $cly))
                                     ${cgb ? '(i32.and (i32.le_s (global.get $tttn) (i32.const 4)) (i32.eqz (global.get $speed)))' : '(i32.const 0)'})
              (then (if (result i32) (i32.eq (local.get $cly) (i32.const 153)) (then (i32.const 0)) (else (i32.add (local.get $cly) (i32.const 1)))))
              (else (i32.const 0xFF))))))
        (if (i32.eq (local.get $data) (local.get $cly))
          (then ${cgb ? `(if (global.get $speed)
                   (then (call $irq (i32.const 2)))
                   (else (global.set $onet (i32.add (local.get $cc) (i32.const 5)))))` : '(call $irq (i32.const 2))'})))))

  ;; Process every LCD event due by now that belongs to the current line
  ;; (before the LY change), in time order, then take a requested interrupt
  ;; before the next instruction. Called after every instruction and after
  ;; each line start.
  (func $statev
    (local $now i32) (local $lyt i32) (local $t i32) (local $k i32) (local $hit i32)
    (local $e i32) (local $ly i32) (local $L i32) (local $cmp i32) (local $next i32)
    (if (i32.ne (global.get $dmalast) (i32.const -1)) (then (call $dmaupd (global.get $abscc))))
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))) (then (return)))
    ;; the PPU shadow's own events (SpriteMapper::doEvent, the CGB wy2
    ;; one-shot) at their cycles: they re-predict mode 0 (mode3CyclesChange)
    (if (i32.or (i32.and (global.get $gpsmon) (i32.le_s (i32.sub (global.get $gpsmt) (i32.add (global.get $abscc) (global.get $ahead))) (i32.const 0)))
                (i32.and (global.get $gpwy2on) (i32.le_s (i32.sub (global.get $gpwy2t) (i32.add (global.get $abscc) (global.get $ahead))) (i32.const 0))))
      (then (call $gp_update (i32.add (global.get $abscc) (global.get $ahead)))))
    (block $out (loop $again
      ;; $ahead: an IF access asks for the events due by ITS cycle
      ;; (gambatte Memory::updateIrqs -> LCD::update(cc) before IF is read
      ;; or written), which is $ahead cycles into the running instruction
      (local.set $now (i32.add (global.get $abscc) (global.get $ahead)))
      (local.set $lyt (i32.add (global.get $abscc) (global.get $cyc)))
      (local.set $k (i32.const 0))
      (local.set $t (i32.const -1))
      ;; candidate: due (t <= now) and in this line (t < lytime), earliest first
      (local.set $e (global.get $lyct))
      ;; an IF access past the line end also sees the next line's LYC event
      ;; (LCD::update runs the LY and LYC events due by the access cycle)
      (if (i32.and (i32.and (i32.le_s (i32.sub (local.get $e) (local.get $now)) (i32.const 0))
                            (i32.or (i32.lt_s (i32.sub (local.get $e) (local.get $lyt)) (i32.const 0))
                                    (i32.ne (global.get $ahead) (i32.const 0))))
                   (i32.ne (local.get $e) (i32.const -1)))
        (then (local.set $t (local.get $e)) (local.set $k (i32.const 1))))
      ;; (an IF access past the line end also sees the next line's mode-2
      ;; event: line 0's is at the line start)
      (local.set $e (global.get $m2t))
      (if (i32.and (i32.and (i32.and (i32.le_s (i32.sub (local.get $e) (local.get $now)) (i32.const 0))
                                     (i32.or (i32.lt_s (i32.sub (local.get $e) (local.get $lyt)) (i32.const 0))
                                             (i32.ne (global.get $ahead) (i32.const 0))))
                            (i32.ne (local.get $e) (i32.const -1)))
                   (i32.lt_u (local.get $e) (local.get $t)))
        (then (local.set $t (local.get $e)) (local.set $k (i32.const 2))))
      (local.set $e (global.get $onet))
      (if (i32.and (i32.and (i32.and (i32.le_s (i32.sub (local.get $e) (local.get $now)) (i32.const 0))
                                     (i32.lt_s (i32.sub (local.get $e) (local.get $lyt)) (i32.const 0)))
                            (i32.ne (local.get $e) (i32.const -1)))
                   (i32.lt_u (local.get $e) (local.get $t)))
        (then (local.set $t (local.get $e)) (local.set $k (i32.const 3))))
      (if (i32.and (i32.eqz (global.get $m0done)) (global.get $m0arm))
        (then
          (local.set $e (i32.add (i32.sub (local.get $lyt) (global.get $linelen)) (global.get $m0irqat)))
          (if (i32.and (i32.le_s (i32.sub (local.get $e) (local.get $now)) (i32.const 0))
                       (i32.lt_u (local.get $e) (local.get $t)))
            (then (local.set $t (local.get $e)) (local.set $k (i32.const 4))))))
      (if (global.get $ahead) (then (br_if $out (i32.eqz (local.get $k)))))
      (if (i32.and (global.get $hdmanow) (i32.eqz (global.get $ahead)))
        (then (local.set $k (i32.const 5)))
        (else
          (if (i32.and (i32.eqz (global.get $hdmadone)) (i32.eqz (global.get $ahead)))
            (then
              (local.set $e (i32.add (i32.sub (local.get $lyt) (global.get $linelen)) (global.get $hdmaat)))
              (if (i32.and (i32.le_s (i32.sub (local.get $e) (local.get $now)) (i32.const 0))
                           (i32.lt_u (local.get $e) (local.get $t)))
                (then (local.set $t (local.get $e)) (local.set $k (i32.const 5))))))))
      (br_if $out (i32.eqz (local.get $k)))
      ;; LYC (LycIrq::doEvent)
      (if (i32.eq (local.get $k) (i32.const 1))
        (then
          (if (i32.and (i32.or (global.get $lycs) (global.get $lycss)) (i32.const 0x40))
            (then
              ;; an event past the line end (an IF access, see above) is on the next line
              (local.set $L (global.get $ln))
              (local.set $e (local.get $lyt))
              (if (i32.ge_s (i32.sub (local.get $t) (local.get $lyt)) (i32.const 0))
                (then (local.set $e (i32.add (local.get $lyt) (global.get $linelen)))
                      (local.set $L (if (result i32) (i32.eq (local.get $L) (i32.const 153)) (then (i32.const 0)) (else (i32.add (local.get $L) (i32.const 1)))))))
              (local.set $cmp (if (result i32) (i32.lt_u (i32.sub (local.get $e) (local.get $t)) (global.get $linelen))
                                (then (i32.const 0)) (else (local.get $L))))
              (if (i32.and (i32.eq (global.get $lycr) (local.get $cmp))
                           (i32.eqz (i32.and (global.get $lycs)
                             (if (result i32) (i32.lt_u (i32.sub (global.get $lycr) (i32.const 1)) (i32.const 143))
                               (then (i32.const 0x20)) (else (i32.const 0x10))))))
                (then (call $irq (i32.const 2)) (local.set $hit (i32.const 1))))))
          (global.set $lycr (global.get $lycrs))
          (global.set $lycs (global.get $lycss))
          (global.set $lyct (call $lycsched (global.get $lycs) (global.get $lycr) (local.get $t)))))
      ;; mode 2 (LCD::doMode2IrqEvent)
      (if (i32.eq (local.get $k) (i32.const 2))
        (then
          (local.set $ly (if (result i32) (i32.lt_u (i32.sub (local.get $lyt) (local.get $t)) (i32.const 8))
            (then (if (result i32) (i32.eq (global.get $ln) (i32.const 153)) (then (i32.const 0))
                    (else (i32.add (global.get $ln) (i32.const 1)))))
            (else (global.get $ln))))
          (if (i32.and (i32.or (i32.ne (local.get $ly) (i32.const 0)) (i32.eqz (i32.and (global.get $m2s) (i32.const 0x10))))
                       (i32.or (i32.eqz (i32.and (global.get $m2s) (i32.const 0x40)))
                               (if (result i32) (global.get $lycr)
                                 (then (i32.ne (local.get $ly) (i32.add (global.get $lycr) (i32.const 1))))
                                 (else (i32.gt_u (local.get $ly) (i32.const 1))))))
            (then (call $irq (i32.const 2)) (local.set $hit (i32.const 1))))
          (global.set $m2s (global.get $statreg))
          (if (i32.eqz (i32.and (global.get $statreg) (i32.const 0x08)))
            (then
              (local.set $next (i32.add (local.get $t) (global.get $linelen)))
              (if (i32.eqz (local.get $ly)) (then (local.set $next (i32.sub (local.get $next) (i32.const 4))))
                (else (if (i32.eq (local.get $ly) (i32.const 143))
                  (then (local.set $next (i32.add (local.get $next)
                          (i32.add (i32.mul (global.get $linelen) (i32.const 10)) (i32.const 4))))))))
              (global.set $m2t (local.get $next)))
            (else (global.set $m2t (i32.add (local.get $t) (i32.shl (i32.const 70224) (global.get $speed))))))))
      ;; one-shot STAT request (lycRegChange on CGB single speed)
      (if (i32.eq (local.get $k) (i32.const 3))
        (then (call $irq (i32.const 2)) (local.set $hit (i32.const 1)) (global.set $onet (i32.const -1))))
      ;; mode 0 (M0Irq::doEvent)
      (if (i32.eq (local.get $k) (i32.const 4))
        (then
          (global.set $m0done (i32.const 1))
          (if (i32.and (i32.ne (i32.and (i32.or (global.get $m0s) (global.get $statreg)) (i32.const 0x08)) (i32.const 0))
                       (i32.or (i32.eqz (i32.and (global.get $m0s) (i32.const 0x40)))
                               (i32.ne (global.get $ln) (global.get $m0l))))
            (then (call $irq (i32.const 2)) (local.set $hit (i32.const 1))))
          (global.set $m0s (global.get $statreg))
          (global.set $m0l (global.get $lycr))
          (global.set $m0next (i32.and (global.get $statreg) (i32.const 0x08)))))
      ;; one HBlank DMA block at the mode 0 time + 1 - ds (hdmaTimeFromM0Time),
      ;; or at once when enabled inside this line's HDMA period
      (if (i32.eq (local.get $k) (i32.const 5))
        (then
          (global.set $hdmanow (i32.const 0))
          (global.set $hdmadone (i32.const 1))
          ;; a request flagged before the $FF55 write that disabled it
          (if (global.get $hdmaforce)
            (then
              (global.set $hdmaforce (i32.const 0))
              (local.set $L (global.get $cyc))
              (call $hdma_block (global.get $abscc))
              (global.set $hdma_on (i32.const 0))
              (i32.store8 (i32.const ${IO + 0x55}) (i32.or (i32.load8_u (i32.const ${IO + 0x55})) (i32.const 0x80)))
              (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
              (call $tick (i32.sub (local.get $L) (global.get $cyc)))))
          (if (global.get $hdma_on)
            (then
              ;; the CPU is stalled for the block (16 x 2<<ds) and 4 more
              ;; (gambatte intevent_dma): the clocks advance through it
              (local.set $L (global.get $cyc))
              (call $hdma_block (global.get $abscc))
              (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
              (call $tick (i32.sub (local.get $L) (global.get $cyc)))
              ;; an interrupt requested while the block ran (a timer
              ;; overflow) is taken right after it, before the next instruction
              (local.set $hit (i32.const 1))
              ;; inside STOP's stall the wake-up is at a fixed time
              ;; (intevent_unhalt): the block's cycles are part of it
              (if (i32.gt_s (global.get $stopcd) (i32.const 0))
                (then
                  (global.set $stopcd (i32.sub (global.get $stopcd) (i32.sub (local.get $L) (global.get $cyc))))
                  (if (i32.le_s (global.get $stopcd) (i32.const 0)) (then (global.set $halted (i32.const 0))))))))))
      (br $again)))
    (if (i32.and (i32.and (local.get $hit) (i32.eqz (global.get $ahead)))
          (i32.and (global.get $ime)
            (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0xFF}))
                             (i32.and (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 0x1F)))
                    (i32.const 0))))
      (then (global.set $irqonly (i32.const 1)) (call $step) (global.set $irqonly (i32.const 0)))))

  ;; IF read or written at the access cycle: the LCD requests due by then
  ;; are set first (gambatte Memory::updateIrqs before touching IF): the
  ;; in-line STAT events, and the VBlank request of line 144 when the access
  ;; falls past the end of line 143 (flagged once: $m1early).
  (func $ifsync
    (local $off i32)
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80))) (then (return)))
    (local.set $off (call $ioff))
    (global.set $ahead (local.get $off))
    (call $statev)
    (global.set $ahead (i32.const 0))
    (if (i32.and (i32.and (i32.eq (global.get $ln) (i32.const 143)) (i32.eqz (global.get $m1early)))
                 (i32.ge_s (local.get $off) (global.get $cyc)))
      (then
        (global.set $m1early (i32.const 1))
        (call $irq (if (result i32) (i32.eq (i32.and (global.get $m1s) (i32.const 0x18)) (i32.const 0x10))
                     (then (i32.const 3)) (else (i32.const 1))))
        (global.set $m1s (global.get $statreg)))))

  (func $irq (param $m i32)
    (i32.store8 (i32.const ${IO + 0x0F})
      (i32.or (i32.load8_u (i32.const ${IO + 0x0F})) (local.get $m))))

  ;; halt (gambatte CPU case 0x76): with IME off and an interrupt already
  ;; requested (IF read at the halt's cycle) a DMG does not halt; it sets
  ;; skip_, so the next opcode is fetched without advancing pc
  (func $halt_op
    ${cgb ? "(global.set $halted (i32.const 1))" : `(call $ifsync)
    (if (i32.and (i32.eqz (i32.or (global.get $ime) (global.get $eipend)))
                 (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0xFF}))
                                  (i32.and (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 0x1F))) (i32.const 0)))
      (then (global.set $hbug (i32.const 1)))
      (else (global.set $halted (i32.const 1))))`})

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
    ;; A RAM copy ran as its ROM arm (see _ramcode). Control flow in RAM is
    ;; always interpreted ($ram_interp), so the arm was straight-line code
    ;; and its next pc (a ROM-window address) is the fall-through: move it
    ;; back to the RAM instruction after the copy's. Checking that the next
    ;; RAM byte came from the next ROM byte was wrong for a routine built
    ;; from pieces: the pc stayed in ROM and ran the wrong code.
    (if (global.get $ramexec)
      (then
        (global.set $ramexec (i32.const 0))
        (if (i32.lt_u (global.get $pc) (i32.const 0x8000))
          (then
            (global.set $pc (i32.and (i32.add (global.get $pc) (global.get $rambias))
                                     (i32.const 0xFFFF)))))))
    ;; ---- DIV / TIMA for the instruction, BEFORE the interrupt check: a
    ;; TIMA overflow inside this instruction requests its interrupt at that
    ;; cycle, and gambatte takes it before the next instruction.
    (call $tick (i32.add (i32.sub (local.get $c0) (global.get $cyc)) (global.get $cycbias)))
    (global.set $cycbias (i32.const 0))
    (local.set $c0 (global.get $cyc))
    ;; an HBlank DMA block requested before the timer interrupt that is
    ;; about to be taken runs first (gambatte's events in time order: the
    ;; tima event flags IF, the interrupt follows it, the dma waits for its
    ;; own time)
    (if (i32.and (i32.and (global.get $ime) (i32.ne (i32.and (i32.and (i32.load8_u (i32.const ${IO + 0xFF}))
                                                                      (i32.load8_u (i32.const ${IO + 0x0F}))) (i32.const 0x04)) (i32.const 0)))
                 (i32.and (i32.and (global.get $hdma_on) (i32.eqz (global.get $hdmadone)))
                          (i32.and (i32.lt_u (global.get $ln) (i32.const 144))
                                   (i32.ne (i32.and (i32.load8_u (i32.const ${IO + 0x40})) (i32.const 0x80)) (i32.const 0)))))
      (then
        (local.set $t (i32.add (i32.sub (i32.add (global.get $abscc) (global.get $cyc)) (global.get $linelen)) (global.get $hdmaat)))
        (if (i32.and (i32.le_s (i32.sub (local.get $t) (global.get $abscc)) (i32.const 0))
                     (i32.lt_s (i32.sub (local.get $t) (global.get $tirqat)) (i32.const 0)))
          (then
            (global.set $hdmadone (i32.const 1))
            (call $hdma_block (global.get $abscc))
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
            (call $tick (i32.sub (local.get $c0) (global.get $cyc)))
            (local.set $c0 (global.get $cyc))))))
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
        ;; taken straight out of HALT: the CGB wake costs 4 first
        ;; (gambatte Memory::event, intevent_interrupts)
        ${cgb ? '(if (global.get $halted) (then (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))))' : ''}
        (global.set $halted (i32.const 0))
        (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
        ;; high byte at +8, low at +12 (gambatte Interrupter::interrupt)
        (global.set $irqacc (i32.const 8))
        (call $wr8 (i32.and (i32.add (global.get $sp) (i32.const 1)) (i32.const 0xFFFF))
                   (i32.shr_u (global.get $pc) (i32.const 8)))
        (global.set $irqacc (i32.const 12))
        (call $wr8 (global.get $sp) (i32.and (global.get $pc) (i32.const 0xFF)))
        (global.set $irqacc (i32.const 0))
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
    ;; TIMA itself is computed lazily at each access (gambatte tima.cpp,
    ;; see $tupd); here only the interrupt events that fell inside this span.
    (global.set $abscc (i32.add (global.get $abscc) (local.get $t)))
    (call $tirqupd (global.get $abscc))
    ;; a serial transfer finishing inside this span
    (if (i32.and (i32.ne (global.get $serev) (i32.const 0))
                 (i32.ge_s (i32.sub (global.get $abscc) (global.get $serev)) (i32.const 0)))
      (then (call $serupd (global.get $abscc))))
    )

  ;; ---- the timer as gambatte's Tima runs it (tima.cpp). TIMA ticks when
  ;; the ABSOLUTE cycle counter crosses a multiple of 2^k, k = 10/4/6/8 by
  ;; TAC ($tlast is aligned to cc, not to DIV); its value is brought up to
  ;; date at each access cycle. After an overflow TIMA reads 0 until
  ;; $tmat (overflow tick + 3), then TMA, and a TIMA write in the 4 cycles
  ;; from $tmat is not overridden by the reload. The interrupt is its own
  ;; event at overflow tick + 3 ($timairq, 0 = timer off).
  (func $tclk (param $tac i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${IO + 0x1F0}) (i32.and (local.get $tac) (i32.const 3)))))

  (func $tupd (param $cc i32)
    (local $k i32) (local $ticks i32) (local $tmp i32) (local $d i32) (local $tma i32)
    (local.set $k (call $tclk (i32.load8_u (i32.const ${IO + 0x07}))))
    (local.set $tma (i32.load8_u (i32.const ${IO + 0x06})))
    (local.set $ticks (i32.shr_u (i32.sub (local.get $cc) (global.get $tlast)) (local.get $k)))
    (global.set $tlast (i32.add (global.get $tlast) (i32.shl (local.get $ticks) (local.get $k))))
    (if (i32.and (global.get $tmaon) (i32.ge_s (i32.sub (local.get $cc) (global.get $tmat)) (i32.const 0)))
      (then
        (if (i32.ge_s (i32.sub (local.get $cc) (global.get $tmat)) (i32.const 4))
          (then (global.set $tmaon (i32.const 0))))
        (i32.store8 (i32.const ${IO + 0x05}) (local.get $tma))))
    (local.set $tmp (i32.add (i32.load8_u (i32.const ${IO + 0x05})) (local.get $ticks)))
    ;; while (tmp > 0x100) tmp -= 0x100 - tma, in one step
    (if (i32.gt_u (local.get $tmp) (i32.const 0x100))
      (then
        (local.set $d (i32.sub (i32.const 0x100) (local.get $tma)))
        (local.set $tmp (i32.sub (local.get $tmp)
          (i32.mul (local.get $d)
            (i32.div_u (i32.add (i32.sub (local.get $tmp) (i32.const 0x101)) (local.get $d)) (local.get $d)))))))
    (if (i32.eq (local.get $tmp) (i32.const 0x100))
      (then
        (local.set $tmp (i32.const 0))
        (global.set $tmat (i32.add (global.get $tlast) (i32.const 3)))
        (global.set $tmaon (i32.const 1))
        (if (i32.ge_s (i32.sub (local.get $cc) (global.get $tmat)) (i32.const 0))
          (then
            (if (i32.ge_s (i32.sub (local.get $cc) (global.get $tmat)) (i32.const 4))
              (then (global.set $tmaon (i32.const 0))))
            (local.set $tmp (local.get $tma))))))
    (i32.store8 (i32.const ${IO + 0x05}) (local.get $tmp)))

  ;; timer interrupt events up to cc (Memory::updateTimaIrq / doIrqEvent)
  (func $tirqupd (param $cc i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $timairq)))
      (br_if $d (i32.lt_s (i32.sub (local.get $cc) (global.get $timairq)) (i32.const 0)))
      (i32.store8 (i32.const ${IO + 0x0F}) (i32.or (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 4)))
      (global.set $tirqat (global.get $timairq))
      (global.set $timairq (i32.add (global.get $timairq)
        (i32.shl (i32.sub (i32.const 256) (i32.load8_u (i32.const ${IO + 0x06})))
                 (call $tclk (i32.load8_u (i32.const ${IO + 0x07}))))))
      (br $l))))

  ;; FF05-FF07 writes at cycle cc (Tima::setTima / setTma / setTac)
  (func $timerwrite (param $p i32) (param $v i32) (param $cc i32)
    (local $tac i32) (local $nxt i32) (local $d i32) (local $k i32)
    (local.set $tac (i32.load8_u (i32.const ${IO + 0x07})))
    (if (i32.eq (local.get $p) (i32.const 5))
      (then
        (if (i32.and (local.get $tac) (i32.const 4))
          (then
            (call $tirqupd (local.get $cc))
            (call $tupd (local.get $cc))
            (if (i32.and (global.get $tmaon) (i32.lt_u (i32.sub (global.get $tmat) (local.get $cc)) (i32.const 4)))
              (then (global.set $tmaon (i32.const 0))))
            (global.set $timairq (i32.add (i32.add (global.get $tlast)
              (i32.shl (i32.sub (i32.const 256) (local.get $v)) (call $tclk (local.get $tac)))) (i32.const 3)))))
        (i32.store8 (i32.const ${IO + 0x05}) (local.get $v))
        (return)))
    (if (i32.eq (local.get $p) (i32.const 6))
      (then
        (if (i32.and (local.get $tac) (i32.const 4))
          (then (call $tirqupd (local.get $cc)) (call $tupd (local.get $cc))))
        (i32.store8 (i32.const ${IO + 0x06}) (local.get $v))
        (return)))
    (local.set $v (i32.or (local.get $v) (i32.const 0xF8)))
    (if (i32.ne (local.get $v) (local.get $tac))
      (then
        (local.set $nxt (global.get $timairq))
        (if (i32.and (local.get $tac) (i32.const 4))
          (then
            (call $tirqupd (local.get $cc))
            (call $tupd (local.get $cc))
            (local.set $nxt (global.get $timairq))
            (local.set $d (i32.add (i32.shl (i32.const 1) (i32.sub (call $tclk (local.get $tac)) (i32.const 1))) (i32.const 3)))
            (global.set $tlast (i32.sub (global.get $tlast) (local.get $d)))
            (global.set $tmat (i32.sub (global.get $tmat) (local.get $d)))
            (local.set $nxt (i32.sub (local.get $nxt) (local.get $d)))
            (if (i32.ge_s (i32.sub (local.get $cc) (local.get $nxt)) (i32.const 0))
              (then (i32.store8 (i32.const ${IO + 0x0F}) (i32.or (i32.load8_u (i32.const ${IO + 0x0F})) (i32.const 4)))))
            (call $tupd (local.get $cc))
            (global.set $tmaon (i32.const 0))
            (local.set $nxt (i32.const 0))))
        (if (i32.and (local.get $v) (i32.const 4))
          (then
            (local.set $k (call $tclk (local.get $v)))
            (global.set $tlast (i32.shl (i32.shr_u (local.get $cc) (local.get $k)) (local.get $k)))
            (local.set $nxt (i32.add (i32.add (global.get $tlast)
              (i32.shl (i32.sub (i32.const 256) (i32.load8_u (i32.const ${IO + 0x05}))) (local.get $k))) (i32.const 3)))))
        (global.set $timairq (local.get $nxt))))
    (i32.store8 (i32.const ${IO + 0x07}) (local.get $v)))
`;
}

/**
 * Power-on state as gambatte's initstate.cpp sets it (not a boot ROM's).
 * CGB: A = $11, PPU 164 cycles into line 144, DIV $1E with $A0 into its tick,
 * BG palette RAM all $7FFF, OBJ palette RAM its fixed dump. DMG:
 * cycleCounter $102A0+$8D2C = $18FCC, PPU at line 153 + 396, DIV $AB.
 */
function initWat(cgb, cramhi) {
  // gambatte clears SRAM to $FF on first load (clearSram) - both modes
  const sram = `(memory.fill (i32.const ${P.CRAMX}) (i32.const 0xFF) (i32.const 0x8000))`
    + `(memory.fill (i32.const ${cramhi}) (i32.const 0xFF) (i32.const ${P.CRAMHI_BYTES}))`;
  const { BGPAL } = P;
  if (!cgb) {
    return `
    (global.set $ln (i32.const 153))
    (global.set $cyc (i32.const ${456 - 396}))
    (global.set $divcnt (i32.const 0xABCC))
    (global.set $abscc (i32.const 0x18FCC))
    ${sram}
    (i32.store (i32.const ${IOREG + 0x1F0}) (i32.const 0x0806040A))
    ;; the LCD event model from the power-on registers (gambatte loadState)
    (global.set $statreg (i32.load8_u (i32.const ${IOREG + 0x41})))
    (global.set $m0next (i32.and (global.get $statreg) (i32.const 0x08)))
    (call $lcdevreset (global.get $abscc) (i32.const 0))
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
    ;; the LCD event model from the power-on registers (gambatte loadState)
    (global.set $statreg (i32.load8_u (i32.const ${IOREG + 0x41})))
    (global.set $m0next (i32.and (global.get $statreg) (i32.const 0x08)))
    (call $lcdevreset (global.get $abscc) (i32.const 0))
`;
}

/**
 * The frame loop: a PERSISTENT line counter that returns at VBlank start, the
 * way gambatte hands a frame to libretro (LCD-on restarts the PPU at line 0
 * and moves the frame boundary), with libretro's frame-dupe rule. Each line:
 * LYC/mode-2/VBlank STAT sources at its start, the scanline drawn during
 * mode 3, the HBlank STAT source and one HDMA block, then the rest.
 */
function frameWat(cgb) {
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
    ;; gambatte CPU::process starts every run with Memory::updateInput
    (call $updinput)
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
          ;; Mode 1 (gambatte LCD::event MODE1_IRQ): VBlank, and STAT when the
          ;; latched STAT has mode 1 enabled and mode 0 not
          (if (i32.eq (global.get $ln) (i32.const 144))
            (then
              (if (global.get $m1early)
                (then (global.set $m1early (i32.const 0)))
                (else
                  (call $irq (if (result i32) (i32.eq (i32.and (global.get $m1s) (i32.const 0x18)) (i32.const 0x10))
                               (then (i32.const 3)) (else (i32.const 1))))
                  (global.set $m1s (global.get $statreg))))))))
      (if (global.get $ln) (then (global.set $lcdinactive (i32.const 0))))
      ;; this line's mode 3 length, as gambatte predicts it (SCX, window, sprites)
      (call $m3setup)
      ;; in-line events the instruction that crossed into this line already
      ;; passed (an LYC=0 at 153 + 8 behind a 12-cycle instruction)
      (call $statev)
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
        (then
          ;; LCD::updateScreen: the PPU runs up to the blit first (the
          ;; shadow draws line 143's pixels if nothing has asked for them yet)
          (call $gp_update (global.get $abscc))
          (global.set $blitnow (i32.const 0)) (global.set $resume (i32.const 1)) (br $fd)))))
      ;; ---- mode 2 (OAM scan, 80 dots) ----
      (local.set $i (i32.sub (global.get $linelen) (i32.shl (i32.const 80) (global.get $speed))))
      (block $d0 (loop $l0
        (br_if $d0 (i32.le_s (global.get $cyc) (local.get $i)))
        (br_if $d0 (global.get $trapped))
        (br_if $d0 (global.get $lcdrestart))
        (call $step)
        (if (call $offevent) (then (global.set $resume (i32.const 1)) (br $fd)))
        (call $statev)
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
      (call $statev)
      (block $d (loop $l
        ;; the end moves when a mid-line write re-predicts it ($gp_m3change)
        (br_if $d (i32.le_s (global.get $cyc) (i32.sub (global.get $linelen) (i32.shl (global.get $m0dot) (global.get $speed)))))
        (br_if $d (global.get $trapped))
        (br_if $d (global.get $lcdrestart))
        (call $step)
        (if (call $offevent) (then (global.set $resume (i32.const 1)) (br $fd)))
        (call $statev)
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
      ;; HBlank's STAT request and HDMA block are events at their own cycles ($statev).
      ;; The instruction that ended mode 3 may already have passed one (the
      ;; mode-3 loop exits before its $statev runs on the next pass): check
      ;; before the next instruction, as gambatte's event loop does.
      (call $statev)
      (block $d2 (loop $l2
        (br_if $d2 (i32.le_s (global.get $cyc) (i32.const 0)))
        (br_if $d2 (global.get $trapped))
        (br_if $d2 (global.get $lcdrestart))
        (call $step)
        (if (call $offevent) (then (global.set $resume (i32.const 1)) (br $fd)))
        (call $statev)
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
    ;; the frame's audio up to gambatte's runFor end (apu.js)
    (call $apu_frame (global.get $abscc))
    (global.set $rres (i32.sub (global.get $rres) (i32.const 70224)))
    ;; gambatte CPU::runFor: past 2^31 the cycle counter is rebased
    ;; (Memory::resetCounters: dec = (cc & ~0x7FFF) - 0x8000), and every
    ;; absolute event time with it
    (if (i32.lt_s (global.get $abscc) (i32.const 0))
      (then
        (local.set $i (i32.sub (i32.and (global.get $abscc) (i32.const -32768)) (i32.const 0x8000)))
        (global.set $abscc (i32.sub (global.get $abscc) (local.get $i)))
        (call $apu_rebase (local.get $i))
        (if (global.get $timairq) (then (global.set $timairq (i32.sub (global.get $timairq) (local.get $i)))))
        (global.set $tlast (i32.sub (global.get $tlast) (local.get $i)))
        (global.set $gpnow (i32.sub (global.get $gpnow) (local.get $i)))
        (global.set $gptime (i32.sub (global.get $gptime) (local.get $i)))
        (if (global.get $gplastm0) (then (global.set $gplastm0 (i32.sub (global.get $gplastm0) (local.get $i)))))
        (global.set $gpwy2t (i32.sub (global.get $gpwy2t) (local.get $i)))
        (global.set $gplu (i32.sub (global.get $gplu) (local.get $i)))
        (global.set $gpsmt (i32.sub (global.get $gpsmt) (local.get $i)))
        (global.set $tmat (i32.sub (global.get $tmat) (local.get $i)))
        (if (global.get $serev) (then (global.set $serev (i32.sub (global.get $serev) (local.get $i)))))
        (if (i32.ne (global.get $lyct) (i32.const -1)) (then (global.set $lyct (i32.sub (global.get $lyct) (local.get $i)))))
        (if (i32.ne (global.get $m2t) (i32.const -1)) (then (global.set $m2t (i32.sub (global.get $m2t) (local.get $i)))))
        (if (i32.ne (global.get $onet) (i32.const -1)) (then (global.set $onet (i32.sub (global.get $onet) (local.get $i)))))))
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
function opLenTable(img, blocks, opcat) {
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
    // an opcode this ROM's code never uses: its length from the catalogue
    // (RAM code can still run it)
    if (!c) { out[b] = b === 0xCB ? 2 : opcat?.ops.get(b)?.n ?? 1; continue; }
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
// hw-gbc $ram_interp instead; add sp,e8 / ld hl,sp+e8 are written out by
// hand (their lowering folds the operand into flag constants).
const CONTROL = new Set(["jp", "jr", "call", "ret", "reti", "rst"]);
const REP = [["(i32.const 42435)", "(global.get $imm16)"],
  ["(i32.const 42436)", "(i32.and (i32.add (global.get $imm16) (i32.const 1)) (i32.const 0xFFFF))"],
  ["(i32.const 65445)", "(i32.add (i32.const 0xFF00) (global.get $imm8))"],
  ["(i32.const 165)", "(global.get $imm8)"]];

function ramTemplates(img, blocks, opcat) {
  const seen = new Map(), seenCb = new Map();
  for (const [o, v] of blocks) {
    if (o + 1 >= img.length || v.m === "?" || v.m === "defb") continue;
    const op = img[o];
    if (op === 0xCB) { if (!seenCb.has(img[o + 1])) seenCb.set(img[o + 1], v); }
    else if (!seen.has(op)) seen.set(op, v);
  }
  // Opcodes this ROM's code never uses can still run from RAM (a routine
  // assembled at run time, or a test that executes every opcode from WRAM):
  // the rest come from the full opcode catalogue (blocks.opcodeCatalogue).
  if (opcat) {
    for (const [op, v] of opcat.ops) if (!seen.has(op) && v.m !== "defb" && v.m !== "?") seen.set(op, v);
    for (const [op, v] of opcat.cb) if (!seenCb.has(op)) seenCb.set(op, v);
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
  // add sp,e8 / ld hl,sp+e8 with the operand read from RAM: lower() folds a
  // constant operand into its flag expressions, so these two are written
  // out here (H and C from the unsigned low nibble / low byte sums, Z=N=0).
  const e8 = "(i32.sub (i32.xor (global.get $imm8) (i32.const 0x80)) (i32.const 0x80))";
  const spFlags = "(global.set $f (i32.or"
    + " (i32.shl (i32.gt_u (i32.add (i32.and (global.get $sp) (i32.const 0xF)) (i32.and (global.get $imm8) (i32.const 0xF))) (i32.const 0xF)) (i32.const 5))"
    + " (i32.shl (i32.gt_u (i32.add (i32.and (global.get $sp) (i32.const 0xFF)) (global.get $imm8)) (i32.const 0xFF)) (i32.const 4))))";
  const spSum = `(i32.and (i32.add (global.get $sp) ${e8}) (i32.const 0xFFFF))`;
  out.set(0xE8, [`${spFlags} (global.set $sp ${spSum})`, 2, cyclesForOp(0xE8)]);
  out.set(0xF8, [`(global.set $tmp ${spSum}) ${spFlags}`
    + " (global.set $h (i32.shr_u (global.get $tmp) (i32.const 8))) (global.set $l (i32.and (global.get $tmp) (i32.const 0xFF)))", 2, cyclesForOp(0xF8)]);
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

function ramTemplatesWat(img, blocks, opcat) {
  const [t, tcb] = ramTemplates(img, blocks, opcat);
  return templateTable("tmpl", t) + "\n" + templateTable("tmpl_cb", tcb) + `
  ;; run the instruction at $pc from RAM through a template; 1 if handled
  ;; $t: the operand bytes $ram_interp already fetched, each at its own
  ;; cycle (fetching them again would read a later OAM DMA byte)
  (func $tmpl_run (param $op i32) (param $t i32) (result i32)
    (local $n i32)
    (local.set $n (i32.load8_u (i32.add (i32.const ${P.OPLEN}) (local.get $op))))
    (global.set $imm8 (i32.and (local.get $t) (i32.const 0xFF)))
    (global.set $imm16 (if (result i32) (i32.ge_u (local.get $n) (i32.const 3))
      (then (i32.and (local.get $t) (i32.const 0xFFFF))) (else (global.get $imm8))))
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
  const { ORIGIN, CRAMHI, pages: basePages } = gbOriginAndPages(L, addrs.length);
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
    watchLo: WATCH_LO, watchHi: WATCH_HI, padptr: ABI + 0x100, origin: ORIGIN, cgb,
    rb: P.ramBanks(img), rtc: [0x0F, 0x10].includes(img[0x147]), rumble: [0x1C, 0x1D, 0x1E].includes(img[0x147]), cramhi: CRAMHI, time: L.TIME }));
  yield part(A.apuWat({ cgb, muteChannels: o.muteChannels }));
  yield part(commonWat());
  yield part(ppuShadowWat({ cgb, IO: IOREG, OAM: H.OAM, GPSPX, GPMAP, GPMAP2, GPBUF, GPSZ, GPNUM, GPSMAP,
    FB, VRAM0: P.VRAM0, VBANK: P.VBANK_DELTA, BGPAL: P.BGPAL, OBJPAL: P.OBJPAL, SCR: GPSCR }));
  yield part(`  (data (i32.const ${IOREG + 0x100}) "${watBytes(shadeBytes)}")`);
  yield part(H.paletteWat());
  yield part(H.renderWat());
  yield part(cgb ? P.renderWat(FB) : P.dmgRenderWat(FB));
  yield part(P.initstateDataWat(cgb));
  yield part(`  (data (i32.const ${P.OPLEN}) "${watBytes(opLenTable(img, blocks, o.opcat))}")`);
  yield part(`  (data (i32.const ${P.IOTAB}) "${watBytes(P.ioTable(cgb))}")`);
  yield part(ramTemplatesWat(img, blocks, o.opcat));

  // ---- one arm per ROM offset ----
  let ok = 0, bad = 0, broken = 0;
  const bodyFor = (a) => {
    const rec = blocks.get(a);
    // THE FALLTHROUGH ADDRESS IS A CPU ADDRESS, NOT A ROM OFFSET: `$pc` holds
    // what the CPU sees and `$exec` maps pc -> offset through `$rombank`.
    // Handing it `a + n` is only right in bank 0 (a banked `call` pushed a
    // non-16-bit return address and a banked cart returned into the header logo).
    // It is the instruction's CPU address + its length: one ending at $7FFF
    // falls through to $8000 (VRAM), not to the start of the next bank.
    const nxt = cpuAddr(a) + rec.n;
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
    ;; the halt bug's instruction: run as if it sat one byte earlier with
    ;; this opcode, so its operands start at the opcode byte (gambatte:
    ;; pc = pc - 1 after the fetch) and it falls through to pc + len - 1
    (if (global.get $hbug)
      (then
        (global.set $pc (i32.and (i32.sub (global.get $pc) (i32.const 1)) (i32.const 0xFFFF)))
        (global.set $curpc (global.get $pc))
        (drop (call $ram_interp))
        (global.set $hbug (i32.const 0))
        (return)))
    ;; an OAM DMA whose source shares the bus with the code: every byte of
    ;; the instruction is fetched through $rd8 at its cycle (gambatte
    ;; PC_READ -> Memory::read), which sees the byte the DMA moves
    (if (i32.and (i32.ne (global.get $dmalast) (i32.const -1)) (i32.lt_u (global.get $pc) (i32.const 0x8000)))
      (then (if (call $dmaconflict (global.get $pc)) (then (if (call $ram_interp) (then (return)))))))
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
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 0))  (i32.const ${WC_ABI_VERSION}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 4))  (i32.const ${FB_W}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 8))  (i32.const ${FB_H}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 12)) (i32.const ${FB}))
    ;; inputPtr (WCInfo field 7, byte 28). MUST be a real address: the host
    ;; writes 80 bytes of pad state (ABI v4) here EVERY FRAME without checking for
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
    ;; audio: gambatte-libretro's 32768 Hz int16 stereo stream (apu.js)${A.apuInfoWat(ABI)}
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
    ${initWat(cgb, CRAMHI)}
    ;; the PPU shadow at power-on (gambatte PPU::loadState: past line 143's
    ;; mode-3 window, so M2_Ly0::f0 with the cycles left to the frame end)
    (global.set $gpnow (global.get $abscc))
    (global.set $gply (global.get $ln))
    (global.set $gptime (i32.add (global.get $abscc) (global.get $cyc)))
    (global.set $gpst (i32.const 0))
    (global.set $gpcyc (i32.sub (i32.add (i32.mul (global.get $ln) (i32.const 456)) (i32.sub (i32.const 456) (global.get $cyc))) (i32.const 70224)))
    (global.set $gplcdc (i32.load8_u (i32.const ${IOREG + 0x40})))
    (global.set $gpscx (i32.load8_u (i32.const ${IOREG + 0x43})))
    (global.set $gpwy (i32.load8_u (i32.const ${IOREG + 0x4A})))
    (global.set $gpwy2 (i32.load8_u (i32.const ${IOREG + 0x4A})))
    (global.set $gpwx (i32.load8_u (i32.const ${IOREG + 0x4B})))
    (global.set $gpscy (i32.load8_u (i32.const ${IOREG + 0x42})))
    (global.set $gpwyp (i32.const 0xFF))
    ;; its SpriteMapper (OamReader::reset, then loadState: change at the
    ;; power-on cycle, map, the SPRITE_MAP event scheduled)
    (local.set $i (i32.const 0))
    (block $od (loop $ol
      (br_if $od (i32.ge_u (local.get $i) (i32.const 80)))
      (i32.store8 (i32.add (i32.const ${GPBUF}) (local.get $i))
        (i32.load8_u (i32.add (i32.const ${H.OAM}) (i32.or (i32.and (i32.shl (local.get $i) (i32.const 1)) (i32.const -4)) (i32.and (local.get $i) (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ol)))
    (memory.fill (i32.const ${GPSZ}) (i32.const 0) (i32.const 40))
    (global.set $gplu (global.get $abscc))
    (global.set $gplast (i32.const 0xFF))
    (call $gp_oamchange (global.get $abscc))
    (call $gp_mapsprites)
    (call $gp_smsched (global.get $gpnow))
    (call $apu_init))

  (func (export "wc_render")
    (local $i i32) (local $ln i32)
    ${frameWat(cgb)}
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

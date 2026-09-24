// Game Boy machine model for the WAT cart: memory map, MBCs, CGB I/O, timers,
// HDMA, RAM code by provenance, the RAM interpreter's control flow, and the
// CGB and DMG scanline renderers. Both CGB and DMG ROMs run on this model
// (gambatte-derived); a DMG build drops the CGB-only registers.
//
// What CGB mode adds, and where it lives in linear memory:
//
//   VRAM bank 0      0x08000-0x09FFF   (the DMG VRAM region, unchanged)
//   VRAM bank 1      0x12000-0x13FFF   ($FF4F VBK bit 0; BG attribute map lives
//                                       here at the same map offsets)
//   WRAM bank 0      0x0C000-0x0CFFF   ($C000-$CFFF, fixed)
//   WRAM bank n      0x18000+n*0x1000  ($D000-$DFFF, $FF70 SVBK 1..7, 0 reads 1)
//   BG palette RAM   0x11000 (64 B)    ($FF68 BCPS / $FF69 BCPD)
//   OBJ palette RAM  0x11040 (64 B)    ($FF6A OCPS / $FF6B OCPD)
//   line buffer      0x11100 (160 B)   BG colour index | $80 BG-priority, per x
//   sprite claim     0x11200 (160 B)   1 once a higher-priority sprite owns x
//   cart RAM         0x38000 (32 KB)   4 banks of 8 KB, MBC-selected
//
// COLOUR CONVERSION IS MEASURED, NOT RECALLED. romdev's gambatte is built with
// VIDEO_RGB565 and runs with colour correction OFF, so a 15-bit colour reaches
// the screenshot as its raw 5-bit channels packed into RGB565 and expanded to
// 8 bits:
//
//     R = r<<3 | r>>2     G = g6<<2 | g6>>4 with g6 = g<<1     B = b<<3 | b>>2
//
// Checked against gb_bgpdata/gb_objpdata and the reference's own screenshots:
// 115,200/115,200 pixels over 5 Klustar frames, including pure (255,0,0) red,
// which any colour-correction mode would have moved.
//
// Ported from sms-wat src/hw_gbc.py; the emitted text is byte-identical.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { VRAM, WRAM, OAM, IOREG, FB_W, FB_H } from "./hw-gb.js";

export const VRAM0 = VRAM;
export const VRAM1 = 0x12000;
export const VBANK_DELTA = VRAM1 - VRAM0;   // added when VBK = 1
export const WRAMX = 0x18000;
export const BGPAL = 0x11000;
export const OBJPAL = 0x11040;
export const LINEBUF = 0x11100;
export const OBJCLAIM = 0x11200;
export const OPLEN = 0x11300;    // 256-byte instruction-length table (emit.js opLenTable)
export const CRAMX = 0x38000;

// ---- fitted timing constants ------------------------------------------
// These were SMSWAT_GB_* environment knobs while they were being fitted.
// They are fixed now: every verified cart was verified with exactly these.
//
// Mid-line write position: pixel x = dots into the line - 80 - PIXDELAY.
// FITTED, not derived: -4 minimises Link's Awakening f600 line 48 (a SCX
// write from an LYC handler) to 3 residual pixels; 0..-16 all leave 3-4.
export const PIXDELAY = -4;
// Multipliers on $ioff (cycles from the start of the instruction to its
// memory access: one 4-cycle fetch per instruction byte) applied when STAT,
// LY and DIV are READ: the value is sampled where the access happens, not at
// the instruction's start. 1 = the full access offset.
export const STATIOFF = 1;
export const LYIOFF = 1;
export const DIVIOFF = 1;
// The last LYEARLY cycles of a line already read the NEXT line's LY
// (gambatte LCD::getLyReg).
export const LYEARLY = 4;

// gambatte's power-on state, generated from its initstate.cpp by
// scripts/recompile-gen/gen-gb-initstate.mjs (see initstate.json provenance).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let INITSTATE = null;
/** @returns {{provenance:object, wram:string, ioamhram:string, dmg_wram:string, dmg_ioamhram:string, vram_cgb:string, vram_dmg:string, cgb_objp:string}} */
export function initstate() {
  if (!INITSTATE) INITSTATE = JSON.parse(readFileSync(path.join(__dirname, "initstate.json"), "utf8"));
  return INITSTATE;
}

/** The OBJ palette RAM a CGB powers up with (gambatte cgbObjpDump). */
export function cgbObjpInit() {
  return Buffer.from(initstate().cgb_objp, "hex");
}

/**
 * MBC kind from cartridge-type byte $0147.
 * @param {Uint8Array} img
 * @returns {'none'|'mbc1'|'mbc3'|'mbc5'}
 */
export function mbcKind(img) {
  const t = img.length > 0x147 ? img[0x147] : 0;
  if (t === 0x00) return "none";
  if ([0x01, 0x02, 0x03].includes(t)) return "mbc1";
  if ([0x0F, 0x10, 0x11, 0x12, 0x13].includes(t)) return "mbc3";
  if ([0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E].includes(t)) return "mbc5";
  throw new Error(`gb: cartridge type $${t.toString(16).toUpperCase().padStart(2, "0")} is not supported (none/MBC1/MBC3/MBC5 only) - refusing to build.`);
}

export function globalsWat() {
  return `
  ;; ---- CGB state -------------------------------------------------------
  (global $vbk (mut i32) (i32.const 0))
  (global $svbk (mut i32) (i32.const 1))
  (global $speed (mut i32) (i32.const 0))
  (global $key1prep (mut i32) (i32.const 0))
  (global $ramen (mut i32) (i32.const 0))
  (global $hdma_on (mut i32) (i32.const 0))
  (global $hdma_src (mut i32) (i32.const 0))
  (global $hdma_dst (mut i32) (i32.const 0))
  (global $hdma_len (mut i32) (i32.const 0))
  (global $eipend (mut i32) (i32.const 0))
  (global $divcnt (mut i32) (i32.const 0))
  (global $timacnt (mut i32) (i32.const 0))
  (global $ln (mut i32) (i32.const 144))
  (global $lcdrestart (mut i32) (i32.const 0))
  (global $skipnext (mut i32) (i32.const 0))
  (global $blanklcd (mut i32) (i32.const 0))
  (global $offcd (mut i32) (i32.const 0))
  (global $cycbias (mut i32) (i32.const 0))
  ;; real-time cycles run minus 70224 per host frame handed out (see
  ;; emit_gb.cgb_render_wat: gambatte's libretro frame-dupe rule)
  (global $rres (mut i32) (i32.const 0))
  ;; mid-line rendering: the current line is drawn in segments [rx0,rx1)
  (global $rx0 (mut i32) (i32.const 0))
  (global $rx1 (mut i32) (i32.const 160))
  (global $rxnext (mut i32) (i32.const 160))
  (global $winflag (mut i32) (i32.const 0))
  (global $stopcd (mut i32) (i32.const 0))
  (global $abscc (mut i32) (i32.const 0x102A0))
  (global $lastrom (mut i32) (i32.const 0))
  (global $ramexec (mut i32) (i32.const 0))
  (global $ramobase (mut i32) (i32.const 0))
  (global $rambias (mut i32) (i32.const 0))
  (global $imm8 (mut i32) (i32.const 0))
  (global $imm16 (mut i32) (i32.const 0))
  (global $wline (mut i32) (i32.const 0))
  (global $linelen (mut i32) (i32.const 456))
  (global $rtc_sel (mut i32) (i32.const 0))
`;
}

/** MBC control writes ($0000-$7FFF). */
function romWrite(mbc, imgLen) {
  const nbanks = Math.max(2, Math.floor(imgLen / 0x4000));
  const ramen = `
        (if (i32.lt_u (local.get $x) (i32.const 0x2000))
          (then (global.set $ramen (i32.eq (i32.and (local.get $v) (i32.const 0x0F))
                                           (i32.const 0x0A))) (return)))`;
  if (mbc === "none") return "(return)";
  if (mbc === "mbc5") {
    // $2000-$2FFF low 8 bits, $3000-$3FFF bit 8. Bank 0 IS selectable on
    // MBC5 (it is not remapped to 1 as on MBC1/MBC3).
    return ramen + `
        (if (i32.lt_u (local.get $x) (i32.const 0x3000))
          (then (global.set $banklo (local.get $v))
                (global.set $rombank (i32.rem_u (i32.or (global.get $banklo)
                  (i32.shl (global.get $bankhi) (i32.const 8))) (i32.const ${nbanks})))
                (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x4000))
          (then (global.set $bankhi (i32.and (local.get $v) (i32.const 1)))
                (global.set $rombank (i32.rem_u (i32.or (global.get $banklo)
                  (i32.shl (global.get $bankhi) (i32.const 8))) (i32.const ${nbanks})))
                (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x6000))
          (then (global.set $rambank (i32.and (local.get $v) (i32.const 0x0F)))
                (return)))
        (return)`;
  }
  if (mbc === "mbc3") {
    // $2000-$3FFF 7-bit ROM bank (0 reads as 1); $4000-$5FFF RAM bank 0-3
    // or RTC register $08-$0C. The RTC is a stub: registers hold what was
    // written (a game that reads the clock sees a stopped clock at 0).
    return ramen + `
        (if (i32.lt_u (local.get $x) (i32.const 0x4000))
          (then (global.set $rombank
                  (if (result i32) (i32.eqz (i32.and (local.get $v) (i32.const 0x7F)))
                    (then (i32.const 1))
                    (else (i32.rem_u (i32.and (local.get $v) (i32.const 0x7F))
                                     (i32.const ${nbanks})))))
                (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x6000))
          (then (global.set $rambank (i32.and (local.get $v) (i32.const 0x0F)))
                (return)))
        (return)`;
  }
  // MBC1: the three-register logic, via $setbank.
  return ramen + `
        (if (i32.lt_u (local.get $x) (i32.const 0x4000))
          (then
            (global.set $banklo
              (if (result i32) (i32.eqz (i32.and (local.get $v) (i32.const 0x1F)))
                (then (i32.const 1))
                (else (i32.and (local.get $v) (i32.const 0x1F)))))
            (call $setbank) (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x6000))
          (then (global.set $bankhi (i32.and (local.get $v) (i32.const 3)))
                (call $setbank) (return)))
        (global.set $bankmode (i32.and (local.get $v) (i32.const 1)))
        (call $setbank)
        (return)`;
}

/**
 * Remove every `(if (i32.eq (local.get $x) (i32.const 0xFFnn)) ...)` for nn in
 * regs - the CGB-only registers, absent on a DMG.
 */
function dropBranches(text, regs) {
  for (const r of regs) {
    const key = `(if (i32.eq (local.get $x) (i32.const 0x${r.toString(16).toUpperCase().padStart(4, "0")}))`;
    let i;
    while ((i = text.indexOf(key)) >= 0) {
      let depth = 0, j = i;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") { depth--; if (depth === 0) break; }
      }
      text = text.slice(0, i) + text.slice(j + 1);
    }
  }
  return text;
}

export const CGB_ONLY_REGS = [0xFF4D, 0xFF4F, 0xFF51, 0xFF52, 0xFF53, 0xFF54, 0xFF55,
  0xFF68, 0xFF69, 0xFF6A, 0xFF6B, 0xFF70];

/**
 * $rd8/$wr8 and the I/O model.
 * @param {{imgLen:number, mbc:string, romimg:number, probe:number, watchLo:number, watchHi:number, padptr:number, origin:number, cgb?:boolean}} o
 */
export function memWat(o) {
  const t = memWatText(o);
  return o.cgb === false ? dropBranches(t, CGB_ONLY_REGS) : t;
}

function memWatText({ imgLen, mbc, romimg, probe, watchLo, watchHi, padptr, origin }) {
  const mask = Math.max(1, imgLen) - 1;
  return `
  ;; linear address of a WRAM CPU address in $C000-$FDFF (echo folded)
  (func $wram_lin (param $x i32) (result i32)
    (local.set $x (i32.or (i32.const 0xC000) (i32.and (local.get $x) (i32.const 0x1FFF))))
    (if (result i32) (i32.lt_u (local.get $x) (i32.const 0xD000))
      (then (local.get $x))
      (else (i32.add (i32.const ${WRAMX})
        (i32.add (i32.mul (global.get $svbk) (i32.const 0x1000))
                 (i32.and (local.get $x) (i32.const 0xFFF)))))))

  (func $cram_lin (param $x i32) (result i32)
    (i32.add (i32.const ${CRAMX})
      (i32.add (i32.mul (i32.and (global.get $rambank) (i32.const 3)) (i32.const 0x2000))
               (i32.sub (local.get $x) (i32.const 0xA000)))))

  ;; STAT mode bits from where the CPU is inside the current line.
  ;; cycles from the start of the current instruction to its memory access:
  ;; one 4-cycle fetch per instruction byte (OPLEN), CB-prefixed = 8.
  (func $ioff (result i32)
    (local $save i32) (local $op i32)
    (local.set $save (global.get $lastrom))
    (local.set $op (call $rd8 (global.get $curpc)))
    (global.set $lastrom (local.get $save))
    (i32.shl (i32.load8_u (i32.add (i32.const ${OPLEN}) (local.get $op))) (i32.const 2)))

  (func $stat_mode (result i32)
    (local $used i32)
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
      (then (return (i32.const 0))))
    (if (i32.ge_u (global.get $ln) (i32.const 144)) (then (return (i32.const 1))))
    (local.set $used (i32.shr_u (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (i32.mul (call $ioff) (i32.const ${STATIOFF})))
                                (global.get $speed)))
    (if (i32.lt_s (local.get $used) (i32.const 80)) (then (return (i32.const 2))))
    (if (i32.lt_s (local.get $used) (i32.const 252)) (then (return (i32.const 3))))
    (i32.const 0))

  ;; $FF00 from wasmcart pad 0 (WCPad.buttons, u16 at the host's inputPtr).
  ;; ACTIVE LOW. P14 (bit 4) low selects the d-pad (right,left,up,down in
  ;; bits 0-3); P15 (bit 5) low selects A,B,Select,Start. wasmcart bits:
  ;; A 0, B 1, START 6, SELECT 7, UP 8, DOWN 9, LEFT 10, RIGHT 11.
  (func $joypad (result i32)
    (local $sel i32) (local $b i32) (local $n i32)
    (local.set $sel (i32.and (i32.load8_u (i32.const ${IOREG})) (i32.const 0x30)))
    (local.set $b (i32.load16_u (i32.const ${padptr})))
    (local.set $n (i32.const 0x0F))
    (if (i32.eqz (i32.and (local.get $sel) (i32.const 0x10)))
      (then (local.set $n (i32.and (local.get $n) (i32.xor (i32.const 0xFF) (i32.or
        (i32.or (i32.shr_u (i32.and (local.get $b) (i32.const 0x800)) (i32.const 11))
                (i32.shr_u (i32.and (local.get $b) (i32.const 0x400)) (i32.const 9)))
        (i32.or (i32.shr_u (i32.and (local.get $b) (i32.const 0x100)) (i32.const 6))
                (i32.shr_u (i32.and (local.get $b) (i32.const 0x200)) (i32.const 6)))))))))
    (if (i32.eqz (i32.and (local.get $sel) (i32.const 0x20)))
      (then (local.set $n (i32.and (local.get $n) (i32.xor (i32.const 0xFF) (i32.or
        (i32.and (local.get $b) (i32.const 3))
        (i32.or (i32.shr_u (i32.and (local.get $b) (i32.const 0x80)) (i32.const 5))
                (i32.shr_u (i32.and (local.get $b) (i32.const 0x40)) (i32.const 3)))))))))
    (i32.or (i32.or (i32.const 0xC0) (local.get $sel)) (local.get $n)))

  (func $rd8 (param $a i32) (result i32)
    (local $x i32)
    (local.set $x (i32.and (local.get $a) (i32.const 0xFFFF)))
    ;; Every ROM read leaves its offset in $lastrom (+1) - the provenance a
    ;; RAM write compares against (see $origin_note).
    (if (i32.lt_u (local.get $x) (i32.const 0x4000))
      (then (global.set $lastrom (i32.add (local.get $x) (i32.const 1)))
            (return (i32.load8_u (i32.add (i32.const ${romimg}) (local.get $x))))))
    (if (i32.lt_u (local.get $x) (i32.const 0x8000))
      (then
        (global.set $lastrom (i32.add (i32.const 1)
          (i32.and (i32.add (i32.mul (global.get $rombank) (i32.const 0x4000))
                            (i32.sub (local.get $x) (i32.const 0x4000)))
                   (i32.const ${mask}))))
        (return (i32.load8_u (i32.add (i32.const ${romimg - 1}) (global.get $lastrom))))))
    (if (i32.lt_u (local.get $x) (i32.const 0xA000))
      (then (return (i32.load8_u (i32.add (i32.add (i32.const ${VRAM0})
        (i32.sub (local.get $x) (i32.const 0x8000)))
        (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA})))))))
    (if (i32.lt_u (local.get $x) (i32.const 0xC000))
      (then
        (if (i32.eqz (global.get $ramen)) (then (return (i32.const 0xFF))))
        (if (i32.ge_u (global.get $rambank) (i32.const 8))
          (then (return (i32.load8_u (i32.add (i32.const ${probe + 3840})
                          (i32.and (global.get $rambank) (i32.const 7)))))))
        (return (i32.load8_u (call $cram_lin (local.get $x))))))
    (if (i32.lt_u (local.get $x) (i32.const 0xFE00))
      (then (return (i32.load8_u (call $wram_lin (local.get $x))))))
    (if (i32.lt_u (local.get $x) (i32.const 0xFF00))
      (then (return (i32.load8_u (i32.add (i32.const ${OAM})
        (i32.and (i32.sub (local.get $x) (i32.const 0xFE00)) (i32.const 0xFF)))))))
    (if (i32.ge_u (local.get $x) (i32.const 0xFF80))
      (then (return (i32.load8_u (i32.add (i32.const ${IOREG})
        (i32.sub (local.get $x) (i32.const 0xFF00)))))))
    ;; ---- I/O ----
    (if (i32.eq (local.get $x) (i32.const 0xFF00))
      (then (return (call $joypad))))
    ;; DIV/LY/STAT are sampled WHERE IN THE INSTRUCTION the read happens
    ;; (after its opcode and operand fetches, 4 cycles each), not at its
    ;; start: $cyc and $divcnt only advance when the instruction completes.
    ;; An 8-cycle early DIV read moved Link's Awakening's intro rain.
    (if (i32.eq (local.get $x) (i32.const 0xFF04))
      (then (return (i32.and (i32.shr_u (i32.add (global.get $divcnt) (i32.mul (call $ioff) (i32.const ${DIVIOFF}))) (i32.const 8))
                             (i32.const 0xFF)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF0F))
      (then (return (i32.or (i32.load8_u (i32.const ${IOREG + 0x0F})) (i32.const 0xE0)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF41))
      (then (return (i32.or (i32.const 0x80)
        (i32.or (i32.and (i32.load8_u (i32.const ${IOREG + 0x41})) (i32.const 0x7C))
                (call $stat_mode))))))
    ;; LY as gambatte's LCD::getLyReg reads it: line 153 reads 0 (after its
    ;; first 8 cycles at double speed), and the last 4 cycles of any other
    ;; line already read the NEXT line. 1942's sky gradient starts on
    ;; \`wait LY == 0\`, which on this rule exits a line early.
    (if (i32.eq (local.get $x) (i32.const 0xFF44))
      (then
        (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
          (then (return (i32.const 0))))
        (if (i32.eq (global.get $ln) (i32.const 153))
          (then
            (if (i32.eqz (global.get $speed)) (then (return (i32.const 0))))
            (if (i32.le_s (i32.sub (global.get $cyc) (i32.mul (call $ioff) (i32.const ${LYIOFF}))) (i32.const ${912 - 8}))
              (then (return (i32.const 0))))
            (return (i32.const 153))))
        (if (i32.le_s (i32.sub (global.get $cyc) (i32.mul (call $ioff) (i32.const ${LYIOFF}))) (i32.const ${LYEARLY}))
          (then (return (i32.add (global.get $ln) (i32.const 1)))))
        (return (global.get $ln))))
    (if (i32.eq (local.get $x) (i32.const 0xFF4D))
      (then (return (i32.or (i32.or (i32.shl (global.get $speed) (i32.const 7))
                                    (global.get $key1prep)) (i32.const 0x7E)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF4F))
      (then (return (i32.or (global.get $vbk) (i32.const 0xFE)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF55))
      (then (return (i32.load8_u (i32.const ${IOREG + 0x55})))))
    (if (i32.eq (local.get $x) (i32.const 0xFF68))
      (then (return (i32.or (i32.load8_u (i32.const ${IOREG + 0x68})) (i32.const 0x40)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF69))
      (then (return (i32.load8_u (i32.add (i32.const ${BGPAL})
        (i32.and (i32.load8_u (i32.const ${IOREG + 0x68})) (i32.const 0x3F)))))))
    (if (i32.eq (local.get $x) (i32.const 0xFF6A))
      (then (return (i32.or (i32.load8_u (i32.const ${IOREG + 0x6A})) (i32.const 0x40)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF6B))
      (then (return (i32.load8_u (i32.add (i32.const ${OBJPAL})
        (i32.and (i32.load8_u (i32.const ${IOREG + 0x6A})) (i32.const 0x3F)))))))
    (if (i32.eq (local.get $x) (i32.const 0xFF70))
      (then (return (i32.or (global.get $svbk) (i32.const 0xF8)))))
    (i32.load8_u (i32.add (i32.const ${IOREG})
      (i32.sub (local.get $x) (i32.const 0xFF00)))))

  (func $wr8 (param $a i32) (param $v i32)
    (local $x i32) (local $ws i32) (local $i i32) (local $old i32)
    (local.set $x (i32.and (local.get $a) (i32.const 0xFFFF)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (i32.store (i32.const ${probe + 1008})
      (i32.add (i32.load (i32.const ${probe + 1008})) (i32.const 1)))
    (if (i32.and (i32.ge_u (local.get $x) (i32.const ${watchLo}))
                 (i32.le_u (local.get $x) (i32.const ${watchHi})))
      (then
        (local.set $ws (i32.add (i32.const ${probe + 1024})
          (i32.mul (i32.and (i32.load (i32.const ${probe + 1016}))
                            (i32.const 63)) (i32.const 16))))
        (i32.store (local.get $ws) (local.get $x))
        (i32.store (i32.add (local.get $ws) (i32.const 4)) (local.get $v))
        (i32.store (i32.add (local.get $ws) (i32.const 8)) (global.get $curpc))
        ;; CGB: bank | line<<8 | cycles-into-line<<16 (raster timing)
        (i32.store (i32.add (local.get $ws) (i32.const 12))
          (i32.or (i32.and (global.get $rombank) (i32.const 0xFF))
            (i32.or (i32.shl (i32.and (global.get $ln) (i32.const 0xFF)) (i32.const 8))
                    (i32.shl (i32.sub (global.get $linelen) (global.get $cyc)) (i32.const 16)))))
        (i32.store (i32.const ${probe + 1016})
          (i32.add (i32.load (i32.const ${probe + 1016})) (i32.const 1)))))
    (if (i32.lt_u (local.get $x) (i32.const 0x8000))
      (then ${romWrite(mbc, imgLen)}))
    (if (i32.lt_u (local.get $x) (i32.const 0xA000))
      (then (i32.store8 (i32.add (i32.add (i32.const ${VRAM0})
        (i32.sub (local.get $x) (i32.const 0x8000)))
        (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA}))) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $x) (i32.const 0xC000))
      (then
        (if (i32.eqz (global.get $ramen)) (then (return)))
        (if (i32.ge_u (global.get $rambank) (i32.const 8))
          (then (i32.store8 (i32.add (i32.const ${probe + 3840})
                  (i32.and (global.get $rambank) (i32.const 7))) (local.get $v))
                (return)))
        (i32.store8 (call $cram_lin (local.get $x)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $x) (i32.const 0xFE00))
      (then (call $set_origin (call $origin_slot (local.get $x)) (local.get $v))
            (i32.store8 (call $wram_lin (local.get $x)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $x) (i32.const 0xFF00))
      (then (i32.store8 (i32.add (i32.const ${OAM})
        (i32.and (i32.sub (local.get $x) (i32.const 0xFE00)) (i32.const 0xFF)))
        (local.get $v)) (return)))
    (if (i32.ge_u (local.get $x) (i32.const 0xFF80))
      (then (call $set_origin (call $origin_slot (local.get $x)) (local.get $v))
            (i32.store8 (i32.add (i32.const ${IOREG})
        (i32.sub (local.get $x) (i32.const 0xFF00))) (local.get $v)) (return)))
    ;; ---- I/O ----
    (if (i32.eq (local.get $x) (i32.const 0xFF46))
      (then (call $oamdma (local.get $v)) (return)))
    (if (i32.or (i32.and (i32.ge_u (local.get $x) (i32.const 0xFF40))
                         (i32.le_u (local.get $x) (i32.const 0xFF4B)))
                (i32.or (i32.eq (local.get $x) (i32.const 0xFF69))
                        (i32.eq (local.get $x) (i32.const 0xFF6B))))
      (then (call $ppu_write_hook)))
    ;; SC: a transfer on the INTERNAL clock completes (no partner: SB reads
    ;; $FF). External clock never completes, as on hardware with no cable.
    (if (i32.eq (local.get $x) (i32.const 0xFF02))
      (then
        (if (i32.eq (i32.and (local.get $v) (i32.const 0x81)) (i32.const 0x81))
          (then
            (i32.store8 (i32.const ${IOREG + 0x01}) (i32.const 0xFF))
            (i32.store8 (i32.const ${IOREG + 0x02}) (i32.and (local.get $v) (i32.const 0x7F)))
            (i32.store8 (i32.const ${IOREG + 0x0F})
              (i32.or (i32.load8_u (i32.const ${IOREG + 0x0F})) (i32.const 8)))
            (return)))
        (i32.store8 (i32.const ${IOREG + 0x02}) (local.get $v)) (return)))
    ;; DIV reset at the write's cycle: the instruction's full cost is added
    ;; afterwards, so start at -(write offset)
    (if (i32.eq (local.get $x) (i32.const 0xFF04))
      (then (global.set $divcnt (i32.sub (i32.const 0) (call $ioff))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF44)) (then (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF40))
      (then
        (local.set $old (i32.load8_u (i32.const ${IOREG + 0x40})))
        ;; LCD on/off log for the frame-boundary differ: 32 x {frame, ln, cyc, v}
        ;; at PROBE+0xE00, count at PROBE+0xDFC.
        (if (i32.and (i32.xor (local.get $old) (local.get $v)) (i32.const 0x80))
          (then
            (local.set $i (i32.add (i32.const ${probe + 0xE00})
              (i32.shl (i32.and (i32.load (i32.const ${probe + 0xDFC})) (i32.const 31)) (i32.const 4))))
            (i32.store (local.get $i) (i32.load (i32.const ${probe})))
            (i32.store (i32.add (local.get $i) (i32.const 4)) (global.get $ln))
            (i32.store (i32.add (local.get $i) (i32.const 8)) (global.get $cyc))
            (i32.store (i32.add (local.get $i) (i32.const 12)) (local.get $v))
            (i32.store (i32.const ${probe + 0xDFC})
              (i32.add (i32.load (i32.const ${probe + 0xDFC})) (i32.const 1)))))
        ;; LCD switched ON restarts the PPU at line 0 NOW - and gambatte's
        ;; frame boundary moves with it (gambatte-memory.cpp case 0x40): the
        ;; next frame is handed out at the next mode-1 time if a blank frame
        ;; was already shown while it was off, else one mode-1 LATER. The
        ;; current line is cut short: $cyc restarts at a full line and the
        ;; cycles that jump represents are kept out of the timers via $cycbias.
        (if (i32.and (i32.eqz (i32.and (local.get $old) (i32.const 0x80)))
                     (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)))
          (then
            (global.set $lcdrestart (i32.const 1))
            (global.set $ln (i32.const 0))
            (global.set $skipnext (i32.eqz (global.get $blanklcd)))
            ;; line 0 starts AT THE WRITE, which is $ioff cycles into the
            ;; instruction (gambatte lyCounter.reset(0, cc) at the write's cc);
            ;; the instruction's full cost is subtracted after this.
            (global.set $cycbias (i32.add (global.get $cycbias)
              (i32.sub (i32.add (global.get $linelen) (call $ioff)) (global.get $cyc))))
            (global.set $cyc (i32.add (global.get $linelen) (call $ioff)))))
        ;; LCD switched OFF: LY reads 0 and gambatte schedules its next frame
        ;; event 4 lines (1824 cycles) out; that event only arms the blank
        ;; state, and blank frames then follow every 70224 cycles.
        (if (i32.and (i32.ne (i32.and (local.get $old) (i32.const 0x80)) (i32.const 0))
                     (i32.eqz (i32.and (local.get $v) (i32.const 0x80))))
          (then
            (global.set $ly (i32.const 0))
            (global.set $offcd (i32.add (i32.shl (i32.const 1824) (global.get $speed))
              (i32.sub (i32.sub (global.get $linelen) (global.get $cyc)) (call $ioff))))))
        (i32.store8 (i32.const ${IOREG + 0x40}) (local.get $v)) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF4D))
      (then (global.set $key1prep (i32.and (local.get $v) (i32.const 1))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF4F))
      (then (global.set $vbk (i32.and (local.get $v) (i32.const 1))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF55))
      (then (call $hdma_start (local.get $v)) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF51))
      (then (global.set $hdma_src (i32.or (i32.shl (local.get $v) (i32.const 8))
              (i32.and (global.get $hdma_src) (i32.const 0xFF)))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF52))
      (then (global.set $hdma_src (i32.or (i32.and (global.get $hdma_src) (i32.const 0xFF00))
              (i32.and (local.get $v) (i32.const 0xF0)))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF53))
      (then (global.set $hdma_dst (i32.or (i32.shl (local.get $v) (i32.const 8))
              (i32.and (global.get $hdma_dst) (i32.const 0xFF)))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF54))
      (then (global.set $hdma_dst (i32.or (i32.and (global.get $hdma_dst) (i32.const 0xFF00))
              (i32.and (local.get $v) (i32.const 0xF0)))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF69))
      (then
        (local.set $i (i32.load8_u (i32.const ${IOREG + 0x68})))
        (i32.store8 (i32.add (i32.const ${BGPAL}) (i32.and (local.get $i) (i32.const 0x3F)))
                    (local.get $v))
        (if (i32.and (local.get $i) (i32.const 0x80))
          (then (i32.store8 (i32.const ${IOREG + 0x68})
                  (i32.or (i32.const 0x80)
                    (i32.and (i32.add (local.get $i) (i32.const 1)) (i32.const 0x3F))))))
        (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF6B))
      (then
        (local.set $i (i32.load8_u (i32.const ${IOREG + 0x6A})))
        (i32.store8 (i32.add (i32.const ${OBJPAL}) (i32.and (local.get $i) (i32.const 0x3F)))
                    (local.get $v))
        (if (i32.and (local.get $i) (i32.const 0x80))
          (then (i32.store8 (i32.const ${IOREG + 0x6A})
                  (i32.or (i32.const 0x80)
                    (i32.and (i32.add (local.get $i) (i32.const 1)) (i32.const 0x3F))))))
        (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF70))
      (then (global.set $svbk
              (if (result i32) (i32.eqz (i32.and (local.get $v) (i32.const 7)))
                (then (i32.const 1)) (else (i32.and (local.get $v) (i32.const 7)))))
            (return)))
    (i32.store8 (i32.add (i32.const ${IOREG})
      (i32.sub (local.get $x) (i32.const 0xFF00))) (local.get $v)))

  ;; ---- RAM CODE BY PROVENANCE ($origin_note) ---------------------------
  ;; Games copy routines from ROM into HRAM/WRAM and call them there (the OAM
  ;; DMA routine at least). A byte written to RAM that equals the byte of the
  ;; ROM read just before it came FROM that ROM offset; the slot keeps
  ;; offset+1, and any other write clears it. When pc enters RAM, $exec runs
  ;; the arm of the ROM original instead - the copy is byte-identical, so its
  ;; relative jumps and returns behave the same. A slot with no provenance
  ;; (self-modified or computed code) TRAPS rather than guessing.
  ;; This replaces the DMG build's signature-scanned HRAM aliases, which
  ;; anchored on \`ldh ($46),a\` and missed a routine that begins \`di; push
  ;; af\` (1942): the call landed two bytes in, skipped the push, and the
  ;; matching pop unbalanced the stack.
  ;; Slots: WRAM bank 0 0..0xFFF, bank n n*0x1000.., HRAM 0x8000..
  (func $origin_slot (param $x i32) (result i32)
    (if (i32.ge_u (local.get $x) (i32.const 0xFF80))
      (then (return (i32.add (i32.const 0x8000) (i32.sub (local.get $x) (i32.const 0xFF80))))))
    (local.set $x (i32.and (local.get $x) (i32.const 0x1FFF)))
    (if (result i32) (i32.lt_u (local.get $x) (i32.const 0x1000))
      (then (local.get $x))
      (else (i32.add (i32.mul (global.get $svbk) (i32.const 0x1000))
                     (i32.and (local.get $x) (i32.const 0xFFF))))))

  (func $set_origin (param $slot i32) (param $v i32)
    (i32.store (i32.add (i32.const ${origin}) (i32.shl (local.get $slot) (i32.const 2)))
      (if (result i32)
        (i32.and (i32.ne (global.get $lastrom) (i32.const 0))
                 (i32.eq (local.get $v)
                   (i32.load8_u (i32.add (i32.const ${romimg - 1}) (global.get $lastrom)))))
        (then (global.get $lastrom)) (else (i32.const 0)))))

  ;; 1 if bytes pc+1.. of the instruction at pc (origin o = offset+1) all
  ;; still came from the ROM bytes that follow o
  (func $ram_bytes_intact (param $pc i32) (param $o i32) (result i32)
    (local $n i32) (local $k i32)
    (local.set $n (i32.load8_u (i32.add (i32.const ${OPLEN})
      (i32.load8_u (i32.add (i32.const ${romimg - 1}) (local.get $o))))))
    (local.set $k (i32.const 1))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) (local.get $n)))
      (if (i32.ne (call $get_origin (i32.and (i32.add (local.get $pc) (local.get $k)) (i32.const 0xFFFF)))
                  (i32.add (local.get $o) (local.get $k)))
        (then (return (i32.const 0))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
    (i32.const 1))

  (func $get_origin (param $x i32) (result i32)
    (i32.load (i32.add (i32.const ${origin}) (i32.shl (call $origin_slot (local.get $x)) (i32.const 2)))))

  ;; RAM code that is NOT a byte-intact ROM copy: built or patched by the
  ;; game. Control flow is interpreted here with operands read from RAM;
  ;; everything else goes to the gb.lower templates ($tmpl_run, emitted by
  ;; emit_gb). Returns 1 when it handled the instruction; 0 hands over to the
  ;; provenance path, which traps if the bytes are not an intact copy.
  (func $ram_cond (param $op i32) (result i32)
    ;; cc in bits 4-3 of the opcode: nz z nc c
    (local $cc i32)
    (local.set $cc (i32.and (i32.shr_u (local.get $op) (i32.const 3)) (i32.const 3)))
    (if (result i32) (i32.lt_u (local.get $cc) (i32.const 2))
      (then (i32.xor (i32.ne (i32.and (global.get $f) (i32.const 0x80)) (i32.const 0))
                     (i32.eqz (local.get $cc))))
      (else (i32.xor (i32.ne (i32.and (global.get $f) (i32.const 0x10)) (i32.const 0))
                     (i32.eq (local.get $cc) (i32.const 2))))))

  (func $ram_push (param $v i32)
    (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (call $wr8 (global.get $sp) (i32.and (local.get $v) (i32.const 0xFF)))
    (call $wr8 (i32.and (i32.add (global.get $sp) (i32.const 1)) (i32.const 0xFFFF))
               (i32.shr_u (i32.and (local.get $v) (i32.const 0xFFFF)) (i32.const 8))))

  (func $ram_pop (result i32)
    (local $v i32)
    (local.set $v (i32.or (call $rd8 (global.get $sp))
      (i32.shl (call $rd8 (i32.and (i32.add (global.get $sp) (i32.const 1)) (i32.const 0xFFFF)))
               (i32.const 8))))
    (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (local.get $v))

  (func $ram_interp (result i32)
    (local $op i32) (local $t i32) (local $nx i32) (local $o i32)
    (local.set $o (call $get_origin (global.get $pc)))
    (if (local.get $o)
      (then (if (call $ram_bytes_intact (global.get $pc) (local.get $o))
              (then (return (i32.const 0))))))
    (i32.store (i32.const ${probe + 232}) (i32.add (i32.load (i32.const ${probe + 232})) (i32.const 1)))
    (local.set $op (call $rd8 (global.get $pc)))
    (local.set $t (i32.or (call $rd8 (i32.and (i32.add (global.get $pc) (i32.const 1)) (i32.const 0xFFFF)))
      (i32.shl (call $rd8 (i32.and (i32.add (global.get $pc) (i32.const 2)) (i32.const 0xFFFF)))
               (i32.const 8))))
    ;; jp nn / jp cc,nn
    (if (i32.or (i32.eq (local.get $op) (i32.const 0xC3))
                (i32.eq (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0xC2)))
      (then
        (if (i32.or (i32.eq (local.get $op) (i32.const 0xC3)) (call $ram_cond (local.get $op)))
          (then (global.set $pc (local.get $t))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 16))))
          (else (global.set $pc (i32.and (i32.add (global.get $pc) (i32.const 3)) (i32.const 0xFFFF)))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 12)))))
        (return (i32.const 1))))
    ;; call nn / call cc,nn
    (if (i32.or (i32.eq (local.get $op) (i32.const 0xCD))
                (i32.eq (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0xC4)))
      (then
        (local.set $nx (i32.and (i32.add (global.get $pc) (i32.const 3)) (i32.const 0xFFFF)))
        (if (i32.or (i32.eq (local.get $op) (i32.const 0xCD)) (call $ram_cond (local.get $op)))
          (then (call $ram_push (local.get $nx)) (global.set $pc (local.get $t))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 24))))
          (else (global.set $pc (local.get $nx))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 12)))))
        (return (i32.const 1))))
    ;; ret / reti / ret cc
    (if (i32.or (i32.or (i32.eq (local.get $op) (i32.const 0xC9)) (i32.eq (local.get $op) (i32.const 0xD9)))
                (i32.eq (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0xC0)))
      (then
        (if (i32.or (i32.ne (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0xC0))
                    (call $ram_cond (local.get $op)))
          (then (global.set $pc (call $ram_pop))
                (if (i32.eq (local.get $op) (i32.const 0xD9)) (then (global.set $ime (i32.const 1))))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 16))))
          (else (global.set $pc (i32.and (i32.add (global.get $pc) (i32.const 1)) (i32.const 0xFFFF)))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))))
        (return (i32.const 1))))
    ;; jr e / jr cc,e
    (if (i32.or (i32.eq (local.get $op) (i32.const 0x18))
                (i32.eq (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0x20)))
      (then
        (local.set $nx (i32.and (i32.add (global.get $pc) (i32.const 2)) (i32.const 0xFFFF)))
        (if (i32.or (i32.eq (local.get $op) (i32.const 0x18)) (call $ram_cond (local.get $op)))
          (then (global.set $pc (i32.and (i32.add (local.get $nx)
                  (i32.sub (i32.xor (i32.and (local.get $t) (i32.const 0xFF)) (i32.const 0x80))
                           (i32.const 0x80))) (i32.const 0xFFFF)))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 12))))
          (else (global.set $pc (local.get $nx))
                (global.set $cyc (i32.sub (global.get $cyc) (i32.const 8)))))
        (return (i32.const 1))))
    ;; rst n
    (if (i32.eq (i32.and (local.get $op) (i32.const 0xC7)) (i32.const 0xC7))
      (then
        (call $ram_push (i32.and (i32.add (global.get $pc) (i32.const 1)) (i32.const 0xFFFF)))
        (global.set $pc (i32.and (local.get $op) (i32.const 0x38)))
        (global.set $cyc (i32.sub (global.get $cyc) (i32.const 16)))
        (return (i32.const 1))))
    ;; jp (hl)
    (if (i32.eq (local.get $op) (i32.const 0xE9))
      (then
        (global.set $pc (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
        (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
        (return (i32.const 1))))
    (call $tmpl_run (local.get $op)))

  (func $setbank
    (if (global.get $bankmode)
      (then
        (global.set $rombank (global.get $banklo))
        (global.set $rambank (global.get $bankhi)))
      (else
        (global.set $rombank (i32.or (global.get $banklo)
          (i32.shl (global.get $bankhi) (i32.const 5))))
        (global.set $rambank (i32.const 0)))))

  ;; STOP: with KEY1 bit 0 armed it is the CGB speed switch.
  ;; gambatte Memory::stop: with KEY1 armed the speed flips and, if the LCD
  ;; is off, the next frame event moves to 70224<<(old speed) from now.
  ;; EITHER WAY the CPU then sleeps until an interrupt or 0x20000 cycles
  ;; (+8 from double speed) pass - a pause of most of a frame that shifts
  ;; every later frame boundary if it is left out.
  ;; ---- MID-LINE WRITES -------------------------------------------------
  ;; The line is drawn during mode 3 in SEGMENTS: a write to a PPU register
  ;; (LCDC, SCY/SCX, BGP/OBP, WY/WX, CGB palette data) while mode 3 is running
  ;; first draws the pixels already output, with the old value. Link's
  ;; Awakening changes a register part-way along a line; drawing the whole
  ;; line at once put the change at x=0.
  ;; x output at a write = dots into the line - 80 - PIXDELAY.
  (func $ppu_catch (param $x i32)
    (if (i32.gt_s (local.get $x) (i32.const 160)) (then (local.set $x (i32.const 160))))
    (if (i32.gt_s (local.get $x) (global.get $rxnext))
      (then
        (global.set $rx0 (global.get $rxnext))
        (global.set $rx1 (local.get $x))
        (call $ppu_line (global.get $ln))
        (global.set $rxnext (local.get $x)))))

  (func $ppu_write_hook
    (local $used i32)
    (if (i32.ge_u (global.get $rxnext) (i32.const 160)) (then (return)))
    (local.set $used (i32.shr_u (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (call $ioff))
                                (global.get $speed)))
    (call $ppu_catch (i32.sub (local.get $used) (i32.const ${80 + PIXDELAY}))))

  (func $stop
    (local $old i32)
    (local.set $old (global.get $speed))
    (if (global.get $key1prep)
      (then
        (global.set $speed (i32.xor (global.get $speed) (i32.const 1)))
        (global.set $key1prep (i32.const 0))
        (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
          (then (global.set $offcd (i32.add (i32.shl (i32.const 70224) (local.get $old))
                  (i32.sub (global.get $linelen) (global.get $cyc))))))))
    (global.set $halted (i32.const 1))
    (global.set $stopcd (i32.add (i32.const 0x20000) (i32.shl (local.get $old) (i32.const 3)))))

  ;; ---- HDMA / GDMA, as gambatte-memory.cpp intevent_dma does it ----------
  ;; The source/destination are INTERNAL counters: $FF51-$FF54 writes set
  ;; them, and a transfer leaves them advanced, so a second $FF55 write
  ;; continues where the first stopped. (Project S-11 loads 4KB of tiles with
  ;; one address setup and four GDMAs; reloading from the registers each time
  ;; copied the first 1KB four times.) A source in VRAM or above $FDFF reads
  ;; $FF. Each byte costs 2<<speed cycles.
  (func $hdma_block
    (local $i i32) (local $s i32) (local $d i32)
    (local.set $i (i32.const 0))
    (block $dn (loop $l
      (br_if $dn (i32.ge_u (local.get $i) (i32.const 16)))
      (local.set $s (i32.and (global.get $hdma_src) (i32.const 0xFFFF)))
      (local.set $d (if (result i32)
        (i32.or (i32.eq (i32.and (local.get $s) (i32.const 0xE000)) (i32.const 0x8000))
                (i32.gt_u (local.get $s) (i32.const 0xFDFF)))
        (then (i32.const 0xFF))
        (else (call $rd8 (local.get $s)))))
      (i32.store8 (i32.add (i32.add (i32.const ${VRAM0})
          (i32.and (global.get $hdma_dst) (i32.const 0x1FFF)))
          (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA})))
        (local.get $d))
      (global.set $hdma_src (i32.and (i32.add (global.get $hdma_src) (i32.const 1)) (i32.const 0xFFFF)))
      (global.set $hdma_dst (i32.and (i32.add (global.get $hdma_dst) (i32.const 1)) (i32.const 0xFFFF)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.shl (i32.const 32) (global.get $speed))))
    (global.set $hdma_len (i32.sub (global.get $hdma_len) (i32.const 1)))
    (i32.store8 (i32.const ${IOREG + 0x55})
      (if (result i32) (i32.le_s (global.get $hdma_len) (i32.const 0))
        (then (i32.const 0xFF))
        (else (i32.sub (global.get $hdma_len) (i32.const 1)))))
    (if (i32.le_s (global.get $hdma_len) (i32.const 0))
      (then (global.set $hdma_on (i32.const 0)))))

  (func $hdma_start (param $v i32)
    ;; Writing bit 7 = 0 while an HBlank DMA runs CANCELS it.
    (if (i32.and (global.get $hdma_on) (i32.eqz (i32.and (local.get $v) (i32.const 0x80))))
      (then
        (global.set $hdma_on (i32.const 0))
        (i32.store8 (i32.const ${IOREG + 0x55}) (i32.or (i32.and (local.get $v) (i32.const 0x7F))
                                                        (i32.const 0x80)))
        (return)))
    (global.set $hdma_len (i32.add (i32.and (local.get $v) (i32.const 0x7F)) (i32.const 1)))
    (i32.store (i32.const ${probe + 72})
      (i32.add (i32.load (i32.const ${probe + 72})) (i32.const 1)))
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then
        (global.set $hdma_on (i32.const 1))
        (i32.store8 (i32.const ${IOREG + 0x55}) (i32.and (local.get $v) (i32.const 0x7F)))
        ;; LCD off: gambatte moves ONE block and ends the HDMA (its dma event
        ;; zeroes the remaining length when the LCD is off). Only the HBlank
        ;; mode - a GDMA with the LCD off must still move every block, and
        ;; cutting it after one block left Buzz Lightyear's tiles as zeros.
        (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
          (then
            (global.set $hdma_len (i32.const 1))
            (call $hdma_block)))
        (return)))
    ;; General DMA: everything now.
    (block $d (loop $l
      (br_if $d (i32.le_s (global.get $hdma_len) (i32.const 0)))
      (call $hdma_block)
      (br $l)))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
    (global.set $hdma_on (i32.const 0))
    (i32.store8 (i32.const ${IOREG + 0x55}) (i32.const 0xFF)))
`;
}

/** CGB scanline renderer: BG + window with attributes, then sprites. */
export function renderWat(fb) {
  return `
  (global $fbrow (mut i32) (i32.const ${fb}))
  ;; 15-bit CGB colour -> framebuffer word. The wasmcart framebuffer is
  ;; XRGB8888: the WORD is 0x00RRGGBB, so red goes in bits 16-23 (bytes B,G,R,X
  ;; in memory). The first CGB build put red in the low byte and every colour
  ;; came out with R and B exchanged - invisible on the DMG's greys. Channel
  ;; values: RGB565 expansion, no colour correction (module docstring).
  (func $cgb_rgba (param $c i32) (result i32)
    (local $r i32) (local $g i32) (local $b i32)
    (local.set $r (i32.and (local.get $c) (i32.const 31)))
    (local.set $g (i32.shl (i32.and (i32.shr_u (local.get $c) (i32.const 5)) (i32.const 31))
                           (i32.const 1)))
    (local.set $b (i32.and (i32.shr_u (local.get $c) (i32.const 10)) (i32.const 31)))
    (i32.or (i32.const 0xFF000000)
      (i32.or (i32.or (i32.shl (local.get $b) (i32.const 3)) (i32.shr_u (local.get $b) (i32.const 2)))
        (i32.or
          (i32.shl (i32.or (i32.shl (local.get $g) (i32.const 2)) (i32.shr_u (local.get $g) (i32.const 4)))
                   (i32.const 8))
          (i32.shl (i32.or (i32.shl (local.get $r) (i32.const 3)) (i32.shr_u (local.get $r) (i32.const 2)))
                   (i32.const 16))))))

  (func $cgb_pal (param $base i32) (param $pal i32) (param $ci i32) (result i32)
    (local $p i32)
    (local.set $p (i32.add (local.get $base)
      (i32.add (i32.mul (local.get $pal) (i32.const 8)) (i32.mul (local.get $ci) (i32.const 2)))))
    (call $cgb_rgba (i32.or (i32.load8_u (local.get $p))
                            (i32.shl (i32.load8_u (i32.add (local.get $p) (i32.const 1)))
                                     (i32.const 8)))))

  ;; one BG/window pixel from map entry (map address in bank-0 linear space)
  (func $cgb_tilepix (param $maddr i32) (param $row i32) (param $col i32)
                     (param $lcdc i32) (param $fbx i32) (param $y i32)
    (local $tno i32) (local $attr i32) (local $addr i32) (local $bit i32) (local $ci i32)
    (local.set $tno (i32.load8_u (local.get $maddr)))
    (local.set $attr (i32.load8_u (i32.add (local.get $maddr) (i32.const ${VBANK_DELTA}))))
    (if (i32.and (local.get $lcdc) (i32.const 0x10))
      (then (local.set $addr (i32.add (i32.const ${VRAM0})
              (i32.mul (local.get $tno) (i32.const 16)))))
      (else
        (if (i32.ge_u (local.get $tno) (i32.const 128))
          (then (local.set $tno (i32.sub (local.get $tno) (i32.const 256)))))
        (local.set $addr (i32.add (i32.const ${VRAM0 + 0x1000})
          (i32.mul (local.get $tno) (i32.const 16))))))
    (if (i32.and (local.get $attr) (i32.const 0x08))
      (then (local.set $addr (i32.add (local.get $addr) (i32.const ${VBANK_DELTA})))))
    (if (i32.and (local.get $attr) (i32.const 0x40))
      (then (local.set $row (i32.sub (i32.const 7) (local.get $row)))))
    (local.set $addr (i32.add (local.get $addr) (i32.mul (local.get $row) (i32.const 2))))
    (local.set $bit (if (result i32) (i32.and (local.get $attr) (i32.const 0x20))
      (then (local.get $col)) (else (i32.sub (i32.const 7) (local.get $col)))))
    (local.set $ci (i32.or
      (i32.and (i32.shr_u (i32.load8_u (local.get $addr)) (local.get $bit)) (i32.const 1))
      (i32.shl (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $addr) (i32.const 1)))
                                   (local.get $bit)) (i32.const 1)) (i32.const 1))))
    (i32.store8 (i32.add (i32.const ${LINEBUF}) (local.get $fbx))
      (i32.or (local.get $ci) (i32.and (local.get $attr) (i32.const 0x80))))
    (i32.store (i32.add (global.get $fbrow) (i32.mul (local.get $fbx) (i32.const 4)))
      (call $cgb_pal (i32.const ${BGPAL}) (i32.and (local.get $attr) (i32.const 7))
                     (local.get $ci))))

  ;; gambatte's blank frame: the whole buffer cleared to gbcToRgb32(0xFFFF)
  (func $ppu_blank
    (local $i i32) (local $w i32)
    (local.set $w (call $cgb_rgba (i32.const 0x7FFF)))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${FB_W * FB_H})))
      (i32.store (i32.add (i32.const ${fb}) (i32.shl (local.get $i) (i32.const 2))) (local.get $w))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $ppu_line (param $y i32)
    (local $lcdc i32) (local $scx i32) (local $scy i32) (local $map i32)
    (local $x i32) (local $py i32) (local $px i32) (local $wx i32) (local $sx i32)
    (local $white i32)
    (global.set $fbrow (i32.add (i32.const ${fb}) (i32.mul (local.get $y) (i32.const ${FB_W * 4}))))
    (local.set $lcdc (i32.load8_u (i32.const ${IOREG + 0x40})))
    (if (i32.eqz (i32.and (local.get $lcdc) (i32.const 0x80)))
      (then
        (local.set $white (call $cgb_rgba (i32.const 0x7FFF)))
        (local.set $x (global.get $rx0))
        (block $bd (loop $bl
          (br_if $bd (i32.ge_u (local.get $x) (global.get $rx1)))
          (i32.store (i32.add (global.get $fbrow) (i32.mul (local.get $x) (i32.const 4)))
                     (local.get $white))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $bl)))
        (return)))
    (local.set $scy (i32.load8_u (i32.const ${IOREG + 0x42})))
    (local.set $scx (i32.load8_u (i32.const ${IOREG + 0x43})))
    (local.set $map (i32.add (i32.const ${VRAM0})
      (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x08))
        (then (i32.const 0x1C00)) (else (i32.const 0x1800)))))
    (local.set $py (i32.and (i32.add (local.get $y) (local.get $scy)) (i32.const 0xFF)))
    (local.set $x (global.get $rx0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (global.get $rx1)))
      (local.set $px (i32.and (i32.add (local.get $x) (local.get $scx)) (i32.const 0xFF)))
      (call $cgb_tilepix
        (i32.add (local.get $map) (i32.add (i32.mul (i32.shr_u (local.get $py) (i32.const 3))
                                                    (i32.const 32))
                                           (i32.shr_u (local.get $px) (i32.const 3))))
        (i32.and (local.get $py) (i32.const 7)) (i32.and (local.get $px) (i32.const 7))
        (local.get $lcdc) (local.get $x) (local.get $y))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l)))
    ;; ---- window: its own line counter, advanced only on lines it shows ----
    (local.set $wx (i32.sub (i32.load8_u (i32.const ${IOREG + 0x4B})) (i32.const 7)))
    (if (i32.and (i32.and (i32.ne (i32.and (local.get $lcdc) (i32.const 0x20)) (i32.const 0))
                          (i32.ge_u (local.get $y) (i32.load8_u (i32.const ${IOREG + 0x4A}))))
                 (i32.lt_s (local.get $wx) (i32.const ${FB_W})))
      (then
        (local.set $map (i32.add (i32.const ${VRAM0})
          (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x40))
            (then (i32.const 0x1C00)) (else (i32.const 0x1800)))))
        (local.set $py (global.get $wline))
        (local.set $x (if (result i32) (i32.lt_s (local.get $wx) (global.get $rx0))
          (then (global.get $rx0)) (else (local.get $wx))))
        (block $wd (loop $wl
          (br_if $wd (i32.ge_u (local.get $x) (global.get $rx1)))
          (local.set $sx (i32.sub (local.get $x) (local.get $wx)))
          (call $cgb_tilepix
            (i32.add (local.get $map) (i32.add (i32.mul (i32.shr_u (local.get $py) (i32.const 3))
                                                        (i32.const 32))
                                               (i32.shr_u (local.get $sx) (i32.const 3))))
            (i32.and (local.get $py) (i32.const 7)) (i32.and (local.get $sx) (i32.const 7))
            (local.get $lcdc) (local.get $x) (local.get $y))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $wl)))
        (global.set $winflag (i32.const 1))))
    (if (i32.and (local.get $lcdc) (i32.const 0x02))
      (then (call $cgb_sprites (local.get $y) (local.get $lcdc)))))

  ;; CGB sprite priority is OAM ORDER: the lowest-indexed sprite with an
  ;; opaque pixel owns that x, even when the BG then hides it. At most 10
  ;; sprites per line, chosen in OAM order.
  (func $cgb_sprites (param $y i32) (param $lcdc i32)
    (local $i i32) (local $n i32) (local $sy i32) (local $sx i32) (local $tno i32)
    (local $fl i32) (local $row i32) (local $addr i32) (local $lo i32) (local $hi i32)
    (local $px i32) (local $bit i32) (local $ci i32) (local $h i32) (local $sc i32)
    (local $bg i32) (local $o i32)
    (if (i32.eqz (global.get $rx0))
      (then (memory.fill (i32.const ${OBJCLAIM}) (i32.const 0) (i32.const ${FB_W}))))
    (local.set $h (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x04))
      (then (i32.const 16)) (else (i32.const 8))))
    (local.set $i (i32.const 0))
    (local.set $n (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 40)))
      (br_if $d (i32.ge_u (local.get $n) (i32.const 10)))
      (local.set $o (i32.add (i32.const ${OAM}) (i32.mul (local.get $i) (i32.const 4))))
      (local.set $sy (i32.sub (i32.load8_u (local.get $o)) (i32.const 16)))
      (if (i32.and (i32.ge_s (local.get $y) (local.get $sy))
                   (i32.lt_s (local.get $y) (i32.add (local.get $sy) (local.get $h))))
        (then
          (local.set $n (i32.add (local.get $n) (i32.const 1)))
          (local.set $sx (i32.sub (i32.load8_u (i32.add (local.get $o) (i32.const 1))) (i32.const 8)))
          (local.set $tno (i32.load8_u (i32.add (local.get $o) (i32.const 2))))
          (local.set $fl (i32.load8_u (i32.add (local.get $o) (i32.const 3))))
          (local.set $row (i32.sub (local.get $y) (local.get $sy)))
          (if (i32.and (local.get $fl) (i32.const 0x40))
            (then (local.set $row (i32.sub (i32.sub (local.get $h) (i32.const 1)) (local.get $row)))))
          (if (i32.eq (local.get $h) (i32.const 16))
            (then (local.set $tno (i32.and (local.get $tno) (i32.const 0xFE)))))
          (local.set $addr (i32.add (i32.const ${VRAM0})
            (i32.add (i32.mul (local.get $tno) (i32.const 16))
                     (i32.mul (local.get $row) (i32.const 2)))))
          (if (i32.and (local.get $fl) (i32.const 0x08))
            (then (local.set $addr (i32.add (local.get $addr) (i32.const ${VBANK_DELTA})))))
          (local.set $lo (i32.load8_u (local.get $addr)))
          (local.set $hi (i32.load8_u (i32.add (local.get $addr) (i32.const 1))))
          (local.set $px (i32.const 0))
          (block $sd (loop $sl
            (br_if $sd (i32.ge_u (local.get $px) (i32.const 8)))
            (local.set $sc (i32.add (local.get $sx) (local.get $px)))
            (local.set $bit (if (result i32) (i32.and (local.get $fl) (i32.const 0x20))
              (then (local.get $px)) (else (i32.sub (i32.const 7) (local.get $px)))))
            (local.set $ci (i32.or
              (i32.and (i32.shr_u (local.get $lo) (local.get $bit)) (i32.const 1))
              (i32.shl (i32.and (i32.shr_u (local.get $hi) (local.get $bit)) (i32.const 1))
                       (i32.const 1))))
            (if (i32.and (i32.ne (local.get $ci) (i32.const 0))
                  (i32.and (i32.ge_s (local.get $sc) (global.get $rx0))
                           (i32.lt_s (local.get $sc) (global.get $rx1))))
              (then
                (if (i32.eqz (i32.load8_u (i32.add (i32.const ${OBJCLAIM}) (local.get $sc))))
                  (then
                    (i32.store8 (i32.add (i32.const ${OBJCLAIM}) (local.get $sc)) (i32.const 1))
                    (local.set $bg (i32.load8_u (i32.add (i32.const ${LINEBUF}) (local.get $sc))))
                    ;; visible unless LCDC.0 (master priority) is on AND the BG
                    ;; pixel is colour 1-3 AND either priority bit asks for BG.
                    (if (i32.or (i32.eqz (i32.and (local.get $lcdc) (i32.const 1)))
                          (i32.or (i32.eqz (i32.and (local.get $bg) (i32.const 3)))
                                  (i32.eqz (i32.and (i32.or (local.get $bg) (local.get $fl))
                                                    (i32.const 0x80)))))
                      (then
                        (i32.store (i32.add (global.get $fbrow) (i32.mul (local.get $sc) (i32.const 4)))
                          (call $cgb_pal (i32.const ${OBJPAL}) (i32.and (local.get $fl) (i32.const 7))
                                         (local.get $ci)))))))))
            (local.set $px (i32.add (local.get $px) (i32.const 1)))
            (br $sl)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))
`;
}

const esc = (b) => Array.from(b, (x) => "\\" + x.toString(16).padStart(2, "0")).join("");

/**
 * gambatte's power-on WRAM, VRAM, OAM/FEA0 and FF00-FFFF (I/O, HRAM, IE) as
 * data segments, CGB or DMG variant.
 */
export function initstateDataWat(cgb = true) {
  const d = initstate();
  const w = Buffer.from(cgb ? d.wram : d.dmg_wram, "hex");
  const io = Buffer.from(cgb ? d.ioamhram : d.dmg_ioamhram, "hex");
  const v = Buffer.from(cgb ? d.vram_cgb : d.vram_dmg, "hex");
  const segs = [`  (data (i32.const ${WRAM}) "${esc(w.subarray(0, 0x1000))}")`];
  for (let n = 1; n < Math.floor(w.length / 0x1000); n++) {
    segs.push(`  (data (i32.const ${WRAMX + n * 0x1000}) "${esc(w.subarray(n * 0x1000, (n + 1) * 0x1000))}")`);
  }
  segs.push(`  (data (i32.const ${VRAM0}) "${esc(v.subarray(0, 0x2000))}")`);
  if (cgb) segs.push(`  (data (i32.const ${VRAM1}) "${esc(v.subarray(0x2000, 0x4000))}")`);
  segs.push(`  (data (i32.const ${OAM}) "${esc(io.subarray(0, 0x100))}")`);
  segs.push(`  (data (i32.const ${IOREG}) "${esc(io.subarray(0x100, 0x200))}")`);
  return segs.join("\n");
}

// ---- DMG mode on the same machine model -------------------------------------
// A DMG ROM runs on the same CPU/interrupt/timer/frame-hand-off model as CGB,
// with the DMG PPU below. Only the CGB-only registers are absent.
//
// The four shades are gambatte's DMG output as MEASURED from reference
// screenshots (255,251,255 / 165,162,165 / 82,81,82 / 0,0,0), as XRGB8888
// words.
export const DMG_SHADES = [0xFFFFFBFF, 0xFFA5A2A5, 0xFF525152, 0xFF000000];
export const SHADETAB = 0x11400;          // 4 x i32
export const SPRLIST = 0x11420;           // 10 x i32 (sorted OAM indices for the line)

/**
 * DMG scanline renderer, following gambatte ppu.cpp plotPixel:
 * - LCDC.0 off: BG and window show BGP colour 0 and count as colour 0 for
 *   sprite priority;
 * - up to 10 sprites per line in OAM order, then sorted by X: the smallest X
 *   (then lowest OAM index) wins a pixel;
 * - OBJ attr bit 7 hides the sprite behind BG colours 1-3;
 * - OBP0/OBP1 by attr bit 4.
 */
export function dmgRenderWat(fb) {
  const le = [];
  for (const w of DMG_SHADES) le.push(w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, (w >>> 24) & 0xFF);
  const escShades = esc(le);
  return `
  (global $fbrow (mut i32) (i32.const ${fb}))
  (data (i32.const ${SHADETAB}) "${escShades}")
  (func $shade (param $pal i32) (param $ci i32) (result i32)
    (i32.load (i32.add (i32.const ${SHADETAB})
      (i32.shl (i32.and (i32.shr_u (local.get $pal) (i32.shl (local.get $ci) (i32.const 1)))
                        (i32.const 3)) (i32.const 2)))))

  (func $ppu_blank
    (local $i i32) (local $w i32)
    (local.set $w (i32.load (i32.const ${SHADETAB})))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${FB_W * FB_H})))
      (i32.store (i32.add (i32.const ${fb}) (i32.shl (local.get $i) (i32.const 2))) (local.get $w))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $dmg_tilepix (param $maddr i32) (param $row i32) (param $col i32)
                     (param $lcdc i32) (param $fbx i32)
    (local $tno i32) (local $addr i32) (local $bit i32) (local $ci i32)
    (local.set $tno (i32.load8_u (local.get $maddr)))
    (if (i32.and (local.get $lcdc) (i32.const 0x10))
      (then (local.set $addr (i32.add (i32.const ${VRAM0}) (i32.mul (local.get $tno) (i32.const 16)))))
      (else
        (if (i32.ge_u (local.get $tno) (i32.const 128))
          (then (local.set $tno (i32.sub (local.get $tno) (i32.const 256)))))
        (local.set $addr (i32.add (i32.const ${VRAM0 + 0x1000}) (i32.mul (local.get $tno) (i32.const 16))))))
    (local.set $addr (i32.add (local.get $addr) (i32.mul (local.get $row) (i32.const 2))))
    (local.set $bit (i32.sub (i32.const 7) (local.get $col)))
    (local.set $ci (i32.or
      (i32.and (i32.shr_u (i32.load8_u (local.get $addr)) (local.get $bit)) (i32.const 1))
      (i32.shl (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $addr) (i32.const 1)))
                                   (local.get $bit)) (i32.const 1)) (i32.const 1))))
    (if (i32.eqz (i32.and (local.get $lcdc) (i32.const 1))) (then (local.set $ci (i32.const 0))))
    (i32.store8 (i32.add (i32.const ${LINEBUF}) (local.get $fbx)) (local.get $ci))
    (i32.store (i32.add (global.get $fbrow) (i32.mul (local.get $fbx) (i32.const 4)))
      (call $shade (i32.load8_u (i32.const ${IOREG + 0x47})) (local.get $ci))))

  (func $ppu_line (param $y i32)
    (local $lcdc i32) (local $scx i32) (local $scy i32) (local $map i32)
    (local $x i32) (local $py i32) (local $px i32) (local $wx i32) (local $sx i32)
    (global.set $fbrow (i32.add (i32.const ${fb}) (i32.mul (local.get $y) (i32.const ${FB_W * 4}))))
    (local.set $lcdc (i32.load8_u (i32.const ${IOREG + 0x40})))
    (if (i32.eqz (i32.and (local.get $lcdc) (i32.const 0x80)))
      (then
        (block $bd (loop $bl
          (br_if $bd (i32.ge_u (local.get $x) (global.get $rx1)))
          (i32.store (i32.add (global.get $fbrow) (i32.shl (local.get $x) (i32.const 2)))
                     (i32.load (i32.const ${SHADETAB})))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $bl)))
        (return)))
    (local.set $scy (i32.load8_u (i32.const ${IOREG + 0x42})))
    (local.set $scx (i32.load8_u (i32.const ${IOREG + 0x43})))
    (local.set $map (i32.add (i32.const ${VRAM0})
      (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x08))
        (then (i32.const 0x1C00)) (else (i32.const 0x1800)))))
    (local.set $py (i32.and (i32.add (local.get $y) (local.get $scy)) (i32.const 0xFF)))
    (local.set $x (global.get $rx0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (global.get $rx1)))
      (local.set $px (i32.and (i32.add (local.get $x) (local.get $scx)) (i32.const 0xFF)))
      (call $dmg_tilepix
        (i32.add (local.get $map) (i32.add (i32.mul (i32.shr_u (local.get $py) (i32.const 3)) (i32.const 32))
                                           (i32.shr_u (local.get $px) (i32.const 3))))
        (i32.and (local.get $py) (i32.const 7)) (i32.and (local.get $px) (i32.const 7))
        (local.get $lcdc) (local.get $x))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l)))
    (local.set $wx (i32.sub (i32.load8_u (i32.const ${IOREG + 0x4B})) (i32.const 7)))
    (if (i32.and (i32.and (i32.ne (i32.and (local.get $lcdc) (i32.const 0x20)) (i32.const 0))
                          (i32.ge_u (local.get $y) (i32.load8_u (i32.const ${IOREG + 0x4A}))))
                 (i32.lt_s (local.get $wx) (i32.const ${FB_W})))
      (then
        (local.set $map (i32.add (i32.const ${VRAM0})
          (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x40))
            (then (i32.const 0x1C00)) (else (i32.const 0x1800)))))
        (local.set $py (global.get $wline))
        (local.set $x (if (result i32) (i32.lt_s (local.get $wx) (global.get $rx0))
          (then (global.get $rx0)) (else (local.get $wx))))
        (block $wd (loop $wl
          (br_if $wd (i32.ge_u (local.get $x) (global.get $rx1)))
          (local.set $sx (i32.sub (local.get $x) (local.get $wx)))
          (call $dmg_tilepix
            (i32.add (local.get $map) (i32.add (i32.mul (i32.shr_u (local.get $py) (i32.const 3)) (i32.const 32))
                                               (i32.shr_u (local.get $sx) (i32.const 3))))
            (i32.and (local.get $py) (i32.const 7)) (i32.and (local.get $sx) (i32.const 7))
            (local.get $lcdc) (local.get $x))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $wl)))
        (global.set $winflag (i32.const 1))))
    (if (i32.and (local.get $lcdc) (i32.const 0x02))
      (then (call $dmg_sprites (local.get $y) (local.get $lcdc)))))

  (func $dmg_sprites (param $y i32) (param $lcdc i32)
    (local $i i32) (local $n i32) (local $j i32) (local $k i32) (local $t i32)
    (local $sy i32) (local $sx i32) (local $tno i32) (local $fl i32) (local $row i32)
    (local $addr i32) (local $lo i32) (local $hi i32) (local $px i32) (local $bit i32)
    (local $ci i32) (local $h i32) (local $sc i32) (local $o i32)
    (if (i32.eqz (global.get $rx0))
      (then (memory.fill (i32.const ${OBJCLAIM}) (i32.const 0) (i32.const ${FB_W}))))
    (local.set $h (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x04))
      (then (i32.const 16)) (else (i32.const 8))))
    ;; select up to 10 in OAM order
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 40)))
      (br_if $d (i32.ge_u (local.get $n) (i32.const 10)))
      (local.set $sy (i32.sub (i32.load8_u (i32.add (i32.const ${OAM}) (i32.shl (local.get $i) (i32.const 2))))
                              (i32.const 16)))
      (if (i32.and (i32.ge_s (local.get $y) (local.get $sy))
                   (i32.lt_s (local.get $y) (i32.add (local.get $sy) (local.get $h))))
        (then
          (i32.store (i32.add (i32.const ${SPRLIST}) (i32.shl (local.get $n) (i32.const 2))) (local.get $i))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ;; stable insertion sort by X
    (local.set $j (i32.const 1))
    (block $sd (loop $sl
      (br_if $sd (i32.ge_u (local.get $j) (local.get $n)))
      (local.set $t (i32.load (i32.add (i32.const ${SPRLIST}) (i32.shl (local.get $j) (i32.const 2)))))
      (local.set $k (local.get $j))
      (block $id (loop $il
        (br_if $id (i32.eqz (local.get $k)))
        (br_if $id (i32.le_u
          (i32.load8_u (i32.add (i32.const ${OAM + 1})
            (i32.shl (i32.load (i32.add (i32.const ${SPRLIST - 4}) (i32.shl (local.get $k) (i32.const 2))))
                     (i32.const 2))))
          (i32.load8_u (i32.add (i32.const ${OAM + 1}) (i32.shl (local.get $t) (i32.const 2))))))
        (i32.store (i32.add (i32.const ${SPRLIST}) (i32.shl (local.get $k) (i32.const 2)))
          (i32.load (i32.add (i32.const ${SPRLIST - 4}) (i32.shl (local.get $k) (i32.const 2)))))
        (local.set $k (i32.sub (local.get $k) (i32.const 1)))
        (br $il)))
      (i32.store (i32.add (i32.const ${SPRLIST}) (i32.shl (local.get $k) (i32.const 2))) (local.get $t))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $sl)))
    ;; draw in priority order; first opaque pixel claims x
    (local.set $j (i32.const 0))
    (block $dd (loop $dl
      (br_if $dd (i32.ge_u (local.get $j) (local.get $n)))
      (local.set $o (i32.add (i32.const ${OAM})
        (i32.shl (i32.load (i32.add (i32.const ${SPRLIST}) (i32.shl (local.get $j) (i32.const 2)))) (i32.const 2))))
      (local.set $sy (i32.sub (i32.load8_u (local.get $o)) (i32.const 16)))
      (local.set $sx (i32.sub (i32.load8_u (i32.add (local.get $o) (i32.const 1))) (i32.const 8)))
      (local.set $tno (i32.load8_u (i32.add (local.get $o) (i32.const 2))))
      (local.set $fl (i32.load8_u (i32.add (local.get $o) (i32.const 3))))
      (local.set $row (i32.sub (local.get $y) (local.get $sy)))
      (if (i32.and (local.get $fl) (i32.const 0x40))
        (then (local.set $row (i32.sub (i32.sub (local.get $h) (i32.const 1)) (local.get $row)))))
      (if (i32.eq (local.get $h) (i32.const 16))
        (then (local.set $tno (i32.and (local.get $tno) (i32.const 0xFE)))))
      (local.set $addr (i32.add (i32.const ${VRAM0})
        (i32.add (i32.mul (local.get $tno) (i32.const 16)) (i32.mul (local.get $row) (i32.const 2)))))
      (local.set $lo (i32.load8_u (local.get $addr)))
      (local.set $hi (i32.load8_u (i32.add (local.get $addr) (i32.const 1))))
      (local.set $px (i32.const 0))
      (block $pd (loop $pl
        (br_if $pd (i32.ge_u (local.get $px) (i32.const 8)))
        (local.set $sc (i32.add (local.get $sx) (local.get $px)))
        (local.set $bit (if (result i32) (i32.and (local.get $fl) (i32.const 0x20))
          (then (local.get $px)) (else (i32.sub (i32.const 7) (local.get $px)))))
        (local.set $ci (i32.or
          (i32.and (i32.shr_u (local.get $lo) (local.get $bit)) (i32.const 1))
          (i32.shl (i32.and (i32.shr_u (local.get $hi) (local.get $bit)) (i32.const 1)) (i32.const 1))))
        (if (i32.and (i32.ne (local.get $ci) (i32.const 0))
              (i32.and (i32.ge_s (local.get $sc) (global.get $rx0)) (i32.lt_s (local.get $sc) (global.get $rx1))))
          (then
            (if (i32.eqz (i32.load8_u (i32.add (i32.const ${OBJCLAIM}) (local.get $sc))))
              (then
                (i32.store8 (i32.add (i32.const ${OBJCLAIM}) (local.get $sc)) (i32.const 1))
                (if (i32.or (i32.eqz (i32.and (local.get $fl) (i32.const 0x80)))
                            (i32.eqz (i32.load8_u (i32.add (i32.const ${LINEBUF}) (local.get $sc)))))
                  (then
                    (i32.store (i32.add (global.get $fbrow) (i32.mul (local.get $sc) (i32.const 4)))
                      (call $shade
                        (i32.load8_u (i32.add (i32.const ${IOREG})
                          (if (result i32) (i32.and (local.get $fl) (i32.const 0x10))
                            (then (i32.const 0x49)) (else (i32.const 0x48)))))
                        (local.get $ci)))))))))
        (local.set $px (i32.add (local.get $px) (i32.const 1)))
        (br $pl)))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $dl))))
`;
}

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
// 115,200/115,200 pixels over 5 frames of a GBC cart, including pure (255,0,0) red,
// which any colour-correction mode would have moved.
//
// Ported from the earlier Python emitter; the emitted text is byte-identical.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { VRAM, WRAM, OAM, IOREG, FB_W, FB_H } from "./hw-gb.js";
import { RTC_CLOCK } from "../../recompile-section.js";

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
/** gambatte's $FF00-$FF7F write rules (see $iostore): 128 x {mode, OR mask} */
export const IOTAB = 0x11500;

/**
 * The $iostore table for a CGB or DMG build, from gambatte
 * Memory::nontrivial_ff_write.
 * @param {boolean} cgb
 */
export function ioTable(cgb) {
  const t = new Uint8Array(256);
  const set = (p, mode, or = 0) => { t[p * 2] = mode; t[p * 2 + 1] = or; };
  set(0x01, 1); set(0x05, 1); set(0x06, 1); set(0x07, 1, 0xF8); set(0x0F, 1, 0xE0);
  set(0x10, 2, 0x80); set(0x11, 3, 0x3F); set(0x12, 2); set(0x14, 2, 0xBF);
  set(0x16, 3, 0x3F); set(0x17, 2); set(0x19, 2, 0xBF);
  set(0x1A, 2, 0x7F); set(0x1C, 2, 0x9F); set(0x1E, 2, 0xBF);
  set(0x21, 2); set(0x22, 2); set(0x23, 2, 0xBF); set(0x24, 2); set(0x25, 2);
  set(0x26, 5);
  for (let p = 0x30; p < 0x40; p++) set(p, 1);
  set(0x41, 4); set(0x42, 1); set(0x43, 1); set(0x45, 1); set(0x47, 1); set(0x48, 1); set(0x49, 1);
  set(0x4A, 1); set(0x4B, 1);
  if (cgb) {
    set(0x56, 1, 0x3E); set(0x68, 1, 0x40); set(0x6A, 1, 0x40); set(0x6C, 1, 0xFE);
    set(0x72, 1); set(0x73, 1); set(0x74, 1); set(0x75, 1, 0x8F);
  }
  return t;
}

// ---- fitted timing constants ------------------------------------------
// These were environment knobs while they were being fitted.
// They are fixed now: every verified cart was verified with exactly these.
//
// Mid-line write position: pixel x = dots into the line - 80 - PIXDELAY.
// FITTED, not derived: -4 minimises one GBC cart's f600 line 48 (a SCX
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
  // gambatte Cartridge::loadROM's type switch (0x08/0x09 "ROM+RAM" run as
  // MBC2 there, and 0xEA as MBC1)
  if (t === 0x00) return "none";
  if ([0x01, 0x02, 0x03, 0xEA].includes(t)) return "mbc1";
  if ([0x05, 0x06, 0x08, 0x09].includes(t)) return "mbc2";
  if ([0x0F, 0x10, 0x11, 0x12, 0x13].includes(t)) return "mbc3";
  if ([0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E].includes(t)) return "mbc5";
  if (t === 0xFF) return "huc1";
  throw new Error(`gb: cartridge type $${t.toString(16).toUpperCase().padStart(2, "0")} is not supported (none/MBC1/MBC2/MBC3/MBC5/HuC1 only) - refusing to build.`);
}

/**
 * Cart RAM banks of 8KB as gambatte allocates them from header $0149:
 * 0 -> none (1 on MBC2), 1-2 -> 1, 3 -> 4, anything else -> 16.
 * @param {Uint8Array} img
 */
export function ramBanks(img) {
  const code = img.length > 0x149 ? img[0x149] : 0;
  if (code === 0) return mbcKind(img) === "mbc2" ? 1 : 0;
  if (code <= 2) return 1;
  if (code === 3) return 4;
  return 16;
}

/** Cart RAM banks 4-15 live at options.cramhi (see gbOriginAndPages). */
export const CRAMHI_BYTES = 12 * 0x2000;

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
  ;; cycles past $ioff of the current access (multi-access instructions)
  (global $accx (mut i32) (i32.const 0))
  ;; nonzero: the interrupt dispatch's own access offset, used as is
  (global $irqacc (mut i32) (i32.const 0))
  (global $pushv (mut i32) (i32.const 0))
  (global $rmwv (mut i32) (i32.const 0))
  (global $imm8 (mut i32) (i32.const 0))
  (global $imm16 (mut i32) (i32.const 0))
  (global $wline (mut i32) (i32.const 0))
  (global $linelen (mut i32) (i32.const 456))
  (global $rtc_sel (mut i32) (i32.const 0xF8))
  (global $serev (mut i32) (i32.const 0))
  (global $hdmanow (mut i32) (i32.const 0))
  (global $dmapos (mut i32) (i32.const 0xFE))
  (global $dmalast (mut i32) (i32.const -1))
  (global $dmapage (mut i32) (i32.const 0))
  (global $dmasrc (mut i32) (i32.const 5))
  ;; gambatte ioamhram[0x141] & 7 (see the $FF41 read) and the first line after LCD enable
  (global $statlow (mut i32) (i32.const 0))
  (global $lcdinactive (mut i32) (i32.const 0))
  (global $sercnt (mut i32) (i32.const 8))
  (global $serfast (mut i32) (i32.const 0))
`;
}

/** MBC control writes ($0000-$7FFF). */
/** $setbank for MBC1 (Mbc1::setRombank) and HuC1 (setRombank + setRambank). */
function setbankFn(mbc, imgLen, rb) {
  const bm = Math.max(2, Math.floor(imgLen / 0x4000)) - 1;
  const rm = Math.max(1, rb) - 1;
  if (mbc === "huc1") {
    return `  (func $setbank
    (global.set $rambank (if (result i32) (global.get $bankmode)
      (then (i32.and (global.get $bankhi) (i32.const ${rm}))) (else (i32.const 0))))
    (global.set $rombank (i32.and (if (result i32) (global.get $bankmode)
      (then (global.get $banklo))
      (else (i32.or (i32.shl (global.get $bankhi) (i32.const 6)) (global.get $banklo))))
      (i32.const ${bm}))))`;
  }
  // MBC1: (bank & 0x1F) == 0 selects bank | 1
  return `  (func $setbank
    (global.set $rombank (i32.and (if (result i32) (i32.and (global.get $banklo) (i32.const 0x1F))
      (then (global.get $banklo)) (else (i32.or (global.get $banklo) (i32.const 1))))
      (i32.const ${bm}))))`;
}

function romWrite(mbc, imgLen, rb, rtc) {
  // ROM banks as gambatte masks them (bank & (rombanks - 1), rombanks a
  // power of two); RAM banks & (rambanks - 1). Every mapper is gambatte's
  // (mem/cartridge.cpp Mbc0/Mbc1/Mbc2/Mbc3/Mbc5/HuC1 romWrite).
  const nbanks = Math.max(2, Math.floor(imgLen / 0x4000));
  const bm = nbanks - 1;
  const rm = Math.max(1, rb) - 1;
  const ramen = `
        (if (i32.lt_u (local.get $x) (i32.const 0x2000))
          (then (global.set $ramen (i32.eq (i32.and (local.get $v) (i32.const 0x0F))
                                           (i32.const 0x0A))) (return)))`;
  if (mbc === "none") return ramen + "(return)";
  if (mbc === "mbc5") {
    // $2000-$2FFF low 8 bits, $3000-$3FFF bit 8. Bank 0 IS selectable on
    // MBC5 (it is not remapped to 1 as on MBC1/MBC3). A rumble cart's
    // $4000-$4FFF write drops bit 3 (the motor).
    return ramen + `
        (if (i32.lt_u (local.get $x) (i32.const 0x3000))
          (then (global.set $banklo (local.get $v))
                (global.set $rombank (i32.and (i32.or (global.get $banklo)
                  (i32.shl (global.get $bankhi) (i32.const 8))) (i32.const ${bm})))
                (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x4000))
          (then (global.set $bankhi (i32.and (local.get $v) (i32.const 1)))
                (global.set $rombank (i32.and (i32.or (global.get $banklo)
                  (i32.shl (global.get $bankhi) (i32.const 8))) (i32.const ${bm})))
                (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x6000))
          (then (global.set $rambank (i32.and (local.get $v)
                  (i32.const ${rtc === "rumble" ? "0x0F" : "0x0F"})))
                ${rtc === "rumble" ? "(if (i32.lt_u (local.get $x) (i32.const 0x5000)) (then (global.set $rambank (i32.and (global.get $rambank) (i32.const 7)))))" : ""}
                (global.set $rambank (i32.and (global.get $rambank) (i32.const ${rm})))
                (return)))
        (return)`;
  }
  if (mbc === "mbc3") {
    // $2000-$3FFF 7-bit ROM bank (0 after masking reads as 1); $4000-$5FFF
    // RAM bank, or RTC register $08-$0C on a timer cart. The RTC is a stub:
    // registers hold what was written (gambatte's runs on the host clock).
    return ramen + `
        (if (i32.lt_u (local.get $x) (i32.const 0x4000))
          (then (global.set $rombank (i32.and (i32.and (local.get $v) (i32.const 0x7F)) (i32.const ${bm})))
                (if (i32.eqz (global.get $rombank)) (then (global.set $rombank (i32.const 1))))
                (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x6000))
          (then (global.set $rambank (i32.and (local.get $v) (i32.const ${rm})))
                ${rtc ? "(global.set $rtc_sel (i32.and (i32.sub (i32.and (local.get $v) (i32.const 0xF)) (i32.const 8)) (i32.const 0xFF)))" : ""}
                (return)))
        ${rtc ? "(call $rtc_latch (local.get $v))" : ""}
        (return)`;
  }
  if (mbc === "mbc2") {
    // address bit 8 picks the register: $0000 (A8=0) RAM enable, $2100
    // (A8=1) a 4-bit ROM bank (0 stays 0 in gambatte's Mbc2)
    return `
        (if (i32.eqz (i32.and (local.get $x) (i32.const 0x6100)))
          (then (global.set $ramen (i32.eq (i32.and (local.get $v) (i32.const 0x0F)) (i32.const 0x0A))) (return)))
        (if (i32.eq (i32.and (local.get $x) (i32.const 0x6100)) (i32.const 0x2100))
          (then (global.set $rombank (i32.and (i32.and (local.get $v) (i32.const 0x0F)) (i32.const ${bm}))) (return)))
        (return)`;
  }
  if (mbc === "huc1") {
    // $banklo = 6-bit ROM bank, $bankhi = 2-bit RAM bank, $bankmode = RAM mode
    return ramen + `
        (if (i32.lt_u (local.get $x) (i32.const 0x4000))
          (then (global.set $banklo (i32.and (local.get $v) (i32.const 0x3F))) (call $setbank) (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x6000))
          (then (global.set $bankhi (i32.and (local.get $v) (i32.const 3))) (call $setbank) (return)))
        (global.set $bankmode (i32.and (local.get $v) (i32.const 1)))
        (call $setbank)
        (return)`;
  }
  // MBC1 (gambatte Mbc1): $banklo holds the 7-bit ROM bank register. In RAM
  // mode a $2000 write replaces all of it and $4000 selects the RAM bank; in
  // ROM mode $4000 sets bits 5-6. The mode write itself remaps nothing.
  return ramen + `
        (if (i32.lt_u (local.get $x) (i32.const 0x4000))
          (then
            (global.set $banklo (if (result i32) (global.get $bankmode)
              (then (i32.and (local.get $v) (i32.const 0x1F)))
              (else (i32.or (i32.and (global.get $banklo) (i32.const 0x60)) (i32.and (local.get $v) (i32.const 0x1F))))))
            (call $setbank) (return)))
        (if (i32.lt_u (local.get $x) (i32.const 0x6000))
          (then
            (if (global.get $bankmode)
              (then (global.set $rambank (i32.and (i32.and (local.get $v) (i32.const 3)) (i32.const ${rm}))))
              (else (global.set $banklo (i32.or (i32.and (i32.shl (local.get $v) (i32.const 5)) (i32.const 0x60))
                                                (i32.and (global.get $banklo) (i32.const 0x1F))))
                    (call $setbank)))
            (return)))
        (global.set $bankmode (i32.and (local.get $v) (i32.const 1)))
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

function memWatText({ imgLen, mbc, romimg, probe, watchLo, watchHi, padptr, origin, cgb = true, rb = 4, rtc = false, rumble = false, cramhi, time }) {
  const mask = Math.max(1, imgLen) - 1;
  const setbankWat = setbankFn(mbc, imgLen, rb);
  // cart RAM: none (reads $FF, writes dropped), else enabled by $ramen
  // (HuC1 always reads: its disable is write-protect only)
  // an MBC3 clock is reachable (with RAM enabled) even with no RAM chip
  const ramOff = rb === 0 && !rtc ? "(i32.const 1)" : mbc === "huc1" ? "(i32.const 0)" : "(i32.eqz (global.get $ramen))";
  const ramWOff = rb === 0 && !rtc ? "(i32.const 1)" : "(i32.eqz (global.get $ramen))";
  const noRam = rb === 0 ? "(i32.const 1)" : "(i32.const 0)";
  return `
  ;; linear address of a WRAM CPU address in $C000-$FDFF (echo folded)
  (func $wram_lin (param $x i32) (result i32)
    (local.set $x (i32.or (i32.const 0xC000) (i32.and (local.get $x) (i32.const 0x1FFF))))
    (if (result i32) (i32.lt_u (local.get $x) (i32.const 0xD000))
      (then (local.get $x))
      (else (i32.add (i32.const ${WRAMX})
        (i32.add (i32.mul (global.get $svbk) (i32.const 0x1000))
                 (i32.and (local.get $x) (i32.const 0xFFF)))))))

  ;; cart RAM bank $rambank (masked to the chip): banks 0-3 at CRAMX, 4-15
  ;; at the high region
  (func $cram_lin (param $x i32) (result i32)
    (if (i32.ge_u (global.get $rambank) (i32.const 4))
      (then (return (i32.add (i32.const ${cramhi - 4 * 0x2000})
        (i32.add (i32.mul (global.get $rambank) (i32.const 0x2000))
                 (i32.sub (local.get $x) (i32.const 0xA000)))))))
    (i32.add (i32.const ${CRAMX})
      (i32.add (i32.mul (global.get $rambank) (i32.const 0x2000))
               (i32.sub (local.get $x) (i32.const 0xA000)))))

  ;; STAT mode bits from where the CPU is inside the current line.
  ;; cycles from the start of the current instruction to its memory access:
  ;; one 4-cycle fetch per instruction byte (OPLEN), CB-prefixed = 8.
  (func $ioff (result i32)
    (local $x i32) (local $op i32)
    (if (global.get $irqacc) (then (return (global.get $irqacc))))
    ;; the opcode byte as stored, not through $rd8: a RAM pc read through
    ;; $rd8 during an OAM DMA asked $dmaupd for the access cycle, which is
    ;; this function again (unbounded recursion in code run from HRAM)
    (local.set $x (i32.and (i32.add (global.get $curpc) (global.get $hbug)) (i32.const 0xFFFF)))
    (local.set $op (if (result i32) (i32.lt_u (local.get $x) (i32.const 0x4000))
      (then (i32.load8_u (i32.add (i32.const ${romimg}) (local.get $x))))
      (else (if (result i32) (i32.lt_u (local.get $x) (i32.const 0x8000))
        (then (i32.load8_u (i32.add (i32.const ${romimg})
          (i32.and (i32.add (i32.mul (global.get $rombank) (i32.const 0x4000))
                            (i32.sub (local.get $x) (i32.const 0x4000))) (i32.const ${mask})))))
        (else (if (result i32) (i32.lt_u (local.get $x) (i32.const 0xA000))
          (then (i32.load8_u (i32.add (i32.add (i32.const ${VRAM0}) (i32.sub (local.get $x) (i32.const 0x8000)))
                                      (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA})))))
          (else (if (result i32) (i32.lt_u (local.get $x) (i32.const 0xC000))
            (then (i32.load8_u (call $cram_lin (local.get $x))))
            (else (if (result i32) (i32.lt_u (local.get $x) (i32.const 0xFE00))
              (then (i32.load8_u (call $wram_lin (local.get $x))))
              (else (i32.load8_u (i32.add (i32.const ${IOREG}) (i32.sub (local.get $x) (i32.const 0xFF00)))))))))))))))
    (i32.add (i32.shl (i32.load8_u (i32.add (i32.const ${OPLEN}) (local.get $op))) (i32.const 2))
             (global.get $accx)))

  ;; gambatte LCD::getStat at the ACCESS cycle ($ioff into the instruction):
  ;; the mode bits and the LYC coincidence flag, computed from where the
  ;; access falls - past the end of the cart's current line it is already
  ;; the next line, as gambatte's LY counter has advanced by then.
  ;;   ly > 143: mode 1, except the last 4 cycles (0 at double speed) of 153
  ;;   first 80 video cycles: mode 2 (0 right after LCD enable)
  ;;   mode 3 while cc + ds - cgb + 2 is before the line's mode-0 time
  ;;   bit 2: LYC == LY with 153 comparing as 0 after its first 8 cycles
  (func $getstat (result i32)
    (local $used i32) (local $ly i32) (local $ttn i32) (local $st i32)
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
      (then (return (i32.const 0))))
    (call $m0sync (i32.add (global.get $abscc) (call $ioff)))
    (local.set $used (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (i32.mul (call $ioff) (i32.const ${STATIOFF}))))
    (local.set $ly (global.get $ln))
    (if (i32.ge_s (local.get $used) (global.get $linelen))
      (then
        (local.set $used (i32.sub (local.get $used) (global.get $linelen)))
        (local.set $ly (i32.add (local.get $ly) (i32.const 1)))
        (if (i32.ge_u (local.get $ly) (i32.const 154)) (then (local.set $ly (i32.const 0))))))
    (local.set $ttn (i32.sub (global.get $linelen) (local.get $used)))
    (if (i32.gt_u (local.get $ly) (i32.const 143))
      (then
        (if (i32.or (i32.lt_u (local.get $ly) (i32.const 153))
                    (i32.gt_s (local.get $ttn) (i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2)))))
          (then (local.set $st (i32.const 1)))))
      (else
        (if (i32.lt_s (i32.sub (i32.const 456) (i32.shr_s (local.get $ttn) (global.get $speed))) (i32.const 80))
          (then (if (i32.eqz (i32.and (global.get $lcdinactive) (i32.eqz (local.get $ly))))
                  (then (local.set $st (i32.const 2)))))
          (else
            (if (i32.and (i32.eq (local.get $ly) (global.get $ln))
                         (i32.lt_s (i32.add (local.get $used) (i32.add (global.get $speed) (i32.const ${cgb ? 1 : 2})))
                                   (i32.shl (global.get $m0dot) (global.get $speed))))
              (then (local.set $st (i32.const 3))))))))
    (if (i32.eq (local.get $ly) (i32.const 153))
      (then
        (if (i32.gt_s (i32.sub (local.get $ttn) (i32.shl (i32.const 448) (global.get $speed))) (i32.const 0))
          (then (local.set $ttn (i32.sub (local.get $ttn) (i32.shl (i32.const 448) (global.get $speed)))))
          (else (local.set $ly (i32.const 0))
                (local.set $ttn (i32.add (local.get $ttn) (global.get $linelen)))))))
    (if (i32.and (i32.eq (i32.load8_u (i32.const ${IOREG + 0x45})) (local.get $ly))
                 (i32.gt_s (local.get $ttn) (i32.sub (i32.const 4) (i32.shl (global.get $speed) (i32.const 2)))))
      (then (local.set $st (i32.or (local.get $st) (i32.const 4)))))
    (local.get $st))

  (func $stat_mode (result i32)
    (i32.and (call $getstat) (i32.const 3)))

  ;; $FF00 from wasmcart pad 0 (WCPad.buttons, u16 at the host's inputPtr).
  ;; ACTIVE LOW. P14 (bit 4) low selects the d-pad (right,left,up,down in
  ;; bits 0-3); P15 (bit 5) low selects A,B,Select,Start. wasmcart bits:
  ;; A 0, B 1, START 6, SELECT 7, UP 8, DOWN 9, LEFT 10, RIGHT 11.
  ;; Face buttons are read BY POSITION, the wasmcart convention: the Game
  ;; Boy's A is the EAST button (WC_BTN_B, bit 1) and its B the SOUTH button
  ;; (WC_BTN_A, bit 0), exactly where a libretro RetroPad puts them, so one
  ;; input schedule presses the same button on the cart and on gambatte.
  ;; P1 as gambatte keeps it (Memory::updateInput): the low nibble of
  ;; $FF00 is the state latched at each update, and a new press seen when
  ;; the latched nibble was all released requests the joypad interrupt.
  ;; Updated at the start of every host frame that runs, on $FF00 reads, and
  ;; when a write changes the select bits.
  (func $updinput
    (local $sel i32) (local $b i32) (local $n i32) (local $old i32)
    (local.set $old (i32.load8_u (i32.const ${IOREG})))
    (local.set $sel (i32.and (local.get $old) (i32.const 0x30)))
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
        (i32.or (i32.shr_u (i32.and (local.get $b) (i32.const 2)) (i32.const 1))
                (i32.shl (i32.and (local.get $b) (i32.const 1)) (i32.const 1)))
        (i32.or (i32.shr_u (i32.and (local.get $b) (i32.const 0x80)) (i32.const 5))
                (i32.shr_u (i32.and (local.get $b) (i32.const 0x40)) (i32.const 3)))))))))
    (if (i32.and (i32.ne (local.get $n) (i32.const 0x0F))
                 (i32.eq (i32.and (local.get $old) (i32.const 0x0F)) (i32.const 0x0F)))
      (then (i32.store8 (i32.const ${IOREG + 0x0F})
              (i32.or (i32.load8_u (i32.const ${IOREG + 0x0F})) (i32.const 0x10)))))
    (i32.store8 (i32.const ${IOREG}) (i32.or (i32.and (local.get $old) (i32.const 0xF0)) (local.get $n))))

  (func $joypad (result i32)
    (call $updinput)
    (i32.load8_u (i32.const ${IOREG})))

  (func $rd8 (param $a i32) (result i32)
    (local $x i32) (local $lyd i32) (local $lyl i32)
    (local.set $x (i32.and (local.get $a) (i32.const 0xFFFF)))
    ;; OAM DMA bus conflict (gambatte Memory::nontrivial_read): while a
    ;; transfer runs, reads in the source's conflict area see the byte the
    ;; DMA is moving - ROM included (a DMA from ROM, or from WRAM on a DMG)
    (if (i32.ne (global.get $dmalast) (i32.const -1))
      (then
        (call $dmaupd (i32.add (global.get $abscc) (call $ioff)))
        (if (i32.and (i32.lt_u (global.get $dmapos) (i32.const 0xA0)) (call $dmaconflict (local.get $x)))
          (then (return (i32.load8_u (i32.add (i32.const ${OAM}) (global.get $dmapos))))))))
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
    ;; ...nor readable (reads $FF)
    (if (i32.lt_u (local.get $x) (i32.const 0xA000))
      (then (if (i32.eq (call $stat_mode) (i32.const 3)) (then (return (i32.const 0xFF))))))
    (if (i32.lt_u (local.get $x) (i32.const 0xA000))
      (then (return (i32.load8_u (i32.add (i32.add (i32.const ${VRAM0})
        (i32.sub (local.get $x) (i32.const 0x8000)))
        (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA})))))))
    (if (i32.lt_u (local.get $x) (i32.const 0xC000))
      (then
        (if ${ramOff} (then (return (i32.const 0xFF))))
        (if ${rtc ? "(i32.lt_u (global.get $rtc_sel) (i32.const 5))" : "(i32.const 0)"}
          (then (return (i32.load8_u (i32.add (i32.const ${probe + 3840}) (global.get $rtc_sel))))))
        (if ${noRam} (then (return (i32.const 0xFF))))
        (return (i32.load8_u (call $cram_lin (local.get $x))))))
    (if (i32.lt_u (local.get $x) (i32.const 0xFE00))
      (then (return (i32.load8_u (call $wram_lin (local.get $x))))))
    ;; OAM reads $FF during an OAM DMA or while the PPU owns it (LCD::oamReadable)
    (if (i32.lt_u (local.get $x) (i32.const 0xFF00))
      (then
        (if (i32.or (i32.lt_u (global.get $dmapos) (i32.const 0xA0))
                    (i32.eqz (call $oamok (i32.add (global.get $abscc) (call $ioff)) (i32.const ${cgb ? 4 : 4}) (i32.const 3))))
          (then (return (i32.const 0xFF))))
        (return (i32.load8_u (i32.add (i32.const ${OAM})
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
    ;; An 8-cycle early DIV read moved one cart's DIV-seeded intro animation.
    (if (i32.eq (local.get $x) (i32.const 0xFF04))
      (then (return (i32.and (i32.shr_u (i32.add (global.get $divcnt) (i32.mul (call $ioff) (i32.const ${DIVIOFF}))) (i32.const 8))
                             (i32.const 0xFF)))))
    (if (i32.or (i32.eq (local.get $x) (i32.const 0xFF01)) (i32.eq (local.get $x) (i32.const 0xFF02)))
      (then (call $serupd (i32.add (global.get $abscc) (call $ioff)))))
    ;; TIMA at the access cycle (gambatte Tima::tima)
    (if (i32.eq (local.get $x) (i32.const 0xFF05))
      (then
        (if (i32.and (i32.load8_u (i32.const ${IOREG + 0x07})) (i32.const 4))
          (then (call $tupd (i32.add (global.get $abscc) (call $ioff)))))
        (return (i32.load8_u (i32.const ${IOREG + 0x05})))))
    ;; IF: the serial and timer requests due by the access cycle are visible
    ;; (gambatte Memory::updateIrqs before reading IF)
    (if (i32.eq (local.get $x) (i32.const 0xFF0F))
      (then
        (call $serupd (i32.add (global.get $abscc) (call $ioff)))
        (call $tirqupd (i32.add (global.get $abscc) (call $ioff)))
        (call $ifsync)
        (return (i32.or (i32.load8_u (i32.const ${IOREG + 0x0F})) (i32.const 0xE0)))))
    ;; gambatte: ioamhram[0x141] | getStat. The stored low bits are cleared
    ;; at LCD enable and hold the LYC flag latched at LCD disable ($statlow).
    (if (i32.eq (local.get $x) (i32.const 0xFF41))
      (then (return (i32.or (i32.or (i32.const 0x80)
                                    (i32.and (i32.load8_u (i32.const ${IOREG + 0x41})) (i32.const 0x78)))
                            (i32.or (global.get $statlow) (call $getstat))))))
    ;; LY as gambatte's LCD::getLyReg reads it, at the access cycle: an
    ;; access at or past the end of the cart's current line is already on
    ;; the next line (getLyReg updates the LY counter first), and the rules
    ;; apply to THAT line. Line 153 reads 0 (after its first 8 cycles at
    ;; double speed); the last 4 cycles of any other line already read the
    ;; NEXT line. So a read that lands just past the end of line 152 reads 0
    ;; at single speed, not 153. A sky-gradient raster effect starts on
    ;; \`wait LY == 0\`, which on this rule exits a line early.
    (if (i32.eq (local.get $x) (i32.const 0xFF44))
      (then
        (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
          (then (return (i32.const 0))))
        (local.set $lyd (i32.sub (global.get $cyc) (i32.mul (call $ioff) (i32.const ${LYIOFF}))))
        (local.set $lyl (global.get $ln))
        (if (i32.le_s (local.get $lyd) (i32.const 0))
          (then
            (local.set $lyd (i32.add (local.get $lyd) (global.get $linelen)))
            (local.set $lyl (if (result i32) (i32.eq (local.get $lyl) (i32.const 153))
                              (then (i32.const 0)) (else (i32.add (local.get $lyl) (i32.const 1)))))))
        (if (i32.eq (local.get $lyl) (i32.const 153))
          (then
            (if (i32.eqz (global.get $speed)) (then (return (i32.const 0))))
            (if (i32.le_s (local.get $lyd) (i32.const ${912 - 8}))
              (then (return (i32.const 0))))
            (return (i32.const 153))))
        (if (i32.le_s (local.get $lyd) (i32.const ${LYEARLY}))
          (then (return (i32.add (local.get $lyl) (i32.const 1)))))
        (return (local.get $lyl))))
    (if (i32.eq (local.get $x) (i32.const 0xFF4D))
      (then (return (i32.or (i32.or (i32.shl (global.get $speed) (i32.const 7))
                                    (global.get $key1prep)) (i32.const 0x7E)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF4F))
      (then (return (i32.or (global.get $vbk) (i32.const 0xFE)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF55))
      (then (return (i32.load8_u (i32.const ${IOREG + 0x55})))))
    (if (i32.eq (local.get $x) (i32.const 0xFF68))
      (then (return (i32.or (i32.load8_u (i32.const ${IOREG + 0x68})) (i32.const 0x40)))))
    (if (i32.and (i32.or (i32.eq (local.get $x) (i32.const 0xFF69)) (i32.eq (local.get $x) (i32.const 0xFF6B)))
                 (i32.eqz (call $palok (i32.add (global.get $abscc) (call $ioff)))))
      (then (return (i32.const 0xFF))))
    (if (i32.eq (local.get $x) (i32.const 0xFF69))
      (then (return (i32.load8_u (i32.add (i32.const ${BGPAL})
        (i32.and (i32.load8_u (i32.const ${IOREG + 0x68})) (i32.const 0x3F)))))))
    (if (i32.eq (local.get $x) (i32.const 0xFF6A))
      (then (return (i32.or (i32.load8_u (i32.const ${IOREG + 0x6A})) (i32.const 0x40)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF6B))
      (then (return (i32.load8_u (i32.add (i32.const ${OBJPAL})
        (i32.and (i32.load8_u (i32.const ${IOREG + 0x6A})) (i32.const 0x3F)))))))
    ;; SVBK reads back what was written | $F8 (ioamhram[0x170]); a 0 still
    ;; maps bank 1 ($svbk) but reads 0
    (if (i32.eq (local.get $x) (i32.const 0xFF70))
      (then (return (i32.load8_u (i32.const ${IOREG + 0x70})))))
    ;; NR52 status and wave RAM come from the APU (apu.js)
    (if (i32.or (i32.eq (local.get $x) (i32.const 0xFF26)) (i32.eq (i32.and (local.get $x) (i32.const 0xFFF0)) (i32.const 0xFF30)))
      (then (return (call $apu_ffr (local.get $x)))))
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
    ;; OAM DMA bus conflict (gambatte Memory::nontrivial_write): a write in
    ;; the source's conflict area lands in the OAM byte being moved - before
    ;; the MBC sees a ROM-area write (a push to $7FFF during a DMA from ROM)
    (if (i32.and (i32.ne (global.get $dmalast) (i32.const -1)) (i32.lt_u (local.get $x) (i32.const 0xFF80)))
      (then
        (call $dmaupd (i32.add (global.get $abscc) (call $ioff)))
        (if (i32.and (i32.lt_u (global.get $dmapos) (i32.const 0xA0)) (call $dmaconflict (local.get $x)))
          (then (i32.store8 (i32.add (i32.const ${OAM}) (global.get $dmapos)) (local.get $v)) (return)))))
    (if (i32.lt_u (local.get $x) (i32.const 0x8000))
      (then ${romWrite(mbc, imgLen, rb, rumble ? "rumble" : rtc)}))
    ;; VRAM is not writable while the PPU is in mode 3 (gambatte
    ;; LCD::vramAccessible); the write is dropped.
    (if (i32.lt_u (local.get $x) (i32.const 0xA000))
      (then (if (i32.eq (call $stat_mode) (i32.const 3)) (then (return)))))
    ;; LCD::vramChange: the PPU runs up to the write first
    (if (i32.lt_u (local.get $x) (i32.const 0xA000))
      (then (call $gp_update (i32.add (global.get $abscc) (call $ioff)))))
    (if (i32.lt_u (local.get $x) (i32.const 0xA000))
      (then (i32.store8 (i32.add (i32.add (i32.const ${VRAM0})
        (i32.sub (local.get $x) (i32.const 0x8000)))
        (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA}))) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $x) (i32.const 0xC000))
      (then
        (if ${ramWOff} (then (return)))
        (if ${rtc ? "(i32.lt_u (global.get $rtc_sel) (i32.const 5))" : "(i32.const 0)"}
          (then (call $rtc_write (local.get $v)) (return)))
        (if ${noRam} (then (return)))
        (i32.store8 (call $cram_lin (local.get $x)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $x) (i32.const 0xFE00))
      (then (call $set_origin (call $origin_slot (local.get $x)) (local.get $v))
            (i32.store8 (call $wram_lin (local.get $x)) (local.get $v)) (return)))
    ;; OAM writes only outside a DMA and while the PPU lets go of it
    ;; (LCD::oamWritable); $FEA0-$FEFF only on CGB
    (if (i32.lt_u (local.get $x) (i32.const 0xFF00))
      (then
        (if (i32.and (i32.and (i32.ge_u (global.get $dmapos) (i32.const 0xA0))
                              (call $oamok (i32.add (global.get $abscc) (call $ioff)) (i32.const ${cgb ? 4 : 3}) (i32.const 2)))
                     ${cgb ? '(i32.const 1)' : '(i32.lt_u (local.get $x) (i32.const 0xFEA0))'})
          (then (call $gp_oamw (i32.add (global.get $abscc) (call $ioff)))
                (i32.store8 (i32.add (i32.const ${OAM})
                  (i32.and (i32.sub (local.get $x) (i32.const 0xFE00)) (i32.const 0xFF)))
                  (local.get $v))))
        (return)))
    (if (i32.ge_u (local.get $x) (i32.const 0xFF80))
      (then (call $set_origin (call $origin_slot (local.get $x)) (local.get $v))
            (i32.store8 (i32.add (i32.const ${IOREG})
        (i32.sub (local.get $x) (i32.const 0xFF00))) (local.get $v)) (return)))
    ;; ---- I/O ----
    ;; LCD::lcdstatChange / lycRegChange run update(cc) first: the LCD
    ;; events due by the write cycle (a line's LYC event on that very cycle
    ;; still compares the old LYC) are processed before the write
    (if (i32.eq (local.get $x) (i32.const 0xFF41))
      (then (call $ifsync) (call $statwrite (local.get $v) (i32.add (global.get $abscc) (call $ioff)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF45))
      (then (call $ifsync) (call $lycwrite (local.get $v) (i32.add (global.get $abscc) (call $ioff)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF00))
      (then
        (if (i32.and (i32.xor (local.get $v) (i32.load8_u (i32.const ${IOREG}))) (i32.const 0x30))
          (then
            (i32.store8 (i32.const ${IOREG})
              (i32.or (i32.and (i32.load8_u (i32.const ${IOREG})) (i32.const 0xCF)) (i32.and (local.get $v) (i32.const 0x30))))
            (call $updinput)))
        (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF46))
      (then (call $oamdma (local.get $v) (i32.add (global.get $abscc) (call $ioff))) (return)))
    (if (i32.or (i32.and (i32.ge_u (local.get $x) (i32.const 0xFF40))
                         (i32.le_u (local.get $x) (i32.const 0xFF4B)))
                (i32.or (i32.eq (local.get $x) (i32.const 0xFF69))
                        (i32.eq (local.get $x) (i32.const 0xFF6B))))
      (then (call $ppu_write_hook)))
    ;; SC: a transfer on the INTERNAL clock takes 8 bit times (512 cycles
    ;; each, 16 in CGB fast mode) and shifts 1s into SB (no partner), then
    ;; requests the serial interrupt - gambatte Memory::nontrivial_ff_write
    ;; case 0x02 / updateSerial (built without HAVE_NETWORK). External clock
    ;; never completes, as on hardware with no cable.
    (if (i32.eq (local.get $x) (i32.const 0xFF02))
      (then
        (call $serupd (i32.add (global.get $abscc) (call $ioff)))
        (global.set $sercnt (i32.const 8))
        (global.set $serev (i32.const 0))
        (if (i32.eq (i32.and (local.get $v) (i32.const 0x81)) (i32.const 0x81))
          (then
            (local.set $i (i32.add (global.get $abscc) (call $ioff)))
            (global.set $serfast (i32.and (local.get $v) (i32.const ${cgb ? 2 : 0})))
            (global.set $serev (if (result i32) (global.get $serfast)
              (then (i32.add (i32.and (local.get $i) (i32.const -8)) (i32.const 0x80)))
              (else (i32.add (i32.and (local.get $i) (i32.const -256)) (i32.const 0x1000)))))))
        (i32.store8 (i32.const ${IOREG + 0x02}) (i32.or (local.get $v) (i32.const ${cgb ? 0x7C : 0x7E}))) (return)))
    ;; DIV reset at the write's cycle: the instruction's full cost is added
    ;; afterwards, so start at -(write offset)
    (if (i32.eq (local.get $x) (i32.const 0xFF04))
      (then (global.set $divcnt (i32.sub (i32.const 0) (call $ioff))) (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF44)) (then (return)))
    (if (i32.and (i32.ge_u (local.get $x) (i32.const 0xFF05)) (i32.le_u (local.get $x) (i32.const 0xFF07)))
      (then (call $timerwrite (i32.sub (local.get $x) (i32.const 0xFF00)) (local.get $v)
              (i32.add (global.get $abscc) (call $ioff))) (return)))
    ;; IF write: requests due before the write cycle are set first, then
    ;; overwritten (gambatte Memory::updateIrqs before setIfreg)
    (if (i32.eq (local.get $x) (i32.const 0xFF0F))
      (then
        (call $serupd (i32.add (global.get $abscc) (call $ioff)))
        (call $tirqupd (i32.add (global.get $abscc) (call $ioff)))
        (call $ifsync)))
    ;; the gambatte PPU shadow sees SCX/WX/WY/LCDC at the write's cycle
    (if (i32.eq (local.get $x) (i32.const 0xFF42)) (then (call $gp_scy (local.get $v) (i32.add (global.get $abscc) (call $ioff)))))
    ;; dmgBgPaletteChange / dmgSpPalette1Change / dmgSpPalette2Change
    (if (i32.and (i32.ge_u (local.get $x) (i32.const 0xFF47)) (i32.le_u (local.get $x) (i32.const 0xFF49)))
      (then (call $gp_update (i32.add (global.get $abscc) (call $ioff)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF43)) (then (call $gp_scx (local.get $v) (i32.add (global.get $abscc) (call $ioff)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF4B)) (then (call $gp_wx (local.get $v) (i32.add (global.get $abscc) (call $ioff)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF4A)) (then (call $gp_wy (local.get $v) (i32.add (global.get $abscc) (call $ioff)))))
    (if (i32.eq (local.get $x) (i32.const 0xFF40))
      (then
        ;; LCD::lcdcChange runs update(cc) first: the LCD events due by the
        ;; write (a line's LYC or mode-2 request) are set before the LCD goes off
        (if (i32.and (i32.xor (i32.load8_u (i32.const ${IOREG + 0x40})) (local.get $v)) (i32.const 0x80))
          (then (call $ifsync)))
        (call $gp_lcdc (local.get $v) (i32.add (global.get $abscc) (call $ioff)))
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
            ;; gambatte LCD::lcdcChange on enable: the STAT coincidence flag
            ;; is cleared (ioamhram[0x141] &= 0xF8) and an LYC=0 STAT
            ;; interrupt is requested at once if enabled.
            (i32.store8 (i32.const ${IOREG + 0x41})
              (i32.and (i32.load8_u (i32.const ${IOREG + 0x41})) (i32.const 0xF8)))
            (global.set $statlow (i32.const 0))
            (global.set $lcdinactive (i32.const 1))
            (global.set $skipnext (i32.eqz (global.get $blanklcd)))
            ;; line 0 starts AT THE WRITE, which is $ioff cycles into the
            ;; instruction (gambatte lyCounter.reset(0, cc) at the write's cc);
            ;; the instruction's full cost is subtracted after this.
            (global.set $cycbias (i32.add (global.get $cycbias)
              (i32.sub (i32.add (global.get $linelen) (call $ioff)) (global.get $cyc))))
            (global.set $cyc (i32.add (global.get $linelen) (call $ioff)))
            ;; the LCD events restart with the new LY counter (lcdcChange)
            (i32.store8 (i32.const ${IOREG + 0x40}) (local.get $v))
            (call $lcdevreset (i32.add (global.get $abscc) (call $ioff)) (i32.const 1))
            (global.set $m0next (i32.and (global.get $statreg) (i32.const 0x08)))
            (call $m3setup)
            (global.set $hdmadone (i32.const 1))))
        ;; LCD switched OFF: LY reads 0 and gambatte schedules its next frame
        ;; event 4 lines (1824 cycles) out; that event only arms the blank
        ;; state, and blank frames then follow every 70224 cycles. Counted
        ;; from the WRITE's cycle ($ioff into the instruction), as $offcd is
        ;; measured from the line start (the frame loop's $offevent).
        (if (i32.and (i32.ne (i32.and (local.get $old) (i32.const 0x80)) (i32.const 0))
                     (i32.eqz (i32.and (local.get $v) (i32.const 0x80))))
          (then
            (global.set $statlow (i32.and (call $getstat) (i32.const 4)))
            (global.set $ly (i32.const 0))
            (global.set $offcd (i32.add (i32.shl (i32.const 1824) (global.get $speed))
              (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (call $ioff))))
            ;; an HBlank DMA running when the LCD goes off is flagged at once
            ;; (case 0x40: flagHdmaReq): one block, and with the LCD off the
            ;; transfer ends there ($FF55 = $FF)
            (if (global.get $hdma_on)
              (then (global.set $hdma_len (i32.const 1))
                    (call $hdma_block (i32.add (i32.add (global.get $abscc) (call $ioff)) (i32.const 4)))
                    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))))))
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
        ;; palette RAM is not writable in mode 3 (LCD::cgbpAccessible)
        (if (call $palok (i32.add (global.get $abscc) (call $ioff)))
          (then (call $gp_update (i32.add (global.get $abscc) (call $ioff)))
                (i32.store8 (i32.add (i32.const ${BGPAL}) (i32.and (local.get $i) (i32.const 0x3F)))
                            (local.get $v))))
        (if (i32.and (local.get $i) (i32.const 0x80))
          (then (i32.store8 (i32.const ${IOREG + 0x68})
                  (i32.or (i32.const 0x80)
                    (i32.and (i32.add (local.get $i) (i32.const 1)) (i32.const 0x3F))))))
        (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF6B))
      (then
        (local.set $i (i32.load8_u (i32.const ${IOREG + 0x6A})))
        ;; palette RAM is not writable in mode 3 (LCD::cgbpAccessible)
        (if (call $palok (i32.add (global.get $abscc) (call $ioff)))
          (then (call $gp_update (i32.add (global.get $abscc) (call $ioff)))
                (i32.store8 (i32.add (i32.const ${OBJPAL}) (i32.and (local.get $i) (i32.const 0x3F)))
                            (local.get $v))))
        (if (i32.and (local.get $i) (i32.const 0x80))
          (then (i32.store8 (i32.const ${IOREG + 0x6A})
                  (i32.or (i32.const 0x80)
                    (i32.and (i32.add (local.get $i) (i32.const 1)) (i32.const 0x3F))))))
        (return)))
    (if (i32.eq (local.get $x) (i32.const 0xFF70))
      (then ${cgb ? `(global.set $svbk
              (if (result i32) (i32.eqz (i32.and (local.get $v) (i32.const 7)))
                (then (i32.const 1)) (else (i32.and (local.get $v) (i32.const 7)))))
            (i32.store8 (i32.const ${IOREG + 0x70}) (i32.or (local.get $v) (i32.const 0xF8)))` : ""}
            (return)))
    (call $iostore (i32.sub (local.get $x) (i32.const 0xFF00)) (local.get $v)))

  ;; The rest of $FF00-$FF7F, register by register as gambatte's
  ;; Memory::nontrivial_ff_write stores them (IOTAB: mode, OR mask):
  ;;   0 not stored (write-only, unused, or absent on this model)
  ;;   1 stored as data | mask
  ;;   2 sound register: stored as data | mask only while the APU is on
  ;;   3 NR11/NR21: APU off -> ignored on CGB, length bits only on DMG
  ;;   4 STAT: (old & 0x87) | (data & 0x78)
  ;;   5 NR52: switching off writes 0 through every register $FF10-$FF25
  (func $iostore (param $p i32) (param $v i32)
    (local $m i32) (local $or i32) (local $on i32) (local $i i32)
    (local.set $m (i32.load8_u (i32.add (i32.const ${IOTAB}) (i32.shl (local.get $p) (i32.const 1)))))
    (local.set $or (i32.load8_u (i32.add (i32.const ${IOTAB + 1}) (i32.shl (local.get $p) (i32.const 1)))))
    (local.set $on (i32.and (i32.load8_u (i32.const ${IOREG + 0x26})) (i32.const 0x80)))
    ;; the sound side of $FF10-$FF3F (apu.js), before the register byte is stored
    (call $apu_ffw (local.get $p) (local.get $v))
    (block $done
      (br_if $done (i32.eqz (local.get $m)))
      (if (i32.eq (local.get $m) (i32.const 2)) (then (br_if $done (i32.eqz (local.get $on)))))
      (if (i32.eq (local.get $m) (i32.const 3))
        (then (if (i32.eqz (local.get $on))
                (then ${cgb ? '(br $done)' : '(local.set $v (i32.and (local.get $v) (i32.const 0x3F)))'}))))
      (if (i32.eq (local.get $m) (i32.const 4))
        (then (local.set $v (i32.or (i32.and (i32.load8_u (i32.const ${IOREG + 0x41})) (i32.const 0x87))
                                    (i32.and (local.get $v) (i32.const 0x78))))))
      (if (i32.eq (local.get $m) (i32.const 5))
        (then
          ;; (a 0x80 bit ANDed with an eqz 1 was always 0: the zero writes never ran)
          (if (i32.and (i32.ne (i32.and (i32.xor (local.get $v) (i32.load8_u (i32.const ${IOREG + 0x26}))) (i32.const 0x80)) (i32.const 0))
                       (i32.eqz (i32.and (local.get $v) (i32.const 0x80))))
            (then
              (local.set $i (i32.const 0x10))
              (block $d (loop $l
                (br_if $d (i32.ge_u (local.get $i) (i32.const 0x26)))
                (call $iostore (local.get $i) (i32.const 0))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $l)))
              (call $apu_poweroff)))
          (local.set $v (i32.or (i32.and (local.get $v) (i32.const 0x80))
                                (i32.and (i32.load8_u (i32.const ${IOREG + 0x26})) (i32.const 0x7F))))))
      (i32.store8 (i32.add (i32.const ${IOREG}) (local.get $p)) (i32.or (local.get $v) (local.get $or)))))

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
  ;; af\` (seen in one GBC cart): the call landed two bytes in, skipped the push, and the
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

  ;; the opcodes $ram_interp interprets itself: jp/jp cc/call/call cc/
  ;; ret/reti/ret cc/jr/jr cc/rst/jp (hl)
  (func $ram_isctl (param $op i32) (result i32)
    (i32.or (i32.or (i32.or (i32.eq (local.get $op) (i32.const 0xC3)) (i32.eq (local.get $op) (i32.const 0xCD)))
                    (i32.or (i32.eq (local.get $op) (i32.const 0xC9)) (i32.eq (local.get $op) (i32.const 0xD9))))
      (i32.or (i32.or (i32.eq (local.get $op) (i32.const 0x18)) (i32.eq (local.get $op) (i32.const 0xE9)))
        (i32.or (i32.eq (i32.and (local.get $op) (i32.const 0xC7)) (i32.const 0xC7))
          (i32.or (i32.eq (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0x20))
            (i32.lt_u (i32.sub (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0xC0)) (i32.const 5)))))))

  ;; byte $k of the current instruction, read at its own fetch cycle (4k):
  ;; an operand in memory the PPU or an OAM DMA is blocking reads as the
  ;; bus sees it at THAT cycle (gambatte PC_READ)
  (func $opfetch (param $a i32) (param $k i32) (result i32)
    (local $v i32)
    (global.set $accx (i32.const 0))
    (global.set $accx (i32.sub (i32.shl (local.get $k) (i32.const 2)) (call $ioff)))
    (local.set $v (call $rd8 (i32.and (local.get $a) (i32.const 0xFFFF))))
    (global.set $accx (i32.const 0))
    (local.get $v))

  ;; high byte first, at $hiat cycles past $ioff (gambatte PUSH)
  (func $ram_push (param $v i32) (param $hiat i32)
    (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (global.set $accx (local.get $hiat))
    (call $wr8 (i32.and (i32.add (global.get $sp) (i32.const 1)) (i32.const 0xFFFF))
               (i32.shr_u (i32.and (local.get $v) (i32.const 0xFFFF)) (i32.const 8)))
    (global.set $accx (i32.add (local.get $hiat) (i32.const 4)))
    (call $wr8 (global.get $sp) (i32.and (local.get $v) (i32.const 0xFF)))
    (global.set $accx (i32.const 0)))

  (func $ram_pop (param $loat i32) (result i32)
    (local $v i32)
    (global.set $accx (local.get $loat))
    (local.set $v (call $rd8 (global.get $sp)))
    (global.set $accx (i32.add (local.get $loat) (i32.const 4)))
    (local.set $v (i32.or (local.get $v)
      (i32.shl (call $rd8 (i32.and (i32.add (global.get $sp) (i32.const 1)) (i32.const 0xFFFF)))
               (i32.const 8))))
    (global.set $accx (i32.const 0))
    (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (local.get $v))

  ;; Control flow is interpreted here even for a byte-intact ROM copy: the
  ;; ROM arm's return address (call, rst) and relative target (jr) are the
  ;; ROM's, so a copy run as its ROM arm pushed a ROM address and jumped
  ;; back into ROM. Everything else in an intact copy runs as its ROM arm.
  (func $ram_interp (result i32)
    (local $op i32) (local $t i32) (local $nx i32) (local $o i32)
    (local.set $op (call $opfetch (i32.add (global.get $pc) (global.get $hbug)) (i32.const 0)))
    ;; ...and so is anything whose operand bytes reach into $FE00-$FF7F
    ;; (OAM/IO), where a read depends on the cycle it happens at
    (if (i32.and (i32.and (i32.eqz (call $ram_isctl (local.get $op)))
                          (i32.and (i32.eqz (global.get $hbug)) (i32.ge_u (global.get $pc) (i32.const 0x8000))))
                 (i32.or (i32.lt_u (global.get $pc) (i32.const 0xFDFE)) (i32.ge_u (global.get $pc) (i32.const 0xFF80))))
      (then
        (local.set $o (call $get_origin (global.get $pc)))
        ;; a banked original must end inside its window: the arm of an
        ;; instruction ending at $7FFF falls through to the window's start,
        ;; not to the next RAM byte (a lone $00 written after a read of the
        ;; bank's last byte carries that byte as provenance)
        (if (i32.and (i32.ge_u (local.get $o) (i32.const 0x4001))
              (i32.gt_u (i32.add (i32.and (i32.sub (local.get $o) (i32.const 1)) (i32.const 0x3FFF))
                          (i32.load8_u (i32.add (i32.const ${OPLEN}) (local.get $op)))) (i32.const 0x3FFF)))
          (then (local.set $o (i32.const 0))))
        (if (local.get $o)
          (then (if (call $ram_bytes_intact (global.get $pc) (local.get $o))
                  (then (return (i32.const 0))))))))
    (i32.store (i32.const ${probe + 232}) (i32.add (i32.load (i32.const ${probe + 232})) (i32.const 1)))
    ;; only the instruction's own operand bytes are fetched: a read past
    ;; them is a bus access at a LATER cycle (it advanced an OAM DMA early)
    (local.set $nx (i32.load8_u (i32.add (i32.const ${OPLEN}) (local.get $op))))
    (local.set $t (i32.const 0))
    (if (i32.ge_u (local.get $nx) (i32.const 2))
      (then (local.set $t (call $opfetch (i32.add (global.get $pc) (i32.const 1)) (i32.const 1)))))
    (if (i32.ge_u (local.get $nx) (i32.const 3))
      (then (local.set $t (i32.or (local.get $t)
              (i32.shl (call $opfetch (i32.add (global.get $pc) (i32.const 2)) (i32.const 2)) (i32.const 8))))))
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
          (then (call $ram_push (local.get $nx) (i32.const 4)) (global.set $pc (local.get $t))
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
          (then (global.set $pc (call $ram_pop
                  (select (i32.const 4) (i32.const 0) (i32.eq (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0xC0)))))
                (if (i32.eq (local.get $op) (i32.const 0xD9)) (then (global.set $ime (i32.const 1))))
                ;; ret/reti 16, ret cc taken 20
                (global.set $cyc (i32.sub (global.get $cyc)
                  (select (i32.const 20) (i32.const 16)
                    (i32.eq (i32.and (local.get $op) (i32.const 0xE7)) (i32.const 0xC0))))))
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
        (call $ram_push (i32.and (i32.add (global.get $pc) (i32.const 1)) (i32.const 0xFFFF)) (i32.const 0))
        (global.set $pc (i32.and (local.get $op) (i32.const 0x38)))
        (global.set $cyc (i32.sub (global.get $cyc) (i32.const 16)))
        (return (i32.const 1))))
    ;; jp (hl)
    (if (i32.eq (local.get $op) (i32.const 0xE9))
      (then
        (global.set $pc (i32.or (i32.shl (global.get $h) (i32.const 8)) (global.get $l)))
        (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
        (return (i32.const 1))))
    (call $tmpl_run (local.get $op) (local.get $t)))

  ;; serial transfer progress at absolute cycle $cc (gambatte updateSerial,
  ;; non-network build): done -> SB = ((SB+1) << bits left) - 1, SC bit 7
  ;; cleared, serial interrupt; else shift in the bits already clocked.
  (func $serupd (param $cc i32)
    (local $tgt i32)
    (if (i32.eqz (global.get $serev)) (then (return)))
    (if (i32.ge_s (i32.sub (local.get $cc) (global.get $serev)) (i32.const 0))
      (then
        (i32.store8 (i32.const ${IOREG + 0x01})
          (i32.sub (i32.shl (i32.add (i32.load8_u (i32.const ${IOREG + 0x01})) (i32.const 1))
                            (global.get $sercnt)) (i32.const 1)))
        (i32.store8 (i32.const ${IOREG + 0x02})
          (i32.and (i32.load8_u (i32.const ${IOREG + 0x02})) (i32.const 0x7F)))
        (global.set $serev (i32.const 0))
        (call $irq (i32.const 8))
        (return)))
    (local.set $tgt (if (result i32) (global.get $serfast)
      (then (i32.shr_u (i32.add (i32.sub (global.get $serev) (local.get $cc)) (i32.const 0xF)) (i32.const 4)))
      (else (i32.shr_u (i32.add (i32.sub (global.get $serev) (local.get $cc)) (i32.const 0x1FF)) (i32.const 9)))))
    (i32.store8 (i32.const ${IOREG + 0x01})
      (i32.sub (i32.shl (i32.add (i32.load8_u (i32.const ${IOREG + 0x01})) (i32.const 1))
                        (i32.sub (global.get $sercnt) (local.get $tgt))) (i32.const 1)))
    (global.set $sercnt (local.get $tgt)))

  ;; ---- OAM DMA as gambatte runs it (Memory::updateOamDma): one byte per
  ;; 4 cycles, the first 8 cycles after the $FF46 write, OAM unreadable and
  ;; invisible to the PPU while it runs; the source is read as each byte is
  ;; moved. $dmapos 0xFE idle, 0xFF warming up, 0..0x9F moving.
  (func $dmasrctype (param $page i32) (result i32)
    (if (i32.lt_u (local.get $page) (i32.const 0xA0))
      (then (return (if (result i32) (i32.lt_u (local.get $page) (i32.const 0x80)) (then (i32.const 0)) (else (i32.const 2))))))
    (if (i32.lt_u (local.get $page) (i32.const ${cgb ? 0xE0 : 0xFE}))
      (then (return (if (result i32) (i32.lt_u (local.get $page) (i32.const 0xC0)) (then (i32.const 1)) (else (i32.const 3))))))
    (i32.const 4))

  (func $dmabyte (param $k i32) (result i32)
    (local $a i32)
    (local.set $a (i32.or (i32.shl (global.get $dmapage) (i32.const 8)) (local.get $k)))
    (if (i32.eqz (global.get $dmasrc))
      (then (return (if (result i32) (i32.lt_u (local.get $a) (i32.const 0x4000))
        (then (i32.load8_u (i32.add (i32.const ${romimg}) (local.get $a))))
        (else (i32.load8_u (i32.add (i32.const ${romimg})
          (i32.and (i32.add (i32.mul (global.get $rombank) (i32.const 0x4000)) (i32.sub (local.get $a) (i32.const 0x4000)))
                   (i32.const ${mask})))))))))
    (if (i32.eq (global.get $dmasrc) (i32.const 2))
      (then (return (i32.load8_u (i32.add (i32.add (i32.const ${VRAM0}) (i32.sub (local.get $a) (i32.const 0x8000)))
                                          (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA})))))))
    (if (i32.eq (global.get $dmasrc) (i32.const 1))
      (then
        (if ${ramOff} (then (return (i32.const 0xFF))))
        (if ${rtc ? "(i32.lt_u (global.get $rtc_sel) (i32.const 5))" : "(i32.const 0)"}
          (then (return (i32.load8_u (i32.add (i32.const ${probe + 3840}) (global.get $rtc_sel))))))
        (if ${noRam} (then (return (i32.const 0xFF))))
        (return (i32.load8_u (call $cram_lin (local.get $a))))))
    (if (i32.eq (global.get $dmasrc) (i32.const 3))
      (then (return (i32.load8_u (call $wram_lin (local.get $a))))))
    ${cgb ? '(i32.const 0xFF)' : '(if (result i32) (i32.eq (global.get $dmapage) (i32.const 0xFF)) (then (i32.const 0)) (else (i32.const 0xFF)))'})

  (func $dmaupd (param $cc i32)
    (local $n i32)
    (if (i32.eq (global.get $dmalast) (i32.const -1)) (then (return)))
    (local.set $n (i32.shr_s (i32.sub (local.get $cc) (global.get $dmalast)) (i32.const 2)))
    (block $d (loop $l
      (br_if $d (i32.le_s (local.get $n) (i32.const 0)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (global.set $dmapos (i32.and (i32.add (global.get $dmapos) (i32.const 1)) (i32.const 0xFF)))
      (global.set $dmalast (i32.add (global.get $dmalast) (i32.const 4)))
      ;; the PPU loses the OAM at the first byte and gets it back after the
      ;; last (startOamDma / endOamDma at lastOamDmaUpdate - 1)
      (if (i32.eqz (global.get $dmapos)) (then (call $gp_oamptr (i32.const 1) (i32.sub (global.get $dmalast) (i32.const 1)))))
      (if (i32.lt_u (global.get $dmapos) (i32.const 0xA0))
        (then (i32.store8 (i32.add (i32.const ${OAM}) (global.get $dmapos)) (call $dmabyte (global.get $dmapos))))
        (else (if (i32.eq (global.get $dmapos) (i32.const 0xA0))
          (then (call $gp_oamptr (i32.const 0) (i32.sub (global.get $dmalast) (i32.const 1)))
                (global.set $dmapos (i32.const 0xFE)) (global.set $dmasrc (i32.const 5))
                (global.set $dmalast (i32.const -1)) (br $d)))))
      (br $l))))

  ;; the conflict areas of Memory::isInOamDmaConflictArea, per source
  (func $dmaconflict (param $p i32) (result i32)
    (local $up i32) (local $lo i32) (local $w i32)
    (if (i32.eq (global.get $dmasrc) (i32.const 2))
      (then (local.set $up (i32.const 0xA000)) (local.set $lo (i32.const 0)) (local.set $w (i32.const 0x8000)))
      (else (if (i32.ge_u (global.get $dmasrc) (i32.const 5)) (then (return (i32.const 0))))
        ${cgb ? `(if (i32.eq (global.get $dmasrc) (i32.const 3))
          (then (local.set $up (i32.const 0xFE00)) (local.set $lo (i32.const 0)) (local.set $w (i32.const 0xC000)))
          (else (local.set $up (i32.const 0xC000)) (local.set $lo (i32.const 0x8000)) (local.set $w (i32.const 0x2000))))`
        : '(local.set $up (i32.const 0xFE00)) (local.set $lo (i32.const 0x8000)) (local.set $w (i32.const 0x2000))'}))
    (i32.and (i32.lt_u (local.get $p) (local.get $up))
             (i32.ge_u (i32.sub (local.get $p) (local.get $lo)) (local.get $w))))

  ;; $FF46 written at $cc (Memory::nontrivial_ff_write case 0x46)
  (func $oamdma (param $page i32) (param $cc i32)
    (i32.store (i32.const ${probe + 20}) (i32.add (i32.load (i32.const ${probe + 20})) (i32.const 1)))
    (i32.store (i32.const ${probe + 24}) (local.get $page))
    (call $dmaupd (local.get $cc))
    (if (i32.ne (global.get $dmalast) (i32.const -1))
      (then (call $gp_oamptr (i32.const 0) (local.get $cc))
            (global.set $dmapos (i32.const 0xFE)) (global.set $dmasrc (i32.const 5))))
    (global.set $dmalast (local.get $cc))
    (global.set $dmapage (local.get $page))
    (global.set $dmasrc (call $dmasrctype (local.get $page)))
    (i32.store8 (i32.const ${IOREG + 0x46}) (local.get $page)))

  ;; LCD::oamReadable / oamWritable at $cc: $near = the line-end window
  ;; (4 or 3 + cgb, minus ds*3 or ds*2 via $dsm)
  (func $oamok (param $cc i32) (param $near i32) (param $dsm i32) (result i32)
    (local $ly i32) (local $ttn i32) (local $lc i32)
    (call $m0sync (local.get $cc))
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80))) (then (return (i32.const 1))))
    (local.set $ly (call $lyat (local.get $cc)))
    (if (i32.and (global.get $lcdinactive) (i32.eqz (local.get $ly)))
      (then (if (i32.lt_s (i32.sub (local.get $cc) (i32.sub (global.get $tly) (global.get $linelen)))
                          (i32.shl (i32.const 80) (global.get $speed)))
              (then (return (i32.const 1))))))
    (local.set $ttn (i32.sub (global.get $tly) (local.get $cc)))
    (local.set $lc (i32.sub (i32.const 456) (i32.shr_s (local.get $ttn) (global.get $speed))))
    (if (i32.ge_s (i32.sub (i32.add (local.get $lc) (local.get $near)) (i32.mul (global.get $speed) (local.get $dsm))) (i32.const 456))
      (then (return (i32.and (i32.ge_u (local.get $ly) (i32.const 143)) (i32.ne (local.get $ly) (i32.const 153))))))
    (if (i32.ge_u (local.get $ly) (i32.const 144)) (then (return (i32.const 1))))
    (if (i32.ne (local.get $ly) (global.get $ln)) (then (return (i32.const 0))))
    (i32.ge_s (i32.add (local.get $cc) (i32.add (global.get $speed) (i32.const ${cgb ? 1 : 2})))
              (i32.add (i32.sub (global.get $tly) (global.get $linelen)) (i32.shl (global.get $m0dot) (global.get $speed)))))

  ;; LCD::cgbpAccessible at $cc
  (func $palok (param $cc i32) (result i32)
    (local $ly i32) (local $lc i32)
    (call $m0sync (local.get $cc))
    (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80))) (then (return (i32.const 1))))
    (local.set $ly (call $lyat (local.get $cc)))
    (if (i32.ge_u (local.get $ly) (i32.const 144)) (then (return (i32.const 1))))
    (local.set $lc (i32.sub (i32.const 456) (i32.shr_s (i32.sub (global.get $tly) (local.get $cc)) (global.get $speed))))
    (if (i32.lt_s (local.get $lc) (i32.add (i32.const 80) (global.get $speed))) (then (return (i32.const 1))))
    (if (i32.ne (local.get $ly) (global.get $ln)) (then (return (i32.const 0))))
    (i32.ge_s (local.get $cc)
              (i32.sub (i32.add (i32.add (i32.sub (global.get $tly) (global.get $linelen)) (i32.shl (global.get $m0dot) (global.get $speed)))
                                (i32.const 3))
                       (global.get $speed))))

${setbankWat}
  ;; STOP: with KEY1 bit 0 armed it is the CGB speed switch.
  ;; gambatte Memory::stop: with KEY1 armed the speed flips and, if the LCD
  ;; is off, the next frame event moves to 70224<<(old speed) from now.
  ;; EITHER WAY the CPU then sleeps until an interrupt or 0x20000 cycles
  ;; (+8 from double speed) pass - a pause of most of a frame that shifts
  ;; every later frame boundary if it is left out.
  ;; ---- MID-LINE WRITES -------------------------------------------------
  ;; The line is drawn during mode 3 in SEGMENTS: a write to a PPU register
  ;; (LCDC, SCY/SCX, BGP/OBP, WY/WX, CGB palette data) while mode 3 is running
  ;; first draws the pixels already output, with the old value. A cart can
  ;; change a register part-way along a line; drawing the whole
  ;; line at once put the change at x=0.
  ;; x output at a write = dots into the line - 80 - PIXDELAY.
  ;; the picture is drawn by the PPU shadow (ppu-shadow.js) now; the line
  ;; renderer below is kept only as the reference the shadow replaced
  (func $ppu_catch (param $x i32)
    (return)
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
    (local $old i32) (local $d i32)
    (local.set $old (global.get $speed))
    ;; gambatte Memory::stop spends 4 (+4 at double speed) cycles on top of
    ;; the opcode fetch the cycle table charges: cc += 4 + 4 * ds.
    (global.set $cyc (i32.sub (global.get $cyc) (i32.add (i32.const 4) (i32.shl (local.get $old) (i32.const 2)))))
    (if (global.get $key1prep)
      (then
        ;; the sound up to the switch at the old speed (Memory::stop:
        ;; psg_.generateSamples(cc + 4 + 4 * ds) after the opcode fetch)
        (call $apu_gen (i32.add (global.get $abscc) (i32.add (i32.const 8) (i32.shl (local.get $old) (i32.const 2)))))
        (call $gp_speed (i32.add (global.get $abscc) (i32.add (i32.const 8) (i32.shl (local.get $old) (i32.const 2)))))
        (global.set $speed (i32.xor (global.get $speed) (i32.const 1)))
        (global.set $key1prep (i32.const 0))
        ;; gambatte PPU::speedChange keeps the VIDEO position: the rest of
        ;; the current line (in video cycles, 456 per line) now takes
        ;; rest << newspeed CPU cycles. The switch happens after the opcode
        ;; fetch (4, charged after this body) and the cycles spent above.
        (local.set $d (global.get $cyc))
        (global.set $cyc (i32.add (i32.shl (i32.shr_s (i32.sub (global.get $cyc) (i32.const 4)) (local.get $old))
                                           (global.get $speed))
                                  (i32.const 4)))
        ;; the rescale is not time passing: keep it out of the clocks
        (global.set $cycbias (i32.add (global.get $cycbias) (i32.sub (global.get $cyc) (local.get $d))))
        (global.set $linelen (i32.shl (i32.const 456) (global.get $speed)))
        (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
          ;; counted from gambatte's cc after STOP: the fetch (4, charged
          ;; after this body) plus the cycles just spent
          (then (global.set $offcd (i32.add (i32.shl (i32.const 70224) (local.get $old))
                  (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (i32.const 4))))))))
    (global.set $halted (i32.const 1))
    (global.set $stopcd (i32.add (i32.const 0x20000) (i32.shl (local.get $old) (i32.const 3)))))

  ;; ---- HDMA / GDMA, as gambatte-memory.cpp intevent_dma does it ----------
  ;; The source/destination are INTERNAL counters: $FF51-$FF54 writes set
  ;; them, and a transfer leaves them advanced, so a second $FF55 write
  ;; continues where the first stopped. (One cart loads 4KB of tiles with
  ;; one address setup and four GDMAs; reloading from the registers each time
  ;; copied the first 1KB four times.) A source in VRAM or above $FDFF reads
  ;; $FF. Each byte costs 2<<speed cycles.
  ;; $cc: the cycle the block starts at. An OAM DMA keeps running through
  ;; it (intevent_dma): each byte takes 2<<ds cycles, and every 4 cycles the
  ;; OAM DMA moves on - copying the HDMA's byte, at the HDMA source's low
  ;; address, instead of its own
  (func $hdma_block (param $cc i32)
    (local $i i32) (local $s i32) (local $d i32) (local $lo i32)
    ;; Memory::event brings the OAM DMA up to the event's cycle first
    (if (i32.ne (global.get $dmalast) (i32.const -1)) (then (call $dmaupd (local.get $cc))))
    (local.set $lo (global.get $dmalast))
    (global.set $dmalast (i32.const -1))
    (local.set $i (i32.const 0))
    (block $dn (loop $l
      (br_if $dn (i32.ge_u (local.get $i) (i32.const 16)))
      (local.set $s (i32.and (global.get $hdma_src) (i32.const 0xFFFF)))
      (local.set $d (if (result i32)
        (i32.or (i32.eq (i32.and (local.get $s) (i32.const 0xE000)) (i32.const 0x8000))
                (i32.gt_u (local.get $s) (i32.const 0xFDFF)))
        (then (i32.const 0xFF))
        (else (call $rd8 (local.get $s)))))
      (local.set $cc (i32.add (local.get $cc) (i32.shl (i32.const 2) (global.get $speed))))
      (if (i32.and (i32.ne (local.get $lo) (i32.const -1))
                   (i32.gt_s (i32.sub (i32.sub (local.get $cc) (i32.const 3)) (local.get $lo)) (i32.const 0)))
        (then
          (global.set $dmapos (i32.and (i32.add (global.get $dmapos) (i32.const 1)) (i32.const 0xFF)))
          (local.set $lo (i32.add (local.get $lo) (i32.const 4)))
          (if (i32.lt_u (global.get $dmapos) (i32.const 0xA0))
            (then
              (if (i32.eqz (global.get $dmapos)) (then (call $gp_oamptr (i32.const 1) (i32.sub (local.get $lo) (i32.const 1)))))
              (i32.store8 (i32.add (i32.const ${OAM}) (i32.and (local.get $s) (i32.const 0xFF))) (local.get $d)))
            (else (if (i32.eq (global.get $dmapos) (i32.const 0xA0))
              (then (call $gp_oamptr (i32.const 0) (i32.sub (local.get $lo) (i32.const 1)))
                    (global.set $dmapos (i32.const 0xFE)) (global.set $dmasrc (i32.const 5))
                    (local.set $lo (i32.const -1))))))))
      (call $gp_update (local.get $cc))
      (i32.store8 (i32.add (i32.add (i32.const ${VRAM0})
          (i32.and (global.get $hdma_dst) (i32.const 0x1FFF)))
          (i32.mul (global.get $vbk) (i32.const ${VBANK_DELTA})))
        (local.get $d))
      (global.set $hdma_src (i32.and (i32.add (global.get $hdma_src) (i32.const 1)) (i32.const 0xFFFF)))
      (global.set $hdma_dst (i32.and (i32.add (global.get $hdma_dst) (i32.const 1)) (i32.const 0xFFFF)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $dmalast (local.get $lo))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.shl (i32.const 32) (global.get $speed))))
    (global.set $hdma_len (i32.sub (global.get $hdma_len) (i32.const 1)))
    (i32.store8 (i32.const ${IOREG + 0x55})
      (if (result i32) (i32.le_s (global.get $hdma_len) (i32.const 0))
        (then (i32.const 0xFF))
        (else (i32.sub (global.get $hdma_len) (i32.const 1)))))
    (if (i32.le_s (global.get $hdma_len) (i32.const 0))
      (then (global.set $hdma_on (i32.const 0))))
    ;; the destination reached $10000 (intevent_dma: (dest + length) &
    ;; 0x10000): the transfer stops there with bit 7 set in $FF55
    (if (i32.eqz (global.get $hdma_dst))
      (then
        ;; (with the LCD off the rest of the length is dropped: dmaLength = 0)
        (i32.store8 (i32.const ${IOREG + 0x55})
          (if (result i32) (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80))
            (then (i32.or (i32.and (i32.sub (global.get $hdma_len) (i32.const 1)) (i32.const 0xFF)) (i32.const 0x80)))
            (else (i32.const 0xFF))))
        (global.set $hdma_len (i32.const 0))
        (global.set $hdma_on (i32.const 0)))))

  (func $hdma_start (param $v i32)
    (local $w i32)
    ;; Writing bit 7 = 0 while an HBlank DMA runs CANCELS it.
    ;; LCD::disableHdma runs update(cc) first: a block whose request is due
    ;; by the write's cycle is already flagged and still moves (16 bytes,
    ;; $hdmaforce), with the length the write left in $FF55
    (if (i32.and (global.get $hdma_on) (i32.eqz (i32.and (local.get $v) (i32.const 0x80))))
      (then
        (global.set $hdma_on (i32.const 0))
        (i32.store8 (i32.const ${IOREG + 0x55}) (i32.or (i32.and (local.get $v) (i32.const 0x7F))
                                                        (i32.const 0x80)))
        (local.set $w (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (call $ioff)))
        (if (i32.and (i32.and (i32.eqz (global.get $hdmadone))
                              (i32.and (i32.ne (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)) (i32.const 0))
                                       (i32.lt_u (global.get $ln) (i32.const 144))))
                     (i32.ge_s (local.get $w) (global.get $hdmaat)))
          (then
            (global.set $hdma_len (i32.add (i32.and (local.get $v) (i32.const 0x7F)) (i32.const 1)))
            (global.set $hdmaforce (i32.const 1))
            (global.set $hdmanow (i32.const 1)) (global.set $hdmadone (i32.const 1))))
        (return)))
    ;; bit 7 set while an HBlank DMA already runs: only the length changes
    ;; (case 0x55 stores data & 0x7F; LCD::enableHdma is not called again)
    (if (global.get $hdma_on)
      (then
        (global.set $hdma_len (i32.add (i32.and (local.get $v) (i32.const 0x7F)) (i32.const 1)))
        (i32.store8 (i32.const ${IOREG + 0x55}) (i32.and (local.get $v) (i32.const 0x7F)))
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
        ;; cutting it after one block left one cart's tiles as zeros.
        (if (i32.eqz (i32.and (i32.load8_u (i32.const ${IOREG + 0x40})) (i32.const 0x80)))
          (then
            (global.set $hdma_len (i32.const 1))
            (call $hdma_block (i32.add (i32.add (global.get $abscc) (call $ioff)) (i32.const 4)))
            (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
            (return)))
        ;; Enabled INSIDE this line's HDMA period (gambatte LCD::enableHdma,
        ;; isHdmaPeriod: LY < 144, more than 4 cycles before the next line,
        ;; at or after the mode-0 time + 1 - ds): one block is requested at
        ;; once, moved after this instruction ($statev), and the next is the
        ;; next line's.
        ;; LCD::enableHdma predicts the line's mode-0 time from the PPU state
        ;; now (a mid-line SCX/WX/... write only invalidated it), and the
        ;; HDMA request follows it (hdmaTimeFromM0Time)
        (call $m0sync (i32.add (global.get $abscc) (call $ioff)))
        (if (i32.eqz (global.get $hdmadone))
          (then (global.set $hdmaat (i32.add (i32.shl (global.get $m0dot) (global.get $speed))
                                             (i32.sub (i32.const 1) (global.get $speed))))))
        (local.set $w (i32.add (i32.sub (global.get $linelen) (global.get $cyc)) (call $ioff)))
        (if (i32.and (i32.and (i32.lt_u (global.get $ln) (i32.const 144))
                              (i32.gt_s (i32.sub (global.get $linelen) (local.get $w)) (i32.const 4)))
                     (i32.ge_s (local.get $w) (global.get $hdmaat)))
          (then (global.set $hdmanow (i32.const 1)) (global.set $hdmadone (i32.const 1))))
        (return)))
    ;; General DMA: everything now, from the end of the writing instruction
    (local.set $w (i32.add (i32.add (global.get $abscc) (call $ioff)) (i32.add (i32.const 4) (global.get $cyc))))
    (block $d (loop $l
      (br_if $d (i32.le_s (global.get $hdma_len) (i32.const 0)))
      (call $hdma_block (i32.sub (local.get $w) (global.get $cyc)))
      (br $l)))
    (global.set $cyc (i32.sub (global.get $cyc) (i32.const 4)))
    (global.set $hdma_on (i32.const 0)))
  ;; ---- MBC3 real-time clock, gambatte's Rtc (mem/rtc.cpp) ----
  ;; The clock is the host's frame clock (WCInfo time, ms since the cart
  ;; started) as time() reads Date.now(): trunc((baseMs + ms) / 1000), with
  ;; RTC_CLOCK.baseMs. gambatte's baseTime starts at time(0) when the ROM
  ;; loads, so what a game sees is elapsed seconds either way; verification
  ;; pins the reference's Date.now() to the same frames (setPinnedClock).
  (global $rtc_base (mut i64) (i64.const ${RTC_CLOCK.baseMs / 1000}))
  (global $rtc_halt (mut i64) (i64.const 0))
  (global $rtc_last (mut i32) (i32.const 0))
  (func $rtc_now (result i64)
    (i64.trunc_f64_u (f64.div (f64.add (f64.const ${RTC_CLOCK.baseMs}) (f64.load (i32.const ${time}))) (f64.const 1000))))
  (func $rtc_reg (param $i i32) (result i32) (i32.load8_u (i32.add (i32.const ${probe + 3840}) (local.get $i))))
  (func $rtc_set (param $i i32) (param $v i32) (i32.store8 (i32.add (i32.const ${probe + 3840}) (local.get $i)) (local.get $v)))
  ;; the clock's current time: frozen at haltTime while DH bit 6 is set
  (func $rtc_unix (result i64)
    (if (result i64) (i32.and (call $rtc_reg (i32.const 4)) (i32.const 0x40)) (then (global.get $rtc_halt)) (else (call $rtc_now))))
  ;; Rtc::doLatch
  (func $rtc_dolatch
    (local $t i64)
    (local.set $t (i64.sub (call $rtc_unix) (global.get $rtc_base)))
    (block $d (loop $l
      (br_if $d (i64.le_u (local.get $t) (i64.const ${0x1FF * 86400})))
      (global.set $rtc_base (i64.add (global.get $rtc_base) (i64.const ${0x1FF * 86400})))
      (local.set $t (i64.sub (local.get $t) (i64.const ${0x1FF * 86400})))
      (call $rtc_set (i32.const 4) (i32.or (call $rtc_reg (i32.const 4)) (i32.const 0x80)))
      (br $l)))
    (call $rtc_set (i32.const 3) (i32.wrap_i64 (i64.and (i64.div_u (local.get $t) (i64.const 86400)) (i64.const 0xFF))))
    (call $rtc_set (i32.const 4) (i32.or (i32.and (call $rtc_reg (i32.const 4)) (i32.const 0xFE))
      (i32.wrap_i64 (i64.shr_u (i64.and (i64.div_u (local.get $t) (i64.const 86400)) (i64.const 0x100)) (i64.const 8)))))
    (local.set $t (i64.rem_u (local.get $t) (i64.const 86400)))
    (call $rtc_set (i32.const 2) (i32.wrap_i64 (i64.div_u (local.get $t) (i64.const 3600))))
    (local.set $t (i64.rem_u (local.get $t) (i64.const 3600)))
    (call $rtc_set (i32.const 1) (i32.wrap_i64 (i64.div_u (local.get $t) (i64.const 60))))
    (call $rtc_set (i32.const 0) (i32.wrap_i64 (i64.rem_u (local.get $t) (i64.const 60)))))
  ;; Rtc::latch ($6000-$7FFF)
  (func $rtc_latch (param $v i32)
    (if (i32.and (i32.eqz (global.get $rtc_last)) (i32.eq (local.get $v) (i32.const 1))) (then (call $rtc_dolatch)))
    (global.set $rtc_last (i32.ne (local.get $v) (i32.const 0))))
  ;; Rtc::write: setS/setM/setH/setDl/setDh move baseTime, then the register
  (func $rtc_write (param $v i32)
    (local $u i64) (local $o i64)
    (local.set $u (call $rtc_unix))
    (block $done
      (if (i32.eqz (global.get $rtc_sel))
        (then
          (global.set $rtc_base (i64.add (global.get $rtc_base) (i64.rem_u (i64.sub (local.get $u) (global.get $rtc_base)) (i64.const 60))))
          (global.set $rtc_base (i64.sub (global.get $rtc_base) (i64.extend_i32_u (local.get $v))))
          (br $done)))
      (if (i32.eq (global.get $rtc_sel) (i32.const 1))
        (then
          (local.set $o (i64.rem_u (i64.div_u (i64.sub (local.get $u) (global.get $rtc_base)) (i64.const 60)) (i64.const 60)))
          (global.set $rtc_base (i64.sub (i64.add (global.get $rtc_base) (i64.mul (local.get $o) (i64.const 60)))
                                         (i64.mul (i64.extend_i32_u (local.get $v)) (i64.const 60))))
          (br $done)))
      (if (i32.eq (global.get $rtc_sel) (i32.const 2))
        (then
          (local.set $o (i64.rem_u (i64.div_u (i64.sub (local.get $u) (global.get $rtc_base)) (i64.const 3600)) (i64.const 24)))
          (global.set $rtc_base (i64.sub (i64.add (global.get $rtc_base) (i64.mul (local.get $o) (i64.const 3600)))
                                         (i64.mul (i64.extend_i32_u (local.get $v)) (i64.const 3600))))
          (br $done)))
      (if (i32.eq (global.get $rtc_sel) (i32.const 3))
        (then
          (local.set $o (i64.and (i64.div_u (i64.sub (local.get $u) (global.get $rtc_base)) (i64.const 86400)) (i64.const 0xFF)))
          (global.set $rtc_base (i64.sub (i64.add (global.get $rtc_base) (i64.mul (local.get $o) (i64.const 86400)))
                                         (i64.mul (i64.extend_i32_u (local.get $v)) (i64.const 86400))))
          (br $done)))
      ;; DH: the day high bit, and the halt bit starting/stopping the clock
      (local.set $o (i64.and (i64.div_u (i64.sub (local.get $u) (global.get $rtc_base)) (i64.const 86400)) (i64.const 0x100)))
      (global.set $rtc_base (i64.add (global.get $rtc_base) (i64.mul (local.get $o) (i64.const 86400))))
      (global.set $rtc_base (i64.sub (global.get $rtc_base) (i64.mul (i64.extend_i32_u (i32.shl (i32.and (local.get $v) (i32.const 1)) (i32.const 8))) (i64.const 86400))))
      (if (i32.and (i32.xor (call $rtc_reg (i32.const 4)) (local.get $v)) (i32.const 0x40))
        (then
          (if (i32.and (local.get $v) (i32.const 0x40))
            (then (global.set $rtc_halt (call $rtc_now)))
            (else (global.set $rtc_base (i64.add (global.get $rtc_base) (i64.sub (call $rtc_now) (global.get $rtc_halt)))))))))
    (call $rtc_set (global.get $rtc_sel) (local.get $v)))
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
    (if (i32.lt_u (global.get $dmapos) (i32.const 0xA0)) (then (return)))
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
    (if (i32.lt_u (global.get $dmapos) (i32.const 0xA0)) (then (return)))
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

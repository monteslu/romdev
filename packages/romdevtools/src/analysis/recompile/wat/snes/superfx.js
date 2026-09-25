// The SuperFX (GSU-1 / GSU-2) coprocessor of a recompiled SNES
// cart, run as snes9x runs it: an instruction interpreter clocked in bursts
// of a fixed instruction count, one burst at the end of every scanline and
// one when the S-CPU starts the chip, with the result written back to the
// $3000-$32FF register space between bursts.
//
// Two sources:
//   - the instruction handlers (fxinst.cpp: every fx_* function, the
//     1024-entry opcode table over the ALT1/ALT2 prefix bits, the plot /
//     rpix table) are a MECHANICAL translation generated from the pinned
//     snes9x source into snes9x-superfx.json by
//     scripts/recompile-gen/snes9x-superfx.mjs (`--check` verifies);
//   - fxemu.cpp (FxReset's bank tables, fx_readRegisterSpace /
//     fx_writeRegisterSpace, fx_computeScreenPointers, fx_checkStartAddress,
//     FxEmulate / fx_run, S9xSuperFXExec, S9xSetSuperFX / S9xGetSuperFX) and
//     memmap.cpp's Map_SuperFXLoROMMap are ported by hand below, function
//     for function; the generator records fxemu.cpp's hash so a change to it
//     is noticed.
//
// snes9x's model, which the cart keeps exactly (it is what the reference
// does, not what the chip does): no GSU cycle timing (a burst is
// speedPerLine instructions, 2.5x with CLSR set), the S-CPU never waits for
// the GSU, the code cache is only its base register and flags (instructions
// are always fetched from the program bank), the ROM buffer is filled at
// once, PLOT writes the bitplanes directly (no pixel caches).
//
// Linear memory: the chip's own block `lay.CHIP` (above everything else):
//   +0x000  the $3000-$32FF register space (snes9x FillRAM + $3000)
//   +0x400  R0-R15 (GSU.avReg, uint32 each: snes9x keeps 32 bits between
//           writes back, e.g. an INC of $FFFF is $10000 until the burst ends)
//   +0x480  apvScreen[32] (linear addresses), +0x500 x[32]
//   +0x600  apvRomBank[256] as (base, mask): FxReset's bank table over the
//           ROM view below (and SRAM for banks $70-$73)
//   +0xE00  apvRamBank[4]
//   +0x1000 the ROM as the GSU sees it: snes9x's Memory.ROM[0, 2MB) (the
//           image, then zeros, plus the copier header's stale tail). Banks
//           $00-$3F read Map_SuperFXLoROMMap's replicated copy (each 32KB
//           block twice per 64KB bank), which is this view with the offset's
//           bit 15 dropped (mask $7FFF).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { ROM } from "./layout.js";

const FX = JSON.parse(readFileSync(new URL("./snes9x-superfx.json", import.meta.url), "utf8"));

/** Chip block offsets (bytes from lay.CHIP). */
export const GSU_OFF = Object.freeze({
  FXREG: 0x000, AVREG: 0x400, APVTAB: 0x480, XTAB: 0x500, ROMTAB: 0x600, RAMTAB: 0xe00, ROMVIEW: 0x1000,
});
/** The GSU's ROM view: snes9x's Memory.ROM up to 2MB (FxReset caps nRomBanks at $20). */
const ROMVIEW_SIZE = 0x200000;
/** 64KB pages the chip block needs. */
export const GSU_PAGES = Math.ceil((GSU_OFF.ROMVIEW + ROMVIEW_SIZE) / 0x10000);

/** snes9x Settings.SuperFXClockMultiplier (libretro's "snes9x_overclock_superfx" default, 100%). */
const CLOCK_MULTIPLIER = 100;

/**
 * S9xResetSuperFX's instructions per burst: speedPerLine =
 * (uint32) (5823405 * ((1.0 / (float) ROMFramesPerSecond) / ((float) V_Max))),
 * with V_Max at reset (262 NTSC, 312 PAL) and S9xSuperFXExec's CLSR and
 * multiplier arithmetic (uint32).
 * @param {boolean} pal
 */
export function burstLengths(pal) {
  const fps = pal ? 50 : 60, vmax = pal ? 312 : 262;
  const speed = Math.trunc(FX.speedConstant * ((1.0 / Math.fround(fps)) / Math.fround(vmax)));
  return {
    speedPerLine: speed,
    slow: Math.floor((speed * CLOCK_MULTIPLIER) / 100),
    fast: Math.floor((Math.floor((speed * 5) / 2) * CLOCK_MULTIPLIER) / 100),
  };
}

/**
 * The SRAM size snes9x gives a SuperFX cart (InitROM: ROM[$7FDA] == $33 ?
 * ROM[$7FBD] : 5) and the save_ram region libretro exposes for it
 * ((1 << (SRAMSize + 3)) * 128, capped at 128KB).
 * @param {Uint8Array} img  the loaded image (loader.js)
 */
export function superfxSram(img) {
  const sramSize = img[0x7fda] === 0x33 ? img[0x7fbd] : 5;
  const bytes = sramSize ? Math.min(0x20000, (1 << ((sramSize + 3) & 31)) * 128) : 0;
  return { sramSize, bytes };
}

/**
 * Map_SuperFXLoROMMap's part of the S-CPU map (memmap.cpp), for memmap.js:
 * LoROM at $00-$3F/$80-$BF:8000 (the first 2MB for images over 2MB), the
 * HiROM view at $40-$5F and $C0-$DF (or $C0-$FF over 2MB), the GSU RAM
 * (SRAM) at $00-$3F/$80-$BF:6000-7FFF, $70/$71 (and $F0/$F1 on GSU-1 sized
 * images) as plain memory (map_space), and the $3000-$3FFF block as the
 * chip's window: S9xGetPPU / S9xSetPPU hand $3000-$32FF to the GSU and
 * $3300-$3FFF are open bus / ignored.
 * @param {any} api  memmap.js buildMemMap's helpers
 * @param {number} sramBase  linear address of the SRAM buffer
 */
export function superfxMap(api, sramBase) {
  const { set, each, lorom, hirom, size, MAP_TYPE } = api;
  // "Check GSU revision (not 100% accurate but it works)": only the LoROM
  // size and the upper HiROM range differ.
  if (size > 0x200000) {
    lorom(0x00, 0x3f, 0x8000, 0xffff, 0x200000);
    lorom(0x80, 0xbf, 0x8000, 0xffff, 0x200000);
    hirom(0x40, 0x5f, 0x0000, 0xffff, 0x200000, 0);
    hirom(0xc0, 0xff, 0x0000, 0xffff, size, 0);
  } else {
    lorom(0x00, 0x3f, 0x8000, 0xffff, size);
    lorom(0x80, 0xbf, 0x8000, 0xffff, size);
    hirom(0x40, 0x5f, 0x0000, 0xffff, size, 0);
    hirom(0xc0, 0xdf, 0x0000, 0xffff, size, 0);
  }
  each(0x00, 0x3f, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + i - 0x6000));
  each(0x80, 0xbf, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + i - 0x6000));
  each(0x70, 0x70, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + i));
  each(0x71, 0x71, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + 0x10000 + i));
  if (size <= 0x200000) {
    each(0xf0, 0xf0, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + i));
    each(0xf1, 0xf1, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + 0x10000 + i));
  }
  // the register window (map_System put $2000-$3FFF on MAP_PPU)
  each(0x00, 0x3f, 0x3000, 0x3fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
  each(0x80, 0xbf, 0x3000, 0x3fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
}

/**
 * FxReset's bank tables as data: apvRomBank[256] as (base, mask) and
 * apvRamBank[4], for a ROM of `calc` bytes (snes9x CalculatedSize).
 * @param {number} chipBase  lay.CHIP
 * @param {number} sramBase  lay.SRAM
 * @param {number} calc
 */
export function bankTables(chipBase, sramBase, calc) {
  // InitROM: SuperFX.nRomBanks = CalculatedSize >> 15; FxReset caps it.
  let nRomBanks = calc >>> 15;
  if (nRomBanks > 0x20) nRomBanks = 0x20;
  const nRamBanks = 2;   // Memory::Init: "Most only use 1. 1=64KB=512Mb, 2=128KB=1024Mb"
  const view = chipBase + GSU_OFF.ROMVIEW;
  const rom = new Uint32Array(512);
  for (let i = 0; i < 256; i++) {
    let b = i & 0x7f;
    if (b >= 0x40) {
      if (nRomBanks > 1) b %= nRomBanks;
      else b &= 1;
      rom[i * 2] = view + (b << 16); rom[i * 2 + 1] = 0xffff;
    } else {
      // &pvRom[(b << 16) + 0x800000]: Map_SuperFXLoROMMap's replicated copy
      // of the 32KB block b, twice per bank
      b %= nRomBanks * 2;
      rom[i * 2] = view + b * 0x8000; rom[i * 2 + 1] = 0x7fff;
    }
  }
  const ram = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    ram[i] = sramBase + ((i % nRamBanks) << 16);
    rom[(0x70 + i) * 2] = ram[i]; rom[(0x70 + i) * 2 + 1] = 0xffff;
  }
  return { rom, ram, nRomBanks };
}

/** Bytes of a Uint32Array as a WAT string literal. */
function watBytes(u32) {
  const b = new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength);
  let s = "";
  for (const v of b) s += "\\" + v.toString(16).padStart(2, "0");
  return s;
}

/** GSU struct scalars (fxinst.h FxRegs_s) the handlers and fxemu.cpp use. */
const FIELDS = [
  "vColorReg", "vPlotOptionReg", "vStatusReg", "vPrgBankReg", "vRomBankReg", "vRamBankReg",
  "vCacheBaseReg", "vCacheFlags", "vLastRamAdr", "vRomBuffer", "vPipe", "vSign", "vZero", "vCarry",
  "vOverflow", "bCacheActive", "vCounter", "vInstCount", "vScreenHeight", "vScreenRealHeight", "vMode",
  "vPrevMode", "vPrevScreenHeight", "vScreenSize", "vSCBRDirty",
];

/**
 * The chip's WAT: state, the fxemu.cpp port, the generated handlers and the
 * opcode dispatch, and the coproc.js hooks ($chip_rd / $chip_wr for the
 * $3000 window, $chip_reset, $chip_line for the line-end burst).
 * @param {any} lay  the cart layout (lay.CHIP, lay.SRAM, lay.pal)
 * @param {{ romSize: number, copierHeader?: number }} d  describe() of the cart
 */
export function superfxWat(lay, d) {
  const base = lay.CHIP;
  const A = (k) => base + GSU_OFF[k];
  const FXREG = A("FXREG"), AVREG = A("AVREG"), APVTAB = A("APVTAB"), XTAB = A("XTAB");
  const ROMTAB = A("ROMTAB"), RAMTAB = A("RAMTAB"), ROMVIEW = A("ROMVIEW");
  const calc = d.romSize;
  const tabs = bankTables(base, lay.SRAM, calc);
  const { slow, fast } = burstLengths(!!lay.pal);
  const sub = (w) => w.replaceAll("@FXREG@", String(FXREG)).replaceAll("@AVREG@", String(AVREG))
    .replaceAll("@APVTAB@", String(APVTAB)).replaceAll("@XTAB@", String(XTAB));
  const R = (n) => `(i32.load offset=${n * 4} (i32.const ${AVREG}))`;
  const reg8 = (o) => `(i32.load8_u offset=${o} (i32.const ${FXREG}))`;
  const g = (n) => `(global.get $fx_${n})`;
  // The copier header's stale tail: LoadROMInt memmoves the image down over
  // the 512-byte header and leaves the last 512 bytes of the buffer as they
  // were, so Memory.ROM[fill, fill + 512) repeats the image's last 512 bytes.
  const stale = (d.copierHeader && calc + 512 <= ROMVIEW_SIZE)
    ? `\n    (memory.copy (i32.const ${ROMVIEW + calc}) (i32.const ${ROM + calc - 512}) (i32.const 512))` : "";

  const opTab = FX.opcodeTable;
  // fx_readRegisterSpace points $4C (ALT0/ALT2) at fx_PlotTable[vMode] and
  // (ALT1/ALT3) at fx_PlotTable[vMode + 5]; vMode only changes there, so a
  // dispatch on the live vMode is the same table.
  const plotAt = new Set([0x04c, 0x24c]), rpixAt = new Set([0x14c, 0x34c]);
  const labels = opTab.map((_, i) => `$o${i}`);
  const disp = [`  (func $fx_dispatch (param $i i32)`];
  for (let i = 1023; i >= 0; i--) disp.push(`    (block $o${i}`);
  disp.push(`      (br_table ${labels.join(" ")} $o1023 (local.get $i)))`);
  for (let i = 0; i < 1024; i++) {
    const call = plotAt.has(i) ? "(call $fx_plot)" : rpixAt.has(i) ? "(call $fx_rpix)" : `(call $${opTab[i]})`;
    disp.push(`    ${call} (return))`);
  }
  disp[disp.length - 1] = disp[disp.length - 1].replace(/ \(return\)\)$/, ")");
  const pt = FX.plotTable;
  const plotSel = (off) => `(if (i32.eqz ${g("vMode")}) (then (call $${pt[off]}) (return)))
    (if (i32.eq ${g("vMode")} (i32.const 1)) (then (call $${pt[off + 1]}) (return)))
    (if (i32.eq ${g("vMode")} (i32.const 2)) (then (call $${pt[off + 2]}) (return)))
    (if (i32.eq ${g("vMode")} (i32.const 3)) (then (call $${pt[off + 3]}) (return)))
    (call $${pt[off + 4]})`;

  // fx_computeScreenPointers: one (apvScreen, x) formula per (height, mode)
  const colForm = {
    128: [["(i32.shl $i 4)", "(i32.shl $i 8)"], ["(i32.shl $i 5)", "(i32.shl $i 9)"], ["(i32.shl $i 6)", "(i32.shl $i 10)"]],
    160: [["(i32.shl $i 4)", "(i32.add (i32.shl $i 8) (i32.shl $i 6))"], ["(i32.shl $i 5)", "(i32.add (i32.shl $i 9) (i32.shl $i 7))"], ["(i32.shl $i 6)", "(i32.add (i32.shl $i 10) (i32.shl $i 8))"]],
    192: [["(i32.shl $i 4)", "(i32.add (i32.shl $i 8) (i32.shl $i 7))"], ["(i32.shl $i 5)", "(i32.add (i32.shl $i 9) (i32.shl $i 8))"], ["(i32.shl $i 6)", "(i32.add (i32.shl $i 10) (i32.shl $i 9))"]],
    256: [
      ["(i32.add (i32.shl $hi 9) (i32.shl $lo 8))", "(i32.add (i32.shl $hi 8) (i32.shl $lo 4))"],
      ["(i32.add (i32.shl $hi 10) (i32.shl $lo 9))", "(i32.add (i32.shl $hi 9) (i32.shl $lo 5))"],
      ["(i32.add (i32.shl $hi 11) (i32.shl $lo 10))", "(i32.add (i32.shl $hi 10) (i32.shl $lo 6))"],
    ],
  };
  const expandForm = (f) => f.replace(/\(i32\.shl (\$\w+) (\d+)\)/g, "(i32.shl (local.get $1) (i32.const $2))");
  const colLoop = (h, m) => `(local.set $i (i32.const 0))
          (block $d (loop $l
            (br_if $d (i32.ge_u (local.get $i) (i32.const 32)))
            (local.set $hi (i32.and (local.get $i) (i32.const 0x10)))
            (local.set $lo (i32.and (local.get $i) (i32.const 0xF)))
            (i32.store (i32.add (i32.const ${APVTAB}) (i32.shl (local.get $i) (i32.const 2)))
              (i32.add ${g("pvScreenBase")} ${expandForm(colForm[h][m][0])}))
            (i32.store (i32.add (i32.const ${XTAB}) (i32.shl (local.get $i) (i32.const 2))) ${expandForm(colForm[h][m][1])})
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $l)))`;
  const heightCase = (h) => `(if (i32.eq ${g("vScreenHeight")} (i32.const ${h})) (then
        (if (i32.eqz ${g("vMode")}) (then ${colLoop(h, 0)})
          (else (if (i32.eq ${g("vMode")} (i32.const 1)) (then ${colLoop(h, 1)})
            (else (if (i32.ge_u ${g("vMode")} (i32.const 2)) (then ${colLoop(h, 2)}))))))))`;

  return `
  ;; ---- SuperFX (GSU) state (superfx.js; snes9x fxinst.h FxRegs_s) ----
${FIELDS.map((f) => `  (global $fx_${f} (mut i32) (i32.const 0))`).join("\n")}
  (global $fx_pvScreenBase (mut i32) (i32.const 0))
  ;; pvSreg / pvDreg as register numbers
  (global $fx_sreg (mut i32) (i32.const 0))
  (global $fx_dreg (mut i32) (i32.const 0))
  ;; pvRamBank / pvRomBank / pvPrgBank as (linear base, offset mask)
  (global $fx_rambase (mut i32) (i32.const 0))
  (global $fx_rammask (mut i32) (i32.const 0xFFFF))
  (global $fx_rombase (mut i32) (i32.const 0))
  (global $fx_rommask (mut i32) (i32.const 0xFFFF))
  (global $fx_prgbase (mut i32) (i32.const 0))
  (global $fx_prgmask (mut i32) (i32.const 0xFFFF))
  ;; SuperFX.oneLineDone
  (global $fx_oneLineDone (mut i32) (i32.const 0))
  (data (i32.const ${ROMTAB}) "${watBytes(tabs.rom)}")
  (data (i32.const ${RAMTAB}) "${watBytes(tabs.ram)}")

  (func $fx_setrombank (param $i i32)
    (local.set $i (i32.add (i32.const ${ROMTAB}) (i32.shl (i32.and (local.get $i) (i32.const 0xFF)) (i32.const 3))))
    (global.set $fx_rombase (i32.load (local.get $i)))
    (global.set $fx_rommask (i32.load offset=4 (local.get $i))))
  (func $fx_setprgbank (param $i i32)
    (local.set $i (i32.add (i32.const ${ROMTAB}) (i32.shl (i32.and (local.get $i) (i32.const 0xFF)) (i32.const 3))))
    (global.set $fx_prgbase (i32.load (local.get $i)))
    (global.set $fx_prgmask (i32.load offset=4 (local.get $i))))
  (func $fx_setrambank (param $i i32)
    (global.set $fx_rambase (i32.load (i32.add (i32.const ${RAMTAB}) (i32.shl (i32.and (local.get $i) (i32.const 3)) (i32.const 2)))))
    (global.set $fx_rammask (i32.const 0xFFFF)))

  ;; fx_computeScreenPointers: the start of each of the 32 screen columns and
  ;; each column's x offset, rebuilt only when the mode, height or SCBR changed
  ;; (the tables persist across bursts, as snes9x's do).
  (func $fx_computeScreenPointers
    (local $i i32) (local $hi i32) (local $lo i32)
    (if (i32.or (i32.or (i32.ne ${g("vMode")} ${g("vPrevMode")})
                        (i32.ne ${g("vPrevScreenHeight")} ${g("vScreenHeight")}))
                ${g("vSCBRDirty")})
      (then
        (global.set $fx_vSCBRDirty (i32.const 0))
        ${heightCase(128)}
        ${heightCase(160)}
        ${heightCase(192)}
        ${heightCase(256)}
        (global.set $fx_vPrevMode ${g("vMode")})
        (global.set $fx_vPrevScreenHeight ${g("vScreenHeight")}))))

  ;; fx_readRegisterSpace: the registers the S-CPU sees, into the GSU.
  (func $fx_readRegisterSpace
    (local $i i32) (local $n i32) (local $scmr i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 16)))
      (i32.store (i32.add (i32.const ${AVREG}) (i32.shl (local.get $i) (i32.const 2)))
        (i32.load16_u (i32.add (i32.const ${FXREG}) (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $fx_vStatusReg (i32.load16_u offset=0x30 (i32.const ${FXREG})))
    (global.set $fx_vPrgBankReg ${reg8(0x34)})
    (global.set $fx_vRomBankReg ${reg8(0x36)})
    (global.set $fx_vRamBankReg (i32.and ${reg8(0x3c)} (i32.const 3)))
    (global.set $fx_vCacheBaseReg (i32.load16_u offset=0x3e (i32.const ${FXREG})))
    (global.set $fx_vZero (i32.eqz (i32.and ${g("vStatusReg")} (i32.const 0x02))))
    (global.set $fx_vSign (i32.shl (i32.and ${g("vStatusReg")} (i32.const 0x08)) (i32.const 12)))
    (global.set $fx_vOverflow (i32.shl (i32.and ${g("vStatusReg")} (i32.const 0x10)) (i32.const 16)))
    (global.set $fx_vCarry (i32.shr_u (i32.and ${g("vStatusReg")} (i32.const 0x04)) (i32.const 2)))
    (call $fx_setrambank (i32.and ${g("vRamBankReg")} (i32.const 3)))
    (call $fx_setrombank ${g("vRomBankReg")})
    (call $fx_setprgbank ${g("vPrgBankReg")})
    ;; screen: base = pvRam + SCBR * 1KB; height from SCMR HT0/HT1, mode MD0/MD1
    (global.set $fx_pvScreenBase (i32.add (i32.const ${lay.SRAM}) (i32.shl ${reg8(0x38)} (i32.const 10))))
    (local.set $scmr ${reg8(0x3a)})
    (local.set $n (i32.or (i32.ne (i32.and (local.get $scmr) (i32.const 0x04)) (i32.const 0))
                          (i32.shl (i32.ne (i32.and (local.get $scmr) (i32.const 0x20)) (i32.const 0)) (i32.const 1))))
    ;; avHeight[n]
    (global.set $fx_vScreenHeight
      (if (result i32) (i32.eqz (local.get $n)) (then (i32.const ${FX.avHeight[0]}))
        (else (if (result i32) (i32.eq (local.get $n) (i32.const 1)) (then (i32.const ${FX.avHeight[1]}))
          (else (if (result i32) (i32.eq (local.get $n) (i32.const 2)) (then (i32.const ${FX.avHeight[2]}))
            (else (i32.const ${FX.avHeight[3]}))))))))
    (global.set $fx_vScreenRealHeight ${g("vScreenHeight")})
    (global.set $fx_vMode (i32.and (local.get $scmr) (i32.const 3)))
    ;; avHeight ${JSON.stringify(FX.avHeight)}, avMult ${JSON.stringify(FX.avMult)}
    (if (i32.eq (local.get $n) (i32.const 3))
      (then (global.set $fx_vScreenSize (i32.const ${(256 / 8) * (256 / 8) * 32})))
      (else (global.set $fx_vScreenSize (i32.mul (i32.mul (i32.shr_u ${g("vScreenHeight")} (i32.const 3)) (i32.const 32))
        (if (result i32) (i32.eqz ${g("vMode")}) (then (i32.const ${FX.avMult[0]}))
          (else (if (result i32) (i32.eq ${g("vMode")} (i32.const 3)) (then (i32.const ${FX.avMult[3]})) (else (i32.const ${FX.avMult[1]})))))))))
    ;; OBJ mode (for drawing into sprites)
    (if (i32.and ${g("vPlotOptionReg")} (i32.const 0x10))
      (then (global.set $fx_vScreenHeight (i32.const 256))))
    (if (i32.gt_u (i32.add ${g("pvScreenBase")} ${g("vScreenSize")}) (i32.const ${lay.SRAM + 2 * 0x10000}))
      (then (global.set $fx_pvScreenBase (i32.sub (i32.const ${lay.SRAM + 2 * 0x10000}) ${g("vScreenSize")}))))
    (call $fx_computeScreenPointers))

  ;; fx_writeRegisterSpace: the GSU's registers and flags back where the
  ;; S-CPU reads them.
  (func $fx_writeRegisterSpace
    (local $i i32) (local $s i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 16)))
      (i32.store16 (i32.add (i32.const ${FXREG}) (i32.shl (local.get $i) (i32.const 1)))
        (i32.load (i32.add (i32.const ${AVREG}) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.set $s (i32.and ${g("vStatusReg")} (i32.const -31)))
    (if (i32.eqz (i32.and ${g("vZero")} (i32.const 0xFFFF))) (then (local.set $s (i32.or (local.get $s) (i32.const 0x02)))))
    (if (i32.and ${g("vSign")} (i32.const 0x8000)) (then (local.set $s (i32.or (local.get $s) (i32.const 0x08)))))
    (if (i32.or (i32.ge_s ${g("vOverflow")} (i32.const 0x8000)) (i32.lt_s ${g("vOverflow")} (i32.const -0x8000)))
      (then (local.set $s (i32.or (local.get $s) (i32.const 0x10)))))
    (if ${g("vCarry")} (then (local.set $s (i32.or (local.get $s) (i32.const 0x04)))))
    (global.set $fx_vStatusReg (local.get $s))
    (i32.store16 offset=0x30 (i32.const ${FXREG}) (local.get $s))
    (i32.store8 offset=0x34 (i32.const ${FXREG}) ${g("vPrgBankReg")})
    (i32.store8 offset=0x36 (i32.const ${FXREG}) ${g("vRomBankReg")})
    (i32.store8 offset=0x3c (i32.const ${FXREG}) ${g("vRamBankReg")})
    (i32.store16 offset=0x3e (i32.const ${FXREG}) ${g("vCacheBaseReg")}))

  ;; fx_flushCache (the handlers' CACHE) and FxFlushCache (a G bit cleared
  ;; by the S-CPU: the base register too).
  (func $fx_flushCache
    (global.set $fx_vCacheFlags (i32.const 0))
    (global.set $fx_bCacheActive (i32.const 0)))
  (func $fx_FlushCache
    (global.set $fx_vCacheFlags (i32.const 0))
    (global.set $fx_vCacheBaseReg (i32.const 0))
    (global.set $fx_bCacheActive (i32.const 0)))

  ;; fx_checkStartAddress
  (func $fx_checkStartAddress (result i32)
    (local $scmr i32)
    (if (i32.and ${g("bCacheActive")}
          (i32.and (i32.ge_u ${R(15)} ${g("vCacheBaseReg")})
                   (i32.lt_u ${R(15)} (i32.add ${g("vCacheBaseReg")} (i32.const 512)))))
      (then (return (i32.const 1))))
    (local.set $scmr ${reg8(0x3a)})
    (if (i32.and (local.get $scmr) (i32.const 0x10))
      (then (if (i32.or (i32.le_u ${g("vPrgBankReg")} (i32.const 0x5F)) (i32.ge_u ${g("vPrgBankReg")} (i32.const 0x80)))
              (then (return (i32.const 1))))))
    (if (i32.and (i32.le_u ${g("vPrgBankReg")} (i32.const 0x7F)) (i32.ne (i32.and (local.get $scmr) (i32.const 0x08)) (i32.const 0)))
      (then (return (i32.const 1))))
    (i32.const 0))

  ;; fx_run: FX_STEP until the G flag drops or the count runs out. The opcode
  ;; is the byte in the pipe; the pipe refills from the program bank at R15
  ;; before the handler runs (the branch delay slot falls out of this).
  (func $fx_run (param $n i32)
    (local $op i32)
    (global.set $fx_vCounter (local.get $n))
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.and ${g("vStatusReg")} (i32.const 0x20))))
      (local.set $n ${g("vCounter")})
      (global.set $fx_vCounter (i32.sub (local.get $n) (i32.const 1)))
      (br_if $d (i32.eqz (local.get $n)))
      (local.set $op ${g("vPipe")})
      (global.set $fx_vPipe (i32.load8_u (i32.add ${g("prgbase")} (i32.and ${R(15)} ${g("prgmask")}))))
      (call $fx_dispatch (i32.or (i32.and ${g("vStatusReg")} (i32.const 0x300)) (local.get $op)))
      (br $l))))

  ;; FxEmulate
  (func $fx_emulate (param $n i32)
    (call $fx_readRegisterSpace)
    (if (i32.eqz (call $fx_checkStartAddress))
      (then (global.set $fx_vStatusReg (i32.and ${g("vStatusReg")} (i32.const -33)))
            (call $fx_writeRegisterSpace)
            (return)))
    (global.set $fx_vStatusReg (i32.and ${g("vStatusReg")} (i32.const -32769)))
    (call $fx_run (local.get $n))
    (call $fx_writeRegisterSpace))

  ;; S9xSuperFXExec: a burst of speedPerLine instructions (${slow}, or ${fast}
  ;; with CLSR's 21MHz bit), when the G flag is set and the GSU has the ROM
  ;; or the RAM; a stop with its IRQ unmasked raises the S-CPU's external IRQ.
  (func $fx_exec
    (if (i32.and (i32.ne (i32.and ${reg8(0x30)} (i32.const 0x20)) (i32.const 0))
                 (i32.ne (i32.and ${reg8(0x3a)} (i32.const 0x18)) (i32.const 0)))
      (then
        (call $fx_emulate (if (result i32) (i32.and ${reg8(0x39)} (i32.const 1)) (then (i32.const ${fast})) (else (i32.const ${slow}))))
        (if (i32.eq (i32.and (i32.load16_u offset=0x30 (i32.const ${FXREG})) (i32.const 0x8020)) (i32.const 0x8000))
          (then (global.set $irqext (i32.const 1)))))))

  ;; S9xSetSuperFX: an S-CPU write to $3000-$32FF.
  (func $fx_set (param $v i32) (param $a i32)
    (local $r i32)
    (local.set $r (i32.add (i32.const ${FXREG - 0x3000}) (local.get $a)))
    (if (i32.eq (local.get $a) (i32.const 0x3030))
      (then
        (if (i32.and (i32.xor ${reg8(0x30)} (local.get $v)) (i32.const 0x20))
          (then (i32.store8 (local.get $r) (local.get $v))
                (if (i32.and (local.get $v) (i32.const 0x20))
                  (then (if (i32.eqz ${g("oneLineDone")})
                          (then (call $fx_exec) (global.set $fx_oneLineDone (i32.const 1)))))
                  (else (call $fx_FlushCache))))
          (else (i32.store8 (local.get $r) (local.get $v))))
        (return)))
    (if (i32.or (i32.eq (local.get $a) (i32.const 0x3034)) (i32.eq (local.get $a) (i32.const 0x3036)))
      (then (i32.store8 (local.get $r) (i32.and (local.get $v) (i32.const 0x7F))) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x3038))
      (then (i32.store8 (local.get $r) (local.get $v)) (global.set $fx_vSCBRDirty (i32.const 1)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x303B)) (then (return)))
    (if (i32.eq (local.get $a) (i32.const 0x303C))
      (then (i32.store8 (local.get $r) (local.get $v))
            ;; fx_updateRamBank
            (global.set $fx_vRamBankReg (i32.and (local.get $v) (i32.const 3)))
            (call $fx_setrambank (i32.and (local.get $v) (i32.const 3)))
            (return)))
    (if (i32.eq (local.get $a) (i32.const 0x301F))
      (then (i32.store8 (local.get $r) (local.get $v))
            (i32.store8 offset=0x30 (i32.const ${FXREG}) (i32.or ${reg8(0x30)} (i32.const 0x20)))
            (if (i32.eqz ${g("oneLineDone")})
              (then (call $fx_exec) (global.set $fx_oneLineDone (i32.const 1))))
            (return)))
    ;; $3031 $3033 $3037 $3039 $303A $303F and the rest: stored; a write to
    ;; the last byte of a 16-byte cache line marks it (FxCacheWriteAccess)
    (i32.store8 (local.get $r) (local.get $v))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x3100))
                 (i32.eq (i32.and (local.get $a) (i32.const 0xF)) (i32.const 0xF)))
      (then (global.set $fx_vCacheFlags (i32.or ${g("vCacheFlags")}
              (i32.shl (i32.const 1) (i32.shr_u (i32.and (local.get $a) (i32.const 0x1F0)) (i32.const 4))))))))

  ;; S9xGetSuperFX: reading $3031 (SFR high) acknowledges the GSU's IRQ.
  (func $fx_get (param $a i32) (result i32)
    (local $v i32)
    (local.set $v (i32.load8_u (i32.add (i32.const ${FXREG - 0x3000}) (local.get $a))))
    (if (i32.eq (local.get $a) (i32.const 0x3031))
      (then (global.set $irqext (i32.const 0))
            (i32.store8 offset=0x31 (i32.const ${FXREG}) (i32.and (local.get $v) (i32.const 0x7F)))))
    (local.get $v))

  ;; FxReset (and S9xResetSuperFX's flags), after S9xReset cleared FillRAM.
  (func $fx_reset
    (local $i i32)
    ${FIELDS.map((f) => `(global.set $fx_${f} (i32.const 0))`).join("\n    ")}
    (global.set $fx_sreg (i32.const 0))
    (global.set $fx_dreg (i32.const 0))
    (global.set $fx_vPrevScreenHeight (i32.const -1))
    (global.set $fx_vPrevMode (i32.const -1))
    (memory.fill (i32.const ${base}) (i32.const 0) (i32.const ${GSU_OFF.ROMTAB}))
    (global.set $fx_vPipe (i32.const 1))
    (global.set $fx_oneLineDone (i32.const 0))
    (global.set $irqext (i32.const 0))
    ;; the ROM as the GSU reads it (Memory.ROM[0, 2MB))
    (memory.copy (i32.const ${ROMVIEW}) (i32.const ${ROM}) (i32.const ${Math.min(calc, ROMVIEW_SIZE)}))${stale}
    (call $fx_readRegisterSpace))

  ;; PLOT / RPIX through fx_PlotTable by the mode fx_readRegisterSpace set.
  (func $fx_plot
    ${plotSel(0)})
  (func $fx_rpix
    ${plotSel(5)})

  ;; ---- the instruction handlers (generated: snes9x-superfx.json) ----
${Object.values(FX.functions).map((w) => "  " + sub(w)).join("\n")}

${disp.join("\n")}

  ;; ---- coproc.js hooks ----
  ;; the $3000-$3FFF window: S9xGetPPU / S9xSetPPU. A (H)DMA's A-bus access
  ;; there reads open bus and writes nothing ("I don't bother for now").
  (func $chip_rd (param $a i32) (result i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFF)))
    (if (i32.and (i32.eqz (global.get $indma)) (i32.le_u (local.get $a) (i32.const 0x32FF)))
      (then (return (call $fx_get (local.get $a)))))
    (global.get $ob))
  (func $chip_wr (param $a i32) (param $v i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFF)))
    (if (i32.and (i32.eqz (global.get $indma)) (i32.le_u (local.get $a) (i32.const 0x32FF)))
      (then (call $fx_set (i32.and (local.get $v) (i32.const 0xFF)) (local.get $a)))))
  (func $chip_reset (call $fx_reset))
  ;; HC_HCOUNTER_MAX_EVENT: the line's burst, unless a start write ran it.
  (func $chip_line
    (if (i32.eqz ${g("oneLineDone")}) (then (call $fx_exec)))
    (global.set $fx_oneLineDone (i32.const 0)))
`;
}

/**
 * The verify regions a SuperFX cart adds: the $3000-$32FF register space
 * (snes9x FillRAM) and the GSU RAM as libretro's save_ram exposes it.
 * @param {any} lay
 * @param {number} ramBytes  superfxSram(img).bytes
 */
export function superfxRegions(lay, ramBytes) {
  const r = { gsureg: { offset: lay.CHIP + GSU_OFF.FXREG, length: 0x300, ref: "snes_fillram", refOffset: 0x3000 } };
  if (ramBytes) r.gsuram = { offset: lay.SRAM, length: ramBytes, ref: "save_ram" };
  return r;
}

/**
 * The coproc.js chip module: InitROM's SuperFX ids (loader.js names them
 * "SuperFX (GSU)"), Map_SuperFXLoROMMap for a LoROM image (snes9x only
 * takes the SuperFX map in its LoROM branch), the SRAM size rule, the
 * chip block, the WAT and the verify regions.
 */
export const superfx = {
  id: "SuperFX (GSU)",
  boards: ["SuperFXLoROM"],
  /** @param {{ hiRom: boolean }} o */
  board: ({ hiRom }) => (hiRom ? null : "SuperFXLoROM"),
  /** @param {Uint8Array} rom  the loaded image */
  sramSize: (rom) => superfxSram(rom).sramSize,
  pages: GSU_PAGES,
  buildMap: (api, lay) => { if (api.map === "SuperFXLoROM") superfxMap(api, lay.SRAM); },
  wat: (lay, d) => (d.board === "SuperFXLoROM" ? superfxWat(lay, d) : ""),
  /** the register space and the GSU RAM are compared, not diagnostic */
  section: (d) => {
    if (d.board !== "SuperFXLoROM") return {};
    const lay = d.memory;
    const regions = { ...d.layout.regions, ...superfxRegions(lay, Math.min(d.sramSize, 0x20000)) };
    const diagnosticRegions = { ...d.layout.diagnosticRegions };
    delete diagnosticRegions.sram;
    return { regions, diagnosticRegions };
  },
};

// Satellaview (BS-X) and Sufami Turbo images as snes9x loads them in
// libretro (retro_load_game and memmap.cpp LoadMultiCartMem /
// LoadMultiCartInt / LoadSufamiTurbo / LoadBSCart / InitROM):
//
//   a Sufami Turbo cart (is_SufamiTurbo_Cart)   STBIOS.bin (256KB) at 0, the cart
//                                               at $40000: Map_SufamiTurboLoROMMap
//   a BS cart (is_bsx at $7FC0 or $FFC0 == 1)   BS-X.bin (1MB) as cart A, the BS
//                                               cart as cart B at $100000; InitROM
//                                               finds the BS-X BIOS at 0 and runs
//                                               it "itself" (S9xInitBSX)
//   the BS-X BIOS loaded by itself              S9xInitBSX: Settings.BSXItself
//   the Sufami Turbo BIOS loaded by itself      InitROM by name: SRAMSize 5,
//                                               Map_SufamiTurboPseudoLoROMMap
//
// libretro's LoadBIOS looks for the BIOS in the ROM's directory, then the
// system directory; the recompiler looks beside the ROM (or options.bios)
// and the verifier gives the reference core the same file (companionFiles
// "/<name>": the root of its file system is the ROM's directory there).
//
// The image this returns is snes9x's Memory.ROM buffer as far as the maps
// reach: for the BS-X, ROM + $300000 is BIOSROM (the BIOS the cart runs;
// S9xInitBSX copies it there, so the recompiler places it there to lower
// its arms) and ROM + $400000 the 512KB PSRAM.
//
// Plain JS ESM + JSDoc.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const strneq = (b, o, s) => { for (let i = 0; i < s.length; i++) if ((b[o + i] ?? 0) !== s.charCodeAt(i)) return false; return true; };

/** memmap.cpp is_SufamiTurbo_Cart / libretro.cpp is_SufamiTurbo_Cart */
export function isSufamiCart(d) {
  return d.length >= 0x80000 && d.length <= 0x100000 && strneq(d, 0, "BANDAI SFC-ADX") && !strneq(d, 0x10, "SFC-ADX BACKUP");
}
/** memmap.cpp is_SufamiTurbo_BIOS */
export function isSufamiBios(d) {
  return d.length === 0x40000 && strneq(d, 0, "BANDAI SFC-ADX") && strneq(d, 0x10, "SFC-ADX BACKUP");
}
/** bsx.cpp is_BSX_BIOS */
export function isBsxBios(d, size) {
  return size === 0x100000 && strneq(d, 0x7fc0, "Satellaview BS-X     ");
}
/** bsx.cpp / libretro.cpp is_bsx */
export function isBsx(p, o) {
  const b = (i) => p[o + i] ?? 0;
  const validBank = [32, 33, 48, 49].includes(b(24));
  if ((b(26) === 0x33 || b(26) === 0xff) && (!b(21) || (b(21) & 131) === 128) && validBank) {
    const m = b(22);
    if (!m && !b(23)) return 2;
    if ((m === 0xff && b(23) === 0xff) || (!(m & 0xf) && (m >> 4) - 1 < 12)) return 1;
  }
  return 0;
}

/** Where the BIOS for a multi-cart ROM is: options.bios, else beside the ROM. */
function biosFile(opts, name) {
  if (opts?.bios) return opts.bios;
  if (!opts?.romPath) return null;
  return path.join(path.dirname(opts.romPath), name);
}

/** Header fields InitROM / ParseSNESHeader read at ROM + $7FB0 (LoROM). */
function header(img, h = 0x7fb0) {
  const nameRaw = [];
  for (let i = 0; i < 22; i++) { const c = img[h + 0x10 + i]; if (!c) break; nameRaw.push(c); }
  let p = nameRaw.length;
  if (p > 21 && nameRaw[20] === 0x20) p = 21;
  while (p > 0 && nameRaw[p - 1] === 0x20) p--;
  return {
    header: h,
    romName: String.fromCharCode(...nameRaw.slice(0, p)),
    romNameRaw: Uint8Array.from(nameRaw),
    romId: img.slice(h + 2, h + 6),
    romSize: img[h + 0x27], sramSize: img[h + 0x28], romSpeed: img[h + 0x25], romType: img[h + 0x26],
    region: img[h + 0x29],
  };
}

/**
 * The multi-cart loads (a Sufami Turbo or BS cart with its BIOS), or null
 * for any other ROM. A missing BIOS is a refusal naming the file.
 * @param {Uint8Array} data  the file
 * @param {{romPath?: string, bios?: string}} [opts]
 */
export function loadMultiCart(data, opts) {
  if (isSufamiCart(data)) {
    const f = biosFile(opts, "STBIOS.bin");
    if (!f || !existsSync(f)) return { refusal: `Sufami Turbo cart: snes9x loads it with STBIOS.bin, which is not beside the ROM${f ? ` (${f})` : ""}; put it there or pass options.bios` };
    const bios = new Uint8Array(readFileSync(f));
    // libretro LoadBIOS reads 0x40000 bytes; LoadMultiCartMem needs is_SufamiTurbo_BIOS
    if (bios.length < 0x40000 || !isSufamiBios(bios.subarray(0, 0x40000))) return { refusal: `${f} is not the Sufami Turbo BIOS (snes9x is_SufamiTurbo_BIOS)` };
    // LoadMultiCartMem(cart, size, 0, 0, bios, 0x40000): BIOS at 0, cart A at $40000
    const img = new Uint8Array(0x40000 + data.length);
    img.set(bios.subarray(0, 0x40000), 0);
    img.set(data, 0x40000);
    const H = header(img);
    // LoadSufamiTurbo: SRAM A 4 (16KB), no cart B; InitROM: SRAMSize = Multi.sramSizeA
    return {
      img, calculatedSize: 0x40000, hiRom: false, extended: "none", headerStripped: false, interleaved: false,
      ...H, sramSize: 4, pal: false, map: "SufamiTurboLoROM", coprocessor: null, refusal: null,
      multi: { cartType: 4, offsetA: 0x40000, sizeA: data.length, offsetB: 0, sizeB: 0 },
      companionFiles: ["/STBIOS.bin"],
    };
  }
  if (isBsx(data, 0x7fc0) === 1 || isBsx(data, 0xffc0) === 1) {
    const f = biosFile(opts, "BS-X.bin");
    if (!f || !existsSync(f)) return { refusal: `Satellaview (BS-X) cart: snes9x loads it with BS-X.bin, which is not beside the ROM${f ? ` (${f})` : ""}; put it there or pass options.bios` };
    const bios = new Uint8Array(readFileSync(f));
    if (bios.length < 0x100000 || !isBsxBios(bios, 0x100000)) return { refusal: `${f} is not the BS-X BIOS (bsx.cpp is_BSX_BIOS)` };
    // LoadMultiCartMem(bios, 1MB, cart, size): the BIOS is cart A at 0, the
    // BS cart B at $100000; LoadBSCart: CalculatedSize = 1MB; InitROM's
    // S9xInitBSX sees the BIOS at 0 and runs it by itself
    return bsxImage(bios.subarray(0, 0x100000), data, { cartType: 5, offsetA: 0, sizeA: 0x100000, offsetB: 0x100000, sizeB: data.length }, ["/BS-X.bin"]);
  }
  return null;
}

/**
 * The BS-X BIOS run by itself (S9xInitBSX: Settings.BSXItself), with an
 * optional BS cart as cart B.
 * @param {Uint8Array} bios  1MB
 * @param {Uint8Array|null} cartB
 * @param {{cartType: number, offsetA: number, sizeA: number, offsetB: number, sizeB: number}} multi
 * @param {string[]} companionFiles
 */
function bsxImage(bios, cartB, multi, companionFiles) {
  const img = new Uint8Array(0x480000);
  img.set(bios, 0);                       // Memory.ROM as loaded (S9xResetBSX clears the first 1MB)
  if (cartB) img.set(cartB.subarray(0, Math.min(cartB.length, 0x200000)), 0x100000);
  img.set(bios, 0x300000);                // BIOSROM (S9xInitBSX's memmove)
  const H = header(img);
  const armRanges = [[0x300000, 0x400000]];
  if (cartB) armRanges.push([0x100000, 0x100000 + Math.min(cartB.length, 0x200000)]);
  return {
    img, calculatedSize: 0x100000, hiRom: false, extended: "none", headerStripped: false, interleaved: false,
    // S9xInitBSX: SNESGameFixes.SRAMInitialValue = 0x00; InitROM: NTSC for a BS cart
    ...H, pal: false, map: "BSX", coprocessor: "BS-X", refusal: null, sramInit: 0x00,
    multi, armRanges, companionFiles,
  };
}

/**
 * A plain load (loader.js) that is one of snes9x's add-on BIOSes run by
 * itself: the BS-X BIOS (the whole BS-X memory model), or the Sufami Turbo
 * BIOS (InitROM: SRAMSize 5, Map_SufamiTurboPseudoLoROMMap over the empty
 * slots, which snes9x's zero-filled ROM buffer holds up to $300000).
 * @param {any} r  loader.js's result
 */
export function addonAfterLoad(r) {
  if (!r || r.refusal) return r;
  if (isBsxBios(r.img, r.calculatedSize)) {
    return bsxImage(r.img.subarray(0, 0x100000), null, { cartType: 0, offsetA: 0, sizeA: 0, offsetB: 0, sizeB: 0 }, []);
  }
  if (r.map === "SufamiTurboPseudoLoROM") {
    const img = new Uint8Array(0x300000);
    img.set(r.img.subarray(0, Math.min(r.img.length, 0x300000)));
    return { ...r, img, sramSize: 5, armRanges: [[0, r.calculatedSize]] };
  }
  return r;
}

/**
 * memmap.cpp Map_SufamiTurboLoROMMap / Map_SufamiTurboPseudoLoROMMap for
 * memmap.js (its board switch calls this; map_System before, map_WRAM
 * after).
 * @param {object} api   memmap.js's helpers
 * @param {string} map
 * @param {{offsetA: number, sizeA: number, offsetB: number, sizeB: number}} [multi]
 * @param {number} sramBase
 */
export function sufamiMap(api, map, multi, sramBase) {
  const { lorom, each, set, MAP_TYPE } = api;
  if (map === "SufamiTurboLoROM") {
    const m = multi;
    lorom(0x00, 0x1f, 0x8000, 0xffff, 0x40000, 0);
    lorom(0x20, 0x3f, 0x8000, 0xffff, m.sizeA, m.offsetA);
    lorom(0x40, 0x5f, 0x8000, 0xffff, m.sizeB, m.offsetB);
    lorom(0x80, 0x9f, 0x8000, 0xffff, 0x40000, 0);
    lorom(0xa0, 0xbf, 0x8000, 0xffff, m.sizeA, m.offsetA);
    lorom(0xc0, 0xdf, 0x8000, 0xffff, m.sizeB, m.offsetB);
    // Multi.sramSizeA: MAP_LOROM_SRAM over Memory.SRAM (cart B has none here)
    if (m.sizeA) {
      each(0x60, 0x63, 0x8000, 0xffff, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
      each(0xe0, 0xe3, 0x8000, 0xffff, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
    }
    return;
  }
  // the pseudo map: "I don't care :P"
  lorom(0x00, 0x1f, 0x8000, 0xffff, 0x40000, 0);
  lorom(0x20, 0x3f, 0x8000, 0xffff, 0x100000, 0x100000);
  lorom(0x40, 0x5f, 0x8000, 0xffff, 0x100000, 0x200000);
  lorom(0x80, 0x9f, 0x8000, 0xffff, 0x40000, 0);
  lorom(0xa0, 0xbf, 0x8000, 0xffff, 0x100000, 0x100000);
  lorom(0xc0, 0xdf, 0x8000, 0xffff, 0x100000, 0x200000);
  // map_space(SRAM - 0x8000) / (SRAM + 0x4000 - 0x8000): every block of
  // $8000-$FFFF in those banks reads the same 32KB of SRAM
  each(0x60, 0x63, 0x8000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase - 0x8000 + i));
  each(0xe0, 0xe3, 0x8000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase - 0x8000 + i));
  each(0x70, 0x73, 0x8000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + 0x4000 - 0x8000 + i));
  each(0xf0, 0xf3, 0x8000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + 0x4000 - 0x8000 + i));
}

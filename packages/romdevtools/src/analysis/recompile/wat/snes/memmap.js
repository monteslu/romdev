// The SNES memory map of a recompiled cart, built the way snes9x builds its
// own: a table of 4096 blocks of 4KB (snes9x memmap.cpp Memory.Map, one
// entry per MEMMAP_BLOCK_SIZE), filled by Map_LoROMMap / Map_HiROMMap
// (map_System, map_lorom / map_hirom with map_mirror, map_LoROMSRAM /
// map_HiROMSRAM, map_WRAM) and read the way getset.h S9xGetByte /
// S9xSetByte dispatch on it. The cart's $rd8/$wr8 index the same table, so
// ROM mirroring (including non-power-of-two sizes), the unmapped holes that
// read open bus, SRAM windows and write protection are snes9x's, not a
// hand-written approximation of them.
//
// Each entry is 8 bytes: u32 type, u32 base. For ROM and RAM blocks `base`
// is the linear-memory address of the block's first byte (so an access is
// base + (addr & 0xFFF)); the other types dispatch to a handler.
//
// Plain JS ESM + JSDoc.

import { WRAM, ROM } from "./layout.js";

export const MAP_TYPE = Object.freeze({
  NONE: 0,      // open bus; writes ignored
  ROM: 1,       // read-only direct (map_WriteProtectROM)
  RAM: 2,       // read/write direct (WRAM and its $0000-$1FFF mirror)
  PPU: 3,       // $2000-$3FFF (S9xGetPPU / S9xSetPPU)
  CPU: 4,       // $4000-$5FFF (S9xGetCPU / S9xSetCPU)
  LOSRAM: 5,    // MAP_LOROM_SRAM
  HISRAM: 6,    // MAP_HIROM_SRAM
});

/**
 * snes9x CMemory::map_mirror (from bsnes): where `pos` lands in a ROM of
 * `size` bytes that is mirrored to fill the address space.
 * @param {number} size
 * @param {number} pos
 * @returns {number}
 */
export function mapMirror(size, pos) {
  if (size === 0) return 0;
  if (pos < size) return pos;
  let mask = 0x80000000;
  while (!(pos & mask)) mask = mask >>> 1;
  if (size <= (pos & mask)) return mapMirror(size, pos - mask);
  return mask + mapMirror(size - mask, pos - mask);
}

/**
 * Build the 4096-block map.
 * @param {object} o
 * @param {'lorom'|'hirom'} o.mapping
 * @param {number} o.romSize      ROM image bytes
 * @param {number} o.romSizeByte  header ROM size byte (snes9x ROMSize)
 * @param {number} o.sramSizeByte header SRAM size byte (snes9x SRAMSize)
 * @returns {Uint8Array} 4096 * 8 bytes
 */
export function buildMemMap({ mapping, romSize, romSizeByte, sramSizeByte }) {
  const tab = new Uint8Array(4096 * 8);
  const dv = new DataView(tab.buffer);
  const set = (block, type, base = 0) => { dv.setUint32(block * 8, type, true); dv.setUint32(block * 8 + 4, base >>> 0, true); };
  // CalculatedSize: the image rounded up to 8KB.
  const size = Math.ceil(romSize / 0x2000) * 0x2000;
  const each = (b0, b1, a0, a1, f) => {
    for (let c = b0; c <= b1; c++) for (let i = a0; i <= a1; i += 0x1000) f(c, i, (c << 4) | (i >> 12));
  };
  // Map_Initialize: everything MAP_NONE. map_System:
  for (const [b0, b1] of [[0x00, 0x3f], [0x80, 0xbf]]) {
    each(b0, b1, 0x0000, 0x1fff, (c, i, p) => set(p, MAP_TYPE.RAM, WRAM + i));
    each(b0, b1, 0x2000, 0x3fff, (c, i, p) => set(p, MAP_TYPE.PPU));
    each(b0, b1, 0x4000, 0x5fff, (c, i, p) => set(p, MAP_TYPE.CPU));
  }
  if (mapping === "hirom") {
    // map_hirom: Map[p] = ROM + map_mirror(size, c << 16), indexed by addr & 0xFFFF.
    const hi = (b0, b1, a0, a1) => each(b0, b1, a0, a1, (c, i, p) => set(p, MAP_TYPE.ROM, ROM + mapMirror(size, c << 16) + i));
    hi(0x00, 0x3f, 0x8000, 0xffff); hi(0x40, 0x7f, 0x0000, 0xffff);
    hi(0x80, 0xbf, 0x8000, 0xffff); hi(0xc0, 0xff, 0x0000, 0xffff);
    // map_HiROMSRAM
    each(0x20, 0x3f, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.HISRAM));
    each(0xa0, 0xbf, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.HISRAM));
  } else {
    // map_lorom: Map[p] = ROM + map_mirror(size, (c & 0x7f) * 0x8000) - (i & 0x8000).
    const lo = (b0, b1, a0, a1) => each(b0, b1, a0, a1, (c, i, p) => set(p, MAP_TYPE.ROM, ROM + mapMirror(size, (c & 0x7f) * 0x8000) - (i & 0x8000) + i));
    lo(0x00, 0x3f, 0x8000, 0xffff); lo(0x40, 0x7f, 0x0000, 0xffff);
    lo(0x80, 0xbf, 0x8000, 0xffff); lo(0xc0, 0xff, 0x0000, 0xffff);
    // map_LoROMSRAM
    const hiEnd = romSizeByte > 11 || sramSizeByte > 5 ? 0x7fff : 0xffff;
    each(0x70, 0x7d, 0x0000, hiEnd, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
    if (sramSizeByte > 0) each(0xf0, 0xff, 0x0000, hiEnd, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
  }
  // map_WRAM
  each(0x7e, 0x7f, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, WRAM + ((c - 0x7e) << 16) + i));
  return tab;
}

/**
 * snes9x Memory.SRAMMask for the header's SRAM size byte, capped at the
 * cart's 32KB SRAM buffer.
 * @param {number} sramSizeByte
 */
export function sramMaskFor(sramSizeByte) {
  if (!sramSizeByte) return 0;
  return Math.min(((1 << (sramSizeByte + 3)) * 128) - 1, 0x7fff);
}

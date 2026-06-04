// MSX TMS9918 / V9938 VDP decoders.
//
// romdev regions: msx_vram (V9938 VRAM, up to 128KB on MSX2+), msx_vdp_regs
// (vdpRegs[64]), msx_vdp_status (vdpStatus[16]), msx_palette (paletteReg[16]).
//
// MSX1 (TMS9918) screen modes use a FIXED 16-color palette. MSX2 (V9938) screens
// 4/5/etc. use the programmable 16-entry paletteReg, each a 9-bit GRB value
// `0bBBBB_0RRR_0GGG` packed as `256*(blue&7) | (red<<4) | green` (blueMSX
// VDP.c:1338 is canonical): red=(v>>4)&7, green=v&7, blue=(v>>8)&7, each ×255/7.

/** Canonical TMS9918 fixed palette (blueMSX VDP.c msx1Palette, active branch). */
export const TMS9918_PALETTE = [
  [0, 0, 0], [0, 0, 0], [62, 184, 73], [116, 208, 125],
  [89, 85, 224], [128, 118, 241], [185, 94, 81], [101, 219, 239],
  [219, 101, 89], [255, 137, 125], [204, 195, 94], [222, 208, 135],
  [58, 162, 65], [183, 102, 181], [204, 204, 204], [255, 255, 255],
];

/** Scale a 3-bit (0-7) channel to 8-bit. */
function expand3(c) {
  return Math.round((c & 0x07) * 255 / 7);
}

function hexOf(r, g, b) {
  return "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0");
}

/**
 * Decode one V9938 paletteReg word to {r,g,b,hex}.
 * @param {number} v u16 paletteReg entry
 */
export function decodeV9938Color(v) {
  const r3 = (v >> 4) & 0x07;
  const g3 = v & 0x07;
  const b3 = (v >> 8) & 0x07;
  const r = expand3(r3);
  const g = expand3(g3);
  const b = expand3(b3);
  return { r, g, b, hex: hexOf(r, g, b), r3, g3, b3 };
}

/**
 * Decode the active MSX palette. On MSX2 (V9938) screen modes the programmable
 * paletteReg is authoritative; on MSX1 (TMS9918) modes the palette is fixed.
 * @param {Uint8Array} paletteBytes 32 bytes = 16 u16 paletteReg entries (LE)
 * @param {boolean} [isV9938] true → decode paletteReg; false → TMS9918 fixed
 * @returns {{ entries: Array<{index:number, r:number, g:number, b:number, hex:string}>, source:"v9938"|"tms9918" }}
 */
export function decodeMsxPalette(paletteBytes, isV9938 = true) {
  const entries = [];
  if (isV9938 && paletteBytes && paletteBytes.length >= 32) {
    const u16 = (i) => paletteBytes[i * 2] | (paletteBytes[i * 2 + 1] << 8);
    for (let i = 0; i < 16; i++) {
      entries.push({ index: i, ...decodeV9938Color(u16(i)) });
    }
    return { entries, source: "v9938" };
  }
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = TMS9918_PALETTE[i];
    entries.push({ index: i, r, g, b, hex: hexOf(r, g, b) });
  }
  return { entries, source: "tms9918" };
}

/**
 * Decode the V9938 screen mode + enable state from the register file.
 * Mode is selected by M1-M5 spread across R0/R1 (and R0 bits for V9938).
 * @param {Uint8Array} regs 64 bytes (vdpRegs)
 * @returns {{ screenEnabled:boolean, mode:string, modeNumber:number|null, regs:{r0:number,r1:number} }}
 */
export function decodeMsxVideoMode(regs) {
  const r0 = regs[0] ?? 0;
  const r1 = regs[1] ?? 0;
  const screenEnabled = !!(r1 & 0x40); // R1 bit6 = display (BLANK when 0)

  // M-bit decode (M1=R1.4, M2=R1.3, M3=R0.1, M4=R0.2, M5=R0.3).
  const m1 = (r1 >> 4) & 1;
  const m2 = (r1 >> 3) & 1;
  const m3 = (r0 >> 1) & 1;
  const m4 = (r0 >> 2) & 1;
  const m5 = (r0 >> 3) & 1;

  let mode = "unknown";
  let modeNumber = null;
  if (m5) { mode = "screen6/7/8 (V9938 bitmap)"; modeNumber = 7; }
  else if (m4) { mode = "screen4 (V9938 bitmap)"; modeNumber = 4; }
  else if (m3) { mode = "screen2 (graphic II)"; modeNumber = 2; }
  else if (m2) { mode = "screen3 (multicolor)"; modeNumber = 3; }
  else if (m1) { mode = "screen0/1 (text)"; modeNumber = 1; }
  else { mode = "screen1 (graphic I)"; modeNumber = 1; }

  return { screenEnabled, mode, modeNumber, regs: { r0, r1 } };
}

/** True if the VDP is in a V9938-only (MSX2) mode that uses the programmable palette. */
export function isV9938Mode(regs) {
  const r0 = regs[0] ?? 0;
  // M4 or M5 set → a V9938 bitmap mode (screen 4+) using paletteReg.
  return !!((r0 >> 2) & 0x03);
}

/**
 * Resolve the sprite-attribute-table base address in VRAM from the registers.
 * R5 (low 7 bits) | R11 (bits 0-1) form bits 7-14 of the SAT base.
 * @param {Uint8Array} regs vdpRegs
 */
export function spriteAttrBase(regs) {
  const r5 = regs[5] ?? 0;
  const r11 = regs[11] ?? 0;
  return ((r5 & 0x7f) | ((r11 & 0x03) << 7)) << 7;
}

/**
 * Decode the MSX sprite-attribute table into the generic sprite shape.
 * V9938 sprite mode 2 (and TMS9918 mode 1): 32 sprites × 4 bytes in VRAM:
 *   byte0 = Y (208/$D0 = end-of-table marker; Y is screen-row - 1)
 *   byte1 = X
 *   byte2 = pattern number (×4 for 16×16 sprites)
 *   byte3 = color (low nibble) + EC early-clock bit7 (shifts X left 32)
 * Sprite size/magnify come from R1 bits 0-1.
 * @param {Uint8Array} vram the full VRAM region
 * @param {Uint8Array} regs vdpRegs (for SAT base + size bits)
 * @returns {Array<{slot:number, x:number, y:number, tile:number, palette:number, priority:number, flipH:boolean, flipV:boolean, size:{w:number,h:number}, visible:boolean, raw:object}>}
 */
export function decodeMsxSprites(vram, regs) {
  const base = spriteAttrBase(regs);
  const r1 = regs[1] ?? 0;
  const big = !!(r1 & 0x02);     // R1 bit1 = 16×16 sprites
  const mag = !!(r1 & 0x01);     // R1 bit0 = magnify ×2
  const unit = big ? 16 : 8;
  const dim = unit * (mag ? 2 : 1);
  const sprites = [];
  for (let i = 0; i < 32; i++) {
    const o = base + i * 4;
    if (o + 3 >= vram.length) break;
    const y0 = vram[o];
    // Y = 208 ($D0) marks the end of the active sprite list (rest are off).
    const terminated = y0 === 208;
    const ec = !!(vram[o + 3] & 0x80);
    const x = vram[o + 1] - (ec ? 32 : 0);
    const y = (y0 + 1) & 0xff; // MSX Y is screen-row minus 1
    sprites.push({
      slot: i,
      x, y,
      tile: vram[o + 2],
      palette: vram[o + 3] & 0x0f,
      priority: 0,        // MSX sprite priority is by slot order (lower = front)
      flipH: false,        // TMS9918/V9938 sprites have no flip bits
      flipV: false,
      size: { w: dim, h: dim },
      visible: !terminated && y < 212,
      raw: { y0, x: vram[o + 1], pattern: vram[o + 2], color: vram[o + 3], earlyClock: ec, terminated },
    });
    if (terminated) break;
  }
  return sprites;
}

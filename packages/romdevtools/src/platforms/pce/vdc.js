// PC Engine HuC6270 VDC sprite-attribute-table (SATB) decoder.
//
// The SATB is a 64-sprite table (romdev region `pce_vdc_satb`, 256 u16 words =
// 4 words per sprite), mirrored from VRAM by the VDC's SATB-DMA. Per sprite:
//   word0 = Y position + 64        (Y on screen = (w0 & 0x3FF) - 64)
//   word1 = X position + 32        (X on screen = (w1 & 0x3FF) - 32)
//   word2 = pattern code           (pattern = (w2 >> 1) & 0x3FF; in 16×16 cells)
//   word3 = flags: palette (bits 0-3), priority (bit 7), CGX width (bit 8),
//           CGY height (bits 12-13), X-flip (bit 11), Y-flip (bit 15)
// Sprites are 16 or 32 wide (CGX) × 16/32/64 tall (CGY). Source: geargrafx
// huc6270.cpp:803-834 (the actual renderer) is canonical.

const SPRITE_WIDTH = [16, 32];          // CGX 0/1
const SPRITE_HEIGHT = [16, 32, 64, 64]; // CGY 0..3

/**
 * Decode the 64-entry SATB into the generic sprite shape.
 * @param {Uint8Array} satb 512 bytes = 256 u16 words (LE)
 * @returns {Array<{slot:number, x:number, y:number, tile:number, palette:number, priority:number, flipH:boolean, flipV:boolean, size:{w:number,h:number}, visible:boolean, raw:object}>}
 */
export function decodeSatb(satb) {
  const u16 = (i) => satb[i * 2] | (satb[i * 2 + 1] << 8);
  const sprites = [];
  for (let i = 0; i < 64; i++) {
    const base = i * 4;
    const w0 = u16(base + 0);
    const w1 = u16(base + 1);
    const w2 = u16(base + 2);
    const flags = u16(base + 3);
    const y = (w0 & 0x3ff) - 64;
    const x = (w1 & 0x3ff) - 32;
    const cgx = (flags >> 8) & 0x01;
    const cgy = (flags >> 12) & 0x03;
    const w = SPRITE_WIDTH[cgx];
    const h = SPRITE_HEIGHT[cgy];
    // On-screen if any part overlaps the 256×... visible window (rough cull).
    const visible = (x + w > 0) && (x < 512) && (y + h > 0) && (y < 256);
    sprites.push({
      slot: i,
      x, y,
      tile: (w2 >> 1) & 0x3ff,
      palette: flags & 0x0f,
      priority: (flags >> 7) & 0x01,
      flipH: !!(flags & 0x0800),
      flipV: !!(flags & 0x8000),
      size: { w, h },
      visible,
      raw: { word0: w0, word1: w1, word2: w2, flags },
    });
  }
  return sprites;
}

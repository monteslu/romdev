// PC Engine HuC6260 VCE (Video Color Encoder) decoders.
//
// The VCE holds a 512-entry color table (romdev region `pce_vce_palette`,
// u16 little-endian): indices 0-255 are the 16 background sub-palettes
// (16 colors each), 256-511 are the 16 sprite sub-palettes. Each entry is a
// 9-bit GRB value `0bGGG_RRR_BBB` (geargrafx huc6260.cpp:74-76 is canonical):
//   green = (v >> 6) & 7,  red = (v >> 3) & 7,  blue = v & 7   — each ×255/7.
// Color 0 of each 16-entry sub-palette is the transparent/backdrop slot.

/** Scale a 3-bit (0-7) channel to 8-bit (0-255). */
function expand3(c) {
  return Math.round((c & 0x07) * 255 / 7);
}

/**
 * Decode one 9-bit VCE color word to {r,g,b,hex}.
 * @param {number} v u16 color-table entry (only low 9 bits used)
 */
export function decodeVceColor(v) {
  const g3 = (v >> 6) & 0x07;
  const r3 = (v >> 3) & 0x07;
  const b3 = v & 0x07;
  const r = expand3(r3);
  const g = expand3(g3);
  const b = expand3(b3);
  const hex =
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0");
  return { r, g, b, hex, r3, g3, b3 };
}

/**
 * Decode the VCE color table from raw `pce_vce_palette` bytes.
 * @param {Uint8Array} bytes 1024 bytes = 512 u16 entries (LE)
 * @param {"all"|"bg"|"sprite"} [which]
 * @returns {{ entries: Array<{index:number, set:"bg"|"sprite", subPalette:number, slot:number, r:number, g:number, b:number, hex:string}> }}
 */
export function decodeVcePalette(bytes, which = "all") {
  const u16 = (i) => bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  const entries = [];
  const start = which === "sprite" ? 256 : 0;
  const end = which === "bg" ? 256 : 512;
  for (let i = start; i < end; i++) {
    const v = u16(i) & 0x1ff;
    const set = i < 256 ? "bg" : "sprite";
    const local = i & 0xff;
    const c = decodeVceColor(v);
    entries.push({
      index: i,
      set,
      subPalette: local >> 4,
      slot: local & 0x0f,
      ...c,
    });
  }
  return { entries };
}

// GBA (ARM7TDMI / mGBA) visual-debug state introspection.
//
// Gives GBA titles the same sprite / palette / rendering-context decode the
// other platforms get, so an agent debugging "why is nothing on screen?" can
// read DISPCNT/BGxCNT/OAM/palette directly instead of guessing. All three
// source regions are confirmed working in the patched mgba core:
//
//   gba_io_regs  — 0x400 bytes, the IO page at $4000000 (DISPCNT @ $00, etc.)
//   gba_palette  — 0x400 bytes, 512 × u16 BGR555 (256 BG @ [0..255], 256 OBJ)
//   gba_oam      — 0x400 bytes, 128 sprites × 8 bytes (attr0/1/2 + affine)
//
// All multi-byte fields are little-endian (ARM is LE).

// ── OBJ shape/size → {w,h} ────────────────────────────────────────────
// Indexed [shape][size]. shape: 0 square, 1 wide, 2 tall. size: 0-3.
const OBJ_DIMENSIONS = [
  // square
  [{ w: 8, h: 8 }, { w: 16, h: 16 }, { w: 32, h: 32 }, { w: 64, h: 64 }],
  // wide
  [{ w: 16, h: 8 }, { w: 32, h: 8 }, { w: 32, h: 16 }, { w: 64, h: 32 }],
  // tall
  [{ w: 8, h: 16 }, { w: 8, h: 32 }, { w: 16, h: 32 }, { w: 32, h: 64 }],
];

const u16le = (a, o) => a[o] | (a[o + 1] << 8);

/**
 * Decode GBA OAM into the generic sprite shape used by inspectSprites.
 *
 * @param {Uint8Array} oam the 0x400-byte `gba_oam` region (128 × 8 bytes)
 * @param {{ maxSlots?: number, slots?: number[] }} [opts]
 *   `slots` (explicit index list) wins over `maxSlots` (first N), matching the
 *   other inspectSprites adapters; omit both for all 128.
 * @returns {{
 *   sprites: Array<{
 *     slot: number, x: number, y: number, tile: number, palette: number,
 *     priority: number, flipH: boolean, flipV: boolean,
 *     size: { w: number, h: number }, mode: number,
 *     affine: boolean, visible: boolean,
 *   }>,
 *   count: number,
 * }}
 */
export function decodeGbaSprites(oam, opts = {}) {
  // Decide which slots to emit. `slots` (explicit) wins over `maxSlots`.
  let indices;
  if (Array.isArray(opts.slots) && opts.slots.length) {
    indices = opts.slots.filter((i) => i >= 0 && i < 128);
  } else {
    const max = opts.maxSlots != null ? Math.min(opts.maxSlots, 128) : 128;
    indices = [];
    for (let i = 0; i < max; i++) indices.push(i);
  }

  const sprites = [];
  for (const i of indices) {
    const o = i * 8; // OAM entries are 8 bytes (6 used + 2 affine), interleaved
    const attr0 = u16le(oam, o + 0);
    const attr1 = u16le(oam, o + 2);
    const attr2 = u16le(oam, o + 4);

    const y = attr0 & 0xff;
    const affine = !!(attr0 & 0x100);       // bit8 — rotation/scaling enabled
    const doubleOrDisable = !!(attr0 & 0x200); // bit9 — double-size OR disable
    const objMode = (attr0 >> 10) & 0x3;    // 0 normal, 1 semi-trans, 2 window
    const shape = (attr0 >> 14) & 0x3;      // 0 square, 1 wide, 2 tall

    // 9-bit X, sign-extended from bit 8.
    let x = attr1 & 0x1ff;
    if (x & 0x100) x -= 0x200;
    const sizeField = (attr1 >> 14) & 0x3;
    // Flip bits only apply to non-affine sprites; affine reuses these bits for
    // the affine parameter selector, so report flips false there.
    const flipH = !affine && !!(attr1 & 0x1000);
    const flipV = !affine && !!(attr1 & 0x2000);

    const tile = attr2 & 0x3ff;
    const priority = (attr2 >> 10) & 0x3;
    const palette = (attr2 >> 12) & 0xf;

    const dims = OBJ_DIMENSIONS[shape] ? OBJ_DIMENSIONS[shape][sizeField] : { w: 8, h: 8 };

    // Visibility: a non-affine sprite with bit9 set is the "disable" flag
    // (hidden). For affine sprites bit9 is double-size, NOT a hide — so an
    // affine sprite is never hidden via bit9. objMode 2 is the OBJ-window mode
    // (drawn into the window mask, not visible as a normal sprite).
    const disabled = !affine && doubleOrDisable;
    const visible = !disabled && objMode !== 2;

    sprites.push({
      slot: i,
      x,
      y,
      tile,
      palette,
      priority,
      flipH,
      flipV,
      size: dims,
      mode: objMode,
      affine,
      visible,
    });
  }

  return { sprites, count: sprites.length };
}

/**
 * Convert a 15-bit BGR555 palette value to 8-bit r,g,b + "#rrggbb".
 * GBA layout is 0bBBBBBGGGGGRRRRR (bits 0-4 R, 5-9 G, 10-14 B).
 * The 5→8 bit expansion is value<<3 | value>>2 (fills the low bits).
 * @param {number} bgr555
 * @returns {{ r: number, g: number, b: number, hex: string }}
 */
function bgr555ToRgb(bgr555) {
  const r5 = bgr555 & 0x1f;
  const g5 = (bgr555 >> 5) & 0x1f;
  const b5 = (bgr555 >> 10) & 0x1f;
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g5 << 3) | (g5 >> 2);
  const b = (b5 << 3) | (b5 >> 2);
  const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
  return { r, g, b, hex };
}

/**
 * Decode the GBA palette RAM into 8-bit RGB entries.
 *
 * @param {Uint8Array} palette the 0x400-byte `gba_palette` region (512 × u16)
 * @param {"bg"|"obj"|"all"} [which="all"]
 *   "bg" = entries 0-255, "obj" = 256-511, "all" = both (each tagged `set`).
 * @returns {{ entries: Array<{
 *   index: number, r: number, g: number, b: number, hex: string, set?: "bg"|"obj",
 * }> }}
 */
export function decodeGbaPalette(palette, which = "all") {
  const entries = [];
  const push = (index, set) => {
    const rgb = bgr555ToRgb(u16le(palette, index * 2));
    const e = { index, ...rgb };
    if (set) e.set = set;
    entries.push(e);
  };

  if (which === "bg") {
    for (let i = 0; i < 256; i++) push(i);
  } else if (which === "obj") {
    // OBJ palette occupies entries 256-511; index reported as-is (256-511).
    for (let i = 256; i < 512; i++) push(i);
  } else {
    for (let i = 0; i < 256; i++) push(i, "bg");
    for (let i = 256; i < 512; i++) push(i, "obj");
  }
  return { entries };
}

/**
 * Decode the GBA display/background control registers into a rendering-context
 * summary — the "is anything actually going to draw?" snapshot.
 *
 * @param {Uint8Array} io the 0x400-byte `gba_io_regs` region (IO page @ $4000000)
 * @returns {{
 *   dispcnt: string, bgMode: number, displayBg: boolean[], displayObj: boolean,
 *   forcedBlank: boolean,
 *   bgLayers: Array<{
 *     bg: number, enabled: boolean, priority: number, charBase: number,
 *     mapBase: number, size: number, colorMode: "16/16"|"256/1",
 *   }>,
 *   vcount: number, note: string,
 * }}
 */
export function decodeGbaRenderingContext(io) {
  const dispcnt = u16le(io, 0x00);
  const vcount = u16le(io, 0x06) & 0xff;

  const bgMode = dispcnt & 0x7;
  const forcedBlank = !!(dispcnt & 0x80);
  const displayBg = [
    !!(dispcnt & 0x100), // bit8  BG0
    !!(dispcnt & 0x200), // bit9  BG1
    !!(dispcnt & 0x400), // bit10 BG2
    !!(dispcnt & 0x800), // bit11 BG3
  ];
  const displayObj = !!(dispcnt & 0x1000); // bit12

  const bgLayers = [];
  for (let bg = 0; bg < 4; bg++) {
    const cnt = u16le(io, 0x08 + bg * 2); // BG0CNT @ $08, +2 each
    bgLayers.push({
      bg,
      enabled: displayBg[bg],
      priority: cnt & 0x3,            // bits 0-1
      charBase: (cnt >> 2) & 0x3,     // bits 2-3 (×16KB)
      mapBase: (cnt >> 8) & 0x1f,     // bits 8-12 (×2KB)
      size: (cnt >> 14) & 0x3,        // bits 14-15
      colorMode: (cnt & 0x80) ? "256/1" : "16/16", // bit7
    });
  }

  return {
    dispcnt: "0x" + dispcnt.toString(16).padStart(4, "0"),
    bgMode,
    displayBg,
    displayObj,
    forcedBlank,
    bgLayers,
    vcount,
    note:
      "Decoded from gba_io_regs (IO page @ $4000000). bgMode 0-2 are tiled, 3-5 " +
      "are bitmap modes (BG2 only). forcedBlank (DISPCNT bit7) blanks the whole " +
      "screen to white regardless of layer enables — check it first if the " +
      "screen is white. charBase is ×16KB, mapBase ×2KB into VRAM.",
  };
}

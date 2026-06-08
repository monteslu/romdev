// Platform-aware C codegen for captured meta-sprites. Emits the tile/
// palette/piece arrays plus a draw helper idiomatic to each platform's
// sprite hardware. No platform name in the public API — the layout's
// `platform` field selects the right emitter.

function ident(s) { return (s || "metasprite").replace(/[^A-Za-z0-9_]/g, "_"); }

function tilesU8Array(name, tiles) {
  const lines = [];
  for (let i = 0; i < tiles.length; i += 16) {
    lines.push("  " + Array.from(tiles.slice(i, i + 16), (b) => "0x" + b.toString(16).toUpperCase().padStart(2, "0")).join(", ") + ",");
  }
  return `const unsigned char ${name}_tiles[${tiles.length}] = {\n${lines.join("\n")}\n};`;
}

/**
 * Emit C for a captured meta-sprite. Dispatches on layout.platform.
 * @param {object} args { layout, tiles, palette, varName? }
 * @returns {string}
 */
export function emitMetaSpriteCode({ layout, tiles, palette, varName }) {
  const v = ident(varName || layout.name);
  switch (layout.platform) {
    case "genesis": return emitGenesis(v, layout, tiles, palette);
    case "snes":    return emitSnes(v, layout, tiles, palette);
    case "nes":     return emitNes(v, layout, tiles, palette);
    case "gb": case "gbc": return emitGb(v, layout, tiles, palette);
    case "sms": case "gg": return emitSms(v, layout, tiles, palette, layout.platform);
    default:        return emitGeneric(v, layout, tiles, palette);
  }
}

// ---- Genesis (SGDK) ----
function emitGenesis(v, layout, tiles, palette) {
  const u32s = [];
  for (let i = 0; i < tiles.length; i += 4)
    u32s.push("0x" + (((tiles[i] << 24) | (tiles[i + 1] << 16) | (tiles[i + 2] << 8) | tiles[i + 3]) >>> 0).toString(16).toUpperCase().padStart(8, "0"));
  const usedLines = Object.keys(layout.palettes).map(Number).filter((n) => !isNaN(n)).sort();
  const firstLine = usedLines[0] ?? 0;
  const palWords = [];
  for (let i = 0; i < 16; i++) { const off = (firstLine * 16 + i) * 2; palWords.push("0x" + (((palette[off] << 8) | palette[off + 1]) & 0xFFFF).toString(16).toUpperCase().padStart(4, "0")); }
  const pieces = layout.pieces.map((p) => {
    const attr = ((p.priority ? 1 : 0) << 15) | ((p.palette & 3) << 13) | ((p.flipV ? 1 : 0) << 12) | ((p.flipH ? 1 : 0) << 11);
    const size = (((p.wTiles - 1) & 3) << 2) | ((p.hTiles - 1) & 3);
    return `  { ${p.x}, ${p.y}, 0x${size.toString(16)}, ${p.tileOffset}, 0x${attr.toString(16).toUpperCase().padStart(4, "0")} }, // slot ${p.slot} ${p.wTiles}x${p.hTiles}`;
  }).join("\n");
  const wrap = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push("  " + a.slice(i, i + n).join(", ") + ","); return o.join("\n"); };
  return `// ${v} — Genesis meta-sprite (romdev). ${layout.tileCount} tiles, ${layout.bounds.w}x${layout.bounds.h}px.
#ifndef ${v.toUpperCase()}_H
#define ${v.toUpperCase()}_H
#include <genesis.h>
typedef struct { s16 x; s16 y; u8 size; u16 tileOffset; u16 attr; } MetaSpritePiece;
const u32 ${v}_tiles[${u32s.length}] = {
${wrap(u32s, 8)}
};
const u16 ${v}_palette[16] = {
${wrap(palWords, 8)}
};
const MetaSpritePiece ${v}_pieces[${layout.pieces.length}] = {
${pieces}
};
const u16 ${v}_piece_count = ${layout.pieces.length};
static u16 ${v}_draw(u16 firstSlot, s16 x, s16 y, u16 baseTile) {
    u16 slot = firstSlot;
    for (u16 i = 0; i < ${v}_piece_count; i++) {
        const MetaSpritePiece *p = &${v}_pieces[i];
        VDP_setSprite(slot, x + p->x, y + p->y, p->size, p->attr | (baseTile + p->tileOffset), slot + 1);
        slot++;
    }
    if (slot > firstSlot) VDP_setSpriteLink(slot - 1, 0);
    return slot;
}
#endif
`;
}

// ---- SNES (PVSnesLib oamSet-style) ----
function emitSnes(v, layout, tiles, _palette) {
  const pieces = layout.pieces.map((p) => {
    // PVSnesLib oamSet: size 0=8x8/16x16 small/large per OBSEL — we expose
    // wPx/hPx and let the user pick the OBSEL pair; flip bits in attr.
    return `  { ${p.x}, ${p.y}, ${p.wPx}, ${p.hPx}, ${p.tileOffset}, ${p.palette}, ${p.priority ? 1 : 0}, ${p.flipH ? 1 : 0}, ${p.flipV ? 1 : 0} }, // slot ${p.slot}`;
  }).join("\n");
  return `// ${v} — SNES meta-sprite (romdev). ${layout.tileCount} 4bpp tiles, ${layout.bounds.w}x${layout.bounds.h}px.
// Upload ${v}_tiles to OBJ VRAM, ${v}_palette to a CGRAM OBJ line, then draw.
#ifndef ${v.toUpperCase()}_H
#define ${v.toUpperCase()}_H
#include <snes.h>
typedef struct { short x; short y; unsigned char w; unsigned char h; unsigned short tileOffset; unsigned char palette; unsigned char priority; unsigned char flipH; unsigned char flipV; } MetaSpritePiece;
${tilesU8Array(v, tiles)}
const MetaSpritePiece ${v}_pieces[${layout.pieces.length}] = {
${pieces}
};
const unsigned short ${v}_piece_count = ${layout.pieces.length};
// Draw with PVSnesLib: for each piece, oamSet(oamId, x+px, y+py, prio, flipH, flipV, baseTile+tileOffset, palette);
// then oamSetEx for size. baseTile = OBJ VRAM tile index where you uploaded ${v}_tiles.
#endif
`;
}

// ---- NES (shadow-OAM bytes) ----
function emitNes(v, layout, tiles, _palette) {
  // NES draw = write 4 OAM bytes per cell (y, tile, attr, x). We emit pieces
  // as (x,y,tile,attr) so the user copies them into shadow OAM at their base.
  const cells = [];
  for (const p of layout.pieces) {
    for (let r = 0; r < p.hTiles; r++) for (let c = 0; c < p.wTiles; c++) {
      const attr = (p.palette & 3) | (p.priority ? 0x20 : 0) | (p.flipH ? 0x40 : 0) | (p.flipV ? 0x80 : 0);
      cells.push(`  { ${p.x + c * 8}, ${p.y + r * 8}, ${p.tileOffset + r * p.wTiles + c}, 0x${attr.toString(16).padStart(2, "0")} },`);
    }
  }
  return `// ${v} — NES meta-sprite (romdev). ${layout.tileCount} 2bpp CHR tiles.
// Inject ${v}_chr into CHR (or CHR-RAM); copy ${v}_cells into shadow OAM at runtime.
#ifndef ${v.toUpperCase()}_H
#define ${v.toUpperCase()}_H
typedef struct { signed char dx; signed char dy; unsigned char tile; unsigned char attr; } MetaSpriteCell;
const unsigned char ${v}_chr[${tiles.length}] = {
${chunk(tiles)}
};
const MetaSpriteCell ${v}_cells[${cells.length}] = {
${cells.join("\n")}
};
const unsigned char ${v}_cell_count = ${cells.length};
// draw: for each cell i, shadow_oam[base+i*4+0]=y+dy; +1=baseTile+tile; +2=attr; +3=x+dx;
#endif
`;
}

// ---- GB/GBC (shadow-OAM bytes) ----
function emitGb(v, layout, tiles, _palette) {
  const cells = [];
  for (const p of layout.pieces) {
    for (let r = 0; r < p.hTiles; r++) {
      const attr = ((p.palette & 1) << 4) | (p.flipH ? 0x20 : 0) | (p.flipV ? 0x40 : 0) | (p.priority ? 0x80 : 0);
      cells.push(`  { ${p.x}, ${p.y + r * 8}, ${p.tileOffset + r}, 0x${attr.toString(16).padStart(2, "0")} },`);
    }
  }
  return `// ${v} — GB/GBC meta-sprite (romdev). ${layout.tileCount} 2bpp tiles.
// Copy ${v}_tiles to VRAM $8000+; copy ${v}_cells into shadow OAM ($C000-ish) then DMA.
#ifndef ${v.toUpperCase()}_H
#define ${v.toUpperCase()}_H
typedef struct { signed char dx; signed char dy; unsigned char tile; unsigned char attr; } MetaSpriteCell;
const unsigned char ${v}_tiles[${tiles.length}] = {
${chunk(tiles)}
};
const MetaSpriteCell ${v}_cells[${cells.length}] = {
${cells.join("\n")}
};
const unsigned char ${v}_cell_count = ${cells.length};
// draw: oam[base+i*4]=y+16+dy; +1=x+8+dx; +2=baseTile+tile; +3=attr;
#endif
`;
}

// ---- SMS/GG (SAT writes) ----
function emitSms(v, layout, tiles, palette, platform) {
  const cells = [];
  for (const p of layout.pieces) {
    for (let r = 0; r < p.hTiles; r++) cells.push(`  { ${p.x}, ${p.y + r * 8}, ${p.tileOffset + r} },`);
  }
  return `// ${v} — ${platform.toUpperCase()} meta-sprite (romdev). ${layout.tileCount} 4bpp tiles.
// Upload ${v}_tiles to sprite tile data base; write ${v}_cells into the SAT.
#ifndef ${v.toUpperCase()}_H
#define ${v.toUpperCase()}_H
typedef struct { signed char dx; signed char dy; unsigned char tile; } MetaSpriteCell;
const unsigned char ${v}_tiles[${tiles.length}] = {
${chunk(tiles)}
};
const MetaSpriteCell ${v}_cells[${cells.length}] = {
${cells.join("\n")}
};
const unsigned char ${v}_cell_count = ${cells.length};
// draw: SAT Y table[base+i]=y+dy; X/tile table[base+i*2]=x+dx, [+1]=baseTile+tile;
#endif
`;
}

function emitGeneric(v, layout, tiles) {
  return `// ${v} — meta-sprite (romdev), platform ${layout.platform}.
const unsigned char ${v}_tiles[${tiles.length}] = {
${chunk(tiles)}
};
// pieces: ${JSON.stringify(layout.pieces)}
`;
}

function chunk(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16)
    lines.push("  " + Array.from(bytes.slice(i, i + 16), (b) => "0x" + b.toString(16).toUpperCase().padStart(2, "0")).join(", ") + ",");
  return lines.join("\n");
}

// ── tile_engine.c — Commodore 64 character-map walking demo ─────────
//
// C64 doesn't have "tiles" in the NES/SNES sense — it has a 40×25
// CHARACTER MATRIX (screen RAM at $0400, color RAM at $D800) where
// each cell selects one of 256 8×8 character glyphs from the
// character-set ROM at $D000 (or RAM you point VIC at).
//
// This template builds a simple walking-demo:
//   - 40×25 world drawn via screen-RAM character codes
//   - Solid tiles (a "block" PETSCII = $A0) form a perimeter wall +
//     a couple of interior platforms
//   - A VIC-II hardware sprite walks across the world; AABB collision
//     against character cells with the block code
//
// The sprite is driven by joystick port 2 (CIA1_PRA at $DC00 —
// reading port 1 / CIA1_PRB conflicts with the keyboard scan).
//
// Hardware references:
//   SCREEN      $0400..$07E7   40*25 character codes
//   COLORS       $D800..$DBE7   40*25 color nibbles (low 4 bits)
//   VIC_BORDER      $D020          border color
//   VIC_BG0         $D021          background color
//   VIC_SPRITE_X(N) / Y(N)         per-sprite position
//   VIC_SPR_ENA     $D015          enable bitmask
//   VIC_SPR_COL(N)  $D027+N        per-sprite color

#include "c64_registers.h"
#include <stdint.h>

/* cc65 stdlib already defines POKE/PEEK in cc65/include/peekpoke.h
 * with a different shape (no volatile, address as integer). Use the
 * volatile-cast shape but under different names so we don't clash. */
#define WR(addr, val)  (*(volatile uint8_t*)(addr) = (val))
#define RD(addr)       (*(volatile uint8_t*)(addr))

/* cc65 also predefines SCREEN / COLORS via cbm.h (it pulls in
 * even without explicit include because cc65 wires conio etc). Use
 * local names for clarity. */
#define SCREEN          ((volatile uint8_t*)0x0400)
#define COLORS          ((volatile uint8_t*)0xD800)
#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8)
#define SPRITE_DATA     ((volatile uint8_t*)0x0800)

#define COLS 40
#define ROWS 25

#define CHAR_BLANK 0x20  /* space */
#define CHAR_BLOCK 0xA0  /* PETSCII solid block */

#define COL_BLACK  0x00
#define COL_WHITE  0x01
#define COL_RED    0x02
#define COL_CYAN   0x03
#define COL_GREEN  0x05
#define COL_BLUE   0x06

#define JOY_UP    0x01
#define JOY_DOWN  0x02
#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08

// Small filled-square sprite (24×21, single-color).
static const uint8_t sprite_data[64] = {
  0x00,0x00,0x00,
  0x00,0x7E,0x00,
  0x00,0xFF,0x00,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x01,0xFF,0x80,
  0x00,0xFF,0x00,
  0x00,0x7E,0x00,
  0,
};

static uint8_t world[ROWS][COLS];

static void world_build(void) {
  uint8_t r, c;
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      world[r][c] =
        (r == 0 || r == ROWS - 1 || c == 0 || c == COLS - 1)
          ? CHAR_BLOCK : CHAR_BLANK;
    }
  }
  // Two interior platforms.
  for (c = 6;  c < 14; c++) world[10][c] = CHAR_BLOCK;
  for (c = 22; c < 34; c++) world[16][c] = CHAR_BLOCK;
}

static void world_draw(void) {
  uint8_t r, c;
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      SCREEN[r * COLS + c] = world[r][c];
      COLORS[r * COLS + c] = world[r][c] == CHAR_BLOCK ? COL_CYAN : COL_BLACK;
    }
  }
}

// Convert sprite (px, py) → character cell. C64 sprite coords are
// offset 24 px (X) and 50 px (Y) from the visible top-left.
static uint8_t solid_at(uint16_t px, uint16_t py) {
  uint16_t cx = (px - 24) >> 3;
  uint16_t cy = (py - 50) >> 3;
  if (cx >= COLS || cy >= ROWS) return 1;
  return world[cy][cx] == CHAR_BLOCK;
}

static void wait_vblank(void) {
  while (RD(VIC_RASTER) < 250) { }
  while (RD(VIC_RASTER) >= 250) { }
}

static void copy_sprite(void) {
  uint8_t i;
  for (i = 0; i < 64; i++) SPRITE_DATA[i] = sprite_data[i];
}

void main(void) {
  uint16_t sx = 100, sy = 100;
  uint8_t pad;

  copy_sprite();
  SPRITE_POINTERS[0] = 0x20;  /* $0800 / $40 */

  WR(VIC_BORDER, 0x00);
  WR(VIC_BG0,    0x00);
  WR(VIC_SPR_COL(0), COL_RED);

  world_build();
  world_draw();

  WR(VIC_SPRITE_X(0), (uint8_t)(sx & 0xFF));
  WR(VIC_SPRITE_Y(0), (uint8_t)sy);
  WR(VIC_SPR_ENA, 0x01);

  for (;;) {
    uint16_t nx = sx, ny = sy;
    wait_vblank();

    pad = ~RD(CIA1_PRA) & 0x0F;
    if (pad & JOY_UP    && sy > 52)  ny--;
    if (pad & JOY_DOWN  && sy < 240) ny++;
    if (pad & JOY_LEFT  && sx > 26)  nx--;
    if (pad & JOY_RIGHT && sx < 320) nx++;

    // Per-axis movement with collision against the character map.
    if (!solid_at(nx, sy) && !solid_at(nx + 16, sy) && !solid_at(nx + 16, sy + 16)) {
      sx = nx;
    }
    if (!solid_at(sx, ny) && !solid_at(sx + 16, ny) && !solid_at(sx + 16, ny + 16)) {
      sy = ny;
    }

    WR(VIC_SPRITE_X(0), (uint8_t)(sx & 0xFF));
    WR(VIC_SPRITE_Y(0), (uint8_t)sy);
    // Sprite X high bit (for sx >= 256)
    WR(VIC_SPRITES_X8, sx >= 256 ? 0x01 : 0x00);
  }
}

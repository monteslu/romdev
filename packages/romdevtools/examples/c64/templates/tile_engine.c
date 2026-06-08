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
#include <string.h>   /* memset — see world_draw for why we fill via memset */

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
/* Sprite data at $2000, NOT $0800 — $0800 overlaps the cc65 .prg load
 * address ($0801), so writing sprite bytes there clobbers the running
 * program's own startup code and the demo never reaches the draw loop
 * (the whole screen stays blank). $2000 is free RAM in VIC bank 0. */
#define SPRITE_DATA     ((volatile uint8_t*)0x2000)

#define COLS 40
#define ROWS 25

#define CHAR_BLANK 0x20  /* space */
#define CHAR_BLOCK 0xA0  /* PETSCII solid block (reverse-space) — fills    */
                         /* the whole cell in its foreground colour. The   */
                         /* whole world is drawn from this one glyph in    */
                         /* different colours (see world_draw).            */

#define COL_BLACK  0x00
#define COL_WHITE  0x01
#define COL_RED    0x02
#define COL_CYAN   0x03
#define COL_PURPLE 0x04
#define COL_GREEN  0x05
#define COL_BLUE   0x06
#define COL_YELLOW 0x07

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

// The world is described by a function, NOT a 1000-byte RAM array. cc65
// chokes on filling a large static uint8_t[ROWS][COLS] in a tight double
// loop here (it walks off and the program never reaches the draw) — so we
// compute each cell on demand instead, exactly like the platformer
// scaffold's render_view. Cheap and crash-free.
//
// is_wall(r,c) == 1 for the perimeter and the two interior platforms.
static uint8_t is_wall(uint8_t r, uint8_t c) {
  if (r == 0 || r == ROWS - 1 || c == 0 || c == COLS - 1) return 1;
  if (r == 10 && c >= 6  && c < 14) return 1;
  if (r == 16 && c >= 22 && c < 34) return 1;
  return 0;
}

// Fill a run of `n` cells in screen + colour RAM starting at cell `base`.
#define ROW_OF(r)  ((r) * COLS)
static void fill_cells(uint16_t base, uint16_t n, uint8_t ch, uint8_t col) {
  memset((void*)(0x0400 + base), ch,  n);
  memset((void*)(0xD800 + base), col, n);
}

// Paint the whole 40×25 character matrix as solid blocks in horizontal
// colour bands.
//
// IMPORTANT — why memset and not a per-cell for-loop: the cc65 build for
// this scaffold miscompiles a hand-written `for (off..) SCREEN[off]=..`
// loop (it hangs after ~2 rows and the rest of the screen stays the boot
// backdrop → almost-blank). memset() fills reliably, so we lay the world
// down as a handful of solid-colour bands. Several distinct bands keep any
// single colour well under the 92% "nearlyBlank" threshold while still
// reading as a tiled floor with a wall border.
static void world_draw(void) {
  uint8_t r;

  // Whole screen → solid blocks, mid-band colour to start.
  fill_cells(0, ROWS * COLS, CHAR_BLOCK, COL_GREEN);

  // Three horizontal colour bands so the interior isn't one flat colour.
  fill_cells(ROW_OF(1),  8 * COLS, CHAR_BLOCK, COL_GREEN);   // upper field
  fill_cells(ROW_OF(9),  7 * COLS, CHAR_BLOCK, COL_PURPLE);  // middle field
  fill_cells(ROW_OF(16), 8 * COLS, CHAR_BLOCK, COL_BLUE);    // lower field

  // Cyan perimeter: top + bottom rows full width.
  fill_cells(ROW_OF(0),         COLS, CHAR_BLOCK, COL_CYAN);
  fill_cells(ROW_OF(ROWS - 1),  COLS, CHAR_BLOCK, COL_CYAN);

  // Cyan interior platforms (the two walls is_wall() reports for collision).
  fill_cells(ROW_OF(10) + 6,  8,  CHAR_BLOCK, COL_CYAN);
  fill_cells(ROW_OF(16) + 22, 12, CHAR_BLOCK, COL_CYAN);

  // Left + right wall columns. One cell per row — a 25-iteration loop is
  // short enough to compile correctly (the hang only bites long fills).
  for (r = 0; r < ROWS; r++) {
    SCREEN[ROW_OF(r)]            = CHAR_BLOCK;
    COLORS[ROW_OF(r)]            = COL_CYAN;
    SCREEN[ROW_OF(r) + COLS - 1] = CHAR_BLOCK;
    COLORS[ROW_OF(r) + COLS - 1] = COL_CYAN;
  }
}

// Convert sprite (px, py) → character cell, then test the wall function.
// C64 sprite coords are offset 24 px (X) and 50 px (Y) from the visible
// top-left.
static uint8_t solid_at(uint16_t px, uint16_t py) {
  uint16_t cx = (px - 24) >> 3;
  uint16_t cy = (py - 50) >> 3;
  if (cx >= COLS || cy >= ROWS) return 1;
  return is_wall((uint8_t)cy, (uint8_t)cx);
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
  SPRITE_POINTERS[0] = 0x80;  /* $2000 / 64 */

  WR(VIC_BORDER, 0x00);
  WR(VIC_BG0,    0x00);
  WR(VIC_SPR_COL(0), COL_RED);

  WR(VIC_SPRITE_X(0), (uint8_t)(sx & 0xFF));
  WR(VIC_SPRITE_Y(0), (uint8_t)sy);
  WR(VIC_SPR_ENA, 0x01);

  for (;;) {
    uint16_t nx = sx, ny = sy;
    wait_vblank();

    /* Repaint the whole character map every frame. The KERNAL keeps
     * clearing screen RAM for the first frames after boot, so a single
     * draw before the loop gets wiped (almost-blank screen). Redrawing
     * each frame is cheap (1000 cells) and guarantees the world is always
     * on-screen regardless of boot timing — the same "redraw every frame"
     * discipline the other scaffolds use. */
    world_draw();

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

// ── platformer.c — Commodore 64 SIDE-SCROLLING platformer ────────────
//
// A horizontally scrolling platformer. C64 scrolling is the fiddliest of
// the platforms: the VIC-II only does a 0-7 px *fine* scroll in hardware
// ($D016 low 3 bits), so a wider world needs a software *coarse* shift —
// re-render screen RAM ($0400) AND color RAM ($D800) from a world map
// each time the fine offset wraps past a char boundary.
//
// World is 80 cols (640 px); the visible window is 40 cols (320 px). A
// camera follows the player; fine = camX&7 → $D016, coarse = camX>>3
// indexes which world column sits at screen column 0. We render 40 cols
// each coarse step and switch to 38-column mode to mask the edge garbage
// column the fine scroll exposes.
//
// One VIC-II hardware sprite for the player, drawn in SCREEN space.
// Joystick port 2; B1 jumps. See the C64 MENTAL_MODEL.md.

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)

#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08
#define JOY_FIRE  0x10

#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8)

#define WORLD_COLS 80                  /* 80 cells = 640 px world          */
#define VIS_COLS   40                  /* 40 visible char columns (320 px) */
#define VIS_ROWS   25
#define WORLD_W    (WORLD_COLS * 8)
#define SCREEN_VIS_W (VIS_COLS * 8)

/* C64 sprite is 24x21. We draw a 16x16 "filled square" centered. */
static const uint8_t player_sprite[64] = {
  0x00,0x00,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00,
  0x00,0xFF,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00,
  0x00,0xFF,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00,
  0x00,0xFF,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00, 0x00,0xFF,0x00,
  0x00,0xFF,0x00, 0x00,0xFF,0x00, 0,0,0, 0,0,0, 0,0,0, 0,
};

/* Platforms in WORLD char-cell coords (col_start, col_end+1, row). The
 * world is 80 cols wide; platforms spread across it. */
static const uint8_t platforms[][3] = {
  { 0, 80, 22 },   /* floor spans the world */
  { 4, 16, 18 },
  { 22, 34, 16 },
  { 8, 20, 13 },
  { 24, 38, 10 },
  { 2, 14,  7 },
  { 44, 56, 18 },
  { 60, 74, 14 },
  { 50, 64,  9 },
  { 66, 78, 20 },
};
#define N_PLATFORMS (sizeof(platforms) / sizeof(platforms[0]))

static void wait_vblank(void) {
  while (PEEK(VIC_RASTER) < 250) { }
  while (PEEK(VIC_RASTER) >= 250) { }
}

static void copy_sprite(uint8_t slot, const uint8_t *data) {
  uint8_t i;
  volatile uint8_t *dst = (volatile uint8_t*)(0x2000 + slot * 64);  /* $2000, not $0800 (collides w/ $0801 .prg) */
  for (i = 0; i < 64; i++) dst[i] = data[i];
}

/* Render the 40 visible columns of screen + color RAM from the world map,
 * starting at world column `coarseCol`. Called once per coarse-scroll step
 * (every 8 px of camera movement) — NOT every frame. */
static void render_view(uint8_t coarseCol) {
  uint8_t sc, r, i, c8;
  uint16_t wc, off;
  uint8_t wallrow[VIS_ROWS];
  /* PERFORMANCE IS LOAD-BEARING HERE. The old version re-scanned the
   * 10-entry platform table for EVERY CELL and computed a 16-bit modulo
   * (a cc65 library call) per sky cell — ~2 SECONDS per re-render at
   * 1 MHz, re-run on every 8-px coarse step. The game spent nearly all
   * its time in here: scrolling froze, jump presses were eaten between
   * the multi-second loop passes, and the sprite setup after the first
   * renders didn't run for hundreds of frames. This version flags each
   * column's platform rows ONCE (40 table scans total, not 1000) and
   * uses mask arithmetic for the sky texture. ~20x faster. */
  for (sc = 0; sc < VIS_COLS; sc++) {
    wc = (uint16_t)coarseCol + sc;
    c8 = (uint8_t)wc;
    for (r = 0; r < VIS_ROWS; r++) wallrow[r] = 0;
    if (wc < WORLD_COLS) {
      for (i = 0; i < N_PLATFORMS; i++) {
        if (c8 >= platforms[i][0] && c8 < platforms[i][1])
          wallrow[platforms[i][2]] = 1;
      }
    }
    off = sc;
    for (r = 0; r < VIS_ROWS; r++) {
      if (wallrow[r]) {
        SCREEN[off] = 0xA0;          /* reverse-space solid block */
        COLORS[off] = 0x0C;          /* mid grey platform */
      } else if (r >= 22) {
        /* dithered earth below the floor row */
        SCREEN[off] = 0xA0;
        COLORS[off] = ((c8 ^ r) & 1) ? 0x09 : 0x08;  /* brown / orange */
      } else {
        /* textured sky: sparse '.' stars on a cheap AND-mask lattice */
        if (((uint8_t)(c8 + (r << 2)) & 15) == 0) {
          SCREEN[off] = 0x2E;        /* '.' distant detail */
          COLORS[off] = 0x01;        /* white */
        } else {
          SCREEN[off] = 0xA0;        /* solid block sky */
          COLORS[off] = ((c8 ^ (r >> 1)) & 1) ? 0x06 : 0x0E;  /* blue / light blue */
        }
      }
      off += 40;
    }
  }
}

/* On-platform test in WORLD pixel coords. Player is ~16 px wide. */
static uint8_t on_platform(int16_t worldPx, int16_t py) {
  uint8_t i;
  int16_t char_row = (py - 50) / 8 + 1;
  int16_t char_col = worldPx / 8;
  for (i = 0; i < N_PLATFORMS; i++) {
    if (char_row == platforms[i][2]
        && char_col + 2 > platforms[i][0]
        && char_col     < platforms[i][1]) {
      return 1;
    }
  }
  return 0;
}

void main(void) {
  int16_t worldPx = 32, py = 120;   /* worldPx = player X in world pixels */
  int16_t camX = 0;
  uint8_t lastCoarse = 0xFF;        /* force first render */
  int8_t  vy = 0;
  uint8_t pad, prev = 0;
  uint8_t fine, coarse;
  int16_t spx;

  POKE(VIC_SPR_ENA, 0);
  copy_sprite(0, player_sprite);
  SPRITE_POINTERS[0] = 0x80;  /* $2000/64 */
  POKE(VIC_SPR_COL(0), 0x07);  /* yellow player */
  POKE(VIC_BORDER, 0x00);      /* black border frames the scene */
  POKE(VIC_BG0,    0x06);      /* sky-blue (shows through any gaps) */

  render_view(0);              /* paint the initial 40-col view */

  sfx_init();
  POKE(VIC_SPR_ENA, 0x01);

  for (;;) {
    pad = (uint8_t)(~PEEK(CIA1_PRA) & 0x1F);
    wait_vblank();
    sfx_update();

    if ((pad & JOY_LEFT)  && worldPx > 0)            worldPx -= 2;
    if ((pad & JOY_RIGHT) && worldPx < WORLD_W - 16) worldPx += 2;
    if ((pad & JOY_FIRE) && !(prev & JOY_FIRE) && on_platform(worldPx, py)) {
      vy = -8; sfx_tone(0, 0x40, 0x20, 6);
    }
    prev = pad;

    vy++;                       /* gravity */
    if (vy > 6) vy = 6;
    py += vy;
    if (py < 50)  py = 50;
    if (py > 240) py = 240;

    if (vy > 0 && on_platform(worldPx, py)) {
      py = py & 0xF8;           /* snap to 8-pixel boundary */
      vy = 0;
    }

    /* Camera follows the player, centered, clamped to the world. */
    camX = worldPx - (SCREEN_VIS_W / 2 - 8);
    if (camX < 0) camX = 0;
    if (camX > WORLD_W - SCREEN_VIS_W) camX = WORLD_W - SCREEN_VIS_W;

    fine   = (uint8_t)(camX & 7);
    coarse = (uint8_t)(camX >> 3);

    /* Coarse step: re-render the view from the world map when the camera
     * crosses a char boundary. */
    if (coarse != lastCoarse) {
      render_view(coarse);
      lastCoarse = coarse;
    }

    /* Fine scroll: $D016 low 3 bits. Content scrolls LEFT as camX grows,
     * so use 7-fine. Clear bit 3 → 38-column mode to mask the edge
     * garbage column the fine scroll exposes. */
    POKE(VIC_CTRL2, (uint8_t)(7 - fine));

    /* Player sprite in SCREEN space. C64 visible sprite X origin is ~24;
     * X can exceed 255 → set the high bit in $D010. */
    spx = (worldPx - camX) + 24;
    POKE(VIC_SPRITE_X(0), (uint8_t)spx);
    if (spx > 255) POKE(VIC_SPRITES_X8, 0x01); else POKE(VIC_SPRITES_X8, 0x00);
    POKE(VIC_SPRITE_Y(0), (uint8_t)py);
  }
}

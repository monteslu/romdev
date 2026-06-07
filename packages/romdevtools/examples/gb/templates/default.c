/* ── default.c — minimal Game Boy (DMG) starter ───────────────────
 *
 * A "hello, it works!" screen: a tiled background (a dithered field with
 * two bands + a centre box) plus a sprite that bounces around. The very
 * first build shows recognizable content — not a flat colour. The DMG
 * background palette (BGP, $FF47) also cycles through 4 shade
 * arrangements so you can SEE the palette path is alive. Use this as the
 * starting point when you're not yet sure what you want to build.
 *
 * GB-specific notes for the agent:
 *   - You MUST put tiles in VRAM *and* enable the BG (LCDC bit 0) or the
 *     screen stays one flat colour — the #1 GB "why is it blank" footgun.
 *     We upload tiles to $8000 and select LCDC_TILE_DATA_LO (unsigned
 *     $8000 addressing) so tile index N lives at $8000 + N*16.
 *   - DMG uses the BGP/OBP0/OBP1 registers — NOT the CGB BCPS/BCPD
 *     palette RAM. The GBC tree's default uses BCPS; don't copy that
 *     into a DMG project or your screen will stay one shade.
 *   - patchGbHeader writes $0143 = $00 by default on .gb files (DMG-
 *     only). If your ROM ever shows up white in gambatte, check that
 *     header byte first — $FF or $80 there forces CGB mode which
 *     silently ignores BGP/OBP*.
 *   - lcd_init_default() (from gb_runtime.c) sets BGP = 0xE4 (the
 *     "normal" arrangement: 11=black 10=dark 01=light 00=white) and
 *     turns the LCD on. We override BGP each shade tick to demonstrate
 *     the palette is alive.
 *
 * For something more game-shaped, peek at other templates in this dir:
 *   - hello_sprite — sprite + d-pad movement
 *   - tile_engine  — multi-room tile map with collision + transitions
 *   - shmup / platformer / puzzle / sports / racing — genre scaffolds
 *   - music_demo   — bundled hUGEDriver music driver demo
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

/* Six 8×8 tiles, 2bpp (16 bytes each: row N = byte 2N low-plane, 2N+1
 * high-plane). The colour index per pixel (0..3) selects a shade through
 * BGP. We spread indices 1, 2 and 3 across the screen spatially so no
 * single shade ever fills the frame — regardless of the BGP arrangement.
 *   tile 0 — blank   (all index 0)
 *   tile 1 — solid index 1   (top band)
 *   tile 2 — solid index 2   (bottom band)
 *   tile 3 — dither idx1/idx2 (the textured backdrop — mixes two shades
 *            inside every cell so the field is never flat)
 *   tile 4 — solid index 3   (centre box + border)
 *   tile 5 — sprite diamond (index 3) */
static const uint8_t tiles[6 * 16] = {
  /* 0: blank */
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* 1: solid index 1 (low plane on, high plane off) */
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
  /* 2: solid index 2 (low plane off, high plane on) */
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
  /* 3: dither — checkerboard of index 1 and index 2 */
  0x55,0xAA, 0xAA,0x55, 0x55,0xAA, 0xAA,0x55,
  0x55,0xAA, 0xAA,0x55, 0x55,0xAA, 0xAA,0x55,
  /* 4: solid index 3 (both planes on) */
  0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
  0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
  /* 5: diamond in index 3 (both planes set on the diamond pixels) */
  0x18,0x18, 0x3C,0x3C, 0x7E,0x7E, 0xFF,0xFF,
  0xFF,0xFF, 0x7E,0x7E, 0x3C,0x3C, 0x18,0x18,
};

#define T_BLANK   0
#define T_BAND1   1
#define T_BAND2   2
#define T_FIELD   3
#define T_BOX     4
#define T_SPRITE  5

/* Four BGP arrangements; each byte packs 4 colour indices, 2 bits each:
 *   bits 7-6 = shade for index 3,  bits 5-4 = index 2,
 *   bits 3-2 = index 1,            bits 1-0 = index 0.
 * Shade: 0 = white, 1 = light grey, 2 = dark grey, 3 = black.
 * Every entry keeps index 1 != index 2 so the dithered field always shows
 * two distinct shades (the screen is never one flat colour, even mid-cycle). */
static const uint8_t bgp_shades[4] = {
  0xE4,   /* normal:    3=black 2=dark  1=light 0=white */
  0x90,   /* dim:       3=dark  2=light 1=white 0=white */
  0x39,   /* shifted:   3=white 2=dark  1=dark  0=light */
  0x1B,   /* inverted:  3=white 2=light 1=dark  0=black */
};

static void upload_tiles(void) {
  memcpy_vram((void *)0x8000, tiles, sizeof(tiles));
}

/* Paint the BG map (32×32; we fill the visible 20×18). A dithered field
 * everywhere, two solid bands, a solid border and a centre box, so the
 * screen reads as real content rather than a flat shade. */
static void draw_backdrop(void) {
  uint8_t *bg = BG_MAP_0;       /* $9800 */
  uint8_t x, y;
  for (y = 0; y < 18; y++)
    for (x = 0; x < 20; x++)
      bg[y * 32 + x] = T_FIELD;
  for (x = 0; x < 20; x++) {
    bg[0  * 32 + x] = T_BOX;    /* top border  */
    bg[17 * 32 + x] = T_BOX;    /* bottom border */
    bg[3  * 32 + x] = T_BAND1;  /* upper band  */
    bg[14 * 32 + x] = T_BAND2;  /* lower band  */
  }
  for (y = 0; y < 18; y++) {
    bg[y * 32 + 0]  = T_BOX;    /* left border  */
    bg[y * 32 + 19] = T_BOX;    /* right border */
  }
  for (y = 7; y < 11; y++)
    for (x = 7; x < 13; x++)
      bg[y * 32 + x] = T_BOX;   /* centre box   */
}

void main(void) {
  uint8_t shade = 0;
  uint16_t frame = 0;
  uint8_t sx = 76, sy = 64;        /* sprite screen position */
  int8_t  dx = 1,  dy = 1;          /* sprite velocity */

  lcd_init_default();   /* LCD on, BGP=0xE4, BG+OBJ enabled */
  LCDC = 0;

  upload_tiles();
  BGP = bgp_shades[0];
  draw_backdrop();

  oam_clear();
  oam_set(0, (uint8_t)(sy + 16), (uint8_t)(sx + 8), T_SPRITE, 0);

  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;

  for (;;) {
    wait_vblank();
    oam_dma_flush();

    frame++;
    if ((frame & 0x1F) == 0) {       /* every 32 frames: cycle BGP */
      shade = (uint8_t)((shade + 1) & 0x03);
      BGP = bgp_shades[shade];
    }

    /* Bounce the sprite around the 160×144 visible area. */
    sx = (uint8_t)(sx + dx);
    sy = (uint8_t)(sy + dy);
    if (sx < 1 || sx > 152) dx = (int8_t)-dx;
    if (sy < 1 || sy > 136) dy = (int8_t)-dy;
    oam_clear();
    oam_set(0, (uint8_t)(sy + 16), (uint8_t)(sx + 8), T_SPRITE, 0);
  }
}

/* ── default.c — minimal Game Boy Color (CGB) starter ─────────────
 *
 * A "hello, it works! IN COLOR" screen: a tiled background (two bands
 * + a centre box) drawn with a real CGB palette, plus a sprite that
 * bounces around. The very first GBC build shows recognizable content
 * — not a flat colour. Use this as the starting point when you're not
 * yet sure what you want to build; edit from here.
 *
 * GBC-specific notes:
 *   - CGB uses BCPS/BCPD ($FF68/$FF69) to write into 64 bytes of
 *     palette RAM (8 BG palettes × 4 colours × 2 bytes each, BGR555
 *     little-endian) and OCPS/OCPD for the sprite palettes. The DMG-only
 *     BGP/OBP0/OBP1 ($FF47-$49) registers do nothing in CGB mode.
 *   - You MUST put tiles in VRAM and enable the BG (LCDC bit 0) or the
 *     screen stays one flat colour — the #1 GB "why is it blank" footgun.
 *     We upload tiles to $8000 and select LCDC_TILE_DATA_LO (unsigned
 *     $8000 addressing) so tile index N lives at $8000 + N*16.
 *   - patchGbHeader on a .gbc file sets $0143 = $80 (CGB-aware) by
 *     default. The corresponding `.gb` default uses DMG BGP — don't
 *     cross-pollinate the two trees.
 *
 * For something more game-shaped, peek at other templates in this dir:
 *   - hello_sprite — sprite + d-pad movement
 *   - tile_engine  — multi-room tile map with collision + transitions
 *   - shmup / platformer / puzzle / sports / racing — genre scaffolds
 *   - music_demo   — bundled hUGEDriver music driver demo
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

/* Three 8×8 tiles, 2bpp (16 bytes each: row N = byte 2N low-bits, 2N+1
 * high-bits).  Colour index per tile pixel selects into the 4-colour
 * palette below.
 *   tile 0 — blank   (all colour 0 — reserved so OAM Y=0 doesn't glitch)
 *   tile 1 — solid   (all colour 1 — the background fill / bands)
 *   tile 2 — sprite  (a filled diamond in colour 3) */
static const uint8_t tiles[3 * 16] = {
  /* tile 0: blank */
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* tile 1: solid colour 1 (low plane all-on, high plane all-off) */
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
  /* tile 2: diamond in colour 3 (both planes set on the diamond pixels) */
  0x18,0x18, 0x3C,0x3C, 0x7E,0x7E, 0xFF,0xFF,
  0xFF,0xFF, 0x7E,0x7E, 0x3C,0x3C, 0x18,0x18,
};

/* BG palette 0 (BGR555). Colour 0 = backdrop, colour 1 = the bands/box.
 * We cycle colour 1 through these four shades each ~32 frames so you can
 * SEE the CGB palette path is alive. */
static const uint16_t bg_fill_cycle[4] = {
  0x03FF,  /* yellow-ish */
  0x7C00,  /* blue       */
  0x03E0,  /* green      */
  0x001F,  /* red        */
};

/* Sprite palette (OBJ palette 0): 0 transparent, 3 = white diamond. */
static const uint16_t obj_pal[4] = {
  0x0000,  /* 0 transparent (sprite colour 0 never drawn) */
  0x7FFF,  /* 1 white  */
  0x03E0,  /* 2 green  */
  0x7FFF,  /* 3 white  */
};

static void set_bg_color1(uint16_t bgr555) {
  /* Write BG palette 0: colour 0 = dark backdrop, colour 1 = bgr555. */
  BCPS = 0x80;                              /* palette 0, colour 0, auto-inc */
  BCPD = 0x08; BCPD = 0x21;                 /* colour 0 = dark grey (0x2108) */
  BCPD = (uint8_t)(bgr555 & 0xFF);          /* colour 1 lo */
  BCPD = (uint8_t)((bgr555 >> 8) & 0xFF);   /* colour 1 hi */
}

void main(void) {
  uint8_t x, y;
  uint8_t sx = 76, sy = 64;        /* sprite screen position */
  int8_t  dx = 1,  dy = 1;          /* sprite velocity */
  uint8_t shade = 0;
  uint16_t frame = 0;
  uint8_t *bg_map = BG_MAP_0;       /* $9800 */
  uint8_t i;

  /* 1. LCD off (safely — lcd_init_default checks LCDC.7 first). */
  lcd_init_default();
  LCDC = 0;

  /* 2. Tiles → VRAM at $8000 (unsigned addressing, see LCDC_TILE_DATA_LO). */
  memcpy_vram((void *)0x8000, tiles, sizeof(tiles));

  /* 3. Palettes. */
  set_bg_color1(bg_fill_cycle[0]);
  OCPS = 0x80;
  for (i = 0; i < 4; i++) {
    OCPD = (uint8_t)(obj_pal[i] & 0xFF);
    OCPD = (uint8_t)((obj_pal[i] >> 8) & 0xFF);
  }

  /* 4. Paint the BG map (32×32; we fill the visible 20×18). Background
   *    is tile 0 (blank → backdrop colour); two solid bands + a centre
   *    box are tile 1 so the screen reads as real content. */
  for (y = 0; y < 32; y++)
    for (x = 0; x < 32; x++)
      bg_map[y * 32 + x] = 0;
  for (x = 0; x < 20; x++) {
    bg_map[2 * 32 + x]  = 1;   /* top band    (row 2)  */
    bg_map[15 * 32 + x] = 1;   /* bottom band (row 15) */
  }
  for (y = 6; y < 12; y++)
    for (x = 6; x < 14; x++)
      bg_map[y * 32 + x] = 1;  /* centre box */

  /* 5. Initial sprite. */
  oam_clear();
  oam_set(0, (uint8_t)(sy + 16), (uint8_t)(sx + 8), 2, 0);

  /* 6. LCD on with BG + OBJ + $8000 tile addressing. */
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;

  for (;;) {
    wait_vblank();
    oam_dma_flush();

    frame++;
    if ((frame & 0x1F) == 0) {            /* every 32 frames: cycle BG colour */
      shade = (uint8_t)((shade + 1) & 0x03);
      set_bg_color1(bg_fill_cycle[shade]);
    }

    /* Bounce the sprite around the 160×144 visible area. */
    sx = (uint8_t)(sx + dx);
    sy = (uint8_t)(sy + dy);
    if (sx < 1 || sx > 152) dx = (int8_t)-dx;
    if (sy < 1 || sy > 136) dy = (int8_t)-dy;
    oam_clear();
    oam_set(0, (uint8_t)(sy + 16), (uint8_t)(sx + 8), 2, 0);
  }
}

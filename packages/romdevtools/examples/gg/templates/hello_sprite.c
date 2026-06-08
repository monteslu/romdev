/* ── hello_sprite.c — Game Gear starter (one sprite + d-pad) ────────
 *
 * Drives one sprite around the Game Gear screen with the directional
 * pad. Uses the bundled GG runtime helpers (gg_vdp_init, gg_load_tiles,
 * gg_load_palette, gg_sprite_*, gg_vblank_wait, gg_joypad_read).
 *
 * GG hardware notes the templates assume:
 *   - 256×192 internal frame; only the centered 160×144 region SHOWS.
 *     Keep gameplay sprites inside [VIS_X0..VIS_X1] x [VIS_Y0..VIS_Y1].
 *   - Sprite attribute table at VRAM $3F00 (configured by gg_vdp_init)
 *   - Sprite tile data at VRAM $2000 (R6 = 0xFF → SA13 set → $2000)
 *   - 64 sprite slots × 4 bytes (Y / X / tile / unused)
 *
 * Multi-file project — main.c plus the runtime .c files. Build with:
 *   build({ output: "rom", platform:"gg", language:"c",
 *                sources: { "main.c": ..., "vdp_init.c": ..., ... },
 *                includes: { "gg_hw.h": ... }})
 *
 * createProject({platform:"gg", template:"hello_sprite"}) copies all
 * the bits into your project tree.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include <stdint.h>

extern void gg_vdp_init(void);
extern void gg_vdp_display_on(void);
extern void gg_vdp_write_reg(uint8_t reg, uint8_t value);
extern void gg_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void gg_load_palette(const uint8_t *palette);
extern void gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern void gg_vblank_wait(void);
extern uint8_t gg_joypad_read(void);
extern void gg_sprite_init(void);
extern void gg_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void gg_sat_upload(void);

/* GG palette = 32 entries × 2 bytes (4-4-4 BGR LE): low=(g<<4)|r, high=b.
 * Entries 0-15 = BG, 16-31 = SPRITE. gg_load_palette reads 64 bytes, so a
 * 32-byte SMS-style array leaves the sprite palette (16-31) reading past the
 * array = garbage = INVISIBLE sprites. Sprite colour index N uses entry 16+N,
 * so sprite colour 1 = entry 17 (white here). */
static const uint8_t palette[64] = {
  /* BG 0-15: 0 = dark navy backdrop, 1 = teal, 2 = blue (dither tones) */
  0x20,0x02, 0xC8,0x08, 0x80,0x0C, 0,0, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* SPRITE 16-31: 16=transparent, 17=white */
  0,0, 0xFF,0x0F, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
};

/* One dithered BG tile (BG bank $0000): plane0/plane1 alternate so pixels
 * flip between colour 1 (teal) and colour 2 (blue). Filling the name table
 * with it gives a two-tone backdrop so the frame is never a flat colour —
 * a uniform fill still reads as a blank screen. The dither fills the whole
 * 256x192 frame, so it shows in the GG's centered 160x144 window too. */
static const uint8_t bg_tile[32] = {
  0xAA,0x55,0x00,0x00, 0x55,0xAA,0x00,0x00,
  0xAA,0x55,0x00,0x00, 0x55,0xAA,0x00,0x00,
  0xAA,0x55,0x00,0x00, 0x55,0xAA,0x00,0x00,
  0xAA,0x55,0x00,0x00, 0x55,0xAA,0x00,0x00,
};

static void draw_bg(void) {
  uint8_t row, col;
  for (row = 0; row < 28; row++)
    for (col = 0; col < 32; col++)
      gg_set_tilemap_cell(row, col, 0, 0);
}

/* ── Game Gear visible viewport ──────────────────────────────────────
 * Sprite OAM uses SMS HARDWARE coordinates (256x192 space), but the GG
 * LCD only shows the CENTER 160x144. Keep the sprite inside this box or
 * it's placed "correctly" in hardware yet INVISIBLE on screen. */
#define VIS_X0  48
#define VIS_Y0  24
#define VIS_X1  207   /* 48 + 160 - 1 */
#define VIS_Y1  167   /* 24 + 144 - 1 */

/* One 8×8 sprite tile (4bpp interleaved). Filled square in color 1. */
static const uint8_t sprite_tile[32] = {
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
};

void main(void) {
  uint8_t x = (VIS_X0 + VIS_X1) / 2;   /* center of the visible window */
  uint8_t y = (VIS_Y0 + VIS_Y1) / 2;
  uint8_t prev = 0;

  gg_vdp_init();
  gg_load_palette(palette);
  /* BG dither tile → BG bank $0000, paint the whole name table. */
  gg_load_tiles(0x0000, bg_tile, 32);
  draw_bg();
  /* Upload one sprite tile to VRAM $2000 (sprite tile area). */
  gg_load_tiles(0x2000, sprite_tile, 32);

  gg_sprite_init();
  sfx_init();
  sfx_tone(0, 220, 12);  /* boot chime — confirms sound works */
  gg_sprite_set(0, x, y, /*tile*/ 0);
  gg_sat_upload();

  gg_vdp_display_on();

  do {
    uint8_t pad;
    gg_vblank_wait();
    sfx_update();
    /* Stage sprite for the next frame BEFORE we read input — the SAT
     * upload below pushes the staging buffer to VRAM at vblank. */
    gg_sprite_set(0, x, y, 0);
    gg_sat_upload();

    pad = gg_joypad_read();
    /* Clamp to the visible window so the sprite never slides off-screen. */
    if (pad & JOY_LEFT  && x > VIS_X0)      x = (uint8_t)(x - 2);
    if (pad & JOY_RIGHT && x < VIS_X1 - 8)  x = (uint8_t)(x + 2);
    if (pad & JOY_UP    && y > VIS_Y0)      y = (uint8_t)(y - 2);
    if (pad & JOY_DOWN  && y < VIS_Y1 - 8)  y = (uint8_t)(y + 2);
    prev = pad;
    (void)prev;
  } while (1);
}

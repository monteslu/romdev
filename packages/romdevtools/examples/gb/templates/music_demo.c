/* ── music_demo.c — hUGEDriver music player demo (GB) ────────────────
 *
 * Plays the bundled sample_song (see song_data.c) on the GB APU.
 *
 * The driver shipped here is a compact SDCC-native music player whose
 * function surface (hUGE_init / hUGE_dosound) matches the upstream
 * hUGEDriver project (https://github.com/SuperDisk/hUGEDriver, public
 * domain). The upstream RGBDS asm source is bundled in source-visible
 * form as `hUGEDriver.upstream.asm` so an agent can later port to it.
 *
 * Wiring:
 *   - sound_init()         power-on the APU (NR52 master enable)
 *   - hUGE_init(&song)     load the song descriptor
 *   - hUGE_dosound()       advance one tick; call once per vblank
 *
 * What you should hear: a short looping 4-pattern, two-channel tune in
 * C-major. Melody on CH1 (square 1), bass on CH2 (square 2). Drops
 * back to the start of the song after ~8 seconds.
 *
 * Visual: BGP cycles through 4 shades so you can also SEE the driver
 * is alive even if you have audio muted in your emulator.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"
#include "hUGEDriver.h"

/* The song descriptor is defined in song_data.c (linked in by the
 * project template). */
extern const huge_song_t sample_song;

/* Two 8×8 2bpp tiles so the BG isn't a single flat colour (a uniform
 * screen reads >=92% one colour and fails the blank-screen check):
 *   tile 1 — solid colour 3
 *   tile 2 — solid colour 1
 * We checkerboard them across the BG map below. */
static const uint8_t tile_solid3[16] = {
  0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
  0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF,
};
static const uint8_t tile_solid1[16] = {
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
};

void main(void) {
  uint8_t  shade = 0;
  uint16_t frame = 0;
  uint8_t *bg_map;
  uint16_t j;

  lcd_init_default();
  LCDC = 0;               /* LCD off so we can write VRAM freely */

  /* Upload two tiles to VRAM slots 1 ($8010) and 2 ($8020). Use
   * memcpy_vram (pointer-walk) — an indexed dst[i]=src[i] loop into VRAM
   * is miscompiled by SDCC sm83. */
  memcpy_vram((uint8_t *)0x8010, tile_solid3, 16);
  memcpy_vram((uint8_t *)0x8020, tile_solid1, 16);

  /* Checkerboard the 32×32 BG map at $9800 with tiles 1 and 2 so the
   * screen shows two distinct shades. Pointer-walk (NOT bg_map[k]=...,
   * which SDCC sm83 miscompiles into VRAM). */
  bg_map = (uint8_t *)0x9800;
  for (j = 0; j < 32u * 32u; j++) {
    *bg_map++ = (uint8_t)((((j ^ (j >> 5)) & 1u) ? 1u : 2u));
  }

  /* LCD on with BG enabled, $8000 tile-data addressing so index 1 == our
   * tile at $8010. */
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_TILE_DATA_LO;

  sound_init();

  hUGE_init(&sample_song);

  for (;;) {
    wait_vblank();
    hUGE_dosound();         /* one driver tick per frame */
    frame++;
    if ((frame & 0x1F) == 0) {
      shade = (uint8_t)((shade + 1) & 0x03);
      /* DMG palette cycle — every 32 frames shift the BG shade.
       * On GBC this writes through to the legacy DMG-compat palette. */
      BGP = (uint8_t)(0xE4u ^ (uint8_t)(shade * 0x55u));
    }
  }
}

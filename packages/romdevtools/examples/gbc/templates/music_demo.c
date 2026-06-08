/* ── music_demo.c — hUGEDriver music player demo (GBC) ───────────────
 *
 * Plays the bundled sample_song (see song_data.c) on the GBC APU. The
 * APU is identical between DMG and CGB modes, so the driver code is
 * the same — only the BG-palette path differs (BCPS/BCPD instead of
 * BGP). The .gbc extension flips $0143 = $80 → gambatte boots CGB mode.
 *
 * Driver: compact SDCC-native rewrite of the upstream hUGEDriver
 * interface (https://github.com/SuperDisk/hUGEDriver, public domain).
 *
 * Wiring:
 *   - sound_init()         power-on the APU
 *   - hUGE_init(&song)     load song descriptor
 *   - hUGE_dosound()       advance one tick; call once per vblank
 *
 * Visual: BG palette 0 cycles through 4 colors — purple/blue/green/red —
 * via BCPS/BCPD writes, so the demo is unambiguously CGB-mode visible.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"
#include "hUGEDriver.h"

extern const huge_song_t sample_song;

/* CGB BG palette 0: backdrop colour cycles (bg_colors[shade]) while
 * colours 1..3 stay fixed and bright, so the checkerboard backdrop below
 * always shows several distinct colours (not a single flat field). */
static const uint16_t bg_colors[4] = {
  0x4210,  /* dim purple */
  0x4308,  /* dim blue   */
  0x0252,  /* dim green  */
  0x0017,  /* dim red    */
};

/* Two 8×8 2bpp tiles so the BG isn't a single flat colour:
 *   tile 1 — solid colour 1
 *   tile 2 — solid colour 2
 * Checkerboarded across the BG map below. */
static const uint8_t tile_solid1[16] = {
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
  0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
};
static const uint8_t tile_solid2[16] = {
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
  0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
};

/* Write CGB BG palette 0 with the current backdrop shade plus fixed bright
 * colours 1..3 (blue / green / white) so the checkerboard is multi-colour. */
static void set_bg_palette(uint8_t shade) {
  BCPS = 0x80;            /* auto-increment, start at palette 0 colour 0 */
  /* colour 0 — animated backdrop */
  BCPD = (uint8_t)(bg_colors[shade] & 0xFFu);
  BCPD = (uint8_t)((bg_colors[shade] >> 8) & 0xFFu);
  /* colour 1 — bright blue */
  BCPD = (uint8_t)(0x7C00u & 0xFFu);
  BCPD = (uint8_t)((0x7C00u >> 8) & 0xFFu);
  /* colour 2 — bright green */
  BCPD = (uint8_t)(0x03E0u & 0xFFu);
  BCPD = (uint8_t)((0x03E0u >> 8) & 0xFFu);
  /* colour 3 — white */
  BCPD = (uint8_t)(0x7FFFu & 0xFFu);
  BCPD = (uint8_t)((0x7FFFu >> 8) & 0xFFu);
}

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
  memcpy_vram((uint8_t *)0x8010, tile_solid1, 16);
  memcpy_vram((uint8_t *)0x8020, tile_solid2, 16);

  /* Checkerboard the 32×32 BG map at $9800 with tiles 1 and 2. Pointer-walk
   * (NOT bg_map[k]=..., which SDCC sm83 miscompiles into VRAM). */
  bg_map = (uint8_t *)0x9800;
  for (j = 0; j < 32u * 32u; j++) {
    *bg_map++ = (uint8_t)((((j ^ (j >> 5)) & 1u) ? 1u : 2u));
  }

  set_bg_palette(shade);

  /* LCD on with BG enabled, $8000 tile-data addressing. */
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_TILE_DATA_LO;

  sound_init();

  hUGE_init(&sample_song);

  for (;;) {
    wait_vblank();
    hUGE_dosound();
    frame++;
    if ((frame & 0x3F) == 0) {     /* every 64 frames ≈ 1 s */
      shade = (uint8_t)((shade + 1) & 0x03);
      set_bg_palette(shade);
    }
  }
}

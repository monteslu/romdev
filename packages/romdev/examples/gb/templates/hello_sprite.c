/* ── hello_sprite.c — GBC starter (works on plain GB too) ──────────
 *
 * A complete, tested, boots-from-cold game-loop skeleton:
 *   - Turns the LCD off safely (handles "LCD already off at boot")
 *   - Uploads one 16-byte tile to VRAM tile slot 1
 *   - Writes a 4-color object palette (CGB BCPD path; harmless on DMG)
 *   - Places sprite 0 in the middle of the screen
 *   - Reads d-pad each vblank and moves the sprite
 *   - Uses shadow_oam + oam_dma_flush so writes are clean
 *
 * Edit FROM this baseline rather than building from scratch — the
 * boot order below is the GBC pitfall that costs new ports the most
 * time (see TROUBLESHOOTING.md "screen is blank").
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

/* A simple 8×8 tile, 2bpp. Each row is 2 bytes; 8 rows × 2 = 16 bytes.
 * Layout: row N's low-bits come from byte 2N, high-bits from byte 2N+1.
 * This makes a hollow square (color 3 outline, color 0 fill). */
static const uint8_t tile_data[16] = {
  0xFF, 0xFF,   /* row 0: all color 3 */
  0x81, 0x81,   /* row 1: outline only */
  0x81, 0x81,
  0x81, 0x81,
  0x81, 0x81,
  0x81, 0x81,
  0x81, 0x81,
  0xFF, 0xFF,   /* row 7: all color 3 */
};

/* CGB object palette 0 in BGR555. Color 0 must be transparent for sprites,
 * but the value is still written (the hardware ignores it). */
static const uint16_t obj_palette[4] = {
  0x7FFF,  /* color 0 — transparent (any value) */
  0x001F,  /* color 1 — red */
  0x03E0,  /* color 2 — green */
  0x7C00,  /* color 3 — blue */
};

void main(void) {
  uint8_t pad = 0;
  uint8_t prev_pad = 0;
  uint8_t x = 80;       /* hardware X = screen X + 8 */
  uint8_t y = 80;       /* hardware Y = screen Y + 16 */
  uint8_t i;
  uint8_t *vram_dst;
  const uint8_t *src;

  /* ── 1. LCD off (safe whether it was on or off) ──────────────────
   * lcd_init_default() checks LCDC.7 and only waits for vblank if the
   * LCD is on; otherwise LY is frozen at 0 and a blind wait would hang
   * the entire boot. */
  lcd_init_default();
  LCDC = 0;             /* turn off again so we can write VRAM freely */

  /* ── 2. Upload our tile to VRAM slot 1 ($8010) ───────────────────
   * Slot 0 ($8000) is reserved for "blank" by convention so we don't
   * accidentally render garbage tiles that point to it. */
  vram_dst = (uint8_t *)0x8010;
  src = tile_data;
  for (i = 0; i < 16; i++) {
    vram_dst[i] = src[i];
  }

  /* ── 3. Object palette 0 (CGB path) ──────────────────────────────
   * OCPS bit 7 = auto-increment after each write; bits 5..3 = palette
   * index (0..7); bits 2..1 = color index (0..3); bit 0 = MSB select.
   * Setting OCPS = 0x80 means "palette 0, color 0, low byte, then
   * auto-advance". 8 byte writes = 4 colors × 2 bytes (BGR555).
   *
   * On DMG, OCPS/OCPD don't exist — the writes are silently dropped
   * and DMG uses OBP0 instead, which lcd_init_default already set. */
  OCPS = 0x80;
  for (i = 0; i < 4; i++) {
    OCPD = (uint8_t)(obj_palette[i] & 0xFF);        /* low byte */
    OCPD = (uint8_t)((obj_palette[i] >> 8) & 0xFF); /* high byte */
  }

  /* ── 4. Build initial OAM ────────────────────────────────────────
   * Clear all 40 slots then write our sprite into slot 0. */
  oam_clear();
  oam_set(0, y, x, /* tile= */ 1, /* attr= */ 0);

  /* ── 5. Turn the LCD back on with BG + OBJ enabled. ──────────────
   * LCDC bits: 0x80=LCD on, 0x02=OBJ on, 0x10=tile data at $8000.
   * (BG remains off — we have no BG map set up.) */
  LCDC = LCDC_LCD_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;

  /* ── 6. APU on — let the player beep ──────────────────────────── */
  sound_init();

  /* ── 7. Game loop ────────────────────────────────────────────────
   * Order matters:
   *   wait for vblank  → safe time to flush OAM
   *   flush OAM        → push shadow_oam to hardware
   *   read input       → for next frame's update
   *   update           → mutate game state
   * Then loop. */
  for (;;) {
    wait_vblank();
    oam_dma_flush();
    prev_pad = pad;
    pad = joypad_read();

    /* D-pad lives in the HIGH nybble of joypad_read's packed byte. */
    if (pad & PAD_LEFT)  x--;
    if (pad & PAD_RIGHT) x++;
    if (pad & PAD_UP)    y--;
    if (pad & PAD_DOWN)  y++;

    /* Beep on the rising edge of A (one-shot, not held). */
    if ((pad & PAD_A) && !(prev_pad & PAD_A)) {
      /* C5-ish note on channel 2 (~261 Hz, ~120ms). */
      sound_play_tone(2, 1798, 30);
    }

    /* Re-stage the sprite at its new position. */
    oam_set(0, y, x, 1, 0);
  }
}

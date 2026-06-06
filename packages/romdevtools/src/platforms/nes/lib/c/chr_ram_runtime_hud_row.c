/* chr_ram_runtime_hud_row.c — BG-layer HUD: score + label at row 2.
 *
 * Demonstrates the queued-VRAM-writes pattern for updating BG
 * during gameplay. Use as the starting point for any game that
 * needs a score display, lives counter, or persistent on-screen
 * text.
 *
 * Build with:
 *   build({output:'rom'})({platform:"nes", linkerConfig:"chr-ram-runtime",
 *                sources:{"main.c": <this>, "nes_runtime.c": <runtime>},
 *                includes:{"nes_runtime.h": <header>}})
 *
 * Footguns this avoids:
 *
 * 1. HUD at row 2, not row 0. Framebuffer is 256×224 — top 8 px
 *    (nametable row 0, PPU $2000-$201F) are cropped by overscan.
 *    Always position visible BG at rows 2-27.
 *
 * 2. BG pattern table is at $1000 (PPUCTRL bit 4 = 1 by default).
 *    Upload BG tiles via chr_ram_upload(0x1000 + tile*16, ...),
 *    NOT 0x0000 (that's the sprite pattern table).
 *
 * 3. Updates use tile_set() which queues into vram_queue. The NMI
 *    handler flushes the queue during vblank — writes during
 *    rendering would corrupt the PPUADDR latch.
 *
 * 4. Decimal-digit rendering goes high-to-low (left-to-right on
 *    screen) so a "012" score shows as "012" not "210".
 */
#include "nes_runtime.h"

/* Tile patterns for digits 0-9, each 16 bytes (2bpp NES format).
 * Plane 0 = outline, plane 1 = 0. So digits render in color 1. */
static const uint8_t digit_tiles[10][16] = {
  /* '0' */ { 0x3C,0x66,0x66,0x66,0x66,0x66,0x66,0x3C, 0,0,0,0,0,0,0,0 },
  /* '1' */ { 0x18,0x38,0x18,0x18,0x18,0x18,0x18,0x7E, 0,0,0,0,0,0,0,0 },
  /* '2' */ { 0x3C,0x66,0x06,0x0C,0x18,0x30,0x60,0x7E, 0,0,0,0,0,0,0,0 },
  /* '3' */ { 0x3C,0x66,0x06,0x1C,0x06,0x06,0x66,0x3C, 0,0,0,0,0,0,0,0 },
  /* '4' */ { 0x0C,0x1C,0x3C,0x6C,0x7E,0x0C,0x0C,0x0C, 0,0,0,0,0,0,0,0 },
  /* '5' */ { 0x7E,0x60,0x60,0x7C,0x06,0x06,0x66,0x3C, 0,0,0,0,0,0,0,0 },
  /* '6' */ { 0x3C,0x66,0x60,0x7C,0x66,0x66,0x66,0x3C, 0,0,0,0,0,0,0,0 },
  /* '7' */ { 0x7E,0x06,0x0C,0x18,0x18,0x18,0x18,0x18, 0,0,0,0,0,0,0,0 },
  /* '8' */ { 0x3C,0x66,0x66,0x3C,0x66,0x66,0x66,0x3C, 0,0,0,0,0,0,0,0 },
  /* '9' */ { 0x3C,0x66,0x66,0x66,0x3E,0x06,0x66,0x3C, 0,0,0,0,0,0,0,0 },
};

static const uint8_t palette[32] = {
  0x0F, 0x30, 0x16, 0x00,    /* BG pal 0: backdrop / white / red / black */
  0x0F, 0x30, 0x16, 0x00,
  0x0F, 0x30, 0x16, 0x00,
  0x0F, 0x30, 0x16, 0x00,
  0x0F, 0x30, 0x16, 0x00,    /* sprite pals (unused here) */
  0x0F, 0x30, 0x16, 0x00,
  0x0F, 0x30, 0x16, 0x00,
  0x0F, 0x30, 0x16, 0x00,
};

/* Draw a 3-digit decimal number at nametable (x, 2). High digit on
 * the LEFT (canonical reading order). */
static void draw_score(uint8_t x, uint16_t value) {
  uint8_t hundreds = (uint8_t)((value / 100) % 10);
  uint8_t tens     = (uint8_t)((value / 10)  % 10);
  uint8_t ones     = (uint8_t)(value % 10);
  /* Tiles 0x10..0x19 hold digits 0..9 in BG pattern table.
   * tile_set queues — NMI flushes during vblank. */
  tile_set(0, x,     2, (uint8_t)(0x10 + hundreds));
  tile_set(0, x + 1, 2, (uint8_t)(0x10 + tens));
  tile_set(0, x + 2, 2, (uint8_t)(0x10 + ones));
}

void main(void) {
  uint16_t score = 0;
  uint8_t frame = 0;

  /* ── 1. Init (PPU off) ────────────────────────────────────── */
  ppu_off();

  /* Upload digit tiles into BG pattern table at $1100 = tile slot $10.
   * 10 digits × 16 bytes = 160 bytes total. */
  chr_ram_upload(0x1100, &digit_tiles[0][0], 160);

  palette_load(palette);

  /* Initial score render — queued, will flush at next NMI. Since
   * rendering is OFF now, the queued writes happen in the first
   * NMI after ppu_on_all (which is when NMI fires for the first time). */
  draw_score(/* col */ 14, score);

  ppu_on_all();

  /* ── 2. Game loop ────────────────────────────────────────── */
  for (;;) {
    ++frame;
    if (frame == 0) {            /* every 256 frames (~4 seconds) */
      ++score;
      if (score > 999) score = 0;
      draw_score(14, score);     /* re-queue the 3 digit cells */
    }
    ppu_wait_nmi();              /* NMI flushes the queue + DMAs OAM */
  }
}

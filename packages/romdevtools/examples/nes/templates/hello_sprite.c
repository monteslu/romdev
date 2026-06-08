/* ── hello_sprite.c — NES starter ────────────────────────────────
 *
 * Tested boots-from-cold game-loop skeleton:
 *   - Standard two-vblank PPU warm-up (handled by the bundled crt0)
 *   - Uploads one 8×8 tile (sprite ID 1) to CHR-RAM
 *   - Sets a 4-color sprite palette at $3F10
 *   - Places one sprite in the middle of the screen
 *   - Reads d-pad each NMI and moves it
 *   - Uses shadow_oam (at $0200) — the NMI handler DMAs it to $2003
 *     automatically every frame
 *
 * Edit FROM this baseline rather than building from scratch — the
 * two-vblank warm-up and palette-at-$3F00 setup below are the NES
 * pitfalls that cost new ports the most time (see TROUBLESHOOTING.md
 * "screen blank" / "wrong colors").
 *
 * Game-loop order is important: stage sprites FIRST, then call
 * ppu_wait_nmi. The NMI handler fires at vblank-start and DMAs whatever
 * shadow_oam contains AT THAT MOMENT. If you stage sprites AFTER waiting,
 * you'd be staging into a buffer that already got DMA'd a frame earlier.
 */

#include "nes_runtime.h"

/* A simple 8×8 tile, 2bpp NES format. Each plane is 8 bytes; tile = two
 * stacked planes (low bits then high bits). This makes a hollow square
 * outline using color 1. */
static const uint8_t tile_data[16] = {
  /* plane 0 (low bit of each pixel) */
  0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF,
  /* plane 1 (high bit of each pixel) — keep zero, so all pixels are color 1 */
  0,    0,    0,    0,    0,    0,    0,    0,
};

/* Two BG tiles so the backdrop isn't a single flat colour (a uniform
 * screen reads >=92% one colour and fails the blank-screen check):
 *   tile 1 — solid colour 1
 *   tile 2 — solid colour 2
 * Checkerboarded across the nametable below. BG fetches from $1000-$1FFF
 * under the default PPUCTRL, so these upload to the BG pattern table. */
static const uint8_t bg_tiles[2 * 16] = {
  /* tile 1: solid colour 1 */
  0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  /* tile 2: solid colour 2 */
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,
};

/* 32-byte palette: 4 BG palettes + 4 sprite palettes.
 * BG  index 0 ($3F00) is the universal backdrop.
 * SPR index 0 ($3F10) is transparent — always; the value is written
 * but the hardware ignores it. */
static const uint8_t palette[32] = {
  /* BG palettes 0-3 */
  0x0F, 0x30, 0x10, 0x00,
  0x0F, 0x21, 0x11, 0x01,
  0x0F, 0x27, 0x17, 0x07,
  0x0F, 0x2A, 0x1A, 0x0A,
  /* Sprite palettes 0-3 — palette 0 colour 1 = light blue */
  0x0F, 0x2C, 0x12, 0x32,
  0x0F, 0x21, 0x11, 0x01,
  0x0F, 0x27, 0x17, 0x07,
  0x0F, 0x2A, 0x1A, 0x0A,
};

/* Fill nametable 0 ($2000) with a checkerboard of BG tiles 1 and 2 so the
 * screen behind the sprite is visibly NOT blank. Attribute table stays at
 * palette 0. Caller must have the PPU off. */
static void fill_bg(void) {
  uint16_t addr;
  uint8_t y, x;
  for (y = 0; y < 30; y++) {
    addr = (uint16_t)(0x2000 + (uint16_t)y * 32);
    for (x = 0; x < 32; x++) {
      vram_unsafe_set(addr, (uint8_t)(((x ^ y) & 1) + 1));
      ++addr;
    }
  }
}

void main(void) {
  uint8_t px = 124;       /* mid-screen X */
  uint8_t py = 110;       /* mid-screen Y */
  uint8_t pad;
  uint8_t prev_pad = 0;   /* for one-shot edge detection on A */

  /* ── 1. PPU off (rendering disabled — safe to write VRAM) ─────── */
  ppu_off();

  /* ── 2. Upload our tile to CHR-RAM at $0010 (tile slot 1) ──────
   * Slot 0 ($0000) is reserved for "blank" by convention so we don't
   * accidentally render garbage tiles. We use sprite-pattern table
   * at $0000-$0FFF since the default PPUCTRL has sprite_pattern=0. */
  chr_ram_upload(0x0010, tile_data, 16);

  /* ── 2b. Upload BG tiles to the BG pattern table at $1000 and paint
   * a checkerboard backdrop so the sprite isn't alone on a blank field. */
  chr_ram_upload(0x1000, bg_tiles, sizeof(bg_tiles));
  fill_bg();

  /* ── 3. Load palette ─────────────────────────────────────────── */
  palette_load(palette);

  /* ── 4. Clear OAM (Y=$FF = off-screen) and stage initial sprite. */
  oam_clear();
  oam_spr(px, py, /* tile */ 1, /* attr */ 0);

  /* ── 5. PPU back on with BG + sprites ────────────────────────── */
  ppu_on_all();

  /* ── 6. APU on — let the player beep ─────────────────────────── */
  sound_init();

  /* ── 7. Game loop ────────────────────────────────────────────── */
  for (;;) {
    /* Stage sprites for the next frame FIRST. The NMI handler will
     * DMA whatever shadow_oam contains at vblank-start. */
    oam_clear();
    oam_spr(px, py, 1, 0);

    /* Now block until the NMI fires (vblank-start). */
    ppu_wait_nmi();

    /* Read input and update game state. */
    pad = pad_poll(0);
    if (pad & PAD_LEFT)  --px;
    if (pad & PAD_RIGHT) ++px;
    if (pad & PAD_UP)    --py;
    if (pad & PAD_DOWN)  ++py;

    /* Play a beep on the rising edge of A (one-shot, not held). */
    if ((pad & PAD_A) && !(prev_pad & PAD_A)) {
      /* C5 note on pulse1, mid volume, ~150ms */
      sound_play_tone(/* pulse1 */ 0, /* period */ 0x1AA, /* vol */ 8, /* length */ 10);
    }
    prev_pad = pad;
  }
}

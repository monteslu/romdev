// ── hello_sprite.c — Commodore 64 VIC-II sprite + joystick ──────────
//
// One MOB sprite (one of the C64's 8 hardware sprites) driven by the
// joystick in port 2. The C64 has two joystick ports: port 2 is the
// agent-friendly default since reading port 1 (`CIA1_PRB`) clashes
// with the keyboard scan matrix.
//
// VIC-II sprite quick reference:
//   - 8 sprites max, each 24×21 pixels (3 bytes wide × 21 rows = 63 bytes)
//   - Stored in 64-byte chunks aligned to a "sprite pointer" slot
//     ($07F8..$07FF) which holds a /64 index into the VIC's 16 KB bank
//   - Default VIC bank = $0000-$3FFF, so a pointer value of $20 means
//     sprite data lives at $20 * $40 = $0800
//   - VIC_SPRITE_X(N) / Y(N) → sprite N position registers
//   - VIC_SPR_ENA bit N → enable bit for sprite N
//   - VIC_SPR_COL(N) → per-sprite color (single-color sprites only;
//     multicolor uses MC0/MC1 + per-sprite multicolor bit)
//
// To extend: define more sprites and walk multiple pointer slots; turn
// on multicolor mode for 4-color sprites via VIC_SPR_MCOLOR bits.

#include "c64_registers.h"
#include <stdint.h>

#define POKE(addr, val)  (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)       (*(volatile uint8_t*)(addr))

#define SPRITE_POINTERS  ((volatile uint8_t*)0x07F8)
#define SPRITE_DATA      ((volatile uint8_t*)0x0800)   /* 64 bytes per sprite */

#define JOY_UP    0x01
#define JOY_DOWN  0x02
#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08
#define JOY_FIRE  0x10

// 24×21 sprite — a simple filled diamond. Each row is 3 bytes (24 px,
// 1 bit per pixel = single-color sprite mode).
static const uint8_t sprite_data[64] = {
  /* row */
  0x00,0x18,0x00,
  0x00,0x3C,0x00,
  0x00,0x7E,0x00,
  0x00,0xFF,0x00,
  0x01,0xFF,0x80,
  0x03,0xFF,0xC0,
  0x07,0xFF,0xE0,
  0x0F,0xFF,0xF0,
  0x1F,0xFF,0xF8,
  0x3F,0xFF,0xFC,
  0x7F,0xFF,0xFE,
  0x3F,0xFF,0xFC,
  0x1F,0xFF,0xF8,
  0x0F,0xFF,0xF0,
  0x07,0xFF,0xE0,
  0x03,0xFF,0xC0,
  0x01,0xFF,0x80,
  0x00,0xFF,0x00,
  0x00,0x7E,0x00,
  0x00,0x3C,0x00,
  0x00,0x18,0x00,
  0,  /* padding to 64 bytes */
};

static void copy_sprite(void) {
  uint8_t i;
  for (i = 0; i < 64; i++) SPRITE_DATA[i] = sprite_data[i];
}

static void wait_vblank(void) {
  // VIC_RASTER reports the current rasterline. The VBLANK starts when
  // the raster passes line 250 (visible region is roughly 50..250).
  // Spinning until we see line 250+ gives us a stable per-frame tick.
  while (PEEK(VIC_RASTER) < 250) { }
  while (PEEK(VIC_RASTER) >= 250) { }
}

void main(void) {
  uint8_t sx = 160;   /* mid-screen X (sprite X is 0..255, +256 via VIC_SPRITES_X8) */
  uint8_t sy = 130;
  uint8_t pad, prev_pad = 0;

  // ── 1. Upload sprite data ──────────────────────────────────────────
  copy_sprite();

  // Sprite 0 pointer = $0800 / $40 = $20.
  SPRITE_POINTERS[0] = 0x20;

  // ── 2. Colors ──────────────────────────────────────────────────────
  POKE(VIC_BORDER, 0x06);   // blue border
  POKE(VIC_BG0,    0x00);   // black background
  POKE(VIC_SPR_COL(0), 0x01);  // sprite 0 = white

  // ── 3. Position + enable sprite 0 ──────────────────────────────────
  POKE(VIC_SPRITE_X(0), sx);
  POKE(VIC_SPRITE_Y(0), sy);
  POKE(VIC_SPR_ENA, 0x01);  // enable sprite 0 only

  // ── 4. Game loop — joystick 2 moves the sprite ─────────────────────
  for (;;) {
    wait_vblank();

    // Joystick 2 is wired through CIA1 port A (CIA1_PRA at $DC00).
    // Bits are active-LOW (pressed = 0). Invert and mask to test.
    pad = ~PEEK(CIA1_PRA) & 0x1F;

    if (pad & JOY_UP    && sy > 50)  sy--;
    if (pad & JOY_DOWN  && sy < 230) sy++;
    if (pad & JOY_LEFT  && sx > 24)  sx--;
    if (pad & JOY_RIGHT && sx < 250) sx++;

    POKE(VIC_SPRITE_X(0), sx);
    POKE(VIC_SPRITE_Y(0), sy);
    prev_pad = pad;
    (void)prev_pad;  // available if you want to edge-detect FIRE
  }
}

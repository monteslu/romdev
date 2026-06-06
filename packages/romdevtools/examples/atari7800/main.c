// ── Hello, Atari 7800 — MARIA bring-up + single sprite ──────────────
//
// Build: buildSource({ platform: "atari7800", source: <this file>,
//                      language: "c" })
//
// Sets up a minimal display list, paints the background blue and renders
// a 16-byte-wide sprite. Demonstrates the canonical MARIA boot sequence
// (DLL, DPP, CHARBASE, CTRL.DMA_ENABLE).
//
// cc65 NOTE: pointer-to-int casts aren't constant expressions, so the
// DLL + display-list addresses are patched in at runtime in main().

#include <stdint.h>

// MARIA register pointers ────────────────────────────────────────────
#define BACKGRND  (*(volatile uint8_t*)0x20)
#define P0C1      (*(volatile uint8_t*)0x21)
#define P0C2      (*(volatile uint8_t*)0x22)
#define P0C3      (*(volatile uint8_t*)0x23)
#define MSTAT     (*(volatile uint8_t*)0x28)
#define DPPH      (*(volatile uint8_t*)0x2C)
#define DPPL      (*(volatile uint8_t*)0x30)
#define CHARBASE  (*(volatile uint8_t*)0x34)
#define OFFSET    (*(volatile uint8_t*)0x38)
#define CTRL      (*(volatile uint8_t*)0x3C)

// Sprite pixel data (16 bytes wide × 8 rows).
static const uint8_t sprite_pixels[16 * 8] = {
  0,0,0,0,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0,0,0,0,
  0,0,0,0xAA,0xAA,0x55,0x55,0x55,0x55,0x55,0x55,0xAA,0xAA,0,0,0,
  0,0,0xAA,0x55,0x55,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x55,0x55,0xAA,0,0,
  0,0xAA,0x55,0x55,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x55,0x55,0xAA,0,
  0,0xAA,0x55,0x55,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x55,0x55,0xAA,0,
  0,0,0xAA,0x55,0x55,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x55,0x55,0xAA,0,0,
  0,0,0,0xAA,0xAA,0x55,0x55,0x55,0x55,0x55,0x55,0xAA,0xAA,0,0,0,
  0,0,0,0,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0,0,0,0,
};

// DL: 5-byte header pointing at sprite_pixels, then $00.
// We fill in the address bytes at runtime — cc65 won't evaluate
// (uintptr_t)&sprite_pixels at compile time for an initializer.
static uint8_t display_list[6] = {
  0,
  0x80 | 16,    // write+width
  0,
  0x00,         // palette + H pos hi
  80,           // X position
  0x00,         // end-of-DL
};

// DLL: one zone covering 184 scanlines + end marker.
static uint8_t dll[6] = {
  0x80 | 183,
  0,
  0,
  0, 0, 0,
};

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }
  while (!(MSTAT & 0x80)) { }
}

void main(void) {
  uint16_t dl_addr = (uint16_t)(uintptr_t)display_list;
  uint16_t dll_addr = (uint16_t)(uintptr_t)dll;
  uint16_t sp_addr = (uint16_t)(uintptr_t)sprite_pixels;

  display_list[0] = (uint8_t)(sp_addr & 0xFF);
  display_list[2] = (uint8_t)(sp_addr >> 8);

  dll[1] = (uint8_t)(dl_addr >> 8);
  dll[2] = (uint8_t)(dl_addr & 0xFF);

  BACKGRND = 0x88;
  P0C1 = 0x96;
  P0C2 = 0x0F;
  P0C3 = 0x46;
  CHARBASE = 0;
  OFFSET = 0;

  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);

  CTRL = 0x40;    // border off, DMA on

  for (;;) { vblank_wait(); }
}

// ── Hello, C64 — VIC-II direct hardware access demo ──────────────────
//
// Bypasses the KERNAL's printf path to show the platform's hardware
// directly: writes screen codes into screen RAM, sets per-cell colors
// in color RAM, and cycles the border color in a main loop.
//
// Build: build({ output: "rom",  platform: "c64", source: <this file>, language: "c" })

#include <stdint.h>

#define VIC_BORDER  (*(volatile uint8_t*)0xD020)
#define VIC_BG0     (*(volatile uint8_t*)0xD021)
#define SCREEN_RAM  ((volatile uint8_t*)0x0400)
#define COLOR_RAM   ((volatile uint8_t*)0xD800)

// PETSCII screen codes for "HELLO ROM-DEV-MCP" (uppercase character set,
// where 'A' = 0x01, 'B' = 0x02, ...). The space character is 0x20.
static const uint8_t MESSAGE[] = {
  0x08, 0x05, 0x0C, 0x0C, 0x0F,        // HELLO
  0x20,
  0x12, 0x0F, 0x0D,                    // ROM
  0x2D,                                // -
  0x04, 0x05, 0x16,                    // DEV
  0x2D,                                // -
  0x0D, 0x03, 0x10,                    // MCP
};
#define MESSAGE_LEN (sizeof(MESSAGE) / sizeof(MESSAGE[0]))

static void clear_screen(void) {
  uint16_t i;
  for (i = 0; i < 1000; i++) {
    SCREEN_RAM[i] = 0x20;             // space
    COLOR_RAM[i] = 14;                 // light blue
  }
}

static void draw_message(uint8_t row) {
  // Center on the row: row starts at offset row*40, center = +12.
  uint16_t base;
  uint8_t i;
  base = row * 40 + (40 - MESSAGE_LEN) / 2;
  for (i = 0; i < MESSAGE_LEN; i++) {
    SCREEN_RAM[base + i] = MESSAGE[i];
    COLOR_RAM[base + i]  = 1;          // white
  }
}

void main(void) {
  uint16_t frame;
  frame = 0;
  VIC_BORDER = 0;                      // black border
  VIC_BG0    = 6;                      // blue background

  clear_screen();
  draw_message(12);                    // middle of screen

  // Cycle the border color forever. Each iteration is ~1 raster line
  // worth of CPU; the visible cycle takes hundreds of frames.
  for (;;) {
    VIC_BORDER = (uint8_t)(frame >> 4) & 0x0F;
    frame++;
  }
}

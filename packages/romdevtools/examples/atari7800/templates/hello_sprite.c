/* hello_sprite.c — Atari 7800 single movable sprite + joystick.
 *
 * Extends default.c with joystick input: stick port A (SWCHA) drives
 * X/Y. Same MARIA pattern (1-scanline zones, 7-byte DLs, 243-entry
 * DLL — see default.c and MENTAL_MODEL.md for the full explanation
 * of why every detail matters).
 *
 * Horizontal movement: mutate the X byte in each row's DL.
 * Vertical movement: rebuild the DLL each frame so the 8 sprite-row
 * DLs land at different DLL indices.
 */
#include <stdint.h>
#include "atari7800_sfx.h"

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
#define SWCHA     (*(volatile uint8_t*)0x280)

/* SWCHA bit pattern (port A, active LOW — invert before testing) */
#define JOY_UP    0x80
#define JOY_DOWN  0x40
#define JOY_LEFT  0x20
#define JOY_RIGHT 0x10

/* 16-pixel-wide ball (= 4 bytes in 160A mode), 8 rows tall. */
static const uint8_t sprite_row0[4] = { 0x05, 0x55, 0x55, 0x50 };
static const uint8_t sprite_row1[4] = { 0x55, 0xAA, 0xAA, 0x55 };
static const uint8_t sprite_row2[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row3[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row4[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row5[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row6[4] = { 0x55, 0xAA, 0xAA, 0x55 };
static const uint8_t sprite_row7[4] = { 0x05, 0x55, 0x55, 0x50 };

/* 5-byte extended DL + terminator at byte 6 (next entry's mode). */
#define MK_DL(name) static uint8_t name[7] = { 0, 0x40, 0, 0x1C, 80, 0, 0 }
MK_DL(dl_row0); MK_DL(dl_row1); MK_DL(dl_row2); MK_DL(dl_row3);
MK_DL(dl_row4); MK_DL(dl_row5); MK_DL(dl_row6); MK_DL(dl_row7);

static uint8_t dl_empty[2] = { 0, 0 };

#define DLL_ZONES 243
static uint8_t dll[DLL_ZONES * 3];

static void set_dl_addr(uint8_t* dl, const uint8_t* row) {
  uint16_t a = (uint16_t)(uintptr_t)row;
  dl[0] = (uint8_t)(a & 0xFF);
  dl[2] = (uint8_t)(a >> 8);
}

static void set_dll_entry(int idx, uint16_t dl_ptr) {
  dll[idx * 3 + 0] = 0;
  dll[idx * 3 + 1] = (uint8_t)(dl_ptr >> 8);
  dll[idx * 3 + 2] = (uint8_t)(dl_ptr & 0xFF);
}

/* Build the DLL with the sprite's 8 rows placed at DLL index sprite_y. */
static void build_dll(uint8_t sprite_y) {
  uint16_t empty = (uint16_t)(uintptr_t)dl_empty;
  int i;
  for (i = 0; i < DLL_ZONES; i++) {
    uint16_t dl;
    int d = i - (int)sprite_y;
    switch (d) {
      case 0: dl = (uint16_t)(uintptr_t)dl_row0; break;
      case 1: dl = (uint16_t)(uintptr_t)dl_row1; break;
      case 2: dl = (uint16_t)(uintptr_t)dl_row2; break;
      case 3: dl = (uint16_t)(uintptr_t)dl_row3; break;
      case 4: dl = (uint16_t)(uintptr_t)dl_row4; break;
      case 5: dl = (uint16_t)(uintptr_t)dl_row5; break;
      case 6: dl = (uint16_t)(uintptr_t)dl_row6; break;
      case 7: dl = (uint16_t)(uintptr_t)dl_row7; break;
      default: dl = empty; break;
    }
    set_dll_entry(i, dl);
  }
}

static void set_x(uint8_t x) {
  dl_row0[4] = x; dl_row1[4] = x; dl_row2[4] = x; dl_row3[4] = x;
  dl_row4[4] = x; dl_row5[4] = x; dl_row6[4] = x; dl_row7[4] = x;
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }
  while (!(MSTAT & 0x80)) { }
}

void main(void) {
  uint16_t dll_addr;
  uint8_t x = 80;
  uint8_t y = 110;

  /* Wire each DL's address bytes to its sprite-row data. */
  set_dl_addr(dl_row0, sprite_row0);
  set_dl_addr(dl_row1, sprite_row1);
  set_dl_addr(dl_row2, sprite_row2);
  set_dl_addr(dl_row3, sprite_row3);
  set_dl_addr(dl_row4, sprite_row4);
  set_dl_addr(dl_row5, sprite_row5);
  set_dl_addr(dl_row6, sprite_row6);
  set_dl_addr(dl_row7, sprite_row7);

  set_x(x);
  build_dll(y);

  BACKGRND = 0x88;
  P0C1     = 0x46;
  P0C2     = 0x0F;
  P0C3     = 0x36;
  CHARBASE = 0;
  OFFSET   = 0;

  dll_addr = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);

  CTRL = 0x40;

  sfx_init();
  sfx_tone(0, 10, 12);

  for (;;) {
    uint8_t pad;
    vblank_wait();
    sfx_update();
    pad = ~SWCHA;
    if ((pad & JOY_LEFT)  && x > 4)        { x--; set_x(x); }
    if ((pad & JOY_RIGHT) && x < 152)      { x++; set_x(x); }
    if ((pad & JOY_UP)    && y > 12)       { y--; build_dll(y); }
    if ((pad & JOY_DOWN)  && y < DLL_ZONES - 9) { y++; build_dll(y); }
  }
}

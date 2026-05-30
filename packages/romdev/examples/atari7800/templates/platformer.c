/* platformer.c — Atari 7800 single-screen platformer scaffold.
 *
 * Subpixel gravity + jump physics + grounded check. Player is one
 * 16x8 sprite; ground is a fixed Y coordinate. Same MARIA pattern
 * as hello_sprite.c (per-scanline zones; see MENTAL_MODEL.md).
 *
 * Static platforms aren't included — extend by rebuilding the DLL
 * with sprite-row DLs at each platform's Y range.
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
#define INPT4     (*(volatile uint8_t*)0x0C)

#define JOY_UP    0x80
#define JOY_DOWN  0x40
#define JOY_LEFT  0x20
#define JOY_RIGHT 0x10

/* 16-pixel-wide (= 4 bytes in 160A), 8 rows tall player ball. */
static const uint8_t player_row0[4] = { 0x05, 0x55, 0x55, 0x50 };
static const uint8_t player_row1[4] = { 0x55, 0xAA, 0xAA, 0x55 };
static const uint8_t player_row2[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t player_row3[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t player_row4[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t player_row5[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t player_row6[4] = { 0x55, 0xAA, 0xAA, 0x55 };
static const uint8_t player_row7[4] = { 0x05, 0x55, 0x55, 0x50 };

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

static void build_dll(uint8_t y) {
  uint16_t empty = (uint16_t)(uintptr_t)dl_empty;
  int i;
  for (i = 0; i < DLL_ZONES; i++) {
    uint16_t dl;
    int d = i - (int)y;
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

/* Physics in 4.4 fixed point — 16 = 1 px, allows half-pixel velocity. */
#define GRAVITY    8
#define MOVE_PX    1
#define JUMP_VEL  (-48)
#define MAXFALL    48
#define GROUND_Y   200   /* DLL index of the ground line */

void main(void) {
  int16_t px = 80;
  int16_t py16 = (GROUND_Y - 8) << 4;
  int16_t vy = 0;
  uint8_t prev_btn = 0;
  uint16_t dll_addr;

  set_dl_addr(dl_row0, player_row0);
  set_dl_addr(dl_row1, player_row1);
  set_dl_addr(dl_row2, player_row2);
  set_dl_addr(dl_row3, player_row3);
  set_dl_addr(dl_row4, player_row4);
  set_dl_addr(dl_row5, player_row5);
  set_dl_addr(dl_row6, player_row6);
  set_dl_addr(dl_row7, player_row7);
  set_x((uint8_t)px);
  build_dll((uint8_t)(py16 >> 4));

  BACKGRND = 0x84;
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

  for (;;) {
    uint8_t pad, btn, grounded;
    int16_t py;
    vblank_wait();
    sfx_update();

    pad = ~SWCHA;
    if (pad & JOY_LEFT  && px > 4)         { px -= MOVE_PX; set_x((uint8_t)px); }
    if (pad & JOY_RIGHT && px < 152)       { px += MOVE_PX; set_x((uint8_t)px); }

    py = py16 >> 4;
    grounded = (py >= GROUND_Y - 8);
    btn = (INPT4 & 0x80) ? 0 : 1;
    if (btn && !prev_btn && grounded) { vy = JUMP_VEL; sfx_tone(0, 6, 6); }
    prev_btn = btn;

    vy += GRAVITY;
    if (vy > MAXFALL) vy = MAXFALL;
    if (grounded && vy > 0) { vy = 0; py16 = (GROUND_Y - 8) << 4; }
    else {
      py16 += vy;
      if (py16 < 0) py16 = 0;
      if ((py16 >> 4) > GROUND_Y - 8) py16 = (GROUND_Y - 8) << 4;
    }

    build_dll((uint8_t)(py16 >> 4));
  }
}

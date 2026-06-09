/* racing.c — Atari 7800 top-down racing (minimal).
 *
 * SCAFFOLD CAVEAT: the original "3-lane racer with 3 enemy cars" is
 * deferred. Multi-object scenes on 7800 require careful per-scanline
 * DL pool sizing within the 2 KB RAM1 budget (see sports.c for a 3-
 * object working example, MENTAL_MODEL.md for the MARIA constraints).
 *
 * This minimal scaffold demonstrates: player car (one 16x8 sprite)
 * that moves LEFT/RIGHT between 3 lanes. Extend by reading sports.c
 * for the per-scanline pool pattern and add 1-3 enemy cars within
 * the RAM budget.
 */
#include <stdint.h>
#include "atari7800_sfx.h"

#define BACKGRND  (*(volatile uint8_t*)0x20)
#define P0C1      (*(volatile uint8_t*)0x21)
#define P0C2      (*(volatile uint8_t*)0x22)
#define P0C3      (*(volatile uint8_t*)0x23)
#define P1C1      (*(volatile uint8_t*)0x25)
#define P2C1      (*(volatile uint8_t*)0x29)
#define MSTAT     (*(volatile uint8_t*)0x28)
#define DPPH      (*(volatile uint8_t*)0x2C)
#define DPPL      (*(volatile uint8_t*)0x30)
#define CHARBASE  (*(volatile uint8_t*)0x34)
#define OFFSET    (*(volatile uint8_t*)0x38)
#define CTRL      (*(volatile uint8_t*)0x3C)
#define SWCHA     (*(volatile uint8_t*)0x280)

/* SWCHA bit order is Right(0x80)/Left(0x40)/Down(0x20)/Up(0x10) — the
 * old 0x20/0x10 masks here were the DOWN/UP bits, so the stick's
 * vertical axis steered horizontally. */
#define JOY_LEFT  0x40
#define JOY_RIGHT 0x80

/* 16-pixel-wide (= 4 bytes in 160A) × 8 row car sprite. */
static const uint8_t car_row0[4] = { 0x05, 0x55, 0x55, 0x50 };
static const uint8_t car_row1[4] = { 0x5A, 0x5A, 0xA5, 0xA5 };
static const uint8_t car_row2[4] = { 0xAA, 0xFF, 0xFF, 0xAA };
static const uint8_t car_row3[4] = { 0xAA, 0xFF, 0xFF, 0xAA };
static const uint8_t car_row4[4] = { 0xAA, 0xFF, 0xFF, 0xAA };
static const uint8_t car_row5[4] = { 0xAA, 0xFF, 0xFF, 0xAA };
static const uint8_t car_row6[4] = { 0x5A, 0x5A, 0xA5, 0xA5 };
static const uint8_t car_row7[4] = { 0x05, 0x55, 0x55, 0x50 };

#define MK_DL(name) static uint8_t name[7] = { 0, 0x40, 0, 0x1C, 80, 0, 0 }
MK_DL(dl_row0); MK_DL(dl_row1); MK_DL(dl_row2); MK_DL(dl_row3);
MK_DL(dl_row4); MK_DL(dl_row5); MK_DL(dl_row6); MK_DL(dl_row7);

static uint8_t dl_empty[2] = { 0, 0 };

/* ── Background road ──────────────────────────────────────────────
 * Without a full-screen drawable the display list emits only the car
 * and ~99% of the screen stays the flat BACKGRND colour (reads as
 * "blank"). Each road zone draws three full-width segments: grass on
 * the left (palette 1), the grey road down the centre (palette 2),
 * grass on the right (palette 1). Width = byte[3] low 5 bits (32-n);
 * high 3 bits = palette. */
static const uint8_t band_pix[16] = {
  0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,
  0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55
};
/* 8 bytes (32 px) grass @ x0, 16 bytes (64 px) road @ x32,
 * 8 bytes (32 px) grass @ x96, terminator. */
static uint8_t dl_road[16] = {
  0, 0x40, 0, (1 << 5) | 24, 0,
  0, 0x40, 0, (2 << 5) | 16, 32,
  0, 0x40, 0, (1 << 5) | 24, 96,
  0
};

static void set_road_addr(void) {
  uint16_t a = (uint16_t)(uintptr_t)band_pix;
  dl_road[0]  = dl_road[5]  = dl_road[10] = (uint8_t)(a & 0xFF);
  dl_road[2]  = dl_road[7]  = dl_road[12] = (uint8_t)(a >> 8);
}

static uint16_t bg_zone_dl(int zone) {
  if (zone >= 16 && zone < 220) return (uint16_t)(uintptr_t)dl_road;
  return (uint16_t)(uintptr_t)dl_empty;
}

#define DLL_ZONES 243
static uint8_t dll[DLL_ZONES * 3];

#define PLAYER_Y 170
#define LANES    3
static int lane;

static const uint8_t lane_xs[LANES] = { 40, 80, 120 };

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

static void set_x(uint8_t x) {
  dl_row0[4] = x; dl_row1[4] = x; dl_row2[4] = x; dl_row3[4] = x;
  dl_row4[4] = x; dl_row5[4] = x; dl_row6[4] = x; dl_row7[4] = x;
}

static void build_dll(void) {
  int i;
  for (i = 0; i < DLL_ZONES; i++) {
    uint16_t dl;
    int d = i - PLAYER_Y;
    switch (d) {
      case 0: dl = (uint16_t)(uintptr_t)dl_row0; break;
      case 1: dl = (uint16_t)(uintptr_t)dl_row1; break;
      case 2: dl = (uint16_t)(uintptr_t)dl_row2; break;
      case 3: dl = (uint16_t)(uintptr_t)dl_row3; break;
      case 4: dl = (uint16_t)(uintptr_t)dl_row4; break;
      case 5: dl = (uint16_t)(uintptr_t)dl_row5; break;
      case 6: dl = (uint16_t)(uintptr_t)dl_row6; break;
      case 7: dl = (uint16_t)(uintptr_t)dl_row7; break;
      default: dl = bg_zone_dl(i); break;
    }
    set_dll_entry(i, dl);
  }
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }
  while (!(MSTAT & 0x80)) { }
}

void main(void) {
  uint16_t dll_addr;
  uint8_t prev_pad = 0;

  set_dl_addr(dl_row0, car_row0);
  set_dl_addr(dl_row1, car_row1);
  set_dl_addr(dl_row2, car_row2);
  set_dl_addr(dl_row3, car_row3);
  set_dl_addr(dl_row4, car_row4);
  set_dl_addr(dl_row5, car_row5);
  set_dl_addr(dl_row6, car_row6);
  set_dl_addr(dl_row7, car_row7);

  lane = 1;
  set_road_addr();
  set_x(lane_xs[lane]);
  build_dll();

  BACKGRND = 0x88;   /* sky/horizon */
  P0C1     = 0x46;   /* car */
  P0C2     = 0x0F;
  P0C3     = 0x36;
  P1C1     = 0xC8;   /* roadside grass (green) */
  P2C1     = 0x06;   /* road surface (grey) */
  CHARBASE = 0;
  OFFSET   = 0;

  dll_addr = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);
  CTRL = 0x40;
  sfx_init();

  for (;;) {
    uint8_t pad;
    vblank_wait();
    sfx_update();

    pad = ~SWCHA;
    if ((pad & JOY_LEFT)  && !(prev_pad & JOY_LEFT)  && lane > 0)         { lane--; set_x(lane_xs[lane]); sfx_tone(0, 6, 4); }
    if ((pad & JOY_RIGHT) && !(prev_pad & JOY_RIGHT) && lane < LANES - 1) { lane++; set_x(lane_xs[lane]); sfx_tone(0, 6, 4); }
    prev_pad = pad;
  }
}

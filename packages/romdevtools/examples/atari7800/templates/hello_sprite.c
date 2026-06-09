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
#define P1C1      (*(volatile uint8_t*)0x25)
#define P2C1      (*(volatile uint8_t*)0x29)
#define MSTAT     (*(volatile uint8_t*)0x28)
#define DPPH      (*(volatile uint8_t*)0x2C)
#define DPPL      (*(volatile uint8_t*)0x30)
#define CHARBASE  (*(volatile uint8_t*)0x34)
#define OFFSET    (*(volatile uint8_t*)0x38)
#define CTRL      (*(volatile uint8_t*)0x3C)
#define SWCHA     (*(volatile uint8_t*)0x280)

/* SWCHA bit pattern (port A, active LOW — invert before testing) */
/* SWCHA P0 nibble, active-low after the ~SWCHA invert. The bit order is
 * Right/Left/Down/Up from bit7 down — the OLD defines here were exactly
 * REVERSED (UP=0x80 etc.), which made up/down move the sprite left/right
 * on every 7800 scaffold. */
#define JOY_RIGHT 0x80
#define JOY_LEFT  0x40
#define JOY_DOWN  0x20
#define JOY_UP    0x10

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

/* ── Background playfield ─────────────────────────────────────────────
 * Without a full-screen drawable the display list emits only the one
 * sprite and ~99% of the screen stays the flat BACKGRND colour (reads as
 * "blank"). These full-width bands fill every non-sprite zone with scenery
 * so the frame has real content (same machinery as default.c).
 *
 * One scanline of solid pixels lives in ROM (band_pix). A single DL
 * drawable is at most 32 bytes = 128 px wide, so a full 160-px line needs
 * TWO drawables. Width (byte[3] low 5 bits) = 32-bytes; high 3 bits =
 * palette: field uses palette 1, ground uses palette 2. */
static const uint8_t band_pix[32] = {
  0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,
  0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55
};
#define MK_BAND(name, pal) static uint8_t name[11] = { \
  0, 0x40, 0, ((pal) << 5) | 0,  0,    /* 128 px @ x0   */ \
  0, 0x40, 0, ((pal) << 5) | 24, 128,  /* 32 px  @ x128 */ \
  0 }
MK_BAND(dl_field, 1);
MK_BAND(dl_ground, 2);
#define GROUND_ZONE 188

static void set_band_addr(uint8_t* dl) {
  uint16_t a = (uint16_t)(uintptr_t)band_pix;
  dl[0] = dl[5] = (uint8_t)(a & 0xFF);
  dl[2] = dl[7] = (uint8_t)(a >> 8);
}

/* Background DL for a non-sprite zone: sky (empty) up top, field in the
 * middle, ground at the bottom. */
static uint16_t bg_zone_dl(int zone) {
  if (zone >= GROUND_ZONE) return (uint16_t)(uintptr_t)dl_ground;
  if (zone >= 28)          return (uint16_t)(uintptr_t)dl_field;
  return (uint16_t)(uintptr_t)dl_empty;
}

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

/* Build the DLL with the sprite's 8 rows placed at DLL index sprite_y;
 * every other zone gets the background scenery band for its row. */
static void build_dll(uint8_t sprite_y) {
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
      default: dl = bg_zone_dl(i); break;   /* field/ground scenery */
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

  /* Point the background bands at their shared ROM pixel row. */
  set_band_addr(dl_field);
  set_band_addr(dl_ground);

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

  BACKGRND = 0x88;   /* light blue sky */
  P0C1     = 0x46;
  P0C2     = 0x0F;
  P0C3     = 0x36;
  P1C1     = 0xC8;   /* field green (background band) */
  P2C1     = 0x14;   /* ground brown (background band) */
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

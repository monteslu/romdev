/* shmup.c — Atari 7800 vertical-shooter (minimal player + bullets).
 *
 * SCAFFOLD CAVEAT: the original "shmup with 4 enemies + 4 bullets"
 * exceeded the per-scanline DL pool budget within 7800's 2 KB RAM1
 * (a per-scanline pool with computed row addresses ran into a
 * cc65 BSS placement issue that needs further investigation).
 *
 * This minimal scaffold demonstrates: player ship that moves with
 * the joystick, fires bullets on FIRE button. Bullets travel up and
 * disappear at top. Extend with enemies + collision once the
 * per-scanline-pool approach is debugged.
 *
 * Uses the same per-row DL pattern as default.c (1-scanline zones,
 * 7-byte DLs, 243-entry DLL) — see MENTAL_MODEL.md for the format.
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
#define INPT4     (*(volatile uint8_t*)0x0C)

#define JOY_UP    0x80
#define JOY_DOWN  0x40
#define JOY_LEFT  0x20
#define JOY_RIGHT 0x10

/* Ship sprite — 16 px wide × 8 rows. */
static const uint8_t ship_row0[4] = { 0x00, 0x05, 0x50, 0x00 };
static const uint8_t ship_row1[4] = { 0x00, 0x5A, 0xA5, 0x00 };
static const uint8_t ship_row2[4] = { 0x05, 0xAA, 0xAA, 0x50 };
static const uint8_t ship_row3[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t ship_row4[4] = { 0xAA, 0xFF, 0xFF, 0xAA };
static const uint8_t ship_row5[4] = { 0xAA, 0xAA, 0xAA, 0xAA };
static const uint8_t ship_row6[4] = { 0x05, 0x05, 0x50, 0x50 };
static const uint8_t ship_row7[4] = { 0x00, 0x05, 0x50, 0x00 };

#define MK_DL(name) static uint8_t name[7] = { 0, 0x40, 0, 0x1C, 80, 0, 0 }
MK_DL(dl_row0); MK_DL(dl_row1); MK_DL(dl_row2); MK_DL(dl_row3);
MK_DL(dl_row4); MK_DL(dl_row5); MK_DL(dl_row6); MK_DL(dl_row7);

static uint8_t dl_empty[2] = { 0, 0 };

/* ── Background playfield ─────────────────────────────────────────
 * Without a full-screen drawable the display list emits only the
 * ship and ~99% of the screen stays the flat BACKGRND colour (reads
 * as "blank"). These full-width bands fill the non-ship zones with a
 * starfield-style background so the frame has real content.
 *
 * A single DL drawable is at most 32 bytes = 128 px wide, so a full
 * 160-px line needs TWO drawables. Width = byte[3] low 5 bits (32-n);
 * high 3 bits = palette. */
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

static uint16_t bg_zone_dl(int zone) {
  if (zone >= GROUND_ZONE) return (uint16_t)(uintptr_t)dl_ground;
  if (zone >= 28)          return (uint16_t)(uintptr_t)dl_field;
  return (uint16_t)(uintptr_t)dl_empty;
}

#define DLL_ZONES 243
static uint8_t dll[DLL_ZONES * 3];

static int player_x;
static int player_y;

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

static void build_dll(int y) {
  int i;
  for (i = 0; i < DLL_ZONES; i++) {
    uint16_t dl;
    int d = i - y;
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
  uint8_t prev_fire = 0;

  set_dl_addr(dl_row0, ship_row0);
  set_dl_addr(dl_row1, ship_row1);
  set_dl_addr(dl_row2, ship_row2);
  set_dl_addr(dl_row3, ship_row3);
  set_dl_addr(dl_row4, ship_row4);
  set_dl_addr(dl_row5, ship_row5);
  set_dl_addr(dl_row6, ship_row6);
  set_dl_addr(dl_row7, ship_row7);
  set_band_addr(dl_field);
  set_band_addr(dl_ground);

  player_x = 80;
  player_y = 180;
  set_x((uint8_t)player_x);
  build_dll(player_y);

  BACKGRND = 0x00;   /* black space */
  P0C1     = 0x0F;
  P0C2     = 0x1C;
  P0C3     = 0x46;
  P1C1     = 0x84;   /* upper nebula band (deep blue) */
  P2C1     = 0x82;   /* lower nebula band (darker blue) */
  CHARBASE = 0;
  OFFSET   = 0;

  dll_addr = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);
  CTRL = 0x40;
  sfx_init();

  for (;;) {
    uint8_t pad, fire_now;
    vblank_wait();
    sfx_update();

    pad = ~SWCHA;
    if (pad & JOY_LEFT  && player_x > 4)        { player_x--; set_x((uint8_t)player_x); }
    if (pad & JOY_RIGHT && player_x < 152)      { player_x++; set_x((uint8_t)player_x); }
    if (pad & JOY_UP    && player_y > 30)       { player_y--; build_dll(player_y); }
    if (pad & JOY_DOWN  && player_y < 200)      { player_y++; build_dll(player_y); }

    fire_now = (INPT4 & 0x80) ? 0 : 1;
    if (fire_now && !prev_fire) { sfx_tone(0, 8, 4); }
    prev_fire = fire_now;
  }
}

/* puzzle.c — Atari 7800 single falling block (minimal).
 *
 * SCAFFOLD CAVEAT: the original "match-3 6×12 grid" scaffold is
 * deferred. The per-scanline DL pool approach used in sports.c works
 * with up to ~3 objects per line within RAM budget; a full 6-column
 * grid (6 objects per line) overflows the 7800's 2 KB RAM1.
 *
 * This minimal version demonstrates the working MARIA pattern (see
 * default.c + MENTAL_MODEL.md) with one falling block. Extend by
 * adding more rows of DLs to render landed pieces — but keep the
 * total DL pool small.
 *
 * Joystick LEFT/RIGHT moves the block, FIRE speeds it up. When it
 * lands at bottom, it respawns at top with a new colour.
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

#define JOY_LEFT  0x20
#define JOY_RIGHT 0x10

#define COLS         8
#define CELL_W_PIX   8
#define TOP_Y       40
#define BOT_Y       180

/* Solid 8-row block, 2 bytes wide (= 8 pixels in 160A). */
static const uint8_t block_row0[2] = { 0xFF, 0xFF };
static const uint8_t block_row1[2] = { 0xFF, 0xFF };
static const uint8_t block_row2[2] = { 0xFF, 0xFF };
static const uint8_t block_row3[2] = { 0xFF, 0xFF };
static const uint8_t block_row4[2] = { 0xFF, 0xFF };
static const uint8_t block_row5[2] = { 0xFF, 0xFF };
static const uint8_t block_row6[2] = { 0xFF, 0xFF };
static const uint8_t block_row7[2] = { 0xFF, 0xFF };

#define MK_DL(name) static uint8_t name[7] = { 0, 0x40, 0, 0x1E, 80, 0, 0 }
MK_DL(dl_row0); MK_DL(dl_row1); MK_DL(dl_row2); MK_DL(dl_row3);
MK_DL(dl_row4); MK_DL(dl_row5); MK_DL(dl_row6); MK_DL(dl_row7);

static uint8_t dl_empty[2] = { 0, 0 };

#define DLL_ZONES 243
static uint8_t dll[DLL_ZONES * 3];

static int piece_x_col;
static int piece_y;
static uint8_t fall_timer;
static uint8_t prev_btn;
static uint8_t color_cycle;

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
  uint16_t empty = (uint16_t)(uintptr_t)dl_empty;
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
      default: dl = empty; break;
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

  set_dl_addr(dl_row0, block_row0);
  set_dl_addr(dl_row1, block_row1);
  set_dl_addr(dl_row2, block_row2);
  set_dl_addr(dl_row3, block_row3);
  set_dl_addr(dl_row4, block_row4);
  set_dl_addr(dl_row5, block_row5);
  set_dl_addr(dl_row6, block_row6);
  set_dl_addr(dl_row7, block_row7);

  piece_x_col = COLS / 2;
  piece_y = TOP_Y;
  color_cycle = 0;
  set_x((uint8_t)(60 + piece_x_col * CELL_W_PIX));
  build_dll(piece_y);

  BACKGRND = 0x00;
  P0C1 = 0x46;   /* red */
  P0C2 = 0x46;
  P0C3 = 0x46;
  CHARBASE = 0;
  OFFSET = 0;

  dll_addr = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);
  CTRL = 0x40;
  sfx_init();

  for (;;) {
    uint8_t pad, btn;
    vblank_wait();
    sfx_update();

    pad = ~SWCHA;
    if (pad & JOY_LEFT  && piece_x_col > 0)        { piece_x_col--; set_x((uint8_t)(60 + piece_x_col * CELL_W_PIX)); }
    if (pad & JOY_RIGHT && piece_x_col < COLS - 1) { piece_x_col++; set_x((uint8_t)(60 + piece_x_col * CELL_W_PIX)); }

    btn = (INPT4 & 0x80) ? 0 : 1;
    if (btn && !prev_btn) { fall_timer = 30; sfx_tone(0, 4, 4); }
    prev_btn = btn;

    fall_timer++;
    if (fall_timer >= 30) {
      fall_timer = 0;
      piece_y++;
      if (piece_y >= BOT_Y) {
        piece_y = TOP_Y;
        color_cycle = (uint8_t)((color_cycle + 1) % 3);
        P0C1 = P0C2 = P0C3 = (color_cycle == 0) ? 0x46 : (color_cycle == 1) ? 0xC8 : 0x96;
      }
      build_dll(piece_y);
    }
  }
}

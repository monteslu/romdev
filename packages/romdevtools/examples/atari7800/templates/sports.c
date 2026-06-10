/* sports.c — Atari 7800 two-player Pong scaffold.
 *
 * 2P Pong via both 7800 joystick ports. SWCHA packs P1 in bits 4-7,
 * P2 in bits 0-3 (active-low). AI on P2 when no second pad held.
 *
 * MARIA pipeline: per-scanline DLs. For every scanline in the play
 * area, walk every object (P1 paddle, P2 paddle, ball), check if
 * the object's Y range intersects this scanline, and if so emit a
 * 5-byte DL header pointing at the correct row of the object's
 * sprite data. Each scanline DL has space for up to MAX_OBJS
 * objects + a terminator byte.
 *
 * See MENTAL_MODEL.md for the DL/DLL byte-level format. The
 * per-scanline-zone pattern in default.c is the foundation; this
 * scales it to multiple objects with independent Y positions.
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
 * old 0x80/0x40 masks were the RIGHT/LEFT bits, so the stick's
 * horizontal axis moved the paddle vertically.
 * Port 2 (low nibble) repeats the SAME order from bit 3 down:
 * Right(0x08)/Left(0x04)/Down(0x02)/Up(0x01) — the previous 0x08/0x04
 * masks here were P2's RIGHT/LEFT bits (verified bit-by-bit against
 * prosystem 2026-06), so player 2's paddle ignored the vertical axis. */
#define P1_UP    0x10
#define P1_DOWN  0x20
#define P2_UP    0x01
#define P2_DOWN  0x02

#define PADDLE_W_BYTES  1     /* 1 byte = 4 px wide in 160A */
#define PADDLE_H       16
#define BALL_H          4
#define PADDLE_X1      16
#define PADDLE_X2     140
#define PLAY_LINES    100
#define COURT_TOP      60     /* DLL index */
#define COURT_BOT     (COURT_TOP + PLAY_LINES)

/* Sprite rows. 0x55 = all 4 pixels = palette index 1 (lit). */
static const uint8_t solid_row[1] = { 0x55 };

/* Scanline DL pool — one DL per scanline in the play area. Each DL
 * has slots for up to 3 objects (5 bytes each) + 2 terminator bytes
 * (1 for the "next entry's mode = 0", 1 for safety). */
/* Per-line DL capacity: paddles+ball never share a scanline since
 * they're horizontally separated, so MAX_OBJS=3 fits with margin.
 * 17 bytes/line × 100 court lines = 1700 B + 729 B DLL = 2429 B —
 * out of the 7800's 2 KB RAM1, doesn't fit. Use 100 lines × 12B
 * (MAX=2) = 1200 B + 729 = 1929 B. Fits within 2112 B RAM1. */
#define MAX_OBJS_PER_LINE  2
#define DL_BYTES_PER_LINE  (5 * MAX_OBJS_PER_LINE + 2)
static uint8_t scanline_dls[PLAY_LINES * DL_BYTES_PER_LINE];

static uint8_t dl_empty[2] = { 0, 0 };

/* ── Court border bands ───────────────────────────────────────────
 * The court itself (per-scanline DLs below) only draws two thin
 * paddles + a ball, so on a black screen ~99% of the frame is blank.
 * Fill the zones above and below the court with full-width bands so
 * the court is framed by visible walls. A single DL drawable is at
 * most 32 bytes = 128 px wide, so a full 160-px line needs TWO
 * drawables. Width = byte[3] low 5 bits (32-n); high 3 bits = palette. */
static const uint8_t band_pix[32] = {
  0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,
  0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55
};
#define MK_BAND(name, pal) static uint8_t name[11] = { \
  0, 0x40, 0, ((pal) << 5) | 0,  0,    /* 128 px @ x0   */ \
  0, 0x40, 0, ((pal) << 5) | 24, 128,  /* 32 px  @ x128 */ \
  0 }
MK_BAND(dl_wall, 1);

static void set_band_addr(uint8_t* dl) {
  uint16_t a = (uint16_t)(uintptr_t)band_pix;
  dl[0] = dl[5] = (uint8_t)(a & 0xFF);
  dl[2] = dl[7] = (uint8_t)(a >> 8);
}

#define DLL_ZONES 243
static uint8_t dll[DLL_ZONES * 3];

static int16_t p1y, p2y, by;
static int16_t bx;
static int8_t bdx, bdy;

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }
  while (!(MSTAT & 0x80)) { }
}

static void set_dll_entry(int idx, uint16_t dl_ptr) {
  dll[idx * 3 + 0] = 0;
  dll[idx * 3 + 1] = (uint8_t)(dl_ptr >> 8);
  dll[idx * 3 + 2] = (uint8_t)(dl_ptr & 0xFF);
}

/* Write a 5-byte DL entry for one object at the given byte offset
 * within a scanline DL. Returns the new offset. */
static uint8_t emit_obj(uint8_t* dl, uint8_t off, uint16_t data_addr,
                        uint8_t width_bytes, uint8_t palette, uint8_t x) {
  dl[off + 0] = (uint8_t)(data_addr & 0xFF);
  dl[off + 1] = 0x40;                          /* extended 5-byte form */
  dl[off + 2] = (uint8_t)(data_addr >> 8);
  dl[off + 3] = (uint8_t)((palette << 5) | ((32 - width_bytes) & 0x1F));
  dl[off + 4] = x;
  return off + 5;
}

/* Rebuild ALL scanline DLs + DLL based on current object positions. */
static void rebuild(void) {
  uint16_t wall = (uint16_t)(uintptr_t)dl_wall;
  uint16_t empty = (uint16_t)(uintptr_t)dl_empty;
  uint16_t solid = (uint16_t)(uintptr_t)solid_row;
  int line;
  int i;

  /* DLL: point each play-area line at its scanline DL slot; frame the
   * court with full-width wall bands above and below, leaving a thin
   * empty gutter right at the court edges. */
  for (i = 0; i < DLL_ZONES; i++) {
    if (i >= COURT_TOP && i < COURT_BOT) {
      uint16_t dlp = (uint16_t)(uintptr_t)&scanline_dls[(i - COURT_TOP) * DL_BYTES_PER_LINE];
      set_dll_entry(i, dlp);
    } else if (i >= COURT_TOP - 8 && i < COURT_BOT + 8) {
      set_dll_entry(i, empty);   /* small gutter around the court */
    } else {
      set_dll_entry(i, wall);
    }
  }

  /* Scanline DLs: for each play-area scanline, walk objects, emit
   * entries for those whose Y range intersects. */
  for (line = 0; line < PLAY_LINES; line++) {
    int abs_y = COURT_TOP + line;
    uint8_t* dlp = &scanline_dls[line * DL_BYTES_PER_LINE];
    uint8_t off = 0;
    int i2;
    /* Zero the slot so leftover bytes don't form garbage entries. */
    for (i2 = 0; i2 < DL_BYTES_PER_LINE; i2++) dlp[i2] = 0;

    /* P1 paddle */
    if (abs_y >= p1y && abs_y < p1y + PADDLE_H) {
      off = emit_obj(dlp, off, solid, PADDLE_W_BYTES, 0, PADDLE_X1);
    }
    /* P2 paddle */
    if (abs_y >= p2y && abs_y < p2y + PADDLE_H) {
      off = emit_obj(dlp, off, solid, PADDLE_W_BYTES, 0, PADDLE_X2);
    }
    /* Ball */
    if (abs_y >= by && abs_y < by + BALL_H) {
      off = emit_obj(dlp, off, solid, PADDLE_W_BYTES, 0, (uint8_t)bx);
    }
    /* off points to the byte AFTER the last entry — already 0 from
     * memset above, which serves as the mode terminator. */
    (void)off;
  }
}

static void serve_ball(uint8_t to_left) {
  bx = 76;
  by = 120;
  bdx = to_left ? -2 : 2;
  bdy = 2;             /* was 1 — the rally felt 'very slow' */
}

void main(void) {
  uint16_t dll_addr;
  uint8_t pad;
  int16_t target;

  p1y = 110; p2y = 110;
  serve_ball(0);

  /* MARIA color byte = (hue<<4)|lum. Court = dark green so the play area
   * reads as an actual field (0x00 black looked like a blank/dead screen);
   * walls = blue. NB: 0x48 is hue 4 = RED-magenta (renders PINK), not blue —
   * blue is hue 8/9, so the walls use 0x8A. */
  BACKGRND = 0xB4;   /* dark green court floor (hue 11) */
  P0C1     = 0x0F;   /* white paddles + ball */
  P0C2     = 0x0F;
  P0C3     = 0x0F;
  P1C1     = 0x8A;   /* court walls — BLUE (hue 8); was 0x48 = pink */
  CHARBASE = 0;
  OFFSET   = 0;

  set_band_addr(dl_wall);
  rebuild();

  dll_addr = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);
  CTRL = 0x40;
  sfx_init();

  for (;;) {
    vblank_wait();
    sfx_update();

    pad = (uint8_t)(~SWCHA);
    if ((pad & P1_UP)   && p1y > COURT_TOP)            p1y -= 2;
    if ((pad & P1_DOWN) && p1y < COURT_BOT - PADDLE_H) p1y += 2;

    if (pad & (P2_UP | P2_DOWN)) {
      if ((pad & P2_UP)   && p2y > COURT_TOP)            p2y -= 2;
      if ((pad & P2_DOWN) && p2y < COURT_BOT - PADDLE_H) p2y += 2;
    } else {
      target = by - PADDLE_H / 2;
      if (p2y < target && p2y < COURT_BOT - PADDLE_H) p2y += 1;
      else if (p2y > target && p2y > COURT_TOP)       p2y -= 1;
    }

    bx = bx + bdx;
    by = by + bdy;

    if (by < COURT_TOP)             { by = COURT_TOP; bdy = -bdy; }
    if (by + BALL_H > COURT_BOT)    { by = COURT_BOT - BALL_H; bdy = -bdy; }

    /* Paddle collisions */
    if (bdx < 0 && bx <= PADDLE_X1 + 4 && bx >= PADDLE_X1
        && by + BALL_H > p1y && by < p1y + PADDLE_H) {
      bdx = -bdx; bx = PADDLE_X1 + 4;
    }
    if (bdx > 0 && bx + 4 >= PADDLE_X2 && bx <= PADDLE_X2 + 4
        && by + BALL_H > p2y && by < p2y + PADDLE_H) {
      bdx = -bdx; bx = PADDLE_X2 - 4;
    }
    if (bx < 4 || bx > 152) {
      serve_ball(bx > 80 ? 1 : 0);
    }

    rebuild();
  }
}

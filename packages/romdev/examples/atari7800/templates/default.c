/* default.c — Atari 7800 MARIA single-sprite minimal demo.
 *
 * Renders ONE sprite (16 pixels wide × 8 scanlines tall) at (X=80,
 * Y=110) on a solid blue background. Plays a boot chime on the TIA.
 * Smallest known-working 7800 boot.
 *
 * ── MARIA hierarchy ──────────────────────────────────────────────
 *
 * The 7800 has no tilemap. Each frame, MARIA:
 *
 *   DPP register → DLL (one entry per zone)
 *                     → DL (one entry per object in that zone)
 *                          → raw pixel bytes
 *
 * You build the DL and DLL; MARIA walks them and writes a line buffer
 * that becomes the framebuffer. See MENTAL_MODEL.md for the full
 * register / mode-byte reference.
 *
 * ── Why this scaffold is structured the way it is ────────────────
 *
 * MARIA's per-scanline addressing has a quirk: within a multi-line
 * zone, sprite row N is read from `ADDR + (zone_height - 1 - N) * 256`.
 * That forces page-aligned per-row layouts (8 separate 256-byte
 * pages for an 8-row sprite) UNLESS you side-step the quirk.
 *
 * This scaffold side-steps it: every zone is ONE scanline tall
 * (offset=0), and we have 8 separate DL entries (one per row of the
 * sprite). Each DL points at one row of contiguous pixel data. No
 * page-alignment dance.
 *
 * Tradeoff: the DLL needs ONE entry per visible scanline, plus the
 * 10 lines of top overscan that MARIA walks before the visible area
 * starts. That's 243 entries × 3 bytes = 729 bytes — fits easily in
 * the 4KB of internal RAM.
 *
 * ── Build ───────────────────────────────────────────────────────
 *   buildSource({ platform: "atari7800", sources: { "main.c": ... } })
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

/* Sprite rows. In 160A mode (the default), 1 byte = 4 pixels of
 * 2-bit colour. So 4 bytes per row = 16 pixels wide. Each 2-bit
 * value selects: 00=backdrop, 01=P0C1, 10=P0C2, 11=P0C3.
 *
 * Pattern below = an 8x16 ball (orange-and-white). */
static const uint8_t sprite_row0[4] = { 0x05, 0x55, 0x55, 0x50 };
static const uint8_t sprite_row1[4] = { 0x55, 0xAA, 0xAA, 0x55 };
static const uint8_t sprite_row2[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row3[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row4[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row5[4] = { 0x5A, 0xFF, 0xFF, 0xA5 };
static const uint8_t sprite_row6[4] = { 0x55, 0xAA, 0xAA, 0x55 };
static const uint8_t sprite_row7[4] = { 0x05, 0x55, 0x55, 0x50 };

/* DL for ONE sprite scanline. 5-byte (extended) form:
 *   [0] = ADDR LSB                  (patched at runtime)
 *   [1] = mode = 0x40 — extended form (bits 0-4 = 0) + bit 6 set so
 *         MARIA's parse-loop continues. bit 7 unset = "write mode 0"
 *         (4-pixels-per-byte, 160A graphics). bit 5 unset = direct.
 *   [2] = ADDR MSB                  (patched at runtime)
 *   [3] = palette(3) | width-encoding(5). Palette 0 (bits 5-7 = 0) +
 *         width 4 bytes encoded as (32-4) = 0x1C in bits 0-4.
 *         Final byte = 0x1C.
 *   [4] = X position (in MARIA cell units; visible range ~0..159).
 *
 * After the 5-byte entry, MARIA reads `dp + 6` as the next entry's
 * mode byte. So we need byte 6 to be 0 (terminator). Total: 7 bytes.
 *
 * A previous version of this scaffold used a 6-byte array — MARIA
 * then read random memory at offset 6 as the next "mode" byte and
 * walked off into garbage. If you change this size, update the
 * terminator slot accordingly.
 */
#define MK_DL(name) static uint8_t name[7] = { 0, 0x40, 0, 0x1C, 80, 0, 0 }
MK_DL(dl_row0); MK_DL(dl_row1); MK_DL(dl_row2); MK_DL(dl_row3);
MK_DL(dl_row4); MK_DL(dl_row5); MK_DL(dl_row6); MK_DL(dl_row7);

/* Empty DL — for zones with no objects. MARIA reads the mode byte
 * at dp+1; if it's 0, the parse loop exits immediately. */
static uint8_t dl_empty[2] = { 0, 0 };

/* DLL: one entry per visible scanline + the 10-line top overscan
 * MARIA walks BEFORE the visible area begins. NTSC display area =
 * scanlines 16..258 = 243 lines.
 *
 * Per entry (3 bytes):
 *   byte 0: DLI(bit 7) | H16(bit 6) | H8(bit 5) | offset(bits 0-3)
 *           offset = (lines_in_zone - 1), max 15.
 *   byte 1: DL pointer HIGH
 *   byte 2: DL pointer LOW
 *
 * MARIA has NO DLL terminator — it just walks for every scanline.
 * If your DLL is shorter than 243 entries, MARIA reads past the
 * end into random memory and renders garbage. Always cover the
 * full 243 lines.
 */
#define DLL_ZONES 243
static uint8_t dll[DLL_ZONES * 3];

#define SPRITE_Y 110  /* DLL index — ~middle of the visible area */

static void set_dl_addr(uint8_t* dl, const uint8_t* row) {
  uint16_t a = (uint16_t)(uintptr_t)row;
  dl[0] = (uint8_t)(a & 0xFF);
  dl[2] = (uint8_t)(a >> 8);
}

static void set_dll_entry(int idx, uint16_t dl_ptr) {
  dll[idx * 3 + 0] = 0;                          /* offset=0, no DLI/holey */
  dll[idx * 3 + 1] = (uint8_t)(dl_ptr >> 8);     /* HIGH */
  dll[idx * 3 + 2] = (uint8_t)(dl_ptr & 0xFF);   /* LOW */
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }       /* if already in vblank, wait for it to end */
  while (!(MSTAT & 0x80)) { }    /* then wait for next vblank to start */
}

void main(void) {
  uint16_t dll_addr;
  uint16_t empty_dl = (uint16_t)(uintptr_t)dl_empty;
  int i;

  /* Patch each row's DL to point at its sprite-data row. */
  set_dl_addr(dl_row0, sprite_row0);
  set_dl_addr(dl_row1, sprite_row1);
  set_dl_addr(dl_row2, sprite_row2);
  set_dl_addr(dl_row3, sprite_row3);
  set_dl_addr(dl_row4, sprite_row4);
  set_dl_addr(dl_row5, sprite_row5);
  set_dl_addr(dl_row6, sprite_row6);
  set_dl_addr(dl_row7, sprite_row7);

  /* Build the DLL: empty zones everywhere except the 8 sprite rows. */
  for (i = 0; i < DLL_ZONES; i++) {
    uint16_t dl_ptr = empty_dl;
    if      (i == SPRITE_Y + 0) dl_ptr = (uint16_t)(uintptr_t)dl_row0;
    else if (i == SPRITE_Y + 1) dl_ptr = (uint16_t)(uintptr_t)dl_row1;
    else if (i == SPRITE_Y + 2) dl_ptr = (uint16_t)(uintptr_t)dl_row2;
    else if (i == SPRITE_Y + 3) dl_ptr = (uint16_t)(uintptr_t)dl_row3;
    else if (i == SPRITE_Y + 4) dl_ptr = (uint16_t)(uintptr_t)dl_row4;
    else if (i == SPRITE_Y + 5) dl_ptr = (uint16_t)(uintptr_t)dl_row5;
    else if (i == SPRITE_Y + 6) dl_ptr = (uint16_t)(uintptr_t)dl_row6;
    else if (i == SPRITE_Y + 7) dl_ptr = (uint16_t)(uintptr_t)dl_row7;
    set_dll_entry(i, dl_ptr);
  }

  /* Palette + background. Atari NTSC palette: HHHL nibble form. */
  BACKGRND = 0x88;   /* light blue */
  P0C1     = 0x46;   /* orange-red */
  P0C2     = 0x0F;   /* white */
  P0C3     = 0x36;   /* pink */
  CHARBASE = 0;
  OFFSET   = 0;

  /* Point MARIA at our DLL. */
  dll_addr = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);

  /* Enable DMA. Bit 6 = DMA on, bits 0-1 = 0 (160A mode), colour-burst on. */
  CTRL = 0x40;

  sfx_init();
  sfx_tone(0, 10, 12);   /* boot chime */

  for (;;) {
    vblank_wait();
    sfx_update();
  }
}

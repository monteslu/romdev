/* music_demo.c — Atari 7800 TIA 2-voice music demo.
 *
 * Plays a continuous looping chiptune:
 *   - voice 0 (TIA channel 0): melody — arpeggio + descending walk
 *   - voice 1 (TIA channel 1): bass   — walking I-V-IV-V quarter notes
 *
 * Visual: a "MUSIC" banner rendered with the same MARIA pattern as
 * default.c (1-scanline zones, 7-byte DLs, full 243-entry DLL). See
 * MENTAL_MODEL.md for the format reference.
 *
 * The note tables live in atari7800_music.c — they ARE the song.
 *
 * Build: build({ output: "rom",  platform: "atari7800", template: "music_demo" })
 */
#include <stdint.h>
#include "atari7800_music.h"

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

/* "MUSIC" banner. 160A mode: 1 byte = 4 pixels (2 bits each). Each
 * letter = 8 pixels = 2 bytes. 5 letters = 10 bytes per row. 8 rows.
 * 0x55 = all 4 pixels at palette index 1 (P0C1, lit). */
#define _L 0x55
#define _D 0x00
static const uint8_t banner_row0[10] = { _L,_L, _L,_L, _D,_D, _L,_L, _D,_D };
static const uint8_t banner_row1[10] = { _L,_L, _L,_L, _L,_L, _L,_L, _L,_L };
static const uint8_t banner_row2[10] = { _L,_D, _L,_L, _L,_D, _D,_L, _L,_D };
static const uint8_t banner_row3[10] = { _L,_L, _L,_L, _D,_L, _D,_L, _D,_D };
static const uint8_t banner_row4[10] = { _L,_L, _L,_L, _D,_L, _D,_L, _D,_D };
static const uint8_t banner_row5[10] = { _L,_L, _L,_L, _L,_D, _D,_L, _L,_D };
static const uint8_t banner_row6[10] = { _L,_L, _L,_L, _L,_L, _L,_L, _L,_L };
static const uint8_t banner_row7[10] = { _L,_L, _L,_L, _D,_D, _L,_L, _D,_D };

/* DL: 5-byte form. Byte 3 encodes palette(0) + width(10) as (32-10)=22=$16. */
#define MK_DL(name) static uint8_t name[7] = { 0, 0x40, 0, 0x16, 60, 0, 0 }
MK_DL(dl_row0); MK_DL(dl_row1); MK_DL(dl_row2); MK_DL(dl_row3);
MK_DL(dl_row4); MK_DL(dl_row5); MK_DL(dl_row6); MK_DL(dl_row7);

static uint8_t dl_empty[2] = { 0, 0 };

#define DLL_ZONES 243
static uint8_t dll[DLL_ZONES * 3];

#define BANNER_Y 100

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

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }
  while (!(MSTAT & 0x80)) { }
}

void main(void) {
  uint16_t dll_addr;
  uint16_t empty = (uint16_t)(uintptr_t)dl_empty;
  int i;

  set_dl_addr(dl_row0, banner_row0);
  set_dl_addr(dl_row1, banner_row1);
  set_dl_addr(dl_row2, banner_row2);
  set_dl_addr(dl_row3, banner_row3);
  set_dl_addr(dl_row4, banner_row4);
  set_dl_addr(dl_row5, banner_row5);
  set_dl_addr(dl_row6, banner_row6);
  set_dl_addr(dl_row7, banner_row7);

  for (i = 0; i < DLL_ZONES; i++) {
    uint16_t dl;
    int d = i - BANNER_Y;
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

  BACKGRND = 0x84;
  P0C1     = 0x0F;  /* white text (palette index 1) */
  P0C2     = 0x0F;
  P0C3     = 0x0F;
  CHARBASE = 0;
  OFFSET   = 0;

  dll_addr = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(dll_addr & 0xFF);
  DPPH = (uint8_t)(dll_addr >> 8);

  CTRL = 0x40;

  music_init();
  music_play();

  for (;;) {
    vblank_wait();
    music_update();
  }
}

// ── music_demo.c — Commodore 64 SID 3-voice music demo ──────────────
//
// A continuous 3-voice tune on the SID:
//   voice 0 = melody  (high pulse)
//   voice 1 = bass    (low  pulse)
//   voice 2 = harmony (mid  pulse)
//
// The note table IS the song — open c64_music.c to read/edit the tune.
// Chord progression is the classic Am-F-C-G loop with melody variations
// across 4 verses; the song wraps forever.
//
// Visuals: title text in the screen-RAM character matrix + a row of
// "VU meter" bars that pulse with the beat (driven by music_tick()).
// Border flashes one color-step per beat for that classic demoscene
// vibe.
//
// Joystick port 2 FIRE: toggle music on/off. The standard C64 idiom
// uses port 2 because port 1 conflicts with the keyboard scan matrix.

#include "c64_registers.h"
#include "c64_music.h"
#include <stdint.h>

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)

#define JOY_FIRE 0x10

/* PETSCII screen codes: A-Z = 1-26, space = 32, 0-9 = 48-57.
 * (Different from PETSCII char codes — these are direct screen-RAM
 * indices into the C64 character ROM.) */
static uint8_t scr_char(char c) {
  if (c >= 'A' && c <= 'Z') return (uint8_t)(c - 'A' + 1);
  if (c >= 'a' && c <= 'z') return (uint8_t)(c - 'a' + 1);
  if (c >= '0' && c <= '9') return (uint8_t)c;   /* 48..57 work directly */
  if (c == '-') return 0x2D;
  if (c == '!') return 0x21;
  return 0x20;  /* space */
}

static void draw_text(uint8_t row, uint8_t col, const char *s, uint8_t color) {
  uint16_t off = (uint16_t)row * 40 + col;
  while (*s) {
    SCREEN[off] = scr_char(*s);
    COLORS[off] = color;
    s++;
    off++;
  }
}

static void wait_vblank(void) {
  while (PEEK(VIC_RASTER) < 250) { }
  while (PEEK(VIC_RASTER) >= 250) { }
}

static void clear_screen(void) {
  uint16_t i;
  for (i = 0; i < 1000; i++) {
    SCREEN[i] = 0x20;       /* space */
    COLORS[i] = COLOR_LIGHT_BLUE;
  }
}

int main(void) {
  uint8_t playing = 1;
  uint8_t prev_pad = 0;
  uint8_t i;
  uint8_t border_phase = 0;
  uint8_t prev_beat = 0;

  /* Pretty C64-blue setup. */
  POKE(VIC_BORDER, COLOR_BLUE);
  POKE(VIC_BG0,    COLOR_BLACK);
  clear_screen();

  draw_text(2,  10, "C64 SID MUSIC DEMO",   COLOR_LIGHT_GREEN);
  draw_text(4,  10, "THREE VOICES LOOP",    COLOR_LIGHT_BLUE);
  draw_text(6,  10, "MELODY  BASS  HARMONY",COLOR_YELLOW);
  draw_text(10, 12, "AM - F - C - G",       COLOR_WHITE);
  draw_text(20,  8, "FIRE TOGGLES PLAYBACK",COLOR_LIGHT_GRAY);
  draw_text(22, 14, "JOY PORT 2",           COLOR_DARK_GRAY);

  music_init();
  music_play();

  for (;;) {
    uint8_t pad;
    uint8_t beat;
    wait_vblank();

    if (playing) {
      music_update();
    }

    /* Beat = upper bits of the tick — changes every ~8 frames. */
    beat = (uint8_t)(music_tick() >> 3);
    if (beat != prev_beat) {
      prev_beat = beat;
      border_phase = (uint8_t)(border_phase + 1);
      POKE(VIC_BORDER, (uint8_t)(border_phase & 0x0F));

      /* VU bars: row 14, 16 cells wide, length tied to phase. */
      {
        uint8_t bar_len = (uint8_t)(border_phase & 0x0F);
        for (i = 0; i < 16; i++) {
          uint16_t off = (uint16_t)14 * 40 + 12 + i;
          if (i < bar_len) {
            SCREEN[off] = 0xA0;            /* solid block */
            COLORS[off] = (uint8_t)((i >> 1) + 2);
          } else {
            SCREEN[off] = 0x20;            /* space */
          }
        }
      }
    }

    pad = (uint8_t)(~PEEK(CIA1_PRA) & 0x1F);
    if ((pad & JOY_FIRE) && !(prev_pad & JOY_FIRE)) {
      playing = (uint8_t)(!playing);
      if (playing) {
        music_play();
      } else {
        music_stop();
      }
    }
    prev_pad = pad;
  }
}

// ── music_demo.c — cc65 lynx_snd_play music engine demo ─────────────
//
// Demonstrates the cc65 4-channel music driver on the Atari Lynx.
// Unlike lynx_sfx (one-shot pokes to the MIKEY voice registers) the
// snd_* API streams a bytestream of (note, length) tuples driven by a
// 240Hz timer IRQ — the same primitive used by Lynx-tracker exports.
//
// Wiring:
//   1) lynx_snd_init()                        — set up 240Hz IRQ, reset voices
//   2) lynx_snd_play(0, demo_music)           — start streaming on channel 0
//   3) main loop just keeps the screen alive; the IRQ does the audio work
//
// To stop / restart you can call lynx_snd_stop() or lynx_snd_play again
// with the same data. The music data itself is in lynx_music.c (the
// byte array IS the source — no asset pipeline involved).

#include <tgi.h>
#include <lynx.h>
#include "lynx_music.h"

void main(void) {
  tgi_install(&lynx_160_102_16_tgi);
  tgi_init();

  lynx_snd_init();
  lynx_snd_play(0, (unsigned char *)demo_music);

  for (;;) {
    tgi_clear();
    tgi_setcolor(COLOR_WHITE);
    tgi_outtextxy(20, 20, "LYNX MUSIC DEMO");
    tgi_setcolor(COLOR_YELLOW);
    tgi_outtextxy(20, 40, "channel 0 playing");
    tgi_outtextxy(20, 50, "via lynx_snd_play");
    tgi_updatedisplay();
  }
}

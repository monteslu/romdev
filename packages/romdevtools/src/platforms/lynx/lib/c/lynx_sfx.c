/* lynx_sfx.c — MIKEY 4-voice audio driver for Lynx scaffolds.
 *
 * Each MIKEY voice occupies 8 bytes starting at $FD20:
 *   +0  VOLCNTRL      signed output volume (-128..127)
 *   +1  FEEDBACK      LFSR feedback taps (which bits XOR back)
 *   +2  OUTPUT        current LFSR output bit
 *   +3  SHIFT         LFSR shift register (low 8 bits)
 *   +4  BACKUP        timer reload value (period)
 *   +5  CTRL          timer/LFSR control bits
 *                       bits 0-2 = clock source (000=16us, 111=link)
 *                       bit 3    = ENABLE_COUNT  ← writing 1 here triggers
 *                                                   handy to reschedule
 *                                                   the next timer event
 *                                                   to NOW (see R57 fix
 *                                                   below)
 *                       bit 4    = ENABLE_RELOAD
 *                       bit 5    = integrate
 *                       bit 6    = reset done flag
 *                       bit 7    = waveshaper feedback bit
 *   +6  COUNTER       current timer value
 *   +7  OTHER         LFSR shift bits 8..11 + feedback enable
 *
 * Voice base: $FD20 + voice*8.
 *
 * STEREO ($FD50) bit pattern: bits 0-3 mute left for voice 0-3,
 *                              bits 4-7 mute right for voice 0-3.
 *                              Set to 0 = all voices to both speakers.
 *
 * ─── R57 fix: defer voice-enable writes to vblank ───────────────────
 *
 * Round 29 friction report: calling sfx_tone() during the active frame
 * intermittently corrupted TGI playfield rendering ("basket + coins
 * invisible, HUD + score fine"). Reproduces with sfx_init alone in
 * some builds, deterministically with any sfx_tone call. The agent
 * tried clearing what they thought was the IRQ bit (bit 3 → bit 4) —
 * didn't help.
 *
 * Root cause (handy mikie.cpp:1668-1680): when a CTL write sets bit 3
 * (ENABLE_COUNT) OR bit 6 (RESET_DONE), handy executes
 *   gNextTimerEvent = gSystemCycleCount;
 * which forces a SYNCHRONOUS timer-event sweep at the next CPU
 * instruction boundary. That sweep can land mid-Suzy-blit and the
 * partially-blitted sprite gets clobbered. Result: some draws abort.
 *
 * The fix is structural: stage the voice config in shadow RAM
 * (sfx_pending_*[]) and have sfx_update() write to hardware. Callers
 * MUST call sfx_update() during vblank — when the blitter is idle —
 * so the synchronous timer-event sweep lands during vblank with no
 * visible damage. This matches the cross-platform shape we use
 * everywhere (sfx_update called once per frame after the wait_vblank).
 */

#include "lynx_sfx.h"

#define MIKEY_BASE      0xFD00
#define VOICE_BASE(n)   (0xFD20 + (n) * 8)
#define MIKEY_STEREO    (*(volatile uint8_t*)0xFD50)

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))

static uint8_t sfx_remaining[4];

/* R57: shadow-RAM trigger queue. sfx_tone / sfx_noise stage their
 * config here; sfx_update flushes the staged channels to hardware
 * during the (caller's) vblank window. */
static uint8_t sfx_pending_kind[4];   /* 0 = no change, 1 = tone, 2 = noise */
static uint8_t sfx_pending_period[4];

void sfx_init(void) {
  uint8_t i;
  MIKEY_STEREO = 0;  /* all voices to both speakers */
  for (i = 0; i < 4; i++) {
    POKE(VOICE_BASE(i) + 0, 0);    /* volume 0 */
    POKE(VOICE_BASE(i) + 5, 0);    /* CTRL off (bit 3 = 0 → no trigger) */
    sfx_remaining[i] = 0;
    sfx_pending_kind[i] = 0;
    sfx_pending_period[i] = 0;
  }
}

void sfx_tone(uint8_t channel, uint8_t period, uint8_t length_frames) {
  if (channel > 3) return;
  /* Stage only — actual hardware writes happen in sfx_update() during
   * the caller's vblank, NOT now. See R57 comment block above. */
  sfx_pending_kind[channel] = 1;
  sfx_pending_period[channel] = period;
  sfx_remaining[channel] = length_frames;
}

void sfx_noise(uint8_t length_frames) {
  /* Voice 3 reserved for noise. Same staging discipline. */
  sfx_pending_kind[3] = 2;
  sfx_remaining[3] = length_frames;
}

/* Apply any staged voice config to hardware. Call during vblank
 * (immediately after tgi_updatedisplay or wait_vblank). */
static void sfx_flush_pending(void) {
  uint8_t i;
  for (i = 0; i < 4; i++) {
    if (sfx_pending_kind[i] == 1) {
      /* Tone: pure repeating bit, period from staged value. */
      POKE(VOICE_BASE(i) + 1, 0x80);     /* feedback off */
      POKE(VOICE_BASE(i) + 4, sfx_pending_period[i]);
      POKE(VOICE_BASE(i) + 5, 0x18);     /* RELOAD + COUNT + 16us clock */
      POKE(VOICE_BASE(i) + 0, 100);      /* volume (was 64 — read as near-silent on hardware) */
    } else if (sfx_pending_kind[i] == 2) {
      /* Noise on voice 3. */
      POKE(VOICE_BASE(i) + 7, 0x01);     /* 12-bit LFSR */
      POKE(VOICE_BASE(i) + 1, 0x95);     /* classic noise feedback */
      POKE(VOICE_BASE(i) + 4, 40);
      POKE(VOICE_BASE(i) + 5, 0x18);
      POKE(VOICE_BASE(i) + 0, 100);
    }
    sfx_pending_kind[i] = 0;
  }
}

/* ── background music: 16-step melody loop on voice 1 ───────────────
 * Ticked from sfx_update() through the SAME staged-write path (R57),
 * so every scaffold that already calls sfx_init() + sfx_update() gets
 * continuous music for free — "no sound at all" was the Lynx playtest
 * verdict. sfx_music(0) turns it off. SFX use voice 0 (+ noise on 3).
 * MIKEY period at the 16us clock: freq ~= 31250 / period. */
static const uint8_t music_period[16] = {
    119, 95, 80, 60, 80, 95, 119, 0,    /* C4 E4 G4 C5 G4 E4 C4 -  */
    142, 119, 95, 71, 95, 119, 142, 0,  /* A3 C4 E4 A4 E4 C4 A3 -  */
};
static uint8_t music_enabled = 1;
static uint8_t music_step, music_timer;

void sfx_music(uint8_t on) {
  music_enabled = on;
  music_step = 0;
  music_timer = 0;
}

static void music_tick(void) {
  uint8_t p;
  if (!music_enabled) return;
  if (music_timer == 0) {
    p = music_period[music_step & 15];
    if (p) {
      sfx_pending_kind[1] = 1;          /* staged like any tone (R57-safe) */
      sfx_pending_period[1] = p;
      sfx_remaining[1] = 8;             /* hold 8 of 9 frames — articulated */
    }
    music_step++;
  }
  music_timer++;
  if (music_timer >= 9) music_timer = 0;
}

void sfx_update(void) {
  uint8_t i;
  music_tick();
  /* R57: flush any sfx_tone/sfx_noise requests from THIS frame. The
   * caller is expected to have just returned from tgi_updatedisplay
   * (or wait_vblank), so the synchronous timer-event sweep that handy
   * triggers on the ENABLE_COUNT write lands during vblank where it
   * can't damage in-flight Suzy blits. */
  sfx_flush_pending();

  /* Tick auto-silence countdowns for active voices. */
  for (i = 0; i < 4; i++) {
    if (sfx_remaining[i] > 0) {
      sfx_remaining[i]--;
      if (sfx_remaining[i] == 0) {
        POKE(VOICE_BASE(i) + 0, 0);  /* silence */
      }
    }
  }
}

void sfx_off(void) {
  uint8_t i;
  for (i = 0; i < 4; i++) {
    POKE(VOICE_BASE(i) + 0, 0);
    POKE(VOICE_BASE(i) + 5, 0);    /* CTRL=0 — bit 3 clear, no trigger */
    sfx_remaining[i] = 0;
    sfx_pending_kind[i] = 0;
  }
}

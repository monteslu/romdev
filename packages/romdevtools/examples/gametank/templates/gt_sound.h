/* ── gt_sound.h — simple SFX for the romdev GameTank examples (no music) ──────
 *
 * One-shot sound effects on the ACP FM synth — NO song engine. The SDK music
 * player (play_song/tick_music) drove a continuous buzz on un-keyed channels and
 * bogged the frame; for examples, punchy SFX (shoot / hit / explode) are clearer
 * and dead simple. Each gt_sfx() keys a note on one FM channel at a chosen
 * amplitude; gt_sfx_tick() (call once/frame) fades active SFX so they don't ring
 * forever. No per-frame song parsing, no buzz.
 *
 * USAGE:
 *   gt_sfx_tick();          once per frame (fades out SFX envelopes)
 *   gt_sfx(GT_SFX_SHOOT);   fire a shoot blip
 *   gt_sfx(GT_SFX_HIT);     a hit/score blip
 *   gt_sfx(GT_SFX_EXPLODE); a low explosion
 */
#ifndef GT_SOUND_H
#define GT_SOUND_H
#include "music.h"
#include "instruments.h"
#include "audio_coprocessor.h"   /* AMPLITUDE, PITCH_MSB/LSB, set_audio_param, flush_audio_params */

/* SFX presets: { note, FM channel, start amplitude, fade-per-frame }. */
#define GT_SFX_SHOOT   0
#define GT_SFX_HIT     1
#define GT_SFX_EXPLODE 2
#define GT_SFX_COIN    3
#define GT_SFX_JUMP    4

/* per-channel fade state (channel 0..3). */
static unsigned char gt_sfx_amp[4];
static unsigned char gt_sfx_fade[4];
static unsigned char gt_sfx_started;

static void gt_sfx_init(void) {
  unsigned char c;
  init_music();                 /* brings up the note/param plumbing (no song) */
  for (c = 0; c < 4; c++) {
    /* ch0/1 = GUITAR (shoot/hit blips), ch2 = SNARE (explode), ch3 = PIANO — a clean
     * mellow tone for pleasant pickups (coins). GUITAR on high notes sounds metallic. */
    unsigned char instr = (c == 2) ? INSTR_IDX_SNARE
                        : (c == 3) ? INSTR_IDX_PIANO
                        : INSTR_IDX_GUITAR;
    load_instrument(c, get_instrument_ptr(instr));
    gt_sfx_amp[c] = 0; gt_sfx_fade[c] = 0;
  }
  gt_sfx_started = 1;
}

/* fade active SFX channels toward silence. Call ONCE per frame. */
static void gt_sfx_tick(void) {
  unsigned char c, op;
  if (!gt_sfx_started) gt_sfx_init();
  for (c = 0; c < 4; c++) {
    if (gt_sfx_amp[c]) {
      gt_sfx_amp[c] = (gt_sfx_amp[c] > gt_sfx_fade[c]) ? gt_sfx_amp[c] - gt_sfx_fade[c] : 0;
      op = c << 2;
      set_audio_param(AMPLITUDE + op,   (gt_sfx_amp[c] >> 1) + 128);
      set_audio_param(AMPLITUDE + op+1, (gt_sfx_amp[c] >> 1) + 128);
      set_audio_param(AMPLITUDE + op+2, (gt_sfx_amp[c] >> 1) + 128);
      set_audio_param(AMPLITUDE + op+3, (gt_sfx_amp[c] >> 1) + 128);
    }
  }
  flush_audio_params();
}

/* fire a one-shot SFX. id picks the note/channel/amplitude/fade. */
static void gt_sfx(unsigned char id) {
  unsigned char note, ch, amp, fade, op;
  if (!gt_sfx_started) gt_sfx_init();
  switch (id) {
    case GT_SFX_SHOOT:   note = 64; ch = 0; amp = 0x50; fade = 12; break;
    case GT_SFX_HIT:     note = 52; ch = 1; amp = 0x60; fade = 10; break;
    case GT_SFX_EXPLODE: note = 30; ch = 2; amp = 0x70; fade = 5;  break;
    case GT_SFX_COIN:    note = 76; ch = 3; amp = 0x44; fade = 16; break;  /* PIANO ch, bright + quick */
    case GT_SFX_JUMP:    note = 60; ch = 0; amp = 0x50; fade = 14; break;
    default:             note = 60; ch = 0; amp = 0x50; fade = 12; break;
  }
  op = ch << 2;
  set_note(op, note);
  gt_sfx_amp[ch] = amp; gt_sfx_fade[ch] = fade;
  set_audio_param(AMPLITUDE + op,   (amp >> 1) + 128);
  set_audio_param(AMPLITUDE + op+1, (amp >> 1) + 128);
  set_audio_param(AMPLITUDE + op+2, (amp >> 1) + 128);
  set_audio_param(AMPLITUDE + op+3, (amp >> 1) + 128);
}

/* compatibility shim: games still call gt_music_tick() each frame → just fades SFX. */
#define gt_music_tick() gt_sfx_tick()

#endif /* GT_SOUND_H */

/* c64_music.c — per-frame 3-voice SID music driver.
 *
 *  Architecture
 *  ────────────
 *  Three voices, each walks an independent (freq, length_frames) table:
 *
 *    voice0 = melody   (pulse,  high register)
 *    voice1 = bass     (pulse,  low  register, longer notes)
 *    voice2 = harmony  (pulse,  mid  register)
 *
 *  On each music_update() (called once per VBlank ≈ 50 Hz PAL / 60 Hz NTSC):
 *    - decrement the current note's frames-remaining counter for each voice
 *    - when it hits 0, advance to the next note: write FREQ_LO/HI, retrigger
 *      GATE (off-on transition keys the envelope) and start the new counter
 *    - if a voice reaches end-of-table it wraps to 0 → continuous loop
 *
 *  ADSR shape (same for all 3 voices for simplicity):
 *    attack=0  decay=4  sustain=8 release=4
 *  → punchy front, ~half-volume sustain, short tail. Notes don't bleed
 *    into each other but sound musical.
 *
 *  Frequency values are the standard PAL SID 16-bit dividers from any
 *  C64 programmer reference. Hz ≈ freq * 0.0596.
 *
 *  The song
 *  ────────
 *  16-bar loop, 4/4, ~125 BPM. Each "step" is 12 frames = ~0.2s @ 50 Hz.
 *  Melody plays mostly quarter-steps, bass holds half-steps, harmony
 *  rides between. C major / A minor flavor — chord progression:
 *    Am  F   C   G   (the classic four-chord loop)
 *  repeated 4× per loop with melody variations.
 *
 *  A rest is encoded as freq=0 (driver gates off without retriggering).
 */

#include "c64_music.h"
#include "c64_registers.h"

#define POKE(addr, val)  (*(volatile uint8_t*)(addr) = (val))

/* ── SID 16-bit frequency dividers for PAL (985248 Hz clock) ────── */
/* Standard table — match any C64 programmer's guide. Hz ≈ f * 0.0596. */
#define N_REST  0x0000u

#define N_C3    0x1199u
#define N_D3    0x13EEu
#define N_E3    0x1666u
#define N_F3    0x1798u
#define N_G3    0x1AE6u
#define N_A3    0x1E78u
#define N_B3    0x2253u

#define N_C4    0x2333u
#define N_D4    0x27DDu
#define N_E4    0x2CCCu
#define N_F4    0x2F30u
#define N_G4    0x35CCu
#define N_A4    0x3CF1u
#define N_B4    0x44A7u

#define N_C5    0x4666u
#define N_D5    0x4FBAu
#define N_E5    0x5998u
#define N_F5    0x5E60u
#define N_G5    0x6B99u
#define N_A5    0x79E1u
#define N_B5    0x894Eu

/* Step length: number of frames a "unit" note occupies. */
#define STEP  10

typedef struct {
  uint16_t freq;
  uint8_t  len;   /* frames */
} Note;

/* ── Voice 0: melody (lead). High register, ~quarter-note pacing. ─
 * Chord progression spelled out as Am F C G repeated. Each chord
 * gets 4 melody notes (one bar). 16 bars × 4 notes = 64 notes. */
static const Note melody[] = {
  /* Am bar */
  { N_A4, STEP*2 }, { N_C5, STEP }, { N_E5, STEP }, { N_C5, STEP*2 }, { N_A4, STEP*2 },
  /* F  bar */
  { N_F4, STEP*2 }, { N_A4, STEP }, { N_C5, STEP }, { N_A4, STEP*2 }, { N_F4, STEP*2 },
  /* C  bar */
  { N_C5, STEP*2 }, { N_E5, STEP }, { N_G5, STEP }, { N_E5, STEP*2 }, { N_C5, STEP*2 },
  /* G  bar */
  { N_G4, STEP*2 }, { N_B4, STEP }, { N_D5, STEP }, { N_B4, STEP*2 }, { N_G4, STEP*2 },

  /* — verse 2: same chords, ornamented — */
  { N_A4, STEP   }, { N_C5, STEP }, { N_E5, STEP*2 }, { N_D5, STEP }, { N_C5, STEP }, { N_E5, STEP*2 },
  { N_F4, STEP   }, { N_A4, STEP }, { N_C5, STEP*2 }, { N_B4, STEP }, { N_A4, STEP }, { N_C5, STEP*2 },
  { N_C5, STEP   }, { N_E5, STEP }, { N_G5, STEP*2 }, { N_F5, STEP }, { N_E5, STEP }, { N_G5, STEP*2 },
  { N_G4, STEP   }, { N_B4, STEP }, { N_D5, STEP*2 }, { N_C5, STEP }, { N_B4, STEP }, { N_D5, STEP*2 },

  /* — verse 3: rising arpeggios — */
  { N_A3, STEP }, { N_C4, STEP }, { N_E4, STEP }, { N_A4, STEP }, { N_C5, STEP }, { N_E5, STEP }, { N_A5, STEP*2 },
  { N_F3, STEP }, { N_A3, STEP }, { N_C4, STEP }, { N_F4, STEP }, { N_A4, STEP }, { N_C5, STEP }, { N_F5, STEP*2 },
  { N_C4, STEP }, { N_E4, STEP }, { N_G4, STEP }, { N_C5, STEP }, { N_E5, STEP }, { N_G5, STEP }, { N_C5, STEP*2 },
  { N_G3, STEP }, { N_B3, STEP }, { N_D4, STEP }, { N_G4, STEP }, { N_B4, STEP }, { N_D5, STEP }, { N_G5, STEP*2 },

  /* — verse 4: cooldown, longer notes — */
  { N_A4, STEP*4 }, { N_E5, STEP*4 },
  { N_F4, STEP*4 }, { N_C5, STEP*4 },
  { N_C5, STEP*4 }, { N_G5, STEP*4 },
  { N_G4, STEP*4 }, { N_D5, STEP*4 },

  /* end-mark not needed; we wrap. */
};

/* ── Voice 1: bass. Low register, half-note pacing. ───────────── */
static const Note bass[] = {
  /* Am F C G — one note per bar, sustained */
  { N_A3, STEP*8 }, { N_F3, STEP*8 }, { N_C3, STEP*8 }, { N_G3, STEP*8 },
  /* repeat for verse 2 */
  { N_A3, STEP*8 }, { N_F3, STEP*8 }, { N_C3, STEP*8 }, { N_G3, STEP*8 },
  /* verse 3 — walking bass */
  { N_A3, STEP*4 }, { N_E3, STEP*4 },
  { N_F3, STEP*4 }, { N_C3, STEP*4 },
  { N_C3, STEP*4 }, { N_G3, STEP*4 },
  { N_G3, STEP*4 }, { N_D3, STEP*4 },
  /* verse 4 — pedal */
  { N_A3, STEP*8 }, { N_F3, STEP*8 }, { N_C3, STEP*8 }, { N_G3, STEP*8 },
};

/* ── Voice 2: harmony. Mid register, offset rhythm. ─────────── */
static const Note harmony[] = {
  /* Am chord tones */
  { N_C4, STEP*2 }, { N_E4, STEP*2 }, { N_A4, STEP*2 }, { N_E4, STEP*2 },
  /* F  chord tones */
  { N_A3, STEP*2 }, { N_C4, STEP*2 }, { N_F4, STEP*2 }, { N_C4, STEP*2 },
  /* C  chord tones */
  { N_E4, STEP*2 }, { N_G4, STEP*2 }, { N_C5, STEP*2 }, { N_G4, STEP*2 },
  /* G  chord tones */
  { N_D4, STEP*2 }, { N_G4, STEP*2 }, { N_B4, STEP*2 }, { N_G4, STEP*2 },

  /* verse 2 — same with rest accents */
  { N_C4, STEP }, { N_E4, STEP }, { N_REST, STEP }, { N_A4, STEP*2 }, { N_E4, STEP*2 }, { N_C4, STEP },
  { N_A3, STEP }, { N_C4, STEP }, { N_REST, STEP }, { N_F4, STEP*2 }, { N_C4, STEP*2 }, { N_A3, STEP },
  { N_E4, STEP }, { N_G4, STEP }, { N_REST, STEP }, { N_C5, STEP*2 }, { N_G4, STEP*2 }, { N_E4, STEP },
  { N_D4, STEP }, { N_G4, STEP }, { N_REST, STEP }, { N_B4, STEP*2 }, { N_G4, STEP*2 }, { N_D4, STEP },

  /* verse 3 — long pads */
  { N_E4, STEP*8 }, { N_F4, STEP*8 }, { N_G4, STEP*8 }, { N_B4, STEP*8 },

  /* verse 4 — drop out partly */
  { N_REST, STEP*8 }, { N_C4, STEP*8 }, { N_REST, STEP*8 }, { N_D4, STEP*8 },
};

#define ARR_LEN(a) (sizeof(a) / sizeof((a)[0]))

/* Per-voice state. */
static uint16_t v_pos[3];      /* index into the voice's note table */
static uint8_t  v_remaining[3];/* frames left on current note */
static uint8_t  m_tick;

static uint16_t voice_len(uint8_t v) {
  switch (v) {
    case 0: return (uint16_t)ARR_LEN(melody);
    case 1: return (uint16_t)ARR_LEN(bass);
    default: return (uint16_t)ARR_LEN(harmony);
  }
}
static const Note *voice_note(uint8_t v, uint16_t i) {
  switch (v) {
    case 0: return &melody[i];
    case 1: return &bass[i];
    default: return &harmony[i];
  }
}

/* Set up the pulse-wave shape on a voice: PW = 50% duty, ADSR shape. */
static void setup_voice(uint8_t v) {
  POKE(SID_PW_LO(v), 0x00);
  POKE(SID_PW_HI(v), 0x08);   /* PW = $0800 = 50% */
  POKE(SID_AD(v), 0x04);      /* attack=0, decay=4 */
  POKE(SID_SR(v), 0x84);      /* sustain=8, release=4 */
  POKE(SID_CTRL(v), 0);       /* gate off until first note */
}

/* Trigger a note: write freq, gate off→on retrigger so envelope keys. */
static void trigger(uint8_t v, uint16_t freq) {
  if (freq == N_REST) {
    /* Rest: gate off, no retrigger. Release tail plays. */
    POKE(SID_CTRL(v), SID_PULSE);
    return;
  }
  POKE(SID_FREQ_LO(v), (uint8_t)(freq & 0xFF));
  POKE(SID_FREQ_HI(v), (uint8_t)(freq >> 8));
  /* Off then on for clean envelope retrigger. */
  POKE(SID_CTRL(v), SID_PULSE);
  POKE(SID_CTRL(v), SID_PULSE | SID_GATE);
}

void music_init(void) {
  uint8_t v;
  POKE(SID_VOL_MODE, 0x0F);   /* master vol = 15, no filter */
  for (v = 0; v < 3; v++) {
    setup_voice(v);
    v_pos[v] = 0;
    v_remaining[v] = 0;
  }
  m_tick = 0;
}

void music_play(void) {
  uint8_t v;
  const Note *n;
  for (v = 0; v < 3; v++) {
    v_pos[v] = 0;
    n = voice_note(v, 0);
    v_remaining[v] = n->len;
    trigger(v, n->freq);
  }
}

void music_update(void) {
  uint8_t v;
  const Note *n;
  m_tick++;
  for (v = 0; v < 3; v++) {
    if (v_remaining[v] > 0) {
      v_remaining[v]--;
    }
    if (v_remaining[v] == 0) {
      /* Advance, with wrap. */
      v_pos[v]++;
      if (v_pos[v] >= voice_len(v)) v_pos[v] = 0;
      n = voice_note(v, v_pos[v]);
      v_remaining[v] = n->len;
      trigger(v, n->freq);
    }
  }
}

void music_stop(void) {
  uint8_t v;
  for (v = 0; v < 3; v++) {
    POKE(SID_CTRL(v), 0);
    v_remaining[v] = 0;
    v_pos[v] = 0;
  }
  POKE(SID_VOL_MODE, 0);
}

uint8_t music_tick(void) {
  return m_tick;
}

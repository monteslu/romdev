/* MSX music_sfx — AY-3-8910 PSG melody + trigger-fired sound effect.
 *
 * WHAT IT DOES
 *   - Channel A plays a short looping 8-note melody (~0.2 s per note).
 *   - Channel B plays a soft bass note under the melody (harmony).
 *   - Pressing the joystick TRIGGER (button A / port-1 fire) fires a quick
 *     descending "blip" SFX on channel C.
 *   - On-screen state is shown with sprites: a row of eight "beat" sprites
 *     lights the one matching the current melody step (a tiny step sequencer,
 *     split across two rows so the VDP's 4-sprites-per-scanline limit doesn't
 *     drop any), and a big 16x16 indicator sprite turns RED while the trigger
 *     is held (white when idle).
 *
 * WHY SPRITES (not text): screen 2's font isn't loaded by INIGRP, so the most
 * reliable "visible state" on a fresh graphic screen is sprites, which the VDP
 * draws from the sprite tables with no font upload. The big indicator uses the
 * VDP's 16x16 magnified sprite mode (R1 bits 0-1) so it's impossible to miss.
 *
 * KEY APIS (from msx_hw.h / msx_vdp.c, all direct-port, no fragile asm):
 *   msx_psg_tone(chan, period, vol)  - play a square tone on PSG chan 0/1/2
 *   msx_psg_off(chan)                - silence a channel
 *   gttrig(1)                        - BIOS GTTRIG: bit7 set = trigger pressed
 *   msx_set_sprite / msx_clear_sprites / msx_vblank_wait
 *
 * AY period for a note = clock(1789772.5) / (16 * freq). period 0 = silent.
 *
 * BUILD: link msx_vdp.c + msx_crt0.s (sources) + msx_hw.h (includes),
 *        crt0 ".module empty\n", sourceName "main.c".
 */
#include "msx_hw.h"

/* --- melody (channel A) ------------------------------------------------- */
#define NOTE_C4 426
#define NOTE_D4 379
#define NOTE_E4 338
#define NOTE_G4 284
#define NOTE_A4 253
#define NOTE_C5 213
#define REST    0

#define MELODY_LEN 8
static const unsigned int MELODY[MELODY_LEN] = {
    NOTE_C4, NOTE_E4, NOTE_G4, NOTE_C5, NOTE_A4, NOTE_G4, NOTE_E4, NOTE_D4
};
/* a slow bass line on channel B, one note per two melody steps */
static const unsigned int BASS[MELODY_LEN] = {
    NOTE_C4 * 2, NOTE_C4 * 2, NOTE_E4 * 2, NOTE_E4 * 2,
    NOTE_C4 * 2, NOTE_C4 * 2, NOTE_G4 * 2, NOTE_G4 * 2
};

/* note duration in frames (~60 Hz). 12 frames ~= 0.2 s. */
#define NOTE_FRAMES 12

/* --- sprite patterns ---------------------------------------------------- */
/* Pattern 0: a solid 8x8 blob used for the small "beat" markers. */
static const unsigned char BLOB8[8] = {
    0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C
};
/* Patterns 1..4: a 16x16 ring used as the big trigger indicator. A 16x16 MSX
 * sprite is four 8x8 patterns laid out TL,BL,TR,BR (column-major). */
static const unsigned char RING16[32] = {
    /* pattern 1 = top-left quadrant */
    0x03, 0x0C, 0x10, 0x20, 0x40, 0x40, 0x80, 0x80,
    /* pattern 2 = bottom-left quadrant */
    0x80, 0x80, 0x40, 0x40, 0x20, 0x10, 0x0C, 0x03,
    /* pattern 3 = top-right quadrant */
    0xC0, 0x30, 0x08, 0x04, 0x02, 0x02, 0x01, 0x01,
    /* pattern 4 = bottom-right quadrant */
    0x01, 0x01, 0x02, 0x02, 0x04, 0x08, 0x30, 0xC0
};

/* Sprite planes:
 *   0      = big 16x16 trigger indicator
 *   1..8   = the eight small beat markers (step sequencer)            */
#define PLANE_INDICATOR 0
#define PLANE_BEAT0     1

/* MSX sprite colours (fixed TMS9918 palette): 15=white, 8=red, 4=blue,
 * 11=light yellow, 14=gray. */
#define COL_WHITE  15
#define COL_RED     8
#define COL_GREEN   3
#define COL_GRAY   14
#define COL_YELLOW 11

/* Beat-marker placement. The TMS9918/V9938 only draws 4 sprites per scanline;
 * with all eight on one row the 5th-8th would vanish. So we stagger them into
 * two rows of four (even index -> top row, odd -> bottom row), and within each
 * row spread them out horizontally. */
#define BEAT_X(i) ((unsigned char)(72 + ((i) >> 1) * 28))
#define BEAT_Y(i) ((unsigned char)(((i) & 1) ? 168 : 144))

void main(void) {
    unsigned char step = 0;      /* current melody / beat index 0..7 */
    unsigned char ticks = 0;     /* frames elapsed on the current note */
    unsigned int  sfx = 0;       /* sfx period; 0 = not playing       */
    unsigned char trig, prev_trig = 0;
    unsigned char i;

    msx_set_screen2();           /* 256x192 graphic mode, display on  */
    msx_clear_sprites();

    /* Enable 16x16 sprites (R1 bit1 = size 16x16). Keep display on (bit6) and
     * the standard mode bits INIGRP set; just OR in the size bit. R1 after
     * INIGRP is 0x60 -> 0x62 selects 16x16 unmagnified sprites. */
    msx_wrtvdp(1, 0x62);

    /* Upload sprite patterns: BLOB8 at pattern #0, RING16 at patterns #1..#4
     * (each pattern is 8 bytes; pattern N lives at SPRPAT + N*8). */
    msx_vram_write(VRAM_SPRPAT + 0 * 8, BLOB8, 8);
    msx_vram_write(VRAM_SPRPAT + 1 * 8, RING16, 32);

    /* Lay out the eight beat markers in a row near the bottom. With 16x16
     * sprites the small BLOB8 (pattern 0) draws as a 16x16 magnified-ish block;
     * that's fine — we want them chunky and visible. Pattern numbers for a
     * 16x16 sprite must be multiples of 4, so BLOB8 (pattern 0) is valid and
     * the ring starts at pattern 4... but we uploaded the ring at pattern 1.
     * To keep both valid in 16x16 mode we give the beat markers pattern 0 and
     * the indicator pattern 4-aligned; re-upload the ring to pattern 4. */
    msx_vram_write(VRAM_SPRPAT + 4 * 8, RING16, 32);

    for (i = 0; i < MELODY_LEN; i++) {
        msx_set_sprite((unsigned char)(PLANE_BEAT0 + i),
                       BEAT_X(i), BEAT_Y(i),
                       0 /*BLOB8*/, COL_GRAY);
    }

    for (;;) {
        /* --- melody (chan A) + bass (chan B): advance every NOTE_FRAMES --- */
        if (ticks == 0) {
            if (MELODY[step] == REST) msx_psg_off(0);
            else                      msx_psg_tone(0, MELODY[step], 13);
            msx_psg_tone(1, BASS[step], 7);   /* quiet bass */

            /* light the current beat (yellow), dim the rest (gray) */
            for (i = 0; i < MELODY_LEN; i++) {
                msx_set_sprite((unsigned char)(PLANE_BEAT0 + i),
                               BEAT_X(i), BEAT_Y(i),
                               0,
                               (i == step) ? COL_YELLOW : COL_GRAY);
            }
            step = (unsigned char)((step + 1) & (MELODY_LEN - 1));
        }
        ticks = (unsigned char)((ticks + 1) % NOTE_FRAMES);

        /* --- SFX (chan C): fire a descending blip on the trigger PRESS edge --- */
        trig = gttrig(1);                       /* bit7 set = pressed */
        if ((trig & 0x80) && !(prev_trig & 0x80)) {
            sfx = 120;                          /* start high, slide down */
        }
        prev_trig = trig;
        if (sfx) {
            msx_psg_tone(2, sfx, 14);
            sfx += 40;                          /* period grows -> pitch falls */
            if (sfx > 800) { sfx = 0; msx_psg_off(2); }
        }

        /* --- big indicator sprite: RED while trigger held, else WHITE --- */
        msx_set_sprite(PLANE_INDICATOR, 120, 70, 4 /*RING16*/,
                       (unsigned char)((trig & 0x80) ? COL_RED : COL_WHITE));

        msx_vblank_wait();
    }
}

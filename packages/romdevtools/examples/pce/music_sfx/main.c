/* PC Engine music_sfx — HuC6280 PSG music + sound-effect demo.
 *
 * A looping melody plays on two of the six PSG wavetable channels:
 *   - channel 0 = lead voice (the tune)
 *   - channel 1 = bass voice (lower, changes every two steps)
 * Pressing button I fires a short descending "blip" SFX on channel 2, which
 * frees itself after a few frames so the music keeps going.
 *
 * The on-screen indicator is drawn with cc65's conio text layer (same reliable
 * path hello_pce.c uses — conio sets up the VDC/VCE and uploads a font, so we
 * never hand-roll BAT/tile rendering):
 *   - an 8-step bar of dots with a moving block that steps in time with the
 *     melody, so you can SEE the music advancing.
 *   - an "SFX!" label that lights up (reverse video) while button I's effect
 *     is sounding, so button I has an obvious VISUAL response too.
 *
 * Sound is the PCE helper lib: psg_tone(chan, freq, vol) loads a triangle wave
 * and enables the channel; psg_off(chan) silences it. The PCE frequency reg is
 * a DIVIDER, so a SMALLER value = HIGHER pitch (~3.58MHz / (32 * freq)).
 *
 * cc65 is C89 — declare locals at the top of a block.
 *
 * Build: link main.c + pce_sound.c + pce_input.c, with pce_hw.h in includes.
 * (conio gives us the display + font; no pce_video.c / bg_enable needed.)
 */
#include <conio.h>
#include <pce.h>
#include "pce_hw.h"

/* ---- musical note -> PCE 12-bit frequency divider ------------------------
 * A short, recognisable 8-step loop. Lower divider = higher pitch. REST(0)
 * means "no lead note this step". Tuned by ear for the geargrafx core. */
#define REST   0

static const u16 lead_freq[8] = {
    0x120,  /* high  */
    0x144,
    0x160,
    0x144,
    0x120,
    0x0F0,  /* highest */
    0x120,
    REST    /* rest    */
};

/* Bass: one note per two lead steps, lower pitch (bigger divider). */
static const u16 bass_freq[4] = {
    0x300,
    0x2C0,
    0x280,
    0x300
};

/* ---- timing --------------------------------------------------------------
 * One melody step every STEP_FRAMES vsyncs (~60Hz). 12 frames ~= 200ms/step. */
#define STEP_FRAMES   12

/* SFX: a short descending blip on channel 2; lasts SFX_FRAMES, then freed. */
#define SFX_FRAMES    10

/* conio screen positions for the indicator (PCE conio is ~32x28 chars). */
#define BAR_X     11   /* left column of the 8-step bar */
#define BAR_Y     13
#define SFX_X     13
#define SFX_Y     16

/* keep .bss non-empty (crt0 BSS-clear underflows on empty .bss); we already
 * have globals below, but an explicit guard documents the trap. */
static unsigned char _keep[4];

/* Redraw the 8-step bar: every step a dot, the active step a solid block. */
static void draw_bar(u8 active) {
    u8 i;
    for (i = 0; i < 8; ++i) {
        cputcxy((u8)(BAR_X + i), BAR_Y, (char)((i == active) ? '#' : '.'));
    }
}

/* Paint a decorative full-screen frame so the demo reads as a real UI panel
 * instead of a near-empty backdrop. conio only inits a backdrop + font, so an
 * otherwise text-only screen leaves >92% of pixels one colour, which looks
 * blank to a human. We fill the top/bottom title bands and both side borders
 * with a block character (the labels are drawn ON TOP afterwards). PCE conio is
 * 32 cols x 28 rows. */
#define SCR_COLS  32
#define SCR_ROWS  28
static void draw_frame(void) {
    u8 x, y;
    /* solid top band (rows 0-1) and bottom band (rows 26-27) */
    for (y = 0; y < SCR_ROWS; ++y) {
        if (y < 2 || y >= SCR_ROWS - 2) {
            for (x = 0; x < SCR_COLS; ++x) cputcxy(x, y, '#');
        } else {
            /* left + right vertical borders (two columns each for weight) */
            cputcxy(0, y, '#');
            cputcxy(1, y, '#');
            cputcxy((u8)(SCR_COLS - 2), y, '#');
            cputcxy((u8)(SCR_COLS - 1), y, '#');
        }
    }
    /* a mid separator bar under the title so the panel has visible structure */
    for (x = 2; x < SCR_COLS - 2; ++x) cputcxy(x, 5, '=');
}

void main(void) {
    u8  pad, prev_pad;
    u8  step;        /* current melody step 0..7              */
    u8  frame;       /* frames since last step                */
    u8  sfx_timer;   /* >0 while the SFX channel is sounding   */
    u16 sfx_freq;    /* current SFX divider (rises = pitch falls) */
    u8  last_sfx_vis;/* shadow so we only repaint the label on change */

    _keep[0] = 0;

    /* conio: clear + enable display, paint the frame, then the static labels. */
    clrscr();
    draw_frame();            /* visible bordered panel (not a blank backdrop)  */
    cputsxy(8, 8,  "PC ENGINE MUSIC + SFX");
    cputsxy(8, 11, "MELODY:");
    cputsxy(8, BAR_Y - 1, "STEP:");
    cputsxy(8, 20, "PRESS  I  FOR SFX");

    pce_joy_init();

    /* kick off the music */
    step = 0; frame = 0;
    prev_pad = 0;
    sfx_timer = 0; sfx_freq = 0x080; last_sfx_vis = 0;

    if (lead_freq[0] != REST) psg_tone(0, lead_freq[0], 28);
    psg_tone(1, bass_freq[0], 20);
    draw_bar(0);
    cputsxy(SFX_X, SFX_Y, "    ");   /* SFX label off */

    for (;;) {
        waitvsync();
        pad = pce_joy_read();

        /* ---- button I: trigger SFX (edge-triggered: a hold = one blip) --- */
        if ((pad & PCE_JOY_I) && !(prev_pad & PCE_JOY_I)) {
            sfx_timer = SFX_FRAMES;
            sfx_freq  = 0x080;            /* start high, sweep down */
            psg_tone(2, sfx_freq, 31);    /* loud blip on channel 2 */
        }
        prev_pad = pad;

        /* ---- advance the SFX sweep / free the channel when done ---------- */
        if (sfx_timer) {
            sfx_freq = (u16)(sfx_freq + 0x040);  /* bigger divider = lower pitch */
            psg_tone(2, sfx_freq, 31);
            --sfx_timer;
            if (sfx_timer == 0) psg_off(2);
        }

        /* light the SFX label only on state change (cheap; avoids flicker) */
        if ((sfx_timer != 0) != (last_sfx_vis != 0)) {
            last_sfx_vis = (sfx_timer != 0);
            if (last_sfx_vis) {
                revers(1);
                cputsxy(SFX_X, SFX_Y, "SFX!");
                revers(0);
            } else {
                cputsxy(SFX_X, SFX_Y, "    ");
            }
        }

        /* ---- melody step clock ------------------------------------------ */
        ++frame;
        if (frame >= STEP_FRAMES) {
            frame = 0;
            step = (u8)((step + 1) & 7);

            if (lead_freq[step] != REST) psg_tone(0, lead_freq[step], 28);
            else                          psg_off(0);

            psg_tone(1, bass_freq[(step >> 1) & 3], 20);

            draw_bar(step);
        }
    }
}

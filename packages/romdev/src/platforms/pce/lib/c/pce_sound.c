/*
 * pce_sound.c — HuC6280 PSG helpers (C89).
 *
 * The PCE PSG has 6 wavetable channels at $0800-$0809. To make a tone you:
 *   1. select the channel  (PSG_CHAN_SELECT = chan)
 *   2. set its 12-bit frequency  (PSG_FREQ_LO / PSG_FREQ_HI)
 *   3. write a 32-byte waveform into the channel's wave RAM (PSG_CHAN_DATA)
 *   4. enable the channel with a 5-bit volume  (PSG_CHAN_CTRL = 0x80 | vol)
 *
 * psg_tone() does all of that with a built-in triangle wave so a single call
 * makes audible sound. Higher PCE frequency register value = LOWER pitch (it's
 * a divider): pitch ~= 3.58MHz / (32 * freq).
 */
#include "pce_hw.h"

/* A simple 32-sample triangle wave (0..31), loaded once per channel so the
 * wavetable isn't empty (an all-zero wave is silent even with volume up). */
static const u8 _pce_tri[32] = {
     0,  2,  4,  6,  8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30,
    31, 29, 27, 25, 23, 21, 19, 17, 15, 13, 11,  9,  7,  5,  3,  1
};

/* Play a wavetable tone on `chan` (0..5) at 12-bit `freq` (divider; lower =
 * higher pitch), `vol` 0..31. Resets the wave write pointer before loading. */
void psg_tone(u8 chan, u16 freq, u8 vol) {
    u8 i;
    if (chan > 5) return;

    PSG_CHAN_SELECT = chan;                 /* select this channel's registers */
    PSG_GLOBAL_PAN  = 0xFF;                 /* main amplitude: full L+R        */

    /* Frequency: 12 bits across LO (8) + HI (low 4 bits). */
    PSG_FREQ_LO = (u8)(freq & 0xFF);
    PSG_FREQ_HI = (u8)((freq >> 8) & 0x0F);

    /* Arm wavetable write: control bit7=0, bit6=0 selects waveform-write mode,
     * which also resets the wave index to 0. Then stream 32 samples. */
    PSG_CHAN_CTRL = 0x00;
    for (i = 0; i < 32; ++i) {
        PSG_CHAN_DATA = _pce_tri[i];
    }

    PSG_CHAN_PAN  = 0xFF;                    /* per-channel full L+R            */
    /* Enable: bit7 on, bit6=0 (wavetable, not DDA), low 5 bits = volume. */
    PSG_CHAN_CTRL = (u8)(PSG_CTRL_ON | (vol & PSG_CTRL_VOL_MASK));
}

/* Silence and disable a channel. */
void psg_off(u8 chan) {
    if (chan > 5) return;
    PSG_CHAN_SELECT = chan;
    PSG_CHAN_CTRL   = 0x00;   /* bit7 clear = channel off, volume 0 */
}

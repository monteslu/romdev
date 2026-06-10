/* ── gba_sfx.c — minimal GBA sound-effects wrapper ──────────────────
 *
 * GBA APU register summary (Tonc names):
 *   REG_SND1SWEEP   ch1 sweep (NR10 equivalent)
 *   REG_SND1CNT     ch1 control: duty + length + envelope (NR11/NR12)
 *   REG_SND1FREQ    ch1 frequency + trigger + length-enable (NR13/NR14)
 *   REG_SND2CNT     ch2 control (NR21/NR22)
 *   REG_SND2FREQ    ch2 frequency (NR23/NR24)
 *   REG_SND4CNT     ch4 noise control (NR41/NR42)
 *   REG_SND4FREQ    ch4 noise freq + trigger (NR43/NR44)
 *   REG_SNDDMGCNT   master DMG routing (NR50/NR51 — volume + L/R)
 *   REG_SNDDSCNT    Direct Sound + DMG-vs-DS master volume
 *   REG_SNDSTAT     power on/off (NR52); BIT 7 = master enable
 *
 * Register layouts on GBA = DMG layouts shifted into u16 pairs. The
 * .L half = first byte (NR_1), .H half = second byte (NR_2). Or treat
 * as one u16 with low/high bytes.
 */

#include "gba_sfx.h"
#include <tonc_memmap.h>

void sfx_init(void) {
    /* Power-up sequence per GBA TRM 14.0:
     *   1. Turn on master enable.
     *   2. Set DMG-vs-DS volume (we go 100% DMG, no DS).
     *   3. Route all 4 DMG channels to both speakers at max volume. */
    REG_SNDSTAT   = 0x0080;     /* master enable (bit 7) */
    REG_SNDDSCNT  = 0x0002;     /* DMG vol = 100% (bits 0..1 = 0b10) */
    REG_SNDDMGCNT = 0xFF77;     /* NR51 = 0xFF (all 4 chans on L+R),
                                 * NR50 = 0x77 (max master vol L+R) */
}

void sfx_tone(u8 channel, u16 freq_period, u8 length_frames) {
    /* Length register: 64-step countdown. 0 = full duration, 63 = ~3.9ms.
     * NR11/NR21 low 6 bits = (64 - length_frames). */
    u16 len_code = (length_frames >= 63) ? 0 : (u16)(64 - length_frames);
    u16 freq_lo  = (u16)(freq_period & 0x07FF);

    /* SNDxCNT layout:
     *   bits 0..5  = length (NR11 low 6 = 64 - count)
     *   bits 6..7  = duty cycle (0b10 = 50%)
     *   bits 8..10 = envelope step time (0 = no decay)
     *   bit  11    = envelope direction (0 = decrease, here moot)
     *   bits 12..15= initial envelope volume (0xF = max)
     *
     * SNDxFREQ:
     *   bits 0..10 = frequency code
     *   bit  14    = length-enable (channel auto-stops on countdown)
     *   bit  15    = trigger (set to start the note)
     */
    u16 cnt  = (u16)(0xF080 | len_code);      /* full vol + 50% duty + length */
    u16 freq = (u16)(0xC000 | freq_lo);       /* trigger + length-enable + freq */

    if (channel == 1) {
        REG_SND1SWEEP = 0x0000;   /* no sweep */
        REG_SND1CNT   = cnt;
        REG_SND1FREQ  = freq;
    } else if (channel == 2) {
        REG_SND2CNT  = cnt;
        REG_SND2FREQ = freq;
    }
}

void sfx_noise(u8 length_frames) {
    u16 len_code = (length_frames >= 63) ? 0 : (u16)(64 - length_frames);
    /* SND4CNT: same layout as SND1CNT (no duty bits, but they're ignored). */
    REG_SND4CNT  = (u16)(0xF000 | len_code);
    /* SND4FREQ:
     *   bits 0..2  = ratio of frequency divider (0..7)
     *   bit  3     = counter step width (0 = 15-bit / 1 = 7-bit "tinnier")
     *   bits 4..7  = shift clock frequency
     *   bit  14    = length-enable
     *   bit  15    = trigger
     *  0xC033 = trigger + length-enable + mid-pitch white noise. */
    REG_SND4FREQ = 0xC033;
}

/* ── background music: 16-step melody loop on channel 2 ─────────────
 * Mirrors the Genesis/NES example pattern: games get continuous music
 * for free by calling sfx_music_tick() once per frame. The melody is a
 * gentle A-minor arpeggio at reduced envelope volume (0xA of 0xF) so
 * one-shot SFX on channel 1 / noise on 4 read clearly over it.
 * Note values are GBA 11-bit frequency codes: Hz = 131072/(2048-code),
 * code = 2048 - 131072/Hz. 0 = rest. */
static const u16 music_code[16] = {
    1452, 1548, 1651, 1750,   /* A3 C4 E4 A4 */
    1714, 1651, 1548, 0,      /* G4 E4 C4  - */
    1452, 1546, 1620, 1714,   /* A3 C4 D4 G4 */
    1651, 1548, 1452, 0,      /* E4 C4 A3  - */
};
static u8 music_enabled = 1;
static u8 music_step, music_timer;

void sfx_music(u8 on) {
    music_enabled = on;
    music_step = 0;
    music_timer = 0;
    if (!on) REG_SND2CNT = 0x0000;   /* zero envelope = silence now */
}

void sfx_music_tick(void) {
    if (!music_enabled) return;
    if (music_timer == 0) {
        u16 code = music_code[music_step & 15];
        if (code) {
            /* vol 0xA, 50% duty, length 40/64 steps (~156ms) — the
             * length-enable auto-silences before the next note so
             * rests actually rest. */
            REG_SND2CNT  = (u16)(0xA080 | (64 - 40));
            REG_SND2FREQ = (u16)(0xC000 | (code & 0x07FF));
        }
        music_step++;
    }
    music_timer++;
    if (music_timer >= 10) music_timer = 0;   /* 6 notes/sec at 60fps */
}

void sfx_off(void) {
    REG_SNDSTAT = 0x0000;
}

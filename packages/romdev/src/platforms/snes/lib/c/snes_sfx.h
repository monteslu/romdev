/* ── snes_sfx.h — minimal SNES sound + music wrapper ────────────────
 *
 * SNES audio = SPC700 (separate CPU + 64 KB ARAM + 8-channel DSP).
 * The 65816 main CPU has NO direct DSP access — it can ONLY talk to
 * the SPC700 via four I/O ports at $2140-$2143 (also known as
 * APUIO0-3 / REG_APU00-03).
 *
 * To make sound on SNES you need TWO things:
 *   1. An SPC driver program (running on the SPC700, in ARAM).
 *   2. Sample data (BRR-encoded) loaded into ARAM where the driver
 *      knows to look for it.
 *
 * This wrapper takes the simpler path: ship a prebuilt "apu_blob"
 * (driver + sample bank + song table) that gets uploaded to ARAM at
 * $0200 during sfx_init(). Then to trigger sound you write a command
 * byte to $2140 and the driver dispatches.
 *
 * Commands (matching the bundled spc_driver.asm):
 *   0 = no-op / release         (call sfx_release between repeats)
 *   1 = play sample 0 (shoot)   — sfx_play(1)
 *   2 = play sample 1 (explosion) — sfx_play(2)
 *   3 = start music              — sfx_music_play()
 *   4 = stop  music              — sfx_music_stop()
 *
 * Voice assignment in the driver:
 *   Voice 0 = sfx slot (one-shot, retriggered on cmds 1/2)
 *   Voice 1 = music melody (driven by the song table walker, retriggers
 *             on each row at the row's pitch)
 *   Voices 2-7 = unused (room to extend the driver with more channels)
 *
 * The driver uses edge-detection on the command byte — to trigger
 * the same command twice in a row you MUST send 0 (release) first
 * then the real command. All wrapper helpers below handle that for you.
 *
 * Music engine details:
 *   - The bundled song is a 16-step C-major-ish arpeggio (4 bars at
 *     ~115 BPM) hand-authored in apu_blob.asm. It loops forever once
 *     sfx_music_play() is called.
 *   - To replace the song, edit apu_blob.asm's `song:` table (each row
 *     is 3 bytes: duration_ticks at 62.5 Hz, pitch_lo, pitch_hi) and
 *     re-run `node scripts/build-apu-blob.js`.
 *
 * Source files alongside this header:
 *   apu_blob.bin        prebuilt SPC driver + sample bank + song
 *   apu_blob.asm        asar source for the whole payload (driver +
 *                       music engine + song table)
 *   spc_driver.asm      reference copy of the driver only
 *   shoot.brr           BRR-encoded "shoot" sample (also used as the
 *                       instrument waveform for music voice 1)
 *   explosion.brr       BRR-encoded "explosion" sample
 *   sample_bank.bin     directory + samples assembled together
 */

#ifndef SNES_SFX_H
#define SNES_SFX_H

#include <snes/snestypes.h>

/* Call once near the start of main() before any sfx_play(). Uploads
 * the bundled SPC driver + sample bank + song table into ARAM at
 * $0200 and kicks it off running. Takes ~60 ms (~20 KB transferred
 * one byte at a time over the APUIO ports — the SPC's max rate).
 *
 * Returns 0 on success, nonzero if the SPC didn't respond to the
 * boot handshake (usually means the SPC is in a weird state from a
 * previous program — try a hard reset). */
u8 sfx_init(void);

/* Trigger a sound effect. cmd = 1 (shoot) or 2 (explosion); other
 * values are no-ops. The driver auto-resets on cmd=0; this wrapper
 * sends 0 before each non-zero command so back-to-back triggers work. */
void sfx_play(u8 cmd);

/* Send the explicit "release" / no-op (cmd 0). Useful if you've sent
 * a play and want to allow a re-trigger of the SAME sound on the
 * next frame. Most callers won't need this — sfx_play does it
 * automatically. */
void sfx_release(void);

/* Start the bundled music loop on voice 1. Safe to call repeatedly —
 * each call rewinds the song to row 0. */
void sfx_music_play(void);

/* Stop the music (key-off voice 1, halt the row walker). Safe to
 * call when music isn't playing. */
void sfx_music_stop(void);

#endif

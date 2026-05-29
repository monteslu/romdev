/* lynx_music.c — hand-authored music bytestream for cc65's lynx_snd_play.
 *
 * cc65 ships a 4-channel music engine on the Atari Lynx (see
 * build/cc65/src/libsrc/lynx/lynx-snd.s). Driver is started with:
 *
 *     lynx_snd_init();                       // 240Hz IRQ + voice reset
 *     lynx_snd_play(channel, demo_music);    // begin streaming on channel
 *
 * Stream byte format (parsed in SndGetCmd):
 *
 *   byte < $80  → NOTE+LENGTH pair. byte0 is the note index (1..127),
 *                 byte1 is the delay/length in 240Hz ticks. The driver
 *                 looks up note -> prescaler + reload from internal
 *                 tables (SndPrescaler / SndReload in lynx-snd.s). Note 0
 *                 terminates the stream (SndStop). Notes roughly form a
 *                 chromatic scale; ~12-13 = ~middle C, +12 per octave.
 *                 Two bytes consumed.
 *
 *   byte $80..$ff → COMMAND. The low 7 bits index a function table:
 *      $80 SndLoop           start loop (next byte = loop count)
 *      $81 SndDo             end-of-loop marker (jumps back to $80)
 *      $82 SndPause          rest for N ticks (next byte = N)
 *      $83 SndNoteOff        release current note (envelope tail)
 *      $84 SndSetInstr       set channel instrument (5 bytes follow)
 *      $85 SndNewNote2       explicit reload+prescale note (3 bytes)
 *      $86 SndCallPattern    call sub-pattern (2-byte addr)
 *      $87 SndRetToSong      return from sub-pattern
 *      $88..$8d envelope setup (define + select vol/frq/wave)
 *      $8e SndSetStereo      stereo mute mask (1 byte)
 *      $91 SndPlayerFreq     change tempo (2 bytes)
 *      $92 SndReturnAll      end-of-track sentinel
 *
 *   Command's Y register on return tells the driver how many bytes to
 *   advance past (low 7 bits of Y; high bit means "loop again same tick").
 *
 * The demo below plays a short C-major-arpeggio-like motif on one channel
 * so you can audibly verify the driver is wired and the IRQ is firing.
 * Each note is roughly an 8th-note at the default 240Hz player rate.
 *
 * NOTE numbers picked by ear from SndReload table — the driver doesn't
 * publish a "midi number" mapping, so values 24/28/31/36 sit in a
 * comfortable musical range and demonstrate distinct pitches. Adjust
 * freely; values 1..127 are all valid.
 */

#include "lynx_music.h"

/* Non-const because cc65's lynx_snd_play signature wants a writable
 * pointer — see lynx_music.h. The bytes live in ROM (cc65 puts read-
 * only globals there) so attempting to write through this would crash;
 * the cc65 driver never writes, just reads. */
unsigned char demo_music[] = {
  /* note, length(ticks) — length 30 @ 240Hz ≈ 125 ms per note */
  24, 30,   /* low  */
  28, 30,
  31, 30,
  36, 30,   /* high */
  31, 30,
  28, 30,
  24, 60,   /* longer trailing note */
  0x82, 30, /* SndPause: rest 30 ticks before looping the engine restart */
  0         /* SndStop — terminate stream */
};

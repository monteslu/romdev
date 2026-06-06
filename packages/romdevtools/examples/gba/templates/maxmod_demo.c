/* ── maxmod_demo.c — Game Boy Advance maxmod music demo (R34) ───────
 *
 * Plays a CC0 tracker module compiled into a Maxmod soundbank.
 * Demonstrates the canonical Maxmod boot dance:
 *
 *   1. Hook mmVBlank into the VBlank IRQ slot — Maxmod's per-frame
 *      mixer state advance depends on this firing every vblank.
 *   2. Call mmInitDefault(soundbank, channels) once at boot.
 *   3. Call mmFrame() once per frame (anywhere outside the IRQ).
 *   4. mmStart(MOD_<NAME>_FROM_HEADER, mode) to begin playback.
 *
 * Build via romdev:
 *   buildSource({
 *     platform: "gba",
 *     language: "c",
 *     source:   <this file>,
 *     maxmod:   true,
 *     binaryIncludes: { "soundbank.bin": <bytes from chiptune_soundbank.bin> }
 *   })
 *
 * The maxmod link is opt-in via `maxmod: true`. The soundbank.bin must
 * be pre-built on the developer's machine with the bundled host tool:
 *
 *   build/maxmod/host/mmutil chiptune.xm -osoundbank.bin -hsoundbank.h
 *
 * (Source .xm tracker module + Node-based regenerator both live under
 *  src/platforms/gba/lib/maxmod/music/ — see make_chiptune_xm.js. The
 *  buildGbaC layer auto-emits a `.incbin "soundbank.bin"` asm stub
 *  exposing the soundbank under the global symbol `soundbank_bin`.)
 *
 * Why we don't include "soundbank.h" directly: the header just defines
 * MOD_CHIPTUNE = 0 (and similar IDs if more songs are present). We
 * inline the constant below to keep this template self-contained when
 * the user runs mmutil with a different .xm.
 */

#include <tonc.h>
#include <maxmod.h>

/* soundbank_bin is the symbol auto-defined by buildGbaC's incbin stub
 * when binaryIncludes contains "soundbank.bin". Treat it as a generic
 * byte pointer — Maxmod casts it internally. */
extern const u8 soundbank_bin[];

/* Module IDs come from the auto-generated soundbank.h. For the bundled
 * chiptune.xm built by mmutil there is exactly one entry: MOD_CHIPTUNE = 0.
 * Adjust if you regenerate with a differently-named .xm. */
#define MOD_CHIPTUNE 0

int main(void) {
    /* ── IRQ setup ── Maxmod requires mmVBlank() in the VBlank slot.
     * Without this, the mixer DMA buffers never get swapped and audio
     * hard-locks after the first buffer fill. Single most common
     * Maxmod gotcha. */
    irq_init(NULL);
    irq_add(II_VBLANK, mmVBlank);

    /* TTE setup so we can show a status banner. Standard Tonc setup. */
    tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0;

    tte_write("#{P:24,32}");
    tte_write("Maxmod demo");
    tte_write("#{P:24,52}");
    tte_write("music playing");
    tte_write("#{P:24,80}");
    tte_write("Press START to");
    tte_write("#{P:24,96}");
    tte_write("toggle playback");

    /* ── Maxmod boot ─────────────────────────────────────────────────
     * 8 channels is plenty for chip music. The library allocates
     * channel state from its own static pool; mmInitDefault picks
     * sensible defaults for GBA (Direct Sound A, 16384 Hz mix rate). */
    mmInitDefault((mm_addr)soundbank_bin, 8);

    /* Kick off the song in looping mode. */
    mmStart(MOD_CHIPTUNE, MM_PLAY_LOOP);

    int paused = 0;
    int prev_keys = 0;

    while (1) {
        VBlankIntrWait();

        /* Maxmod mixer step — MUST be called once per frame from main
         * context (not from IRQ). The vblank IRQ handler (mmVBlank)
         * only flips the double buffers; the actual song advance + new
         * sample generation happens here. */
        mmFrame();

        /* Edge-detect START to toggle pause. key_poll-based input would
         * also work, but raw REG_KEYS keeps this template's runtime
         * deps to just <maxmod.h> + <tonc.h> with no extra setup. */
        int keys = ~REG_KEYS & KEY_ANY;
        int rising = keys & ~prev_keys;
        if (rising & KEY_START) {
            paused ^= 1;
            if (paused) mmPause();
            else        mmResume();
        }
        prev_keys = keys;
    }
    return 0;
}

/* ── snes_sfx.c — SPC driver uploader + sfx + music dispatch ────────
 *
 * Direct C port of the apu_upload routine from
 * rom-games/snes/invaders/main.asm. The protocol is well-known but
 * timing-sensitive — every byte transfer requires a handshake with
 * the SPC700 driver, which is why it's spelled out byte-by-byte here.
 *
 * Upload protocol (from Nintendo's "Audio Programming Manual"):
 *   1. Wait for SPC to write $AA $BB into ports 0+1 (its boot ROM
 *      handshake — says "I'm ready"). $2140 = $AA, $2141 = $BB.
 *   2. Write destination ARAM address into ports 2+3 ($2142/$2143).
 *   3. Write $01 to $2141 (kick command).
 *   4. Write $CC to $2140 and wait for SPC to echo it back. Now
 *      we're in upload mode.
 *   5. For each byte: write byte to $2141, write index (mod 256) to
 *      $2140, wait for SPC to echo the index.
 *   6. To finish: write final destination into $2142/$2143, $00 into
 *      $2141, then a "kick+2" command into $2140 telling SPC to
 *      jump to the new code.
 *
 * The driver, once running, watches $F4 (= main side's $2140) and
 * dispatches on edge-detected command changes.
 *
 * R46 update: payload size is now read from the linker-defined
 * `apu_blob_end` symbol so the song table can grow without touching
 * this file. The R46 driver added music engine state + an extra
 * voice config (voice 1), bumping the driver from ~150 to ~230 bytes,
 * and song data lives at ARAM $5000 — so the upload payload jumped
 * from 9240 to ~20 KB.
 */

#include "snes_sfx.h"
#include <snes/sound.h>

/* The prebuilt SPC driver + sample bank + song table. Defined in
 * snes_sfx_data.asm via `.incbin "apu_blob.bin"`; the matching end
 * symbol lets us size the upload at runtime. */
extern const u8 apu_blob[];
extern const u8 apu_blob_end[];

#define APU_LOAD_ADDR  0x0200

u8 sfx_init(void) {
    u16 i;
    u16 blob_size = (u16)(apu_blob_end - apu_blob);
    /* Wait for SPC700 boot handshake — it writes $AA into $2140 and
     * $BB into $2141 once its internal ROM finishes initializing. */
    u16 timeout = 0xFFFF;
    while (REG_APU0001 != 0xBBAA) {
        if (--timeout == 0) return 1;
    }

    /* Set destination address, kick command. */
    REG_APU0203 = APU_LOAD_ADDR;
    REG_APU01 = 0x01;

    /* Kick handshake — write $CC to $2140 and wait for echo. */
    REG_APU00 = 0xCC;
    while (REG_APU00 != 0xCC) { /* spin */ }

    /* Transfer apu_blob byte by byte. Index in $2140 doubles as the
     * SPC's "ready for next byte" handshake. */
    for (i = 0; i < blob_size; i++) {
        REG_APU01 = apu_blob[i];
        REG_APU00 = (u8)(i & 0xFF);
        while (REG_APU00 != (u8)(i & 0xFF)) { /* spin */ }
    }

    /* Finish: set entry-point address, $00 in $2141, then "index + 2"
     * in $2140 (must be nonzero — if it would be zero, bump it). */
    REG_APU0203 = APU_LOAD_ADDR;
    REG_APU01 = 0x00;
    u8 jmp_cmd = (u8)((i + 2) & 0xFF);
    if (jmp_cmd == 0) jmp_cmd = 1;
    REG_APU00 = jmp_cmd;
    while (REG_APU00 != jmp_cmd) { /* spin */ }

    return 0;
}

void sfx_release(void) {
    REG_APU00 = 0;
}

void sfx_play(u8 cmd) {
    /* Release first so the driver's edge-detector sees a new event
     * even if the same cmd was sent last call. */
    REG_APU00 = 0;
    REG_APU00 = cmd;
}

void sfx_music_play(void) {
    /* Cmd 3 = start music. Release first for edge-detector. */
    REG_APU00 = 0;
    REG_APU00 = 3;
}

void sfx_music_stop(void) {
    /* Cmd 4 = stop music. */
    REG_APU00 = 0;
    REG_APU00 = 4;
}

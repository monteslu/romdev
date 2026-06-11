/* ── music_demo.c — SNES SPC700 continuous-music demo ──────────────
 *
 * Standalone demo of the R46 music engine in the bundled SPC driver.
 * After sfx_init(), calling sfx_music_play() kicks off a looping
 * 16-step C-major arpeggio on voice 1. Press B to layer the "shoot"
 * sfx (voice 0) on top; press A to stop the music; press START to
 * resume it.
 *
 * What this demonstrates:
 *   - Music engine runs autonomously on the SPC700 once started —
 *     no per-frame work is required from the 65816 side. The 65816
 *     just sends one command byte ($03 = start, $04 = stop) and the
 *     SPC700 walks the song table itself, driven by its own Timer 0.
 *   - SFX and music coexist on separate DSP voices (voice 0 vs 1),
 *     so triggering a shoot doesn't interrupt the melody.
 *
 * Pair with a real BRR instrument sample for proper music tone — the
 * bundled shoot.brr is short and percussive, so the arpeggio sounds
 * chirpy/8-bit. Replace via apu_blob.asm + scripts/build-apu-blob.js.
 *
 * Sibling music_demo-data.asm provides the font stubs (same shape
 * as c-hello-data.asm).
 */

#include <snes.h>
#include "snes_sfx.c"

extern char tilfont, palfont;
extern char tilbg, palbg;       /* wallpaper tile + palette (data.asm) */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* BG1 wallpaper map: a full 32x32 screen of the 4-colour tile so the
 * screen never reads as a flat/blank backdrop. Filled at runtime. */
static u16 bg_map[32 * 32];

int main(void) {
    u16 pad;
    u16 prev = 0;
    u16 frame = 0;
    u8 music_running;
    u16 i;

    /* ── Text-mode setup (PVSnesLib convention) ─────────────────── */
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0000);   /* tile index = (char-0x20); font is at the BG char base */
    consoleInitText(0, 16 * 2, &tilfont, &palfont);
    setMode(BG_MODE1, 0);
    /* consoleInitText DMAs the font but does NOT set the PPU BG base
     * registers — point BG0 at the same font ($3000) + map ($6800). */
    bgSetGfxPtr(0, 0x3000);
    bgSetMapPtr(0, 0x6800, SC_32x32);

    /* BG1 = full-screen wallpaper so the screen never reads as blank.
     * Tiles -> VRAM $2000, map -> VRAM $4000 (clear of the console gfx
     * $3000 / map $6800). Map entries use palette block 1 (0x0400) so the
     * wallpaper palette doesn't disturb the console font palette in block 0
     * (HUD text stays legible). */
    bgInitTileSet(1, (u8 *)&tilbg, (u8 *)&palbg, 1,
                  32, 32, BG_16COLORS, 0x2000);
    for (i = 0; i < 32 * 32; i++) bg_map[i] = 0x0400;
    bgInitMapSet(1, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x4000);
    bgSetEnable(1);
    bgSetDisable(2);

    consoleDrawText( 8, 6,  "SNES MUSIC DEMO");
    consoleDrawText( 3, 11, "B    = SHOOT SFX");
    consoleDrawText( 3, 13, "A    = STOP MUSIC");
    consoleDrawText( 3, 15, "STRT = PLAY MUSIC");

    setScreenOn();

    /* Upload SPC driver + sample bank + song table to ARAM. sfx_init() must
     * run AFTER setScreenOn() (snes_sfx.h:63) — if the SPC stalls before the
     * screen is on you get a black/forced-blank screen forever. */
    sfx_init();

    /* One frame between init and the FIRST command: sfx_init returns the
     * instant the SPC echoes the jump command, but the driver then spends
     * ~50 port writes initialising the DSP BEFORE it seeds its command
     * edge-detector from $2140. A command sent inside that window gets
     * swallowed by the seed — the music silently never starts. */
    WaitForVBlank();

    /* Auto-start music. */
    sfx_music_play();
    music_running = 1;
    consoleDrawText( 8, 20, "MUSIC: PLAYING");

    /* ── Game loop ─────────────────────────────────────────────── */
    while (1) {
        pad = padsCurrent(0);

        if ((pad & KEY_B) && !(prev & KEY_B)) {
            sfx_play(1);
        }
        if ((pad & KEY_A) && !(prev & KEY_A)) {
            sfx_music_stop();
            music_running = 0;
            consoleDrawText( 8, 20, "MUSIC: STOPPED");
        }
        if ((pad & KEY_START) && !(prev & KEY_START)) {
            sfx_music_play();
            music_running = 1;
            consoleDrawText( 8, 20, "MUSIC: PLAYING");
        }
        prev = pad;
        frame++;

        WaitForVBlank();
        consoleVblank();
    }
    return 0;
}

/* ── c-hello.c — minimal PVSnesLib starter ─────────────────────────
 *
 * Tested boots-from-cold game-loop skeleton for SNES C:
 *   - consoleInitText sets up PVSnesLib's text mode against tilfont + palfont
 *   - setMode(BG_MODE1, 0) selects a standard 4-color BG + sprite mix
 *   - consoleDrawText writes ASCII into the configured map at (col, row)
 *   - WaitForVBlank is the canonical PVSnesLib game-loop heartbeat
 *
 * Sibling data.asm provides tilfont + palfont. Real projects replace
 * the stub bytes there with .incbin of a real font asset (gfx4snes
 * converts PNG → .pic + .pal; we don't bundle gfx4snes yet, so a hand-
 * authored .pic + .pal works equivalently).
 *
 * Build via romdev:
 *   build({ output: "rom", 
 *     platform: "snes", language: "c",
 *     sources: {
 *       "main.c":   <this file>,
 *       "data.asm": <sibling>,
 *     },
 *   })
 *
 * Output: ~35 KB SNES LoROM. PVSnesLib runtime (crt0, libm, libtcc,
 * libc) is auto-linked.
 */

#include <snes.h>

extern char tilfont, palfont;
extern char tilbg, palbg;       /* wallpaper tile + palette (data.asm) */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * It has no public prototype in console.h, so declare it here. Call it
 * once per frame (after WaitForVBlank) or via nmiSet(consoleVblank). */
extern void consoleVblank(void);

/* BG1 wallpaper map: a full 32x32 screen of the 4-colour tile so the
 * screen never reads as a flat/blank backdrop. Filled at runtime. */
static u16 bg_map[32 * 32];

int main(void) {
    u16 i;

    /* ── 1. PVSnesLib text-mode setup ─────────────────────────────
     * Map + tile-data + palette-offset addresses are conventions —
     * any free VRAM region will work, these match PVSnesLib's
     * hello_world example layout.
     */
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0000);   /* tile index = (char-0x20); font is at the BG char base */
    consoleInitText(0, 16 * 2, &tilfont, &palfont);

    /* ── 2. Pick a BG mode ────────────────────────────────────────
     * BG_MODE1 = 16-color BG0/BG1 + 4-color BG2. Good default.
     * consoleInitText only DMAs the font/palette to VRAM — it does NOT
     * program the PPU BG base registers, so point BG0 at the same font
     * ($3000) + map ($6800) addresses we gave the console above.
     * Disable BG1 / BG2 since we only use BG0 for text here.
     */
    setMode(BG_MODE1, 0);
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

    /* ── 3. Draw text ─────────────────────────────────────────────
     * consoleDrawText(col, row, str). Coordinates are tile-space
     * (BG_MODE1 BG0 is 32 cols × 28 rows in a 256x224 viewport).
     */
    consoleDrawText(10, 10, "Hello SNES");
    consoleDrawText( 6, 14, "BUILT WITH ROM-DEV-MCP");

    /* ── 4. Turn the screen on ────────────────────────────────────
     * Until setScreenOn fires, the SNES forces blank (INIDISP $80).
     */
    setScreenOn();

    /* ── 5. Game loop ─────────────────────────────────────────────
     * WaitForVBlank is the PVSnesLib heartbeat. Update game state
     * BEFORE the call so the NMI handler's auto-DMA picks up your
     * sprite changes before the next frame draws.
     */
    while (1) {
        WaitForVBlank();
        consoleVblank();   /* flush any consoleDrawText changes to VRAM */
    }
    return 0;
}

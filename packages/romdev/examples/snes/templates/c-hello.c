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
 * Build via rom-dev-mcp:
 *   buildSource({
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

int main(void) {
    /* ── 1. PVSnesLib text-mode setup ─────────────────────────────
     * Map + tile-data + palette-offset addresses are conventions —
     * any free VRAM region will work, these match PVSnesLib's
     * hello_world example layout.
     */
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);

    /* ── 2. Pick a BG mode ────────────────────────────────────────
     * BG_MODE1 = 16-color BG0/BG1 + 4-color BG2. Good default.
     * Disable BG1 / BG2 since we only use BG0 for text here.
     */
    setMode(BG_MODE1, 0);
    bgSetDisable(1);
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
    }
    return 0;
}

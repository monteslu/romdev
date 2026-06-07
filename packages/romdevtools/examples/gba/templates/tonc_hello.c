/* ── tonc_hello.c — Game Boy Advance libtonc starter (TTE) ──────────
 *
 * Idiomatic Tonc-tutorial-style hello world. Uses TTE (Tonc Text
 * Engine) to draw "Hello, Tonc!" on a Mode-0 tile background — the
 * canonical "Hello GBA" pattern from gbadev.net/tonc.
 *
 * Build via romdev:
 *   build({ output: "rom", platform:"gba", language:"c", source: <this file>})
 *
 * (defaults to runtime:"libtonc" — pass {runtime:"libgba"} to use
 *  devkitPro's libgba instead, or {runtime:"none"} for bare gcc.)
 *
 * The bundled libtonc runtime gives you the canonical Tonc-book API:
 *   - <tonc.h>          umbrella header
 *   - REG_DISPCNT, DCNT_MODE0, DCNT_BG0, etc. display registers
 *   - tte_init_chr4c_default()      TTE setup (4bpp char-mode text)
 *   - tte_set_pos(x, y)             cursor positioning
 *   - tte_write(str)                draw text (no format)
 *   - tte_printf(fmt, ...)          formatted output (varargs)
 *   - tonccpy / toncset             VRAM-safe memcpy/memset (16/32-bit)
 *   - REG_KEYS, KEY_A/B/SELECT/START etc.
 *   - VBlankIntrWait()              frame heartbeat
 *
 * ⚠️  One omission: libtonc's `tte_iohook` (auto-routing of printf /
 *    iprintf through TTE via libsysbase) is NOT bundled — same
 *    reason as libgba's console.c. Use `tte_write` / `tte_printf`
 *    directly (which is what every Tonc tutorial actually does
 *    anyway). The Tonc book never says `iprintf` — it says
 *    `tte_printf`. Following that pattern keeps your code portable.
 */

#include <tonc.h>

/* ── Backdrop tiles (4bpp, 8 rows × 32 bits) ─────────────────────────
 * Two solid colour tiles so the whole BG0 map reads as a checkerboard,
 * not a flat blank backdrop. Every nibble of tile 1 = palette index 1,
 * every nibble of tile 2 = palette index 2 — so the tile is one solid
 * colour. (m3_fill's tiled-mode equivalent: paint the whole screen.) */
static const u32 tile_solid1[8] = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
static const u32 tile_solid2[8] = {
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
};

int main(void) {
    /* ── Filled tiled backdrop on BG0 ────────────────────────────
     * Without this the screen is just the black backdrop colour and a
     * few text glyphs — which reads as "blank". We lay a two-tone
     * checkerboard across the entire 32x32 BG0 map so a clear majority
     * of the screen is coloured (the GBA tiled-mode analogue of
     * m3_fill-ing a Mode-3 framebuffer). Tile data → char-block 0,
     * map → screen-block 28 (clear of TTE's char-block 2 / SBB 30). */
    pal_bg_mem[0] = CLR_BLACK;
    pal_bg_mem[1] = RGB15(3, 6, 14);   /* deep sky blue   */
    pal_bg_mem[2] = RGB15(2, 4, 9);    /* darker navy     */
    tonccpy(&tile_mem[0][1], tile_solid1, sizeof(tile_solid1));
    tonccpy(&tile_mem[0][2], tile_solid2, sizeof(tile_solid2));
    REG_BG0CNT = BG_CBB(0) | BG_SBB(28) | BG_REG_32x32 | BG_4BPP | BG_PRIO(3);
    {
        SCR_ENTRY *map = se_mem[28];
        for (int ty = 0; ty < 32; ty++)
            for (int tx = 0; tx < 32; tx++)
                map[ty * 32 + tx] = SE_BUILD(1 + ((tx ^ ty) & 1), 0, 0, 0);
    }

    /* Initialise TTE in 4-bits-per-pixel chr-mode with the built-in
     * sys8 font. Cleanest API in the entire GBA ecosystem — one call
     * gets you a usable text terminal. We put it on BG1 (char-block 2,
     * screen-block 30) so it sits cleanly in front of the BG0 backdrop.
     *
     * NOTE: we deliberately do NOT call tte_init_con() — that lives
     * in the excluded tte_iohook.c (the libsysbase bridge). Without
     * it, printf/iprintf don't route through TTE — but `tte_write` /
     * `tte_printf` work directly without any libsysbase plumbing,
     * which is what the Tonc tutorial uses everywhere anyway. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    REG_BG1CNT |= BG_PRIO(0);          /* text in front of the backdrop */

    /* ── IRQ setup ── REQUIRED for VBlankIntrWait() to work ──────
     * Without this, the BIOS halts the CPU on the first
     * VBlankIntrWait() forever (it waits for an IRQ that never
     * fires). Single most common GBA-Tonc gotcha. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    /* Set DISPCNT — turn on BG0 (the filled backdrop) and BG1 (TTE
     * text). DCNT_MODE0 is the tile-BG mode. */
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1;

    /* Draw text. tte_write moves the internal cursor; \n wraps. */
    tte_write("#{P:32,32}");         /* position cursor at pixel (32,32) */
    tte_write("Hello, Tonc!\n");
    tte_write("Built with romdev\n");

    /* NOTE: tte_printf with a %d/%05d conversion is broken in this libtonc
     * build (it garbles output + can wedge the loop — GBA-1). For dynamic
     * numbers, build the string yourself and tte_write it (see the genre
     * scaffolds' draw_score). For static text just tte_write a literal: */
    tte_write("#{P:32,80}Year: 2026\n");

    /* Game loop. VBlankIntrWait() halts the CPU until next vblank —
     * saves battery on real hardware. */
    while (1) {
        VBlankIntrWait();
    }
    return 0;
}

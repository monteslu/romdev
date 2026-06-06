/* ── tonc_hello.c — Game Boy Advance libtonc starter (TTE) ──────────
 *
 * Idiomatic Tonc-tutorial-style hello world. Uses TTE (Tonc Text
 * Engine) to draw "Hello, Tonc!" on a Mode-0 tile background — the
 * canonical "Hello GBA" pattern from gbadev.net/tonc.
 *
 * Build via romdev:
 *   buildSource({platform:"gba", language:"c", source: <this file>})
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

int main(void) {
    /* Initialise TTE in 4-bits-per-pixel chr-mode with the built-in
     * sys8 font. Cleanest API in the entire GBA ecosystem — one call
     * gets you a usable text terminal on BG0.
     *
     * NOTE: we deliberately do NOT call tte_init_con() — that lives
     * in the excluded tte_iohook.c (the libsysbase bridge). Without
     * it, printf/iprintf don't route through TTE — but `tte_write` /
     * `tte_printf` work directly without any libsysbase plumbing,
     * which is what the Tonc tutorial uses everywhere anyway. */
    tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));

    /* ── IRQ setup ── REQUIRED for VBlankIntrWait() to work ──────
     * Without this, the BIOS halts the CPU on the first
     * VBlankIntrWait() forever (it waits for an IRQ that never
     * fires). Single most common GBA-Tonc gotcha. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    /* Set DISPCNT — turn on BG0 (where TTE drew the font tiles into
     * char-base 0 + screen-base 31). DCNT_MODE0 is the tile-BG mode. */
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0;

    /* Draw text. tte_write moves the internal cursor; \n wraps. */
    tte_write("#{P:32,32}");         /* position cursor at pixel (32,32) */
    tte_write("Hello, Tonc!\n");
    tte_write("Built with romdev\n");

    /* Formatted output without needing iprintf or libsysbase. */
    int year = 2026;
    tte_printf("#{P:32,80}Year: %d\n", year);

    /* Game loop. VBlankIntrWait() halts the CPU until next vblank —
     * saves battery on real hardware. */
    while (1) {
        VBlankIntrWait();
    }
    return 0;
}

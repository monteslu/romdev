/* nmi_handler.c — install a C-level NMI handler for NES.
 *
 * REQUIRES: linkerConfig:"chr-ram" AND `nmi_trampoline.s` (paste both).
 *
 * Pattern: the chr-ram crt0's default `nmi: rti` is overridden by the
 * trampoline .s in this snippet pair, which calls into your C function.
 * The trampoline saves/restores A/X/Y around the call (the C function
 * uses cc65's __fastcall__ convention, which is reg-clobbering).
 *
 * PITFALLS:
 *   - DO NOT include this when also using the chr-ram crt0's default
 *     stub — they both define `nmi:`. The trampoline below assumes
 *     you've also dropped the crt0's `nmi: rti` (or replaced the
 *     whole crt0 with a custom one — see the comments in
 *     src/toolchains/cc65/presets/nes/chr-ram.crt0.s).
 *
 *     Easiest path: don't override the default crt0 here. Instead just
 *     don't include nmi_trampoline.s, and put your "wait for vblank"
 *     pattern in main() using `bit $2002 / bpl` via inline asm or by
 *     polling `*(volatile uint8_t*)0x2002`. The default `nmi: rti`
 *     still fires (so PPU vblank flag DOES tick) — you just won't run
 *     custom code at that moment.
 *
 *   - If you do install a real NMI handler, keep it SHORT. Vblank is
 *     ~2270 cycles; cc65 prologue/epilogue eats ~50; OAM DMA eats 513.
 *     That leaves ~1700 for the rest of your vblank work.
 *
 *   - The `vblank_ready` flag below lets main() wait for the NMI:
 *       while (!vblank_ready) { }
 *       vblank_ready = 0;
 *       // now safe to write PPU regs
 */

#include <stdint.h>

volatile uint8_t vblank_ready;
volatile uint8_t nmi_count;

/* This is the C-side handler the trampoline jumps to. Name + signature
 * are coupled to nmi_trampoline.s — change both together. */
void __fastcall__ nmi_c_main(void) {
    /* 1. OAM DMA: shadow OAM at $0200..$02FF → sprite RAM. 513 cycles. */
    *(volatile uint8_t*)0x2003 = 0;       /* OAMADDR = 0 */
    *(volatile uint8_t*)0x4014 = 0x02;    /* OAMDMA from $0200 */

    /* 2. Bump frame counter and signal main(). */
    nmi_count++;
    vblank_ready = 1;

    /* 3. ADD MORE HERE: palette upload, scroll, nametable updates. */
}

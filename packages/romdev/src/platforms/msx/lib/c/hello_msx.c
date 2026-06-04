/*
 * hello_msx.c — MSX / MSX2 starter (SDCC z80, C89).
 *
 * Boots to a guaranteed-VISIBLE screen by calling the MSX BIOS:
 *   INITXT ($006C) — set the 40-column text screen (mode 0) and clear it.
 *   CHPUT  ($00A2) — print the char in register A at the cursor.
 * C-BIOS (the open MSX BIOS romdev bundles) provides these. No proprietary ROM.
 *
 * Build with the cartridge crt0 (msx_crt0.s), which emits the "AB" ROM header
 * at $4000 and points INIT at this code:
 *   buildSource({ platform:"msx",
 *     sources: { "main.c": <this>, "msx_crt0.s": <the crt0> },
 *     crt0: ".module empty\n" })           // empty stock crt0
 *
 * IMPORTANT — a cartridge INIT routine must NOT return: C-BIOS CALLs INIT to
 * hand the machine to the cart, and if INIT `ret`s the BIOS thinks no bootable
 * cart is present ("No cartridge found"). So main() ends in an infinite loop —
 * the cart keeps control. Don't add a `return` to main.
 *
 * TIMING — C-BIOS shows its logo for ~2-3 seconds (≈150 frames) BEFORE it CALLs
 * the cart INIT. When testing, step at least 240 frames before expecting output.
 */
void main(void) {
    /* INITXT (set + clear the text screen) then walk a string through CHPUT.
     * The message bytes sit inside this same asm block (jumped over) so the
     * label and the print loop share scope and we don't depend on SDCC's
     * stack-frame calling convention. $0D/$0A = CR/LF between the two lines. */
    __asm
        call  0x006C            ; INITXT — 40-col text mode, screen enabled

        ld    hl, #msg$
print_loop$:
        ld    a, (hl)
        or    a, a
        jr    Z, print_done$
        call  0x00A2            ; CHPUT — print char in A
        inc   hl
        jr    print_loop$
msg$:
        .ascii  "HELLO MSX"
        .db     0x0D, 0x0A
        .ascii  "ROMDEV TIER-1"
        .db     0
print_done$:
    __endasm;

    /* A cartridge INIT must never return — keep control forever.
     * A real game would read input + update game state in this loop. */
    for (;;) {
    }
}

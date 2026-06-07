/*
 * hello_pce.c — PC Engine / TurboGrafx-16 starter (cc65, C89).
 *
 * Boots to a guaranteed-VISIBLE screen using cc65's conio (text) library, which
 * initializes the HuC6270 VDC + HuC6260 VCE for you and uploads a font to VRAM.
 * Build with: build({ output: "rom",  platform: "pce" })  (language defaults to C).
 *
 * FOOTGUN — the empty-BSS crt0 trap (cc65 pce/crt0.s line 84):
 *   The PCE crt0 clears .bss with `tii __BSS_RUN__, __BSS_RUN__+1, __BSS_SIZE__-1`.
 *   When your program has NO global/static variables, __BSS_SIZE__ is 0 and the
 *   `- 1` underflows → ld65 throws a "Range error in module pce/crt0.s" and the
 *   ROM boots to a BLACK screen (VDC never initializes). ALWAYS keep at least one
 *   global/static variable so .bss is non-empty. The `_keep_bss` byte below does
 *   exactly that — don't delete it until you have real globals.
 */
#include <conio.h>
#include <pce.h>

/* Keeps .bss non-empty so the crt0 BSS-clear doesn't underflow (see header).
 * Sized > 1 byte: a 1-byte .bss uploads only a partial conio font on some
 * builds; >= 2 bytes is reliably full. Replace with your real game state. */
static unsigned char _keep_bss[4];

void main(void) {
    _keep_bss[0] = 0;

    clrscr();                       /* clear the text plane, enable display */
    gotoxy(8, 12);
    cputs("HELLO PC ENGINE");
    gotoxy(8, 14);
    cputs("ROMDEV TIER-1");

    /* conio left the VDC enabled; just idle so the screen stays up. */
    for (;;) {
        waitvsync();
    }
}

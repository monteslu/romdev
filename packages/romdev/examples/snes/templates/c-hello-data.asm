; ── c-hello-data.asm — stub data symbols for the c-hello template ──
;
; Two symbols required by main.c's consoleInitText call:
;
;   tilfont   — pointer to font tile data (.pic format = wla-dx
;               binary include, 2 KB for a 16x16 ASCII font in 2bpp)
;   palfont   — pointer to font palette data (.pal = 32-byte SNES
;               CGRAM blob: 16 colors × 2 bytes per color in BGR555)
;
; Both stubbed as 8 zero bytes here so the link resolves. Real
; projects replace these stubs with `.incbin "myfont.pic"` and
; `.incbin "myfont.pal"`.
;
; Convert a PNG to .pic + .pal with PVSnesLib's gfx4snes tool (not
; bundled in romdev yet — pre-convert outside the MCP and ship
; the binary artifacts alongside your source).

.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

.ends

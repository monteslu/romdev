; ── music_demo-data.asm — stub data symbols for music_demo ─────────
;
; PVSnesLib's consoleInitText needs tilfont + palfont symbols at link
; time. We stub them as zero bytes here so the link resolves; the SNES
; ROM will boot fine but the text glyphs will render as blank tiles
; until you replace these stubs with real .pic + .pal blobs.
;
; (See examples/snes/templates/c-hello-data.asm for the same pattern.)

.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

.ends

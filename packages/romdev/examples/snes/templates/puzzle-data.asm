; ── puzzle-data.asm — font stubs only ─────────────────────────────
; puzzle.c uses only consoleDrawText, so we don't need sprite tile
; or palette data.
.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

.ends

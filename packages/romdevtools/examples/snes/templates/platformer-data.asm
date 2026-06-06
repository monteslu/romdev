; ── platformer-data.asm — one sprite (player) + font stubs ─────────
.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

tilsprite:
; Tile 0 — player (filled diamond, colour 1)
.db $18, $00, $3C, $00, $7E, $00, $FF, $00
.db $FF, $00, $7E, $00, $3C, $00, $18, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

palsprite:
.db $00, $00          ; 0 transparent
.db $00, $7C          ; 1 red
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

.ends

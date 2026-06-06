; ── sports-data.asm — font + paddle/ball sprite data for sports.c ────
; One sprite tile: a solid 8×8 white block reused for paddles + ball.
.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

tilsprite:
; Tile 0 — solid 8×8 block, colour 1
.db $FF, $00, $FF, $00, $FF, $00, $FF, $00
.db $FF, $00, $FF, $00, $FF, $00, $FF, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

palsprite:
.db $00, $00       ; 0 transparent
.db $FF, $7F       ; 1 white
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

.ends

; ── racing-data.asm — font + player car + enemy car tiles ─────────
.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

tilsprite:
; Tile 0 — player car (colour 1)
.db $3C, $00, $7E, $00, $42, $00, $7E, $00
.db $7E, $00, $42, $00, $7E, $00, $66, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
; Tile 1 — enemy car (colour 2)
.db $00, $3C, $00, $7E, $00, $42, $00, $7E
.db $00, $7E, $00, $42, $00, $7E, $00, $66
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

palsprite:
.db $00, $00       ; 0 transparent
.db $FF, $7F       ; 1 white (player)
.db $00, $7C       ; 2 red (enemy)
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

.ends

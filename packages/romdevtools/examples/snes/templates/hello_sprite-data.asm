; ── hello_sprite-data.asm — symbols required by hello_sprite.c ────
;
; Provides:
;   tilfont   — text-font tile data (stubbed; replace with real .pic)
;   palfont   — text-font palette (stubbed)
;   tilsprite — sprite tile data, one 8×8 4bpp tile (32 bytes), drawn
;               here as a filled diamond using colour 1
;   palsprite — sprite palette, 16 colours × 2 bytes BGR555
;
; SNES 4bpp tile layout is bitplane-interleaved: rows 0-7 store
; planes 0+1 (16 bytes), then rows 0-7 store planes 2+3 (16 bytes).
; For "all colour 1" pixels we want plane 0 = 1, planes 1/2/3 = 0.

.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

tilsprite:
; Plane 0 — diamond shape (colour 1 where bits are set)
.db $18, $00, $3C, $00, $7E, $00, $FF, $00
.db $FF, $00, $7E, $00, $3C, $00, $18, $00
; Plane 1 — zero
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

palsprite:
; BGR555: c=BBBBBGGGGGRRRRR0, 2 bytes little-endian per colour.
; 16 colours = 32 bytes. Colour 0 = transparent; we colour the
; sprite via colour 1 = bright cyan.
.db $00, $00     ; 0 transparent
.db $FF, $7F     ; 1 white-ish
.db $00, $7C     ; 2 red
.db $E0, $03     ; 3 green
.db $1F, $00     ; 4 blue
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

.ends

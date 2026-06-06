; ── default-data.asm — symbols required by default.c ───────────────
;
; Provides:
;   tilsprite — one 8×8 4bpp tile (32 bytes), a filled diamond shape
;   palsprite — sprite palette, 16 colours × 2 bytes BGR555
;
; SNES 4bpp tile layout is bitplane-interleaved:
;   bytes 0-15  = rows 0..7 of planes 0+1 (low/hi pair per row)
;   bytes 16-31 = rows 0..7 of planes 2+3
; "All pixels in colour 1" needs plane 0 = bits set, planes 1/2/3 = 0.

.include "hdr.asm"

.section ".rodata1" superfree

tilsprite:
; Plane 0 — diamond shape (colour 1 where bits are set)
.db $18, $00, $3C, $00, $7E, $00, $FF, $00
.db $FF, $00, $7E, $00, $3C, $00, $18, $00
; Plane 1 — zero
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

palsprite:
; BGR555: c = 0BBBBBGGGGGRRRRR, 2 bytes little-endian per colour.
; 16 colours = 32 bytes. Colour 0 = transparent (skipped by SNES).
.db $00, $00     ; 0 transparent
.db $FF, $7F     ; 1 white  (R=31 G=31 B=31)
.db $00, $7C     ; 2 red
.db $E0, $03     ; 3 green
.db $1F, $00     ; 4 blue
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

.ends

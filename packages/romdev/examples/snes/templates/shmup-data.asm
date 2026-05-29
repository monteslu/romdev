; ── shmup-data.asm — font + 3-sprite blob for shmup.c ─────────────
;
; tilsprite contains three 8×8 4bpp tiles back-to-back:
;   tile 0 (offset 0)  — ship  (palette colour 1, mid-blue)
;   tile 1 (offset 32) — bullet (palette colour 2, yellow)
;   tile 2 (offset 64) — enemy (palette colour 3, red)
;
; Each 8×8 4bpp tile = 32 bytes (4 bitplanes × 8 rows × 1 byte).
; SNES interleaves planes 0+1 first (16 bytes), then 2+3 (16 bytes).

.include "hdr.asm"

.section ".rodata1" superfree

tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

tilsprite:
; Tile 0 — ship (diamond)
.db $18, $00, $3C, $00, $7E, $00, $FF, $00
.db $FF, $00, $7E, $00, $3C, $00, $18, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
; Tile 1 — bullet (small ball, colour 2 → plane 1 set)
.db $00, $18, $00, $3C, $00, $3C, $00, $3C
.db $00, $3C, $00, $3C, $00, $18, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
; Tile 2 — enemy (X shape, colour 3 → planes 0+1 set)
.db $81, $81, $42, $42, $24, $24, $18, $18
.db $18, $18, $24, $24, $42, $42, $81, $81
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

palsprite:
.db $00, $00          ; 0 transparent
.db $1F, $7C          ; 1 mid-blue (ship)
.db $E0, $03          ; 2 yellow   (bullet)
.db $00, $7C          ; 3 red      (enemy)
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

.ends

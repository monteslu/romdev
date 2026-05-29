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

; ⚠ KNOWN ISSUE (text-BG HUD): this is a STUB font. consoleInitText DMAs
; 3072 bytes from here into VRAM; with only a stub, it reads past into
; adjacent data → a garbage font → the text BG shows a junk checkerboard
; AND the HUD text is unreadable. The real fix is to ship PVSnesLib's
; open-source bitmap font: convert pvsneslibfont.png with gfx2snes and
; `.incbin "pvsneslibfont.pic"` / `.pal` here (see the official PVSnesLib
; hello_world example). Tracked as R7(c) follow-up. The GAME itself
; (sprites, motion, input, collision, sound) renders + plays correctly;
; only the on-BG HUD text is affected.
tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0

; HUD font palette — colour 1 = white so consoleDrawText() is VISIBLE
; once a real font is dropped in above.
palfont:
.db $00, $00          ; 0 transparent (BG shows through)
.db $FF, $7F          ; 1 white (text)
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00

tilsprite:
; Tile 0 — ship (cannon: wide base + central barrel, reads as a player)
.db $18, $00, $18, $00, $18, $00, $3C, $00
.db $7E, $00, $FF, $00, $FF, $00, $E7, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
; Tile 1 — bullet (vertical bolt, colour 2 → plane 1 set)
.db $00, $18, $00, $18, $00, $3C, $00, $3C
.db $00, $3C, $00, $3C, $00, $18, $00, $18
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
; Tile 2 — enemy (classic invader silhouette, colour 3 → planes 0+1)
.db $24, $24, $7E, $7E, $DB, $DB, $FF, $FF
.db $FF, $FF, $5A, $5A, $24, $24, $42, $42
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

palsprite:
.db $00, $00          ; 0 transparent
.db $1F, $7E          ; 1 cyan-blue (ship)
.db $E0, $03          ; 2 yellow    (bullet)
.db $1F, $00          ; 3 green     (enemy — classic invader green)
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00
.db $00, $00, $00, $00, $00, $00, $00, $00

.ends

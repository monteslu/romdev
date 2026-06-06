; NES — upload 32 palette bytes from a table to PPU $3F00.
;
; Pass the table address in A (low) / Y (high) via your own caller —
; simpler version below assumes a fixed label `palette_data`.
;
; The 32 bytes cover: 1 universal BG + 4 BG palettes × 4 entries + 4
; sprite palettes × 4 entries (note: each palette's entry 0 mirrors the
; universal BG).
;
; Disable rendering ($2001=0) before calling this if not during vblank.

.proc load_palette
  lda #$3f
  sta $2006
  lda #$00
  sta $2006
  ldx #0
@loop:
  lda palette_data, x
  sta $2007
  inx
  cpx #32
  bne @loop
  rts
.endproc

; You provide:
;   palette_data:
;     .byte $0F, $00, $10, $30   ; BG palette 0
;     .byte $0F, ...
;     ...

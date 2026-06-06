; NES — fill nametable 0 ($2000-$23FF) with a single tile, plus zero out
; the attribute table ($23C0-$23FF).
;
; Pass the fill tile in A. Disable rendering before calling, or call
; during vblank.

.proc clear_nametable
  pha             ; save fill tile
  lda #$20
  sta $2006
  lda #$00
  sta $2006

  pla             ; restore fill tile
  ldx #4          ; 4 outer iterations × 256 inner = 1024 writes
  ldy #0
@row:
@col:
  sta $2007
  iny
  bne @col
  dex
  bne @row

  ; zero the attribute table (last 64 bytes of the 1KB region we just filled)
  ; but we just wrote past it, so write attributes again starting at $23C0
  lda #$23
  sta $2006
  lda #$c0
  sta $2006
  ldx #64
  lda #0
@attr:
  sta $2007
  dex
  bne @attr
  rts
.endproc

; NES — move all 64 sprites off-screen by setting their Y coords to $FF.
;
; Call during init, before you start placing real sprites in the shadow
; OAM. Without this, the OAM starts in whatever random state RAM came up
; in, and you get garbage sprites at frame 0.

.proc clear_oam
  lda #$ff
  ldx #0
@loop:
  sta $0200, x    ; Y position for sprite 0..63
  inx
  inx             ; skip tile/attr/x — only writing Y
  inx
  inx
  bne @loop
  rts
.endproc

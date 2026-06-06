; NES — read controller 1 into the keydown byte.
;
; After calling read_pad, keydown holds the button state:
;   bit 7 = A     bit 6 = B     bit 5 = Select  bit 4 = Start
;   bit 3 = Up    bit 2 = Down  bit 1 = Left    bit 0 = Right
;
; Also computes keynew = buttons newly pressed this frame
; (useful for one-shot events like jump-on-tap, menu confirm).
;
; Requires these zeropage variables (declare in your own .segment "ZEROPAGE"):
;   keydown: .res 1
;   keylast: .res 1
;   keynew:  .res 1
;
; Uses a counted 8-iteration loop — the seed-bit-through-rol idiom is
; fragile and platform-dependent; this is the safe version.

JOY1 = $4016

.proc read_pad
  lda keydown
  sta keylast

  ; Strobe: write 1 then 0 to $4016 to latch the current button state.
  lda #1
  sta JOY1
  lda #0
  sta JOY1

  ; Read 8 bits, one per loop iteration. Each $4016 read returns the
  ; next button in bit 0; we shift that bit into keydown via carry.
  ldx #8
@loop:
  lda JOY1
  lsr a            ; bit 0 -> carry
  rol keydown      ; carry -> bit 0 of keydown; high bits shift up
  dex
  bne @loop

  ; keynew = (NOT keylast) AND keydown -> buttons pressed THIS frame only
  lda keylast
  eor #$ff
  and keydown
  sta keynew
  rts
.endproc

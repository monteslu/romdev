; NES — standard reset routine.
;
; Sets up the CPU + APU + PPU to a known clean state. Standard idiom every
; NES game uses; copy this verbatim into a new project's reset handler and
; call your init code at the end.

.proc reset_init
  sei             ; disable IRQs
  cld             ; clear decimal mode (NES 2A03 doesn't support BCD anyway)
  ldx #$40
  stx $4017       ; disable APU frame IRQ
  ldx #$ff
  txs             ; stack at $01FF
  inx             ; X = 0
  stx $2000       ; disable NMI
  stx $2001       ; disable rendering
  stx $4010       ; disable DMC IRQ

  ; wait for first vblank
@v1:
  bit $2002
  bpl @v1

  ; zero RAM ($0000-$07FF), set OAM shadow ($0200-$02FF) to Y=$FF off-screen
  ldx #0
@clrmem:
  lda #0
  sta $0000, x
  sta $0100, x
  sta $0300, x
  sta $0400, x
  sta $0500, x
  sta $0600, x
  sta $0700, x
  lda #$ff
  sta $0200, x
  inx
  bne @clrmem

  ; wait for second vblank — PPU is fully warm now
@v2:
  bit $2002
  bpl @v2

  rts             ; caller turns on rendering when ready
.endproc

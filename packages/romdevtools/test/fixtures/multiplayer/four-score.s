; Native NES Four Score fixture. Only $4016/$4017 provide game input.
; $0300-$0303: pads, $0304-$0305: signatures, $0308-$030B: positions.
; $030C: completed game tick; four independently moving colored sprites.
.segment "HEADER"
.byte $4e,$45,$53,$1a,2,1,1,0,0,0,0,0,0,0,0,0
.segment "CODE"
reset:
 sei
 cld
 ldx #$ff
 txs
 lda #0
 sta $2000
 sta $2001
 sta $4010
 sta $4015
 sta $4017
 bit $2002
@v1: bit $2002
 bpl @v1
@v2: bit $2002
 bpl @v2
 lda #0
 ldx #0
@clear:
 sta $0000,x
 sta $0100,x
 sta $0300,x
 sta $0400,x
 sta $0500,x
 sta $0600,x
 sta $0700,x
 lda #$ff
 sta $0200,x
 lda #0
 inx
 bne @clear
 lda #$20
 sta $2006
 lda #0
 sta $2006
 ldx #4
 ldy #0
@nt: sta $2007
 iny
 bne @nt
 dex
 bne @nt
 lda #$3f
 sta $2006
 lda #0
 sta $2006
 ldx #0
@pal: lda palette,x
 sta $2007
 inx
 cpx #32
 bne @pal
 ldx #0
@pos:
 lda positions,x
 sta $0308,x
 inx
 cpx #4
 bne @pos
 lda #$80
 sta $2000
 lda #$1e
 sta $2001
@tick:
 lda $00
@wait: cmp $00
 beq @wait
 lda #1
 sta $4016
 lda #0
 sta $4016
 sta $0300
 sta $0301
 sta $0302
 sta $0303
 sta $0304
 sta $0305
 ldx #8
@pads12:
 lda $4016
 lsr
 ror $0300
 lda $4017
 lsr
 ror $0301
 dex
 bne @pads12
 ldx #8
@pads34:
 lda $4016
 lsr
 ror $0302
 lda $4017
 lsr
 ror $0303
 dex
 bne @pads34
 ldx #8
@sig:
 lda $4016
 lsr
 ror $0304
 lda $4017
 lsr
 ror $0305
 dex
 bne @sig
 ldx #0
@move:
 lda $0300,x
 and #$80
 beq @left
 inc $0308,x
@left:
 lda $0300,x
 and #$40
 beq @sound
 dec $0308,x
@sound:
 ; An active A pad also drives the pulse channel for audio replay checks.
 lda $0300,x
 and #1
 beq @next
 lda #1
 sta $4015
 lda #$bf
 sta $4000
 lda #$30
 sta $4002
 lda #8
 sta $4003
@next:
 inx
 cpx #4
 bne @move
 ldx #0
 ldy #0
@draw:
 lda rows,x
 sta $0200,y
 lda #1
 sta $0201,y
 txa
 sta $0202,y
 lda $0308,x
 sta $0203,y
 iny
 iny
 iny
 iny
 inx
 cpx #4
 bne @draw
 lda $9ff0
 sta $0310
 inc $030c
 jmp @tick
nmi:
 pha
 lda #0
 sta $2003
 lda #2
 sta $4014
 lda #0
 sta $2005
 sta $2005
 inc $00
 pla
 rti
irq: rti
palette:
.byte $0f,$00,$00,$00,$0f,$00,$00,$00,$0f,$00,$00,$00,$0f,$00,$00,$00
.byte $0f,$2c,$3c,$1c,$0f,$28,$38,$18,$0f,$24,$34,$14,$0f,$2a,$3a,$1a
positions: .byte 48,80,112,144
rows: .byte 40,72,104,136
.segment "VECTORS"
.word nmi,reset,irq
.segment "CHARS"
.res 16,0
.byte $ff,$ff,$ff,$ff,$ff,$ff,$ff,$ff
.res 8,0
.res 8192-32,0

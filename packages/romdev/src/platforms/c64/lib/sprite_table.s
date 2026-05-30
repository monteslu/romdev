; ── Sprite setup helper ─────────────────────────────────────────────
; Loads sprite pixel pointers, positions, enables, and colors for all 8
; hardware MOBs. Each sprite has 64 bytes of pixel data (24×21, 3 bytes
; per row × 21 rows + padding); the high byte of its data address (÷64)
; goes in screen[$3F8 + N].
;
; Example layout assumed: sprite N data at $2000 + N * $40.
;   → pointer byte = ($2000 / 64) + N = $80 + N

.export _sprite_table_init

VIC_SPR_ENA   = $D015
VIC_SPR_X(N)  = ($D000 + 2*(N))
VIC_SPR_Y(N)  = ($D001 + 2*(N))
VIC_SPR_COL_BASE = $D027
SCREEN_RAM    = $0400
SPRITE_PTRS   = $07F8           ; screen RAM + $3F8

.proc _sprite_table_init
    ; Point each sprite at its data block ($2000 + N*$40).
    LDX #0
:   TXA
    CLC
    ADC #$80                    ; $2000 / 64 = $80
    STA SPRITE_PTRS,X
    INX
    CPX #8
    BNE :-

    ; Set sprite positions in a horizontal line.
    LDA #50                     ; Y for all
    STA VIC_SPR_Y(0)
    STA VIC_SPR_Y(1)
    STA VIC_SPR_Y(2)
    STA VIC_SPR_Y(3)
    STA VIC_SPR_Y(4)
    STA VIC_SPR_Y(5)
    STA VIC_SPR_Y(6)
    STA VIC_SPR_Y(7)

    LDA #24                     ; X start, sprites at 24, 48, 72...
    STA VIC_SPR_X(0)
    CLC
    ADC #24
    STA VIC_SPR_X(1)
    ADC #24
    STA VIC_SPR_X(2)
    ADC #24
    STA VIC_SPR_X(3)
    ADC #24
    STA VIC_SPR_X(4)
    ADC #24
    STA VIC_SPR_X(5)
    ADC #24
    STA VIC_SPR_X(6)
    ADC #24
    STA VIC_SPR_X(7)

    ; Colors: cycle through 8 of the 16 palette entries.
    LDX #0
:   TXA
    AND #$0F
    STA VIC_SPR_COL_BASE,X
    INX
    CPX #8
    BNE :-

    ; Enable all 8 sprites.
    LDA #$FF
    STA VIC_SPR_ENA

    RTS
.endproc

; ── Minimal VIC-II init ─────────────────────────────────────────────
; Call from your reset / main entry. Black border + dark-blue background,
; clear screen + color RAM, enable display.
;
; Assumes VIC bank 0 (default) → screen at $0400, char ROM at $1000.

.export _vic_init

VIC_BORDER  = $D020
VIC_BG0     = $D021
VIC_CTRL1   = $D011
SCREEN_RAM  = $0400
COLOR_RAM   = $D800

.proc _vic_init
    ; Border + background.
    LDA #$00
    STA VIC_BORDER          ; black border
    LDA #$06
    STA VIC_BG0             ; blue background

    ; Clear screen RAM (40×25 = 1000 bytes; round up to 1024).
    LDX #0
    LDA #$20                 ; PETSCII space (in screen-code: $20)
:   STA SCREEN_RAM + $000,X
    STA SCREEN_RAM + $100,X
    STA SCREEN_RAM + $200,X
    STA SCREEN_RAM + $300,X
    INX
    BNE :-

    ; Color RAM = light-blue (14) so any text we draw is readable.
    LDX #0
    LDA #14
:   STA COLOR_RAM + $000,X
    STA COLOR_RAM + $100,X
    STA COLOR_RAM + $200,X
    STA COLOR_RAM + $300,X
    INX
    BNE :-

    ; Enable display: bit 4 = DEN (display enable), bit 3 = 25 rows.
    LDA #%00011011           ; $1B = DEN + 25-row + bitmap-off + y-scroll=3
    STA VIC_CTRL1

    RTS
.endproc

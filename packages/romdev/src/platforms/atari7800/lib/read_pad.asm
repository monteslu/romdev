; ── Read 7800 joystick + fire buttons ──────────────────────────────
; The 7800 ports work via RIOT just like the 2600 PLUS analog inputs:
;   SWCHA ($280)    — directional bits (active-low) for both sticks
;   INPT0-3 ($08-$0B) — analog input dump (latched paddles, etc.)
;   INPT4-5 ($0C-$0D) — digital fire button (active-low)
;
; 7800 ProLine controllers have TWO fire buttons. The right button
; appears on INPT0/INPT2 (or INPT1/INPT3 depending on the port — INPTCTRL
; selects between 2-button and 1-button modes).

.include "maria_registers.h"

JOY0_STATE = $90        ; bits 7-4 = right/left/down/up (active-low cleared)
JOY1_STATE = $91
FIRE0_R    = $92        ; bit 7 = right-fire pressed
FIRE0_L    = $93        ; bit 7 = left-fire pressed
FIRE1_R    = $94
FIRE1_L    = $95

.proc read_pad
    LDA SWCHA
    PHA
    AND #$F0            ; upper nibble = joystick 0
    EOR #$F0            ; invert → 1 = direction held
    STA JOY0_STATE

    PLA
    AND #$0F            ; lower nibble = joystick 1
    ASL                 ; shift to upper for symmetric storage
    ASL
    ASL
    ASL
    EOR #$F0
    STA JOY1_STATE

    ; Digital fire buttons (INPT4 = stick 0, INPT5 = stick 1).
    ; Active-low, so EOR to flip sense.
    LDA $0C
    EOR #$80
    STA FIRE0_R

    LDA $0D
    EOR #$80
    STA FIRE1_R

    ; Left-fire on 7800 ProLine — read from INPT0 / INPT2 (latched analog).
    ; INPTCTRL=$01 at boot routes "2-button" mode. Bit 7 = button.
    LDA $08
    EOR #$80
    STA FIRE0_L

    LDA $0A
    EOR #$80
    STA FIRE1_L

    RTS
.endproc

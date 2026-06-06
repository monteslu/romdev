; SMS joypad read.
;
; Port $DC = controller port A (P1 directions + buttons 1+2, P2 D-pad).
; Port $DD = controller port B (P2 buttons + reset/cart inserted bits).
;
; Bit layout for port $DC (active LOW — pressed = 0):
;   bit 0  P1 up
;   bit 1  P1 down
;   bit 2  P1 left
;   bit 3  P1 right
;   bit 4  P1 button 1 (TL)
;   bit 5  P1 button 2 (TR)
;   bit 6  P2 up
;   bit 7  P2 down
;
; This routine reads $DC, inverts (so pressed = 1), and stores into
; (_p1_state). The agent can then test individual bits.

JOY_PORT_A equ $DC
JOY_PORT_B equ $DD

joypad_read:
        in a,(JOY_PORT_A)
        cpl                      ; invert: pressed=1
        ld (_p1_state),a
        in a,(JOY_PORT_B)
        cpl
        ld (_p2_state),a
        ret

; Convenience masks — combine into your own test code as needed:
JOY_UP    equ $01
JOY_DOWN  equ $02
JOY_LEFT  equ $04
JOY_RIGHT equ $08
JOY_B1    equ $10
JOY_B2    equ $20

_p1_state .equ $C010
_p2_state .equ $C011

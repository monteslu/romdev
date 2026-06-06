; ── Read joystick 2 (CIA1 port A) ───────────────────────────────────
; Joystick 2 (the "main" game port on the right) lives on CIA1 PRA at
; $DC00. Active-low, so a pressed direction reads as 0.
;
;   bit 0 = up
;   bit 1 = down
;   bit 2 = left
;   bit 3 = right
;   bit 4 = fire
;
; Returns inverted bits in A (1 = pressed).
;
; CAVEAT: reading $DC00 also reads keyboard col 0. To get a clean joystick
; read without keyboard interference, write $FF to CIA1 DDRA first.

.export _read_joystick

CIA1_PRA   = $DC00
CIA1_DDRA  = $DC02

.proc _read_joystick
    LDA #$FF
    STA CIA1_DDRA          ; port A all-input (joystick mode)
    LDA CIA1_PRA
    EOR #$FF               ; invert: 1 = pressed
    AND #$1F               ; mask: only directions + fire
    RTS
.endproc

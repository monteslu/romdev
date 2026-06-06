; Game Boy joypad read.
;
; Port $FF00 (JOYP) layout:
;   bit 5: select button group ($00 = buttons A/B/Sel/Start, $10 = D-pad)
;   bit 4: select D-pad group  ($00 selects, $10 deselects)
;   bits 0-3: 4 buttons in the selected group (ACTIVE LOW — pressed = 0)
;
; To read both groups, write the selector, read $FF00 twice (small wait
; for the contacts to stabilize), combine into one byte. Result format:
;   bit 0: A
;   bit 1: B
;   bit 2: Select
;   bit 3: Start
;   bit 4: Right
;   bit 5: Left
;   bit 6: Up
;   bit 7: Down
; (pressed = 1 after inversion)

joypad_read::
  ; Select button group: bit 5 = 0, bit 4 = 1.
  ld a, $10
  ld [$FF00], a
  ld a, [$FF00]
  ld a, [$FF00]       ; second read — bouncing tolerance
  cpl                 ; invert: pressed = 1
  and $0F             ; keep only the 4 button bits
  swap a              ; move buttons to high nybble
  ld b, a             ; stash in B

  ; Select D-pad group: bit 4 = 0, bit 5 = 1.
  ld a, $20
  ld [$FF00], a
  ld a, [$FF00]
  ld a, [$FF00]
  cpl
  and $0F             ; D-pad bits in low nybble
  or b                ; combine: high = buttons, low = D-pad
  ld [JoypadState], a

  ; Reset the matrix to inactive state.
  ld a, $30
  ld [$FF00], a
  ret

SECTION "JoypadState", HRAM
JoypadState:: ds 1

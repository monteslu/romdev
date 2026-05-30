; ── Single-player kernel — render an 8x16 sprite via GRP0 ─────────
; Shows the minimal pattern: load sprite bytes from a table during the
; visible kernel, WSYNC between lines. Position the player with RESP0
; (cycle-counted) before the first visible line.
;
; ── COPY-PASTE TEMPLATE, not a linkable module ─────────────────────
; No `org` directives here on purpose — they'd collide with your main
; ROM layout ("Origin Reverse-indexed") when dasm builds the flat ROM.
; Inline the routines + PLAYER_SHAPE table into your own source where
; you want them. Your kernel_skeleton.asm owns the org $F000 / $FFFA.
;
; Usage: inline after vcs_constants.h, JSR PLAYER_INIT once after RAM
; clear, then call PLAYER_FRAME from inside the visible kernel.

  ; --- player position byte lives in zp at $80 (player X 0-159) ---
PLAYER_X equ $80
PLAYER_Y equ $81  ; top scanline (0-191)

  ; --- sprite data (8 rows × 1 byte each) — place in your data area
PLAYER_SHAPE:
  .byte %00111100
  .byte %01111110
  .byte %11011011
  .byte %11111111
  .byte %11111111
  .byte %11011011
  .byte %01100110
  .byte %01000010

PLAYER_INIT:
  ; Default position: roughly center.
  LDA #80
  STA PLAYER_X
  LDA #90
  STA PLAYER_Y
  RTS

; ── POS_OBJ_P0 — coarse + fine horizontal position for P0 ──────────
; Call with the target X column 0..159 in A. This is the canonical
; "burn cycles equivalent to (X/15) and use the remainder for HMOVE
; fine adjust" 2600 technique. Same shape works for P1/M0/M1/BL —
; replace RESP0/HMP0 with the equivalent register pair.
;
; Cost: ~12-90 cycles depending on X, plus 3 WSYNCs (~228 cycles
; total in the worst case). Always call inside VBLANK, never inside
; the visible kernel.
;
; CRITICAL: the SBC #15 loop terminates ONLY when the carry clears;
; if you forget the SEC before .loop you get an infinite loop. The
; EOR #$07 + 4× ASL converts the remainder to the HMP0 nibble format
; (high nibble is signed -8..+7 in 2's-complement-ish form, stored
; pre-shifted in the high byte).
POS_OBJ_P0:
  STA WSYNC          ; sync to line start so timing is deterministic
  SEC                ; carry SET before SBC chain
.loop:
  SBC #15            ; burn 15-cycle chunks
  BCS .loop          ; until we go negative
  EOR #$07           ; convert -1..-15 remainder to HMP0 nibble
  ASL
  ASL
  ASL
  ASL
  STA RESP0          ; coarse position (whatever column we're at now)
  STA HMP0           ; fine adjust amount
  STA WSYNC          ; let RESP0 settle
  STA HMOVE          ; apply fine adjust
  STA WSYNC
  STA HMCLR          ; clear HMP0 so next line doesn't drift
  RTS

; PLAYER_FRAME — call inside the visible-kernel loop. X holds line index.
PLAYER_FRAME:
  ; Is this line within the player sprite range?
  TXA
  SEC
  SBC PLAYER_Y
  CMP #8
  BCS .blank          ; outside sprite: blank GRP0
  TAY
  LDA PLAYER_SHAPE,Y
  STA GRP0
  RTS
.blank:
  LDA #0
  STA GRP0
  RTS

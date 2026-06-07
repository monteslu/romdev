; ── Hello, Atari 2600 ──────────────────────────────────────────────
; A complete 4 KB cart: blue background, single player sprite at center,
; standard NTSC frame timing (3 vsync + 37 vblank + 192 visible + 30
; overscan). Read joystick to move the sprite.
;
; Build: build({ output: "rom",  platform: "atari2600", source: <this file> })

  processor 6502
  org $F000

; ── TIA register equates ───────────────────────────────────────────
VSYNC    = $00
VBLANK   = $01
WSYNC    = $02
COLUP0   = $06
COLUBK   = $09
PF1      = $0E
RESP0    = $10
GRP0     = $1B
HMOVE    = $2A
HMP0     = $20
SWCHA    = $280
INPT4    = $3C

; ── Zero-page state ────────────────────────────────────────────────
P_X      = $80      ; player X (column 0-159)
P_Y      = $81      ; player top scanline (0-191)
FRAME    = $82      ; frame counter

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clr:
  STA $00,X
  DEX
  BNE .clr

  LDA #80
  STA P_X
  LDA #90
  STA P_Y
  LDA #$80       ; blue background
  STA COLUBK
  LDA #$0F       ; white player
  STA COLUP0

MAIN:
  INC FRAME

  ; ── VSYNC (3 lines) ────────────────────────────────────────────
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC

  ; ── VBLANK (37 lines) — game logic here ───────────────────────
  LDA #2
  STA VBLANK
  LDX #37
.vb:
  STA WSYNC
  DEX
  BNE .vb

  ; Read joystick and adjust P_X / P_Y (every 4th frame to throttle).
  LDA FRAME
  AND #$03
  BNE .skip_move
  LDA SWCHA
  ASL              ; right
  BCS .nr
  INC P_X
.nr:
  ASL              ; left
  BCS .nl
  DEC P_X
.nl:
  ASL              ; down
  BCS .nd
  INC P_Y
.nd:
  ASL              ; up
  BCS .nu
  DEC P_Y
.nu:
.skip_move:

  LDA #0
  STA VBLANK

  ; ── Visible (192 lines) ─────────────────────────────────────────
  LDX #192
.draw:
  STA WSYNC
  TXA
  SEC
  SBC P_Y
  CMP #8
  BCS .blank
  TAY
  LDA SPRITE,Y
  STA GRP0
  JMP .next
.blank:
  LDA #0
  STA GRP0
.next:
  DEX
  BNE .draw

  ; ── Overscan (30 lines) ─────────────────────────────────────────
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

  ; ── Sprite shape (8 rows × 1 byte each) ─────────────────────────
SPRITE:
  .byte %00111100
  .byte %01111110
  .byte %11011011
  .byte %11111111
  .byte %11111111
  .byte %11011011
  .byte %01100110
  .byte %01000010

  ; ── Vector table ────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

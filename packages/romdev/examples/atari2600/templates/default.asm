; ── Hello, Atari 2600 ──────────────────────────────────────────────
; A complete 4 KB cart: blue background, single player sprite at center,
; standard NTSC frame timing (3 vsync + 37 vblank + 192 visible + 30
; overscan). Read joystick to move the sprite.
;
; Build: buildSource({ platform: "atari2600", source: <this file> })

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
; ── TIA audio (R41) ────────────────────────────────────────────────
AUDC0    = $15      ; channel 0 waveform/distortion (0..15)
AUDF0    = $17      ; channel 0 frequency divider (0..31)
AUDV0    = $19      ; channel 0 volume (0..15)

; ── Zero-page state ────────────────────────────────────────────────
P_X      = $80      ; player X (column 0-159)
P_Y      = $81      ; player top scanline (0-191)
FRAME    = $82      ; frame counter
SFX_LEFT = $83      ; frames remaining on the active sfx (0 = silent)

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

  ; ── Boot chime (~250 ms) so it's obvious audio is wired ─────────
  ; AUDC0 = $04 = pure tone. AUDF0 = $0C = mid pitch. AUDV0 = $0F = max.
  ; SFX_LEFT counts frames; sfx_update (in VBLANK) silences when 0.
  LDA #$04
  STA AUDC0
  LDA #$0C
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #15
  STA SFX_LEFT

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

  ; ── Fire button click (INPT4 bit 7 = joy 1 button, active LOW) ──
  LDA INPT4
  BMI .no_fire        ; bit 7 set = released
  ; Trigger a short click whenever the button is held.
  LDA #$04
  STA AUDC0
  LDA #$06          ; higher pitch than boot
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #4
  STA SFX_LEFT
.no_fire:

  ; ── sfx_update: decrement SFX_LEFT, silence on zero ─────────────
  LDA SFX_LEFT
  BEQ .sfx_done
  DEC SFX_LEFT
  BNE .sfx_done
  LDA #0
  STA AUDV0
.sfx_done:

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

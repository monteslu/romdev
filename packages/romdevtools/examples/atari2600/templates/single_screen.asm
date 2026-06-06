; ── single_screen.asm — Atari 2600 dodge-the-falling-pixels scaffold ──
;
; Player sprite at the bottom of the screen, falling "rocks" (use
; missile M0) from the top. Joystick port A moves left/right. Goal:
; avoid the rocks.
;
; Demonstrates per-frame missile re-positioning (the rock) + boundary
; logic + simple "score counter" stored in zero page (rendered as
; foreground colour change — bright = high score).
;
; Why missiles for rocks? 2600's P0 is already the player; M0 (missile
; 0) is a 1-bit-wide 1-8-pixel-wide alternative graphics object that
; shares P0's colour. Perfect for small enemies / projectiles.

  processor 6502
  org $F000

VSYNC    = $00
VBLANK   = $01
WSYNC    = $02
COLUP0   = $06
COLUBK   = $09
RESP0    = $10
RESM0    = $11
GRP0     = $1B
ENAM0    = $1D
HMP0     = $20
HMM0     = $22
HMOVE    = $2A
SWCHA    = $280
NUSIZ0   = $04
; TIA audio (R41)
AUDC0    = $15
AUDF0    = $17
AUDV0    = $19

; Zero page
P_X      = $80
P_Y      = $81
ROCK_X   = $82
ROCK_Y   = $83
FRAME    = $84
SCORE    = $85          ; survive-frames / 60
SFX_LEFT = $86          ; frames remaining on active sfx

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
  LDA #160               ; near bottom
  STA P_Y
  LDA #40
  STA ROCK_X
  LDA #20
  STA ROCK_Y
  LDA #$80               ; blue bg
  STA COLUBK
  LDA #$0F               ; white
  STA COLUP0
  LDA #5                 ; missile = 2-pixel-wide
  STA NUSIZ0

  ; Boot chime — confirms TIA audio is wired.
  LDA #$04
  STA AUDC0
  LDA #$0C
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #20
  STA SFX_LEFT

MAIN:
  INC FRAME

  ; VSYNC
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC

  ; VBLANK 37
  LDA #2
  STA VBLANK
  LDX #37
.vb:
  STA WSYNC
  DEX
  BNE .vb

  ; Input — every 2nd frame
  LDA FRAME
  AND #$01
  BNE .skipmove
  LDA SWCHA
  ASL                    ; right
  BCS .nr
  INC P_X
  INC P_X
.nr:
  ASL                    ; left
  BCS .nl
  DEC P_X
  DEC P_X
.nl:
.skipmove:

  ; Move rock down 1 px/frame
  INC ROCK_Y
  LDA ROCK_Y
  CMP #185
  BCC .norock_reset
  ; Reset rock to top with a varying-but-deterministic X — chime per dodge.
  LDA #20
  STA ROCK_Y
  LDA FRAME
  AND #$7F
  CLC
  ADC #$10
  STA ROCK_X
  INC SCORE              ; survive!
  ; sfx_chime — short tone confirms you dodged a rock.
  LDA #$04
  STA AUDC0
  LDA #$06
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #8
  STA SFX_LEFT
.norock_reset:

  ; sfx_update: tick countdown, silence on zero.
  LDA SFX_LEFT
  BEQ .sfx_done
  DEC SFX_LEFT
  BNE .sfx_done
  LDA #0
  STA AUDV0
.sfx_done:

  ; Position P0 at column P_X (race-the-beam — simplified: divide by 15)
  STA WSYNC
  LDX P_X
  LDA #0
.p0d:
  CPX #15
  BCC .p0done
  SBC #15
  TAX
  JMP .p0d
.p0done:
  STA RESP0
  STA HMOVE

  ; Position M0 at column ROCK_X (race-the-beam)
  STA WSYNC
  LDX ROCK_X
  LDA #0
.m0d:
  CPX #15
  BCC .m0done
  SBC #15
  TAX
  JMP .m0d
.m0done:
  STA RESM0

  LDA #0
  STA VBLANK

  ; Visible 192
  LDY #192
.draw:
  STA WSYNC
  ; Player: 8 rows around P_Y
  TYA
  SEC
  SBC P_Y
  CMP #8
  BCS .p_blank
  TAX
  LDA SPRITE,X
  STA GRP0
  JMP .p_done
.p_blank:
  LDA #0
  STA GRP0
.p_done:
  ; Rock: enable missile for the 2 lines around ROCK_Y
  TYA
  SEC
  SBC ROCK_Y
  CMP #2
  BCS .m_blank
  LDA #2
  STA ENAM0
  JMP .m_done
.m_blank:
  LDA #0
  STA ENAM0
.m_done:
  DEY
  BNE .draw

  ; Overscan 30
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

SPRITE:
  .byte %00111100
  .byte %01111110
  .byte %11011011
  .byte %11111111
  .byte %11111111
  .byte %11011011
  .byte %01100110
  .byte %01000010

  org $FFFA
  .word START
  .word START
  .word START

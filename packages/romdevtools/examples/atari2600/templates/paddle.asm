; ── paddle.asm — Atari 2600 Pong-style paddle scaffold ────────────────
;
; Two paddles (player 0 = left, player 1 = right), one ball (BL),
; symmetric playfield with top + bottom walls. Joystick port A up/down
; moves the left paddle; the right paddle does simple AI (chases ball Y).
;
; 2600 architecture refresher:
;   - No frame buffer. Every scanline you write TIA registers describing
;     what THAT line looks like, then STA WSYNC to advance.
;   - 5 graphics objects: P0, P1, M0, M1, BL (+ PF tiles via PF0/1/2).
;   - "Race the beam": the CPU has ~76 cycles between WSYNCs.
;
; This scaffold uses:
;   P0  → left paddle  (8-pixel-tall vertical bar)
;   P1  → right paddle (8-pixel-tall vertical bar)
;   BL  → 2-pixel-wide ball
;   PF0 → top + bottom playfield walls (drawn for the top + bottom rows)

  processor 6502
  org $F000

VSYNC    = $00
VBLANK   = $01
WSYNC    = $02
COLUP0   = $06
COLUP1   = $07
COLUPF   = $08
COLUBK   = $09
PF0      = $0D
PF1      = $0E
PF2      = $0F
RESP0    = $10
RESP1    = $11
RESBL    = $14
GRP0     = $1B
GRP1     = $1C
ENABL    = $1F
HMP0     = $20
HMP1     = $21
HMBL     = $24
HMOVE    = $2A
CTRLPF   = $0A
SWCHA    = $280
; ── TIA audio (R41) ────────────────────────────────────────────────
AUDC0    = $15
AUDF0    = $17
AUDV0    = $19

; ── Zero-page state ──────────────────────────────────────────────────
P0_Y     = $80        ; left paddle top scanline (16..168)
P1_Y     = $81        ; right paddle top scanline
BALL_X   = $82        ; ball horizontal (TIA pixel 0..159)
BALL_Y   = $83        ; ball vertical (scanline)
BALL_DX  = $84        ; +1 or -1
BALL_DY  = $85        ; +1 or -1
FRAME    = $86
SFX_LEFT = $87        ; frames remaining on active sfx (0 = silent)

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

  LDA #88
  STA P0_Y
  STA P1_Y
  LDA #80
  STA BALL_X
  LDA #90
  STA BALL_Y
  LDA #1
  STA BALL_DX
  STA BALL_DY

  ; Boot chime — confirms TIA audio is wired.
  LDA #$04
  STA AUDC0
  LDA #$0C
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #20
  STA SFX_LEFT

  LDA #$80           ; blue background
  STA COLUBK
  LDA #$0F           ; white paddles
  STA COLUP0
  STA COLUP1
  LDA #$48           ; cyan playfield
  STA COLUPF
  LDA #$05           ; PF symmetric reflect + ball priority
  STA CTRLPF

MAIN:
  INC FRAME

  ; ── VSYNC ─────────────────────────────────────────────────────────
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC

  ; ── VBLANK (37 lines) — game logic ────────────────────────────────
  ; 34 here + the 3 STA WSYNC in the P0/P1 positioning block below = 37 VBLANK
  ; lines total. (Bug fix: this loop used to be 37 AND the positioning added 3
  ; more → 265 scanlines/frame → the TV/emulator can't lock vsync → rolling /
  ; black picture. Exactly 262 lines = 3 VSYNC + 37 VBLANK + 192 visible + 30
  ; overscan; the positioning WSYNCs MUST be counted against the 37.)
  LDA #2
  STA VBLANK
  LDX #34
.vb:
  STA WSYNC
  DEX
  BNE .vb

  ; Move left paddle from joystick (every 2 frames to throttle).
  LDA FRAME
  AND #$01
  BNE .skip_pad
  LDA SWCHA
  ASL                 ; right (unused)
  ASL                 ; left (unused)
  ASL                 ; down
  BCS .nd
  INC P0_Y
.nd:
  ASL                 ; up
  BCS .nu
  DEC P0_Y
.nu:
  ; Clamp paddle within bounds
  LDA P0_Y
  CMP #16
  BCS .nopaddmin
  LDA #16
  STA P0_Y
.nopaddmin:
  CMP #168
  BCC .nopaddmax
  LDA #168
  STA P0_Y
.nopaddmax:
.skip_pad:

  ; Right-paddle AI — chase the ball's Y
  LDA BALL_Y
  CMP P1_Y
  BCC .ai_up
  INC P1_Y
  JMP .ai_done
.ai_up:
  DEC P1_Y
.ai_done:

  ; Move ball
  LDA BALL_DX
  CLC
  ADC BALL_X
  STA BALL_X
  LDA BALL_DY
  CLC
  ADC BALL_Y
  STA BALL_Y

  ; Bounce off top/bottom — short blip on each bounce.
  LDA BALL_Y
  CMP #20
  BCS .nb_top
  LDA #1
  STA BALL_DY
  JSR sfx_wall
.nb_top:
  LDA BALL_Y
  CMP #180
  BCC .nb_bot
  LDA #$FF              ; -1
  STA BALL_DY
  JSR sfx_wall
.nb_bot:
  ; Bounce off left/right (and respawn near centre on miss) — pew on miss.
  LDA BALL_X
  CMP #4
  BCS .nb_l
  LDA #1
  STA BALL_DX
  LDA #80
  STA BALL_X
  JSR sfx_score
.nb_l:
  LDA BALL_X
  CMP #156
  BCC .nb_r
  LDA #$FF
  STA BALL_DX
  LDA #80
  STA BALL_X
  JSR sfx_score
.nb_r:

  ; sfx_update: tick the countdown, silence on zero.
  LDA SFX_LEFT
  BEQ .sfx_done
  DEC SFX_LEFT
  BNE .sfx_done
  LDA #0
  STA AUDV0
.sfx_done:

  ; Position P0 horizontally at column 16 (race-the-beam delay)
  STA WSYNC
  LDA #1
  STA WSYNC
  LDX #15
.p0d:
  DEX
  BNE .p0d
  STA RESP0
  ; Position P1 at column 144
  STA WSYNC
  LDX #38
.p1d:
  DEX
  BNE .p1d
  STA RESP1
  STA HMOVE

  LDA #0
  STA VBLANK

  ; ── Visible (192 lines) ───────────────────────────────────────────
  LDY #192
.draw:
  STA WSYNC
  TYA
  ; Top-bottom walls: lines 0..3 and 188..191 draw a full-width PF
  CMP #4
  BCS .nottop
  LDA #$FF
  STA PF0
  STA PF1
  STA PF2
  JMP .pf_done
.nottop:
  CMP #188
  BCC .notbot
  LDA #$FF
  STA PF0
  STA PF1
  STA PF2
  JMP .pf_done
.notbot:
  LDA #0
  STA PF0
  STA PF1
  STA PF2
.pf_done:
  ; Left paddle: 8 lines starting at P0_Y
  TYA
  SEC
  SBC P0_Y
  CMP #8
  BCS .p0blank
  LDA #$FF
  STA GRP0
  JMP .p0done
.p0blank:
  LDA #0
  STA GRP0
.p0done:
  ; Right paddle: 8 lines starting at P1_Y
  TYA
  SEC
  SBC P1_Y
  CMP #8
  BCS .p1blank
  LDA #$FF
  STA GRP1
  JMP .p1done
.p1blank:
  LDA #0
  STA GRP1
.p1done:
  ; Ball: 2 lines starting at BALL_Y
  TYA
  SEC
  SBC BALL_Y
  CMP #2
  BCS .blblank
  LDA #2
  STA ENABL
  JMP .bldone
.blblank:
  LDA #0
  STA ENABL
.bldone:
  DEY
  BNE .draw

  ; ── Overscan (30 lines) ───────────────────────────────────────────
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

  ; ── TIA sfx helpers (R41) ─────────────────────────────────────────
  ; sfx_wall — short blip on wall bounce (4-frame ringing tone)
sfx_wall:
  LDA #$04
  STA AUDC0
  LDA #$10
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #4
  STA SFX_LEFT
  RTS

  ; sfx_score — longer chime when a player scores (16 frames)
sfx_score:
  LDA #$04
  STA AUDC0
  LDA #$06            ; higher pitch
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #16
  STA SFX_LEFT
  RTS

  ; ── Vector table ──────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

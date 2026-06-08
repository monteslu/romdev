; ── shmup.asm — Atari 2600 SHMUP genre scaffold ─────────────────────
;
; The 2600's flagship genre — Space Invaders, Galaxian, Demon Attack
; were all fixed/gallery shooters, because that is exactly what the TIA
; is good at. This is the canonical 2600 shmup, identical in spirit to
; the verified `mini_invaders` template.
;
; A fixed-shooter / gallery-shooter 2600 game that uses the RIGHT TIA
; objects instead of playfield "barcode" bars (see the note at the bottom).
;
; TIA object roles (the canonical layout for this genre):
;   P0  = player cannon (double-width via NUSIZ0 = %00000111)
;   P1  + NUSIZ1 = %011 (3 medium-spaced copies) = a ROW OF INVADERS
;          → one GRP1 write draws three aliens, hardware-replicated.
;   M0  = the player's shot
;   PF  = a thin ground line only (NOT the aliens — playfield bits look
;          like a barcode; real sprites read as actual invaders).
;
; The aliens march left/right as a block (move P1's X), drop a step at
; the edges, and you shoot upward with the joystick button. This is the
; deliberately-small but visually-honest version of the genre on the
; 2600 — extend it by reusing P1 again lower down for shields, or
; adding M1 as an alien bomb.
;
; NTSC kernel: 3 VSYNC + 37 VBLANK + 192 visible + 30 overscan.

  processor 6502
  org $F000

VSYNC    = $00
VBLANK   = $01
WSYNC    = $02
NUSIZ0   = $04
NUSIZ1   = $05
COLUP0   = $06
COLUP1   = $07
COLUPF   = $08
COLUBK   = $09
CTRLPF   = $0A
RESP0    = $10
RESP1    = $11
RESM0    = $12
GRP0     = $1B
GRP1     = $1C
ENAM0    = $1D
PF0      = $0D
HMP0     = $20
HMP1     = $21
HMM0     = $22
HMOVE    = $2A
HMCLR    = $2B
SWCHA    = $280
INPT4    = $0C          ; P0 fire (active-low, bit 7)
AUDC0    = $15
AUDF0    = $17
AUDV0    = $19

; Zero page
P_X      = $80          ; player cannon X (visible column)
ALIEN_X  = $81          ; left edge of the alien block (P1 X)
ALIEN_Y  = $82          ; top scanline of the alien row
ALIEN_DIR = $83         ; 1 = right, $FF = left
SHOT_X   = $84
SHOT_Y   = $85          ; $FF = no shot active
FRAME    = $86
MARCH    = $87          ; march timer
SFX_LEFT = $88

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

  LDA #76
  STA P_X
  LDA #40
  STA ALIEN_X
  LDA #60
  STA ALIEN_Y
  LDA #1
  STA ALIEN_DIR
  LDA #$FF
  STA SHOT_Y           ; no shot yet

  ; Colours
  LDA #$06             ; dark blue-grey bg
  STA COLUBK
  LDA #$1E             ; yellow cannon
  STA COLUP0
  LDA #$46             ; red-ish aliens
  STA COLUP1
  LDA #$0A             ; grey ground line
  STA COLUPF

  ; Object sizes: P0 double-width; P1 = 3 medium-spaced copies.
  LDA #%00000101       ; NUSIZ0: P0 double size (2x width)
  STA NUSIZ0
  LDA #%00000011       ; NUSIZ1: three copies, medium spacing
  STA NUSIZ1
  LDA #1
  STA CTRLPF           ; PF reflected (symmetric ground)

MAIN:
  INC FRAME

  ; ── VSYNC (3 lines) ──
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC

  ; ── VBLANK (37 lines) — do all game logic here ──
  LDA #2
  STA VBLANK
  LDX #37
.vb:
  STA WSYNC
  DEX
  BNE .vb

  ; Player move (every 2nd frame), joystick port A high nibble.
  LDA FRAME
  AND #$01
  BNE .skipmove
  LDA SWCHA
  ASL                  ; bit7 = P0 Right
  BCS .nr
  LDA P_X
  CMP #140
  BCS .nr
  INC P_X
  INC P_X
.nr:
  ASL                  ; bit6 = P0 Left
  BCS .nl
  LDA P_X
  CMP #10
  BCC .nl
  DEC P_X
  DEC P_X
.nl:
.skipmove:

  ; Fire on button (INPT4 bit7 active-low) if no shot active.
  LDA SHOT_Y
  CMP #$FF
  BNE .noFire
  BIT INPT4
  BMI .noFire          ; bit7 set = not pressed
  LDA P_X
  CLC
  ADC #4
  STA SHOT_X
  LDA #180
  STA SHOT_Y
  ; pew sfx
  LDA #$04
  STA AUDC0
  LDA #$08
  STA AUDF0
  LDA #$0C
  STA AUDV0
  LDA #6
  STA SFX_LEFT
.noFire:

  ; Move shot up 4px/frame; despawn past the aliens.
  LDA SHOT_Y
  CMP #$FF
  BEQ .noShotMove
  SEC
  SBC #4
  STA SHOT_Y
  CMP #50
  BCS .noShotMove
  LDA #$FF
  STA SHOT_Y
.noShotMove:

  ; March the alien block every 24 frames.
  INC MARCH
  LDA MARCH
  CMP #24
  BCC .noMarch
  LDA #0
  STA MARCH
  LDA ALIEN_DIR
  BMI .marchLeft
  LDA ALIEN_X
  CMP #96
  BCS .flip            ; hit right edge → reverse + drop
  CLC
  ADC #6
  STA ALIEN_X
  JMP .noMarch
.marchLeft:
  LDA ALIEN_X
  CMP #14
  BCC .flip            ; hit left edge → reverse + drop
  SEC
  SBC #6
  STA ALIEN_X
  JMP .noMarch
.flip:
  ; Reverse direction and step the whole row DOWN one notch. ALIEN_Y is
  ; the row's top scanline; SMALLER Y = lower on screen (Y counts 192→1),
  ; so "drop" means decrement ALIEN_Y. Stop dropping once they reach the
  ; player's row (game-over territory — kept simple here: clamp).
  LDA ALIEN_DIR
  EOR #$FE             ; 1 <-> $FF
  STA ALIEN_DIR
  LDA ALIEN_Y
  CMP #30
  BCC .noMarch         ; already near the bottom — don't go further
  SEC
  SBC #6
  STA ALIEN_Y
.noMarch:

  ; sfx countdown
  LDA SFX_LEFT
  BEQ .sfxDone
  DEC SFX_LEFT
  BNE .sfxDone
  LDA #0
  STA AUDV0
.sfxDone:

  ; ── Position objects (race-the-beam) ──
  ; P0 (player) at column P_X.
  STA WSYNC
  STA HMCLR
  LDX P_X
  LDA #0
.p0pos:
  CPX #15
  BCC .p0done
  SEC
  SBC #15
  TAX
  JMP .p0pos
.p0done:
  STA RESP0
  ; P1 (alien block) at column ALIEN_X.
  STA WSYNC
  LDX ALIEN_X
  LDA #0
.p1pos:
  CPX #15
  BCC .p1done
  SEC
  SBC #15
  TAX
  JMP .p1pos
.p1done:
  STA RESP1
  ; M0 (shot) at column SHOT_X.
  STA WSYNC
  LDX SHOT_X
  LDA #0
.m0pos:
  CPX #15
  BCC .m0done
  SEC
  SBC #15
  TAX
  JMP .m0pos
.m0done:
  STA RESM0
  STA HMOVE

  LDA #0
  STA VBLANK

  ; ── Visible (192 lines) ──
  LDY #192
.draw:
  STA WSYNC

  ; Player cannon: 8 rows around scanline 176 (near the bottom).
  TYA
  SEC
  SBC #16              ; 192-176 region → small Y window near bottom
  CMP #8
  BCS .pBlank
  TAX
  LDA SHIP,X
  STA GRP0
  JMP .pDone
.pBlank:
  LDA #0
  STA GRP0
.pDone:

  ; Alien row: 8 rows starting at ALIEN_Y, drawn via P1 (NUSIZ1 gives
  ; 3 hardware copies, so one GRP1 write paints all three invaders).
  ; Window: (Y - ALIEN_Y) in [0..7] → index into the ALIEN bitmap.
  TYA
  SEC
  SBC ALIEN_Y
  CMP #8
  BCS .aBlank
  TAX
  LDA ALIEN,X
  STA GRP1
  JMP .aDone
.aBlank:
  LDA #0
  STA GRP1
.aDone:

  ; Shot: enable M0 for 4 lines around SHOT_Y.
  TYA
  SEC
  SBC SHOT_Y
  CMP #4
  BCS .sBlank
  LDA #2
  STA ENAM0
  JMP .sDone
.sBlank:
  LDA #0
  STA ENAM0
.sDone:

  ; Ground line near the very bottom via PF0.
  CPY #6
  BCS .noGround
  LDA #$F0
  STA PF0
  JMP .gDone
.noGround:
  LDA #0
  STA PF0
.gDone:

  DEY
  BNE .draw

  ; ── Overscan (30 lines) ──
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

; 8-row cannon silhouette (double-width via NUSIZ0).
SHIP:
  .byte %00011000
  .byte %00011000
  .byte %00111100
  .byte %01111110
  .byte %11111111
  .byte %11111111
  .byte %11111111
  .byte %11100111

; 8-row invader silhouette — drawn via P1 with NUSIZ1=%011 so it
; hardware-replicates into 3 medium-spaced aliens from one GRP1 write.
ALIEN:
  .byte %00100100
  .byte %00111100
  .byte %01111110
  .byte %11011011
  .byte %11111111
  .byte %01011010
  .byte %00100100
  .byte %01000010

  org $FFFA
  .word START
  .word START
  .word START

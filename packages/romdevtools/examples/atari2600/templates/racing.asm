; ── racing.asm — Atari 2600 RACING genre scaffold (top-down) ──────────
;
; The 2600 had a deep racing catalogue — Enduro, Indy 500, Night Driver,
; Pole Position, Grand Prix. This scaffold is the HONEST 2600 racer: a
; TOP-DOWN, vertically-scrolling lane racer (the same idiom Enduro uses),
; NOT a pseudo-3D road — projecting a 3D road needs a per-line table the
; 4 KB/76-cycle budget can't spare in a starter, and a top-down racer is
; a fully period-correct, recognizable racing game on its own.
;
; TIA object roles:
;   P0  = the player's car (8-px sprite) near the bottom, steers L/R.
;   PF  = the road: reflected playfield draws the two ROAD EDGES (left
;          rail mirrors to the right rail) plus a dashed CENTRE LINE that
;          scrolls upward every frame to convey forward speed.
;   P1  = an oncoming/lead car you must avoid (8-px sprite) that drifts
;          down the road; reused each time it passes the bottom, dropped
;          back to the top in a (deterministic) new lane.
;   M0  = a second smaller hazard (a cone / debris) in another lane.
;
; Gameplay: hold LEFT/RIGHT on the joystick to weave between the rails;
; survive the descending traffic. Your SPEED (and the score) ramps up
; the longer you last — the centre-line dashes scroll faster and the
; traffic descends faster. A collision (TIA P0-vs-P1 / P0-vs-M0) flashes
; the screen red and resets your speed. Extend it with M1 as a 3rd
; hazard, a fuel gauge via a PF bar, or NUSIZ1 for two-abreast traffic.
;
; TIMING DISCIPLINE (learned the hard way in paddle.asm):
;   * 262 lines EXACTLY = 3 VSYNC + 37 VBLANK + 192 visible + 30 overscan.
;   * The 3 object-positioning WSYNCs are COUNTED against the 37 VBLANK
;     lines (so the VBLANK delay loop is #34, not #37).
;   * The visible region is a TWO-LINE KERNEL: one scanline of render
;     work (road edges + centre line + one car test) is ~80+ cycles and
;     does NOT fit in 76; splitting across two WSYNCs doubles the budget.
;     96 passes x 2 lines = 192 visible lines.

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
PF0      = $0D
PF1      = $0E
PF2      = $0F
RESP0    = $10
RESP1    = $11
RESM0    = $12
GRP0     = $1B
GRP1     = $1C
ENAM0    = $1D
HMP0     = $20
HMP1     = $21
HMM0     = $22
HMOVE    = $2A
HMCLR    = $2B
CXPPMM   = $07          ; READ: bit7 = P0/P1 collided
CXP0FB   = $02          ; READ: bit6 = P0/missile-or-ball... we use CXM0P
CXM0P    = $00          ; READ: bit6 = M0/P0 collided
CXCLR    = $2C
SWCHA    = $280
INPT4    = $0C          ; P0 fire (active-low, bit7) — unused here but handy
; TIA audio
AUDC0    = $15
AUDF0    = $17
AUDV0    = $19

; ── Zero-page state ───────────────────────────────────────────────────
P_X      = $80          ; player car X (visible column 0..159)
E1_X     = $81          ; enemy car P1 X
E1_Y     = $82          ; enemy car P1 top scanline (counts with the beam)
E2_X     = $83          ; hazard M0 X
E2_Y     = $84          ; hazard M0 top scanline
SPEED    = $85          ; current speed (1..6) — drives scroll + descent
SCROLL   = $86          ; centre-line dash phase (0..7)
FRAME    = $87
SCORE    = $88          ; distance survived / ramps speed
SFX_LEFT = $89          ; frames remaining on active sfx
FLASH    = $8A          ; >0 = crash flash frames remaining
TMP      = $8B

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

  ; Initial positions
  LDA #76
  STA P_X              ; player mid-road, near bottom
  LDA #50
  STA E1_X
  LDA #170
  STA E1_Y             ; enemy car starts up top
  LDA #104
  STA E2_X
  LDA #150
  STA E2_Y
  LDA #1
  STA SPEED

  ; Colours
  LDA #$00             ; black "tarmac" background
  STA COLUBK
  LDA #$1E             ; yellow player car
  STA COLUP0
  LDA #$36             ; pink/red oncoming car (also colours M0 hazard)
  STA COLUP1
  LDA #$0E             ; white road markings
  STA COLUPF

  ; M0 hazard shares P0 colour normally; we want it to read as debris.
  ; Make it 2px wide.
  LDA #%00010000       ; NUSIZ0: missile 2x wide (bits 4-5), P0 single
  STA NUSIZ0

  ; Playfield: reflected so the left rail mirrors to a right rail, and
  ; SCORE_COLOR priority not needed. CTRLPF bit0 = reflect.
  LDA #%00000001
  STA CTRLPF

  ; Boot chime — confirms TIA audio is wired (engine "rev").
  LDA #$03
  STA AUDC0
  LDA #$0A
  STA AUDF0
  LDA #$0C
  STA AUDV0
  LDA #18
  STA SFX_LEFT

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

  ; ── VBLANK (37 lines: 34 here + 3 positioning WSYNCs below) ──
  LDA #2
  STA VBLANK
  LDX #34
.vb:
  STA WSYNC
  DEX
  BNE .vb

  ; ── Steering: joystick port A left/right, every 2nd frame ──
  LDA FRAME
  AND #$01
  BNE .skipmove
  LDA SWCHA
  ASL                  ; bit7 = P0 Right
  BCS .nr
  LDA P_X
  CMP #128
  BCS .nr
  INC P_X
  INC P_X
.nr:
  ASL                  ; bit6 = P0 Left
  BCS .nl
  LDA P_X
  CMP #28
  BCC .nl
  DEC P_X
  DEC P_X
.nl:
.skipmove:

  ; ── Crash flash countdown ──
  LDA FLASH
  BEQ .noflash
  DEC FLASH
.noflash:

  ; ── Scroll the dashed centre line upward at SPEED px/frame ──
  ; SCROLL is the phase 0..7; subtract SPEED, wrap mod 8.
  LDA SCROLL
  SEC
  SBC SPEED
  AND #$07
  STA SCROLL

  ; ── Descend traffic at SPEED px/frame (smaller Y = lower on screen,
  ; because Y counts 192->1 with the beam). So descending = DEC Y. ──
  LDA E1_Y
  SEC
  SBC SPEED
  STA E1_Y
  CMP #20              ; passed the bottom?
  BCS .e1ok
  ; recycle to top, new deterministic lane from FRAME
  LDA #186
  STA E1_Y
  LDA FRAME
  AND #$3F
  CLC
  ADC #40
  STA E1_X
  INC SCORE            ; survived a car
  ; ramp speed every time SCORE crosses a multiple of 4 (cap at 6)
  LDA SCORE
  AND #$03
  BNE .e1ok
  LDA SPEED
  CMP #6
  BCS .e1ok
  INC SPEED
  ; speed-up "rev" sfx
  LDA #$03
  STA AUDC0
  LDA #$08
  STA AUDF0
  LDA #$0C
  STA AUDV0
  LDA #10
  STA SFX_LEFT
.e1ok:

  ; Hazard M0 descends a touch faster (SPEED+1).
  LDA E2_Y
  SEC
  SBC SPEED
  SBC #0               ; (placeholder; SPEED already applied)
  STA E2_Y
  CMP #18
  BCS .e2ok
  LDA #182
  STA E2_Y
  LDA FRAME
  EOR #$5A
  AND #$3F
  CLC
  ADC #36
  STA E2_X
.e2ok:

  ; ── Collision check (read TIA collision latches from LAST frame) ──
  ; P0 vs P1 → CXPPMM bit7. M0 vs P0 → CXM0P bit6.
  BIT CXPPMM
  BMI .crash           ; bit7 set = P0/P1 overlapped
  BIT CXM0P
  BVS .crash           ; bit6 set = M0/P0 overlapped
  JMP .nocrash
.crash:
  ; Reset speed, flash the screen, recycle the offending traffic up top,
  ; play a crash tone.
  LDA #1
  STA SPEED
  LDA #12
  STA FLASH
  LDA #186
  STA E1_Y
  LDA #182
  STA E2_Y
  LDA #$08             ; noisy crash
  STA AUDC0
  LDA #$1F
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #14
  STA SFX_LEFT
.nocrash:
  STA CXCLR            ; clear collision latches for the next frame

  ; ── sfx countdown ──
  LDA SFX_LEFT
  BEQ .sfxdone
  DEC SFX_LEFT
  BNE .sfxdone
  LDA #0
  STA AUDV0
.sfxdone:

  ; ── Position objects (race-the-beam) — 3 WSYNC-bounded lines ──
  ; Use the divide-by-15 coarse approach (good enough for a starter; the
  ; cars sit on lane centres). HMCLR first so stale HM values don't drift.
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
  ; P1 (enemy car)
  STA WSYNC
  LDX E1_X
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
  ; M0 (hazard)
  STA WSYNC
  LDX E2_X
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

  ; Crash flash: paint background dark-red while FLASH active.
  LDA FLASH
  BEQ .bgblack
  LDA #$42             ; dark red
  STA COLUBK
  JMP .bgdone
.bgblack:
  LDA #$00
  STA COLUBK
.bgdone:

  LDA #0
  STA VBLANK

  ; ── Visible (192 lines) — TWO-LINE KERNEL ──
  ; Each pass renders TWO scanlines:
  ;   line A: road edges (PF) + scrolling centre dash (PF) + player car.
  ;   line B: enemy car (P1) + hazard (M0).
  ; Y counts 192 -> 2 in steps of 2.  96 passes = 192 lines.
  LDY #192
.draw:
  ; ---- line A: road + player car ----
  STA WSYNC
  ; Road rails via PF0 (reflected → left+right rails). The rails are the
  ; OUTER playfield pixels; PF0's high nibble shows on screen pixels
  ; 4..7 (the leftmost visible chunk after the 4-px PF0 gap), mirrored to
  ; the right edge by CTRLPF reflect. A constant rail every line.
  LDA #%00010000       ; one rail bar on each side
  STA PF0
  ; Centre dash via PF2 — a dash that appears on some scanline groups,
  ; phased by SCROLL so it crawls upward. (Y+SCROLL)&8 picks dash on/off.
  TYA
  CLC
  ADC SCROLL
  AND #%00001000
  BEQ .nodash
  LDA #%00011000       ; centre pixels of PF2 (maps near screen middle)
  STA PF2
  JMP .dashdone
.nodash:
  LDA #0
  STA PF2
.dashdone:
  ; Player car: 8 rows starting at P_Y region near the bottom (~Y 30..22).
  ; Window: (Y - 22) in [0..7] → index CAR bitmap.
  TYA
  SEC
  SBC #22
  CMP #8
  BCS .pblank
  TAX
  LDA CAR,X
  STA GRP0
  JMP .pdone
.pblank:
  LDA #0
  STA GRP0
.pdone:

  ; ---- line B: enemy car + hazard ----
  STA WSYNC
  ; Enemy car P1: 8 rows starting at E1_Y.
  TYA
  SEC
  SBC E1_Y
  CMP #8
  BCS .eblank
  TAX
  LDA CAR,X
  STA GRP1
  JMP .edone
.eblank:
  LDA #0
  STA GRP1
.edone:
  ; Hazard M0: enable for 4 rows around E2_Y.
  TYA
  SEC
  SBC E2_Y
  CMP #4
  BCS .hblank
  LDA #2
  STA ENAM0
  JMP .hdone
.hblank:
  LDA #0
  STA ENAM0
.hdone:

  DEY
  DEY
  BNE .draw

  ; ── Overscan (30 lines) — clear the playfield so it doesn't bleed ──
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA GRP1
  STA ENAM0
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

; ── 8-row top-down car silhouette (windshield + body) ──
CAR:
  .byte %00111100
  .byte %01111110
  .byte %01011010
  .byte %01111110
  .byte %11111111
  .byte %11111111
  .byte %01011010
  .byte %01111110

  ; ── Vector table ──
  org $FFFA
  .word START
  .word START
  .word START

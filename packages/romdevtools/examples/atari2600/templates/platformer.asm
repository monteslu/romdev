; ── platformer.asm — Atari 2600 PLATFORMER genre scaffold ─────────────
;
; SINGLE-SCREEN platformer. Pitfall!, Montezuma's Revenge, and Kangaroo
; are 2600 platformers, and they are single-screen-at-a-time: the 2600
; has NO hardware scroll, no tilemap, and 128 bytes of RAM, so a smooth
; side-scroller is not the honest 2600 idiom (you'd flip whole screens,
; Pitfall-style, instead). What IS idiomatic — and what this scaffold
; ships — is gravity + a jump arc + land-on-top collision against a set
; of fixed platforms, all on one screen.
;
; TIA object roles:
;   P0  = the player (8-px sprite) that walks + jumps.
;   PF  = the platforms (and the floor): three horizontal playfield bars
;          at fixed Y bands. The playfield is the only 2600 object wide
;          enough to be a platform; players/missiles are too narrow.
;
; Physics (fixed-point Y, 1 sub-pixel bit):
;   * Gravity pulls the player down every frame (velocity += g).
;   * Pressing FIRE while standing on a surface launches a jump
;     (velocity = -jump).
;   * After moving, we test the player's FEET against each platform's
;     (Y, x-span) in CODE — not TIA collision — because we need to know
;     WHICH surface to stand on and TIA only gives a yes/no overlap.
;   * Walk left/right with the joystick; you can't walk off the screen.
;
; This is the jump/gravity/collision CORE. Extend it with: a second
; sprite (P1) as a pickup or enemy, M0 as a thrown rock, ladders (let
; UP/DOWN move Y when overlapping a ladder x-span), or Pitfall-style
; screen flipping when the player exits the left/right edge.
;
; TIMING: 262 lines = 3 VSYNC + 37 VBLANK + 192 visible + 30 overscan.
; One positioning WSYNC is counted against VBLANK (loop = #36). The
; visible region is a TWO-LINE KERNEL so the per-pass work (platform PF
; lookup + player-sprite test) fits the cycle budget.

  processor 6502
  org $F000

VSYNC    = $00
VBLANK   = $01
WSYNC    = $02
NUSIZ0   = $04
COLUP0   = $06
COLUPF   = $08
COLUBK   = $09
CTRLPF   = $0A
PF0      = $0D
PF1      = $0E
PF2      = $0F
RESP0    = $10
GRP0     = $1B
HMP0     = $20
HMOVE    = $2A
HMCLR    = $2B
SWCHA    = $280
INPT4    = $0C          ; fire button (active-low, bit7) = JUMP
; TIA audio
AUDC0    = $15
AUDF0    = $17
AUDV0    = $19

; ── Zero-page state ───────────────────────────────────────────────────
P_X      = $80          ; player X (visible column)
P_Y      = $81          ; player top scanline (integer part). Y counts with
                        ; the beam 192->0, so SMALLER = LOWER on screen.
P_VY     = $82          ; vertical velocity, signed, in half-pixels (8.1)
P_YSUB   = $83          ; (spare — physics is integer-pixel; kept for layout)
ON_GND   = $84          ; 1 = standing on a surface (can jump)
FRAME    = $85
SFX_LEFT = $86
TMP      = $87
LANDY    = $88          ; the Y we snap to when we land
; PFROW: 96-byte playfield row buffer (one entry per 2-line kernel row),
; built ONCE at boot from the platform table. $89..$E8. Stack ($FF down)
; has $E9..$FF free (23 bytes) — ample, since the only JSR is the one-shot
; build_pfrow and the kernel itself calls nothing.
PFROW    = $89

; Player height (sprite rows).
PH       = 8

; ── Platform table ────────────────────────────────────────────────────
; Each platform = (top-band scanline Y, x-left, x-right). The visuals are
; FULL-WIDTH horizontal bars (cheap + reads cleanly), so the x-spans below
; are the whole screen and the land-on-top test lets you stand anywhere on
; a platform. Beam Y counts 192(top)->1(bottom): a LARGER Y value sits
; HIGHER on the screen, so PLAT_Y=18 is the bottom FLOOR and PLAT_Y=150 is
; the top ledge.
;   floor : Y=18   (bottom, full width)
;   ledge : Y=70
;   ledge : Y=110
;   ledge : Y=150  (highest)
NUM_PLAT = 4

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

  ; Start the player standing on the floor.
  LDA #76
  STA P_X
  LDA #26              ; just above the floor band (floor top = 18, +PH)
  STA P_Y
  LDA #1
  STA ON_GND

  ; Colours
  LDA #$84             ; blue sky background
  STA COLUBK
  LDA #$1E             ; yellow player
  STA COLUP0
  LDA #$28             ; brown/orange platforms
  STA COLUPF

  ; Reflected playfield (harmless for full-width bars; left set so that if
  ; you switch ledges to partial patterns later they mirror symmetrically).
  LDA #%00000001
  STA CTRLPF

  ; Build the static playfield row buffer ONCE (platforms never move).
  JSR build_pfrow

  ; Boot chime.
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

  ; ── VSYNC (3 lines) ──
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC

  ; ── VBLANK (37 lines: 36 here + 1 positioning WSYNC below) ──
  LDA #2
  STA VBLANK
  LDX #36
.vb:
  STA WSYNC
  DEX
  BNE .vb

  ; ── Horizontal move (every 2nd frame to throttle) ──
  LDA FRAME
  AND #$01
  BNE .skipmove
  ; SWCHA is active-LOW; RE-LOAD per direction (the old ASL carry-chain
  ; clobbered A with LDA P_X between shifts → RIGHT also triggered LEFT
  ; and the moves cancelled — the player couldn't move).
  LDA SWCHA
  AND #$80             ; bit7 = Right (0 = pressed)
  BNE .nr
  LDA P_X
  CMP #140
  BCS .nr
  INC P_X
  INC P_X
.nr:
  LDA SWCHA
  AND #$40             ; bit6 = Left (0 = pressed)
  BNE .nl
  LDA P_X
  CMP #16
  BCC .nl
  DEC P_X
  DEC P_X
.nl:
.skipmove:

  ; ── Jump: FIRE while on the ground launches an upward velocity ──
  ; Coordinate reminder: Y is the BEAM scanline; the top of the screen is
  ; the LARGER Y. So "up" = INCREASING P_Y, and a positive P_VY rises.
  ; P_VY is signed WHOLE PIXELS/frame (no sub-pixel — integer motion looks
  ; perfectly fine for a 2600 jump and avoids a fractional-carry bug where
  ; small half-pixel velocities never accumulate a whole pixel).
  LDA ON_GND
  BEQ .nojump
  BIT INPT4
  BMI .nojump          ; bit7 set = button released
  LDA #6               ; initial jump speed (pixels/frame, upward)
  STA P_VY
  LDA #0
  STA ON_GND
  ; jump sfx
  LDA #$0C
  STA AUDC0
  LDA #$14
  STA AUDF0
  LDA #$0F
  STA AUDV0
  LDA #6
  STA SFX_LEFT
.nojump:

  ; ── Gravity + integrate vertical velocity (only while airborne) ──
  ; Standing still on a platform we DON'T apply gravity (otherwise the
  ; player drops 1px every frame and the landing snap fights it → jitter).
  LDA ON_GND
  BNE .skipgrav
  DEC P_VY             ; gravity: velocity drifts toward falling each frame
  ; Clamp terminal FALL speed to -8 px/frame — but ONLY while falling.
  ; The old unsigned compare (CMP #$F8 / BCS keep) also caught every
  ; POSITIVE velocity (5 < $F8 unsigned!), so the instant you jumped the
  ; clamp slammed P_VY from +6 to -8: the whole "jump" rose 0 frames,
  ; fell 8px and re-landed within ONE frame — jump sfx played, screen
  ; blipped, player never left the ground.
  LDA P_VY
  BPL .vyok            ; rising (positive) → terminal clamp doesn't apply
  CMP #$F8
  BCS .vyok            ; -8..-1 → within terminal speed, keep
  LDA #$F8             ; -128..-9 → clamp to -8
  STA P_VY
.vyok:
  ; P_Y += P_VY  (signed add: sign-extend P_VY into the add)
  LDA P_VY
  CLC
  ADC P_Y
  STA P_Y
.skipgrav:

  ; ── Land-on-top collision against the platform table ──
  ; Only while DESCENDING (P_VY negative = moving down the screen). For
  ; each platform, the stand-line = PLAT_Y + PH (the player's feet rest
  ; just above the band's top edge). If the player's feet (P_Y) have
  ; reached or just dropped through that line from above, and X is within
  ; the platform's span, snap onto it.
  LDA P_VY
  BPL .noland          ; rising or stationary → can't land this frame
  LDX #0
.landloop:
  LDA PLAT_Y,X
  CLC
  ADC #PH              ; stand-line for this platform
  STA LANDY
  ; player at/below the stand-line?  (P_Y <= LANDY, i.e. NOT P_Y > LANDY)
  LDA P_Y
  CMP LANDY
  BEQ .ydepth          ; exactly on it
  BCS .nextplat        ; P_Y > LANDY → still above the surface → no land
.ydepth:
  ; not fallen WAY past it (avoid grabbing a platform from underneath):
  ; require LANDY - P_Y <= 12.
  LDA LANDY
  SEC
  SBC P_Y
  CMP #13
  BCS .nextplat        ; dropped >12px below → ignore
  ; x-span test: PLAT_XL <= P_X <= PLAT_XR
  LDA P_X
  CMP PLAT_XL,X
  BCC .nextplat
  CMP PLAT_XR,X
  BCS .nextplat        ; (XR=159 + the +1 makes the whole row standable)
  ; LAND!
  LDA LANDY
  STA P_Y
  LDA #0
  STA P_VY
  LDA #1
  STA ON_GND
  JMP .landdone
.nextplat:
  INX
  CPX #NUM_PLAT
  BNE .landloop
  ; matched nothing → still airborne
  LDA #0
  STA ON_GND
.landdone:
.noland:

  ; Safety floor: never let the player fall off the bottom of the world.
  LDA P_Y
  CMP #18
  BCS .floorok
  LDA #26
  STA P_Y
  LDA #0
  STA P_VY
  LDA #1
  STA ON_GND
.floorok:

  ; ── sfx countdown ──
  LDA SFX_LEFT
  BEQ .sfxdone
  DEC SFX_LEFT
  BNE .sfxdone
  LDA #0
  STA AUDV0
.sfxdone:

  ; ── Position P0 at column P_X (1 WSYNC, counted in VBLANK) ──
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
  STA HMOVE

  LDA #0
  STA VBLANK

  ; ── Visible (192 lines) — SINGLE-LINE KERNEL reading a PF row buffer ──
  ; CRITICAL CYCLE NOTE: the platforms are STATIC, so we DON'T recompute
  ; them per scanline (a per-line JSR over the platform table overflowed
  ; the 76-cycle budget → frames grew to ~250 lines → no vsync lock →
  ; black rolling screen — the bug this kernel fixes). Instead PFROW[] is
  ; a 96-byte buffer (one entry per 2-line row) filled ONCE at boot from
  ; the platform table: $FF = platform here, $00 = open air. The kernel
  ; just LDA PFROW,X / STA PF1 / STA PF2 (cheap) + a single player-sprite
  ; test. That comfortably fits one scanline.
  ;
  ; X = row index 0..95 (top→bottom in buffer order). Y = beam scanline
  ; 192→1. We draw two scanlines per buffer row.
  LDX #0               ; PFROW index
  LDY #192
.draw:
  STA WSYNC
  ; --- playfield for this row (full-width bars) ---
  LDA PFROW,X
  STA PF0
  STA PF1
  STA PF2
  ; --- player sprite test ---
  TYA
  SEC
  SBC P_Y
  CMP #PH
  BCS .pblank
  STY TMP              ; save beam line
  TAY
  LDA PLAYER,Y
  STA GRP0
  LDY TMP
  JMP .pdone
.pblank:
  LDA #0
  STA GRP0
.pdone:
  DEY
  ; second scanline of this row — reuse same PF, re-test the sprite.
  STA WSYNC
  STA GRP0             ; (A still holds the sprite/blank byte from above —
                       ;  good enough; sprite is effectively 2px tall rows)
  DEY
  INX
  CPX #96
  BNE .draw

  ; ── Overscan (30 lines) ──
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

; ── build_pfrow: fill the 96-byte PFROW buffer from the platform table.
;    Called ONCE at boot. Row r covers beam scanlines (192 - 2*r) down to
;    (191 - 2*r). A row is a platform if its top scanline falls within any
;    platform's PLAT_Y..PLAT_Y+(bandHeight) window. ──
PF_BAND = 8            ; platform visual thickness in scanlines
build_pfrow:
  LDX #0               ; row index 0..95
.brow:
  ; beam scanline for this row = 192 - 2*X
  TXA
  ASL
  STA TMP              ; TMP = 2*X
  LDA #192
  SEC
  SBC TMP
  STA LANDY            ; LANDY reused as "this row's scanline"
  ; test against each platform
  LDY #0
  LDA #0
  STA PFROW,X          ; default open air
.bplat:
  LDA LANDY
  SEC
  SBC PLAT_Y,Y
  CMP #PF_BAND
  BCS .bnext
  ; within a platform band → mark solid
  LDA #$FF
  STA PFROW,X
.bnext:
  INY
  CPY #NUM_PLAT
  BNE .bplat
  INX
  CPX #96
  BNE .brow
  RTS

; ── Player sprite (8 rows) — a little explorer ──
PLAYER:
  .byte %00111100
  .byte %00111100
  .byte %00011000
  .byte %01111110
  .byte %10111101
  .byte %00111100
  .byte %00100100
  .byte %01100110

; ── Platform table ────────────────────────────────────────────────────
; Parallel arrays indexed 0..NUM_PLAT-1. Y = band top scanline (beam
; coords: bigger Y = higher on screen). XL/XR = the column span for the
; land-on-top test. The bars render FULL WIDTH, so every span is the whole
; screen (you can stand anywhere on a platform — visual == collision). To
; make narrower ledges, give a platform a partial PFROW pattern AND shrink
; its XL/XR here so the two stay in sync.
PLAT_Y:
  .byte 18             ; floor (bottom)
  .byte 70             ; ledge
  .byte 110            ; ledge
  .byte 150            ; ledge (top)
PLAT_XL:
  .byte 0
  .byte 0
  .byte 0
  .byte 0
PLAT_XR:
  .byte 159
  .byte 159
  .byte 159
  .byte 159

  ; ── Vector table ──
  org $FFFA
  .word START
  .word START
  .word START

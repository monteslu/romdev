; ── racing.asm — SWERVE STREAK — Atari 2600 road racer (complete game) ───────
;
; A COMPLETE, working game — drawn title screen, a forward-view lane racer
; (your car weaving up a road as traffic descends toward you), distance
; score + in-session hi-score, TIA sound effects + a title jingle, a crash
; → game over with auto-return to the title, and the 2600's signature
; feature: THE WHOLE MACHINE. There is no framebuffer, no tilemap, no OS —
; every visible scanline below is composed live by racing the beam, and this
; file teaches the road-racer's load-bearing TIA tricks while doing it:
;
;   1. THE ROAD IS PLAYFIELD, AND IT ANIMATES (the sense of motion) — the
;      2600 has NO hardware scroll and NO tilemap, so a road racer cannot
;      "scroll" anything. The road is drawn from the PLAYFIELD registers
;      (PF0/PF1/PF2) as two edges; the illusion of forward speed comes from
;      animating a dashed CENTRE LINE that crawls DOWN the screen every
;      frame (a per-frame phase offset, SCROLL), plus traffic cars that
;      descend toward you. This is exactly how the era's forward-view road
;      games faked motion — honest, period-correct, no scroll hardware.
;   2. RESP/HMOVE BEAM POSITIONING (the SBC-#15 idiom) — there is no sprite
;      X register; you strobe RESPx/RESM0 WHERE THE BEAM IS, then nudge ±7px
;      with HMOVE. Three objects (your car P0, a rival car P1, a hazard M0)
;      positioned this way each frame, inside the timed VBLANK window.
;   3. TIA COLLISION LATCHES (the crash detect) — the TIA detects P0/P1 and
;      M0/P0 pixel overlap in silicon as it draws; we read the latched
;      result one frame later, free, instead of doing AABB math. Clear it
;      every frame (CXCLR) or a stale hit crashes a car that isn't there.
;   4. TIM64T/INTIM FRAME TIMING — set the RIOT timer for VBLANK/overscan and
;      let it absorb however much the game logic costs, instead of hand-
;      counting WSYNCs (which rolls the picture the moment logic grows).
;
; THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
; very different one. The markers tell you what's what:
;   HARDWARE IDIOM (load-bearing) — cycle-counted / footgun-dodging code;
;     reshape your gameplay around it (see TROUBLESHOOTING before changing).
;   GAME LOGIC (clay) — movement, scoring, tuning, art: reshape freely.
;
; GAME_TITLE: on the 2600 a title is DRAWN, not printed — there is no font
; hardware. The SWERVE/STREAK banner bitmaps near the bottom of this file ARE
; the title; redraw them for your game (the comment above each table shows
; the 40-pixel artwork and the PF0/PF1/PF2 bit-order encoding).
;
; CONTROLS (documented for players and for the fork README):
;   Title:  fire on JOYSTICK 0 (or console RESET) starts the game
;   Play:   joystick 0 LEFT/RIGHT steers your car across the road; survive
;           the descending traffic. The longer you last the FASTER it gets
;           (the centre dashes crawl faster, the traffic descends faster);
;           console RESET returns to the title
;   A crash flashes the screen and ends the run. Your DISTANCE this run is
;   your score; your best DISTANCE this session is shown on the title screen.
;
; PLAYERS — 1P, honest. The 2600 has two joystick ports, but this genre's
; kernel is already spending its scanline budget on the road playfield, your
; car (P0), a rival car (P1) and a hazard (M0). A second human car would
; need its OWN positioned object competing for the SAME 76-cycle two-line
; passes the road + traffic already fill — and a split-screen second road has
; no spare PF registers. So like the era's single-driver road games, SWERVE
; STREAK is single-player. (To add a 2P "best distance, alternating runs"
; mode — cheap, no extra kernel objects — keep a second hi-score and swap on
; crash; left as an exercise.)
;
; HI-SCORE HONESTY: real 2600 cartridges had NO battery, NO SRAM, NO
; persistence of any kind. The hi-score here lives in RIOT RAM ($A4) and
; survives game → title cycles only WITHIN one power-on session — exactly
; like the arcade machines of the era. Power off and it is gone. Do not
; fake an EEPROM; state it honestly in your fork too.
;
; NTSC frame: 3 VSYNC + 37 VBLANK + 192 visible + 30 overscan = 262 lines.

  processor 6502
  org $F000

; ── TIA write registers ───────────────────────────────────────────────
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
CXCLR    = $2C
; ── TIA audio ─────────────────────────────────────────────────────────
AUDC0    = $15
AUDC1    = $16
AUDF0    = $17
AUDF1    = $18
AUDV0    = $19
AUDV1    = $1A
; ── TIA READ registers (separate read map — the same addresses as some
; write strobes; e.g. CXPPMM reads $07 while STA $07 writes COLUP1) ─────
CXM0P    = $00          ; bit6 = missile0 / player0 collision (latched)
CXPPMM   = $07          ; bit7 = player0 / player1 collision (latched)
INPT4    = $0C          ; joystick 0 fire (bit7, ACTIVE LOW)
; ── RIOT ──────────────────────────────────────────────────────────────
SWCHA    = $280         ; joysticks: P0 = high nibble, P1 = LOW nibble
SWCHB    = $282         ; console: bit0 RESET, bit1 SELECT (ACTIVE LOW)
INTIM    = $284         ; timer read
TIM64T   = $296         ; timer set, 64-cycle ticks

; ── Zero-page state (the 2600's ENTIRE RAM is $80-$FF — 128 bytes; in
; core memory dumps system_ram offset 0 = $80) ────────────────────────
STATE     = $80         ; 0 = title, 1 = play, 2 = game over
P_X       = $81         ; player car X column (visible 0..159)
E1_X      = $82         ; rival car (P1) X column
E1_Y      = $83         ; rival car TOP scanline (beam counts 192→1, so a
                        ;   SMALLER value = LOWER on screen = closer to you)
E2_X      = $84         ; hazard (M0) X column
E2_Y      = $85         ; hazard TOP scanline
SPEED     = $86         ; current speed 1..6 — drives scroll + descent rate
SCROLL    = $87         ; centre-line dash phase 0..7 (the road's "motion")
DIST      = $88         ; distance score, BCD (digit nibbles fall out free)
DIST_HI   = $89         ; distance score high byte, BCD (hundreds/thousands)
FRAME     = $8A
SFX_LEFT  = $8B         ; frames remaining on the voice-0 sound effect
TUNE_SEL  = $8C         ; 0 = title jingle, 1 = game-over tune (voice 1)
TUNE_POS  = $8D
TUNE_LEFT = $8E         ; frames left on current jingle note (0 = silent)
OVER_T    = $8F         ; game-over auto-return-to-title countdown
FLASH     = $90         ; >0 = crash-flash frames remaining
SWCHB_PRV = $91         ; previous SWCHB for RESET edge detect
FIRE_PRV  = $92         ; previous fire level (bit7) for fire-edge detect
EDGEB     = $93         ; this frame's RESET press-edge (bit0)
FIRE_EDG  = $94         ; this frame's fire press-edge (bit7)
TMP       = $95
TICK      = $96         ; distance accumulator: +1 score every N frames
S0BUF     = $97         ; 6 rows: packed score digits for the kernel
SCRATCH   = $9D         ; 6 bytes general kernel/packer scratch
DIST_HSV  = $A4         ; SESSION hi-score (BCD low byte). RAM only — real
DIST_HSH  = $A5         ;   2600 carts have no battery; honest by design.
HSBUF     = $A6         ; 6 rows: hi-score, packed

COL_CAR   = $1E         ; yellow player car
COL_RIVAL = $46         ; red rival car (also colours the M0 hazard)
COL_ROAD  = $0E         ; white road markings (edges + centre dash)
COL_TARMAC = $00        ; black tarmac background
DIST_PERIOD = 8         ; frames per +1 distance at SPEED 1 (faster = more)

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clr:
  STA $00,X             ; clears ALL of $00-$FF: zero page RAM AND the TIA
  DEX                   ; write registers (GRP/ENAxx/HMxx/audio all silenced
  BNE .clr             ; — the standard 2600 power-on hygiene)

  ; Fixed identity colors (the kernels rewrite COLUPF/COLUBK per band, but
  ; the car colors are constant all session).
  LDA #COL_CAR
  STA COLUP0
  LDA #COL_RIVAL
  STA COLUP1
  ; NUSIZ0: single-width car, but make MISSILE 0 (the hazard) 2px wide so it
  ; reads as debris, not a hairline. NUSIZ1: single-width rival car.
  LDA #%00010000       ; M0 width = 2px (bits 4-5 = 01); P0 single
  STA NUSIZ0
  LDA #%00000000
  STA NUSIZ1

  JSR enter_title

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; THE FRAME LOOP. 262 scanlines, every frame, forever. VBLANK and overscan
; are timed with the RIOT timer (TIM64T) instead of counted WSYNCs: set the
; timer, run however much game logic the state needs, then spin on INTIM.
; This is how shipped 2600 games did it, and it kills the classic homebrew
; bug class where adding one branch to the game logic emits a 263rd line
; and the TV loses vsync (rolling picture). The VISIBLE 192 lines are still
; counted exactly — every STA WSYNC below is one scanline, and each state's
; kernel accounts for all 192.
; ──────────────────────────────────────────────────────────────────────
MAIN:
  ; VSYNC: 3 lines
  LDA #2
  STA VBLANK
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC
  ; 37 lines of VBLANK = 2812 cycles ≈ 43 × 64-cycle timer ticks.
  LDA #43
  STA TIM64T

  JSR frame_logic       ; all game thinking happens in the blanked region

  ; burn whatever VBLANK time the logic didn't use
.vbwait:
  LDA INTIM
  BNE .vbwait
  STA WSYNC

  ; kernel dispatch — title has its own kernel; play and game-over share one
  LDA STATE
  BNE .ingame
  JMP title_kernel
.ingame:
  JMP play_kernel

kernel_done:
  ; overscan: 30 lines, timer-paced like VBLANK
  LDA #2
  STA VBLANK
  LDA #35
  STA TIM64T
.oswait:
  LDA INTIM
  BNE .oswait
  STA WSYNC
  JMP MAIN

; ──────────────────────────────────────────────────────────────────────
; Per-frame logic, dispatched by state. Runs entirely inside the timed
; VBLANK window (~2800 cycles — an eternity next to the kernel's 76/line).
; ──────────────────────────────────────────────────────────────────────
frame_logic:
  INC FRAME
  JSR audio_tick

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; Console RESET + fire button are ACTIVE LOW and not debounced; a held
  ; RESET would restart every frame. Convert to press-EDGES once per frame:
  ; edge = was-released-last-frame AND pressed-now.
  LDA SWCHB
  TAX                   ; X = current switch levels
  EOR #$FF              ; A = pressed-now mask (1 = held)
  AND SWCHB_PRV         ; ...that were RELEASED (1) last frame
  STA EDGEB             ; bit0 = RESET edge
  STX SWCHB_PRV
  ; fire button → same edge treatment in bit7
  LDA #0
  BIT INPT4
  BMI .fup              ; bit7 set = not pressed (active low)
  ORA #$80
.fup:
  TAY                   ; Y = pressed-now (bit7)
  LDA FIRE_PRV
  EOR #$FF
  STA TMP               ; released-last-frame mask
  TYA
  AND TMP
  STA FIRE_EDG          ; bit7 = fire press-edge
  STY FIRE_PRV

  LDA STATE
  BEQ logic_title
  CMP #1
  BEQ logic_play_jmp
  JMP logic_over
logic_play_jmp:
  JMP logic_play

; ── GAME LOGIC (clay — reshape freely) ── title-screen behavior ────────
logic_title:
  ; fire 0 or console RESET starts the game.
  LDA FIRE_EDG
  BMI .start            ; bit7 set = fire edge
  LDA EDGEB
  AND #$01
  BNE .start
  JMP .packtitle
.start:
  JMP start_game
.packtitle:
  ; Pack the hi-score into the title's display buffer (the kernel just
  ; streams bytes — all per-frame thinking happens HERE, in VBLANK, never
  ; inside a kernel). We show the low TWO digits of the best distance.
  LDA DIST_HSV
  JSR pack_two_digits
  LDY #0
.hst:
  LDA SCRATCH,Y         ; pack_two_digits left 6 rows in SCRATCH..SCRATCH+5
  STA HSBUF,Y
  INY
  CPY #6
  BNE .hst

  ; title shows no moving objects
  LDA #0
  STA GRP0
  STA GRP1
  STA ENAM0
  RTS

; ── GAME LOGIC (clay — reshape freely) ── one frame of the racer ───────
logic_play:
  LDA EDGEB
  AND #$01              ; console RESET → back to title
  BEQ .noquit
  JMP enter_title
.noquit:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; SWCHA is ACTIVE LOW (0 = pressed) and must be RE-LOADED for every
  ; direction check. The classic bug: caching it in A and chaining ASLs,
  ; then clobbering A with game state between shifts — "right works once,
  ; left never steers". Fresh LDA SWCHA + AND #mask per check is immune.
  ; Joystick 0 lives in the HIGH nibble: bit7 right, bit6 left.
  LDA SWCHA
  AND #$80             ; joy0 right
  BNE .nr
  LDA P_X
  CMP #128             ; right road edge
  BCS .nr
  INC P_X
  INC P_X
.nr:
  LDA SWCHA            ; RE-LOAD — never trust A to still hold SWCHA
  AND #$40             ; joy0 left
  BNE .nl
  LDA P_X
  CMP #28             ; left road edge
  BCC .nl
  DEC P_X
  DEC P_X
.nl:

  ; ── GAME LOGIC (clay) — road MOTION. No scroll hardware exists, so the
  ; centre-line dash phase crawls every frame: subtract SPEED from SCROLL
  ; and wrap mod 8. The kernel reads (Y + SCROLL) & 8 to decide whether a
  ; dash is lit on each line — so as SCROLL counts down, the lit bands
  ; appear to march DOWN the screen toward you = forward speed.
  LDA SCROLL
  SEC
  SBC SPEED
  AND #$07
  STA SCROLL

  ; crash-flash countdown (cosmetic; the crash itself ends the run below)
  LDA FLASH
  BEQ .noflash
  DEC FLASH
.noflash:

  ; ── GAME LOGIC (clay) — descend the rival car. Beam-Y counts 192→1 going
  ; DOWN the screen, so "moving down toward the player" = SUBTRACT from Y.
  ; When it passes the bottom, recycle it to the top in a new (deterministic)
  ; lane and bump distance — you survived a car.
  LDA E1_Y
  SEC
  SBC SPEED
  STA E1_Y
  CMP #20              ; passed the bottom of the road?
  BCS .e1ok
  LDA #180
  STA E1_Y            ; back to the top
  LDA FRAME
  AND #$3F
  CLC
  ADC #40
  STA E1_X            ; new deterministic lane from FRAME
.e1ok:

  ; hazard M0 descends a touch faster (SPEED + 1) and recycles likewise.
  LDA E2_Y
  SEC
  SBC SPEED
  SEC
  SBC #1
  STA E2_Y
  CMP #18
  BCS .e2ok
  LDA #176
  STA E2_Y
  LDA FRAME
  EOR #$5A
  AND #$3F
  CLC
  ADC #36
  STA E2_X
.e2ok:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; CRASH via the TIA's hardware collision LATCHES — the 2600 detects P0/P1
  ; and M0/P0 pixel overlap in silicon while it draws; we read the latched
  ; result here, one frame late, for free (no AABB math). Rules:
  ;   * latches accumulate until CXCLR — clear them EVERY frame, or a stale
  ;     hit from 10 frames ago crashes a car that isn't there;
  ;   * P0/P1 = CXPPMM bit7 (N flag after BIT); M0/P0 = CXM0P bit6 (V flag).
  BIT CXPPMM           ; bit7 (N) = player car overlapped the rival car
  BMI do_crash
  BIT CXM0P            ; bit6 (V) = the hazard overlapped the player car
  BVS do_crash
  JMP .nocrash
do_crash:
  STA CXCLR            ; clear the latch BEFORE leaving (next frame is title)
  JMP do_game_over
.nocrash:
  STA CXCLR            ; arm the latches fresh for the frame we're about to draw

  ; ── GAME LOGIC (clay) — distance score. +1 every DIST_PERIOD/SPEED frames
  ; (faster speed scores faster). When DIST crosses a multiple of $20 in
  ; BCD, ramp SPEED (cap 6): the longer you survive, the harder it gets.
  INC TICK
  LDA SPEED
  STA TMP
  LDA #DIST_PERIOD
  SEC
  SBC TMP              ; period = 8 - SPEED → faster cars score faster
  CMP TICK
  BCS .notick
  LDA #0
  STA TICK
  JSR add_distance
  ; ramp speed when the tens digit rolls (every 16 distance, capped at 6)
  LDA DIST
  AND #$0F
  BNE .notick
  LDA SPEED
  CMP #6
  BCS .notick
  INC SPEED
  LDA #$08            ; "rev" speed-up blip
  LDX #$03
  LDY #10
  JSR sfx_play
.notick:

  JMP pack_score       ; render DIST into the kernel's row buffer (tail-RTS)

; ── GAME LOGIC (clay — reshape freely) ── game-over freeze-frame ───────
logic_over:
  LDA EDGEB
  AND #$01
  BNE .toTitle
  LDA FIRE_EDG
  BMI .toTitle
  DEC OVER_T
  BNE .stay
.toTitle:
  JMP enter_title
.stay:
  ; freeze: hold the traffic where it crashed; flash the tarmac red/black
  LDA FRAME
  AND #$08
  BEQ .flBlack
  LDA #$42             ; dark red
  JMP .flSet
.flBlack:
  LDA #COL_TARMAC
.flSet:
  STA FLASH            ; reuse FLASH as the freeze-flash color carrier
  RTS

; ── GAME LOGIC (clay — reshape freely) ── helpers ──────────────────────

add_distance:          ; +1 distance, BCD, capped at 9999
  SED
  LDA DIST
  CLC
  ADC #$01
  STA DIST
  LDA DIST_HI
  ADC #0               ; carry into the high byte
  STA DIST_HI
  CLD
  ; keep the running session hi-score (best distance)
  LDA DIST_HI
  CMP DIST_HSH
  BCC .nohs
  BNE .seths
  LDA DIST
  CMP DIST_HSV
  BCC .nohs
.seths:
  LDA DIST
  STA DIST_HSV
  LDA DIST_HI
  STA DIST_HSH
.nohs:
  RTS

do_game_over:
  LDA #2
  STA STATE
  LDA #200             ; ~3.3 s freeze, then auto-return to title
  STA OVER_T
  LDA #12
  STA FLASH
  LDA #1
  STA TUNE_SEL
  ; crash noise on voice 0 (over the game-over tune on voice 1)
  LDA #$1F
  LDX #$08
  LDY #16
  JSR sfx_play
  JMP tune_start       ; game-over tune on voice 1

start_game:
  LDA #0
  STA DIST
  STA DIST_HI
  STA TICK
  STA SCROLL
  STA FLASH
  STA TUNE_LEFT        ; silence the title jingle
  STA AUDV1
  LDA #1
  STA SPEED
  LDA #76
  STA P_X              ; player mid-road, near the bottom
  LDA #50
  STA E1_X
  LDA #150
  STA E1_Y             ; rival car starts up top
  LDA #104
  STA E2_X
  LDA #130
  STA E2_Y
  LDA #1
  STA STATE
  LDA #$06             ; start blip
  LDX #$04
  LDY #10
  JMP sfx_play

enter_title:
  LDA #0
  STA STATE
  STA GRP0
  STA GRP1
  STA ENAM0
  STA AUDV0
  STA SFX_LEFT
  STA FLASH
  STA TUNE_SEL         ; title jingle
  JMP tune_start

digit_times6:           ; A = digit 0-9 → A = digit*6 (DIGITS row index)
  STA TMP
  ASL
  CLC
  ADC TMP              ; *3
  ASL                 ; *6
  RTS

; pack_two_digits — A = a BCD byte (two digits). Writes 6 rows into SCRATCH,
; left digit (high nibble) in PF1 high nibble, right digit (low nibble) in
; PF1 low nibble. In SCORE mode the byte draws twice (two colors) — the
; classic dual-score look — but here both halves carry the SAME packed pair.
pack_two_digits:
  PHA
  LSR
  LSR
  LSR
  LSR                  ; high (tens) digit
  JSR digit_times6
  TAX
  LDY #0
.pd0:
  LDA DIGITS,X
  STA SCRATCH,Y        ; high nibble of font = left digit
  INX
  INY
  CPY #6
  BNE .pd0
  PLA
  AND #$0F             ; low (ones) digit
  JSR digit_times6
  TAX
  LDY #0
.pd1:
  LDA DIGITS,X
  LSR
  LSR
  LSR
  LSR                  ; ones in the LOW nibble
  ORA SCRATCH,Y
  STA SCRATCH,Y
  INX
  INY
  CPY #6
  BNE .pd1
  RTS

pack_score:             ; render the low two DIST digits into S0BUF
  LDA DIST
  JSR pack_two_digits
  LDY #0
.pks:
  LDA SCRATCH,Y
  STA S0BUF,Y
  INY
  CPY #6
  BNE .pks
  RTS

; ── GAME LOGIC (clay — reshape freely) ── TIA sound ────────────────────
; Voice 0 = one-shot sound effects (engine revs + crash); voice 1 = the
; jingle player. Separate voices means a rev blip never cuts the tune off.
sfx_play:               ; A = AUDF pitch, X = AUDC waveform, Y = frames
  STA AUDF0
  STX AUDC0
  STY SFX_LEFT
  LDA #$0C
  STA AUDV0
  RTS

tune_start:             ; TUNE_SEL chosen by caller (0 title, 1 game over)
  LDA #0
  STA TUNE_POS
  JSR tune_note
  LDA #$04              ; pure square wave
  STA AUDC1
  LDA #$06
  STA AUDV1
  LDA #10
  STA TUNE_LEFT
  RTS

tune_note:              ; load AUDF1 from the selected table at TUNE_POS;
  LDX TUNE_POS          ; returns Z set (A=0) on the $FF terminator
  LDA TUNE_SEL
  BNE .tn1
  LDA TITLE_TUNE,X
  JMP .tn2
.tn1:
  LDA OVER_TUNE,X
.tn2:
  CMP #$FF
  BEQ .tnEnd
  STA AUDF1
  LDA #1
  RTS
.tnEnd:
  LDA #0
  STA AUDV1
  RTS

audio_tick:             ; called once per frame, every state
  LDA SFX_LEFT
  BEQ .at1
  DEC SFX_LEFT
  BNE .at1
  LDA #0
  STA AUDV0             ; sfx finished → silence voice 0
.at1:
  LDA TUNE_LEFT
  BEQ .at2
  DEC TUNE_LEFT
  BNE .at2
  INC TUNE_POS
  JSR tune_note
  BEQ .at2              ; hit the terminator → tune stays off
  LDA #10
  STA TUNE_LEFT
.at2:
  RTS

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; OBJECT POSITIONING — the canonical SBC-#15 beam-race. There is no "X
; register" for sprites: you strobe RESPx/RESM0 and the object lands
; WHEREVER THE BEAM IS. Each SBC/BCS lap is 5 CPU cycles = 15 beam pixels,
; so when the subtraction underflows the beam has crossed x/15 coarse
; columns; the remainder, EOR #7 shifted to the high nibble, becomes the
; ±7px fine offset HMOVE applies on the next line. The naive "divide first,
; then burn a delay loop" version lands in the WRONG column. Three objects =
; three WSYNC lines + one shared HMOVE line, all inside timed VBLANK.
; ──────────────────────────────────────────────────────────────────────
position_objects:
  STA WSYNC
  STA HMCLR
  LDA P_X               ; player car → P0
  STA WSYNC
  SEC
.d0:
  SBC #15
  BCS .d0
  EOR #7
  ASL
  ASL
  ASL
  ASL
  STA RESP0
  STA HMP0
  LDA E1_X              ; rival car → P1
  STA WSYNC
  SEC
.d1:
  SBC #15
  BCS .d1
  EOR #7
  ASL
  ASL
  ASL
  ASL
  STA RESP1
  STA HMP1
  LDA E2_X              ; hazard → M0
  STA WSYNC
  SEC
.d2:
  SBC #15
  BCS .d2
  EOR #7
  ASL
  ASL
  ASL
  ASL
  STA RESM0
  STA HMM0
  STA WSYNC
  STA HMOVE             ; one HMOVE applies ALL the fine offsets; it must
  RTS                   ; come fresh after a WSYNC (mid-line HMOVE combs)

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; THE PLAY/GAME-OVER KERNEL — 192 visible lines, fully accounted:
;   24 = score bar  +  168 = road (84 two-line passes)
;
; SCORE BAR (SCORE mode): CTRLPF = $02 colors the LEFT playfield half with
; COLUP0 and the RIGHT half with COLUP1 — a two-color scoreboard with zero
; sprites. We stream the packed distance digits into PF1, one font row per
; 4 scanlines.
;
; ROAD (two-line kernel): one line of road work — road edges (PF0/PF2) +
; scrolling centre dash (PF) + ONE car test — is ~80+ cycles, more than a
; single 76-cycle scanline allows. So each loop pass spans TWO scanlines:
;   line A draws the road playfield (rails + centre dash) + the player car;
;   line B draws the rival car (P1) + the hazard (M0).
; 84 passes × 2 = 168 lines; objects move in 2-px steps (invisible on 1977
; televisions). The road's MOTION is in the dash phase (SCROLL), updated in
; VBLANK — the kernel only READS it; never animate inside a kernel.
; ──────────────────────────────────────────────────────────────────────
play_kernel:
  ; positioning runs first, inside the still-blanked region
  JSR position_objects

  LDA #COL_TARMAC
  STA COLUBK
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA GRP1
  STA ENAM0
  STA VBLANK            ; beam on
  LDA #$0E
  STA COLUPF            ; score digits bright
  LDA #$02
  STA CTRLPF           ; SCORE mode for the score bar

  ; ---- score bar: 24 lines (6 font rows × 4) ----
  ; S0BUF was packed in logic_play (VBLANK); stream it here. Two visible
  ; digits (tens/ones of DIST), doubled by SCORE mode into two colors.
  LDX #0
.sbar:
  STA WSYNC
  TXA
  LSR
  LSR
  TAY                   ; row = line/4
  LDA S0BUF,Y
  STA PF1
  INX
  CPX #24
  BNE .sbar

  ; transition: clear the bar, switch the TIA to the road. CTRLPF bit0
  ; (reflect) MIRRORS the 20-pixel playfield so the left rail draws a
  ; matching right rail for free — the road is symmetric. COLUPF = the
  ; white road markings; COLUBK = black tarmac.
  STA WSYNC
  LDA #$01
  STA CTRLPF           ; reflect mode: symmetric rails
  LDA #COL_ROAD
  STA COLUPF
  LDA #COL_TARMAC
  STA COLUBK

  ; ---- road: Y from 168 down to 1 (84 two-line passes) ----
  LDY #168
.road:
  ; ============ line A: road playfield + player car ============
  STA WSYNC
  ; Road EDGES: PF0 high nibble bit4 is the leftmost visible PF pixel; one
  ; rail bar there, mirrored by reflect to the right edge. Constant rails.
  LDA #%00010000
  STA PF0
  ; Centre DASH via PF2 — lit on some line groups, phased by SCROLL so the
  ; lit bands crawl DOWN the screen (forward motion). (Y + SCROLL) & 8.
  TYA
  CLC
  ADC SCROLL
  AND #%00001000
  BEQ .nodash
  LDA #%00011000       ; centre-ish PF2 pixels = the lane dash
  STA PF2
  JMP .dashdone
.nodash:
  LDA #0
  STA PF2
.dashdone:
  ; Player car: 8 rows in the bottom band (Y in [22,30)).
  TYA
  SEC
  SBC #22
  CMP #8
  BCS .noPlayer
  TAX
  LDA CAR,X
  STA GRP0
  JMP .playerDone
.noPlayer:
  LDA #0
  STA GRP0
.playerDone:
  ; ============ line B: rival car + hazard ============
  STA WSYNC
  ; Rival car P1: 8 rows starting at E1_Y.
  TYA
  SEC
  SBC E1_Y
  CMP #8
  BCS .noRival
  TAX
  LDA CAR,X
  STA GRP1
  JMP .rivalDone
.noRival:
  LDA #0
  STA GRP1
.rivalDone:
  ; Hazard M0: enabled for 4 rows at E2_Y (0..3 from its top).
  TYA
  SEC
  SBC E2_Y
  CMP #4
  BCS .noHaz
  LDA #2
  STA ENAM0
  JMP .hazDone
.noHaz:
  LDA #0
  STA ENAM0
.hazDone:

  DEY
  DEY
  BNE .road

  ; clear the playfield so it doesn't bleed into overscan
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA GRP1
  STA ENAM0
  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; THE TITLE KERNEL — 192 lines, banded:
;   24 blank + 28 banner "SWERVE" + 8 gap + 28 banner "STREAK" + 16 gap +
;   24 hi-score + remainder pad = 192
;
; The banner is an ASYMMETRIC PLAYFIELD — the 2600's only way to draw
; full-width artwork. The playfield registers hold just 20 pixels; the TIA
; replays them for the right half of the line (CTRLPF bit0 chooses repeat
; or mirror). For 40 INDEPENDENT pixels you rewrite all three registers
; mid-line, each inside its window (CPU cycle = 3 color clocks; left copy
; reads at clocks 68-147, right copy at 148-227):
;   PF0 again after cycle ~28 (left copy drawn) before ~49 (right copy reads)
;   PF1 again after cycle ~39                   before ~54
;   PF2 again after cycle ~50                   before ~65
; The code below hits those windows by instruction order alone — count
; cycles before you reorder ANYTHING between the WSYNC and the last STA.
; REQUIRES: CTRLPF bit0 = 0 (repeat mode). In mirror mode the right half
; reads the registers in REVERSE order and every window above is wrong.
; ──────────────────────────────────────────────────────────────────────
title_kernel:
  LDA #$94             ; deep slate-blue backdrop (the night road)
  STA COLUBK
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA GRP1
  STA ENAM0
  STA CTRLPF           ; REPEAT mode — required by the banner (see above)
  STA VBLANK           ; beam on

  LDX #24              ; band 1: 24 blank lines
.tb1:
  STA WSYNC
  DEX
  BNE .tb1

  LDA #$9E             ; word 1 in light blue
  STA COLUPF
  LDX #0               ; band 2: 28 banner lines (7 rows × 4)
.ban1:
  STA WSYNC
  TXA                  ; row = line/4
  LSR
  LSR
  TAY
  LDA R1_PF0L,Y
  STA PF0
  LDA R1_PF1L,Y
  STA PF1
  LDA R1_PF2L,Y
  STA PF2
  LDA R1_PF0R,Y
  STA PF0
  LDA R1_PF1R,Y
  STA PF1
  NOP
  NOP
  LDA R1_PF2R,Y
  STA PF2
  INX
  CPX #28
  BNE .ban1

  STA WSYNC            ; band 3: clear + 7 gap lines
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  LDX #7
.tb3:
  STA WSYNC
  DEX
  BNE .tb3

  LDA #$1E             ; word 2 in yellow (the headlights)
  STA COLUPF
  LDX #0               ; band 4: 28 banner lines, word 2
.ban2:
  STA WSYNC
  TXA
  LSR
  LSR
  TAY
  LDA R2_PF0L,Y
  STA PF0
  LDA R2_PF1L,Y
  STA PF1
  LDA R2_PF2L,Y
  STA PF2
  LDA R2_PF0R,Y
  STA PF0
  LDA R2_PF1R,Y
  STA PF1
  NOP
  NOP
  LDA R2_PF2R,Y
  STA PF2
  INX
  CPX #28
  BNE .ban2

  STA WSYNC            ; band 5: clear + 15 gap lines
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  LDA #$02
  STA CTRLPF           ; SCORE mode for the hi-score band
  LDX #15
.tb5:
  STA WSYNC
  DEX
  BNE .tb5

  ; band 6: hi-score, 24 lines (6 rows × 4). Packed digits stream into PF1;
  ; SCORE mode draws them twice in the two player colors. In-session best
  ; DISTANCE; honest: there is no battery — gone at power-off, like the
  ; arcades.
  LDX #0
.hsb:
  STA WSYNC
  TXA
  LSR
  LSR
  TAY
  LDA HSBUF,Y
  STA PF1
  INX
  CPX #24
  BNE .hsb

  STA WSYNC            ; band 7: clear + pad to exactly 192
  LDA #0
  STA PF1
  LDX #65
.tb7:
  STA WSYNC
  DEX
  BNE .tb7

  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── GAME LOGIC (clay — reshape freely) ── data tables ──────────────────
; Digit font: 4 pixels wide × 6 rows, stored in the HIGH nibble (PF1 bit7
; is the LEFTMOST pixel of the left playfield half — high nibble = left).
DIGITS:
  .byte $60,$90,$90,$90,$90,$60   ; 0
  .byte $20,$60,$20,$20,$20,$70   ; 1
  .byte $60,$90,$10,$20,$40,$F0   ; 2
  .byte $E0,$10,$60,$10,$10,$E0   ; 3
  .byte $90,$90,$F0,$10,$10,$10   ; 4
  .byte $F0,$80,$E0,$10,$10,$E0   ; 5
  .byte $60,$80,$E0,$90,$90,$60   ; 6
  .byte $F0,$10,$20,$40,$40,$40   ; 7
  .byte $60,$90,$60,$90,$90,$60   ; 8
  .byte $60,$90,$90,$70,$10,$60   ; 9

; Title jingle (voice 1, AUDC $04 square; AUDF divider — LOWER = higher
; pitch; 10 frames per note; $FF terminates). The table IS the song.
TITLE_TUNE:
  .byte $0F,$0C,$09,$0C,$0F,$13,$0F,$0C,$FF
; Game-over tune: a falling figure.
OVER_TUNE:
  .byte $09,$0C,$0F,$13,$17,$1B,$FF

; ── THE CAR SPRITE ────────────────────────────────────────────────────
; 8 rows: a forward-view car silhouette (cabin + body + wheels), drawn for
; the player via P0 and for the rival via P1 (same bitmap, different color).
CAR:
  .byte %00111100
  .byte %01111110
  .byte %01011010
  .byte %01111110
  .byte %11111111
  .byte %11111111
  .byte %01011010
  .byte %01111110

; ── THE TITLE BANNER ──────────────────────────────────────────────────
; 40-pixel-wide artwork, 7 rows per word, drawn by the asymmetric-playfield
; kernel above. Each row is six bytes across six tables (left PF0/PF1/PF2,
; right PF0/PF1/PF2). PF bit order is the 2600's great prank — three
; registers, three different orders:
;   PF0: only bits 4-7 used, bit 4 = LEFTMOST pixel   (reversed)
;   PF1: bit 7 = leftmost                              (normal)
;   PF2: bit 0 = leftmost                              (reversed again)
;
; The 40-px art for each row is the comment ASCII above each table; the
; bytes are mechanically encoded from it (left half = pixels 0..19 → PF0
; bits4-7 / PF1 bits7-0 / PF2 bits0-7; right half = pixels 20..39 likewise).
;
; SWERVE:
;   .####..#...#.####.####..#...#.####.......
;   .#.....#...#.#....#...#.#...#.#...........
;   .#.....#...#.#....#...#.#...#.#...........
;   .####..#.#.#.###..####..#.#..####........
;   ....#..#.#.#.#....#.#...#.#..#............
;   .#..#..#.#.#.#....#..#...#...#............
;   .####...#.#..####.#...#..#...####........
R1_PF0L:
  .byte %11100000, %00100000, %00100000, %11100000, %00000000, %00100000, %11100000
R1_PF1L:
  .byte %10010001, %00010001, %00010001, %10010101, %10010101, %10010101, %10001010
R1_PF2L:
  .byte %11011110, %01000010, %01000010, %11001110, %01000010, %01000010, %01011110
R1_PF0R:
  .byte %00110000, %01000000, %01000000, %00110000, %00010000, %00100000, %01000000
R1_PF1R:
  .byte %10001011, %10001010, %10001010, %10100111, %10100100, %01000100, %01000111
R1_PF2R:
  .byte %00000011, %00000000, %00000000, %00000001, %00000000, %00000000, %00000001

; STREAK:
;   .####..#####.####..####..###..#...#......
;   .#.......#...#...#.#.....#...#.#..#.......
;   .#.......#...#...#.#.....#...#.#.#........
;   .####....#...####..###...#####.##........
;   ....#....#...#.#...#.....#...#.#.#........
;   .#..#....#...#..#..#.....#...#.#..#.......
;   .####....#...#...#.####..#...#.#...#......
R2_PF0L:
  .byte %11100000, %00100000, %00100000, %11100000, %00000000, %00100000, %11100000
R2_PF1L:
  .byte %10011111, %00000100, %00000100, %10000100, %10000100, %10000100, %10000100
R2_PF2L:
  .byte %10011110, %10100010, %10100010, %10011110, %10001010, %10010010, %10100010
R2_PF0R:
  .byte %01110000, %00000000, %00000000, %00110000, %00000000, %00000000, %01110000
R2_PF1R:
  .byte %01110010, %01000101, %01000101, %01111101, %01000101, %01000101, %01000101
R2_PF2R:
  .byte %00000100, %00000100, %00000010, %00000001, %00000010, %00000100, %00001000

; ── Vector table ──────────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

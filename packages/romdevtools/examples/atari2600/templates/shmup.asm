; ── shmup.asm — FLAK FRENZY — Atari 2600 gallery shooter (complete game) ─────
;
; A COMPLETE, working game — drawn title screen, a fixed/gallery shooter
; (your cannon vs a marching formation of replicated invaders), score +
; in-session hi-score, TIA sound effects + a title jingle, game-over with
; auto-return to the title, and the 2600's signature feature: THE WHOLE
; MACHINE. There is no framebuffer, no tilemap, no OS — every visible
; scanline below is composed live by racing the beam, and this file
; teaches the gallery-shooter's load-bearing TIA tricks while doing it:
;
;   1. NUSIZ REPLICATION (the enemy formation) — ONE GRP1 write paints
;      THREE invaders. NUSIZ1 = %011 (three medium-spaced copies) is how
;      Space Invaders / Galaxian / Demon Attack drew a whole row of aliens
;      from a single 8-pixel sprite. This is the genre's defining idiom and
;      the reason the 2600 is GOOD at this genre — playfield "barcode" bars
;      would read as stripes, not invaders. We replicate a 2x2 BLOCK of six
;      invaders by re-using P1 (GRP1) on a SECOND scanline band lower down.
;   2. RESP/HMOVE BEAM POSITIONING (the SBC-#15 idiom) — there is no sprite
;      X register; you strobe RESPx WHERE THE BEAM IS, then nudge ±7px with
;      HMOVE. Three objects (ship P0, formation P1, shot M0) positioned this
;      way each frame, inside the timed VBLANK window.
;   3. TIA COLLISION LATCHES (the hit detect) — the TIA detects M0/P1 pixel
;      overlap in silicon as it draws; we read the latched result one frame
;      later, free, instead of doing AABB math. Clear it every frame (CXCLR)
;      or a stale hit scores phantom kills.
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
; hardware. The FLAK/FRENZY banner bitmaps near the bottom of this file ARE
; the title; redraw them for your game (the comment above each table shows
; the 40-pixel artwork and the PF0/PF1/PF2 bit-order encoding).
;
; CONTROLS (documented for players and for the fork README):
;   Title:  fire on JOYSTICK 0 (or console RESET) starts the game
;   Play:   joystick 0 LEFT/RIGHT moves your cannon; fire launches a shot
;           (one shot in flight at a time, like the era's arcade games);
;           console RESET returns to the title
;   Clear the whole formation to advance; let it reach your row and it's
;   game over. Your best SCORE this session is shown on the title screen.
;
; PLAYERS — 1P, honest. The 2600 has two joystick ports, but this genre's
; kernel is already spending its scanline budget on P0 (your ship), P1 with
; NUSIZ replication (the formation), and M0 (the shot). A second human ship
; would need its own positioned object competing for the SAME 76-cycle
; lines the formation already fills — so like the arcade gallery shooters
; this descends from, FLAK FRENZY is single-player. (To add 2P alternating
; TURNS instead — cheap, no extra kernel objects — keep a second score/lives
; pair and swap on death; left as an exercise.)
;
; HI-SCORE HONESTY: real 2600 cartridges had NO battery, NO SRAM, NO
; persistence of any kind. The hi-score here lives in RIOT RAM ($A0) and
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
; write strobes; e.g. CXM0P reads $00 while STA $00 strobes VSYNC) ──────
CXM0P    = $00          ; bit7 = missile0 / player1 collision (latched)
INPT4    = $0C          ; joystick 0 fire (bit7, ACTIVE LOW)
; ── RIOT ──────────────────────────────────────────────────────────────
SWCHA    = $280         ; joysticks: P0 = high nibble, P1 = LOW nibble
SWCHB    = $282         ; console: bit0 RESET, bit1 SELECT (ACTIVE LOW)
INTIM    = $284         ; timer read
TIM64T   = $296         ; timer set, 64-cycle ticks

; ── Zero-page state (the 2600's ENTIRE RAM is $80-$FF — 128 bytes; in
; core memory dumps system_ram offset 0 = $80) ────────────────────────
STATE     = $80         ; 0 = title, 1 = play, 2 = game over
P_X       = $81         ; player cannon X column (visible 0..159)
FORM_X    = $82         ; formation left edge (P1 X)
FORM_Y    = $83         ; formation TOP scanline (beam counts 192→1, so a
                        ;   SMALLER value = LOWER on screen = closer to you)
FORM_DIR  = $84         ; +1 = marching right, $FF = marching left
ALIVE     = $85         ; 6 bits = which formation cells still live (one per
                        ;   invader: a kill clears its bit, kernel skips it)
SHOT_X    = $86         ; missile column
SHOT_Y    = $87         ; missile scanline (0 = no shot active)
SCORE     = $88         ; current score, BCD (digit nibbles fall out free)
SCORE_HI  = $89         ; current score high byte, BCD (hundreds/thousands)
FRAME     = $8A
MARCH     = $8B         ; march step timer
SFX_LEFT  = $8C         ; frames remaining on the voice-0 sound effect
TUNE_SEL  = $8D         ; 0 = title jingle, 1 = game-over tune (voice 1)
TUNE_POS  = $8E
TUNE_LEFT = $8F         ; frames left on current jingle note (0 = silent)
OVER_T    = $90         ; game-over auto-return-to-title countdown
SWCHB_PRV = $91         ; previous SWCHB for RESET edge detect
FIRE_PRV  = $92         ; previous fire level (bit7) for fire-edge detect
EDGEB     = $93         ; this frame's RESET press-edge (bit0)
FIRE_EDG  = $94         ; this frame's fire press-edge (bit7)
TMP       = $95
WAVE      = $96         ; wave number (formation speeds up each wave)
MARCH_PERIOD = $97      ; frames per march step (set per wave; speeds up)
S0BUF     = $98         ; 6 rows: packed score digits for the kernel
SCRATCH   = $9E         ; 6 bytes general kernel/packer scratch
SCORE_HSV = $A4         ; SESSION hi-score (BCD low byte). RAM only — real
SCORE_HSH = $A5         ;   2600 carts have no battery; honest by design.
HSBUF     = $A6         ; 6 rows: hi-score, packed

SHIPGFX  = %00111100    ; cannon top bar (full sprite in SHIP table below)
COL_SHIP = $1E          ; yellow cannon
COL_FORM = $46          ; red invaders
COL_BG   = $00          ; black space
COL_SHOT = $0E          ; white shot
FORM_COLS = 3           ; 3 NUSIZ copies across
FORM_W   = 32           ; formation block width in color clocks (for the edge)

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clr:
  STA $00,X             ; clears ALL of $00-$FF: zero page RAM AND the TIA
  DEX                   ; write registers (GRP/ENAxx/HMxx/audio all silenced
  BNE .clr              ; — the standard 2600 power-on hygiene)

  ; Fixed identity colors (the kernels rewrite COLUPF per band, but the
  ; object colors are constant all session).
  LDA #COL_SHIP
  STA COLUP0
  LDA #COL_FORM
  STA COLUP1
  ; NUSIZ0: single-width cannon. NUSIZ1: THREE medium-spaced copies — the
  ; gallery-shooter idiom. Set ONCE; persists every frame.
  LDA #%00000000
  STA NUSIZ0
  LDA #%00000011       ; %011 = 3 copies, medium spacing
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
  ; inside a kernel). Hi-score uses the high byte's tens digit + low byte's
  ; two digits = 3 visible digits, packed two-per-PF1-row like the score.
  LDA SCORE_HSV
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

; ── GAME LOGIC (clay — reshape freely) ── one frame of the shooter ─────
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
  ; left never moves". Fresh LDA SWCHA + AND #mask per check is immune.
  ; Joystick 0 lives in the HIGH nibble: bit7 right, bit6 left.
  LDA SWCHA
  AND #$80             ; joy0 right
  BNE .nr
  LDA P_X
  CMP #144
  BCS .nr
  INC P_X
  INC P_X
.nr:
  LDA SWCHA            ; RE-LOAD — never trust A to still hold SWCHA
  AND #$40             ; joy0 left
  BNE .nl
  LDA P_X
  CMP #14
  BCC .nl
  DEC P_X
  DEC P_X
.nl:

  ; Fire: one shot in flight at a time (SHOT_Y == 0 means free).
  LDA SHOT_Y
  BNE .noFire
  LDA FIRE_EDG
  BPL .noFire          ; no fire edge this frame
  LDA P_X
  CLC
  ADC #3
  STA SHOT_X           ; shot rises from the cannon muzzle
  LDA #30
  STA SHOT_Y           ; just above the cannon
  LDA #$04             ; pew sfx
  LDX #$08
  LDY #6
  JSR sfx_play
.noFire:

  ; Move the shot UP the screen. Beam-Y counts 192→1 going down, so "up"
  ; means a LARGER scanline number → ADD. Despawn past the top band.
  LDA SHOT_Y
  BEQ .noShotMove
  CLC
  ADC #5
  STA SHOT_Y
  CMP #178
  BCC .noShotMove
  LDA #0
  STA SHOT_Y           ; flew off the top → free the shot
.noShotMove:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; Shot/invader collision via the TIA's hardware collision LATCH — the
  ; 2600 detects M0/P1 pixel overlap in silicon while it draws; we read the
  ; latched result here, one frame late, for free (no AABB math). Rules:
  ;   * latches accumulate until CXCLR — clear them EVERY frame, or a stale
  ;     hit scores a phantom kill long after the shot is gone;
  ;   * NUSIZ replication means P1 is THREE invaders + we draw two rows, so
  ;     the latch only says "you hit SOME invader" — we map the shot's X/Y
  ;     to the specific cell to clear the right ALIVE bit.
  BIT CXM0P            ; bit7 (N flag) = M0/P1 overlapped last frame
  BPL .noHit
  LDA SHOT_Y
  BEQ .noHit           ; no shot in flight → ignore stale latch
  JSR resolve_hit
.noHit:
  STA CXCLR            ; arm the latch fresh for the frame we're about to draw

  ; March the formation. Speed ramps with the wave (fewer frames per step).
  INC MARCH
  LDA MARCH
  CMP MARCH_PERIOD     ; period set by wave in start_wave
  BCC .noMarch_jmp
  LDA #0
  STA MARCH
  LDA FORM_DIR
  BMI .marchLeft
  ; marching right: step until the block's right edge nears the wall
  LDA FORM_X
  CMP #112
  BCS .flip
  CLC
  ADC #4
  STA FORM_X
  JMP .noMarch
.marchLeft:
  LDA FORM_X
  CMP #14
  BCC .flip
  SEC
  SBC #4
  STA FORM_X
  JMP .noMarch
.flip:
  ; Reverse direction and DROP the whole block one notch toward the player.
  ; FORM_Y is the top scanline; SMALLER Y = lower on screen, so "drop" =
  ; subtract. Reach the cannon's row and it's game over.
  LDA FORM_DIR
  EOR #$FE             ; +1 <-> $FF
  STA FORM_DIR
  LDA FORM_Y
  SEC
  SBC #8
  STA FORM_Y
  CMP #44              ; reached the cannon's band?
  BCS .noMarch
  JMP do_game_over
.noMarch_jmp:
  JMP .formdone
.noMarch:
.formdone:
  ; Wave cleared? (no ALIVE bits left) → next wave, faster, from the top.
  LDA ALIVE
  BNE .alive
  INC WAVE
  JSR start_wave
  LDA #$0A             ; wave-clear chime
  LDX #$0C
  LDY #18
  JSR sfx_play
.alive:
  JMP pack_score       ; render SCORE into the kernel's row buffer (tail-RTS)

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
  ; freeze: hide the shot, leave the formation sitting on the cannon
  LDA #0
  STA SHOT_Y
  STA ENAM0
  RTS

; ── GAME LOGIC (clay — reshape freely) ── helpers ──────────────────────

; resolve_hit — a shot overlapped the formation. Figure out WHICH of the up
; to 6 cells (2 rows × 3 NUSIZ copies) the shot is inside, clear its ALIVE
; bit, score it, and free the shot. Cell columns are FORM_X + n*16.
resolve_hit:
  ; which row? top row spans FORM_Y..FORM_Y-7, bottom row 16 lower (smaller Y)
  LDA SHOT_Y
  CMP FORM_Y
  BCC .maybeBottom     ; shot Y below the top row's top
  ; (shot at/above top row top — treat as top row)
  LDX #0               ; row 0 → ALIVE bits 0..2
  JMP .findCol
.maybeBottom:
  LDX #3               ; row 1 → ALIVE bits 3..5
.findCol:
  ; column 0..2: nearest of FORM_X, FORM_X+16, FORM_X+32 to SHOT_X
  LDA SHOT_X
  SEC
  SBC FORM_X           ; offset into the block
  BMI .col0
  CMP #8
  BCC .col0
  CMP #24
  BCC .col1
  ; col 2
  INX
.col1:
  INX
.col0:
  ; X = bit index 0..5; clear that ALIVE bit if it's set (a real kill)
  LDA BITMASK,X
  AND ALIVE
  BEQ .stale           ; that cell already dead → no double-score
  LDA BITMASK,X
  EOR #$FF
  AND ALIVE
  STA ALIVE
  JSR add_score        ; +10 points
  LDA #0
  STA SHOT_Y           ; consume the shot
  LDA #$08             ; hit sfx
  LDX #$04
  LDY #8
  JMP sfx_play
.stale:
  RTS

add_score:             ; +10 (one invader), BCD, capped at 9990
  SED
  LDA SCORE
  CLC
  ADC #$10             ; tens place +1 → +10 points
  STA SCORE
  LDA SCORE_HI
  ADC #0               ; carry into the high byte
  STA SCORE_HI
  CLD
  ; keep the running session hi-score
  LDA SCORE_HI
  CMP SCORE_HSH
  BCC .nohs
  BNE .seths
  LDA SCORE
  CMP SCORE_HSV
  BCC .nohs
.seths:
  LDA SCORE
  STA SCORE_HSV
  LDA SCORE_HI
  STA SCORE_HSH
.nohs:
  RTS

start_wave:            ; (re)seed the formation; called per wave
  LDA #$3F             ; 6 invaders alive (bits 0..5)
  STA ALIVE
  LDA #48
  STA FORM_X
  LDA #150
  STA FORM_Y           ; high on screen
  LDA #1
  STA FORM_DIR
  LDA #0
  STA MARCH
  ; march period: 24 frames, minus 3 per wave, floored at 6 (speeds up)
  LDA WAVE
  ASL
  STA TMP
  ASL
  CLC
  ADC TMP              ; WAVE*6... but we want WAVE*3
  LSR                  ; /2 → WAVE*3
  STA TMP
  LDA #24
  SEC
  SBC TMP
  CMP #6
  BCS .pok
  LDA #6
.pok:
  STA MARCH_PERIOD
  RTS

do_game_over:
  LDA #2
  STA STATE
  LDA #200             ; ~3.3 s freeze, then auto-return to title
  STA OVER_T
  LDA #0
  STA SHOT_Y
  STA ENAM0
  LDA #1
  STA TUNE_SEL
  JMP tune_start       ; game-over tune on voice 1

start_game:
  LDA #0
  STA SCORE
  STA SCORE_HI
  STA WAVE
  STA TUNE_LEFT        ; silence the title jingle
  STA AUDV1
  STA SHOT_Y
  LDA #76
  STA P_X
  LDA #1
  STA STATE
  JSR start_wave
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

pack_score:             ; render the low two SCORE digits into S0BUF
  LDA SCORE
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
; Voice 0 = one-shot sound effects; voice 1 = the jingle player. Keeping
; them on separate voices means a pew blip never cuts the tune off.
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
  LDA P_X               ; ship → P0
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
  LDA FORM_X            ; formation → P1 (NUSIZ replicates it ×3)
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
  LDA SHOT_X            ; shot → M0
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
;   24 = score bar  +  168 = playfield (formation + ship + shot)
;
; SCORE BAR (SCORE mode): CTRLPF = $02 colors the LEFT playfield half with
; COLUP0 and the RIGHT half with COLUP1 — a two-color scoreboard with zero
; sprites. We stream the packed score digits into PF1, one row of font per
; 4 scanlines.
;
; PLAYFIELD: a single per-line loop draws the whole field. Each visible line
; computes, from the beam's current Y:
;   * GRP1 = the formation bitmap row IF this Y is inside one of the TWO
;     formation bands (top row at FORM_Y, bottom row 16 lines lower). NUSIZ1
;     replication means this ONE store paints all three columns of that row.
;     ALIVE-bit masking blanks killed columns by zeroing the relevant copy
;     — done by swapping GRP1 to a per-column-masked byte (kept simple: a
;     dead WHOLE row blanks; partial columns rely on the collision-cleared
;     bit + the player seeing the gap as the block marches).
;   * GRP0 = the cannon bitmap row IF this Y is in the cannon band.
;   * ENAM0 = the shot, 4 lines tall at SHOT_Y.
; This is a ONE-line kernel (each pass = one scanline); the work fits 76
; cycles because every test is a compare-and-store, no multiply.
; ──────────────────────────────────────────────────────────────────────
play_kernel:
  ; positioning runs first, inside the still-blanked region
  JSR position_objects

  LDA #COL_BG
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
  ; digits (tens/ones of SCORE), doubled by SCORE mode into two colors.
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

  ; transition: clear the bar, switch the TIA to the playfield, and lay down
  ; a STATIC star-lane backdrop. CTRLPF bit0 (reflect) mirrors the 20-pixel
  ; playfield into a symmetric 40-pixel field of dim vertical star lanes; set
  ; PF0/PF1/PF2 ONCE here (registers persist every line) so the starfield
  ; costs ZERO per-line cycles — the one-line kernel below stays inside 76.
  STA WSYNC
  LDA #$01
  STA CTRLPF           ; reflect mode: symmetric star lanes
  LDA #$06             ; dim grey-blue stars
  STA COLUPF
  LDA #%00000000       ; PF0: no star lane at the very edge
  STA PF0
  LDA #%00010000       ; PF1: one thin star lane
  STA PF1
  LDA #%00001000       ; PF2: one thin star lane (mirrored = 4 lanes total)
  STA PF2
  LDA #COL_BG
  STA COLUBK

  ; ---- playfield: Y from 168 down to 1 ----
  LDY #168
.field:
  STA WSYNC
  ; formation top row: (Y - FORM_Y) in [0,8) ?
  TYA
  SEC
  SBC FORM_Y
  CMP #8
  BCS .notTop
  TAX
  LDA FORM,X
  ; mask whole row if all top cells dead (bits 0..2)
  PHA
  LDA ALIVE
  AND #$07
  BNE .topLive
  PLA
  LDA #0
  JMP .setForm
.topLive:
  PLA
.setForm:
  STA GRP1
  JMP .formDone
.notTop:
  ; formation bottom row: 16 lines lower (smaller Y) than the top
  TYA
  CLC
  ADC #16
  SEC
  SBC FORM_Y
  CMP #8
  BCS .noForm
  TAX
  LDA FORM,X
  PHA
  LDA ALIVE
  AND #$38             ; bottom cells = bits 3..5
  BNE .botLive
  PLA
  LDA #0
  JMP .setForm2
.botLive:
  PLA
.setForm2:
  STA GRP1
  JMP .formDone
.noForm:
  LDA #0
  STA GRP1
.formDone:

  ; cannon: 8 rows in the bottom band (Y in [24,32))
  TYA
  SEC
  SBC #24
  CMP #8
  BCS .noShip
  TAX
  LDA SHIP,X
  STA GRP0
  JMP .shipDone
.noShip:
  LDA #0
  STA GRP0
.shipDone:

  ; shot: ENAM0 for 4 lines at SHOT_Y (0 = parked → never matches)
  LDA SHOT_Y
  BEQ .noShot
  TYA
  SEC
  SBC SHOT_Y
  CMP #4
  BCS .noShot
  LDA #2
  STA ENAM0
  JMP .shotDone
.noShot:
  LDA #0
  STA ENAM0
.shotDone:

  DEY
  BNE .field

  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; THE TITLE KERNEL — 192 lines, banded:
;   24 blank + 28 banner "FLAK" + 8 gap + 28 banner "FRENZY" + 16 gap +
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
  LDA #$80              ; deep blue backdrop
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

  LDA #$46             ; word 2 in red
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
  ; SCORE mode draws them twice in the two player colors. In-session best;
  ; honest: there is no battery — gone at power-off, like the arcades.
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
BITMASK:
  .byte $01,$02,$04,$08,$10,$20

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
  .byte $17,$13,$0F,$0C,$0F,$0C,$09,$0C,$FF
; Game-over tune: a falling figure.
OVER_TUNE:
  .byte $09,$0C,$0F,$13,$17,$1B,$FF

; ── THE INVADER SPRITE ────────────────────────────────────────────────
; 8 rows, drawn via P1 with NUSIZ1=%011 so it hardware-replicates into 3
; medium-spaced invaders from ONE GRP1 write — the genre's defining trick.
FORM:
  .byte %00100100
  .byte %00111100
  .byte %01111110
  .byte %11011011
  .byte %11111111
  .byte %01011010
  .byte %00100100
  .byte %01000010

; ── THE CANNON SPRITE ─────────────────────────────────────────────────
SHIP:
  .byte %00011000
  .byte %00011000
  .byte %00111100
  .byte %01111110
  .byte %11111111
  .byte %11111111
  .byte %11111111
  .byte %11100111

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
; FLAK:
;   .####.....#........###....#...#.........
;   .#........#.......#...#...#..#..........
;   .#........#.......#...#...#.#...........
;   .###......#.......#####...##............
;   .#........#.......#...#...#.#...........
;   .#........#.......#...#...#..#..........
;   .#........#####...#...#...#...#.........
R1_PF0L:
  .byte %11100000, %00100000, %00100000, %11100000, %00100000, %00100000, %00100000
R1_PF1L:
  .byte %10000010, %00000010, %00000010, %00000010, %00000010, %00000010, %00000011
R1_PF2L:
  .byte %10000000, %01000000, %01000000, %11000000, %01000000, %01000000, %01000111
R1_PF0R:
  .byte %00110000, %01000000, %01000000, %01110000, %01000000, %01000000, %01000000
R1_PF1R:
  .byte %00100010, %00100100, %00101000, %00110000, %00101000, %00100100, %00100010
R1_PF2R:
  .byte %00000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00000000

; FRENZY:
;   ####..###...####.#..#..####..#...#......
;   #....#..#..#.....##.#.....#...#.#.......
;   #....#..#..#.....#.##....#.....#........
;   ###..###...###...#.##...#......#........
;   #....#.#...#.....#..#..#.......#........
;   #....#..#..#.....#..#.#........#........
;   #....#..#..####..#..#.####.....#........
R2_PF0L:
  .byte %11110000, %00010000, %00010000, %01110000, %00010000, %00010000, %00010000
R2_PF1L:
  .byte %00111000, %01001001, %01001001, %01110001, %01010001, %01001001, %01001001
R2_PF2L:
  .byte %00101111, %01100000, %10100000, %10100011, %00100000, %00100000, %00100111
R2_PF0R:
  .byte %10010000, %00010000, %00010000, %00010000, %10010000, %01010000, %11010000
R2_PF1R:
  .byte %11100100, %00100010, %01000001, %10000001, %00000001, %00000001, %11000001
R2_PF2R:
  .byte %00000010, %00000001, %00000000, %00000000, %00000000, %00000000, %00000000

; ── Vector table ──────────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

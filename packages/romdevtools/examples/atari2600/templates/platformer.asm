; ── platformer.asm — PERCH PATROL — Atari 2600 single-screen platformer ──────
;
; A COMPLETE, working game — drawn title screen, a single-SCREEN platformer
; (you hop a P0 hero across PLAYFIELD ledges, grab the bouncing coin, dodge
; the patrolling spike), score + in-session hi-score, TIA sound effects + a
; title jingle, game-over with auto-return to the title, and the 2600's
; signature feature: THE WHOLE MACHINE. There is no framebuffer, no tilemap,
; no OS — every visible scanline below is composed live by racing the beam,
; and this file teaches the platformer's load-bearing TIA tricks while doing
; it:
;
;   1. PLAYFIELD-AS-LEVEL (the ledges + floor + pit) — the 2600 has NO
;      tilemap and NO hardware scroll, so the level IS the playfield. PF0/
;      PF1/PF2 are reloaded per scanline band from a per-row table; a lit PF
;      pixel is solid ground, a gap is a pit. This is exactly how the era's
;      single-screen platformers drew their arenas: the honest 2600
;      platformer is a FIXED screen (those games flip whole new screens at
;      the edges — they never scroll), so this one is too.
;   2. CODE COLLISION, NOT TIA LATCHES (land-on-ledge) — a shooter reads the
;      TIA's hardware overlap latch (FLAK FRENZY does), but a platformer must
;      know WHICH surface it's standing on to stop the fall there. So ground
;      contact is tested in CODE: sample the level's PF bit directly under
;      the hero's column at his feet's Y. (TIA latches are still used — for
;      the coin pickup and the spike death, where "did I touch it" is enough.)
;   3. RESP/HMOVE BEAM POSITIONING (the SBC-#15 idiom) — there is no sprite X
;      register; you strobe RESPx/RESBL/RESM0 WHERE THE BEAM IS, then nudge
;      ±7px with HMOVE. Hero P0, coin BL and spike M0 are positioned this way
;      every frame, inside the timed VBLANK window.
;   4. TIM64T/INTIM FRAME TIMING — set the RIOT timer for VBLANK/overscan and
;      let it absorb however much the game logic costs, instead of hand-
;      counting WSYNCs (which rolls the picture the moment logic grows).
;
; THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
; very different one. The markers tell you what's what:
;   HARDWARE IDIOM (load-bearing) — cycle-counted / footgun-dodging code;
;     reshape your gameplay around it (see TROUBLESHOOTING before changing).
;   GAME LOGIC (clay) — physics, level layout, scoring, tuning, art: reshape
;     freely (the LEVEL table near the bottom is pure clay — redraw it).
;
; GAME_TITLE: on the 2600 a title is DRAWN, not printed — there is no font
; hardware. The PERCH/PATROL banner bitmaps near the bottom of this file ARE
; the title; redraw them for your game (the comment above each table shows
; the 40-pixel artwork and the PF0/PF1/PF2 bit-order encoding).
;
; CONTROLS (documented for players and for the fork README):
;   Title:  fire on JOYSTICK 0 (or console RESET) starts the game
;   Play:   joystick 0 LEFT/RIGHT walks the hero; fire (or UP) JUMPS when
;           standing on a ledge; console RESET returns to the title
;   Grab the bouncing coin to score; touch the patrolling spike and it's
;   game over. Your best SCORE this session is shown on the title screen.
;
; PLAYERS — 1P, honest. The 2600 has two joystick ports, but this single-
; screen kernel is already spending its scanline budget on the PLAYFIELD
; level (per-row PF reload), the hero (P0), the coin (BL) and the spike
; (M0). A second human hero would need its own positioned object competing
; for the SAME 76-cycle lines the level reload already fills. To add 2P
; alternating TURNS instead — cheap, no extra kernel objects — keep a second
; score/lives pair and swap on death; left as an exercise.
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
RESBL    = $14
RESM0    = $12
GRP0     = $1B
GRP1     = $1C
ENABL    = $1F
ENAM0    = $1D
HMP0     = $20
HMBL     = $24
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
; write strobes; e.g. CXP0FB reads $02 while STA $02 strobes WSYNC) ─────
CXP0FB   = $02          ; bit6 = player0 / ball collision (latched)
CXM0P    = $00          ; bit7 = missile0 / player0 collision (latched)
INPT4    = $0C          ; joystick 0 fire (bit7, ACTIVE LOW)
; ── RIOT ──────────────────────────────────────────────────────────────
SWCHA    = $280         ; joysticks: P0 = high nibble, P1 = LOW nibble
SWCHB    = $282         ; console: bit0 RESET, bit1 SELECT (ACTIVE LOW)
INTIM    = $284         ; timer read
TIM64T   = $296         ; timer set, 64-cycle ticks

; ── Zero-page state (the 2600's ENTIRE RAM is $80-$FF — 128 bytes; in
; core memory dumps system_ram offset 0 = $80) ────────────────────────
STATE     = $80         ; 0 = title, 1 = play, 2 = game over
P_X       = $81         ; hero X column (visible 0..159; kept 12..148)
P_Y       = $82         ; hero FEET scanline in level space (0=floor .. up)
P_VY      = $83         ; vertical velocity, signed (jump up = +, fall = -)
ON_GND    = $84         ; 1 = standing on a ledge/floor this frame, 0 = airborne
COIN_X    = $85         ; coin (BL) X column
COIN_Y    = $86         ; coin Y in level space
COIN_VY   = $87         ; coin bounce velocity (signed)
SPK_X     = $88         ; spike (M0) X column
SPK_Y     = $89         ; spike Y in level space (which ledge it patrols)
SPK_DIR   = $8A         ; +1 marching right, $FF marching left
SCORE     = $8B         ; current score, BCD (digit nibbles fall out free)
SCORE_HI  = $8C         ; current score high byte, BCD
FRAME     = $8D
SFX_LEFT  = $8E         ; frames remaining on the voice-0 sound effect
TUNE_SEL  = $8F         ; 0 = title jingle, 1 = game-over tune (voice 1)
TUNE_POS  = $90
TUNE_LEFT = $91         ; frames left on current jingle note (0 = silent)
OVER_T    = $92         ; game-over auto-return-to-title countdown
SWCHB_PRV = $93         ; previous SWCHB for RESET edge detect
FIRE_PRV  = $94         ; previous fire level (bit7) for fire-edge detect
EDGEB     = $95         ; this frame's RESET press-edge (bit0)
FIRE_EDG  = $96         ; this frame's fire press-edge (bit7)
TMP       = $97
TMP2      = $98
P_ROW     = $99         ; hero's current level ROW (Y/16) — picked in logic,
                        ;   reused by the kernel to draw the hero band
COIN_ROW  = $9A         ; coin's level row (for the kernel)
SPK_ROW   = $9B         ; spike's level row (for the kernel)
GFXIDX    = $9C         ; hero sprite frame base (0 = idle, 6 = walk)
SCORE_HSV = $A0         ; SESSION hi-score (BCD low byte). RAM only — real
SCORE_HSH = $A1         ;   2600 carts have no battery; honest by design.
S0BUF     = $A2         ; 6 rows: packed score digits for the play kernel
HSBUF     = $A8         ; 6 rows: hi-score, packed (for the title kernel)
SCRATCH   = $AE         ; 6 bytes general kernel/packer scratch

; ── level geometry constants (clay — change to reshape the arena) ──────
; The level is NROWS bands of 16 scanlines. Each row carries a PF0/PF1/PF2
; triple (LEVEL table) = where the ground/ledges are on that band. P_Y is
; the hero's FEET measured 0 (bottom of the arena) upward; row = P_Y/16.
NROWS     = 9           ; 9 rows × 16 = 144 visible level lines (+24 score bar)
ROWH      = 16
GRAVITY   = 1           ; downward pull per frame
JUMP_VY   = 9           ; initial jump impulse
WALK_LO   = 12          ; hero X clamp
WALK_HI   = 148

HEROH     = 6           ; hero sprite height in scanlines
COIN_FLR  = 8           ; coin's bounce floor (level Y)
COIN_CEIL = 124         ; coin's bounce ceiling

COL_SKY   = $00         ; black space behind the arena
COL_HERO  = $3A         ; warm yellow hero
COL_LEDGE = $C6         ; green ledges/floor
COL_COIN  = $1E         ; bright yellow coin
COL_SPIKE = $44         ; red spike
COL_HUD   = $0E         ; white score digits

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
  LDA #COL_HERO
  STA COLUP0
  ; single-width hero. NUSIZ left at 0 = single objects everywhere.
  LDA #%00000000
  STA NUSIZ0
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
  ; inside a kernel). Two visible digits, packed two-per-PF1-row.
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
  STA ENABL
  STA ENAM0
  RTS

; ── GAME LOGIC (clay — reshape freely) ── one frame of the platformer ──
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
  ; Joystick 0 lives in the HIGH nibble: bit7 right, bit6 left, bit4 up.
  LDA SWCHA
  AND #$80             ; joy0 right
  BNE .nr
  LDA P_X
  CMP #WALK_HI
  BCS .nr
  INC P_X
  INC P_X
  LDA #6
  STA GFXIDX           ; walk frame while moving
.nr:
  LDA SWCHA            ; RE-LOAD — never trust A to still hold SWCHA
  AND #$40             ; joy0 left
  BNE .nl
  LDA P_X
  CMP #WALK_LO
  BCC .nl
  DEC P_X
  DEC P_X
  LDA #6
  STA GFXIDX
.nl:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; JUMP / GRAVITY — a fixed-point vertical-velocity counter, the heart of
  ; any platformer. P_VY is signed: positive = rising, negative = falling.
  ; JUMP is only allowed when ON_GND was true (set by the ground test BELOW,
  ; from last frame's footing) — the canonical "no mid-air double jump" gate.
  ; Beam-Y runs 192→1 top-to-bottom, but we keep P_Y in LEVEL space (0 =
  ; arena floor, growing UP) so the physics reads naturally; the kernel maps
  ; it back to a scanline.
  LDA ON_GND
  BEQ .noJump
  ; jump on fire edge OR joystick up
  LDA FIRE_EDG
  BMI .doJump
  LDA SWCHA
  AND #$10             ; joy0 up
  BNE .noJump
.doJump:
  LDA #JUMP_VY
  STA P_VY
  LDA #0
  STA ON_GND           ; we leave the ground this frame
  LDA #$0C             ; jump sfx
  LDX #$04
  LDY #6
  JSR sfx_play
.noJump:

  ; apply gravity to velocity, then velocity to position (signed integrate)
  LDA P_VY
  SEC
  SBC #GRAVITY
  STA P_VY
  CLC
  LDA P_Y
  ADC P_VY
  STA P_Y
  ; ceiling clamp (top of arena = NROWS*16 - HEROH)
  CMP #(NROWS*ROWH - HEROH)
  BCC .nceil
  ; only clamp when RISING into the ceiling (large value, not a fall-wrap)
  LDA P_VY
  BMI .nceil
  LDA #(NROWS*ROWH - HEROH)
  STA P_Y
  LDA #0
  STA P_VY             ; bonk the head → stop rising
.nceil:

  ; floor / fall-through clamp FIRST: P_Y is unsigned; a downward step past 0
  ; wraps to a large value. Detect that and snap to the floor (row 0 top).
  LDA P_Y
  CMP #(NROWS*ROWH)
  BCC .nfloor
  LDA #0               ; wrapped (fell below the floor) → clamp to floor
  STA P_Y
  STA P_VY
  LDA #1
  STA ON_GND
  JMP .landDone
.nfloor:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; LAND-ON-LEDGE collision — done in CODE, not via a TIA latch. A shooter
  ; can ask the TIA "did anything overlap?", but a platformer must know
  ; WHICH surface stopped the fall, to settle the hero exactly on top of it.
  ; Rule: only when FALLING (P_VY <= 0), look up the LEVEL row at the hero's
  ; FEET and test whether a solid PF pixel sits under his X column. If yes,
  ; snap his feet to that row's top, zero the velocity, and mark ON_GND for
  ; next frame's jump gate.
  LDA #0
  STA ON_GND
  LDA P_VY
  BPL .landDone        ; rising (P_VY > 0) → can't land
  ; falling. Which row are the feet in? row = P_Y / 16.
  LDA P_Y
  LSR
  LSR
  LSR
  LSR
  CMP #NROWS
  BCC .rowok
  LDA #(NROWS-1)
.rowok:
  STA TMP              ; TMP = row index
  JSR ground_under_hero ; C=1 if solid PF bit under P_X in row TMP
  BCC .landDone
  ; snap feet to the TOP of this row (row*16)
  LDA TMP
  ASL
  ASL
  ASL
  ASL                  ; row*16
  STA P_Y
  LDA #0
  STA P_VY
  LDA #1
  STA ON_GND
.landDone:

  ; ── GAME LOGIC (clay) — the COIN bounces in place; grab it to score ────
  ; The coin (TIA ball, BL) bounces vertically between COIN_FLR and
  ; COIN_CEIL. Touch it (P0/BL collision latch) → score + respawn it at a
  ; new pseudo-random column.
  LDA COIN_Y
  CLC
  ADC COIN_VY
  STA COIN_Y
  CMP #COIN_CEIL
  BCC .ncoinTop
  LDA #$FF             ; reverse to falling
  STA COIN_VY
.ncoinTop:
  LDA COIN_Y
  CMP #COIN_FLR
  BCS .ncoinBot
  LDA #1               ; reverse to rising
  STA COIN_VY
.ncoinBot:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; Coin pickup AND spike death both use the TIA's hardware collision
  ; LATCHES (P0/ball, P0/missile0). The TIA detects pixel overlap in silicon
  ; as it draws; we read the latched result here, one frame later, free.
  ; Rules: latches accumulate until CXCLR — clear them EVERY frame (we do at
  ; the end of this block), or a stale hit fires phantom pickups/deaths long
  ; after the object moved.
  BIT CXP0FB           ; bit6 (V flag) = P0/ball (hero/coin) overlapped
  BVC .noCoin
  JSR add_score        ; +10
  JSR respawn_coin
  LDA #$08             ; coin chime
  LDX #$0C
  LDY #8
  JSR sfx_play
.noCoin:

  ; ── GAME LOGIC (clay) — the SPIKE patrols a ledge left/right ───────────
  LDA SPK_X
  CLC
  ADC SPK_DIR
  STA SPK_X
  CMP #WALK_HI
  BCC .nspkR
  LDA #$FF
  STA SPK_DIR
.nspkR:
  LDA SPK_X
  CMP #WALK_LO
  BCS .nspkL
  LDA #1
  STA SPK_DIR
.nspkL:

  BIT CXM0P            ; bit7 (N flag) = missile0/P0 (spike/hero) overlapped
  BPL .noDeath
  JMP do_game_over
.noDeath:
  STA CXCLR            ; arm BOTH latches fresh for the frame we draw next

  ; pick the rows for the kernel (Y/16) so the kernel doesn't divide per line
  LDA P_Y
  LSR
  LSR
  LSR
  LSR
  STA P_ROW
  LDA COIN_Y
  LSR
  LSR
  LSR
  LSR
  STA COIN_ROW
  LDA SPK_Y
  LSR
  LSR
  LSR
  LSR
  STA SPK_ROW

  ; decay the walk-animation frame back to idle when not pressing
  LDA GFXIDX
  BEQ .pk
  DEC GFXIDX
.pk:
  JMP pack_score       ; render SCORE into S0BUF (tail-RTS ends frame_logic)

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
  RTS

; ── GAME LOGIC (clay — reshape freely) ── helpers ──────────────────────

; ground_under_hero — is there a solid LEVEL pixel under the hero's column
; in row TMP? Returns C=1 if solid (can stand), C=0 if pit/gap.
; The hero stands at a coarse 1-of-40 column: PF pixel = P_X/4 across the 40
; playfield pixels of a (reflect-mode) symmetric arena. We fold the right
; half back, then test the right PF register+bit. Code reads the SAME LEVEL
; table the kernel draws, so picture and physics never disagree.
ground_under_hero:
  LDA TMP
  CMP #NROWS
  BCC .lok
  LDA #(NROWS-1)
.lok:
  STA TMP2
  ASL
  CLC
  ADC TMP2             ; row*3 = LEVEL byte offset (PF0,PF1,PF2 per row)
  TAX                  ; X = LEVEL offset
  ; coarse playfield pixel index 0..39 from P_X (160 visible px / 4 = 40)
  LDA P_X
  LSR
  LSR                  ; P_X/4
  STA TMP2
  ; In REFLECT mode the right half (px 20..39) mirrors the left, so fold any
  ; index >= 20 down to 0..19 reading from the right edge inward.
  CMP #20
  BCC .left
  LDA #39
  SEC
  SBC TMP2             ; 39 - idx → 0..19
  STA TMP2
.left:
  ; TMP2 = 0..19 into the 20-pixel half. Which register/bit?
  ;   px 0..3   → PF0 bits 4..7 (bit4 = leftmost)
  ;   px 4..11  → PF1 bits 7..0 (bit7 = leftmost)
  ;   px 12..19 → PF2 bits 0..7 (bit0 = leftmost)
  LDA TMP2
  CMP #4
  BCS .notPF0
  ; PF0: pixel n (0..3) → bit (4+n)
  CLC
  ADC #4
  TAY                  ; Y = bit index in PF0
  LDA LEVEL,X          ; PF0 byte
  JMP .testBit
.notPF0:
  CMP #12
  BCS .pf2
  ; PF1: pixel n (4..11) → bit (11-n)
  STA TMP2
  LDA #11
  SEC
  SBC TMP2
  TAY                  ; Y = bit index in PF1
  LDA LEVEL+1,X        ; PF1 byte
  JMP .testBit
.pf2:
  ; PF2: pixel n (12..19) → bit (n-12) (bit0 = leftmost)
  SEC
  SBC #12
  TAY                  ; Y = bit index in PF2
  LDA LEVEL+2,X        ; PF2 byte
.testBit:
  ; shift the chosen bit (Y) down to bit0, return C = that bit
  CPY #0
  BEQ .haveBit
.shloop:
  LSR
  DEY
  BNE .shloop
.haveBit:
  AND #$01
  CMP #$01             ; sets C if the bit was 1 (solid ground)
  RTS

respawn_coin:          ; place the coin at a new pseudo-random column + reset Y
  LDA FRAME
  AND #$7F
  CLC
  ADC #20              ; 20..147 column
  CMP #WALK_HI
  BCC .cok
  LDA #100
.cok:
  STA COIN_X
  LDA #COIN_CEIL
  STA COIN_Y
  LDA #$FF
  STA COIN_VY          ; start it falling
  RTS

add_score:             ; +10 points, BCD, capped at 9990, tracks session hi
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

do_game_over:
  LDA #2
  STA STATE
  LDA #200             ; ~3.3 s freeze, then auto-return to title
  STA OVER_T
  LDA #0
  STA ENABL
  STA ENAM0
  STA GRP0
  LDA #1
  STA TUNE_SEL
  JMP tune_start       ; game-over tune on voice 1

start_game:
  LDA #0
  STA SCORE
  STA SCORE_HI
  STA TUNE_LEFT        ; silence the title jingle
  STA AUDV1
  STA P_VY
  STA GFXIDX
  LDA #1
  STA ON_GND
  LDA #76
  STA P_X
  LDA #(2*ROWH)        ; start standing on row 2's ledge
  STA P_Y
  ; coin
  LDA #110
  STA COIN_X
  LDA #COIN_CEIL
  STA COIN_Y
  LDA #$FF
  STA COIN_VY
  ; spike patrols row 1
  LDA #40
  STA SPK_X
  LDA #(1*ROWH)
  STA SPK_Y
  LDA #1
  STA SPK_DIR
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
  STA ENABL
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
; them on separate voices means a jump blip never cuts the tune off.
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
; register" for sprites: you strobe RESP0/RESBL/RESM0 and the object lands
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
  LDA P_X               ; hero → P0
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
  LDA COIN_X            ; coin → BL
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
  STA RESBL
  STA HMBL
  LDA SPK_X             ; spike → M0
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
;   24 = score bar  +  144 = arena (9 rows × 16)  +  24 = pad  = 192
;
; SCORE BAR (SCORE mode): CTRLPF = $02 colors the LEFT playfield half with
; COLUP0 and the RIGHT half with COLUP1 — a two-color scoreboard with zero
; sprites. We stream the packed score digits into PF1, one font row / 4 lines.
;
; ARENA: the level is NROWS bands of 16 lines. Each band reloads PF0/PF1/PF2
; from the LEVEL table ONCE (the ledges/floor/pit for that row), in REFLECT
; mode so 20 stored pixels mirror into a symmetric 40-pixel arena. Per
; scanline we also test, from the row counter, whether the hero (P0), coin
; (BL) or spike (M0) band is here and enable/disable that object's graphic.
; Each test is a compare-and-store (no multiply) so the work fits 76 cycles.
; Beam Y counts DOWN; level rows are drawn TOP first (row NROWS-1 → 0), so a
; lit pixel in a HIGH row index draws nearer the top, matching level space.
; ──────────────────────────────────────────────────────────────────────
play_kernel:
  ; positioning runs first, inside the still-blanked region
  JSR position_objects

  LDA #COL_SKY
  STA COLUBK
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA ENABL
  STA ENAM0
  STA VBLANK            ; beam on
  LDA #COL_HUD
  STA COLUPF            ; score digits bright
  LDA #$02
  STA CTRLPF           ; SCORE mode for the score bar

  ; ---- score bar: 24 lines (6 font rows × 4) ----
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

  ; transition: clear the bar, switch the TIA to the arena (REFLECT mode so
  ; the 20-pixel level mirrors symmetric), ledges in green.
  STA WSYNC
  LDA #0
  STA PF1
  LDA #$11             ; REFLECT (bit0) + 2px ball (bits 4-5 = 01)
  STA CTRLPF
  LDA #COL_LEDGE
  STA COLUPF

  ; ---- arena: NROWS rows × 16 lines, top row (NROWS-1) drawn first ----
  LDX #(NROWS-1)        ; X = current level row
.rowLoop:
  ; reload PF for this row (once per 16 lines). Row table offset = X*3.
  TXA
  STA TMP              ; save row index for the per-line object tests
  ASL
  CLC
  ADC TMP              ; X*3
  TAY
  LDA LEVEL,Y
  STA PF0
  LDA LEVEL+1,Y
  STA PF1
  LDA LEVEL+2,Y
  STA PF2

  LDY #ROWH            ; 16 scanlines for this row (Y = 16..1)
.lineLoop:
  STA WSYNC
  ; sub-line within the row, 0 (top) .. 15 (bottom) = ROWH - Y
  ; hero: drawn if this row == P_ROW and sub < HEROH
  LDA P_ROW
  CMP TMP
  BNE .noHero
  TYA
  EOR #$FF
  CLC
  ADC #(ROWH+1)        ; sub = ROWH - Y
  CMP #HEROH
  BCS .noHero
  CLC
  ADC GFXIDX           ; pick idle (0) or walk (6) frame base
  TAX
  LDA HERO,X
  STA GRP0
  LDX TMP              ; restore row index
  JMP .heroDone
.noHero:
  LDA #0
  STA GRP0
.heroDone:

  ; coin (BL): enabled if this row == COIN_ROW and sub-line < 4
  LDA COIN_ROW
  CMP TMP
  BNE .noCoinK
  TYA
  EOR #$FF
  CLC
  ADC #(ROWH+1)
  CMP #4
  BCS .noCoinK
  LDA #2
  STA ENABL
  JMP .coinDone
.noCoinK:
  LDA #0
  STA ENABL
.coinDone:

  ; spike (M0): enabled if this row == SPK_ROW and sub-line < 6
  LDA SPK_ROW
  CMP TMP
  BNE .noSpikeK
  TYA
  EOR #$FF
  CLC
  ADC #(ROWH+1)
  CMP #6
  BCS .noSpikeK
  LDA #2
  STA ENAM0
  JMP .spikeDone
.noSpikeK:
  LDA #0
  STA ENAM0
.spikeDone:

  DEY
  BNE .lineLoop

  LDX TMP              ; restore row counter (clobbered by the hero pick)
  DEX
  BPL .rowLoop

  ; pad to reach exactly 192 visible (24 bar + 144 arena = 168 → +24 pad)
  LDA #0
  STA GRP0
  STA ENABL
  STA ENAM0
  STA PF0
  STA PF1
  STA PF2
  LDX #24
.pad:
  STA WSYNC
  DEX
  BNE .pad

  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; THE TITLE KERNEL — 192 lines, banded:
;   24 blank + 28 banner "PERCH" + 8 gap + 28 banner "PATROL" + 16 gap +
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
  LDA #$84              ; deep blue backdrop
  STA COLUBK
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA ENABL
  STA ENAM0
  STA CTRLPF           ; REPEAT mode — required by the banner (see above)
  STA VBLANK           ; beam on

  LDX #24              ; band 1: 24 blank lines
.tb1:
  STA WSYNC
  DEX
  BNE .tb1

  LDA #$3A             ; word 1 in warm yellow
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

  LDA #$C6             ; word 2 in green
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
  LDA #COL_HUD
  STA COLUPF
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

; ── THE HERO SPRITE ───────────────────────────────────────────────────
; 6 rows tall, P0. Two frames stacked: idle (base 0) and a walk pose
; (base 6) selected by GFXIDX in the kernel — a cheap 1977-style 2-frame
; animation. Drawn TOP-row first (the kernel scans the band downward).
HERO:
  ; idle (GFXIDX = 0)
  .byte %00111100
  .byte %01111110
  .byte %00011000
  .byte %00111100
  .byte %01100110
  .byte %01000010
  ; walk  (GFXIDX = 6)
  .byte %00111100
  .byte %01111110
  .byte %00011000
  .byte %00111100
  .byte %00100100
  .byte %01000010

; Title jingle (voice 1, AUDC $04 square; AUDF divider — LOWER = higher
; pitch; 10 frames per note; $FF terminates). The table IS the song.
TITLE_TUNE:
  .byte $1B,$17,$13,$0F,$13,$17,$13,$0F,$FF
; Game-over tune: a falling figure.
OVER_TUNE:
  .byte $0F,$13,$17,$1B,$1F,$23,$FF

; ── THE LEVEL ─────────────────────────────────────────────────────────
; NROWS rows × (PF0, PF1, PF2). A lit pixel = solid ground; a gap = pit.
; REFLECT mode mirrors the 20 stored pixels into a symmetric 40-px arena,
; so you only author the LEFT half — the arena is naturally left/right
; symmetric (for an asymmetric arena, switch the kernel to a per-line
; asymmetric reload like the title banner). Row 0 = BOTTOM (the floor),
; row NROWS-1 = TOP. PF bit order, as ever on the 2600:
;   PF0: bits 4..7 used, bit4 = leftmost (reversed)
;   PF1: bit7 = leftmost (normal)
;   PF2: bit0 = leftmost (reversed)
; This is the workhorse "clay" of the file — every ledge, pit and the floor
; lives here; ground_under_hero reads the SAME table so code and picture
; never disagree. (The hero spawns on row 2; row 0 is a solid landing floor
; so a fall always ends on ground.)
LEVEL:
  ; row 0 — solid floor (full left half → mirrored = full floor)
  .byte %11110000, %11111111, %11111111
  ; row 1 — a low ledge on the left (the spike's patrol band)
  .byte %11110000, %11110000, %00000000
  ; row 2 — a mid ledge (the hero's start perch)
  .byte %00000000, %00001111, %11110000
  ; row 3 — open (air)
  .byte %00000000, %00000000, %00000000
  ; row 4 — a high ledge near the wall
  .byte %11110000, %00000000, %00000000
  ; row 5 — open
  .byte %00000000, %00000000, %00000000
  ; row 6 — a small floating ledge centre-left
  .byte %00000000, %00111100, %00000000
  ; row 7 — open
  .byte %00000000, %00000000, %00000000
  ; row 8 — top cap ledge (a landing under the HUD)
  .byte %11110000, %00000011, %00000000

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
; PERCH (P-E-R-C in the left copy, H in the right; +2px left pad to centre):
;     #### #### #### .### #..#
;     #..# #... #..# #... #..#
;     #..# #... #..# #... #..#
;     #### ###. ###. #... ####
;     #... #... #.#. #... #..#
;     #... #... #..# #... #..#
;     #... #### #..# .### #..#
R1_PF0L:
  .byte %11000000, %01000000, %01000000, %11000000, %01000000, %01000000, %01000000
R1_PF1L:
  .byte %11011110, %01010000, %01010000, %11011100, %00010000, %00010000, %00011110
R1_PF2L:
  .byte %11001111, %00101001, %00101001, %00100111, %00100101, %00101001, %11001001
R1_PF0R:
  .byte %01010000, %01000000, %01000000, %11000000, %01000000, %01000000, %01010000
R1_PF1R:
  .byte %01000000, %01000000, %01000000, %11000000, %01000000, %01000000, %01000000
R1_PF2R:
  .byte %00000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00000000

; PATROL (P-A-T-R in the left copy, O-L in the right):
;   #### .##. #### #### .##. #...
;   #..# #..# ..#. #..# #..# #...
;   #..# #..# ..#. #..# #..# #...
;   #### #### ..#. ###. #..# #...
;   #... #..# ..#. #.#. #..# #...
;   #... #..# ..#. #..# #..# #...
;   #... #..# ..#. #..# .##. ####
R2_PF0L:
  .byte %11110000, %10010000, %10010000, %11110000, %00010000, %00010000, %00010000
R2_PF1L:
  .byte %00110011, %01001000, %01001000, %01111000, %01001000, %01001000, %01001000
R2_PF2L:
  .byte %01111011, %01001001, %01001001, %00111001, %00101001, %01001001, %01001001
R2_PF0R:
  .byte %01100000, %10010000, %10010000, %10010000, %10010000, %10010000, %01100000
R2_PF1R:
  .byte %01000000, %01000000, %01000000, %01000000, %01000000, %01000000, %01111000
R2_PF2R:
  .byte %00000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00000000

; ── Vector table ──────────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

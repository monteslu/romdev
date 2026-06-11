; ── sports.asm — RAPID RALLY — Atari 2600 sports (complete example game) ─────
;
; A COMPLETE, working game — title screen, 1P (vs AI) and 2P head-to-head
; modes, scoring to 7, in-session hi-score (best rally), TIA sound effects +
; a title jingle, and the 2600's signature feature: THE WHOLE MACHINE.
; There is no framebuffer, no tilemap, no OS — every visible scanline below
; is composed live by racing the beam, and this file teaches the four
; classic per-line kernel tricks while doing it:
;
;   1. ASYMMETRIC PLAYFIELD (the title banner) — the playfield registers
;      cover only HALF the screen; rewriting PF0/PF1/PF2 mid-scanline,
;      inside strict cycle windows, paints 40 independent pixels per line.
;   2. SCORE MODE + MID-LINE PF1 REWRITE (the score bar) — CTRLPF bit 1
;      colors the left playfield half with COLUP0 and the right half with
;      COLUP1 for free; a second PF1 write mid-line puts a DIFFERENT digit
;      on each side. Two-color scoreboard, zero sprites used.
;   3. THE TWO-LINE KERNEL (the court) — a full line of render work does
;      not fit in one 76-cycle scanline, so each loop pass paints TWO.
;   4. TIM64T/INTIM FRAME TIMING — instead of hand-counting every VBLANK
;      scanline (and rolling the picture when game logic grows), set the
;      RIOT timer and let it absorb whatever the logic costs.
;
; THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
; very different one. The markers tell you what's what:
;   HARDWARE IDIOM (load-bearing) — cycle-counted / footgun-dodging code;
;     reshape your gameplay around it (see TROUBLESHOOTING before changing).
;   GAME LOGIC (clay) — ball physics, AI, scoring, tuning, art: reshape freely.
;
; GAME_TITLE: on the 2600 a title is DRAWN, not printed — there is no font
; hardware. The RAPID/RALLY banner bitmaps near the bottom of this file ARE
; the title; redraw them for your game (the comment above each table shows
; the 40-pixel artwork and the PF0/PF1/PF2 bit-order encoding).
;
; CONTROLS (documented for players and for the fork README):
;   Title:  fire on JOYSTICK 0 starts 1P (vs AI)
;           fire on JOYSTICK 1 starts 2P (both paddles human)
;           console SELECT toggles the 1P/2P digit; console RESET starts
;           the selected mode
;   Play:   joystick up/down moves your paddle (P0 = left, P1 = right);
;           console RESET returns to the title
;   First to 7 points wins. Your BEST RALLY (consecutive paddle hits in one
;   volley) is the hi-score shown on the title screen.
;
; HI-SCORE HONESTY: real 2600 cartridges had NO battery, NO SRAM, NO
; persistence of any kind. The hi-score here lives in RIOT RAM ($8B) and
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
RESBL    = $14
GRP0     = $1B
GRP1     = $1C
ENAM0    = $1D
ENAM1    = $1E
ENABL    = $1F
HMP0     = $20
HMP1     = $21
HMBL     = $24
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
; write strobes; e.g. CXP0FB reads $02 while STA $02 strobes WSYNC) ────
CXP0FB   = $02          ; bit6 = player 0 / ball collision (latched)
CXP1FB   = $03          ; bit6 = player 1 / ball collision (latched)
INPT4    = $0C          ; joystick 0 fire (bit7, ACTIVE LOW)
INPT5    = $0D          ; joystick 1 fire (bit7, ACTIVE LOW)
; ── RIOT ──────────────────────────────────────────────────────────────
SWCHA    = $280         ; joysticks: P0 = high nibble, P1 = LOW nibble
SWCHB    = $282         ; console: bit0 RESET, bit1 SELECT (ACTIVE LOW)
INTIM    = $284         ; timer read
TIM64T   = $296         ; timer set, 64-cycle ticks

; ── Zero-page state (the 2600's ENTIRE RAM is $80-$FF — 128 bytes; in
; core memory dumps system_ram offset 0 = $80) ────────────────────────
STATE     = $80         ; 0 = title, 1 = play, 2 = game over
MODE2P    = $81         ; 0 = 1P vs AI, 1 = 2P head-to-head
P0_Y      = $82         ; left paddle BOTTOM scanline (court Y, larger = higher)
P1_Y      = $83         ; right paddle bottom scanline
BALL_X    = $84         ; ball column 0..159 (kept in 4..150 — see PosBall)
BALL_Y    = $85         ; ball bottom scanline (200 = parked off-court/hidden)
BALL_DX   = $86         ; +2 or -2 (signed)
BALL_DY   = $87         ; +1 or -1 (signed)
SCORE0    = $88         ; left player points (0..7)
SCORE1    = $89         ; right player points (0..7)
RALLY     = $8A         ; current volley's paddle hits — BCD, so the digit
                        ;   nibbles fall out for free in the score kernel
HISCORE   = $8B         ; best rally this SESSION (BCD). RAM only — real
                        ;   2600 carts have no battery; honest by design.
FRAME     = $8C
SFX_LEFT  = $8D         ; frames remaining on the voice-0 sound effect
TUNE_SEL  = $8E         ; 0 = title jingle, 1 = game-over tune (voice 1)
TUNE_POS  = $8F
TUNE_LEFT = $90         ; frames left on current jingle note (0 = silent)
SERVE_T   = $91         ; serve pause countdown (ball hidden while > 0)
OVER_T    = $92         ; game-over auto-return-to-title countdown
WINNER    = $93         ; 0 = left player won, 1 = right
SWCHB_PRV = $94         ; previous SWCHB for RESET/SELECT edge detect
FIRE_PRV  = $95         ; previous fire bits (bit7 = joy0, bit6 = joy1)
EDGEB     = $96         ; this frame's switch press-edges (bit0/bit1)
FIRE_EDG  = $97         ; this frame's fire press-edges (bit7/bit6)
TMP       = $98
COURTBK   = $99         ; court background color (game-over flashes it)
S0BUF     = $9A         ; 5 rows: left score digit, PF1 high nibble
S1BUF     = $9F         ; 5 rows: right score digit
HSBUF     = $A4         ; 5 rows: hi-score, BOTH digits packed in one byte
INDBUF    = $A9         ; 5 rows: title mode digit (1 or 2)

PADGFX    = %00111100   ; paddle: 4-px-wide bar (GRP bits, 8px sprite)
PADH      = 14          ; paddle height in scanlines
COL_COURT = $C4         ; court green
COL_P0    = $9A         ; left player blue (paddle + their score digits)
COL_P1    = $44         ; right player red

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

  ; Fixed identity colors — used by the score bar (SCORE mode), the court
  ; paddles, and the title hi-score band alike.
  LDA #COL_P0
  STA COLUP0
  LDA #COL_P1
  STA COLUP1
  LDA #80
  STA P0_Y
  STA P1_Y
  LDA #78
  STA BALL_X
  LDA #200
  STA BALL_Y            ; ball parked off-court until a game starts
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
  ; Console switches + fire buttons are ACTIVE LOW and not debounced; a held
  ; RESET would restart every frame. Convert to press-EDGES once per frame:
  ; edge = was-released-last-frame AND pressed-now.
  LDA SWCHB
  TAX                   ; X = current switch levels
  EOR #$FF              ; A = pressed-now mask (1 = held)
  AND SWCHB_PRV         ; ...that were RELEASED (1) last frame
  STA EDGEB             ; bit0 = RESET edge, bit1 = SELECT edge
  STX SWCHB_PRV
  ; fire buttons → same edge treatment, packed bit7 = joy0, bit6 = joy1
  LDA #0
  BIT INPT4
  BMI .f0up             ; bit7 set = not pressed (active low)
  ORA #$80
.f0up:
  BIT INPT5
  BMI .f1up
  ORA #$40
.f1up:
  TAY                   ; Y = pressed-now bits
  LDA FIRE_PRV
  EOR #$FF
  STA TMP               ; released-last-frame mask
  TYA
  AND TMP
  STA FIRE_EDG          ; bit7 = joy0 fire edge, bit6 = joy1 fire edge
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
  ; SELECT toggles the mode digit; fire 0 = start 1P; fire 1 = start 2P;
  ; RESET starts whatever the digit shows.
  LDA EDGEB
  AND #$02
  BEQ .nosel
  LDA MODE2P
  EOR #$01
  STA MODE2P
  LDA #$0E              ; tick sfx on toggle
  LDX #$04
  LDY #4
  JSR sfx_play
.nosel:
  LDA FIRE_EDG
  BPL .nof0             ; bit7 clear = no joy0 fire edge
  LDA #0
  STA MODE2P
  JMP start_game
.nof0:
  LDA FIRE_EDG
  AND #$40
  BEQ .nof1
  LDA #1
  STA MODE2P
  JMP start_game
.nof1:
  LDA EDGEB
  AND #$01
  BEQ .nores
  JMP start_game
.nores:

  ; Pack the title's two display buffers (the kernels just stream bytes —
  ; all per-frame thinking happens HERE, in VBLANK, never inside a kernel):
  ;   HSBUF — hi-score, tens+ones nibbles packed into ONE PF1 byte/row.
  ;   INDBUF — the mode digit (1 or 2), blinking.
  LDA HISCORE
  LSR
  LSR
  LSR
  LSR                   ; tens digit (BCD → no divide needed: the nibble IS it)
  JSR digit_times5
  TAX
  LDY #0
.hst:
  LDA DIGITS,X
  STA HSBUF,Y
  INX
  INY
  CPY #5
  BNE .hst
  LDA HISCORE
  AND #$0F              ; ones digit
  JSR digit_times5
  TAX
  LDY #0
.hso:
  LDA DIGITS,X
  LSR
  LSR
  LSR
  LSR                   ; ones go in the LOW nibble (PF1 bit7 = leftmost,
  ORA HSBUF,Y           ; so the HIGH nibble is the LEFT digit = tens)
  STA HSBUF,Y
  INX
  INY
  CPY #5
  BNE .hso

  ; mode digit: 1 or 2, blinked by FRAME bit 5 (~1 Hz)
  LDA MODE2P
  CLC
  ADC #1
  JSR digit_times5
  TAX
  LDY #0
.ind:
  LDA FRAME
  AND #$20
  BEQ .indblank
  LDA DIGITS,X
  JMP .indstore
.indblank:
  LDA #0
.indstore:
  STA INDBUF,Y
  INX
  INY
  CPY #5
  BNE .ind

  ; title shows no moving objects
  LDA #0
  STA GRP0
  STA GRP1
  STA ENABL
  RTS

; ── GAME LOGIC (clay — reshape freely) ── one frame of pong ────────────
logic_play:
  LDA EDGEB
  AND #$01              ; console RESET → back to title
  BEQ .noquit
  JMP enter_title
.noquit:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; SWCHA is ACTIVE LOW (0 = pressed) and must be RE-LOADED for every
  ; direction check. The classic bug: caching it in A and chaining ASLs,
  ; then clobbering A with game state between shifts — "up works once,
  ; down never moves". Fresh LDA SWCHA + AND #mask per check is immune.
  ; Joystick 0 = HIGH nibble (bit4 up, bit5 down); joystick 1 = LOW nibble
  ; (bit0 up, bit1 down) — both sticks arrive in this ONE register.
  LDA SWCHA
  AND #$10              ; joy0 up
  BNE .p0nup
  INC P0_Y              ; court Y grows UPWARD (the kernel's line counter
  INC P0_Y              ; runs 170 → 2 as the beam moves DOWN the screen)
.p0nup:
  LDA SWCHA             ; RE-LOAD — never trust A to still hold SWCHA
  AND #$20              ; joy0 down
  BNE .p0ndn
  DEC P0_Y
  DEC P0_Y
.p0ndn:
  LDA P0_Y
  JSR clamp_paddle
  STA P0_Y

  LDA MODE2P
  BEQ .ai
  ; 2P: the second human, same idiom, low nibble
  LDA SWCHA
  AND #$01              ; joy1 up
  BNE .p1nup
  INC P1_Y
  INC P1_Y
.p1nup:
  LDA SWCHA             ; RE-LOAD (same footgun, other nibble)
  AND #$02              ; joy1 down
  BNE .p1ndn
  DEC P1_Y
  DEC P1_Y
.p1ndn:
  JMP .p1clamp
.ai:
  ; ── GAME LOGIC (clay) — the AI is deliberately beatable: it moves 1px
  ; on only 3 of every 4 frames (0.75 px/f) while the ball climbs/dives at
  ; 1 px/f — edge hits (which re-angle the ball) out-run it.
  LDA FRAME
  AND #$03
  BEQ .p1clamp          ; skip every 4th frame
  LDA BALL_Y
  SEC
  SBC #5                ; aim paddle center at ball center
  CMP P1_Y
  BEQ .p1clamp
  BCC .aidn
  INC P1_Y
  JMP .p1clamp
.aidn:
  DEC P1_Y
.p1clamp:
  LDA P1_Y
  JSR clamp_paddle
  STA P1_Y

  ; serve pause: ball hidden, then released from center court
  LDA SERVE_T
  BEQ .ballmove
  DEC SERVE_T
  BNE .nopack_jmp
  LDA #90
  STA BALL_Y            ; release the serve
  LDA #78
  STA BALL_X
.nopack_jmp:
  JMP .pack
.ballmove:
  LDA BALL_X
  CLC
  ADC BALL_DX
  STA BALL_X
  LDA BALL_Y
  CLC
  ADC BALL_DY
  STA BALL_Y

  ; wall bounce (the court walls live at lines 170-164 and 8-2)
  LDA BALL_Y
  CMP #159
  BCC .nwtop
  LDA #$FF
  STA BALL_DY
  JSR sfx_wall
.nwtop:
  LDA BALL_Y
  CMP #12
  BCS .nwbot
  LDA #1
  STA BALL_DY
  JSR sfx_wall
.nwbot:

  ; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
  ; Paddle/ball collision via the TIA's hardware collision LATCHES — the
  ; 2600 detects overlap per-pixel in silicon while it draws; you read the
  ; latched result here, one frame later, for free (no AABB math). Rules:
  ;   * latches accumulate until CXCLR — clear them EVERY frame, or a stale
  ;     hit from 10 frames ago bounces a ball that isn't there;
  ;   * gate on travel direction, or the ball re-bounces every frame while
  ;     it overlaps the paddle (the "ball glued to paddle" classic).
  BIT CXP0FB            ; bit6 (V flag) = P0/ball overlapped last frame
  BVC .nohit0
  LDA BALL_DX
  BPL .nohit0           ; only when moving LEFT (toward P0)
  LDA #2
  STA BALL_DX
  LDA BALL_X
  CLC
  ADC #2
  STA BALL_X
  LDA P0_Y
  JSR paddle_english
  JSR rally_hit
.nohit0:
  BIT CXP1FB
  BVC .nohit1
  LDA BALL_DX
  BMI .nohit1           ; only when moving RIGHT (toward P1)
  LDA #$FE              ; -2
  STA BALL_DX
  LDA BALL_X
  SEC
  SBC #2
  STA BALL_X
  LDA P1_Y
  JSR paddle_english
  JSR rally_hit
.nohit1:
  STA CXCLR             ; arm the latches fresh for the frame we're about to draw

  ; scoring: ball escaped past a paddle
  LDA BALL_X
  CMP #4
  BCS .nptL
  LDX #1                ; right player scores
  JSR point_scored
  JMP .pack
.nptL:
  CMP #149
  BCC .pack
  LDX #0                ; left player scores
  JSR point_scored

.pack:
  JSR pack_scores
  JMP position_objects  ; (tail-call; RTS from there ends frame_logic)

; ── GAME LOGIC (clay — reshape freely) ── game-over freeze-frame ───────
logic_over:
  LDA EDGEB
  AND #$01
  BNE .toTitle
  LDA FIRE_EDG
  AND #$C0              ; either fire button
  BNE .toTitle
  DEC OVER_T
  BNE .stay
.toTitle:
  JMP enter_title
.stay:
  ; flash the court between green and dark red while frozen
  LDA FRAME
  AND #$10
  BEQ .flashB
  LDA #COL_COURT
  JMP .flashSet
.flashB:
  LDA #$42
.flashSet:
  STA COURTBK
  JSR pack_scores
  ; blink the WINNER's digit (clearly decodable evidence of who won)
  LDA FRAME
  AND #$10
  BNE .noblink
  LDX #4
  LDA WINNER
  BNE .blink1
.blink0:
  LDA #0
  STA S0BUF,X
  DEX
  BPL .blink0
  JMP .noblink
.blink1:
  LDA #0
  STA S1BUF,X
  DEX
  BPL .blink1
.noblink:
  JMP position_objects

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; HORIZONTAL POSITIONING — the canonical SBC-#15 beam-race. There is no
; "X register" for sprites: you strobe RESPx/RESBL and the object lands
; WHEREVER THE BEAM IS. Each SBC/BCS lap is 5 CPU cycles = 15 beam pixels,
; so when the subtraction underflows the beam has crossed x/15 coarse
; columns; the remainder (-15..-1), EOR #7 and shifted to the high nibble,
; becomes the ±7px fine offset HMOVE applies on the next line. The naive
; "divide first, then burn a delay loop" version lands in the WRONG column
; — RESP must fire AT the beam position, not after computed time.
; Three objects = three WSYNC lines + one shared HMOVE line, all inside
; the timed VBLANK window. Paddles are at fixed columns but are re-strobed
; every frame anyway: one proven code path, no special cases.
; ──────────────────────────────────────────────────────────────────────
position_objects:
  LDA #16               ; left paddle column
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
  STA RESP0             ; coarse: lands at the beam's current column
  STA HMP0              ; fine: remainder → signed nibble
  LDA #140              ; right paddle column
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
  LDA BALL_X            ; ball (logic clamps it to 4..150 — past ~155 the
  STA WSYNC             ; divide loop wouldn't finish inside the line)
  SEC
.d2:
  SBC #15
  BCS .d2
  EOR #7
  ASL
  ASL
  ASL
  ASL
  STA RESBL
  STA HMBL
  STA WSYNC
  STA HMOVE             ; one HMOVE applies ALL the fine offsets; it must
  RTS                   ; come fresh after a WSYNC (mid-line HMOVE shifts
                        ; the line's pixels — the "comb" artifact)

; ── GAME LOGIC (clay — reshape freely) ── helpers ──────────────────────
clamp_paddle:           ; A = paddle Y → clamped to the court
  CMP #12
  BCS .cl1
  LDA #12
.cl1:
  CMP #148
  BCC .cl2
  LDA #148
.cl2:
  RTS

paddle_english:         ; A = paddle bottom Y; deflect by hit point:
  STA TMP               ; top third sends the ball up, bottom third down
  LDA BALL_Y
  SEC
  SBC TMP               ; 0..13 = where on the paddle we struck
  CMP #10
  BCC .eng1
  LDA #1                ; struck the top → deflect upward
  STA BALL_DY
  RTS
.eng1:
  CMP #4
  BCS .eng2
  LDA #$FF              ; struck the bottom → deflect downward
  STA BALL_DY
.eng2:
  RTS

rally_hit:              ; one more paddle hit this volley (BCD, capped at 99)
  LDA RALLY
  CMP #$99
  BEQ .rdone
  SED                   ; BCD mode: $09 + 1 = $10, nibbles stay decimal —
  CLC                   ; the score kernel reads digits straight out of the
  ADC #1                ; nibbles, no divide-by-10 anywhere
  STA RALLY
  CLD                   ; ALWAYS clear decimal mode immediately
.rdone:
  LDA #$0A              ; paddle blip
  LDX #$04
  LDY #4
  JMP sfx_play

rally_end:              ; volley over: keep the best rally as the session
  LDA RALLY             ; hi-score. RAM ONLY — no battery exists on a real
  CMP HISCORE           ; 2600 cart, so this honestly resets at power-off.
  BCC .rkeep
  STA HISCORE
.rkeep:
  LDA #0
  STA RALLY
  RTS

point_scored:           ; X = scorer (0 = left, 1 = right)
  JSR rally_end
  LDA SCORE0,X          ; SCORE0/SCORE1 are adjacent — indexed access
  CLC
  ADC #1
  STA SCORE0,X
  CMP #7
  BCS game_over
  ; serve again, toward the side that just conceded
  LDA #50
  STA SERVE_T
  LDA #200
  STA BALL_Y            ; hide the ball during the serve pause
  LDA #78
  STA BALL_X
  ; Serve TOWARD the player who just conceded — an idle player keeps
  ; conceding, so an unattended match always ends (no stalemates).
  TXA
  BNE .srvL
  LDA #2                ; left scored → conceder is on the right → serve right
  JMP .srvSet
.srvL:
  LDA #$FE              ; right scored → serve left (-2)
.srvSet:
  STA BALL_DX
  LDA FRAME
  AND #$01              ; pseudo-random up/down serve angle
  BNE .srvUp
  LDA #$FF
  STA BALL_DY
  JMP .srvSnd
.srvUp:
  LDA #1
  STA BALL_DY
.srvSnd:
  LDA #$06              ; point chime
  LDX #$04
  LDY #20
  JMP sfx_play

game_over:
  STX WINNER
  LDA #2
  STA STATE
  LDA #240              ; ~4 s freeze, then auto-return to title
  STA OVER_T
  LDA #200
  STA BALL_Y            ; HIDE the ball — a frozen game must not render a
  LDA #0                ; stale object floating mid-court (looks broken)
  STA ENABL
  LDA #1
  STA TUNE_SEL
  JMP tune_start        ; game-over tune on voice 1

start_game:
  LDA #0
  STA SCORE0
  STA SCORE1
  STA RALLY
  STA TUNE_LEFT         ; silence the title jingle
  STA AUDV1
  LDA #80
  STA P0_Y
  STA P1_Y
  LDA #1
  STA STATE
  LDA #50
  STA SERVE_T
  LDA #200
  STA BALL_Y
  LDA #78
  STA BALL_X
  LDA #$FE              ; first serve toward the left player
  STA BALL_DX
  LDA #1
  STA BALL_DY
  LDA #COL_COURT
  STA COURTBK
  LDA #$08              ; start blip
  LDX #$04
  LDY #10
  JMP sfx_play

enter_title:
  LDA #0
  STA STATE
  STA GRP0
  STA GRP1
  STA ENABL
  STA AUDV0
  STA SFX_LEFT
  STA TUNE_SEL          ; title jingle
  JMP tune_start

digit_times5:           ; A = digit 0-9 → A = digit*5 (DIGITS row index)
  STA TMP
  ASL
  ASL
  CLC
  ADC TMP
  RTS

pack_scores:            ; render SCORE0/SCORE1 into the kernel's row buffers
  LDA SCORE0
  JSR digit_times5
  TAX
  LDY #0
.ps0:
  LDA DIGITS,X
  STA S0BUF,Y
  INX
  INY
  CPY #5
  BNE .ps0
  LDA SCORE1
  JSR digit_times5
  TAX
  LDY #0
.ps1:
  LDA DIGITS,X
  STA S1BUF,Y
  INX
  INY
  CPY #5
  BNE .ps1
  RTS

; ── GAME LOGIC (clay — reshape freely) ── TIA sound ────────────────────
; Voice 0 = one-shot sound effects; voice 1 = the jingle player. Keeping
; them on separate voices means a wall blip never cuts the tune off.
sfx_play:               ; A = AUDF pitch, X = AUDC waveform, Y = frames
  STA AUDF0
  STX AUDC0
  STY SFX_LEFT
  LDA #$0C
  STA AUDV0
  RTS

sfx_wall:
  LDA #$13
  LDX #$04
  LDY #4
  JMP sfx_play

tune_start:             ; TUNE_SEL chosen by caller (0 title, 1 game over)
  LDA #0
  STA TUNE_POS
  JSR tune_note
  LDA #$04              ; pure square wave
  STA AUDC1
  LDA #$06
  STA AUDV1
  LDA #8
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
  LDA #8
  STA TUNE_LEFT
.at2:
  RTS

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; THE PLAY/GAME-OVER KERNEL — 192 visible lines, fully accounted:
;   22 = score bar (20 digit lines + 2 transition)  +  170 = court
; Two per-line tricks live here:
;
; SCORE BAR (SCORE mode + mid-line PF1 rewrite): CTRLPF = $02 puts the TIA
; in SCORE mode — the LEFT playfield half draws in COLUP0's color and the
; RIGHT half in COLUP1's. The TIA reads PF1 twice per line (left copy at
; color clocks 84-115, right copy at 164-195, with the CPU at 3 clocks per
; cycle). Write the LEFT player's digit row early in the line, then write
; the RIGHT player's row in the window AFTER the left copy is fully drawn
; (cycle 39) and BEFORE the right copy starts (cycle 54) — one register,
; two different digits, two colors. The NOPs below are not padding sloth:
; each is 2 cycles = 6 beam pixels of deliberate waiting for that window.
; (Without the rewrite you'd see the same byte twice — the classic
; "10 10" dual-score look, which the title screen embraces deliberately.)
;
; COURT (two-line kernel): one line of work here (walls + net + paddle +
; ball, each a compare-and-store) is ~90 cycles — more than the 76 a single
; scanline allows. The standard fix: each loop pass spans TWO scanlines and
; splits the work — line A draws playfield + left paddle, line B draws
; right paddle + ball. 85 passes × 2 = 170 lines; objects move in 2-px
; steps, which 1977 televisions made invisible.
; ──────────────────────────────────────────────────────────────────────
play_kernel:
  ; band setup runs in the last blanked line — registers are live before
  ; the first visible WSYNC
  LDA #0
  STA COLUBK            ; score bar band is black
  STA PF0
  STA PF1
  STA PF2
  STA GRP0              ; scrub objects left over from last frame's court
  STA GRP1              ; (TIA registers persist; the bar would re-render
  STA ENABL             ; a stale ball pixel on every bar line otherwise)
  STA VBLANK            ; beam on
  LDA #$0E
  STA COLUPF            ; walls + net in white (the title kernel leaves its
                        ; last banner color in COLUPF — registers persist!)
  LDA #$02
  STA CTRLPF            ; SCORE mode: PF left half = COLUP0, right = COLUP1

  LDX #0                ; 20 score-bar lines, 5 digit rows × 4 lines each
.sbar:
  STA WSYNC
  TXA
  LSR
  LSR
  TAY                   ; row = line/4
  LDA S0BUF,Y
  STA PF1               ; cycle ~15 → left copy gets the LEFT digit
  NOP                   ; ── now wait for the beam ──
  NOP                   ; 9 NOPs = 18 cycles = 54 beam pixels: parks the
  NOP                   ; CPU until the TIA has FINISHED drawing the left
  NOP                   ; copy of PF1 (ends cycle ~38) but hasn't started
  NOP                   ; the right copy (cycle ~55)
  NOP
  NOP
  NOP
  NOP
  LDA S1BUF,Y
  STA PF1               ; cycle ~40 → right copy gets the RIGHT digit
  INX
  CPX #20
  BNE .sbar

  ; 2 transition lines: clear the bar, re-program the TIA for the court.
  ; (The TIA has no concept of "regions" — CTRLPF/COLUBK are simply
  ; rewritten mid-frame. EVERY banded 2600 screen is built this way.)
  STA WSYNC
  LDA #0
  STA PF1
  LDA #$11              ; court CTRLPF: REFLECT (bit0, symmetric walls) +
  STA CTRLPF            ; 2-px ball (bits 4-5 = 01)
  LDA COURTBK
  STA COLUBK
  STA WSYNC

  ; court: Y = 170 down to 2, step 2 (85 two-line passes)
  LDY #170
.court:
  ; ---- line A: walls + center net (playfield) + left paddle ----
  STA WSYNC
  LDA #0
  CPY #164
  BCC .ckbot            ; Y >= 164 → top wall band (8 lines)
  LDA #$FF
  BNE .wallSet
.ckbot:
  CPY #10
  BCS .wallSet          ; Y < 10 → bottom wall band (8 lines)
  LDA #$FF
.wallSet:
  STA PF0
  STA PF1
  STA TMP               ; remember wall byte — PF2 also carries the net
  TYA
  AND #$08              ; dashed center line, 8 lines on / 8 off
  BNE .dashOff
  LDA #$80              ; PF2 bit7 = the center-most playfield pixel; the
  JMP .dashSet          ; REFLECT bit mirrors it to make a 2-px net
.dashOff:
  LDA #0
.dashSet:
  ORA TMP
  STA PF2
  TYA                   ; left paddle: drawn when (Y - P0_Y) in [0,14)
  SEC
  SBC P0_Y
  CMP #PADH
  LDA #0                ; branchless on/off: A = 0, overwritten if in range
  BCS .p0off
  LDA #PADGFX
.p0off:
  STA GRP0
  ; ---- line B: right paddle + ball ----
  STA WSYNC
  TYA
  SEC
  SBC P1_Y
  CMP #PADH
  LDA #0
  BCS .p1off
  LDA #PADGFX
.p1off:
  STA GRP1
  TYA                   ; ball: 4 lines tall at BALL_Y (200 = parked
  SEC                   ; off-court → never matches → hidden)
  SBC BALL_Y
  CMP #4
  LDA #0
  BCS .bloff
  LDA #2
.bloff:
  STA ENABL
  DEY
  DEY
  BNE .court

  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
; THE TITLE KERNEL — 192 lines, banded:
;   16 blank + 28 banner "RAPID" + 8 gap + 28 banner "RALLY" + 16 gap +
;   20 hi-score + 12 gap + 10 mode digit + 54 bottom pad = 192
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
  LDA #$A2              ; deep blue backdrop
  STA COLUBK
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA GRP1
  STA ENABL
  STA CTRLPF            ; REPEAT mode — required by the banner (see above)
  STA VBLANK            ; beam on

  LDX #16               ; band 1: 16 blank lines
.tb1:
  STA WSYNC
  DEX
  BNE .tb1

  LDA #$9E              ; word 1 in light blue
  STA COLUPF
  LDX #0                ; band 2: 28 banner lines (7 rows × 4)
.ban1:
  STA WSYNC
  TXA                   ; row = line/4                      (cycle 8)
  LSR
  LSR
  TAY
  LDA R1_PF0L,Y         ; left third of the banner row
  STA PF0               ; c15 — beam at clock 45, PF0 reads at 68: in time
  LDA R1_PF1L,Y
  STA PF1               ; c22 (clock 66 < 84)
  LDA R1_PF2L,Y
  STA PF2               ; c29 (clock 87 < 116)
  LDA R1_PF0R,Y         ; ── now RE-write the same registers for the
  STA PF0               ; right half: c36, clock 108 — left PF0 long since
  LDA R1_PF1R,Y         ; drawn (83), right read still ahead (148)
  STA PF1               ; c43 (clock 129: left done 115, right at 164)
  NOP                   ; 2 cycles of deliberate beam-waiting: left PF2
  NOP                   ; finishes at clock 147; don't clobber it early
  LDA R1_PF2R,Y
  STA PF2               ; c54 (clock 162: after 147, before 196)
  INX
  CPX #28
  BNE .ban1

  STA WSYNC             ; band 3: clear + 7 gap lines
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  LDX #7
.tb3:
  STA WSYNC
  DEX
  BNE .tb3

  LDA #$4A              ; word 2 in warm red
  STA COLUPF
  LDX #0                ; band 4: 28 banner lines, word 2
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

  STA WSYNC             ; band 5: clear + 15 gap lines
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  LDA #$02
  STA CTRLPF            ; SCORE mode for the hi-score + mode-digit bands
  LDX #15
.tb5:
  STA WSYNC
  DEX
  BNE .tb5

  ; band 6: hi-score, 20 lines (5 rows × 4). Both digits are packed into
  ; ONE PF1 byte (tens = high nibble = left, ones = low). In SCORE mode
  ; with no reflect the byte draws TWICE — left copy in COLUP0's blue,
  ; right copy in COLUP1's red. That doubled "NN NN" is the classic 2600
  ; dual-score aesthetic (think launch-era tank/plane games): embraced
  ; here, not fixed. In-session best rally; honest comment: there is no
  ; battery — this number is gone at power-off, like the arcades.
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
  CPX #20
  BNE .hsb

  STA WSYNC             ; band 7: clear + 11 gap lines
  LDA #0
  STA PF1
  LDX #11
.tb7:
  STA WSYNC
  DEX
  BNE .tb7

  ; band 8: mode digit (1 or 2), 10 lines (5 rows × 2), blinking. Also
  ; doubled by SCORE mode — "1 1" / "2 2" in the two player colors reads
  ; as "this many players". SELECT toggles it; fire 0/1 overrides it.
  LDX #0
.modeb:
  STA WSYNC
  TXA
  LSR
  TAY
  LDA INDBUF,Y
  STA PF1
  INX
  CPX #10
  BNE .modeb

  STA WSYNC             ; band 9: clear + 53 pad lines to reach exactly 192
  LDA #0
  STA PF1
  LDX #53
.tb9:
  STA WSYNC
  DEX
  BNE .tb9

  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── GAME LOGIC (clay — reshape freely) ── data tables ──────────────────
; Digit font: 4 pixels wide × 5 rows, stored in the HIGH nibble (PF1 bit7
; is the LEFTMOST pixel of the left playfield half — high nibble = left).
DIGITS:
  .byte $60,$90,$90,$90,$60   ; 0
  .byte $20,$60,$20,$20,$70   ; 1
  .byte $60,$90,$20,$40,$F0   ; 2
  .byte $E0,$10,$60,$10,$E0   ; 3
  .byte $90,$90,$F0,$10,$10   ; 4
  .byte $F0,$80,$E0,$10,$E0   ; 5
  .byte $60,$80,$E0,$90,$60   ; 6
  .byte $F0,$10,$20,$40,$40   ; 7
  .byte $60,$90,$60,$90,$60   ; 8
  .byte $60,$90,$70,$10,$60   ; 9

; Title jingle (voice 1, AUDC $04 square; AUDF divider — LOWER = higher
; pitch; 8 frames per note; $FF terminates). The table IS the song.
TITLE_TUNE:
  .byte $13,$0F,$0C,$09,$0C,$09,$07,$09,$FF
; Game-over tune: a falling figure.
OVER_TUNE:
  .byte $07,$09,$0C,$0F,$13,$17,$FF

; ── THE TITLE BANNER ──────────────────────────────────────────────────
; 40-pixel-wide artwork, 7 rows per word, drawn by the asymmetric-playfield
; kernel above. Each row is six bytes across six tables (left PF0/PF1/PF2,
; right PF0/PF1/PF2). PF bit order is the 2600's great prank — three
; registers, three different orders:
;   PF0: only bits 4-7 used, bit 4 = LEFTMOST pixel   (reversed)
;   PF1: bit 7 = leftmost                              (normal)
;   PF2: bit 0 = leftmost                              (reversed again)
; The art below each header is the row layout; regenerate the bytes by
; hand or with any 40-column bitmap-to-PF script honoring that order.
;
; RAPID:
;   .####.....###....####....#####...####...
;   .#...#...#...#...#...#.....#.....#...#..
;   .#...#...#...#...#...#.....#.....#...#..
;   .####....#####...####......#.....#...#..
;   .#.#.....#...#...#.........#.....#...#..
;   .#..#....#...#...#.........#.....#...#..
;   .#...#...#...#...#.......#####...####...
R1_PF0L:
  .byte %11100000, %00100000, %00100000, %11100000, %10100000, %00100000, %00100000
R1_PF1L:
  .byte %10000011, %01000100, %01000100, %10000111, %00000100, %10000100, %01000100
R1_PF2L:
  .byte %11100001, %00100010, %00100010, %11100011, %00100010, %00100010, %00100010
R1_PF0R:
  .byte %00010000, %00100000, %00100000, %00010000, %00000000, %00000000, %00000000
R1_PF1R:
  .byte %01111100, %00010000, %00010000, %00010000, %00010000, %00010000, %01111100
R1_PF2R:
  .byte %00011110, %00100010, %00100010, %00100010, %00100010, %00100010, %00011110

; RALLY:
;   .####.....###....#.......#.......#...#..
;   .#...#...#...#...#.......#........#.#...
;   .#...#...#...#...#.......#.........#....
;   .####....#####...#.......#.........#....
;   .#.#.....#...#...#.......#.........#....
;   .#..#....#...#...#.......#.........#....
;   .#...#...#...#...#####...#####.....#....
R2_PF0L:
  .byte %11100000, %00100000, %00100000, %11100000, %10100000, %00100000, %00100000
R2_PF1L:
  .byte %10000011, %01000100, %01000100, %10000111, %00000100, %10000100, %01000100
R2_PF2L:
  .byte %00100001, %00100010, %00100010, %00100011, %00100010, %00100010, %11100010
R2_PF0R:
  .byte %00000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00110000
R2_PF1R:
  .byte %01000000, %01000000, %01000000, %01000000, %01000000, %01000000, %01111100
R2_PF2R:
  .byte %00100010, %00010100, %00001000, %00001000, %00001000, %00001000, %00001000

; ── Vector table ──────────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

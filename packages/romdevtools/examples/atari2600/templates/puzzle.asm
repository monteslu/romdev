; ── puzzle.asm — TILE TWINS — Atari 2600 memory match-pairs (complete game) ──
;
; A COMPLETE, working game — drawn title screen, a turn-based MEMORY puzzle
; (flip two tiles, match the pair to clear them, clear the whole board to
; win), a move counter + in-session best (fewest flips), TIA sound effects +
; a title jingle, a win/game-over state with auto-return to the title, and
; the 2600's signature feature: THE WHOLE MACHINE. There is no framebuffer,
; no tilemap, no OS — every visible scanline is composed live by racing the
; beam.
;
; WHY THIS IS A PUZZLE, NOT AN ACTION GAME: nothing moves on its own. The
; board is static; the player THINKS, moves a cursor, and chooses which two
; tiles to flip. The challenge is memory + deduction, not reflexes. That is
; the honest "puzzle" idiom — and it suits the 2600 well, because a static,
; turn-based board needs no per-frame motion and so the kernel is simple.
;
; THE BOARD: 8 tiles = 4 PAIRS, drawn as a vertical stack of 8 bands. Each
; tile holds a hidden VALUE 0..3 (two of each, shuffled at game start). A
; tile is in one of three display states:
;   FACE-DOWN  — drawn in neutral gray (you don't know its value)
;   REVEALED   — drawn in its VALUE's color (you flipped it this turn)
;   MATCHED    — drawn dark/empty (cleared; it's out of play)
; The cursor (the tile you're about to flip) gets a bright border line.
;
; TIA object roles:
;   PF       = the 8 tile bands (full-width blocks; the only 2600 object wide
;               enough to read as a "tile"). COLUPF changes per band = per-
;               tile color, the easy honest way to show 4 distinct values.
;   COLUBK   = the cursor highlight (the selected band's background brightens).
;
; CONTROLS: joystick UP/DOWN moves the cursor; FIRE flips the tile under it.
; Flip one, then flip another: match → both clear + a chime; miss → both flip
; back after a short pause. Match all 4 pairs to win.

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
GRP0     = $1B
HMP0     = $20
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
; ── TIA READ registers ─────────────────────────────────────────────────
INPT4    = $0C          ; joystick 0 fire (bit7, ACTIVE LOW)
; ── RIOT ──────────────────────────────────────────────────────────────
SWCHA    = $280         ; joysticks: P0 = high nibble (active LOW)
SWCHB    = $282         ; console: bit0 RESET, bit1 SELECT (ACTIVE LOW)
INTIM    = $284         ; timer read
TIM64T   = $296         ; timer set, 64-cycle ticks

; ── Zero-page state (the 2600's ENTIRE RAM is $80-$FF — 128 bytes; in
; core memory dumps system_ram offset 0 = $80) ────────────────────────
STATE     = $80         ; 0 = title, 1 = play, 2 = game over / win
CURSOR    = $81         ; selected tile index 0..7
FIRST     = $82         ; index of the first flipped tile this turn, or $FF none
MOVES     = $83         ; flips taken this game, BCD (the score — LOWER is better)
MOVES_HI  = $84         ; high byte of the move count, BCD
MATCHED   = $85         ; bit i set = tile i is matched/cleared (8 bits)
REVEAL    = $86         ; bit i set = tile i is currently face-UP (revealed)
PAIRS     = $87         ; pairs found so far (win at 4)
MISS_T    = $88         ; >0 = mismatch pause countdown (both tiles shown, then hide)
FRAME     = $89
SFX_LEFT  = $8A         ; frames remaining on the voice-0 sound effect
TUNE_SEL  = $8B         ; 0 = title jingle, 1 = win/over tune (voice 1)
TUNE_POS  = $8C
TUNE_LEFT = $8D         ; frames left on current jingle note (0 = silent)
OVER_T    = $8E         ; game-over auto-return-to-title countdown
SWCHB_PRV = $8F         ; previous SWCHB for RESET edge detect
FIRE_PRV  = $90         ; previous fire level (bit7) for fire-edge detect
DPAD_PRV  = $91         ; previous SWCHA for up/down edge detect
EDGEB     = $92         ; this frame's RESET press-edge (bit0)
FIRE_EDG  = $93         ; this frame's fire press-edge (bit7)
TMP       = $94
TMP2      = $95
RNG       = $96         ; pseudo-random state (LFSR), reseeded each idle frame
BOARD     = $97         ; 8 bytes: hidden value 0..3 of each tile
                        ;   (BOARD..BOARD+7 = $97..$9E)
S0BUF     = $A0         ; 6 rows: packed move-count digits for the kernel
MOVES_BSV = $A6         ; SESSION best (fewest moves to clear), BCD low
MOVES_BSH = $A7         ;   RAM only — real 2600 carts have no battery.
HSBUF     = $A8         ; 6 rows: best, packed (for the title kernel)
SCRATCH   = $AE         ; 6 bytes general kernel/packer scratch

; ── layout / tuning constants (clay — change to reshape the game) ──────
NTILES    = 8           ; 4 pairs
NVALUES   = 4           ; distinct tile values (two of each)
WIN_PAIRS = 4
BANDH     = 18          ; scanlines per tile band (8 × 18 = 144)
BANDGAP   = 4           ; black separator lines at the bottom of each band
                        ;   (so the 8 tiles read as 8 distinct bars). The lit
                        ;   tile occupies BANDH-BANDGAP lines.
MISS_HOLD = 45          ; frames a mismatched pair stays visible before hiding

COL_BG    = $00         ; black gap behind the board
COL_DOWN  = $06         ; neutral gray — a face-DOWN tile
COL_GONE  = $02         ; near-black — a matched/cleared tile
COL_CUR   = $0E         ; cursor highlight — bright white separator bar
COL_HUD   = $0E         ; white move-counter digits

; the four VALUE colors (revealed tiles). Distinct hues, all bright.
VAL_COL0  = $46         ; red
VAL_COL1  = $1E         ; yellow
VAL_COL2  = $96         ; blue
VAL_COL3  = $C8         ; green

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clr:
  STA $00,X             ; clears ALL of $00-$FF: zero page RAM AND the TIA
  DEX                   ; write registers (GRP/audio all silenced — the
  BNE .clr              ; standard 2600 power-on hygiene)

  ; single, full-width objects everywhere; the cursor sprite (P0) is one band
  ; tall and we reposition it per frame.
  LDA #%00000000
  STA NUSIZ0
  STA NUSIZ1
  LDA #$FF
  STA RNG               ; nonzero LFSR seed

  JSR enter_title

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing — reshape gameplay around this) ───────
; THE FRAME LOOP. 262 scanlines, every frame, forever. VBLANK and overscan
; are timed with the RIOT timer (TIM64T) instead of counted WSYNCs: set the
; timer, run however much game logic the state needs, then spin on INTIM.
; This kills the classic homebrew bug where adding one branch to the logic
; emits a 263rd line and the TV loses vsync. The VISIBLE 192 lines are still
; counted exactly by the kernels below.
; ──────────────────────────────────────────────────────────────────────
MAIN:
  LDA #2
  STA VBLANK
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC
  LDA #43
  STA TIM64T

  JSR frame_logic       ; all game thinking happens in the blanked region

.vbwait:
  LDA INTIM
  BNE .vbwait
  STA WSYNC

  LDA STATE
  BNE .ingame
  JMP title_kernel
.ingame:
  JMP play_kernel

kernel_done:
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
; Per-frame logic, dispatched by state. Runs entirely inside timed VBLANK.
; ──────────────────────────────────────────────────────────────────────
frame_logic:
  INC FRAME
  JSR audio_tick

  ; ── HARDWARE IDIOM (load-bearing) ──
  ; Console RESET, fire, and the joystick are ACTIVE LOW and not debounced;
  ; convert each to a press-EDGE once per frame (was-released AND pressed-now)
  ; so one physical press = one action, not one-per-frame.
  LDA SWCHB
  TAX
  EOR #$FF
  AND SWCHB_PRV
  STA EDGEB             ; bit0 = RESET edge
  STX SWCHB_PRV
  ; fire button → edge in bit7
  LDA #0
  BIT INPT4
  BMI .fup              ; bit7 set = not pressed (active low)
  ORA #$80
.fup:
  TAY
  LDA FIRE_PRV
  EOR #$FF
  STA TMP
  TYA
  AND TMP
  STA FIRE_EDG          ; bit7 = fire press-edge
  STY FIRE_PRV

  ; keep the RNG churning while we wait for input
  JSR rng_step

  LDA STATE
  BEQ logic_title
  CMP #1
  BEQ logic_play_jmp
  JMP logic_over
logic_play_jmp:
  JMP logic_play

; ── GAME LOGIC (clay — reshape freely) ── title-screen behavior ────────
logic_title:
  ; fire or console RESET starts a new game.
  LDA FIRE_EDG
  BMI .start
  LDA EDGEB
  AND #$01
  BNE .start
  JMP .packtitle
.start:
  JMP start_game
.packtitle:
  ; Pack the session BEST into the title's display buffer (the kernel just
  ; streams bytes — all per-frame thinking happens HERE, in VBLANK).
  LDA MOVES_BSV
  JSR pack_two_digits
  LDY #0
.hst:
  LDA SCRATCH,Y
  STA HSBUF,Y
  INY
  CPY #6
  BNE .hst
  RTS

; ── GAME LOGIC (clay — reshape freely) ── one turn of the puzzle ───────
; All input is edge-triggered, so the board only changes on a deliberate
; press. The mismatch pause (MISS_T) is the one timed element — it just
; holds a wrong pair visible long enough to memorize before hiding it.
logic_play:
  ; mismatch pause: if running, count it down; when it expires, hide BOTH
  ; revealed tiles and end the turn. Ignore all input meanwhile.
  LDA MISS_T
  BEQ .noMiss
  DEC MISS_T
  BEQ .missEnd          ; pause just expired → hide the pair below
  JMP .ppack            ; still pausing — show the pair, take no input
.missEnd:
  LDA #0
  STA REVEAL            ; pause over: flip every revealed (unmatched) tile down
  LDA #$FF
  STA FIRST
  JMP .ppack
.noMiss:

  ; cursor up/down. SWCHA player-0 directions are active-LOW in the high
  ; nibble: Up=bit4, Down=bit5, Left=bit6, Right=bit7 (verified empirically
  ; against the host). A pressed direction reads 0, so invert to get a
  ; "pressed-now" mask, then AND with last frame's pressed mask's complement
  ; for a clean press-edge (one tap = one step).
  LDA SWCHA
  TAX                   ; X = raw current levels (active low)
  EOR #$FF              ; A = pressed-now (1 = held)
  STA TMP2              ; TMP2 = pressed-now mask
  EOR #$FF              ; back to raw...
  AND DPAD_PRV          ; (unused path) — keep DPAD_PRV as the prev pressed mask
  ; compute edge = pressed-now AND NOT pressed-last
  LDA DPAD_PRV
  EOR #$FF              ; NOT(pressed-last)
  AND TMP2              ; AND pressed-now → newly-pressed this frame
  STA TMP               ; TMP = press-edge mask
  LDA TMP2
  STA DPAD_PRV          ; store pressed-now as next frame's "pressed-last"
  LDA TMP
  AND #%00010000        ; UP = bit4
  BEQ .noUp
  LDA CURSOR
  BEQ .noUp             ; already at top
  DEC CURSOR
.noUp:
  LDA TMP
  AND #%00100000        ; DOWN = bit5
  BEQ .noDown
  LDA CURSOR
  CMP #(NTILES-1)
  BCS .noDown           ; already at bottom
  INC CURSOR
.noDown:

  ; FIRE = flip the tile under the cursor (if it's legal to flip).
  LDA FIRE_EDG
  BPL .ppack            ; no fire this frame
  ; ignore if this tile is already matched or already revealed
  LDX CURSOR
  JSR tile_bit          ; A = mask for CURSOR, X preserved as index
  STA TMP2              ; TMP2 = cursor bit mask
  AND MATCHED
  BNE .ppack            ; matched → can't flip
  LDA TMP2
  AND REVEAL
  BNE .ppack            ; already face-up → ignore

  ; reveal this tile
  LDA REVEAL
  ORA TMP2
  STA REVEAL
  ; count the flip (a "move")
  JSR add_move
  ; SFX: a short blip on every flip
  LDA #8
  LDX #4
  LDY #4
  JSR sfx_play

  ; is this the FIRST or the SECOND tile of the turn?
  LDA FIRST
  BPL .second
  ; first: just remember it
  LDA CURSOR
  STA FIRST
  JMP .ppack
.second:
  ; second flip — compare values. FIRST holds the other tile's index.
  LDX FIRST
  LDA BOARD,X
  STA TMP               ; value of first tile
  LDX CURSOR
  LDA BOARD,X
  CMP TMP
  BNE .miss
  ; MATCH! mark both matched, clear them from REVEAL, bump PAIRS.
  LDA MATCHED
  ORA TMP2              ; cursor's bit
  STA TMP2              ; (reuse TMP2 to accumulate)
  LDX FIRST
  JSR tile_bit
  ORA TMP2
  STA MATCHED
  LDA #0
  STA REVEAL            ; both were the only revealed tiles
  LDA #$FF
  STA FIRST
  INC PAIRS
  ; match chime (higher, longer)
  LDA #20
  LDX #12
  LDY #14
  JSR sfx_play
  ; win?
  LDA PAIRS
  CMP #WIN_PAIRS
  BCS .win
  JMP .ppack
.miss:
  ; mismatch: start the pause; both stay visible until MISS_T expires.
  LDA #MISS_HOLD
  STA MISS_T
  ; low buzz
  LDA #28
  LDX #6
  LDY #10
  JSR sfx_play
  JMP .ppack
.win:
  ; record best (fewest moves) and go to the win/over state.
  JSR record_best
  JMP do_game_over

.ppack:
  ; pack the live move count into the score buffer for the kernel.
  JSR pack_moves
  RTS

; ── GAME LOGIC (clay — reshape freely) ── win / game-over freeze-frame ──
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
  JSR pack_moves
  RTS

; ── GAME LOGIC (clay — reshape freely) ── helpers ──────────────────────

; tile_bit — A = the bit mask (1<<index) for tile index in X. X preserved.
tile_bit:
  LDA #1
  CPX #0
  BEQ .tbdone
  STX TMP
.sh:
  ASL
  DEC TMP
  BNE .sh
.tbdone:
  RTS

; rng_step — 8-bit LFSR (taps 0xB8). Keeps RNG nonzero; cheap entropy for
; the shuffle. Called every frame so the seed depends on how long the
; player lingered on the title.
rng_step:
  LDA RNG
  LSR
  BCC .noeor
  EOR #$B8
.noeor:
  STA RNG
  RTS

; TMP3PLUS1 — a scratch byte holding (i+1), the modulus for the shuffle's
; "j = rng mod (i+1)" step (see shuffle_with_bounds below).
TMP3PLUS1 = SCRATCH+5

add_move:               ; +1 flip, BCD, capped at 99 (then high byte)
  SED
  CLC
  LDA MOVES
  ADC #1
  STA MOVES
  LDA MOVES_HI
  ADC #0
  STA MOVES_HI
  CLD
  RTS

record_best:            ; if MOVES < session best (or best is 0), store it
  LDA MOVES_BSV
  ORA MOVES_BSH
  BEQ .store            ; best still 0 = unset → first win always records
  LDA MOVES_HI
  CMP MOVES_BSH
  BCC .store
  BNE .rbdone
  LDA MOVES
  CMP MOVES_BSV
  BCS .rbdone           ; current >= best → keep old best
.store:
  LDA MOVES
  STA MOVES_BSV
  LDA MOVES_HI
  STA MOVES_BSH
.rbdone:
  RTS

do_game_over:
  LDA #2
  STA STATE
  LDA #180
  STA OVER_T            ; ~3s auto-return to title
  LDA #1
  STA TUNE_SEL          ; win tune
  JSR tune_start
  RTS

start_game:
  ; reset all per-game state, shuffle a fresh board, enter play.
  LDA #0
  STA MOVES
  STA MOVES_HI
  STA MATCHED
  STA REVEAL
  STA PAIRS
  STA MISS_T
  STA TUNE_LEFT         ; silence the title jingle
  LDA #$FF
  STA FIRST
  LDA #0
  STA CURSOR
  JSR shuffle_with_bounds   ; fresh shuffled board (two each of 0..3)
  LDA #1
  STA STATE
  JSR pack_moves
  RTS

; shuffle_with_bounds — wrapper that drives shuffle_board's mod bound (i+1)
; as i descends. Kept separate so shuffle_board stays readable.
shuffle_with_bounds:
  ; seed 0,0,1,1,2,2,3,3
  LDX #0
.seed:
  TXA
  LSR
  STA BOARD,X
  INX
  CPX #NTILES
  BNE .seed
  LDX #(NTILES-1)
.loop:
  TXA
  CLC
  ADC #1
  STA TMP3PLUS1         ; bound = i+1
  JSR rng_step
  LDA RNG
  AND #$07
.fold:
  CMP TMP3PLUS1
  BCC .haveJ
  SEC
  SBC TMP3PLUS1
  JMP .fold
.haveJ:
  TAY                   ; Y = j
  LDA BOARD,X
  STA TMP2
  LDA BOARD,Y
  STA BOARD,X
  LDA TMP2
  STA BOARD,Y
  DEX
  BNE .loop
  RTS

enter_title:
  LDA #0
  STA STATE
  STA SFX_LEFT
  STA TUNE_SEL          ; title jingle
  STA MISS_T
  STA REVEAL
  JSR tune_start
  RTS

; digit_times6 — A = digit 0-9 → A = digit*6 (DIGITS row index)
digit_times6:
  STA TMP
  ASL
  ASL                   ; *4
  CLC
  ADC TMP               ; *5
  CLC
  ADC TMP               ; *6
  RTS

; pack_two_digits — render the two BCD digits of A into SCRATCH..SCRATCH+5
; (6 font rows), low digit left, high digit right, for the title best line.
pack_two_digits:
  PHA
  AND #$0F              ; low digit
  JSR digit_times6
  TAX
  LDY #0
.lo:
  LDA DIGITS,X
  STA SCRATCH,Y
  INX
  INY
  CPY #6
  BNE .lo
  PLA
  LSR
  LSR
  LSR
  LSR                   ; high digit
  JSR digit_times6
  TAX
  LDY #0
.hi:
  LDA DIGITS,X
  ; merge: high digit occupies the right nibble columns (shift right 4)
  LSR
  LSR
  LSR
  LSR
  ORA SCRATCH,Y
  STA SCRATCH,Y
  INX
  INY
  CPY #6
  BNE .hi
  RTS

; pack_moves — render the low two MOVES digits into S0BUF (the live counter
; the play/over kernel streams into the score bar).
pack_moves:
  LDA MOVES
  JSR pack_two_digits
  LDY #0
.cp:
  LDA SCRATCH,Y
  STA S0BUF,Y
  INY
  CPY #6
  BNE .cp
  RTS

; ── GAME LOGIC (clay — reshape freely) ── TIA sound ────────────────────
; sfx_play — A = AUDF pitch, X = AUDC waveform, Y = frames. Voice 0.
sfx_play:
  STA AUDF0
  STX AUDC0
  STY SFX_LEFT
  LDA #8
  STA AUDV0
  RTS

; tune_start — begin the jingle selected by TUNE_SEL (0 title, 1 win). V1.
tune_start:
  LDA #0
  STA TUNE_POS
  JSR tune_note
  RTS

; tune_note — load AUDF1 from the selected table at TUNE_POS; returns Z set
; (A=0) on the $FF terminator. Sets the note's duration into TUNE_LEFT.
tune_note:
  LDX TUNE_POS
  LDA TUNE_SEL
  BEQ .title
  LDA OVER_TUNE,X
  JMP .got
.title:
  LDA TITLE_TUNE,X
.got:
  CMP #$FF
  BEQ .end
  STA AUDF1
  LDA #12
  STA AUDC1
  LDA #8
  STA AUDV1
  LDA #16
  STA TUNE_LEFT         ; 16 frames per note
  LDA #1                ; Z clear = not terminated
  RTS
.end:
  LDA #0
  STA AUDV1             ; silence
  STA TUNE_LEFT
  RTS

; audio_tick — once per frame, every state: age the SFX and advance the tune.
audio_tick:
  LDA SFX_LEFT
  BEQ .nosfx
  DEC SFX_LEFT
  BNE .nosfx
  LDA #0
  STA AUDV0             ; SFX finished → silence voice 0
.nosfx:
  LDA TUNE_LEFT
  BEQ .notune
  DEC TUNE_LEFT
  BNE .notune
  INC TUNE_POS          ; next note
  JSR tune_note
.notune:
  RTS

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing) ──
; OBJECT POSITIONING — the canonical SBC-#15 beam-race for P0 (the cursor
; bracket). The object lands wherever the beam is when you strobe RESP0;
; each SBC/BCS lap is 5 cycles = 15 pixels, and the remainder becomes the
; fine HMOVE offset. We park P0 at the left margin so its bracket frames the
; board's left edge on the cursor's band.
; ──────────────────────────────────────────────────────────────────────
position_cursor:
  STA WSYNC
  STA HMCLR
  LDA #16               ; cursor bracket X (left margin)
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
  STA WSYNC
  STA HMOVE
  RTS

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing) ──
; THE PLAY/GAME-OVER KERNEL — 192 visible lines, fully accounted:
;   24 = move-counter bar  +  144 = board (8 bands × 18)  +  24 = pad = 192
;
; MOVE BAR (SCORE mode): CTRLPF=$02 colors the left half with COLUP0; we
; stream the packed counter digits into PF1, one font row / 4 lines.
;
; BOARD: 8 tile bands of BANDH lines. Per band we pick the tile's COLOR from
; its state — matched (dark), revealed (its value color), or face-down (gray)
; — and brighten COLUBK on the cursor's band. The whole band is one lit PF
; block (PF0/PF1/PF2 = solid), so each tile reads as a fat horizontal bar.
; ──────────────────────────────────────────────────────────────────────
play_kernel:
  JSR position_cursor

  LDA #COL_BG
  STA COLUBK
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA VBLANK            ; beam on
  ; SCORE mode colors the playfield halves by COLUP0 (left) / COLUP1 (right),
  ; NOT COLUPF — set both white so the counter digits read on either half.
  LDA #COL_HUD
  STA COLUP0
  STA COLUP1
  STA COLUPF
  LDA #$02
  STA CTRLPF            ; SCORE mode for the counter bar

  ; ---- move-counter bar: 24 lines (6 font rows × 4) ----
  LDX #0
.sbar:
  STA WSYNC
  TXA
  LSR
  LSR
  TAY
  LDA S0BUF,Y
  STA PF1
  INX
  CPX #24
  BNE .sbar

  ; transition: clear the bar; switch to a solid full-width playfield for the
  ; tile bands (no reflect needed — each band is a solid bar).
  STA WSYNC
  LDA #0
  STA PF1
  STA CTRLPF            ; normal repeat, solid PF
  LDA #$FF
  STA PF0              ; PF0 uses bits 4-7 → solid left 4 px
  STA PF1
  STA PF2              ; all three solid = full 40-px-wide band

  ; ---- board: NTILES bands, tile 0 at top ----
  LDX #0                ; X = tile index
.bandLoop:
  ; pick this tile's playfield color into A.
  JSR tile_bit          ; A = mask for tile X
  STA TMP2
  AND MATCHED
  BNE .gone
  LDA TMP2
  AND REVEAL
  BNE .revealed
  ; face-down
  LDA #COL_DOWN
  JMP .haveCol
.gone:
  LDA #COL_GONE
  JMP .haveCol
.revealed:
  ; color = VAL_COLn for BOARD[X]
  LDA BOARD,X
  TAY
  LDA VALCOLS,Y
.haveCol:
  STA TMP               ; TMP = this tile's lit color

  ; cursor highlight: the SELECTED band draws its separator gap as a bright
  ; white bar (an unmistakable underline); other bands' gaps are black.
  LDA #COL_BG
  CPX CURSOR
  BNE .noCur
  LDA #COL_CUR
.noCur:
  STA TMP2              ; TMP2 = this band's GAP color

  ; ---- lit tile: BANDH-BANDGAP lines in the tile color ----
  LDA TMP
  STA COLUPF
  LDA #$FF
  STA PF0
  STA PF1
  STA PF2              ; ensure solid (the gap below clears it)
  LDY #(BANDH-BANDGAP)
.tileLine:
  STA WSYNC
  DEY
  BNE .tileLine

  ; ---- separator gap: BANDGAP lines. PF colored by TMP2 (white on the
  ;      cursor band, black otherwise) so the selection reads as a bar. ----
  LDA TMP2
  STA COLUPF
  LDY #BANDGAP
.gapLine:
  STA WSYNC
  DEY
  BNE .gapLine

  INX
  CPX #NTILES
  BNE .bandLoop

  ; pad to 192 visible (24 bar + 144 board = 168 → +24 pad)
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA COLUBK
  STA GRP0
  LDX #24
.pad:
  STA WSYNC
  DEX
  BNE .pad

  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── HARDWARE IDIOM (load-bearing) ──
; THE TITLE KERNEL — 192 lines, banded:
;   24 blank + 28 banner "TILE" + 8 gap + 28 banner "TWINS" + 16 gap +
;   24 best + remainder pad = 192. The banner is an ASYMMETRIC PLAYFIELD,
;   the 2600's only way to draw full-width artwork: PF0/PF1/PF2 are reloaded
;   mid-line so the left copy (px 0..19) and right copy (px 20..39) carry
;   independent pixels. CTRLPF bit0 = 0 (repeat) is required.
; ──────────────────────────────────────────────────────────────────────
title_kernel:
  LDA #$84
  STA COLUBK
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  STA GRP0
  STA CTRLPF            ; REPEAT mode — required by the banner
  STA VBLANK

  LDX #24
.tb1:
  STA WSYNC
  DEX
  BNE .tb1

  LDA #$3A              ; word 1 in warm yellow
  STA COLUPF
  LDX #0
.ban1:
  STA WSYNC
  TXA
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

  STA WSYNC
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  LDX #7
.tb3:
  STA WSYNC
  DEX
  BNE .tb3

  LDA #$C8              ; word 2 in green
  STA COLUPF
  LDX #0
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

  STA WSYNC
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  LDA #$02
  STA CTRLPF            ; SCORE mode for the best band
  LDX #15
.tb5:
  STA WSYNC
  DEX
  BNE .tb5

  ; ---- best line: 24 lines, the session best (fewest moves) ----
  LDA #COL_HUD
  STA COLUPF
  LDX #0
.best:
  STA WSYNC
  TXA
  LSR
  LSR
  TAY
  LDA HSBUF,Y
  STA PF1
  INX
  CPX #24
  BNE .best

  STA WSYNC
  LDA #0
  STA PF1
  ; pad to 192 (24+28+8+28+16+24 = 128 → +64 pad)
  LDX #64
.tpad:
  STA WSYNC
  DEX
  BNE .tpad

  JMP kernel_done

; ──────────────────────────────────────────────────────────────────────
; ── GAME LOGIC (clay — reshape freely) ── data tables ──────────────────
; ──────────────────────────────────────────────────────────────────────

; the four VALUE colors, indexed by BOARD[i] (0..3).
VALCOLS:
  .byte VAL_COL0, VAL_COL1, VAL_COL2, VAL_COL3

; DIGITS — 6 rows/glyph, 0..9. Each byte's high nibble (bits 4-7) is the lit
; pattern; SCORE mode streams it through PF1 so a digit is 4 px wide.
DIGITS:
  .byte %01100000,%10010000,%10010000,%10010000,%10010000,%01100000 ; 0
  .byte %00100000,%01100000,%00100000,%00100000,%00100000,%01110000 ; 1
  .byte %11100000,%00010000,%01100000,%10000000,%10000000,%11110000 ; 2
  .byte %11100000,%00010000,%01100000,%00010000,%10010000,%01100000 ; 3
  .byte %10010000,%10010000,%11110000,%00010000,%00010000,%00010000 ; 4
  .byte %11110000,%10000000,%11100000,%00010000,%10010000,%01100000 ; 5
  .byte %01100000,%10000000,%11100000,%10010000,%10010000,%01100000 ; 6
  .byte %11110000,%00010000,%00100000,%01000000,%01000000,%01000000 ; 7
  .byte %01100000,%10010000,%01100000,%10010000,%10010000,%01100000 ; 8
  .byte %01100000,%10010000,%10010000,%01110000,%00010000,%01100000 ; 9

; jingles — AUDF1 pitches, $FF terminates. (12 = pure tone waveform.)
TITLE_TUNE:
  .byte 20, 16, 12, 16, 20, 24, 20, $FF
OVER_TUNE:
  .byte 12, 12, 16, 20, 24, 28, $FF

; ── THE TITLE BANNER ──────────────────────────────────────────────────
; 40-px artwork, 7 rows/word, drawn by the asymmetric-playfield kernel.
; PF bit order is the 2600's prank — three registers, three orders:
;   PF0: bits 4-7 used, bit4 = LEFTMOST   PF1: bit7 = leftmost (normal)
;   PF2: bit0 = leftmost.  Tables generated from the ASCII art below.
;
; TILE (T-I-L-E, all in the left copy; +6px left pad to centre the word):
;         #### ###. #... ####
;         ..#. .#.. #... #...
;         ..#. .#.. #... #...
;         ..#. .#.. #... ###.
;         ..#. .#.. #... #...
;         ..#. .#.. #... #...
;         ..#. ###. #### ####
R1_PF0L:
  .byte %00000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00000000
R1_PF1L:
  .byte %00111101, %00001000, %00001000, %00001000, %00001000, %00001000, %00001001
R1_PF2L:
  .byte %00010011, %00010001, %00010001, %00010001, %00010001, %00010001, %11110011
R1_PF0R:
  .byte %11100000, %00100000, %00100000, %11100000, %00100000, %00100000, %11100000
R1_PF1R:
  .byte %10000000, %00000000, %00000000, %00000000, %00000000, %00000000, %10000000
R1_PF2R:
  .byte %00000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00000000

; TWINS (T-W-I-N in the left copy, S in the right):
;     #### #..# ###. #..# .###
;     ..#. #..# .#.. ##.# #...
;     ..#. #..# .#.. ##.# #...
;     ..#. #..# .#.. #.## ###.
;     ..#. #.## .#.. #.## ...#
;     ..#. ##.# .#.. #..# ...#
;     ..#. #..# ###. #..# ###.
R2_PF0L:
  .byte %11000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00000000
R2_PF1L:
  .byte %11010010, %10010010, %10010010, %10010010, %10010110, %10011010, %10010010
R2_PF2L:
  .byte %00100111, %01100010, %01100010, %10100010, %10100010, %00100010, %00100111
R2_PF0R:
  .byte %10010000, %01010000, %01010000, %11010000, %00010000, %00010000, %11010000
R2_PF1R:
  .byte %11000000, %00000000, %00000000, %10000000, %01000000, %01000000, %10000000
R2_PF2R:
  .byte %00000000, %00000000, %00000000, %00000000, %00000000, %00000000, %00000000

; ── Vector table ──────────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

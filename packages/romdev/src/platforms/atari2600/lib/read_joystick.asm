; ── Read joystick 0 ────────────────────────────────────────────────
; Joystick state lives in RIOT register SWCHA ($280). The 4 high bits
; (P0_RIGHT/LEFT/DOWN/UP) are the player-0 stick directions, ACTIVE-LOW.
; Bit 7 = right, 6 = left, 5 = down, 4 = up.
;
; Fire button is on TIA INPT4 ($3C), latched low when pressed.
;
; ── How to use ─────────────────────────────────────────────────────
; Call READ_JOYSTICK once per frame (in vblank ideally), then test the
; cached JOY_STATE byte — NEVER re-read SWCHA in the middle of your
; bit-test chain. Reading SWCHA returns the *live* state, so if you
; chain `LDA SWCHA / ASL / BCS / ASL / BCS` you'll see different bits
; on each ASL because the value in A has changed since the last load.
;
; THE CLASSIC BUG (cost an agent 30 min): "left works once, right
; never does" — caused by reading SWCHA twice without re-load, or by
; ASL-chaining without re-loading A between bit-tests. The cached
; JOY_STATE pattern below avoids it entirely.
;
;   JSR READ_JOYSTICK
;
;   ; Pattern A — bit mask (clearest, no ASL chain to mis-count):
;   LDA JOY_STATE
;   AND #P0_RIGHT_MASK
;   BEQ .not_right
;   ; ... right pressed: do work, freely clobber A ...
; .not_right:
;   LDA JOY_STATE          ; ← RE-LOAD before next direction test
;   AND #P0_LEFT_MASK
;   BEQ .not_left
;   ; ... left pressed ...
; .not_left:
;   LDA JOY_STATE          ; ← RE-LOAD again
;   AND #P0_UP_MASK
;   BEQ .not_up
;   ; ...
;
;   ; Pattern B — ASL chain (cheaper, but you MUST re-load JOY_STATE
;   ; before the chain and ensure no code path consumes A mid-chain):
;   LDA JOY_STATE
;   ASL                    ; carry = bit 7 = RIGHT
;   BCC .not_right
;   ; right pressed — do NOT touch A's bits, OR re-load below
; .not_right:
;   LDA JOY_STATE          ; ← RE-LOAD if branch body clobbered A
;   ASL                    ; bit 7 shifted out previously? no — fresh load.
;   ASL                    ; consume bit 7
;   ASL                    ; carry = bit 6 = LEFT (counting from MSB-first
;                          ; after one ASL would be bit 6, etc. — easy to
;                          ; off-by-one. Pattern A above is safer.)
;
; Prefer Pattern A unless you're cycle-counting.

P0_RIGHT_MASK equ $80
P0_LEFT_MASK  equ $40
P0_DOWN_MASK  equ $20
P0_UP_MASK    equ $10
FIRE_MASK     equ $80    ; bit 7 of FIRE_STATE = pressed

JOY_STATE  equ $90   ; ZP byte holding inverted joystick bits
FIRE_STATE equ $91   ; ZP byte: bit 7 set if fire pressed

; READ_JOYSTICK — call once per frame. Caches state in JOY_STATE +
; FIRE_STATE; from then on read those, NOT SWCHA/INPT4 directly.
READ_JOYSTICK:
  LDA SWCHA
  EOR #$FF        ; invert (input is active-low)
  STA JOY_STATE   ; now bit 7 = right pressed, bit 6 = left, etc.

  LDA INPT4
  ASL             ; bit 7 → carry (button is bit 7, active-low)
  LDA #0
  ROR             ; carry → bit 7
  EOR #$80        ; flip so "pressed" = $80
  STA FIRE_STATE
  RTS

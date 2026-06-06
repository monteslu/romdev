; ── Score-band kernel — top-of-screen 2-digit score via PF1 ───────
;
; Renders a 1-2 digit score (0-99) at the top of the visible playfield
; using PF1 in SCORE mode (CTRLPF bit 1 set). SCORE mode makes the LEFT
; half of the playfield use P0's color and the RIGHT half use P1's
; color — so the same playfield bits draw the tens digit (P0 color)
; on the left half and the ones digit (P1 color) on the right half.
;
; This is the canonical 2600 score-display pattern (Combat onward).
;
; ── COPY-PASTE TEMPLATE, not a linkable module ─────────────────────
; This file has NO `org` directive on purpose. dasm builds a flat ROM,
; and an `org` here would collide with your main code / other snippets
; ("Origin Reverse-indexed"). Inline the routines + the DIGIT_SHAPES
; table into your own source wherever you want them to live. Put the
; DIGIT_SHAPES table somewhere it won't straddle a page boundary
; relative to your other data (the (ptr),Y reads cross-page fine, but
; keeping a digit's 8 bytes contiguous is the only requirement).
;
; ── How to use ─────────────────────────────────────────────────────
;   1. Init: write your score (0..99) into SCORE_VALUE (ZP $86),
;      stored BCD-style — high nibble = tens, low nibble = ones.
;      (Maintain it with SED math, or split a binary value yourself.)
;   2. Each frame BEFORE the visible kernel, JSR SCORE_PREP. It splits
;      SCORE_VALUE into tens/ones and builds two FULL 16-bit pointers
;      (lo+hi) into DIGIT_SHAPES.
;   3. Inside the visible kernel, JSR SCORE_KERNEL_BAND at the line
;      where the score should appear. It eats 8 scanlines + 1 cleanup.
;   4. Set COLUP0 (tens color) and COLUP1 (ones color), CTRLPF bit 1
;      (SCORE mode), and zero PF0/PF2 before calling the band.
;
; ── Cost ───────────────────────────────────────────────────────────
;   ROM: ~80 bytes digit shapes + ~55 bytes routines
;   RAM: 5 bytes — $86 SCORE_VALUE, $87/$88 tens ptr lo/hi,
;        $89/$8A ones ptr lo/hi.
;   Cycles: 8 lines × 76 = ~608 per frame.

SCORE_VALUE     equ $86  ; 0..99, BCD: high nibble tens, low nibble ones
SCORE_PTR_T_LO  equ $87  ; tens-digit shape pointer, LO byte
SCORE_PTR_T_HI  equ $88  ; tens-digit shape pointer, HI byte
SCORE_PTR_O_LO  equ $89  ; ones-digit shape pointer, LO byte
SCORE_PTR_O_HI  equ $8A  ; ones-digit shape pointer, HI byte

; ── Digit shapes — 4 pixels wide × 8 rows each, 10 blocks of 8 bytes.
;    Pixels live in the HIGH nibble of each byte; the low nibble is
;    ALWAYS zero. That layout lets SCORE_KERNEL_BAND OR-merge the
;    ones digit (shifted into the low nibble) without masking. Digit
;    N starts at offset N*8.
;
;    INLINE THIS TABLE into your source (no `org` — place it in your
;    data area). (ptr),Y indexing handles a page-crossing table fine.
DIGIT_SHAPES:
  ; '0'
  .byte $60,$90,$90,$90,$90,$90,$60,$00
  ; '1'
  .byte $20,$60,$20,$20,$20,$20,$70,$00
  ; '2'
  .byte $60,$90,$10,$20,$40,$80,$F0,$00
  ; '3'
  .byte $60,$90,$10,$60,$10,$90,$60,$00
  ; '4'
  .byte $90,$90,$90,$F0,$10,$10,$10,$00
  ; '5'
  .byte $F0,$80,$80,$E0,$10,$90,$60,$00
  ; '6'
  .byte $60,$90,$80,$E0,$90,$90,$60,$00
  ; '7'
  .byte $F0,$10,$20,$20,$40,$40,$40,$00
  ; '8'
  .byte $60,$90,$90,$60,$90,$90,$60,$00
  ; '9'
  .byte $60,$90,$90,$70,$10,$90,$60,$00

; SCORE_PREP — compute FULL (lo+hi) pointers for the current
; SCORE_VALUE. Call once per frame BEFORE entering the visible kernel.
SCORE_PREP:
  ; Tens: high nibble of SCORE_VALUE → digit, * 8 = byte offset.
  LDA SCORE_VALUE
  LSR
  LSR
  LSR
  LSR                  ; A = tens digit (0..9)
  ASL
  ASL
  ASL                  ; A = tens * 8
  CLC
  ADC #<DIGIT_SHAPES
  STA SCORE_PTR_T_LO
  LDA #>DIGIT_SHAPES
  ADC #0               ; carry from the LO add (page-cross safe)
  STA SCORE_PTR_T_HI
  ; Ones: low nibble * 8.
  LDA SCORE_VALUE
  AND #$0F
  ASL
  ASL
  ASL                  ; A = ones * 8
  CLC
  ADC #<DIGIT_SHAPES
  STA SCORE_PTR_O_LO
  LDA #>DIGIT_SHAPES
  ADC #0
  STA SCORE_PTR_O_HI
  RTS

; SCORE_KERNEL_BAND — render 8 scanlines of score. Composites BOTH
; digits into ONE PF1 byte per scanline and writes PF1 once. SCORE
; mode (CTRLPF bit 1) then colors the high-nibble (tens) pixels with
; P0's color on the left half and the low-nibble (ones) pixels with
; P1's color on the right half — the classic "10  10" two-color look.
;
; Assumes before entry: CTRLPF bit 1 set, COLUP0/COLUP1 set, PF0=PF2=0.
; Clobbers A, Y, and scratch ZP $94.
;
; (Advanced: if you want two TRULY independent digit shapes — e.g.
; different glyphs whose pixels don't share a single PF1 byte — you
; need a cycle-tight 2-write kernel where the 2nd STA PF1 lands at
; CPU cycle >= 38 / visible pixel >= 48. That's harder to get right;
; the single-write composite below is the standard approach and
; renders correctly out of the box.)
SCORE_KERNEL_BAND:
  LDY #0
.row:
  STA WSYNC
  LDA (SCORE_PTR_T_LO),Y   ; tens row — pixels already in HIGH nibble
  STA $94                  ; stash (low nibble is 0 by table design)
  LDA (SCORE_PTR_O_LO),Y   ; ones row — pixels in HIGH nibble
  LSR
  LSR
  LSR
  LSR                      ; shift ones pixels down into LOW nibble
  ORA $94                  ; composite: tens(hi) | ones(lo)
  STA PF1                  ; single write — both halves from one byte
  INY
  CPY #8
  BNE .row
  ; Clear PF1 so the score band doesn't bleed into the next region.
  STA WSYNC
  LDA #0
  STA PF1
  RTS

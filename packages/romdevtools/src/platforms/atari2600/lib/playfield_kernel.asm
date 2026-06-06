; ── Asymmetric playfield kernel ───────────────────────────────────
; Renders a 40-pixel-wide playfield from a per-scanline byte table.
; Each "row" of the playfield is 3 bytes (PF0 high-nibble, PF1, PF2),
; so a 96-row map needs 288 bytes — well within a 4K cart.
;
; This is the foundation for level / maze / "title screen" graphics
; on the 2600. Pair with `score_kernel.asm` for a status bar.
;
; ── COPY-PASTE TEMPLATE, not a linkable module ─────────────────────
; No `org` directive here — it'd collide with your main ROM layout
; when dasm builds the flat ROM. Inline these routines + the
; PLAYFIELD_DATA table into your own source. Your kernel_skeleton.asm
; owns the org $F000 / $FFFA that define the ROM image.

  ; Per-row playfield bytes: PF0, PF1, PF2 interleaved.
  ; 96 rows × 3 bytes = 288 bytes.
  ;
  ; (PF0 high nibble is what's drawn — low nibble is ignored.)
PLAYFIELD_TABLE_LO equ $80   ; low byte of current row pointer
PLAYFIELD_TABLE_HI equ $81
PLAYFIELD_ROW      equ $82

PLAYFIELD_INIT:
  LDA #<PLAYFIELD_DATA
  STA PLAYFIELD_TABLE_LO
  LDA #>PLAYFIELD_DATA
  STA PLAYFIELD_TABLE_HI
  LDA #0
  STA PLAYFIELD_ROW
  ; Asymmetric playfield (CTRLPF.SCORE = 0, REFLECT = 0): both halves
  ; use the same PF0/PF1/PF2 bytes — but for a level map most authors
  ; instead use CTRLPF_REFLECT for mirroring.
  LDA #CTRLPF_REFLECT
  STA CTRLPF
  RTS

; Call from inside the visible kernel. X = current scanline index.
PLAYFIELD_LINE:
  LDA PLAYFIELD_ROW
  ASL                ; ×2
  ADC PLAYFIELD_ROW  ; ×3  (Y = row * 3)
  TAY
  LDA (PLAYFIELD_TABLE_LO),Y
  STA PF0
  INY
  LDA (PLAYFIELD_TABLE_LO),Y
  STA PF1
  INY
  LDA (PLAYFIELD_TABLE_LO),Y
  STA PF2
  INC PLAYFIELD_ROW
  RTS

  ; 8-row demo map: a hollow rectangle. Each row is PF0, PF1, PF2.
PLAYFIELD_DATA:
  .byte $F0, $FF, $FF        ; top border (all on)
  .byte $10, $00, $80
  .byte $10, $00, $80
  .byte $10, $00, $80
  .byte $10, $00, $80
  .byte $10, $00, $80
  .byte $10, $00, $80
  .byte $F0, $FF, $FF        ; bottom border

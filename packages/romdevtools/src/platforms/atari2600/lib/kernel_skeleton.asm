; ── Atari 2600 standard kernel skeleton ───────────────────────────
; Three-section frame: vertical sync (3 lines) → vertical blank (37 lines)
; → 192 visible scanlines → 30 lines overscan. This is the canonical
; NTSC 262-line frame (3 + 37 + 192 + 30 = 262).
;
; Drop your per-frame game logic into the `; --- VBLANK work here ---`
; slot so it runs during the 37-line blanking period (≈ 2812 cycles).
; Anything that doesn't fit in vblank gets pushed into overscan (30
; lines ≈ 2280 cycles).

  processor 6502
  include "vcs_constants.h"

  org $F000

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clear_ram:
  STA $00,X
  DEX
  BNE .clear_ram

  ; Pick a background color so something renders.
  LDA #$80           ; blue, mid luma
  STA COLUBK

; ── Main loop ───────────────────────────────────────────────────────
MAIN_LOOP:
  LDA #2
  STA VSYNC          ; start vsync (bit 1 = on)
  STA WSYNC
  STA WSYNC
  STA WSYNC          ; 3 lines of vsync
  LDA #0
  STA VSYNC

  ; ── VBLANK (37 lines) ─────────────────────────────────────────────
  LDA #VBLANK_ON
  STA VBLANK
  LDX #37
.vb_loop:
  STA WSYNC
  ; --- VBLANK work here --------------------------------------------
  ;  Game logic, controller reads, sprite positioning, etc.
  ;  Each iteration is one scanline (≈ 76 CPU cycles).
  ; -----------------------------------------------------------------
  DEX
  BNE .vb_loop

  ; ── Visible kernel (192 lines) ────────────────────────────────────
  LDA #0
  STA VBLANK         ; turn on the picture
  LDX #192
.draw_loop:
  STA WSYNC
  ; --- per-scanline graphics writes here ---------------------------
  ;  Update GRP0/GRP1/PF0/PF1/PF2/ENABL etc. *just before* WSYNC if
  ;  you want them visible on THIS line.
  ; -----------------------------------------------------------------
  DEX
  BNE .draw_loop

  ; ── Overscan (30 lines) ───────────────────────────────────────────
  LDA #VBLANK_ON
  STA VBLANK
  LDX #30
.os_loop:
  STA WSYNC
  ; --- overscan work here ------------------------------------------
  ;  Lower-priority logic that didn't fit in vblank.
  ; -----------------------------------------------------------------
  DEX
  BNE .os_loop

  JMP MAIN_LOOP

  ; vector table (always 6 bytes at the top of the bank)
  org $FFFA
  .word START        ; NMI (unused on 2600)
  .word START        ; RESET
  .word START        ; IRQ (unused unless BRK is used)

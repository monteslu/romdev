; ── Cart vector table ──────────────────────────────────────────────
; The 6502 looks here for handler addresses on reset/NMI/IRQ. On the
; 2600 this lives at $FFFA-$FFFF, the top 6 bytes of the cart bank.
;
; For 4 KB carts the bank is mapped at $F000-$FFFF; for banked carts
; EVERY bank must terminate with these same 6 bytes (only the currently-
; mapped bank's vectors are visible to the CPU).
;
; Include via `include "vectors.asm"` after the rest of your code,
; pointing at your reset entry point.

  ; Replace START with your reset label.
  org $FFFA
  .word START        ; NMI handler (unused on 2600 — points at reset)
  .word START        ; RESET handler — where the CPU starts
  .word START        ; IRQ handler (BRK and external IRQs land here)

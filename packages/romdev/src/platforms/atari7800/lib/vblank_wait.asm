; ── Wait for next vblank ───────────────────────────────────────────
; MSTAT bit 7 is set during vertical blanking (MARIA is not currently
; rendering). Spin until we see vblank starting (transition 0 → 1).
; Useful as the sync point for per-frame game updates.

.include "maria_registers.h"

.proc vblank_wait
    ; Wait for vblank to clear first (we might already be in it).
:   LDA MSTAT
    BMI :-
    ; Then wait for it to set.
:   LDA MSTAT
    BPL :-
    RTS
.endproc

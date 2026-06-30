; ---------------------------------------------------------------------------
; GameTank 6502 vector table at $FFFA (NMI / RESET / IRQ-BRK).
; Adapted from gametank_sdk src/gt/vectors.s, MIT. The handlers are exported by
; the Tier-A crt0 (rti defaults) — a game can override _nmi_int/_irq_int.
; ---------------------------------------------------------------------------
.import _init, _nmi_int, _irq_int

.segment "VECTORS"

.addr   _nmi_int        ; $FFFA NMI
.addr   _init           ; $FFFC RESET
.addr   _irq_int        ; $FFFE IRQ / BRK

; GameTank SDK-runtime vector table at $FFFA. The interrupt handlers come from the
; bundled SDK runtime (interrupt.s exports _nmi_int / _irq_int), so this just
; imports + points the table at them. (The bare single-bank.vectors.s defines its
; own rti handlers; the SDK preset uses the SDK's real ones.)
.import _init, _nmi_int, _irq_int

.segment "VECTORS"

.addr   _nmi_int        ; $FFFA NMI
.addr   _init           ; $FFFC RESET
.addr   _irq_int        ; $FFFE IRQ / BRK

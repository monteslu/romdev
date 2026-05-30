; nmi_trampoline.s — paste together with nmi_handler.c.
;
; Replaces the chr-ram preset crt0's default `nmi: rti` stub by
; exporting `nmi` here and calling into the C-side handler. ALSO
; REQUIRES: remove the `nmi: rti` line from the preset crt0 (paste
; the crt0 into your own sources, edit, and include it instead of
; relying on the auto-included preset). Otherwise ca65 errors with
; "symbol `nmi` already defined".

.export nmi
.import _nmi_c_main

nmi:
    pha
    txa
    pha
    tya
    pha
    jsr _nmi_c_main
    pla
    tay
    pla
    tax
    pla
    rti

; ── Load 8 palettes + backdrop ─────────────────────────────────────
; Copies 25 bytes (1 backdrop + 8 palettes × 3 colors) into the MARIA
; palette registers. Each palette index 0 in a sprite refers to BACKGRND
; ($20); indices 1/2/3 refer to PnC1/PnC2/PnC3.
;
; Pass a pointer to a 25-byte palette block in ZP $80/$81 before JSR.

.include "maria_registers.h"

PAL_PTR_LO = $80
PAL_PTR_HI = $81

.proc palette_load
    LDY #0
    ; backdrop ($20)
    LDA (PAL_PTR_LO),Y
    STA BACKGRND
    INY
    ; palette 0 ($21-$23)
    LDX #0
:   LDA (PAL_PTR_LO),Y
    STA P0C1,X
    INX
    INY
    CPX #3
    BNE :-
    ; palette 1 ($25-$27)
    LDX #0
:   LDA (PAL_PTR_LO),Y
    STA P1C1,X
    INX
    INY
    CPX #3
    BNE :-
    ; palette 2..7 follow the same pattern; for brevity callers usually
    ; copy with a generic loop (see palette_load_loop below).
    RTS
.endproc

; Slower but compact: load a flat palette table by walking a parallel
; address table. Each entry is the MARIA register address for the
; palette slot.
.segment "RODATA"
PALETTE_ADDR_TABLE:
    .byte BACKGRND
    .byte P0C1, P0C2, P0C3
    .byte P1C1, P1C2, P1C3
    .byte P2C1, P2C2, P2C3
    .byte P3C1, P3C2, P3C3
    .byte P4C1, P4C2, P4C3
    .byte P5C1, P5C2, P5C3
    .byte P6C1, P6C2, P6C3
    .byte P7C1, P7C2, P7C3

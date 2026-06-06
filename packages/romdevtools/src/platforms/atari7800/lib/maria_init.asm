; ── MARIA boot-time setup ──────────────────────────────────────────
; Call once from your reset handler. Sets up the display list list
; (DLL) pointers, enables DMA, configures a sensible default CTRL.
;
; Requires:  DLL exported by display_list.asm

.include "maria_registers.h"

.proc maria_init
    ; Disable IRQ + initialize stack.
    SEI
    CLD
    LDX #$FF
    TXS

    ; Clear zero page.
    LDA #0
    LDX #0
:   STA $00,X
    INX
    BNE :-

    ; Point DPP (display-list-list pointer) at our DLL table.
    LDA #<DLL_TABLE
    STA DPPL
    LDA #>DLL_TABLE
    STA DPPH

    ; CHARBASE — high byte of character map. Set to where your font
    ; lives in ROM (zero is fine if you're not using character mode).
    LDA #$00
    STA CHARBASE

    ; OFFSET — write 0 unconditionally per the MARIA reference.
    LDA #$00
    STA OFFSET

    ; Set a default background color (luma 0 / hue 0 = black).
    LDA #$00
    STA BACKGRND

    ; Enable DMA, no border, no color-kill, single-byte chars.
    LDA #$40 + CTRL_DMA_OFF     ; wait — set to "no DMA" first, then
    AND #<~CTRL_DMA_OFF         ; clear DMA-off bit to actually enable
    STA CTRL

    RTS
.endproc

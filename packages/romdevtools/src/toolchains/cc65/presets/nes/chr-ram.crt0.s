; Minimal crt0 for NES CHR-RAM mode — replaces cc65's stock crt0 so we
; avoid the .forceimport NESfont (which targets the CHARS segment that
; our chr-ram.cfg removes) AND the ringbuf/ppubuf NMI machinery (which
; presumes the cc65 console subsystem that game code rarely uses).
;
; This is the BARE preset — you write your own NMI handler and OAM
; shadow buffer. For a turnkey runtime that does that for you (and
; matches the nes_runtime.h C API), the build pipeline switches to
; the `chr-ram-runtime` preset automatically when your source
; `#include`s `nes_runtime.h`.
;
; Loaded by linkerConfig:"chr-ram".

        .export         _exit
        .export         __STARTUP__ : absolute = 1

        .import         initlib, donelib, callmain
        .import         _main, zerobss, copydata
        .import         __RAM_START__, __RAM_SIZE__
        .import         __SRAM_START__, __SRAM_SIZE__

; ------------------------------------------------------------------------
; 16-byte iNES header — CHR-RAM (byte 5 = 0).
; If your project supplies its own HEADER segment, delete or override
; these bytes; ld65 lets multiple .segment "HEADER" contributors coexist
; only if their bytes don't overlap, so the project must not also emit
; the 16-byte header.

.segment "HEADER"
        .byte   $4e, $45, $53, $1a   ; "NES" + EOF
        .byte   2                    ; PRG-ROM banks (16K each) → 32K
        .byte   0                    ; CHR-ROM banks (8K each)  → 0 = CHR-RAM
        .byte   %00000001            ; flags6 — vertical mirroring
        .byte   %00000000            ; flags7 — mapper hi nybble
        .byte   0, 0, 0, 0, 0, 0, 0, 0

; ------------------------------------------------------------------------
.segment "STARTUP"

start:
        sei
        cld
        ldx     #$ff
        txs

        ; Wait two VBlanks before touching the PPU (standard NES init).
        lda     #0
        sta     $2000           ; disable NMI
        sta     $2001           ; disable rendering
        sta     $4010           ; disable DMC IRQ
        bit     $2002           ; clear vblank flag

@vbl1:  bit     $2002
        bpl     @vbl1
@vbl2:  bit     $2002
        bpl     @vbl2

        ; Clear BSS + copy DATA (cc65 conventions).
        jsr     zerobss
        jsr     copydata

        ; Set up cc65's C parameter stack pointer.
        lda     #<(__SRAM_START__ + __SRAM_SIZE__)
        ldx     #>(__SRAM_START__ + __SRAM_SIZE__)
        sta     c_sp
        stx     c_sp+1

        jsr     initlib
        jsr     callmain

_exit:  jsr     donelib
        jmp     start

; ------------------------------------------------------------------------
; Default NMI / IRQ — do nothing. To override with your own handler:
;   ; in your own .s file:
;   .export nmi
;   .import _my_c_handler
;   nmi:
;       pha
;       txa
;       pha
;       tya
;       pha
;       jsr _my_c_handler       ; void __fastcall__ my_c_handler(void)
;       pla
;       tay
;       pla
;       tax
;       pla
;       rti
;
;   ; then DELETE the `nmi: rti` line below from this crt0 (or load a
;   ; modified crt0 via your own build({output:'rom'}) sources entry).

.segment "STARTUP"

nmi:    rti
irq:    rti

        .importzp       c_sp

.segment "VECTORS"
        .word   nmi             ; $FFFA
        .word   start           ; $FFFC
        .word   irq             ; $FFFE

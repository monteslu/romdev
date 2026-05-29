;; Game Gear crt0 for SDCC. Byte-identical to sms_crt0.s — GG uses the
;; same Z80 boot model as SMS: same vector table at $0000, same IRQ
;; mode 1 vector at $0038, same NMI at $0066 (the GG's pause-equivalent
;; is the START button on port $00, NOT NMI — but NMI is still vectored
;; for safety).
;;
;; Why this exists separately from sms_crt0.s: every project under
;; createProject({platform:"gg"}) should be self-contained. Cross-
;; platform-by-construction: a `.gg` ROM rebuilds without rom-dev-mcp
;; running. Don't read from sms/lib at build time.
;;
;; Replaces SDCC's stock z80 crt0 (which assumes a host runtime that
;; handles I/O via rst $08 — not what a GG cartridge needs). This one
;; boots cleanly into a real cartridge: vector table at $0000, sets
;; SP to $DFF0, calls main().
;;
;; Use via:
;;   buildSource({
;;     platform: "gg",
;;     sources: {
;;       "main.c": ...,
;;       "gg_crt0.s": ...this file...,
;;     },
;;     crt0: ".module empty\n",  // <-- empty stock crt0
;;   })
;;
;; OR pass the contents of this file as `crt0` to runSdld.

        .module gg_crt0
        .globl  _main
        .globl  l__INITIALIZER
        .globl  s__INITIALIZER
        .globl  s__INITIALIZED

;; ─── Reset vector at $0000 ────────────────────────────────────────
        .area _HEADER (ABS)
        .org    0x0000
        di                          ; interrupts off until we're ready
        im      1                   ; mode 1 — IRQs jump to $0038
        ld      sp, #0xDFF0         ; GG/SMS stack (top of WRAM minus 16)
        jp      gsinit              ; skip the interrupt vector table

;; ─── RST handlers (default = return) ──────────────────────────────
        .org    0x0008
        ret
        .ds     0x08 - 1
        .org    0x0010
        ret
        .ds     0x08 - 1
        .org    0x0018
        ret
        .ds     0x08 - 1
        .org    0x0020
        ret
        .ds     0x08 - 1
        .org    0x0028
        ret
        .ds     0x08 - 1
        .org    0x0030
        ret
        .ds     0x08 - 1

;; ─── IRQ vector at $0038 (IM 1) ───────────────────────────────────
;; GG hits this on vblank IF VDP R1 bit 5 is set. Default = clear the
;; VDP status flag and return. User code that wants a real ISR can
;; install one by writing to (vdp_isr_ptr) and a `ld hl,(vdp_isr_ptr) /
;; jp (hl)` shim — but for now a bare ei/reti keeps things simple.
        .org    0x0038
        push    af
        in      a, (#0xBF)          ; read VDP status — clears IRQ flag
        pop     af
        ei
        reti

;; ─── NMI vector at $0066 ──────────────────────────────────────────
;; GG has no Pause button — START is read from port $00 bit 7 instead.
;; NMI is vectored for safety (some homebrew loaders trigger it).
        .org    0x0066
        retn

;; ─── crt0 body ────────────────────────────────────────────────────
;; Standard SDCC pattern: jump to a code area, run initializers, then
;; call main. The initializer area is filled by sdcc when it sees
;; global initializations.

        .area   _HOME
        .area   _CODE
        .area   _GSINIT
        .area   _GSFINAL

        .area   _DATA
        .area   _INITIALIZED
        .area   _BSEG
        .area   _BSS
        .area   _HEAP

        .area   _CODE

gsinit:
        ld      bc, #l__INITIALIZER
        ld      a, b
        or      a, c
        jr      Z, gsinit_done
        ld      de, #s__INITIALIZED
        ld      hl, #s__INITIALIZER
        ldir

gsinit_done:
        call    _main
hang:
        halt
        jr      hang

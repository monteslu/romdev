;; Game Boy / Game Boy Color crt0 for SDCC.
;;
;; Replaces SDCC's stock sm83 crt0 (designed for a host-runtime that
;; handles I/O via rst $08 — useless on a real cartridge). This one
;; lays out a real cartridge image:
;;
;;   $0000-$0060  reset + interrupt vectors (default = ret/reti)
;;   $0100-$0103  entry point (nop; jp init)
;;   $0104-$014F  cartridge header window — host pipeline patches in
;;                Nintendo logo + checksum after link
;;   $0150+       _CODE segment (the build is configured with
;;                -b _CODE=0x0150 so user code can't pack into the
;;                header window)
;;
;; The host pipeline in src/toolchains/index.js (search "NINTENDO_LOGO")
;; writes the canonical logo bytes + header checksums into the patched
;; output binary.

        .module gb_crt0
        .globl  _main
        .globl  l__INITIALIZER
        .globl  s__INITIALIZER
        .globl  s__INITIALIZED
        .globl  l__INITIALIZED
        .globl  s__DATA
        .globl  l__DATA
        .globl  init

;; ─── Reset vectors at $0000-$0060 ─────────────────────────────────
        .area _HEADER0 (ABS)
        .org    0x0000
        ret

        .area _HEADER1 (ABS)
        .org    0x0008
        ret

        .area _HEADER2 (ABS)
        .org    0x0010
        ret

        .area _HEADER3 (ABS)
        .org    0x0018
        ret

        .area _HEADER4 (ABS)
        .org    0x0020
        ret

        .area _HEADER5 (ABS)
        .org    0x0028
        ret

        .area _HEADER6 (ABS)
        .org    0x0030
        ret

        .area _HEADER7 (ABS)
        .org    0x0038
        ret

;; ─── Interrupt vectors at $0040-$0060 (default = return) ───────────
        .area _HEADER8 (ABS)
        .org    0x0040            ; vblank
        reti

        .area _HEADER9 (ABS)
        .org    0x0048            ; lcd stat
        reti

        .area _HEADERa (ABS)
        .org    0x0050            ; timer
        reti

        .area _HEADERb (ABS)
        .org    0x0058            ; serial
        reti

        .area _HEADERc (ABS)
        .org    0x0060            ; joypad
        reti

;; ─── Entry point at $0100: jump to init ───────────────────────────
        .area _HEADERd (ABS)
        .org    0x0100
        nop
        jp      init

;; ─── Header bytes at $0104-$014F — host pipeline fills most of these ─
;; The logo / title / checksums are patched post-link (rgbfix in the
;; build pipeline, or patch-header.js when rebuilding outside romdev).
;; The CART TYPE and RAM SIZE bytes are DECLARED HERE as real bytes so
;; the build's header fixup can read and preserve them:
;;
;;   $0147 = $03  MBC1 + RAM + BATTERY
;;   $0149 = $02  8 KB external cart RAM at $A000-$BFFF
;;
;; This is what makes battery saves (persistent hi-scores) work: the
;; emulator sizes its SAVE_RAM from these two bytes. The RAM is gated —
;; games must write $0A to $0000-$1FFF before touching $A000 and write
;; $00 after (see the SRAM idiom in the shmup example). Games that never
;; touch $A000 are completely unaffected by the mapper declaration: a
;; 32 KB image fits in MBC1 banks 0-1 exactly as it does in a ROM-only
;; cart, and the MBC registers only react to ROM-area WRITES (which
;; normal code never performs).
;;
;; If you rebuild OUTSIDE romdev, keep these bytes: rgbfix flags are
;; `-m 0x03 -r 0x02` (patch-header.js defaults to ROM-only — pass
;; cartType/ramSize through patchGbHeader() if you script it).
        .area _HEADERe (ABS)
        .org    0x0104
        .ds     0x43            ; $0104-$0146 logo/title/CGB flag/licensee/SGB (patched in)
        .org    0x0147
        .db     0x03            ; $0147 cart type: MBC1+RAM+BATTERY (see above)
        .db     0x00            ; $0148 ROM size (rgbfix -p recomputes)
        .db     0x02            ; $0149 RAM size: 8 KB
        .ds     0x06            ; $014A-$014F dest/licensee/version/checksums (patched in)

;; ─── init: real boot code, lives in _CODE starting at $0150 ────────
        .area   _CODE
init::
        di
        ld      sp, #0xE000             ; top of WRAM
        call    ___sdcc_external_startup
        or      a, a
        call    Z, gsinit
        call    _main
1$:
        halt
        jr      1$

        .area   _HOME
        .area   _INITIALIZER
        .area   _GSINIT
        .area   _GSFINAL

        .area   _DATA
        .area   _INITIALIZED
        .area   _BSEG
        .area   _BSS
        .area   _HEAP

        .area   _GSINIT
gsinit::
        ;; ── Zero the BSS segment (`_DATA`). ──────────────────────────
        ;; Round 27 fix: pre-r55 this loop targeted `s__INITIALIZED` for
        ;; `l__INITIALIZER` bytes — but `_INITIALIZED` is the runtime
        ;; shadow of the `_INITIALIZER` ROM image and gets overwritten
        ;; by the copy loop below anyway, so it was a no-op. The actual
        ;; BSS at `s__DATA..s__DATA+l__DATA` (where every uninitialised
        ;; `static` global in your C lands) was left as power-on WRAM
        ;; garbage. Symptom: `static coin_t coins[4]; ... if (coins[1].active)`
        ;; would spuriously fire at boot because `coins[1].active` was
        ;; some random byte from gambatte's WRAM init pattern.
        ld      hl, #s__DATA
        ld      bc, #l__DATA + 0x0101         ; +1 per byte, +256 per page
        xor     a, a
        jr      gsinit_data_check
gsinit_data_loop:
        ld      (hl+), a
gsinit_data_check:
        dec     c
        jr      NZ, gsinit_data_loop
        dec     b
        jr      NZ, gsinit_data_loop

        ;; ── Copy `_INITIALIZER` (ROM) → `_INITIALIZED` (RAM). ────────
        ;; This is the value-initialised-statics path: `static uint8_t
        ;; lives = 3;` lives in _INITIALIZED at runtime; its initial
        ;; value (the `3`) sits in _INITIALIZER in ROM.
        ld      de, #s__INITIALIZED
        ld      hl, #s__INITIALIZER
        ld      bc, #l__INITIALIZER + 0x0101
        jr      gsinit_init_check
gsinit_init_loop:
        ld      a, (hl+)
        ld      (de), a
        inc     de
gsinit_init_check:
        dec     c
        jr      NZ, gsinit_init_loop
        dec     b
        jr      NZ, gsinit_init_loop
        ret

        .area   _GSFINAL
        ret

;; SMS / Game Gear crt0 for SDCC.
;;
;; Replaces SDCC's stock z80 crt0 (which assumes a host runtime that
;; handles I/O via rst $08 — not what an SMS cartridge needs). This
;; one boots cleanly into a real cartridge: vector table at $0000,
;; standard SMS interrupt vectors, sets SP to $DFF0, calls main().
;;
;; Use via:
;;   build({output:'rom'})({
;;     platform: "sms",
;;     sources: {
;;       "main.c": ...,
;;       "sms_crt0.s": ...this file...,
;;     },
;;     crt0: ".module empty\n",  // <-- empty stock crt0
;;   })
;;
;; OR pass the contents of this file as `crt0` to runSdld.

        .module sms_crt0
        .globl  _main
        .globl  l__INITIALIZER
        .globl  s__INITIALIZER
        .globl  s__INITIALIZED
        .globl  s__DATA
        .globl  l__DATA

;; ─── Reset vector at $0000 ────────────────────────────────────────
        .area _HEADER (ABS)
        .org    0x0000
        ;; ONLY 8 BYTES fit before the RST $08 vector. The old block here
        ;; (di/im 1/ld sp/jp = 9 bytes) overflowed into .org 0x0008, whose
        ;; `ret` stomped the jp's high target byte -> boot jumped into
        ;; garbage. di+im 1+jp = 6 bytes; SP setup moved to _boot below.
        di                          ; interrupts off until we're ready
        im      1                   ; mode 1 — IRQs jump to $0038
        jp      _boot               ; continue past the vector table

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
;; SMS hits this on vblank IF VDP R1 bit 5 is set. Default = clear the
;; VDP status flag and return. User code that wants a real ISR can
;; install one by writing to (vdp_isr_ptr) and a `ld hl,(vdp_isr_ptr) /
;; jp (hl)` shim — but for now a bare ei/reti keeps things simple.
        .org    0x0038
        push    af
        in      a, (#0xBF)          ; read VDP status — clears IRQ flag
        pop     af
        ei
        reti

;; ─── NMI vector at $0066 (Pause button on SMS) ────────────────────
        .org    0x0066
        retn

;; ─── Boot continuation (right after the NMI vector) ───────────────
;; SP first, then the C runtime init. Lives in the ABS header area so
;; it exists at a known address regardless of where _CODE is linked
;; (_CODE must start at >= $0100 so it can't overwrite this table).
        .org    0x0068
_boot:
        ld      sp, #0xDFF0         ; stack at top of WRAM minus 16
        jp      gsinit

;; ─── crt0 body ────────────────────────────────────────────────────
;; Standard SDCC pattern: jump to a code area, run initializers, then
;; call main. The initializer area is filled by sdcc when it sees
;; global initializations.

        ;; AREA ORDERING IS LOad-BEARING. `_INITIALIZER` (the ROM image of
        ;; every value-initialised `static` global) MUST be declared in the
        ;; ROM group here — BEFORE the `_DATA` RAM block. If it isn't, sdld
        ;; places `_INITIALIZER` in RAM right after `_INITIALIZED`, so the
        ;; gsinit copy below copies uninitialised RAM onto itself and every
        ;; `static uint8_t x = 5;` boots as 0. (Bug found 2026-06-08: a GBC
        ;; Columns agent's `static uint32_t rng = 0x1357;` booted as 0, so
        ;; the xorshift PRNG stayed 0 and every "random" roll came out the
        ;; same — a "monochrome RNG" that looked like an SDCC codegen bug
        ;; but was really this missing ROM placement. The sm83 GB crt0 has
        ;; always placed _INITIALIZER in ROM; the z80 crt0s never did.)
        .area   _HOME
        .area   _INITIALIZER
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
        ;; ── Zero the BSS segment (`_DATA`). ──────────────────────────
        ;; Every uninitialised `static` global lands in `_DATA` and MUST
        ;; read back 0 at boot. Without this, `static uint8_t flag;` boots
        ;; with whatever power-on WRAM byte was there (gambatte/gpgx leave
        ;; garbage), and `if (flag)` spuriously fires. Mirrors the sm83 GB
        ;; crt0's gsinit_data loop.
        ld      bc, #l__DATA
        ld      a, b
        or      a, c
        jr      Z, gsinit_bss_done
        ld      hl, #s__DATA
        ld      (hl), #0x00
        ld      d, h
        ld      e, l
        inc     de
        dec     bc
        ld      a, b
        or      a, c
        jr      Z, gsinit_bss_done
        ldir                            ; propagate the 0 across _DATA
gsinit_bss_done:

        ;; ── Copy `_INITIALIZER` (ROM) → `_INITIALIZED` (RAM). ────────
        ;; The value-initialised-statics path: `static uint8_t lives = 3;`
        ;; lives in _INITIALIZED at runtime; its initial value sits in
        ;; _INITIALIZER in ROM (now correctly ROM-placed, see above).
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

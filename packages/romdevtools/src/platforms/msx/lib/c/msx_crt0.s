;; MSX / MSX2 cartridge crt0 for SDCC (z80 port).
;;
;; An MSX ROM cartridge maps at $4000-$BFFF. The first 16 bytes are the ROM
;; header the BIOS scans on boot:
;;   $4000: "AB"  (0x41 0x42)  — the cartridge magic
;;   $4002: INIT  pointer       — the BIOS CALLs this (with a valid stack) to
;;                                start the cartridge program
;;   $4004: STATEMENT  ptr      — BASIC CALL handler (0 = none)
;;   $4006: DEVICE     ptr      — expansion-device handler (0 = none)
;;   $4008: TEXT       ptr      — BASIC program text (0 = none)
;;   $400A..$400F: reserved (0)
;;
;; Replaces SDCC's stock z80 crt0 (which is a CP/M-style $0000 runtime that
;; talks to a host via rst $08 — wrong for a cartridge). This one emits the
;; header, runs the SDCC global-initializer pass, calls main(), then RETs back
;; to the BIOS (the BIOS gave us the stack, so we don't touch SP).
;;
;; Build it as the FIRST object so its _HEADER area lands at $4000. romdev links
;; _CODE at $4010; this header occupies $4000-$400F. Pass via:
;;   build({output:'rom'})({ platform:"msx", sources:{ "main.c":..., "msx_crt0.s":<this> },
;;                 crt0: ".module empty\n" })   // empty stock crt0
;;
;; C-BIOS shows its logo for ~2-3s, THEN CALLs INIT — step >= 240 frames before
;; expecting the cart's output on screen.

        .module msx_crt0
        .globl  _main
        .globl  l__INITIALIZER
        .globl  s__INITIALIZER
        .globl  s__DATA
        .globl  l__DATA
        .globl  s__INITIALIZED

;; ─── Cartridge ROM header at $4000 ────────────────────────────────
        .area   _HEADER (ABS)
        .org    0x4000
        .db     0x41, 0x42          ; "AB" — cartridge magic
        .dw     init                ; INIT  — BIOS calls this to start us
        .dw     0x0000              ; STATEMENT (none)
        .dw     0x0000              ; DEVICE (none)
        .dw     0x0000              ; TEXT (none)
        .dw     0x0000              ; reserved
        .dw     0x0000              ; reserved
        .dw     0x0000              ; reserved

;; ─── crt0 body ────────────────────────────────────────────────────
;; Standard SDCC area order so the linker fills _GSINIT with the global
;; initializer fragments sdcc emits, then _GSFINAL.
        ;; AREA ORDERING IS LOAD-BEARING (same bug class fixed in the SMS/GG
        ;; crt0s 2026-06-08): `_INITIALIZER` (the ROM image of every value-
        ;; initialised static) MUST be declared in the ROM group — otherwise
        ;; sdld places it in RAM after `_INITIALIZED` and the init copy below
        ;; copies uninitialised RAM onto itself, so every `static x = N;`
        ;; boots as 0. On MSX that silenced ALL scaffold audio (the PSG
        ;; music/sfx state booted zeroed) among other ghosts.
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

;; INIT entry — the BIOS CALLs here with interrupts on and a valid stack.
init:
        ;; ── Zero the BSS segment (`_DATA`) ── every uninitialised static
        ;; must read back 0 at boot (power-on RAM is garbage).
        ld      bc, #l__DATA
        ld      a, b
        or      a, c
        jr      Z, bss_done
        ld      hl, #s__DATA
        ld      (hl), #0x00
        ld      d, h
        ld      e, l
        inc     de
        dec     bc
        ld      a, b
        or      a, c
        jr      Z, bss_done
        ldir
bss_done:
        ;; Copy initialized-data image from ROM to RAM (SDCC global inits).
        ld      bc, #l__INITIALIZER
        ld      a, b
        or      a, c
        jr      Z, gsinit_done
        ld      de, #s__INITIALIZED
        ld      hl, #s__INITIALIZER
        ldir
gsinit_done:
        call    _main
        ;; Return to the BIOS (it set up the stack and CALLed INIT). A cart that
        ;; never returns just loops in main(); returning hands control back.
        ret

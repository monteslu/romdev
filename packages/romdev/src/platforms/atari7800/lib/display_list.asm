; ── Minimal MARIA display list + DLL ───────────────────────────────
; Two-zone DLL:
;   Zone 0: 184 scanlines, uses DL_main.
;   Zone 1: end-of-frame marker.
;
; Each DLL entry is 3 bytes:
;   byte 0 = (offset-count << 0) | bit 7 = DLI request | bit 6 = "holey"
;   byte 1 = DL high
;   byte 2 = DL low
;
; The "offset" field is the count of extra scanlines minus 1; a value
; of $80 + N draws N+1 scanlines and triggers a DLI on the last.

.include "maria_registers.h"

.export DLL_TABLE
.export DL_main

.segment "DATA"

DLL_TABLE:
    .byte $80 + 183,   >DL_main, <DL_main   ; 184 visible scanlines
    .byte 0,           0, 0                  ; end-of-DLL marker

; A display list is a list of "header" entries; each describes one
; sprite/character block to draw on the zone's scanlines.
;
; 5-byte header form (bit 7 of byte 2 = 1):
;   byte 0 = data address low
;   byte 1 = mode/control:
;            bit 7 = "write" (use 5-byte form)
;            bit 6 = "ind"   (indirect — use CHARBASE)
;            bits 0-4 = width count (0 = 32 bytes wide, 1 = 31, ..., 31 = 1)
;   byte 2 = data address high
;   byte 3 = palette (bits 5-7) | horizontal position bits 4-0 reserved
;   byte 4 = horizontal position (X)
;
; End-of-DL is a single $00 byte.

DL_main:
    ; sprite data low/high points at SPRITE_DATA below.
    .byte <SPRITE_DATA
    .byte $80 | 16      ; write-bit set, width = 16 bytes (32 - 16)
    .byte >SPRITE_DATA
    .byte $00           ; palette 0
    .byte 50            ; X = 50
    .byte 0             ; end-of-DL

SPRITE_DATA:
    ; 16 bytes (32 pixels wide at 2bpp) of solid color-1 stripe
    .repeat 16
        .byte $55
    .endrepeat

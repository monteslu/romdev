; SMS palette loader.
;
; CRAM has 32 entries (16 BG + 16 sprite), one byte each. Entry layout:
;   bits 0-1 = R (2 bits)
;   bits 2-3 = G
;   bits 4-5 = B
;
; To write CRAM:
;   1. Set the VDP address to CRAM via control port:
;        send word (cram_offset | $C000) — the $C000 prefix tells the VDP
;        "the next data-port write goes to CRAM at this address".
;        Use $4000 prefix for VRAM writes instead.
;   2. Write each color byte to VDP_DATA ($BE). Auto-increments the
;      address pointer.
;
; CALLING: HL → 32-byte palette table; entry 0 written first.

VDP_DATA equ $BE
VDP_CTRL equ $BF

load_palette:
        ld a,$00                 ; LOW byte of CRAM dest addr ($0000)
        out (VDP_CTRL),a
        ld a,$C0                 ; HIGH byte: $C0 = CRAM write
        out (VDP_CTRL),a

        ld b,32                  ; 32 entries (16 BG + 16 sprite)
        ld c,VDP_DATA
        otir                     ; (HL)+ → out (C); B--; loop until B=0
        ret

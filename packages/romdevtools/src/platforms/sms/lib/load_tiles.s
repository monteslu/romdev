; SMS tile loader — VRAM upload.
;
; SMS tiles are 32 bytes each (4bpp interleaved). VRAM is 16 KB at
; $0000-$3FFF. Tile N lives at VRAM offset (N * 32).
;
; To write VRAM:
;   1. Set VDP address: low byte first, then (high | $40) — the $40
;      prefix in the high byte signals VRAM write.
;   2. Write bytes to VDP_DATA — auto-increments.
;
; CALLING:
;   HL  → source bytes
;   BC  → byte count (= tileCount * 32)
;   DE  → VRAM destination (e.g. $2000 = tile 256)
; CLOBBERS: A, BC, HL, DE.

VDP_DATA equ $BE
VDP_CTRL equ $BF

load_tiles:
        ; Set VDP address: low(e), high(d) | $40
        ld a,e
        out (VDP_CTRL),a
        ld a,d
        or $40
        out (VDP_CTRL),a

        ; Bulk copy. OTIR transfers 1 byte at a time and loops on B until
        ; B reaches 0, so we have to outer-loop over C.
        ld d,c                   ; D = high-byte page count
        inc d                    ; INC because OTIR-then-test-B-zero needs round-up
        ld a,b
        or a
        jr nz,_lt_page

_lt_check_partial:
        ld a,c
        or a
        ret z                    ; nothing left
        ld b,c
        ld c,VDP_DATA
        otir
        ret

_lt_page:
        ld c,VDP_DATA
        otir                     ; one full 256-byte page
        ld c,VDP_DATA            ; restore C
        djnz _lt_page            ; B was decremented
        jr _lt_check_partial

; SMS sprite attribute table (SAT) — populate from shadow OAM.
;
; SAT lives at VRAM $3F00 by default (set via VDP R5). Layout:
;   $00-$3F:  64 Y bytes. $D0 in any slot = terminator (VDP stops rendering).
;   $80-$FF:  64 (X, tile) pairs.
;
; Strategy: keep shadow OAM in WRAM (256 bytes), update it during your
; game logic, then DMA-copy to VRAM once per vblank.
;
; CALLING: HL → shadow OAM bytes (256 bytes); writes Y entries 0-63 to
; VRAM $3F00 then X/tile pairs to VRAM $3F80.

VDP_DATA equ $BE
VDP_CTRL equ $BF

sat_upload:
        ; Write Y bytes (slots 0-63 = first 64 bytes of shadow).
        ld a,$00                 ; VRAM offset $3F00 low
        out (VDP_CTRL),a
        ld a,$3F | $40           ; $3F | $40 = VRAM write
        out (VDP_CTRL),a
        ld b,64
        ld c,VDP_DATA
        otir

        ; Write (X, tile) pairs to $3F80.
        ld a,$80
        out (VDP_CTRL),a
        ld a,$3F | $40
        out (VDP_CTRL),a
        ld b,128                 ; 64 sprites × 2 bytes
        ld c,VDP_DATA
        otir
        ret

; To set sprite N's position to (x, y) and tile T from your game code:
;   ld a,y      ; shadow_oam + N
;   ld (shadow_oam + N),a
;   ld a,x      ; shadow_oam + 0x80 + N*2
;   ld (shadow_oam + 0x80 + N*2),a
;   ld a,t
;   ld (shadow_oam + 0x80 + N*2 + 1),a
;
; To hide all sprites (init): fill shadow_oam[0..63] with $D0.

; oam_spr, hand-written.
;
; cc65 compiled the four-byte C body into ~80 instructions and 16 subroutine
; calls per sprite: for EVERY byte it recomputed a 16-bit address (clc/adc/
; tay/txa/adc/tax), pushed it (jsr pushax) and stored through an indirect
; pointer (jsr staspidx). At 23 sprites that ate the whole frame and the game
; ran at 29fps. shadow_oam sits at a fixed address and oam_index is a byte, so
; absolute-indexed addressing does the same work in four stores.
;
; ABI (read off cc65's own output for this exact signature):
;   void oam_spr(uint8_t x, uint8_t y, uint8_t tile, uint8_t attr)
; The caller pushes x, y, tile; `attr` arrives in A (fastcall). Relative to sp
; on entry:  +0 = tile, +1 = y, +2 = x.  The callee pops the three pushed
; bytes -- cc65 does that with `ldy #3; jmp addysp`.

        .export         _oam_spr
        .import         _shadow_oam, _oam_index
        .import         addysp
        .importzp       sp

        .segment "CODE"

_oam_spr:
        ldx     _oam_index      ; X = byte offset of this slot
        sta     _shadow_oam+2,x ; attr, straight from A

        ldy     #1              ; y -> shadow_oam[i+0], less 1 for the PPU's
        lda     (sp),y          ;      off-by-one scanline convention
        sec
        sbc     #1
        sta     _shadow_oam,x

        ldy     #0              ; tile -> shadow_oam[i+1]
        lda     (sp),y
        sta     _shadow_oam+1,x

        ldy     #2              ; x -> shadow_oam[i+3]
        lda     (sp),y
        sta     _shadow_oam+3,x

        txa                     ; oam_index += 4 (wraps at 256, as before)
        clc
        adc     #4
        sta     _oam_index

        ldy     #3              ; drop the three pushed arguments
        jmp     addysp

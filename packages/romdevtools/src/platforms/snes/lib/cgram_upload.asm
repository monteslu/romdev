; SNES — CGRAM (palette RAM) upload.
;
; CGRAM is 512 bytes = 256 colors × 2 bytes BGR555 little-endian.
; Layout: byte 0 is the universal backdrop. Bytes 0..15 = BG palette 0
; (for 4bpp: 16 colors; for 2bpp: 4 sub-palettes of 4 colors each).
; Bytes 128..255 are the OBJ palettes (8 palettes × 16 colors in 4bpp).
;
; Color encoding: BGR555 little-endian. Each color is 2 bytes.
;   low  byte = GGGRRRRR  (bits 0-4 R, 5-7 low bits of G)
;   high byte = .BBBBBGG  (bits 0-1 high bits of G, 2-6 B, bit 7 unused)
; To pack from 8-bit RGB:
;   r5 = R >> 3
;   g5 = G >> 3
;   b5 = B >> 3
;   word = (b5 << 10) | (g5 << 5) | r5
;
; Example: write 16 BG colors from a table at `bg_palette_data`:
;
;   stz $2121           ; CGADD — start at CGRAM index 0
;   ldx #$0000
; .loop:
;   lda bg_palette_data, x
;   sta $2122           ; CGDATA — write byte; pair counts as one color
;   inx
;   cpx #(bg_palette_end-bg_palette_data)
;   bne .loop
;
; For OBJ palettes start at CGADD=$80 (= color index 128).
;
; DMA alternative (faster for big palettes):
;   stz $2121           ; CGADD = 0
;   lda #$00            ; mode 0: 1 byte to one register
;   sta $4300
;   lda #$22            ; B-bus = $2122 (CGDATA)
;   sta $4301
;   ldx #bg_palette_data
;   stx $4302
;   lda #bg_palette_data>>16
;   sta $4304
;   ldx #(bg_palette_end-bg_palette_data)
;   stx $4305
;   lda #$01
;   sta $420B

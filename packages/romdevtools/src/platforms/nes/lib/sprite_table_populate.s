; NES — populating the OAM sprite table.
;
; OAM is 256 bytes: 64 sprites × 4 bytes each.
;   byte 0: Y position (NOTE: stored as actual_y - 1; e.g. y=$10 means
;           the sprite's top edge is at scanline $11)
;   byte 1: tile number (0..255; PPUCTRL bit 3 picks tile bank for 8x8
;           mode; for 8x16 mode, bit 0 of the tile number picks the
;           bank and bits 1-7 are the tile index *2)
;   byte 2: attribute  — vhpxxxpp
;            bit 7: V flip
;            bit 6: H flip
;            bit 5: behind background (0 = in front)
;            bits 0-1: palette (0..3 selects sprite palette 0..3)
;   byte 3: X position
;
; Gotchas:
;   • Y = $EF (239) or higher hides the sprite — the PPU treats it as
;     "off screen". So unused sprite slots are conventionally set to
;     Y=$FF to hide them.
;   • Tile bank for 8x8 sprites is global (PPUCTRL bit 3) and CAN'T be
;     per-sprite. For 8x16 mode (PPUCTRL bit 5), the tile byte's bit 0
;     selects the bank per sprite instead — strange but powerful.
;   • OAM can only be written via $2003/$2004 (slow, one byte at a
;     time) or via DMA from a page-aligned RAM buffer (256 bytes
;     in 513 cycles). ALWAYS use DMA in real code.
;   • The OAM DMA source MUST be page-aligned (high byte is the page,
;     low byte starts at $00). Convention: put soft OAM at $0200.

; ---- soft OAM in RAM (page-aligned at $0200) ----
SOFT_OAM = $0200

; ---- example: write sprite N at (x, y) tile T attr A ----
; Inputs:
;   A = slot (0..63)
;   x_pos, y_pos, tile_num, attr in zeropage (set by caller)

.proc write_sprite
  asl
  asl                       ; A = slot * 4 = byte offset
  tax                       ; X = byte offset
  lda y_pos
  sta SOFT_OAM, x
  lda tile_num
  sta SOFT_OAM + 1, x
  lda attr
  sta SOFT_OAM + 2, x
  lda x_pos
  sta SOFT_OAM + 3, x
  rts
.endproc

; ---- hide all sprites: set every Y to $FF ----
.proc clear_oam
  ldx #0
  lda #$FF
@loop:
  sta SOFT_OAM, x
  inx
  inx
  inx
  inx                       ; skip to next sprite's Y byte
  bne @loop
  rts
.endproc

; ---- OAM DMA: run this at the START of vblank, NOT in the NMI body ----
; Writing $2003=$00 then $4014=$02 copies 256 bytes from $0200-$02FF
; to OAM[$00..$FF]. Takes 513 CPU cycles (~1 scanline).
.proc oam_dma
  lda #$00
  sta $2003                 ; OAMADDR = 0
  lda #$02                  ; page $02 = $0200
  sta $4014                 ; trigger DMA
  rts
.endproc

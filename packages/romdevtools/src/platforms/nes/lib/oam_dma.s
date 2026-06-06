; NES — copy 256-byte shadow OAM at $0200 to the PPU via DMA.
;
; Call this inside your NMI handler. It transfers all 64 sprites' attributes
; in ~513 cycles, which is the only fast way to update sprites without
; tearing.
;
; The shadow OAM is at $0200-$02FF by convention; that's the page we tell
; the DMA register $4014 to copy from (just write the high byte).

.proc oam_dma
  lda #0
  sta $2003       ; set OAM address to start
  lda #$02
  sta $4014       ; trigger DMA from page $02
  rts
.endproc

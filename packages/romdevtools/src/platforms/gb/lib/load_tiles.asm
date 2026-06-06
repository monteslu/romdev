; Game Boy tile loader — bulk VRAM upload from ROM.
;
; GB tiles are 16 bytes each (2bpp interleaved). VRAM at $8000-$97FF
; holds 384 tiles. The PPU is reading tiles continuously while the
; LCD is on — writes during active scanlines are IGNORED by the bus.
; You can only safely write VRAM during:
;   - vblank (LY >= 144)
;   - hblank (PPU mode 0, very short)
;   - LCD off (R1 bit 7 = 0)
;
; The simplest pattern is: turn LCD off for big uploads. The example
; below assumes display is OFF (caller responsibility). For runtime
; uploads during gameplay, queue them and DMA in vblank.
;
; CALLING:
;   HL = source bytes (ROM)
;   DE = VRAM destination ($8000-$97FF range)
;   BC = byte count (= tile_count * 16)

load_tiles::
.loop
  ld a, [hl+]
  ld [de], a
  inc de
  dec bc
  ld a, b
  or c
  jr nz, .loop
  ret

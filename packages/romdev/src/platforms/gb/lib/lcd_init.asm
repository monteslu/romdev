; Game Boy LCD initialization.
;
; The LCD must be ON before sprites/BG draw, but you can't write VRAM
; while it's on (PPU steals the bus). Typical init sequence:
;
;   1. Turn LCD OFF ($FF40 = 0)
;   2. Upload tiles, name map, palettes
;   3. Set LCDC to enable display + the layers you want
;
; LCDC bits (write to $FF40):
;   0: BG/Window display (1 = on)
;   1: Sprites display (1 = on)
;   2: Sprite size (0 = 8x8, 1 = 8x16)
;   3: BG tile map (0 = $9800, 1 = $9C00)
;   4: BG tile data (0 = $8800 signed, 1 = $8000 unsigned)
;   5: Window display (1 = on)
;   6: Window tile map (0 = $9800, 1 = $9C00)
;   7: LCD enable
;
; Standard "BG + sprites, $8000 data, $9800 map" = %10010011 = $93

lcd_off::
  ld a, [$FF40]
  bit 7, a
  ret z               ; already off
  ; Wait for vblank before turning off — turning off mid-frame can
  ; damage real DMG hardware (rare but documented).
.wait
  ld a, [$FF44]
  cp 144
  jr c, .wait
  xor a
  ldh [$40], a        ; LCDC = 0 — LCD off
  ret

lcd_on_bg_sprites::
  ld a, %10010011     ; LCD + BG + sprites, $8000 tiles, $9800 BG map
  ldh [$40], a
  ret

lcd_on_bg_only::
  ld a, %10010001     ; LCD + BG (no sprites)
  ldh [$40], a
  ret

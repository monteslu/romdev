; Game Boy palette setup.
;
; DMG palettes are 1-byte registers — 4 × 2-bit shade indices packed
; into one byte. The shade map is hardware: 0=lightest, 3=darkest.
;
;   $FF47 = BGP  — background palette
;   $FF48 = OBP0 — sprite palette 0 (used when OAM attr bit 4 = 0)
;   $FF49 = OBP1 — sprite palette 1 (used when OAM attr bit 4 = 1)
;
; Byte layout: bits 0-1 = color 0, bits 2-3 = color 1, etc.
; Standard "0=white, 3=black" mapping is %11_10_01_00 = $E4.
; Sprite color 0 is ALWAYS transparent — its slot in OBP doesn't matter.
;
; CGB palette is different — write to $FF68 (BCPS) to set index +
; auto-increment, then write 64 bytes (8 palettes × 4 colors × 2 BGR555)
; to $FF69 (BCPD). See load_palette_gbc.asm for the GBC variant.

load_palette_dmg::
  ld a, $E4           ; 11 10 01 00 — white/lt-gray/dk-gray/black
  ldh [$47], a        ; BGP
  ld a, $1B           ; 00 01 10 11 — invert for OBP0 (just as an example)
  ldh [$48], a        ; OBP0
  ld a, $E4
  ldh [$49], a        ; OBP1
  ret

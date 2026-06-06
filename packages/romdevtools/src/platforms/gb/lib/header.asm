; Game Boy / Game Boy Color cartridge header.
;
; The boot ROM verifies the Nintendo logo bytes at $0104-$0133 and the
; header checksum at $014D before handing off to $0150 — if either
; doesn't match, the boot ROM hangs the console (locks up at the logo).
;
; rgbasm tip: use `rgbfix -v -p 0` after building to auto-compute the
; header checksum + ROM size byte. Doing it by hand is tedious and
; usually wrong; let the tool fix it.
;
;     rgbfix -v -p 0 -m MBC1 -t "MYGAME" out.gb
;
; This snippet provides the structural layout; rgbfix fills in the
; computed fields.

SECTION "Header", ROM0[$0100]

  ; $0100-$0103: entry point — 4 bytes. Conventional pattern is nop+jp.
  nop
  jp Start

  ; $0104-$0133: Nintendo logo bytes — DO NOT change. rgbfix injects.
  ds $30, 0

  ; $0134-$0143: 16-byte title (uppercase ASCII). rgbfix sets via -t.
  ds $10, 0

  ; $0144-$0145: licensee code (new-style 2-char ASCII).
  db "00"

  ; $0146: SGB flag — 0x00 = no SGB features, 0x03 = SGB.
  db $00

  ; $0147: cartridge type. rgbfix -m MBC1 / -m MBC5 / -m ROM_ONLY etc.
  db $00

  ; $0148: ROM size. rgbfix computes from final ROM size.
  db $00

  ; $0149: RAM size. 0=none, 1=2KB, 2=8KB, 3=32KB (4 banks), etc.
  db $00

  ; $014A: destination code. 0=Japan, 1=non-Japan.
  db $01

  ; $014B: old-style licensee code. $33 = use new code at $0144.
  db $33

  ; $014C: ROM version.
  db $00

  ; $014D: header checksum. rgbfix -v fills this in (sum of $0134-$014C).
  db $00

  ; $014E-$014F: global cart checksum. rgbfix -v fills this in.
  dw $0000

; SMS / Game Gear ROM header (TMR SEGA).
;
; Lives at $7FF0-$7FFF (last 16 bytes of bank 0). The BIOS verifies this
; on power-on; without it, real hardware refuses to boot. Most emulators
; (gpgx included) tolerate its absence, but ship the header anyway so
; your ROM runs on real cartridges.
;
; Layout:
;   $7FF0..$7FF7  "TMR SEGA"           — magic string
;   $7FF8..$7FF9  reserved             — 0x00 0x00
;   $7FFA..$7FFB  checksum (LE word)   — sum of bytes $0000-$7FEF
;   $7FFC..$7FFE  product code         — 5 nibbles BCD (low at $7FFC,
;                                         high nibble of $7FFE = high digit)
;   $7FFE high   version               — 4-bit revision number
;   $7FFF        region | rom_size     — bits 7-4 = region, bits 3-0 = size
;
; Region codes:
;   3 = SMS Japan, 4 = SMS Export, 5 = GG Japan, 6 = GG Export, 7 = GG Int'l
; ROM size codes (relevant for ≥32KB carts):
;   $a = 8KB, $b = 16KB, $c = 32KB, $d = 48KB (rare),
;   $e = 64KB, $f = 128KB, $0 = 256KB, $1 = 512KB

        .org $7FF0
        .ascii "TMR SEGA"
        .db $00, $00
        ; Checksum slot — most assemblers won't compute this for you;
        ; either patch it post-build (sums of bytes $0000-$7FEF) or use
        ; the BIOS-skip approach (most emulators don't enforce).
        .db $00, $00
        ; Product code (placeholder: 00001)
        .db $01, $00, $00
        ; Region (4 = SMS Export) and rom size ($c = 32 KB).
        .db $4C

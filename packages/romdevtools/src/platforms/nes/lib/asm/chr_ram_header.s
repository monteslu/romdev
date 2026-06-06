; chr_ram_header.s — replace cc65's default HEADER + skip the NESfont
; CHARS bundle, so the cart boots in CHR-RAM mode.
;
; USE WITH: build({output:'rom'})({platform:"nes", linkerConfig:"chr-ram", ...})
;   That preset's nes/chr-ram.cfg drops the ROM2/CHARS memory region.
;   Without this header file, the link would fail because the stock
;   crt0.s emits its own HEADER (chr=1) AND .forceimport NESfont (which
;   targets the now-missing CHARS segment).
;
; Add this file to your `sources` (or `includes` if you use .include
; from another .s). The .segment "HEADER" here replaces the stock
; HEADER emission. Pair it with a custom crt0 if you also need to drop
; the NESfont — for the simplest path, just don't include any cc65 lib
; routines that touch CHARS (printf/conio family) and the unused font
; gets DCE'd out by ld65.

.segment "HEADER"
    .byte $4E, $45, $53, $1A    ; iNES magic "NES" + EOF
    .byte 2                      ; PRG-ROM banks (×16K)  → 32K total
    .byte 0                      ; CHR-ROM banks (×8K)   → 0 means CHR-RAM
    .byte $00                    ; flags6 (mirroring=horizontal, mapper lo=0)
    .byte $00                    ; flags7 (mapper hi=0)  → NROM
    .byte 0, 0, 0, 0, 0, 0, 0, 0 ; pad to 16 bytes

; ----------------------------------------------------------------------
; OPTIONAL: tiny helper to write a CHR tile from C / asm into PPU $0000+.
; Call: lda #<tile_data : sta src : lda #>tile_data : sta src+1 : jsr write_chr
; Or for cc65 C: extern void __fastcall__ write_chr(unsigned tile_idx, const unsigned char *data);
;
; Most projects don't need this — they write CHR inline with their own
; PPUADDR/PPUDATA setup. Including for reference.
; ----------------------------------------------------------------------

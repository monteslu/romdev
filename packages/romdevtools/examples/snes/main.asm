; Hello, SNES — a real hello-world scaffold for asar.
;
; What this does:
;   1. Standard SNES reset (sei, clc xce → native mode, stack at $1FFF).
;   2. Uploads a single CGRAM color (bright blue) so you see a colored
;      backdrop — proof your build is running. NOT just a black screen.
;   3. Turns on the screen at full brightness, then parks forever.
;
; SUFFICIENT FOR: confirming your toolchain works + your user has
; something to see in playtest. To go further (load tiles, set up BGs,
; sprites, sound, vblank handler) see src/platforms/snes/lib/* snippets:
;
;   listStarterSnippets({platform:"snes"})
;
; The key snippets are:
;   - lorom_header.asm: full SNES header (this scaffold's is minimal)
;   - cgram_upload.asm: palette upload boilerplate
;   - vram_dma_upload.asm: fast tile/map uploads
;   - oam_upload.asm: sprite table writes
;   - nmi_safe.asm: vblank handler skeleton
;
; BUILD: complete LoROM image, no extra options needed.
;   build({ output: "rom",  platform: "snes", source: /* this file */ });

lorom

INIDISP  = $2100   ; screen brightness / forced blank
NMITIMEN = $4200
CGADD    = $2121
CGDATA   = $2122

; -----------------------------------------------------------------------
org $008000
START:
        sei
        clc
        xce             ; → native 65816 mode
        rep #$30        ; A/X/Y = 16-bit
        ldx #$1FFF
        txs             ; stack at $1FFF
        sep #$20        ; A = 8-bit

        ; Blank screen during init.
        lda #$80
        sta INIDISP

        ; Disable interrupts.
        stz NMITIMEN

        ; Upload one color to CGRAM[0] (the backdrop / transparency color).
        ; BGR-555 little-endian. $7C00 = bright blue.
        stz CGADD
        lda #$00
        sta CGDATA
        lda #$7C
        sta CGDATA

        ; Enable screen at full brightness (bit 7 = 0 to disable forced
        ; blank; low nybble = brightness 0..15).
        lda #$0F
        sta INIDISP

LOOP:
        bra LOOP

; -----------------------------------------------------------------------
; Emulation-mode reset vector (used at boot, before `xce` flips to native).
; asar's `lorom` directive handles header + rest of vector table padding.
org $00FFFC
        dw START

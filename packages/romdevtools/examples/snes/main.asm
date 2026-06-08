; Hello, SNES — a real hello-world scaffold for asar.
;
; What this does:
;   1. Standard SNES reset (sei, clc xce → native mode, stack at $1FFF).
;   2. Uploads a 4-colour palette + two 2bpp tiles to VRAM via DMA.
;   3. Fills a 32x32 BG1 tilemap with a checkerboard of those two tiles
;      so the whole screen shows a real tiled pattern — NOT a flat one-
;      colour backdrop (which reads as "blank" to a human / the verifier).
;   4. Points BG1 at the tile + map bases, enables BG1, turns the screen
;      on at full brightness, then parks forever.
;
; SUFFICIENT FOR: confirming your toolchain works AND showing your user a
; real rendered screen in playtest. To go further (sprites, scrolling,
; sound, a vblank handler) see src/platforms/snes/lib/* snippets:
;
;   listStarterSnippets({platform:"snes"})
;
; The key snippets are:
;   - lorom_header.asm: full SNES header (this scaffold's is minimal)
;   - cgram_upload.asm: palette upload boilerplate
;   - vram_dma_upload.asm: fast tile/map uploads (used below)
;   - oam_upload.asm: sprite table writes
;   - nmi_safe.asm: vblank handler skeleton
;
; BUILD: complete LoROM image, no extra options needed.
;   build({ output: "run",  platform: "snes", source: /* this file */ });

lorom

; ── PPU / DMA registers ────────────────────────────────────────────────
INIDISP  = $2100   ; screen brightness / forced blank
BGMODE   = $2105   ; BG mode + tile-size
BG1SC    = $2107   ; BG1 tilemap base + size
BG12NBA  = $210B   ; BG1/BG2 character (tile) base
TM       = $212C   ; main-screen layer enable
NMITIMEN = $4200
CGADD    = $2121
CGDATA   = $2122
VMAIN    = $2115   ; VRAM address increment mode
VMADDL   = $2116   ; VRAM word address (16-bit)
VMDATAL  = $2118   ; VRAM data port (low)
DMAP0    = $4300   ; DMA0 control
BBAD0    = $4301   ; DMA0 B-bus address
A1T0L    = $4302   ; DMA0 source address (16-bit)
A1B0     = $4304   ; DMA0 source bank
DAS0L    = $4305   ; DMA0 byte count (16-bit)
MDMAEN   = $420B   ; DMA enable

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

        ; Blank screen during init; disable NMI/HDMA.
        lda #$80
        sta INIDISP
        stz NMITIMEN

        ; ── Palette → CGRAM ───────────────────────────────────────────
        ; 4 colours (2bpp): 0 = blue backdrop, 1 = white, 2 = green,
        ; 3 = magenta. BGR-555, little-endian (low byte then high byte).
        stz CGADD
        lda #$00
        sta CGDATA          ; colour 0 low  ($7C00 = blue)
        lda #$7C
        sta CGDATA          ; colour 0 high
        lda #$FF
        sta CGDATA          ; colour 1 low  ($7FFF = white)
        lda #$7F
        sta CGDATA          ; colour 1 high
        lda #$E0
        sta CGDATA          ; colour 2 low  ($03E0 = green)
        lda #$03
        sta CGDATA          ; colour 2 high
        lda #$1F
        sta CGDATA          ; colour 3 low  ($7C1F = magenta)
        lda #$7C
        sta CGDATA          ; colour 3 high

        ; ── Tile CHR → VRAM word $0000 (DMA channel 0) ────────────────
        ; Two 8x8 2bpp tiles = 32 bytes. VMAIN $80 = +1 word after the
        ; high-byte write; B-bus $18 = VMDATAL (auto-alternates to $2119).
        ldx #$0000
        stx VMADDL
        lda #$80
        sta VMAIN
        lda #$01
        sta DMAP0           ; DMA mode 1 (2 regs, word transfers)
        lda #$18
        sta BBAD0           ; → $2118 / $2119
        ldx #TILES
        stx A1T0L
        lda #TILES>>16
        sta A1B0
        ldx #(TILES_END-TILES)
        stx DAS0L           ; byte count
        lda #$01
        sta MDMAEN          ; fire channel 0

        ; ── Fill BG1 tilemap → VRAM word $0400 (byte $0800) ───────────
        ; A 32x32 map = 1024 entries. Each entry is a word: low byte =
        ; tile index, high byte = attributes (0). We write a checkerboard
        ; of tile 0 / tile 1 directly through the data port (no source
        ; buffer needed). VMAIN already = +1 word per write.
        ldx #$0400
        stx VMADDL
        rep #$20            ; A = 16-bit for word writes
        ldy #$0000          ; entry counter (0..1023)
.maploop:
        tya
        and #$0001          ; checker by column parity
        sta VMDATAL         ; entry = tile 0 or tile 1
        iny
        cpy #1024
        bne .maploop
        sep #$20            ; back to 8-bit A

        ; ── BG1 base registers ────────────────────────────────────────
        stz BGMODE          ; mode 0, 8x8 tiles
        ; BG1SC: bits 2-7 = tilemap base in $0400-word units, bits 0-1 =
        ; size (00 = 32x32). Map is at word $0400 → base = 1 → ($01<<2)=$04.
        lda #$04
        sta BG1SC
        stz BG12NBA         ; BG1 char base = word $0000 (our tiles)
        lda #$01
        sta TM              ; enable BG1 on the main screen

        ; ── Screen ON at full brightness ──────────────────────────────
        lda #$0F
        sta INIDISP

LOOP:
        bra LOOP

; -----------------------------------------------------------------------
; Tile CHR: two 8x8 2bpp tiles (16 bytes each). 2bpp = 2 bitplanes
; interleaved per row: byte0=row0 plane0, byte1=row0 plane1, ...
;
; Tile 0 — solid colour 1 (plane0 all set, plane1 clear → colour 1).
; Tile 1 — checker of colour 2 / colour 3 (both planes patterned) so the
; map's alternating tiles give a busy, multi-colour screen.
TILES:
; tile 0 (solid: every pixel colour 1)
db $FF, $00, $FF, $00, $FF, $00, $FF, $00
db $FF, $00, $FF, $00, $FF, $00, $FF, $00
; tile 1 (checkerboard: colour 2 / colour 3 alternating per pixel)
db $AA, $55, $55, $AA, $AA, $55, $55, $AA
db $AA, $55, $55, $AA, $AA, $55, $55, $AA
TILES_END:

; -----------------------------------------------------------------------
; Emulation-mode reset vector (used at boot, before `xce` flips to native).
; asar's `lorom` directive handles header + rest of vector table padding.
org $00FFFC
        dw START

; SNES — OAM (sprite list) upload.
;
; OAM is 544 bytes total: 512 byte "low table" (128 sprites × 4 bytes)
; plus 32 byte "high table" (2 bits per sprite, packed).
;
; Low-table per sprite (4 bytes):
;   +0  X position (low 8 bits)
;   +1  Y position
;   +2  tile number (low 8 bits)
;   +3  attributes: VHOO PPCT
;       V/H  = vertical/horizontal flip
;       OO   = priority (0-3, higher draws on top of BG)
;       PPP  = sprite palette (0-7, maps to CGRAM 128 + p*16)
;       T    = tile number high bit (extends 0-255 → 0-511)
;
; High-table 2 bits per sprite, packed 4 sprites per byte:
;   bit 0   = X position high bit (sprite X is 9-bit signed!)
;   bit 1   = size select (small/large per OBSEL $2101)
;
; The simplest pattern — write the whole 544 bytes via DMA each frame
; from a "shadow OAM" in WRAM at $0400-$0621. Update sprites by writing
; to the shadow; the OAM DMA every NMI flushes.
;
; ALWAYS do OAM DMA during forced blank or vblank. Mid-frame OAM writes
; cause sprite flicker. (Inside NMI handler is canonical.)
;
; OAM DMA via channel 0:
;
;   stz $2102           ; OAMADDL — start at OAM byte 0
;   stz $2103           ; OAMADDH
;   stz $4300           ; DMA mode 0 (1 byte to one register)
;   lda #$04
;   sta $4301           ; B-bus = $2104 (OAMDATA)
;   ldx #oam_shadow     ; source address
;   stx $4302
;   lda #oam_shadow>>16
;   sta $4304
;   ldx #$0220          ; 544 bytes
;   stx $4305
;   lda #$01
;   sta $420B           ; fire channel 0
;
; Tip: clear the shadow to {y=$F0, ...} at boot so unused slots stay
; off-screen until you assign them. Otherwise the random WRAM contents
; show as garbage sprites for frame 0.

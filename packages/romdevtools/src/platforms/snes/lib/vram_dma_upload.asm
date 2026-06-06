; SNES — VRAM upload via DMA channel 0.
;
; Uploads `size` bytes from `source_addr` (bank-byte in `source_bank`)
; into VRAM starting at word-address VMADD. Use during forced blank or
; vblank — VRAM writes outside those windows are silently ignored.
;
; Important: VMADD is a WORD address, NOT byte. word $2000 = byte $4000.
; BG tilemaps are typically at word $4000+ (= byte $8000+) so they don't
; overlap CHR data that's accumulating from word $0000.
;
; DMA mode 1 = 2 registers (low/high), one byte each = a 16-bit word
; per beat. Target $18 = VMDATAL ($2118); the DMA controller
; automatically alternates to $2119 (VMDATAH) on each beat.
;
; Inputs you set up before `jsr vram_dma`:
;   16-bit VMADDL ($2116):  destination VRAM word address
;   8-bit VMAIN ($2115)  :  increment mode ($80 = inc after high-byte write)
;   16-bit a1t0 ($4302)  :  source address (low 16 bits)
;   8-bit  a1b0 ($4304)  :  source bank byte
;   16-bit das0 ($4305)  :  byte count (NOT word count — pass size_in_bytes)
;
; Example: upload CHR from `bg_chr_data` (a label in ROM) to VRAM $0000:
;
;   ldx #$0000
;   stx $2116          ; VRAM word $0000
;   lda #$80
;   sta $2115          ; +1 word after VMDATAH write
;   lda #$01
;   sta $4300          ; DMA mode 1
;   lda #$18
;   sta $4301          ; B-bus = $2118 (VMDATAL)
;   ldx #bg_chr_data
;   stx $4302
;   lda #bg_chr_data>>16
;   sta $4304
;   ldx #(bg_chr_end-bg_chr_data)
;   stx $4305          ; byte count
;   lda #$01
;   sta $420B          ; MDMAEN bit 0 — fire channel 0
;
; The DMA finishes synchronously; no need to wait. Subsequent CPU
; instructions run after the transfer completes.

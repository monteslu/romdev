; SNES — canonical reset routine.
;
; Switches the 65816 from emulation mode into native mode, sets up the
; stack, clears registers, forces blank, disables NMI/HDMA. Every SNES
; program starts with roughly this block. Drop into your `reset:` label.
;
; After this finishes you'll typically: upload palettes/CHR/tilemap with
; rendering still blanked, then `lda #$0F / sta $2100` to enable display,
; `lda #$81 / sta $4200` to enable NMI + auto-joypad-read, and fall into
; a main loop that waits on an `nmi_ready` flag the NMI handler sets.
;
; Standard idiom every SNES dev game uses. Copy verbatim.

reset:
  sei            ; mask IRQ
  clc
  xce            ; carry clear → switch to NATIVE mode
  rep #$30       ; 16-bit accumulator + 16-bit X/Y
  ldx #$1FFF
  txs            ; stack at $001FFF

  sep #$20       ; 8-bit A (most code paths)
  rep #$10       ; keep X/Y 16-bit

  lda #$80
  sta $2100      ; INIDISP — forced blank, brightness 0
  stz $4200      ; NMITIMEN — NMI off, auto-joypad off
  stz $420C      ; HDMAEN — all HDMA channels off

  ; Caller should next clear direct page, upload assets via DMA, then
  ; turn screen on + enable NMI.

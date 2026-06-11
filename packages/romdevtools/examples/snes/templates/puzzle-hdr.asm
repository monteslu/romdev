;==LoRom== puzzle hdr.asm — PROJECT OVERRIDE of PVSnesLib's stock header
;
; Why this file exists: the stock include/hdr.asm declares CARTRIDGETYPE $00
; (ROM only) and SRAMSIZE $00. The SNES cart header is the ONLY place battery
; SRAM gets declared — snes9x (and real flash carts) size the save RAM from
; these two bytes. Delete this file and the build still succeeds, the game
; still runs, and saves silently stop existing: sram_read16/sram_write16 hit
; open bus at $70:0000 and the hi-score never survives a power cycle.
;
; Everything except CARTRIDGETYPE/SRAMSIZE/NAME is byte-identical to the
; stock header — the memory map and vectors MUST match what PVSnesLib's
; crt0/libs were assembled against, or wlalink places sections inconsistently.

.MEMORYMAP                      ; Begin describing the system architecture.
  SLOTSIZE $8000                ; ROM slot is $8000 bytes (LoROM 32K banks).
  DEFAULTSLOT 0
  SLOT 0 $8000                  ; ROM
  SLOT 1 $0 $2000               ; low WRAM mirror (tcc registers live at $0000)
  SLOT 2 $2000 $E000            ; WRAM $2000-$FFFF
  SLOT 3 $0 $10000              ; bank $7F WRAM (tcc C globals)
.ENDME

.ROMBANKSIZE $8000              ; 32 KByte ROM banks
.ROMBANKS 8                     ; 2 Mbits (256 KB) — matches PVSnesLib stock

.SNESHEADER
  ID "SNES"

  NAME "JEWEL JOUST          "  ; Program Title - 21 bytes, space-padded.
  ;    "123456789012345678901"

  SLOWROM
  LOROM

  CARTRIDGETYPE $02             ; $02 = ROM + SRAM + battery  ← THE SAVE SWITCH
  ROMSIZE $08                   ; $08 = 2 Mbits
  SRAMSIZE $01                  ; $01 = 2 KB SRAM, mapped at $70:0000-$07FF
  COUNTRY $01                   ; $01 = U.S.
  LICENSEECODE $00
  VERSION $00
.ENDSNES

.SNESNATIVEVECTOR               ; Native Mode interrupt vector table
  COP EmptyHandler
  BRK EmptyHandler
  ABORT EmptyHandler
  NMI VBlank                    ; PVSnesLib's vblank.asm handler
  IRQ EmptyHandler
.ENDNATIVEVECTOR

.SNESEMUVECTOR                  ; Emulation Mode interrupt vector table
  COP EmptyHandler
  ABORT EmptyHandler
  NMI EmptyHandler
  RESET tcc__start              ; PVSnesLib crt0 entry
  IRQBRK EmptyHandler
.ENDEMUVECTOR

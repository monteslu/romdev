; hdr.asm — minimum SNES memory map + ROM header + interrupt vectors
;          for tcc-65816 + wla-65816 + wlalink builds.
;
; This file is auto-included by tcc's emitted assembly (every translation
; unit starts with `.include "hdr.asm"`). It defines the wla-dx memory
; layout, the SNES cartridge header, and the interrupt vector table.
;
; LoROM, 32 KB ROM, SlowROM. No FASTROM / HIROM variants — those add
; complexity that the minimum-viable C-on-SNES build doesn't need yet.

.MEMORYMAP
  SLOTSIZE $8000
  DEFAULTSLOT 0
  SLOT 0 $8000           ; PRG ROM mapped at $00:8000..$00:FFFF (LoROM mirror)
  SLOT 1 $0000 $2000     ; direct page region — tcc__registers lives here
  SLOT 2 $2000 $E000     ; scratch RAM region
  SLOT 3 $0000 $10000    ; full BANK $7F (work RAM high)
.ENDME

.ROMBANKSIZE $8000
.ROMBANKS 1

.SNESHEADER
  ID "ROMD"                   ; 4-char cart id
  NAME "ROM-DEV-MCP C BUILD  " ; 21-char title — padded with spaces
  SLOWROM
  LOROM
  CARTRIDGETYPE $00           ; ROM only
  ROMSIZE $08                 ; 2 Mbits (1 × 32KB bank — header field uses log2 megs)
  SRAMSIZE $00
  COUNTRY $01                 ; USA
  LICENSEECODE $00
  VERSION $00
.ENDSNES

.SNESNATIVEVECTOR              ; Native-mode 65816 interrupt vectors
  COP   EmptyHandler
  BRK   EmptyHandler
  ABORT EmptyHandler
  NMI   EmptyHandler
  IRQ   EmptyHandler
.ENDNATIVEVECTOR

.SNESEMUVECTOR                 ; Emulation-mode (6502-compatible) vectors
  COP    EmptyHandler
  ABORT  EmptyHandler
  NMI    EmptyHandler
  RESET  tcc__start             ; cold-boot entry point — defined in crt0
  IRQBRK EmptyHandler
.ENDEMUVECTOR

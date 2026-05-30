; SNES — LoROM header + vectors.
;
; Every LoROM cartridge needs this exact layout in bank $00, mapped from
; CPU $00:FFC0 onward. The 21-byte title is space-padded to fill exactly
; that field. The byte at $FFD5=$20 declares LoROM/SlowROM; flip to $30
; for FastROM.
;
; Native-mode vectors live at $FFE4-$FFEF. Critical: only NMI ($FFEA)
; and IRQ ($FFEE) are typically used in practice. The 6 entries before
; NMI are COP/BRK/ABORT/reserved/reserved which 99% of homebrew leaves
; at $0000. (Common gotcha: if your `dw` list runs long here you'll cross
; into $010000 = bank $01 and asar will emit an Ebank_border_crossed
; error. Verified by bisection on this MCP server's own dev sessions.)
;
; Emulation-mode vectors at $FFF4-$FFFF. RESET at $FFFC is the one that
; actually matters — it's where the CPU starts after power-on. Everything
; else can be zero.

org $00FFC0
  db "MY GAME              "    ; 21 byte title, pad with spaces to fill
  db $20                          ; map mode: LoROM, SlowROM
  db $00                          ; cart type: ROM only
  db $08                          ; ROM size 2^N KB → $08 = 256 KB
  db $00                          ; SRAM size (0 = none)
  db $01                          ; region: $01 = USA/NTSC, $00 = Japan
  db $00                          ; dev id
  db $00                          ; ROM version
  dw $0000                        ; checksum complement (filled by tools)
  dw $0000                        ; checksum

; Native-mode vectors $FFE4-$FFEF
org $00FFE4
  dw $0000                        ; COP
  dw $0000                        ; BRK
  dw $0000                        ; ABORT
  dw nmi                          ; NMI ($FFEA) ← define `nmi:` somewhere
  dw $0000                        ; reserved
  dw irq                          ; IRQ ($FFEE) ← define `irq:` (usually rti)

; Emulation-mode vectors $FFF4-$FFFF
org $00FFF4
  dw $0000                        ; COP (emulation)
  dw $0000                        ; BRK (emulation)
  dw $0000                        ; ABORT (emulation)
  dw $0000                        ; NMI (emulation)
  dw reset                        ; RESET ($FFFC) ← entry point
  dw $0000                        ; IRQ (emulation)

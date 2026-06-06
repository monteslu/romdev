; SNES — LoROM multi-bank layout (canonical order).
;
; asar 1.x silently crashes (heap-pointer exit code, no diagnostic) when
; `org` directives go to a higher bank and then rewind to a lower one.
; The preflight checker now catches this, but the actual workaround is to
; lay your `org`s out in MONOTONICALLY INCREASING bank order: header and
; small fixed-position data FIRST, then code, then big data blobs in
; higher banks.
;
; This template puts the LoROM header at $00FFC0 BEFORE any large incbin
; that would push past it, then drops your CHR/audio/level data in
; bank $01 ($018000+). Up to bank $07 ($038000..$07FFFF) is freely
; available in a 256 KB ROM; bump the header byte at $FFD7 to allow
; larger ROMs (see lorom_header.asm).
;
; If you need more than ~32 KB in bank $00 itself, you can't — bank $00
; ends at $00FFFF and the header consumes $00FFC0..$00FFFF. Move data
; to bank $01+.

lorom

; ===== bank $00: header FIRST, then code =====
org $00FFC0
  db "MY MULTIBANK GAME    "    ; 21 byte title
  db $20, $00, $08, $00, $01, $00, $00
  dw $0000, $0000                ; checksum complement + checksum

org $00FFE4
  dw $0000, $0000, $0000, nmi, $0000, irq

org $00FFFC
  dw reset                       ; emulation-mode RESET vector

; ===== bank $00 code area =====
org $008000
reset:
  sei
  clc
  xce                            ; switch to native mode
  rep #$30
  ldx #$1FFF
  txs
  ; ... your init + main loop here
  jmp main

nmi:
  rti

irq:
  rti

main:
  wai
  jmp main

; ===== bank $01: CHR, audio samples, level data =====
; All large `incbin`s go here. Bank $01 = file offset $008000..$00FFFF.
; You get up to 32 KB per bank ($XX8000..$XXFFFF).
org $018000
chr_data:
  ; incbin "title_chr.bin"      ; up to 32 KB
; pad $01FFFF                    ; (uncomment to fill the bank if needed)

; ===== bank $02+: more data if needed =====
; org $028000
;   incbin "level_data.bin"

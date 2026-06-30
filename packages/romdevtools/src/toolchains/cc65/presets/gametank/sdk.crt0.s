; ---------------------------------------------------------------------------
; GameTank SDK-runtime crt0 (single-bank EEPROM32K, with the bundled SDK gfx/
; input/random/ACP runtime). Adapted from gametank_sdk src/gt/crt0.s, MIT — but
; STRIPPED of flash banking + the audio-FW asset: a single 32 KB cart maps at
; boot, so there's no flash bank to shift in, and the bare runtime has no
; asset-pipeline audio firmware. Calls _sdk_init (init_graphics + ACP) then
; _main. The SDK's interrupt.s provides _nmi_int / _irq_int, so this crt0 does
; NOT define them (that was the duplicate-symbol clash with the bare crt0).
; ---------------------------------------------------------------------------
.export   _init, _exit
.import   _main, _sdk_init
.export   __STARTUP__ : absolute = 1
.import   __RAM_START__, __RAM_SIZE__
.import   copydata, zerobss, initlib, donelib

.PC02

BankReg = $2005
VIA     = $2800
DDRA    = 3
ORAr    = 1

.include "zeropage.inc"

.segment "STARTUP"

_init:    LDX     #$FF
          TXS
          CLD

          LDX     #0
viaWakeup:
          INX
          BNE     viaWakeup

          STZ     BankReg            ; single 32K cart: fixed bank, nothing to shift
          STZ     $1FFF

          LDA     #%00000111         ; VIA DDRA: banking pins as output
          STA     VIA+DDRA
          LDA     #$FF
          STA     VIA+ORAr

; cc65 C argument-stack pointer = top of work RAM
          LDA     #<(__RAM_START__ + __RAM_SIZE__)
          STA     c_sp
          LDA     #>(__RAM_START__ + __RAM_SIZE__)
          STA     c_sp+1

          JSR     zerobss
          JSR     copydata
          JSR     initlib

          JSR     _sdk_init          ; init_graphics + ACP (the bundled runtime)
          CLI                        ; enable IRQs — the draw queue + ACP are
                                     ; INTERRUPT-DRIVEN (blit-done IRQ processes
                                     ; queue_draw_box; without CLI nothing draws)
          JSR     _main

_exit:    JSR     donelib
          BRK

; ---------------------------------------------------------------------------
; GameTank Tier-A crt0 (single-bank EEPROM32K, no SDK runtime).
; Adapted from gametank_sdk src/gt/crt0.s, MIT (Clyde Shaffer). STRIPPED for the
; bare 32 KB path: NO flash bank shift-out (the whole game is in one bank that
; maps at boot), NO _sdk_init, NO _AudioFWPkg .incbin. Just: stack init, VIA
; wakeup, zerobss/copydata/constructors, set the cc65 C arg-stack pointer, call
; main(). A default NMI/IRQ handler (rti) lives here so a bare game links without
; defining its own.
; ---------------------------------------------------------------------------
.export   _init, _exit
.export   _nmi_int, _irq_int
.import   _main
.export   __STARTUP__ : absolute = 1
.import   __RAM_START__, __RAM_SIZE__
.import   copydata, zerobss, initlib, donelib

.PC02                                 ; W65C02 opcode set (stz/bra/phx/…)

BankReg = $2005
VIA     = $2800
DDRA    = 3
ORAr    = 1

.include "zeropage.inc"

.segment "STARTUP"

_init:    LDX     #$FF                ; init stack pointer to $01FF
          TXS
          CLD

          LDX     #0                  ; brief VIA wakeup delay
viaWakeup:
          INX
          BNE     viaWakeup

          ; Park the banking register at a known state. With a single 32 KB cart
          ; the active bank is fixed at boot, so we don't shift a flash bank in.
          STZ     BankReg
          STZ     $1FFF

          LDA     #%00000111          ; VIA DDRA: low 3 bits output (banking pins)
          STA     VIA+DDRA
          LDA     #$FF
          STA     VIA+ORAr

; ---------------------------------------------------------------------------
; cc65 C argument-stack pointer = top of work RAM
          LDA     #<(__RAM_START__ + __RAM_SIZE__)
          STA     c_sp
          LDA     #>(__RAM_START__ + __RAM_SIZE__)
          STA     c_sp+1

; ---------------------------------------------------------------------------
          JSR     zerobss             ; clear BSS
          JSR     copydata            ; copy initialized DATA to RAM
          JSR     initlib             ; run constructors

          JSR     _main

_exit:    JSR     donelib             ; run destructors
          BRK

; ---------------------------------------------------------------------------
; Default interrupt handlers — a bare game that doesn't define its own still
; links. (A game CAN provide _nmi_int/_irq_int; cc65's linker lets a strong
; symbol from the game override these .export'd ones... so keep them weak by
; only defining if absent — here they're plain rti fallbacks.)
_nmi_int:
_irq_int:
          RTI

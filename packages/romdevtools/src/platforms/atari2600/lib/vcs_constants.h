; ── Atari 2600 register map (TIA write + RIOT) ─────────────────────
; Standard dasm-style constants matching vcs.h from the stella-asm
; distribution. Include via:  include "vcs_constants.h"

; ── TIA write registers ($00-$2C) ──────────────────────────────────
VSYNC     equ $00     ; vertical sync set/clear (bit 1)
VBLANK    equ $01     ; vertical blank + input dump
WSYNC     equ $02     ; wait for horizontal blank — block until next line
RSYNC     equ $03     ; reset horizontal sync counter
NUSIZ0    equ $04     ; player 0 + missile 0 size/count
NUSIZ1    equ $05     ; player 1 + missile 1 size/count
COLUP0    equ $06     ; player 0 + missile 0 color/luma
COLUP1    equ $07     ; player 1 + missile 1 color/luma
COLUPF    equ $08     ; playfield + ball color/luma
COLUBK    equ $09     ; background color/luma
CTRLPF    equ $0A     ; playfield reflect / score / priority / ball size
REFP0     equ $0B     ; reflect player 0 (bit 3)
REFP1     equ $0C     ; reflect player 1 (bit 3)
PF0       equ $0D     ; playfield register 0 (4 high bits)
PF1       equ $0E     ; playfield register 1 (8 bits)
PF2       equ $0F     ; playfield register 2 (8 bits, reverse-scan)
RESP0     equ $10     ; reset player 0 (write triggers, value ignored)
RESP1     equ $11     ; reset player 1
RESM0     equ $12     ; reset missile 0
RESM1     equ $13     ; reset missile 1
RESBL     equ $14     ; reset ball
AUDC0     equ $15     ; audio control channel 0
AUDC1     equ $16     ; audio control channel 1
AUDF0     equ $17     ; audio frequency channel 0
AUDF1     equ $18     ; audio frequency channel 1
AUDV0     equ $19     ; audio volume channel 0
AUDV1     equ $1A     ; audio volume channel 1
GRP0      equ $1B     ; graphics for player 0 (8 bits)
GRP1      equ $1C     ; graphics for player 1
ENAM0     equ $1D     ; enable missile 0 (bit 1)
ENAM1     equ $1E     ; enable missile 1 (bit 1)
ENABL     equ $1F     ; enable ball (bit 1)
HMP0      equ $20     ; horizontal motion player 0 (4-bit signed)
HMP1      equ $21
HMM0      equ $22
HMM1      equ $23
HMBL      equ $24
VDELP0    equ $25     ; vertical delay player 0 (bit 0)
VDELP1    equ $26
VDELBL    equ $27
RESMP0    equ $28     ; reset missile 0 to player 0 (bit 1)
RESMP1    equ $29
HMOVE     equ $2A     ; apply horizontal motion (latched from HMxx)
HMCLR     equ $2B     ; clear all HMxx
CXCLR     equ $2C     ; clear collision latches

; ── TIA read registers ($30-$3D) ───────────────────────────────────
CXM0P     equ $30     ; collisions: M0/P1, M0/P0
CXM1P     equ $31
CXP0FB    equ $32
CXP1FB    equ $33
CXM0FB    equ $34
CXM1FB    equ $35
CXBLPF    equ $36
CXPPMM    equ $37
INPT0     equ $38     ; analog input port 0 (paddle dump)
INPT1     equ $39
INPT2     equ $3A
INPT3     equ $3B
INPT4     equ $3C     ; latched: joystick 0 fire button
INPT5     equ $3D     ; latched: joystick 1 fire button

; ── RIOT ($280-$297) ───────────────────────────────────────────────
SWCHA     equ $280    ; joysticks: bits 7-4 = P0 right/left/down/up,
                      ;            bits 3-0 = P1 right/left/down/up
SWACNT    equ $281    ; port A data direction (usually $00 = input)
SWCHB     equ $282    ; console switches (select/reset/colorbw/diffP0/diffP1)
SWBCNT    equ $283
INTIM     equ $284    ; timer current value (read-only)
TIMINT    equ $285    ; timer wraparound flag
T1024T    equ $296    ; set timer (÷1024 prescale)
T1T       equ $294    ; set timer (÷1)
T8T       equ $295    ; set timer (÷8)
T64T      equ $295    ; set timer (÷64)

; ── Common bit masks ────────────────────────────────────────────────
VBLANK_ON        equ $02       ; bit 1: dump+latch+blank
VSYNC_ON         equ $02
CTRLPF_REFLECT   equ $01
CTRLPF_SCORE     equ $02
CTRLPF_PRIORITY  equ $04
CTRLPF_BALL_2    equ $10       ; bits 4-5 = ball width
CTRLPF_BALL_4    equ $20
CTRLPF_BALL_8    equ $30
NUSIZ_ONE        equ $00       ; one copy, normal width
NUSIZ_TWO_CLOSE  equ $01
NUSIZ_TWO_MED    equ $02
NUSIZ_THREE_CLOSE equ $03
NUSIZ_TWO_WIDE   equ $04
NUSIZ_DOUBLE     equ $05       ; one copy, double width
NUSIZ_THREE_MED  equ $06
NUSIZ_QUAD       equ $07

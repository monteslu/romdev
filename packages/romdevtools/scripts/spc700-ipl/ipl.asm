; romdev SPC700 boot ROM (IPL), 64 bytes at $FFC0-$FFFF of the sound CPU.
;
; Copyright (c) 2026 Luis Montes. MIT License (see LICENSE at the repo root).
;
; A clean-room reimplementation written from the public description of the
; boot upload protocol and of the state a program sees when the boot ROM
; starts it. It was not derived from, compared against or transliterated from
; any other boot ROM's instruction sequence.
;
; Assembled with asar (arch spc700) by build-ipl.mjs, which writes the bytes to
; romdev_iplrom.h. The snes9x and bsnes builds and the recompiler's APU data
; (scripts/recompile-gen/snes9x-apu.mjs -> snes9x-apu.json) use those bytes.
;
; Protocol (S-CPU side reads/writes $2140-$2143, the SPC700 side $F4-$F7):
;   1. The SPC700 signals ready with $AA in port 0 and $BB in port 1.
;   2. The S-CPU writes a destination address to ports 2-3, a nonzero value
;      to port 1 and $CC to port 0, then waits for port 0 to echo $CC.
;   3. Each byte: the S-CPU writes the byte to port 1 and its index (0, 1, 2,
;      ... modulo 256) to port 0, then waits for port 0 to echo the index.
;   4. A new block: address to ports 2-3, nonzero to port 1, and port 0 set to
;      a value other than the last echoed index and the next index (by
;      convention the last index + 2, skipping zero), then wait for the echo.
;   5. Start: the entry address to ports 2-3, zero to port 1, and port 0 set as
;      for a new block; after the echo the SPC700 jumps to the entry address.
;
; State at the jump: A = X = Y = 0, SP = $EF, PSW = $02 (only Z set). ARAM
; $01-$EF is cleared before the upload; $00-$01 hold the entry address.
; Reset enters at $FFC0 through the vector at $FFFE.
;
; Registers during the upload: Y = next index, X = last value echoed on port
; 0, $00-$01 = block address (advanced by 256 each time Y wraps).

arch spc700
norom
org $0000
base $FFC0

reset:
  mov x, #$EF
  mov sp, x            ; stack at $01EF
  mov a, #$00
.clear:                ; $01-$EF = 0 ($00-$01 are written before any use)
  mov (x), a
  dec x
  bne .clear
  mov $F4, #$AA        ; ready signature
  mov $F5, #$BB
.waitcc:
  cmp $F4, #$CC        ; the first kick is $CC
  bne .waitcc

block:                 ; port 0 holds a kick value; ports 1-3 are stable
  mov x, $F4           ; the kick value is the last echo
  movw ya, $F6
  movw $00, ya         ; block / entry address
  mov y, #$00          ; next index
  mov a, $F5           ; zero = start the program
  mov $F4, x           ; echo the kick (stores leave the flags)
  beq start

wait:
  cmp x, $F4
  beq wait             ; port 0 unchanged since the last echo
  cmp y, $F4
  bne block            ; changed, but not the next index: a new block
  mov a, $F5           ; the byte
  mov ($00)+y, a
  mov a, y
  mov x, a
  mov $F4, a           ; echo the index
  inc y
  bne wait
  inc $01              ; Y wrapped: next 256 bytes
  bra wait

start:                 ; A = 0
  clrc
  mov x, a             ; X = 0, PSW = Z
  jmp ($0000+x)        ; Y = 0, SP = $EF

  dw reset             ; $FFFE: reset vector

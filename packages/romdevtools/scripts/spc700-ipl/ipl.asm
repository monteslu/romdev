; romdev SPC700 boot ROM (IPL), 64 bytes at $FFC0-$FFFF of the sound CPU.
;
; Copyright (c) 2026 Luis Montes. MIT License (see LICENSE at the repo root).
;
; A clean-room reimplementation written from the public description of the
; boot upload protocol and of the state a program sees when the boot ROM
; starts it. It was not derived from, compared against or transliterated from
; any other boot ROM's instruction sequence. Its timing was matched from
; outside only: the S-CPU side of an emulator was scripted to write the ports
; at every SPC700 cycle offset, and the cycles at which the console's boot ROM
; samples ports 0-3 and answers on port 0 were measured; this code was then
; written to sample and answer on the same cycles, so a program uploads on
; exactly the console's schedule.
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
;      a value 1 to 128 above the next index (by convention the last index
;      + 2, skipping zero), then wait for the echo.
;   5. Start: the entry address to ports 2-3, zero to port 1, and port 0 set as
;      for a new block; after the echo the SPC700 jumps to the entry address.
;
; State at the jump: A = X = Y = 0, SP = $EF, PSW = $02 (Z) plus the carry the
; last port 0 compare left (set when the program is started right after the
; $CC kick, or when the next index is at or above the start kick as unsigned
; bytes; $02 for the usual last index + 2). ARAM $01-$EF is cleared before the
; upload; $00-$01 hold the entry address. Reset enters at $FFC0 through the
; vector at $FFFE.
;
; Timing (SPC700 cycles): the byte loop samples port 0 every 11 cycles and
; echoes 10 cycles after the sample that sees the next index; with the S-CPU
; answering at once a byte takes 25 cycles (31 when the index wraps). The
; first byte of a block is waited for by a 7-cycle loop. A kick is echoed 31
; cycles after the byte loop sees it (30 after the $CC loop does).
;
; Registers: X = 0 from the clear loop on, Y = next index, $00-$01 = block
; address (advanced by 256 each time Y wraps).

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
  bne .clear           ; X = 0 from here on
  mov $F4, #$AA        ; ready signature
  mov $F5, #$BB
.waitcc:
  cmp $F4, #$CC        ; the first kick is $CC
  bne .waitcc
  bra block

newblock:              ; port 0 changed to something other than the next index
  bpl wait             ; next index minus port 0 positive: not a kick, keep waiting
  xcn a                ; (timing)
block:                 ; port 0 holds a kick value
  movw ya, $F6
  movw $00, ya         ; block / entry address
  movw ya, $F4         ; A = the kick, Y = port 1
  mov $F4, a           ; echo the kick
  mov a, y
  beq start            ; port 1 zero: start the program (A = 0, Z set)
  mov y, $F0+x         ; Y = 0 (the TEST register reads as zero)
first:
  cmp y, $F4           ; wait for index 0
  bne first
wait:
  cmp y, $F4
  bne newblock
  mov a, $F5           ; the byte
  mov $F4, y           ; echo the index
  mov ($00)+y, a
  inc y
  bne wait
  inc $01              ; Y wrapped: next 256 bytes
  bra wait

start:
  jmp ($0000+x)        ; X = Y = 0, SP = $EF

  dw reset             ; $FFFE: reset vector

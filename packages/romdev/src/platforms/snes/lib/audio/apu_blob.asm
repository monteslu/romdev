; ── apu_blob.asm ── SPC700 driver + sample-bank + music assembler ───
;
; This file is the top-level asar input for building apu_blob.bin (the
; payload the SNES uploads into SPC700 ARAM at $0200).
;
; ARAM layout produced (R46):
;   $0200..$02xx    driver code   (~230 bytes — sfx + music engine)
;   $02xx..$0FFF    padding       (zero-filled by org)
;   $1000..$2417    sample bank   (5656 bytes — directory + BRR samples)
;     of which:
;       $1000..$100F  sample directory (4-byte entries × 2 samples + filler)
;       $1100..$1807  shoot.brr      (1800 bytes)
;       $1808..$261B  explosion.brr  (3600 bytes)
;   $2618..$4FFF    padding       (zero-filled)
;   $5000..$50xx    music data    (3 bytes per row × N rows, $00 terminator)
;
; The driver code below is duplicated from spc_driver.asm so this file
; can be assembled standalone by asar (asar 1.91 has trouble with
; `incsrc` inside `arch spc700` blocks). If you change spc_driver.asm,
; mirror the changes here.

arch spc700
norom
org $0000
base $0200

; ── Driver code at $0200 ───────────────────────────────────────────
start:
  mov $f2, #$6c
  mov $f3, #$20

  mov $f2, #$0d
  mov $f3, #$00
  mov $f2, #$2c
  mov $f3, #$00
  mov $f2, #$3c
  mov $f3, #$00
  mov $f2, #$4d
  mov $f3, #$00
  mov $f2, #$6d
  mov $f3, #$00
  mov $f2, #$7d
  mov $f3, #$00

  mov $f2, #$5d
  mov $f3, #$10

  mov $f2, #$0c
  mov $f3, #$7f
  mov $f2, #$1c
  mov $f3, #$7f

  mov $f2, #$00
  mov $f3, #$7f
  mov $f2, #$01
  mov $f3, #$7f

  mov $f2, #$02
  mov $f3, #$00
  mov $f2, #$03
  mov $f3, #$10

  mov $f2, #$05
  mov $f3, #$00
  mov $f2, #$06
  mov $f3, #$00
  mov $f2, #$07
  mov $f3, #$7f

  ; Voice 1 vol (music)
  mov $f2, #$10
  mov $f3, #$50
  mov $f2, #$11
  mov $f3, #$50

  ; Voice 1 ADSR off, GAIN $5F
  mov $f2, #$15
  mov $f3, #$00
  mov $f2, #$16
  mov $f3, #$00
  mov $f2, #$17
  mov $f3, #$5f

  ; Timer 0 setup: target $80 -> ~62.5 Hz
  mov $fa, #$80
  mov $f1, #$01
  mov a, $fd

  ; State init
  mov a, $f4
  mov $00, a
  mov $01, #$00
  mov $02, #$00
  mov $03, #$50
  mov $04, #$00

main_loop:
  mov a, $f4
  cmp a, $00
  beq cmd_done
  mov $00, a
  cmp a, #$01
  beq play_shoot
  cmp a, #$02
  beq play_explosion
  cmp a, #$03
  beq music_start
  cmp a, #$04
  beq music_stop

cmd_done:
  mov a, $01
  beq main_loop
  mov a, $fd
  beq main_loop
  mov a, $04
  beq music_next_row
  dec a
  mov $04, a
  bra main_loop

play_shoot:
  mov $f2, #$04
  mov $f3, #$00
  mov $f2, #$4c
  mov $f3, #$01
  bra cmd_done

play_explosion:
  mov $f2, #$04
  mov $f3, #$01
  mov $f2, #$4c
  mov $f3, #$01
  bra cmd_done

music_start:
  mov $02, #$00
  mov $03, #$50
  mov $04, #$00
  mov $01, #$01
  bra cmd_done

music_stop:
  mov $01, #$00
  mov $f2, #$5c
  mov $f3, #$02
  mov $f2, #$5c
  mov $f3, #$00
  bra cmd_done

music_next_row:
  mov y, #$00
  mov a, ($02)+y
  cmp a, #$00
  beq music_loop_end
  mov $04, a

  mov y, #$01
  mov a, ($02)+y
  mov $f2, #$12
  mov $f3, a

  mov y, #$02
  mov a, ($02)+y
  mov $f2, #$13
  mov $f3, a

  mov $f2, #$14
  mov $f3, #$00

  mov $f2, #$4c
  mov $f3, #$02

  mov a, $02
  clrc
  adc a, #$03
  mov $02, a
  mov a, $03
  adc a, #$00
  mov $03, a
  jmp main_loop

music_loop_end:
  mov $02, #$00
  mov $03, #$50
  jmp music_next_row

; ── Sample bank at $1000 ───────────────────────────────────────────
; file-offset $0E00 = ARAM $1000 - base $0200. Asar 1.91 mis-handles
; the arithmetic form `$1000 - $200`, so we hardcode the literal.
org $0E00
base $1000
incbin "sample_bank.bin"

; ── Music data at $5000 ────────────────────────────────────────────
; file-offset $4E00 = ARAM $5000 - base $0200. sample_bank.bin is
; 5656 bytes ($1618), so it ends at file offset $2417 (ARAM $2618).
; Padding bytes from $2417..$4DFF will be zero-filled by the next org.
;
; Format: each row = [duration_ticks, pitch_lo, pitch_hi].
; Tick rate is ~62.5 Hz, so duration $10 ≈ 256 ms (an eighth-note at
; ~115 BPM). Terminator: a single $00 byte (duration 0) → loop.
;
; Melody is a 16-step ascending/descending C-major-ish run over a
; non-looping BRR sample — the shoot.brr is short so each "note" is
; really a re-trigger of the sample at a different playback rate.
; It sounds like a chirpy chiptune arpeggio, which is exactly the
; vibe we want for a minimum-viable music demo.
org $4E00
base $5000
song:
  db $10, $00, $04        ; pitch $0400
  db $10, $80, $04        ; pitch $0480
  db $10, $00, $05        ; pitch $0500
  db $10, $80, $05        ; pitch $0580
  db $10, $00, $06        ; pitch $0600
  db $10, $00, $07        ; pitch $0700
  db $10, $00, $08        ; pitch $0800
  db $10, $00, $0A        ; pitch $0A00
  db $10, $00, $08
  db $10, $00, $07
  db $10, $00, $06
  db $10, $80, $05
  db $10, $00, $05
  db $10, $80, $04
  db $10, $00, $04
  db $10, $80, $03        ; pitch $0380 — slight bass note
  db $00                  ; loop marker

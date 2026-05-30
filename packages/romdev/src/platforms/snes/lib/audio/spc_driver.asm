; SPC700 driver — command-driven SFX + music dispatcher.
;
; R46 extension: adds continuous music playback on voice 1 layered on
; top of the R31 two-sample sfx system (voice 0). Voices 2-7 are free.
;
; Commands (sent by SNES via STA $2140 -> SPC reads $F4):
;   $00 = no-op / release (resets edge detector)
;   $01 = play sample 0 on voice 0 (shoot — sfx)
;   $02 = play sample 1 on voice 0 (explosion — sfx)
;   $03 = music start  (begin walking the song table at $5000)
;   $04 = music stop   (silence voice 1, halt the row walker)
;
; Strategy for repeat triggers: SNES side writes $00 to $2140 first,
; then the real command byte one frame later. Driver caches prev_cmd
; in ARAM $00 and only dispatches on edge (new != prev). $00 acts as
; the "release" that resets the edge detector.
;
; Music engine:
;   - Song table starts at ARAM $5000. Each row is 3 bytes:
;       db duration_ticks, pitch_lo, pitch_hi
;     duration $00 = end-of-song marker → rewind to $5000 (looping).
;   - Driver state at ARAM $01..$05:
;       $01 music_on   (0/1)
;       $02 song_ptr_lo
;       $03 song_ptr_hi
;       $04 tick_counter (counts SPC Timer 0 ticks down to 0 → next row)
;   - Timing source: SPC Timer 0 at 62.5 Hz (target $80, base 8 kHz).
;     Read $FD per loop pass; nonzero means at least one tick elapsed.
;     We treat each $FD read as "advance tick_counter by 1" (loose but
;     fine — at 62.5 Hz vs main loop spin rate we'll never miss many).
;
; CRITICAL: DSP $6C = FLG (not $5C — that's KOFF). Power-on FLG = $E0
; (reset+mute set); must be cleared. Same hard-won lesson from R31.

arch spc700
norom
org $0000
base $0200

start:
  ; ── DSP init ────────────────────────────────────────────────────
  ; Clear FLG (the real one at $6C)
  mov $f2, #$6c
  mov $f3, #$20

  ; Zero echo regs
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

  ; Sample directory $1000 → DIR=$10
  mov $f2, #$5d
  mov $f3, #$10

  ; Master vol
  mov $f2, #$0c
  mov $f3, #$7f
  mov $f2, #$1c
  mov $f3, #$7f

  ; Voice 0 vol (sfx)
  mov $f2, #$00
  mov $f3, #$7f
  mov $f2, #$01
  mov $f3, #$7f

  ; Voice 0 pitch $1000 (sfx)
  mov $f2, #$02
  mov $f3, #$00
  mov $f2, #$03
  mov $f3, #$10

  ; Voice 0 ADSR off, GAIN $7F
  mov $f2, #$05
  mov $f3, #$00
  mov $f2, #$06
  mov $f3, #$00
  mov $f2, #$07
  mov $f3, #$7f

  ; Voice 1 vol (music) — slightly quieter so sfx still cuts through
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

  ; ── Timer 0 setup ───────────────────────────────────────────────
  ; T0 target = $80 → 8000 Hz / 128 = 62.5 Hz ticks
  mov $fa, #$80
  ; Enable T0 (bit 0 of CONTROL $F1)
  mov $f1, #$01
  ; Prime the read register (any pending count is discarded)
  mov a, $fd

  ; ── State init ──────────────────────────────────────────────────
  ; previous-command cache at ARAM $00 — seed with whatever $F4 has now
  ; so we don't mistake the leftover upload-protocol byte as a command.
  mov a, $f4
  mov $00, a

  ; music_on = 0
  mov $01, #$00
  ; song_ptr = $5000
  mov $02, #$00
  mov $03, #$50
  ; tick_counter = 0 (forces immediate row load on first start)
  mov $04, #$00

main_loop:
  ; ── 1. Command dispatch (edge-detected) ─────────────────────────
  mov a, $f4
  cmp a, $00
  beq cmd_done           ; no change since last poll
  mov $00, a             ; cache the new value
  cmp a, #$01
  beq play_shoot
  cmp a, #$02
  beq play_explosion
  cmp a, #$03
  beq music_start
  cmp a, #$04
  beq music_stop
  ; fall through for $00 (release) — just cache, no action

cmd_done:
  ; ── 2. Music tick ───────────────────────────────────────────────
  ; Skip music processing entirely if not playing.
  mov a, $01
  beq main_loop

  ; Did Timer 0 fire? $FD auto-clears on read; nonzero = ≥1 tick.
  mov a, $fd
  beq main_loop

  ; Advance tick_counter down by 1. When it hits 0, load next row.
  mov a, $04
  beq music_next_row
  dec a
  mov $04, a
  bra main_loop

; ── SFX handlers ──────────────────────────────────────────────────
play_shoot:
  mov $f2, #$04          ; SRCN for voice 0
  mov $f3, #$00
  mov $f2, #$4c          ; KON
  mov $f3, #$01
  bra cmd_done

play_explosion:
  mov $f2, #$04
  mov $f3, #$01
  mov $f2, #$4c
  mov $f3, #$01
  bra cmd_done

; ── Music control ─────────────────────────────────────────────────
music_start:
  ; Reset song pointer to $5000, force immediate row fetch.
  mov $02, #$00
  mov $03, #$50
  mov $04, #$00          ; tick_counter = 0 → next pass loads row 0
  mov $01, #$01          ; music_on
  bra cmd_done

music_stop:
  mov $01, #$00          ; music_on = 0
  ; Key-off voice 1 (KOF bit 1 set in $5C; KOF is sticky until cleared)
  mov $f2, #$5c
  mov $f3, #$02
  ; Then clear KOF so future KON triggers actually retrigger.
  mov $f2, #$5c
  mov $f3, #$00
  bra cmd_done

; ── Row loader ────────────────────────────────────────────────────
; Reads 3 bytes [duration, pitch_lo, pitch_hi] from (song_ptr),
; advances song_ptr by 3, programs voice 1, key-ons.
; Duration of $00 → end-of-song; rewind to $5000 and reload row 0.
;
; Uses `mov a,[dp]+y` (direct-page indirect indexed by Y) where dp
; = $02 (the pair $02/$03 holds the 16-bit ARAM song pointer).
music_next_row:
  mov y, #$00
  mov a, ($02)+y         ; a = duration
  cmp a, #$00
  beq music_loop_end     ; duration 0 → end-of-song, rewind
  mov $04, a             ; tick_counter = duration

  ; pitch_lo at offset 1
  mov y, #$01
  mov a, ($02)+y
  mov $f2, #$12          ; voice 1 PITCHL
  mov $f3, a

  ; pitch_hi at offset 2
  mov y, #$02
  mov a, ($02)+y
  mov $f2, #$13          ; voice 1 PITCHH
  mov $f3, a

  ; SRCN for voice 1 = 0 (reuse shoot.brr as instrument waveform)
  mov $f2, #$14
  mov $f3, #$00

  ; Key-on voice 1 (bit 1 of KON $4C)
  mov $f2, #$4c
  mov $f3, #$02

  ; Advance song_ptr by 3
  mov a, $02
  clrc
  adc a, #$03
  mov $02, a
  mov a, $03
  adc a, #$00
  mov $03, a
  jmp main_loop

music_loop_end:
  ; Rewind song_ptr to $5000 and re-enter row loader.
  mov $02, #$00
  mov $03, #$50
  jmp music_next_row

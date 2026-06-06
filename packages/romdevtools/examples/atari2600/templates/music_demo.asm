; ── music_demo.asm — Atari 2600 2-voice music scaffold ──────────────
;
; The 2600 has two TIA audio channels (AUDC0/AUDC1 + AUDF0/AUDF1 +
; AUDV0/AUDV1). This scaffold plays a CONTINUOUS 2-voice chiptune —
; voice 0 = melody, voice 1 = bass — by stepping through hand-authored
; note tables in ROM. The tables ARE the song: source-visible chiptune,
; no tracker, no toolchain magic.
;
; How it works (per frame, in VBLANK so we don't disturb the display):
;   - For each voice, decrement its frames-left counter.
;   - When the counter hits 0, advance the table index and load the
;     next (AUDF, length_frames) pair. Wraps to start at end-of-table.
;   - AUDC0 = AUDC1 = $04 (pure tone) is set once at boot.
;
; Display: minimal — blue background + a static "MUSIC" rendered via
; the playfield (PF1/PF2 patterns) in a centered band. The point is the
; AUDIO; the visuals exist just to prove the ROM booted.
;
; TIA AUDF freq (NTSC, AUDC=$04 pure tone): ~30kHz / 114 / (AUDF+1).
;   F=$1F → ~ 65 Hz (low C-ish, bass)
;   F=$17 → ~ 80 Hz
;   F=$13 → ~100 Hz
;   F=$0F → ~125 Hz
;   F=$0B → ~165 Hz
;   F=$09 → ~200 Hz
;   F=$07 → ~250 Hz
;   F=$05 → ~330 Hz
; (Exact values don't matter — what matters is relative pitch.)

  processor 6502
  org $F000

; ── TIA register equates ───────────────────────────────────────────
VSYNC    = $00
VBLANK   = $01
WSYNC    = $02
COLUP0   = $06
COLUPF   = $08
COLUBK   = $09
PF0      = $0D
PF1      = $0E
PF2      = $0F
CTRLPF   = $0A
; TIA audio — both voices.
AUDC0    = $15
AUDC1    = $16
AUDF0    = $17
AUDF1    = $18
AUDV0    = $19
AUDV1    = $1A

; ── Zero-page state ($80-$86 used by sibling scaffolds; we use $87+) ─
MEL_IDX   = $87        ; current melody-table index (in bytes, *2)
MEL_LEFT  = $88        ; frames remaining on current melody note
BASS_IDX  = $89        ; current bass-table index (in bytes, *2)
BASS_LEFT = $8A        ; frames remaining on current bass note
FRAME     = $8B

; Note-table layout: pairs of (AUDF, length_frames). End sentinel = $FF
; in the AUDF slot. When we hit it, we wrap MEL_IDX/BASS_IDX back to 0.

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clr:
  STA $00,X
  DEX
  BNE .clr

  ; ── Visual setup ──────────────────────────────────────────────────
  LDA #$80           ; blue background
  STA COLUBK
  LDA #$0F           ; white foreground (playfield + player)
  STA COLUPF
  LDA #$0F
  STA COLUP0
  LDA #$01           ; CTRLPF: reflected playfield (symmetrical "MUSIC" band)
  STA CTRLPF

  ; ── Audio setup ───────────────────────────────────────────────────
  LDA #$04           ; pure tone, both voices
  STA AUDC0
  STA AUDC1
  LDA #$08           ; medium volume on both voices
  STA AUDV0
  STA AUDV1
  ; Prime both voices so they play immediately (no silent first frame).
  LDA #1
  STA MEL_LEFT       ; will hit 0 on first tick and load melody[0]
  STA BASS_LEFT

MAIN:
  INC FRAME

  ; ── VSYNC (3 lines) ──────────────────────────────────────────────
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC

  ; ── VBLANK (37 lines) — all music updates happen here ────────────
  LDA #2
  STA VBLANK

  ; --- Voice 0 (melody) ---
  DEC MEL_LEFT
  BNE .mel_done
  ; Time for the next melody note. Read AUDF byte at melody_notes,MEL_IDX.
  LDX MEL_IDX
  LDA melody_notes,X
  CMP #$FF
  BNE .mel_play
  ; Sentinel → wrap to start of table.
  LDX #0
  STX MEL_IDX
  LDA melody_notes,X
.mel_play:
  STA AUDF0
  INX
  LDA melody_notes,X      ; length_frames
  STA MEL_LEFT
  INX
  STX MEL_IDX
.mel_done:

  ; --- Voice 1 (bass) ---
  DEC BASS_LEFT
  BNE .bass_done
  LDX BASS_IDX
  LDA bass_notes,X
  CMP #$FF
  BNE .bass_play
  LDX #0
  STX BASS_IDX
  LDA bass_notes,X
.bass_play:
  STA AUDF1
  INX
  LDA bass_notes,X
  STA BASS_LEFT
  INX
  STX BASS_IDX
.bass_done:

  ; Burn the rest of VBLANK (37 lines total). We've used a handful for
  ; the music update; pad with WSYNCs.
  LDX #34
.vb:
  STA WSYNC
  DEX
  BNE .vb

  LDA #0
  STA VBLANK

  ; ── Visible (192 lines) ──────────────────────────────────────────
  ; Render a centered horizontal band that spells "MUSIC" via playfield
  ; bits. Top 80 blank, middle 32 = letterforms (16 unique rows × 2),
  ; bottom 80 blank. DO NOT touch audio regs during the visible region.
  LDY #192
.draw:
  STA WSYNC
  CPY #112
  BCS .top_blank      ; Y >= 112 → top blank rows
  CPY #80
  BCC .bot_blank      ; Y < 80 → bottom blank rows
  ; Y in [80,111] → render letters. Map to 0..15 (each letter row used twice).
  TYA
  SEC
  SBC #80
  LSR
  TAX
  LDA LETTERS_PF1,X
  STA PF1
  LDA LETTERS_PF2,X
  STA PF2
  JMP .row_done
.top_blank:
.bot_blank:
  LDA #0
  STA PF1
  STA PF2
.row_done:
  DEY
  BNE .draw

  ; ── Overscan (30 lines) ─────────────────────────────────────────
  LDA #2
  STA VBLANK
  ; Clear playfield so it doesn't bleed into overscan.
  LDA #0
  STA PF0
  STA PF1
  STA PF2
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os

  JMP MAIN

; ── Note tables (the song) ─────────────────────────────────────────
; Format: pairs of (AUDF, length_frames). $FF AUDF = wrap sentinel.
; 60 frames = 1 second on NTSC. ~15-frame notes ≈ 4 notes/sec.
;
; Melody (voice 0): simple ascending/descending hook, 32 notes.
melody_notes:
  ; bar 1 — ascending
  .byte $0F, 12     ; C5-ish
  .byte $0D, 12
  .byte $0B, 12     ; E5-ish
  .byte $09, 12     ; G5-ish
  ; bar 2 — descending
  .byte $0B, 12
  .byte $0D, 12
  .byte $0F, 12
  .byte $11, 24     ; held A4-ish
  ; bar 3 — call
  .byte $0D, 12
  .byte $0B, 12
  .byte $09, 18
  .byte $07, 18     ; high note
  ; bar 4 — response
  .byte $09, 12
  .byte $0B, 12
  .byte $0D, 24
  .byte $0F, 24
  ; bar 5 — repeat with variation
  .byte $0F, 12
  .byte $0B, 12
  .byte $0D, 12
  .byte $09, 12
  ; bar 6
  .byte $07, 18
  .byte $09, 18
  .byte $0B, 18
  .byte $0F, 18
  ; bar 7 — tail
  .byte $0D, 24
  .byte $0B, 24
  .byte $0F, 24
  .byte $11, 36
  .byte $FF         ; wrap

; Bass (voice 1): root-fifth ostinato underneath, 16 notes, slower.
bass_notes:
  .byte $1F, 30     ; low C
  .byte $17, 30     ; G
  .byte $1F, 30
  .byte $17, 30
  .byte $1B, 30     ; low E
  .byte $13, 30     ; B
  .byte $1B, 30
  .byte $13, 30
  .byte $1D, 30     ; low D
  .byte $15, 30     ; A
  .byte $1D, 30
  .byte $15, 30
  .byte $1F, 30
  .byte $17, 30
  .byte $1F, 30
  .byte $17, 30
  .byte $FF         ; wrap

; ── "MUSIC" playfield patterns ──────────────────────────────────────
; CTRLPF bit 0 (reflected mode) is set, so PF1+PF2 occupy the left half
; of the screen and mirror to the right. We have 16 distinct rows; each
; one is used for 2 scanlines (so the band is 32 lines tall).
;
; PF1 bits are written MSB-first to screen pixels 16..23 (8 bits).
; PF2 bits are written LSB-first to screen pixels 24..31 (8 bits).
; We populate a few rows with rough letterforms and leave others blank
; for visual separation. The exact glyph isn't load-bearing — point is
; "something visible on screen so we know the ROM booted".
LETTERS_PF1:
  .byte %00000000
  .byte %11000011    ; M  /  U  /  S  ... approximated as bars
  .byte %11100111
  .byte %11010101
  .byte %11001001
  .byte %11000001
  .byte %11000001
  .byte %11000001
  .byte %11000001
  .byte %11000001
  .byte %11000001
  .byte %11000001
  .byte %11000001
  .byte %01111110
  .byte %00111100
  .byte %00000000

LETTERS_PF2:
  .byte %00000000
  .byte %11000011
  .byte %11100111
  .byte %10100101
  .byte %10010001
  .byte %10000001
  .byte %10000001
  .byte %01111110
  .byte %00000000
  .byte %01111110
  .byte %10000001
  .byte %10000001
  .byte %10000001
  .byte %10000001
  .byte %10000001
  .byte %00000000

  ; ── Vector table ──────────────────────────────────────────────────
  org $FFFA
  .word START
  .word START
  .word START

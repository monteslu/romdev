; ── Play a SID note on voice 1 ──────────────────────────────────────
; Sets ADSR envelope + waveform + gate-on for SID voice 1. Caller
; provides 16-bit frequency in (A=lo, X=hi). Note doesn't stop until
; you write SID_CTRL with the gate bit cleared.

.export _sid_play_note

SID_FREQ_LO1 = $D400
SID_FREQ_HI1 = $D401
SID_AD1      = $D405
SID_SR1      = $D406
SID_CTRL1    = $D404
SID_VOLUME   = $D418

; Frequency table for A-4 = 440 Hz ≈ 7493 = $1D45 (PAL clock).
; Caller can use these or compute their own.
.export _sid_freq_a4
_sid_freq_a4 = $1D45

.proc _sid_play_note
    ; Master volume = 15 (max), no filter.
    LDY #$0F
    STY SID_VOLUME

    ; Voice 1 frequency.
    STA SID_FREQ_LO1
    STX SID_FREQ_HI1

    ; Attack=2 / Decay=2 (snappy), Sustain=$E / Release=$8.
    LDY #$22
    STY SID_AD1
    LDY #$E8
    STY SID_SR1

    ; Gate ON with sawtooth wave.
    LDY #$21                    ; bit 0 = gate, bit 5 = sawtooth
    STY SID_CTRL1
    RTS
.endproc

; Call to release the note (turn gate off).
.export _sid_release_note
.proc _sid_release_note
    LDA SID_CTRL1
    AND #$FE                    ; clear gate bit
    STA SID_CTRL1
    RTS
.endproc

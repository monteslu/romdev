; SNES — safe NMI/VBlank handler skeleton.
;
; The 65816's NMI is ALWAYS native-mode + 16-bit-A/X when used from a
; native-mode program. Two non-obvious gotchas this snippet handles:
;
; 1. **DB (data bank) preservation**. The CPU does NOT restore DB on RTI.
;    If your main code is running in bank $80 and your NMI runs DMA
;    relative to bank $00, you MUST push DB/restore DB. Forgetting this
;    silently breaks the next "lda $1234" in main code (it reads from
;    the wrong bank). 20-minute bug to track down with a "my DMA broke"
;    symptom.
;
; 2. **M/X flag width preservation**. NMI doesn't reset M/X. If main code
;    was running with 8-bit A (M=1) when the NMI fired, your 16-bit `lda
;    #$1234` in the handler will silently load only $34. Always set
;    M=X=0 (`rep #$30`) at the top of NMI, and restore via the pushed P
;    on RTI.
;
; 3. **$4210 NMI flag**. The hardware NMI flag latches until $4210 is
;    READ. Reading it acks the interrupt. If you don't, the next vblank
;    won't re-fire NMI correctly on some hardware.
;
; 4. **Vblank-ready flag**. Main code's "wait for vblank" loop should
;    test a software flag set BY the NMI, not poll $4212 directly —
;    polling races with the NMI fire and you'll miss vblanks.
;
; This skeleton: pushes A/X/Y/D/B + P, sets 16-bit registers + bank $00,
; acks NMI, runs whatever VBlank-time work you want (typically DMA),
; sets the vblank flag for main code to consume, then pops everything.

nmi:
  ; ---- save full register state ----
  php                       ; preserve P (M/X widths AND processor flags)
  rep #$30                  ; force 16-bit A/X/Y so the pushes are wide
  pha                       ; push A.W
  phx                       ; push X.W
  phy                       ; push Y.W
  phd                       ; push DP
  phb                       ; push DB (bank)
  ; ---- normalize bank + DP for the handler ----
  lda #$0000
  tcd                       ; set DP = $0000
  sep #$20                  ; 8-bit A for the bank store
  pha                       ; A = $00 still in low byte; trick: actually load explicitly
  lda #$00
  pha
  plb                       ; pull bank = $00
  rep #$20                  ; back to 16-bit A

  ; ---- ack NMI ----
  lda $4210                 ; read clears NMI flag (8-bit read in 16-bit A is fine; low byte is the flag)

  ; ---- your VBlank-time work here ----
  ; common: OAM DMA, palette upload, VRAM tile transfers.
  ; jsr do_oam_dma
  ; jsr upload_pending_vram

  ; ---- set the vblank-ready flag ----
  lda #$0001
  sta vblank_ready          ; main code's `wai` loop tests this

  ; ---- restore ----
  plb                       ; restore DB
  pld                       ; restore DP
  ply
  plx
  pla
  plp                       ; restore P (and thus M/X widths)
  rti

; In your main loop:
;   wait_vblank:
;     wai
;     lda vblank_ready
;     beq wait_vblank       ; spurious wake — try again
;     stz vblank_ready
;     ; ... your per-frame logic here ...

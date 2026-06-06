; NES — safe NMI/VBlank handler skeleton.
;
; The NES 6502's NMI doesn't preserve registers — you MUST push them
; yourself. Gotchas this snippet covers:
;
; 1. **Register preservation.** Push A, X, Y. Without this, your main
;    code's loop variable gets clobbered mid-frame and animations break
;    in inscrutable ways.
;
; 2. **PPU register order.** OAM DMA ($4014) must run with the OAM
;    address ($2003) reset to 0 first. If main code was mid-PPU-access
;    when NMI fired, the address may be at random offsets.
;
; 3. **PPUSTATUS ($2002) clears the vblank flag on read.** A read in
;    NMI is fine, but be aware that reading it from main code (e.g. in
;    a wait_vblank loop) will lose the next NMI's "vblank started"
;    signal if you race.
;
; 4. **vblank_ready flag.** Main-code loops should test a software flag
;    that NMI sets, not poll $2002 directly. Polling races NMI's read.
;
; This skeleton: push A/X/Y, do OAM DMA + any pending PPU writes, set
; the vblank flag, restore registers.

.proc nmi_handler
  ; ---- preserve regs ----
  pha
  txa
  pha
  tya
  pha

  ; ---- OAM DMA (typically the first thing in VBlank) ----
  lda #$00
  sta $2003                ; OAMADDR = 0
  lda #$02                 ; soft-OAM at $0200
  sta $4014                ; trigger 256-byte DMA

  ; ---- per-frame PPU work goes here ----
  ; e.g. palette updates, nametable patches via PPUDATA $2007
  ; jsr update_palette_if_changed

  ; ---- set vblank-ready flag for main code ----
  lda #1
  sta vblank_ready

  ; ---- restore + return ----
  pla
  tay
  pla
  tax
  pla
  rti
.endproc

; In your main loop:
;   wait_vblank:
;     lda vblank_ready
;     beq wait_vblank
;     lda #0
;     sta vblank_ready
;     ; ... per-frame logic ...
;
; ---- ZP reservations ----
;   vblank_ready: .res 1   ; set by NMI, consumed by main loop

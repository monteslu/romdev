; Genesis — waiting for VBlank without using interrupts.
;
; The VDP has a "vertical blanking in progress" status flag at bit 3
; of the VDP control register ($C00004 when read). When this bit is
; set, the electron beam is in the vblank interval — safe to write
; VRAM/CRAM/VSRAM, do DMA, etc.
;
; The cleanest way to do per-frame work is with the VINT interrupt
; (see nmi_safe.s). But for early-init code, simple games, or
; debugging it's often easier to busy-wait on the status bit.
;
; ** Two patterns, both work: **
;
; Pattern 1: wait for the START of vblank (used when you have one
; chunk of vblank-safe work, e.g. one DMA).
;
;   wait_vblank_start:
;     btst    #3, $C00005     ; bit 3 of status (note: low byte!)
;     beq.s   wait_vblank_start
;     rts
;
; Pattern 2: wait for vblank to END (used when you want to start
; doing work right when active-display begins, e.g. for raster
; effects).
;
;   wait_vblank_end:
;     btst    #3, $C00005
;     bne.s   wait_vblank_end
;     rts
;
; ** Gotcha — the status word is BIG-ENDIAN. ** $C00004 returns the
; high byte first; bit 3 of the LOW byte (which the documentation
; usually means by "bit 3 of the status") is actually accessed at
; $C00005. The btst above gets this right; some older Genesis dev
; docs forget and test the wrong address, producing code that loops
; forever or never waits.

VDP_CTRL   equ $C00004
VDP_STATUS equ $C00005    ; low byte of the status word

wait_vblank_start:
  btst    #3,VDP_STATUS
  beq.s   wait_vblank_start
  rts

wait_vblank_end:
  btst    #3,VDP_STATUS
  bne.s   wait_vblank_end
  rts

; ---- "Wait for the next vblank, then do work" idiom ------------------
;
; The most common pattern: complete the previous frame's logic, then
; wait for the next vblank to start, then do all your vblank-safe work
; (DMA, palette updates, etc.). Use this in your main game loop:
;
;   game_loop:
;     ; ... per-frame game logic (collision, AI, input response) ...
;     jsr     wait_vblank_end       ; finish current frame if mid-vblank
;     jsr     wait_vblank_start     ; sync to next vblank
;     ; ... vblank-safe work (DMA, palette, etc.) ...
;     jsr     dma_sprite_table
;     bra.s   game_loop
;
; The "wait_vblank_end first" ensures you start fresh — if your logic
; finished early and you're already in vblank, you'd otherwise return
; from wait_vblank_start immediately and have less than a frame of
; vblank-safe time left.
;
; ** This pattern blocks the CPU 100% **, which is fine for simple
; games. For complex games that need the CPU running during active
; display (running game logic, AI, etc.), switch to the VINT-based
; pattern in nmi_safe.s.

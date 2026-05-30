; Genesis 68000 — safe VBlank interrupt handler skeleton.
;
; The 68K has 7 interrupt levels; the VDP fires:
;   level 4 = HINT (horizontal blank — fires once per N scanlines, per VDP reg $0A)
;   level 6 = VINT (vertical blank — fires once per frame)
; The CPU's SR bits 8-10 hold the interrupt mask. While mask >= the
; interrupt's level, the interrupt is held off. Most game init code sets
; mask to 7 ($2700 in SR) to block everything, then drops to 1 or 0
; once VBlank is wanted.
;
; Critical gotchas this skeleton handles:
;
; 1. **The vector table at $00-$0FF points at handlers.** vasm68k will
;    happily build a ROM with random garbage at vector $78 (VINT vector)
;    if you forget; the CPU will then jump to garbage on the first VBlank.
;    See header.s for the vector table.
;
; 2. **You must save registers.** The 68K interrupt doesn't auto-save
;    D0-D7/A0-A6 — only PC + SR. If your handler touches D0 without
;    saving it, main code's D0 gets clobbered.
;
; 3. **VDP DMA during active display is unsafe.** The window of opportunity
;    is during VBlank or HBlank — outside those, DMAing causes visible
;    artifacts (snow on the screen as the VDP's own access is starved).
;    The VINT handler is the safe place to do bulk VRAM transfers.
;
; 4. **Read VDP status to clear the interrupt.** Reading $C00004 (control
;    port) returns the VDP status word AND acknowledges the interrupt.
;    Without this read, the next VINT will fire immediately on return.
;
; 5. **Set a vblank_ready flag.** Main loop should test this flag rather
;    than poll the VDP status directly — polling races with the VINT
;    and you'll miss frames.

VDP_CTRL = $C00004

vint_handler:
  ; ---- save full register state ----
  movem.l d0-d7/a0-a6,-(sp)

  ; ---- ack the interrupt by reading VDP status ----
  move.w  VDP_CTRL,d0

  ; ---- per-frame VBlank work goes here ----
  ; common: DMA sprite table, palette updates, sound driver tick.
  ; jsr     dma_sprite_table
  ; jsr     update_palette_if_changed
  ; jsr     sound_driver_tick

  ; ---- set vblank_ready flag for main loop ----
  st      vblank_ready          ; sets to $FF (any nonzero)

  ; ---- restore registers + return ----
  movem.l (sp)+,d0-d7/a0-a6
  rte

hint_handler:
  ; HINT skeleton — typically used for raster effects (per-scanline
  ; scroll change, palette swap, sprite multiplexing). Keep it FAST:
  ; you have ~488 CPU cycles between HINTs at 320x224, less if HINT
  ; counter is low.
  movem.l d0/a0,-(sp)
  move.w  VDP_CTRL,d0          ; ack
  ; ... your per-scanline work ...
  movem.l (sp)+,d0/a0
  rte

; ---- main loop pattern ----
;   wait_vblank:
;     tst.b   vblank_ready
;     beq.s   wait_vblank
;     clr.b   vblank_ready
;     ; ... per-frame game logic ...
;     bra.s   wait_vblank
;
; ---- BSS reservation ----
;   .bss
;   .align 2
; vblank_ready: ds.b 1

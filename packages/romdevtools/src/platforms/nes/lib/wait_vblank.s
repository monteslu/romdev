; NES — wait for vblank (PPU status bit 7).
;
; Use during reset / setup before touching PPU registers, so you know the
; PPU is in a safe state. Standard idiom: two waits before enabling
; rendering, because the PPU is unstable for the first ~30k cycles.

.proc wait_vblank
@wait:
  bit $2002
  bpl @wait
  rts
.endproc

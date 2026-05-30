; Game Boy vblank wait — polls the LY register.
;
; $FF44 = LY (current scanline). The PPU's vblank period is scanlines
; 144..153. The cheapest reliable vblank wait is:
;
;   ld a, [$FF44]
;   cp 144
;   jr c, .wait     ; if LY < 144, still drawing — keep waiting
;
; But this returns when ANY part of vblank starts — could be 1 line in
; or 9 lines in. For tighter sync, wait for LY == 144 explicitly.
;
; Better still: enable the vblank IRQ ($FF0F bit 0, $FFFF bit 0) and
; have your ISR set a flag in HRAM, then `halt` until IRQ. Halt saves
; battery on a real DMG. See vblank_irq.asm for that path.

vblank_wait_poll::
.wait
  ld a, [$FF44]
  cp 144
  jr c, .wait
  ret

; Wait specifically until vblank STARTS (LY = 144). Use this if your
; subsequent VRAM writes need maximum vblank time.
vblank_wait_start::
.wait
  ld a, [$FF44]
  cp 144
  jr nz, .wait
  ret

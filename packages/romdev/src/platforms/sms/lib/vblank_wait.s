; SMS vblank — wait pattern.
;
; The VDP status flag (read from $BF) has bit 7 = vblank-frame interrupt
; pending. Reading $BF clears the flag, so you can spin on it.
;
; Two patterns shipped here:
;
;   vblank_wait_poll  — busy-wait, reads $BF until bit 7 set. Use during
;                       setup before you've enabled interrupts.
;
;   vblank_wait_irq   — assumes you've set up IM 1 with HL → an ISR that
;                       toggles a flag in zero page; this just halts and
;                       waits for the IRQ to fire. Cheaper on the CPU but
;                       requires the IRQ wiring first.

vblank_wait_poll:
        in a,(VDP_CTRL)          ; read status; clears bit 7
        bit 7,a                  ; was the flag set?
        jr z,vblank_wait_poll
        ret

; IM 1 version — caller must:
;   - set up IRQ vector at $38 to jr to a stub that writes a non-zero
;     value to (_vblank_flag) and reti
;   - call this with interrupts enabled (ei + im 1 done in init)
vblank_wait_irq:
        xor a
        ld (_vblank_flag),a
_vw_spin:
        ld a,(_vblank_flag)
        or a
        jr z,_vw_spin
        ret

_vblank_flag .equ $C000          ; one byte in WRAM
VDP_CTRL .equ $BF

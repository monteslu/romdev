; SMS VDP — minimum viable initialization.
;
; The VDP exposes 11 registers (R0..R10). After power-on they're undefined
; — programming the standard "Mode 4, display off" baseline is the first
; thing any SMS ROM does before uploading tiles, palette, or name table.
;
; To write a VDP register from Z80: send a 16-bit value to the control
; port ($BF) as two bytes. The HIGH byte encodes the register number with
; the top bit set: $80 | reg_num. The LOW byte (written FIRST) is the
; value. So to write R0 = $36: out ($BF),$36 / out ($BF),$80.
;
; CALLING CONVENTION: assumes interrupts already disabled (di) and SP set.
; Returns with display still OFF — call your tile / palette / map loaders
; first, then re-write R1 with bit 6 set to enable rendering.

VDP_DATA equ $BE
VDP_CTRL equ $BF

vdp_init:
        ld hl,_vdp_init_regs
        ld b,11                  ; 11 regs to write
        ld c,$BF                 ; VDP control port

_vdp_init_loop:
        ld a,(hl)                ; register value
        out (c),a                ; write value (LSB)
        ld a,$80
        sub b                    ; reg number = 11 - B; first iteration B=11 → reg 0
        add a,$0B
        or a,$80                 ; set "this is a register write" bit
        out (c),a
        inc hl
        djnz _vdp_init_loop
        ret

_vdp_init_regs:
        .db $36                  ; R0: Mode 4, no scroll lock, mask col 0, line IRQ off
        .db $80                  ; R1: display OFF, vblank IRQ off, 192-line mode
        .db $FF                  ; R2: name table at $3800  (($3800 >> 10) | 0x01) — high bit ignored
        .db $FF                  ; R3: color table — M4 ignores
        .db $FF                  ; R4: BG tile data — M4: bit 2 selects $0000 vs $2000
        .db $FF                  ; R5: sprite attr table base ($3F00 = $7E << 7)
        .db $FF                  ; R6: sprite tile data at $2000 (SA13 set; scaffolds upload here)
        .db $00                  ; R7: border color = sprite palette entry 0
        .db $00                  ; R8: BG X scroll
        .db $00                  ; R9: BG Y scroll
        .db $FF                  ; R10: line IRQ counter (disabled)

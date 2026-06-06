; Hello, Genesis — a real hello-world scaffold for vasm68k_mot.
;
; What this does:
;   1. Vector table (SP + reset, rest stubs).
;   2. ROM header at $100 (256 bytes — gpgx auto-skips this if minimal).
;   3. Init: program VDP registers for 320x224 H40 mode, sane defaults.
;   4. Upload a 4-color palette to CRAM.
;   5. Write one 4bpp tile (a yellow 'H') into VRAM at tile $0001.
;   6. Place that tile near screen center in plane A.
;   7. Enable display and park forever.
;
; BUILD:
;   buildSource({ platform: "genesis", source: /* this file */ });
;
; vasm syntax gotchas (in case you go beyond this scaffold):
;   - NO space after commas in operands: `move.w #$2700, sr` FAILS.
;     Write `move.w #$2700,sr` instead.
;   - WRAM at $FF0000-$FFFFFF: use `equ` for variable addresses, not
;     `org $00FF0000` (that produces a 16MB ROM).
;   - VDP control reg ($C00004) takes 16-bit writes; VDP data ($C00000)
;     also 16-bit. Always pair high+low.
;
; See getStarterSnippet({platform:"genesis", name:"..."}) for richer
; building blocks (vdp_init, vblank_wait, pad_read, sprite_table, etc.)
; and src/platforms/genesis/lib/README.md for the full quickstart.

; -----------------------------------------------------------------------
; Memory map — VDP ports.
VDP_DATA    equ $C00000     ; word-write data port
VDP_CTRL    equ $C00004     ; word-write control port (also reads status)

; CRAM (color) word offsets: each entry is BGR-555 in low 12 bits.
; Format constants below build VRAM/CRAM/VSRAM write commands.

; -----------------------------------------------------------------------
; Vector table at $000000.
        org     $000000
        dc.l    $00FFE000          ; initial stack pointer
        dc.l    Start              ; reset vector
        dcb.l   62,Exception       ; rest of vectors → exception stub

; -----------------------------------------------------------------------
; ROM header at $000100 (256 bytes). Many of these fields don't matter
; for emulators; gpgx accepts mostly-empty headers fine.
        org     $000100
        dc.b    'SEGA GENESIS    '              ; console name (16 bytes)
        dc.b    '(C)ROMDEV 2026.MAY'            ; copyright (16 bytes)
        dc.b    'HELLO WORLD                                     '  ; domestic name (48)
        dc.b    'HELLO WORLD                                     '  ; intl name (48)
        dc.b    'GM 00000000-00'                ; serial (14)
        dc.w    $0000                           ; checksum
        dc.b    'J               '              ; I/O support (16)
        dc.l    $00000000                       ; ROM start
        dc.l    $000FFFFF                       ; ROM end (1MB cap)
        dc.l    $00FF0000                       ; RAM start
        dc.l    $00FFFFFF                       ; RAM end
        dc.b    '            '                  ; SRAM info (12)
        dc.b    '                                        '  ; notes (40)
        dc.b    'JUE             '              ; region (16)

; -----------------------------------------------------------------------
; Exception handler — minimal, just spin.
        org     $000200
Exception:
        bra     Exception

; -----------------------------------------------------------------------
; Reset entry point.
Start:
        move.w  #$2700,sr               ; disable interrupts (NO space after comma!)

        ; Wait a few cycles for the Z80 to settle.
        ; (Real code grants Z80 bus and resets it — omitted here for brevity.)

        ; -----------------------------------------------------------
        ; Program VDP registers for 320x224 H40 mode. Register-write
        ; format: $8000 | (reg << 8) | value, written to VDP_CTRL.
        lea     VDP_CTRL,a0
        lea     VDPRegs(pc),a1
        moveq   #18-1,d0             ; 18 register writes
.vdp_loop:
        move.w  (a1)+,(a0)
        dbra    d0,.vdp_loop

        ; -----------------------------------------------------------
        ; Upload palette 0 to CRAM (4 colors).
        ; CRAM write command: $C0000003 (addr 0, code 3 = CRAM write).
        move.l  #$C0000000,VDP_CTRL
        move.w  #$0000,VDP_DATA      ; color 0: transparent / backdrop
        move.w  #$0EEE,VDP_DATA      ; color 1: white-ish ($0E in each nybble)
        move.w  #$00EE,VDP_DATA      ; color 2: yellow
        move.w  #$0E00,VDP_DATA      ; color 3: blue (unused)

        ; -----------------------------------------------------------
        ; Upload one 4bpp tile (8x8 'H', color 2 = yellow) to VRAM at
        ; tile #1 (byte offset $20). Tile data is 32 bytes (8 rows × 4
        ; bytes/row at 4bpp). Each byte = 2 pixels (high nybble = left).
        ;
        ; VRAM write command for byte $0020 = $40200000.
        move.l  #$40200000,VDP_CTRL
        lea     TileH(pc),a1
        moveq   #8-1,d0              ; 8 rows
.tile_loop:
        move.l  (a1)+,VDP_DATA       ; each row = one longword (4 bytes)
        dbra    d0,.tile_loop

        ; -----------------------------------------------------------
        ; Place tile #1 in plane A near screen center.
        ; Plane A base is at VRAM $C000 (default after VDP init).
        ; Cell (col, row) = (20, 14). Plane A is 64 cells wide here, so
        ; byte offset = ((14*64) + 20) * 2 = 1832 = $728.
        ; VRAM write to plane A cell: $C000 + $728 = $C728.
        ; VDP cmd for VRAM write at $C728 = $40080003 = ... compute:
        ;   addr lo = $C728 & $3FFF = $0728
        ;   addr hi = ($C728 >> 14) | code(VRAM_W=$01) = $03 | $01 = $03
        ; → $40280003
        move.l  #$40280003,VDP_CTRL
        move.w  #$0001,VDP_DATA      ; tile #1, palette 0, no flip, low pri

        ; -----------------------------------------------------------
        ; Enable display (VDP reg 1, bit 6).
        move.w  #$8174,VDP_CTRL      ; reg 1 = $74 (display on + V28 + DMA en)

Forever:
        bra     Forever

; -----------------------------------------------------------------------
; VDP register init values. 18 registers programmed at boot.
VDPRegs:
        dc.w    $8004    ; reg 0:  no HInt, palette, disable display
        dc.w    $8134    ; reg 1:  display OFF for now (we re-enable later)
        dc.w    $8230    ; reg 2:  plane A name table at $C000
        dc.w    $8300    ; reg 3:  window name table at $0000 (unused)
        dc.w    $8407    ; reg 4:  plane B name table at $E000
        dc.w    $855C    ; reg 5:  sprite table at $B800
        dc.w    $8600    ; reg 6:  unused
        dc.w    $8700    ; reg 7:  backdrop color = palette 0, color 0
        dc.w    $8800    ; reg 8/9: unused
        dc.w    $8900
        dc.w    $8AFF    ; reg 10: HInterrupt counter (max)
        dc.w    $8B00    ; reg 11: no full-screen scroll
        dc.w    $8C81    ; reg 12: H40 mode (320 wide)
        dc.w    $8D2F    ; reg 13: HScroll table at $B400
        dc.w    $8E00    ; reg 14: unused
        dc.w    $8F02    ; reg 15: auto-increment +2
        dc.w    $9001    ; reg 16: plane size = 64x32 (H64 V32)
        dc.w    $9100    ; reg 17: window x off
        dc.w    $9200    ; (extra) window y off — included for safety

; -----------------------------------------------------------------------
; 4bpp tile data for 'H' — color index 2 (yellow) where bit set.
; 8 rows × 4 bytes/row. High nybble of each byte = left pixel.
TileH:
        dc.l    $20000020       ; row 0: 2.....2  → 0010 0000 0000 0000 0000 0000 0010 0000
        dc.l    $20000020
        dc.l    $20000020
        dc.l    $22222220       ; row 3: 2222222.
        dc.l    $20000020
        dc.l    $20000020
        dc.l    $20000020
        dc.l    $00000000       ; row 7: blank

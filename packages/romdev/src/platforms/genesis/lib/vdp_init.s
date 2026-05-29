; Genesis VDP — minimum viable initialization.
;
; The VDP has 24 registers ($00-$17) controlling video output. After power
; on they're undefined; if you start rendering without programming them,
; you'll see nothing or garbage. This snippet writes the standard "320x224
; H40 mode, BG color 0, both planes enabled" config — adequate for getting
; pixels on screen so you can iterate from there.
;
; VDP I/O addresses:
;   $C00000 = data port (16-bit reads/writes for VRAM/CRAM/VSRAM data)
;   $C00004 = control port (writes set the destination address + access mode)
;   $C00008 = HV counter (read-only)
;
; To write a VDP register: send (0x8000 | (reg_num << 8) | value) to the
; control port. The 0x8000 distinguishes a register write from a memory-
; address-set (which would be a different format).

VDP_DATA  = $C00000
VDP_CTRL  = $C00004

; ---- Register table — 24 bytes, indexed by register number ($00-$17) ----
;
; The bit semantics here are SUBTLE. Look up the VDP register reference
; (NESdev wiki has a great one) before changing values. Some highlights:
;   $00: HV counter latch + interrupt enables. Bit 4 = enable HINT.
;   $01: display enable (bit 6), VINT enable (bit 5), DMA enable (bit 4)
;        and the cell-mode bit (bit 3 = 240-line mode for PAL).
;        ** Without bit 6 (display) set, your screen stays blank. **
;   $0A: HINT counter — # of lines between HINT triggers. $FF = disabled.
;   $0B: vertical scroll mode + horizontal scroll mode. Bit 2 = "full
;        screen" V scroll; clear it for "per-cell" V scroll.
;   $0C: bit 0 = H40 mode (320 wide). Clear for H32 (256 wide).
;   $0F: VDP auto-increment after each data access. 2 = "next word".
;   $10: Plane A/B size (in cells). 0x01 = 64 x 32, 0x11 = 64 x 64, etc.
;
; Plane A name table base, Plane B name table base, Window name table base,
; Sprite attribute table base, HScroll table base — all configured in
; registers $02-$06 below.

vdp_init_table:
  dc.b $14   ; $00: HINT enable, HV counter on
  dc.b $74   ; $01: display ON, VINT ON, DMA ON, 224-line NTSC
  dc.b $30   ; $02: Plane A base = $C000 (× $400 = VRAM offset)
  dc.b $00   ; $03: Window base
  dc.b $07   ; $04: Plane B base = $E000
  dc.b $78   ; $05: Sprite attr table = $F000 (× $200, H40-aligned)
  dc.b $00   ; $06: unused
  dc.b $00   ; $07: backdrop color — palette 0, color 0 (universal BG)
  dc.b $00   ; $08: unused
  dc.b $00   ; $09: unused
  dc.b $FF   ; $0A: HINT counter — $FF = once per frame (essentially off)
  dc.b $00   ; $0B: V scroll = full-screen, H scroll = full-screen
  dc.b $81   ; $0C: H40 mode (320 wide), shadow/highlight off
  dc.b $3F   ; $0D: HScroll table = $FC00
  dc.b $00   ; $0E: unused
  dc.b $02   ; $0F: auto-increment = 2 (next word)
  dc.b $01   ; $10: Plane size = 64x32
  dc.b $00   ; $11: Window H pos
  dc.b $00   ; $12: Window V pos
  dc.b $FF   ; $13: DMA length low
  dc.b $FF   ; $14: DMA length high
  dc.b $00   ; $15: DMA source low
  dc.b $00   ; $16: DMA source mid
  dc.b $80   ; $17: DMA source high + mode bits

; ---- vdp_init: blast the table into the VDP -----------------------------
;
; Call this near the start of _reset, before enabling interrupts. Writes
; all 24 registers in sequence; this leaves the VDP in a sensible state
; for you to start uploading tiles, palettes, sprites, etc.
vdp_init:
  lea     vdp_init_table,a0
  move.l  #VDP_CTRL,a1
  moveq   #0,d0                ; register index counter
  moveq   #23,d1               ; 24 registers - 1
.loop:
  move.b  (a0)+,d2             ; value
  move.w  d0,d3
  lsl.w   #8,d3                ; reg << 8
  or.w    #$8000,d3            ; "this is a register write" marker
  or.b    d2,d3                ; ... | value
  move.w  d3,(a1)
  addq.w  #1,d0
  dbra    d1,.loop
  rts

; SNES — populating the OAM sprite table (with the gotchas spelled out).
;
; SNES OAM is 544 bytes split into two regions:
;
;   "low table" — 512 bytes at OAM addresses $00..$1FF.
;     128 sprites × 4 bytes each:
;       byte 0: X position (low 8 bits)
;       byte 1: Y position
;       byte 2: tile number (low 8 bits)
;       byte 3: vhoopppN   ← V flip, H flip, priority(2), palette(3), name-table bit
;
;   "high table" — 32 bytes at OAM addresses $200..$21F.
;     Packs 2 bits per sprite × 128 sprites:
;       bit 0: X high (extends X to 9 bits, so sprites can wrap to -1..-W)
;       bit 1: size   (0 = small per OBSEL, 1 = large per OBSEL)
;
; **The high-table is the bug magnet.** Writing the low table without
; the corresponding hi-table entry means the size bit defaults to
; whatever was previously there, AND your sprite's X high bit may be
; stuck — making sprite 3 appear at X=$1FF (off-screen-right) when you
; wrote X=$80 to its low byte. The rom-games agent burned 4 hours on
; exactly this in the snes-invaders rebuild.
;
; Workflow:
;   1. Build the sprite table in WRAM ($0200..$041F is the typical layout:
;      512 bytes low + 32 bytes high = a "soft OAM").
;   2. At vblank, DMA the whole 544-byte block to OAM via channel 0.
;   3. Update sprites by writing to WRAM, not directly to OAM (which is
;      forbidden during display anyway).

; ---- low-table layout offsets per sprite ----
;   slot N occupies bytes (N * 4) .. (N * 4 + 3) in soft_oam_low
SOFT_OAM_LOW   = $0200    ; 512 bytes in WRAM
SOFT_OAM_HIGH  = $0400    ; 32 bytes immediately after low table

; ---- write sprite N at (x, y) tile T attr A ----
; Inputs (16-bit A, 16-bit X):
;   X = slot index (0..127)
;   Stack push order: x_low, y, tile_low, attr, x_high (0 or 1), large_size (0 or 1)
; This is verbose; in real code you'd cache the slot offset and DP-relative
; the four byte stores. Shown longhand here for clarity.

write_sprite:
  ; ---- low table: 4 bytes ----
  sep #$20                  ; 8-bit A for byte writes
  txa                       ; A = slot
  asl                       ; * 2
  asl                       ; * 4 = byte offset into low table
  tay                       ; Y = byte offset
  lda x_lo
  sta SOFT_OAM_LOW + 0,y
  lda y_pos
  sta SOFT_OAM_LOW + 1,y
  lda tile_lo
  sta SOFT_OAM_LOW + 2,y
  lda attr_byte
  sta SOFT_OAM_LOW + 3,y

  ; ---- high table: pack 2 bits into the right slot in $0400..$041F ----
  ; sprite N's 2 bits live at byte (N >> 2) in the hi table, shifted
  ; left by ((N & 3) * 2). So slot 0 = bits 0-1 of byte 0; slot 3 = bits 6-7
  ; of byte 0; slot 4 = bits 0-1 of byte 1; etc.
  txa                       ; slot in low byte of A
  lsr
  lsr                       ; A = slot >> 2 = byte offset in hi table
  tay
  txa
  and #$03                  ; A = slot & 3
  asl                       ; * 2 = bit shift amount
  tax                       ; X = shift amount
  lda #$03
.shift_mask:
  cpx #0
  beq .mask_done
  asl                       ; shift mask up
  dex
  bra .shift_mask
.mask_done:
  eor #$FF                  ; A = inverted mask (clear-this-slot bits)
  and SOFT_OAM_HIGH,y       ; clear this slot's 2 bits
  ; now OR in (x_high | (large_size << 1)), shifted by the original X
  ; (which we lost when we used X as the shift counter — recompute):
  ; ... for brevity, assume the caller already shifted (x_high | (sz<<1)) into the
  ; right position and we just OR it here. Real code uses a small table
  ; lookup to avoid the shift loop.
  ora hi_bits_shifted
  sta SOFT_OAM_HIGH,y
  rep #$20                  ; back to 16-bit A
  rts

; ---- attr byte layout (byte 3 of each low entry) ----
;   bit 0: name-table bit. Combined with the low-byte tile gives 9-bit tile
;          number. Bit 0 = 0 selects tiles 0..255 from the first sprite
;          chunk; = 1 selects 256..511 from the second chunk.
;   bits 1-3: palette (0..7 selects sprite palette 0..7)
;   bits 4-5: priority (0..3, higher = on top)
;   bit 6: H flip
;   bit 7: V flip

; ---- OBSEL ($2101) configures the two sizes the OBJ engine knows ----
;   bits 0-2: name base address in VRAM
;   bits 3-4: name select (gap between low and high CHR halves)
;   bits 5-7: sprite size pair:
;     000 = 8x8 / 16x16     001 = 8x8 / 32x32     010 = 8x8 / 64x64
;     011 = 16x16 / 32x32   100 = 16x16 / 64x64   101 = 32x32 / 64x64
;   The hi-table's "size" bit picks small or large.

; ---- OAM DMA at vblank ----
; In your NMI handler:
;   stz $2102                ; OAM address low = $00
;   stz $2103                ; OAM address high = $00 (with priority bit clear)
;   lda #$04                 ; channel 0
;   sta $4300                ; DMA mode: 1-byte, A-bus → B-bus, write to $2104
;   ldx #$2104
;   stx $4301                ; B-bus dest reg = $2104 (OAM data port)
;   ldx #SOFT_OAM_LOW
;   stx $4302                ; A-bus source low+mid
;   stz $4304                ; A-bus source bank = 0
;   ldx #544                 ; 544 bytes (512 low + 32 hi)
;   stx $4305                ; transfer size
;   lda #$01                 ; channel 0 enable bit
;   sta $420B                ; start DMA

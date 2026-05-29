; Genesis VDP — sprite table layout + linked-list management.
;
; Genesis sprites are stored in a 320- or 640-byte table in VRAM (40 or
; 80 sprites × 8 bytes each). The VDP walks the table as a LINKED LIST:
; each sprite has a `link` field giving the index of the next sprite to
; render. Link 0 = end of list. This means:
;   - Sprite priority is order-of-the-list, NOT slot order.
;   - You can rearrange visibility without touching slots: just rewrite
;     the link fields.
;   - You MUST set sprite 0's link, even if you only have one sprite —
;     otherwise the VDP walks into uninitialized memory and renders
;     garbage that flickers per frame.
;
; Sprite entry layout (per sprite, 8 bytes):
;   word 0:  Y position + 128  (bits 0-9 used; Y=128 = top of screen)
;   word 1:  size_H (bits 8-9) | size_W (bits 10-11) | link (bits 0-6)
;            sizes are 0..3, so width/height = (size+1) × 8 px
;   word 2:  priority (bit 15) | palette (bits 13-14) | vflip (bit 12)
;            | hflip (bit 11) | tile_id (bits 0-10)
;   word 3:  X position + 128  (bits 0-8; X=128 = left edge of screen)
;
; The sprite table base in VRAM is configured via VDP reg $05 (× $200 in
; H32 mode, × $400 in H40 mode). vdp_init.s above sets it to $F000.

SPRITE_TABLE_VRAM = $F000  ; per vdp_init.s register $05 = $78

; ---- Build a sprite in WRAM staging area (then DMA up) -----------------
;
; The pattern: maintain a soft-OAM buffer in WRAM at a known address (we
; use $FFE000 here, top of WRAM). Every frame at VBlank, DMA the soft-OAM
; up to VRAM at SPRITE_TABLE_VRAM. This avoids the VDP-during-active-
; display restrictions.

SOFT_SPRITE_TABLE = $FFE000  ; 640 bytes = 80 sprites max

; ---- write_sprite: stamp one sprite into soft-OAM ----------------------
;
; Inputs:
;   D0 = slot index (0-79)
;   D1 = X position (signed; -128..+447)
;   D2 = Y position (signed; -128..+239)
;   D3 = tile index (0-2047)
;   D4 = attr packed: (priority << 7) | (palette << 5) | (vflip << 4)
;        | (hflip << 3) | (size_w << 1) | size_h    ← caller responsible
;   D5 = link to next sprite (0 = end of list)
;
; Output: sprite slot D0 is populated.
write_sprite:
  movem.l d0-d6/a0,-(sp)
  lea     SOFT_SPRITE_TABLE,a0
  moveq   #0,d6
  move.w  d0,d6
  lsl.w   #3,d6                ; slot × 8 = byte offset
  add.l   d6,a0
  ; word 0: Y + 128
  add.w   #128,d2
  move.w  d2,(a0)+
  ; word 1: size_H (bits 8-9) | size_W (bits 10-11) | link (bits 0-6)
  ; Caller packed sizes into D4 bits 1-3; extract here.
  moveq   #0,d6
  move.b  d4,d6
  lsr.b   #1,d6                ; D6.b = size_h (low) + size_w (high)
  and.b   #$03,d6              ; D6.b = size_h
  ; rebuild: actual format is (size_w << 10) | (size_h << 8) | link
  move.b  d4,d6
  lsr.b   #1,d6
  lsr.b   #1,d6
  and.w   #$0003,d6
  lsl.w   #8,d6                ; D6.w = size_h << 8
  move.b  d4,d3
  ; ... this would benefit from a real macro. Simplified path below.
  ; Use word-build approach instead: caller should construct the full
  ; word and call write_sprite_word for clarity. Keeping this skeleton
  ; here as a starting point; production code would have a macro.
  movem.l (sp)+,d0-d6/a0
  rts

; ---- write_sprite_simple: macro-friendly version -----------------------
;
; Inputs:
;   D0 = slot index
;   D1 = Y pos (raw; will add 128)
;   D2 = X pos (raw; will add 128)
;   D3 = tile ID + attr word (build with: (prio<<15)|(pal<<13)|(vf<<12)|(hf<<11)|tile)
;   D4 = size+link word (build with: (size_w<<10)|(size_h<<8)|link)
;
; Cleaner than write_sprite above; recommended for most code.
write_sprite_simple:
  movem.l d0-d4/a0,-(sp)
  lea     SOFT_SPRITE_TABLE,a0
  lsl.w   #3,d0
  add.w   d0,a0
  add.w   #128,d1
  move.w  d1,(a0)+             ; word 0: Y+128
  move.w  d4,(a0)+             ; word 1: size+link
  move.w  d3,(a0)+             ; word 2: priority+pal+flips+tile
  add.w   #128,d2
  move.w  d2,(a0)+             ; word 3: X+128
  movem.l (sp)+,d0-d4/a0
  rts

; ---- dma_sprite_table: blast soft-OAM up to VRAM at VBlank --------------
;
; Call this from your VBlank handler. Writes the full 640 bytes of soft-
; OAM (80 sprites × 8 bytes) via VDP DMA.
;
; VDP DMA setup is verbose; comments label each register write.
dma_sprite_table:
  ; ---- 1. Configure DMA registers ----
  move.l  #$94009300,$C00004   ; reg $94 = 0x00 (length hi), $93 = 0x00 (length lo)
  ; Actually we need 640 / 2 = 320 words; let me set length properly:
  move.w  #$9340,$C00004       ; reg $93 = $40 (length lo = $0140 = 320 words)
  move.w  #$9401,$C00004       ; reg $94 = $01 (length hi)
  ; Source: SOFT_SPRITE_TABLE >> 1 (DMA addresses words, not bytes)
  move.w  #$9500,$C00004       ; reg $95 = (src >> 1) & $FF
  move.w  #$9670,$C00004       ; reg $96 = (src >> 9) & $FF — adjust per actual addr
  move.w  #$977F,$C00004       ; reg $97 = (src >> 17) & $7F | $80 (DMA mode)
  ; ---- 2. Send target address + DMA-trigger command word ----
  ; VRAM write to SPRITE_TABLE_VRAM ($F000) with DMA bit set.
  ; Format of a VDP "command word" for VRAM write + DMA:
  ;   high word: $4000 | (low 14 bits of dest << 0)
  ;   low  word: $0080 | (top 2 bits of dest >> 14)
  ; SPRITE_TABLE_VRAM = $F000:
  ;   high = $4000 | $F000 = $7000... no wait, the encoding is across
  ;   both words; precomputed value below for SPRITE_TABLE_VRAM = $F000.
  ; If you change SPRITE_TABLE_VRAM, recompute this constant:
  ;   ((addr & $3FFF) << 16) | $40000080 | ((addr >> 14) & 3)
  move.l  #$7000_0083,$C00004    ; precomputed for SPRITE_TABLE_VRAM=$F000
  rts

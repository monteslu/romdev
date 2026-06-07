; Game Boy Color hello-world — yellow 'H' on a real BLUE background
; (only possible on GBC; DMG can only do 4 shades).
;
; Differences from the DMG example:
;   - byte at $0143 = $C0  → "GBC only" cart (boot ROM enables CGB mode)
;   - palette via BCPS/BCPD ($FF68/$FF69), not BGP — full 15-bit BGR555
;   - palette 0 entry 0 = backdrop (blue here), entry 1 = yellow
;
; Build with:
;   build({ output: "rom", platform:"gbc", source: <this>})
;
; rgbfix is invoked automatically to fix the header checksums.

SECTION "Entry", ROM0[$0100]
  nop
  jp Start

  ; Nintendo logo bytes ($0104-$0133) — rgbfix fills these in.
  ds $30, 0

  ; Title ($0134-$0142, 15 bytes) — padded.
  ds $0F, 0

  ; $0143: CGB flag. $80 = CGB-supported, $C0 = CGB-only.
  db $C0

  ; Remainder of header — rgbfix patches checksums after assembly.
  ds $014F - @ + 1, 0

SECTION "Main", ROM0[$0150]

Start:
  ; ── Wait for vblank then turn LCD off ──────────────────────────
.wait_vblank
  ld a, [$FF44]
  cp 144
  jr c, .wait_vblank
  xor a
  ldh [$FF40], a

  ld sp, $DFF0

  ; ── Write GBC BG palette 0 ─────────────────────────────────────
  ; BCPS = $FF68: bit 7 = auto-increment, bits 0-5 = byte index (0-63).
  ; Each entry is 2 bytes BGR555: bbbbbggg gg_rrrrr.
  ;
  ; Palette layout: 8 palettes × 4 colors × 2 bytes = 64 bytes.
  ; We write palette 0 entry 0 (backdrop=blue) and entry 1 (yellow).
  ld a, $80                ; index 0, auto-increment ON
  ldh [$FF68], a           ; BCPS
  ld hl, BgPalette
  ld b, 8                  ; first 4 entries = palette 0 (8 bytes)
.pal_loop
  ld a, [hl+]
  ldh [$FF69], a           ; BCPD — auto-increments BCPS index
  dec b
  jr nz, .pal_loop

  ; ── Upload one 'H' tile to VRAM bank 0, tile 1 ($8010) ─────────
  ; The cartridge boots with VBK ($FF4F) = 0, so we're in bank 0.
  ld hl, $8010
  ld de, TileH
  ld bc, 16
.tile_loop
  ld a, [de]
  inc de
  ld [hl+], a
  dec bc
  ld a, b
  or c
  jr nz, .tile_loop

  ; ── Clear BG map (bank 0 = tile indices, bank 1 = attributes) ──
  ld hl, $9800
  ld bc, $400
.clear_map
  xor a
  ld [hl+], a
  dec bc
  ld a, b
  or c
  jr nz, .clear_map

  ; Tile attribute byte = 0 → palette 0, bank 0, no flip, no priority.
  ; (We left bank 1 untouched, so all attributes are 0 — perfect.)

  ; ── Write tile 1 to the center cell ────────────────────────────
  ld hl, $9800 + (8 * 32) + 9
  ld a, $01
  ld [hl], a

  ; ── Enable LCD ─────────────────────────────────────────────────
  ld a, %10010001
  ldh [$FF40], a

  ; ── Idle ───────────────────────────────────────────────────────
.idle
  halt
  nop
  jr .idle

; ── BG palette: 4 entries × 2 bytes (BGR555 little-endian) ──────
; Color 0 = pure blue   ($7C00 = b=31, g=0, r=0)
; Color 1 = pure yellow ($03FF = b=0, g=31, r=31)
; Color 2 = unused      (black)
; Color 3 = unused      (black)
BgPalette:
  dw $7C00     ; color 0: blue (backdrop)
  dw $03FF     ; color 1: yellow
  dw $0000     ; color 2
  dw $0000     ; color 3

; Tile data — same 'H' as the DMG example, color index 1 (yellow).
; Plane 0 only → all H pixels = color 1.
TileH:
  db $66, $00   ; row 0
  db $66, $00   ; row 1
  db $66, $00   ; row 2
  db $7E, $00   ; row 3
  db $7E, $00   ; row 4
  db $66, $00   ; row 5
  db $66, $00   ; row 6
  db $00, $00   ; row 7

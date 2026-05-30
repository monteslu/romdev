; Game Boy hello-world — yellow 'H' on a dark BG, scrollable with A.
;
; Boots into ROM0 at $0100, sets up the LCD, uploads one tile + writes
; it to the BG map, enables the LCD, then loops reading joypad and
; scrolling the BG. Build with:
;
;   buildSource({platform:"gb", source: <this>})
;
; rgbfix gets applied automatically by buildForPlatform so the header
; checksum is valid.

SECTION "Entry", ROM0[$0100]
  nop
  jp Start

  ; Nintendo logo + header bytes are filled in by rgbfix. We just pad.
  ds $150 - @, 0

SECTION "Main", ROM0[$0150]

Start:
  ; ── 1. Turn LCD off so we can write VRAM unrestricted ───────────
.wait_vblank
  ld a, [$FF44]              ; LY register
  cp 144
  jr c, .wait_vblank
  xor a
  ldh [$FF40], a               ; LCDC = 0 (LCD off)

  ; ── 2. Reset stack pointer ──────────────────────────────────────
  ld sp, $DFF0

  ; ── 3. Set palette: BGP = $E4 (white / lt-gray / dk-gray / black) ─
  ld a, $E4
  ldh [$FF47], a               ; BGP

  ; ── 4. Upload one 'H' tile to VRAM tile 1 at $8000 + 16 = $8010 ──
  ld hl, $8010
  ld de, TileH
  ld bc, 16
.upload_loop
  ld a, [de]
  inc de
  ld [hl+], a
  dec bc
  ld a, b
  or c
  jr nz, .upload_loop

  ; ── 5. Clear BG tile map ($9800-$9BFF) to tile 0 ─────────────────
  ld hl, $9800
  ld bc, $400
.clear_map
  xor a
  ld [hl+], a
  dec bc
  ld a, b
  or c
  jr nz, .clear_map

  ; ── 6. Write tile 1 to the center cell (row 8, col 9) ───────────
  ld hl, $9800 + (8 * 32) + 9
  ld a, $01
  ld [hl], a

  ; ── 7. Enable LCD: BG on, $8000 tile data, $9800 BG map, LCD on ──
  ld a, %10010001
  ldh [$FF40], a               ; LCDC

  ; ── 8. Main loop: hold A to scroll BG ───────────────────────────
  xor a
  ld c, a                    ; C = scroll value

MainLoop:
.wait
  ld a, [$FF44]
  cp 144
  jr c, .wait                ; wait for vblank

  ; Read joypad: select button group, check A pressed.
  ld a, $10                  ; bit 5=0 (buttons), bit 4=1 (deselect dpad)
  ld [$FF00], a
  ld a, [$FF00]
  ld a, [$FF00]              ; bounce-tolerance read
  and $01                    ; bit 0 = A button (active LOW)
  jr nz, .skip_scroll        ; A not pressed → no scroll

  inc c
  ld a, c
  ldh [$FF43], a               ; SCX = scroll value

.skip_scroll
  jr MainLoop

; ── Tile data: yellow-on-dark 'H' (color index 3 = darkest in BGP $E4) ─
; 2bpp interleaved: row N = byte 2N (low plane) + byte 2N+1 (high plane).
; This pattern sets both planes for the 'X' bits → color index 3.
TileH:
  db $66, $66                ; row 0: . X X . . X X .
  db $66, $66                ; row 1
  db $66, $66                ; row 2
  db $7E, $7E                ; row 3: . X X X X X X .
  db $7E, $7E                ; row 4
  db $66, $66                ; row 5
  db $66, $66                ; row 6
  db $00, $00                ; row 7: blank

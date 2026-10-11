// Game Boy memory map and the base (DMG-era) scanline code for the WAT cart.
//
// Linear-memory layout shared by DMG and CGB builds (CPU address -> linear):
//   $8000-$9FFF VRAM (bank 0)    -> 0x08000
//   $A000-$BFFF cartridge RAM    -> 0x0A000 (CGB builds bank it at 0x38000)
//   $C000-$DFFF work RAM         -> 0x0C000
//   $FE00-$FE9F OAM              -> 0x0FE00
//   $FF00-$FFFF I/O, HRAM, IE    -> 0x0FF00
// The ROM image is copied to 0x40000; the indexed DMG framebuffer is 0x30000.
//
// A tile is 8x8 at 2bpp in the PLANAR layout the hardware uses: two bytes per
// row, the low bit of each pixel in the first byte and the high bit in the
// second.
//
// $gb_render_line/$gb_window/$gb_sprites are the original DMG renderer. The
// current machine model draws with hw-gbc.js (CGB or DMG PPU); these
// functions are still emitted (dead) so the cart's text stays identical to
// the verified Python build it was ported from.
//
// Ported from the earlier Python emitter.

export const FB_W = 160, FB_H = 144;

export const ROM = 0x40000;     // ROM image base in linear memory
export const VRAM = 0x08000;    // $8000-$9FFF -> 8KB
export const WRAM = 0x0C000;    // $C000-$DFFF -> 8KB
export const OAM = 0x0FE00;     // $FE00-$FE9F
export const IOREG = 0x0FF00;   // $FF00-$FFFF (includes HRAM and IE)
export const CARTRAM = 0x0A000; // $A000-$BFFF
export const GBFB = 0x30000;    // indexed framebuffer, 160x144

/** DMG shade -> RGBA. BGP ($FF47) maps colour index to shade. */
export function paletteWat() {
  return `  (func $gb_shade (param $i i32) (result i32)
    ;; The DMG has four shades. These are the values genesis_plus_gx's DMG
    ;; sibling and every reference emulator produce for the classic green
    ;; LCD; a grey ramp would be a different (and wrong) picture.
    (i32.load (i32.add (i32.const ${IOREG + 0x100})
      (i32.mul (i32.and (local.get $i) (i32.const 3)) (i32.const 4)))))

  (func $gb_bgp (param $ci i32) (result i32)
    ;; BGP at $FF47 packs four 2-bit shades, index 0 in bits 1-0.
    (i32.and (i32.shr_u (i32.load8_u (i32.const ${IOREG + 0x47}))
                        (i32.mul (i32.and (local.get $ci) (i32.const 3))
                                 (i32.const 2)))
             (i32.const 3)))
`;
}

/** Render one scanline of the BG + window into the indexed framebuffer. */
export function renderWat() {
  return `  (func $gb_render_line (param $y i32)
    (local $lcdc i32) (local $scx i32) (local $scy i32)
    (local $map i32) (local $tiles i32) (local $x i32)
    (local $py i32) (local $px i32) (local $tx i32) (local $ty i32)
    (local $tno i32) (local $addr i32) (local $lo i32) (local $hi i32)
    (local $bit i32) (local $ci i32)
    (local.set $lcdc (i32.load8_u (i32.const ${IOREG + 0x40})))
    ;; LCDC bit 7 off = display blank (white). Bit 0 off = BG off.
    (if (i32.eqz (i32.and (local.get $lcdc) (i32.const 0x80)))
      (then
        (local.set $x (i32.const 0))
        (block $bd (loop $bl
          (br_if $bd (i32.ge_u (local.get $x) (i32.const ${FB_W})))
          (i32.store8 (i32.add (i32.const ${GBFB})
            (i32.add (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x)))
            (i32.const 0))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $bl)))
        (return)))
    (local.set $scy (i32.load8_u (i32.const ${IOREG + 0x42})))
    (local.set $scx (i32.load8_u (i32.const ${IOREG + 0x43})))
    ;; LCDC bit 3 picks the BG map: $9800 or $9C00.
    (local.set $map (i32.add (i32.const ${VRAM})
      (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x08))
        (then (i32.const 0x1C00)) (else (i32.const 0x1800)))))
    ;; LCDC bit 4 picks the tile data base AND the index signedness:
    ;;   1 -> $8000, tile index UNSIGNED
    ;;   0 -> $9000, tile index SIGNED (-128..127)
    (local.set $tiles (i32.and (local.get $lcdc) (i32.const 0x10)))
    (local.set $py (i32.and (i32.add (local.get $y) (local.get $scy))
                            (i32.const 0xFF)))
    (local.set $ty (i32.shr_u (local.get $py) (i32.const 3)))
    (local.set $x (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (local.set $px (i32.and (i32.add (local.get $x) (local.get $scx))
                              (i32.const 0xFF)))
      (local.set $tx (i32.shr_u (local.get $px) (i32.const 3)))
      (local.set $tno (i32.load8_u (i32.add (local.get $map)
        (i32.add (i32.mul (local.get $ty) (i32.const 32)) (local.get $tx)))))
      (if (local.get $tiles)
        (then (local.set $addr (i32.add (i32.const ${VRAM})
                (i32.mul (local.get $tno) (i32.const 16)))))
        (else
          ;; signed index off $9000
          (if (i32.ge_u (local.get $tno) (i32.const 128))
            (then (local.set $tno (i32.sub (local.get $tno) (i32.const 256)))))
          (local.set $addr (i32.add (i32.const ${VRAM + 0x1000})
            (i32.mul (local.get $tno) (i32.const 16))))))
      (local.set $addr (i32.add (local.get $addr)
        (i32.mul (i32.and (local.get $py) (i32.const 7)) (i32.const 2))))
      ;; PLANAR 2bpp: byte 0 holds the LOW bit of each pixel, byte 1 the HIGH
      ;; bit. Pixel 0 is bit 7 of each.
      (local.set $lo (i32.load8_u (local.get $addr)))
      (local.set $hi (i32.load8_u (i32.add (local.get $addr) (i32.const 1))))
      (local.set $bit (i32.sub (i32.const 7) (i32.and (local.get $px) (i32.const 7))))
      (local.set $ci (i32.or
        (i32.and (i32.shr_u (local.get $lo) (local.get $bit)) (i32.const 1))
        (i32.shl (i32.and (i32.shr_u (local.get $hi) (local.get $bit))
                          (i32.const 1)) (i32.const 1))))
      (i32.store8 (i32.add (i32.const ${GBFB})
        (i32.add (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x)))
        (call $gb_bgp (local.get $ci)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l)))
    ;; ---- window (LCDC bit 5) ---------------------------------------
    ;; The window is a second, non-scrolling map drawn OVER the BG from
    ;; (WX-7, WY). shocklobster enables it with WY=34, and the 378 pixels
    ;; that differed from the reference all sat at y >= 34 - the whole
    ;; discrepancy was this layer missing.
    (if (i32.and (i32.and (local.get $lcdc) (i32.const 0x20))
                 (i32.ge_s (local.get $y)
                           (i32.load8_u (i32.const ${IOREG + 0x4A}))))
      (then (call $gb_window (local.get $y) (local.get $lcdc))))
    ;; ---- sprites (LCDC bit 1) --------------------------------------
    ;; 40 OAM entries of 4 bytes: y+16, x+8, tile, flags. Drawn after the BG
    ;; because a cart with sprites off still needs a correct BG; leaving them
    ;; out entirely is why a working BG still scored 37%.
    (if (i32.and (local.get $lcdc) (i32.const 0x02))
      (then (call $gb_sprites (local.get $y) (local.get $lcdc)))))

  (func $gb_window (param $y i32) (param $lcdc i32)
    (local $map i32) (local $tiles i32) (local $wx i32) (local $wy i32)
    (local $x i32) (local $py i32) (local $tx i32) (local $ty i32)
    (local $tno i32) (local $addr i32) (local $lo i32) (local $hi i32)
    (local $bit i32) (local $ci i32) (local $sx i32)
    (local.set $wy (i32.load8_u (i32.const ${IOREG + 0x4A})))
    (local.set $wx (i32.sub (i32.load8_u (i32.const ${IOREG + 0x4B}))
                            (i32.const 7)))
    ;; LCDC bit 6 picks the WINDOW map (bit 3 is the BG's).
    (local.set $map (i32.add (i32.const ${VRAM})
      (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x40))
        (then (i32.const 0x1C00)) (else (i32.const 0x1800)))))
    (local.set $tiles (i32.and (local.get $lcdc) (i32.const 0x10)))
    ;; The window has its own line counter starting at WY - it does NOT
    ;; scroll with SCY.
    (local.set $py (i32.sub (local.get $y) (local.get $wy)))
    (local.set $ty (i32.shr_u (local.get $py) (i32.const 3)))
    (local.set $x (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (local.set $sx (i32.sub (local.get $x) (local.get $wx)))
      (if (i32.ge_s (local.get $sx) (i32.const 0))
        (then
          (local.set $tx (i32.shr_u (local.get $sx) (i32.const 3)))
          (local.set $tno (i32.load8_u (i32.add (local.get $map)
            (i32.add (i32.mul (local.get $ty) (i32.const 32)) (local.get $tx)))))
          (if (local.get $tiles)
            (then (local.set $addr (i32.add (i32.const ${VRAM})
                    (i32.mul (local.get $tno) (i32.const 16)))))
            (else
              (if (i32.ge_u (local.get $tno) (i32.const 128))
                (then (local.set $tno (i32.sub (local.get $tno) (i32.const 256)))))
              (local.set $addr (i32.add (i32.const ${VRAM + 0x1000})
                (i32.mul (local.get $tno) (i32.const 16))))))
          (local.set $addr (i32.add (local.get $addr)
            (i32.mul (i32.and (local.get $py) (i32.const 7)) (i32.const 2))))
          (local.set $lo (i32.load8_u (local.get $addr)))
          (local.set $hi (i32.load8_u (i32.add (local.get $addr) (i32.const 1))))
          (local.set $bit (i32.sub (i32.const 7)
            (i32.and (local.get $sx) (i32.const 7))))
          (local.set $ci (i32.or
            (i32.and (i32.shr_u (local.get $lo) (local.get $bit)) (i32.const 1))
            (i32.shl (i32.and (i32.shr_u (local.get $hi) (local.get $bit))
                              (i32.const 1)) (i32.const 1))))
          (i32.store8 (i32.add (i32.const ${GBFB})
            (i32.add (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x)))
            (call $gb_bgp (local.get $ci)))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l))))

  (func $gb_sprites (param $y i32) (param $lcdc i32)
    (local $i i32) (local $sy i32) (local $sx i32) (local $tno i32)
    (local $fl i32) (local $row i32) (local $addr i32) (local $lo i32)
    (local $hi i32) (local $px i32) (local $bit i32) (local $ci i32)
    (local $h i32) (local $sc i32)
    ;; LCDC bit 2 selects 8x16 sprites.
    (local.set $h (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x04))
      (then (i32.const 16)) (else (i32.const 8))))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 40)))
      (local.set $sy (i32.sub (i32.load8_u (i32.add (i32.const ${OAM})
        (i32.mul (local.get $i) (i32.const 4)))) (i32.const 16)))
      (local.set $sx (i32.sub (i32.load8_u (i32.add (i32.const ${OAM})
        (i32.add (i32.mul (local.get $i) (i32.const 4)) (i32.const 1))))
        (i32.const 8)))
      (local.set $tno (i32.load8_u (i32.add (i32.const ${OAM})
        (i32.add (i32.mul (local.get $i) (i32.const 4)) (i32.const 2)))))
      (local.set $fl (i32.load8_u (i32.add (i32.const ${OAM})
        (i32.add (i32.mul (local.get $i) (i32.const 4)) (i32.const 3)))))
      (if (i32.and (i32.ge_s (local.get $y) (local.get $sy))
                   (i32.lt_s (local.get $y) (i32.add (local.get $sy) (local.get $h))))
        (then
          (local.set $row (i32.sub (local.get $y) (local.get $sy)))
          ;; bit 6 = vertical flip
          (if (i32.and (local.get $fl) (i32.const 0x40))
            (then (local.set $row (i32.sub (i32.sub (local.get $h) (i32.const 1))
                                           (local.get $row)))))
          ;; 8x16 ignores bit 0 of the tile number
          (if (i32.eq (local.get $h) (i32.const 16))
            (then (local.set $tno (i32.and (local.get $tno) (i32.const 0xFE)))))
          ;; sprite tiles ALWAYS come from $8000, unsigned
          (local.set $addr (i32.add (i32.const ${VRAM})
            (i32.add (i32.mul (local.get $tno) (i32.const 16))
                     (i32.mul (local.get $row) (i32.const 2)))))
          (local.set $lo (i32.load8_u (local.get $addr)))
          (local.set $hi (i32.load8_u (i32.add (local.get $addr) (i32.const 1))))
          (local.set $px (i32.const 0))
          (block $sd (loop $sl
            (br_if $sd (i32.ge_u (local.get $px) (i32.const 8)))
            (local.set $bit (i32.sub (i32.const 7) (local.get $px)))
            ;; bit 5 = horizontal flip
            (if (i32.and (local.get $fl) (i32.const 0x20))
              (then (local.set $bit (local.get $px))))
            (local.set $ci (i32.or
              (i32.and (i32.shr_u (local.get $lo) (local.get $bit)) (i32.const 1))
              (i32.shl (i32.and (i32.shr_u (local.get $hi) (local.get $bit))
                                (i32.const 1)) (i32.const 1))))
            ;; colour 0 is TRANSPARENT for sprites (unlike the BG)
            (local.set $sc (i32.add (local.get $sx) (local.get $px)))
            (if (i32.and (i32.ne (local.get $ci) (i32.const 0))
                  (i32.and (i32.ge_s (local.get $sc) (i32.const 0))
                           (i32.lt_s (local.get $sc) (i32.const ${FB_W}))))
              (then
                (i32.store8 (i32.add (i32.const ${GBFB})
                  (i32.add (i32.mul (local.get $y) (i32.const ${FB_W}))
                           (local.get $sc)))
                  ;; OBP0/OBP1 by flags bit 4
                  (i32.and (i32.shr_u (i32.load8_u (i32.add (i32.const ${IOREG})
                    (if (result i32) (i32.and (local.get $fl) (i32.const 0x10))
                      (then (i32.const 0x49)) (else (i32.const 0x48)))))
                    (i32.mul (local.get $ci) (i32.const 2)))
                    (i32.const 3)))))
            (local.set $px (i32.add (local.get $px) (i32.const 1)))
            (br $sl)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))
`;
}

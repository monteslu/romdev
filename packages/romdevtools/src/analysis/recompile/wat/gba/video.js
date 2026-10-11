// GBA scanline renderer for the WAT cart (BG modes 0-5, OBJ, windows,
// colour effects). The WAT text is the earlier Python renderer carried over
// mechanically; the differential gate compares the two emitters' output.
//
// COLOUR IS BGR555, NOT RGB555: a GBA halfword is 0BBBBBGGGGGRRRRR, blue in
// the HIGH bits; the 5-bit channel scales to 8 bits by (c << 3) | (c >> 2).
// TILES ARE LINEAR 4BPP OR 8BPP, LOW nibble first.
//
// Plain JS ESM + JSDoc.

export const FB_W = 240, FB_H = 160;

// Linear-memory layout of the GBA's own RAM regions, mapped flat. The
// emitter places everything else (BIOS, tables, ROM) after sizes()[0].
export const EWRAM = 0x0100000;   // 256KB  at GBA $02000000
export const IWRAM = 0x0140000;   // 32KB   at GBA $03000000
export const IOREG = 0x0148000;   // 1KB    at GBA $04000000 (register shadow)
export const PAL = 0x0148400;     // 1KB    at GBA $05000000
export const VRAM = 0x0148800;    // 96KB   at GBA $06000000
export const OAM = 0x0160800;     // 1KB    at GBA $07000000
export const SRAM = 0x0161000;    // 64KB   (unused by the mGBA-model core; kept for layout parity)
export const GBAFB = 0x0171000;   // 0xAARRGGBB framebuffer, 240x160x4
// Per-pixel layer id for the line being composed (0-3 BG, 4 OBJ, 5 backdrop).
export const GBALAY = GBAFB + FB_W * FB_H * 4;
// Per-line OBJ buffer, one i32 per pixel.
export const GBAOBJ = GBALAY + FB_W * FB_H;
// Per-line OBJ-window flags and the resolved window mask, a byte per pixel.
export const GBAOW = GBAOBJ + FB_W * 4;
export const GBAWIN = GBAOW + FB_W;
// BIOS affine-SWI trig table: 256 f32 sines then 256 f32 cosines.
export const SINTAB = (GBAWIN + FB_W + 15) & ~15;
export const DMAINT = SINTAB + 2048;

// I/O register offsets from $04000000.
const DISPCNT = 0x000, BG0CNT = 0x008, BG0HOFS = 0x010;
const BLDCNT = 0x050, BLDALPHA = 0x052, BLDY = 0x054;
const WIN0H = 0x040, WININ = 0x048, WINOUT = 0x04A;

/** @returns {[number, number]} [end of the hw region, framebuffer base] */
export function sizes() {
  return [DMAINT + 32 + 0x1000, GBAFB];
}

/** BGR555 halfword -> 0xAARRGGBB, compositing and the pixel plot. */
export function colorWat() {
    return `
  (func $gba_rgb (param $c i32) (result i32)
    (local $r i32) (local $g i32) (local $b i32)
    (local.set $r (i32.and (local.get $c) (i32.const 0x1F)))
    (local.set $g (i32.and (i32.shr_u (local.get $c) (i32.const 5)) (i32.const 0x1F)))
    (local.set $b (i32.and (i32.shr_u (local.get $c) (i32.const 10)) (i32.const 0x1F)))
    ;; 5 -> 8 bits: (c << 3) | (c >> 2). A plain \`c << 3\` tops out at 248 and
    ;; makes every frame slightly dark, which a colour compare catches and a
    ;; glance does not.
    ;;
    ;; GREEN GOES THROUGH THE 6-BIT LATTICE, NOT THE 5-BIT ONE. mGBA presents
    ;; its framebuffer as RGB565, so green carries one more bit than red and
    ;; blue: the value is doubled into 6 bits and expanded as (g6 << 2) |
    ;; (g6 >> 4). Expanding it as 5 bits puts green on a DIFFERENT LATTICE
    ;; from the reference - 5-bit 24 gives 198 where mGBA gives 195 - and
    ;; since the two ladders only coincide at the ends, that is a 1-3 value
    ;; error on essentially EVERY pixel of every frame.
    ;;
    ;; This was invisible for as long as the carts were failing for larger
    ;; reasons. It surfaced only once one cart's picture came out right:
    ;; the frame looked identical to the reference and still scored 10.53%,
    ;; because the scorer is an exact RGB compare. Measured across the whole
    ;; frame, red and blue matched on every pixel and green differed on every
    ;; pixel - a channel-shaped result, which is what named the cause.
    (local.set $g (i32.shl (local.get $g) (i32.const 1)))
    (i32.or (i32.const 0xFF000000)
      (i32.or (i32.shl (i32.or (i32.shl (local.get $r) (i32.const 3))
                               (i32.shr_u (local.get $r) (i32.const 2)))
                       (i32.const 16))
      (i32.or (i32.shl (i32.or (i32.shl (local.get $g) (i32.const 2))
                               (i32.shr_u (local.get $g) (i32.const 4)))
                       (i32.const 8))
              (i32.or (i32.shl (local.get $b) (i32.const 3))
                      (i32.shr_u (local.get $b) (i32.const 2)))))))

  ;; Palette entry -> RGBA. \`i\` indexes the 512-entry palette RAM as halfwords:
  ;; 0-255 are background, 256-511 sprite.
  (func $gba_pal (param $i i32) (result i32)
    (call $gba_rgb (i32.load16_u (i32.add (i32.const ${PAL})
      (i32.shl (i32.and (local.get $i) (i32.const 0x1FF)) (i32.const 1))))))

  ;; ---- colour special effects (BLDCNT/BLDALPHA/BLDY) --------------------
  ;;
  ;; BLDCNT $04000050: bits 0-5 select the FIRST target (BG0,BG1,BG2,BG3,OBJ,
  ;; backdrop - the same order as the layer ids), bits 6-7 the effect
  ;; (0 none, 1 alpha blend, 2 brighten, 3 darken), bits 8-13 the SECOND
  ;; target. BLDALPHA $04000052 holds EVA in bits 0-4 and EVB in bits 8-12.
  ;; BLDY $04000054 holds EVY in bits 0-4.
  ;;
  ;; Alpha blend is per channel:  min(31, (A*EVA + B*EVB) >> 4), with both
  ;; coefficients CLAMPED TO 16 - not to 31. A cart that writes EVA=17 is
  ;; asking for 16/16, and letting it through produces channels above white
  ;; that wrap when they are packed back into 5 bits.
  ;;
  ;; These operate in the GBA's 5-bit colour space, so the inputs are
  ;; unpacked back to 5 bits from the RGBA the layers wrote. Blending the
  ;; 8-bit expansions instead would round differently from the hardware on
  ;; every pixel and score as a near-miss everywhere.
  (func $gba_blend (param $a i32) (param $b i32) (result i32)
    (local $ea i32) (local $eb i32) (local $v i32) (local $o i32)
    (local.set $v (i32.load16_u (i32.const ${IOREG + BLDALPHA})))
    (local.set $ea (i32.and (local.get $v) (i32.const 0x1F)))
    (local.set $eb (i32.and (i32.shr_u (local.get $v) (i32.const 8))
                            (i32.const 0x1F)))
    (if (i32.gt_u (local.get $ea) (i32.const 16))
      (then (local.set $ea (i32.const 16))))
    (if (i32.gt_u (local.get $eb) (i32.const 16))
      (then (local.set $eb (i32.const 16))))
    (local.set $o (i32.const 0xFF000000))
    (local.set $o (i32.or (local.get $o)
      (i32.shl (call $gba_chan (local.get $a) (local.get $b) (local.get $ea)
                 (local.get $eb) (i32.const 16)) (i32.const 16))))
    (local.set $o (i32.or (local.get $o)
      (i32.shl (call $gba_chan (local.get $a) (local.get $b) (local.get $ea)
                 (local.get $eb) (i32.const 8)) (i32.const 8))))
    (i32.or (local.get $o)
      (call $gba_chan (local.get $a) (local.get $b) (local.get $ea)
        (local.get $eb) (i32.const 0))))

  ;; Take one 8-bit channel of an RGBA back to the 5 bits the hardware
  ;; blends in.
  ;;
  ;; >>3 for EVERY channel, green included, and that is a derivation rather
  ;; than an oversight: green's 8-bit form is (g6 << 2) | (g6 >> 4) with
  ;; g6 = g5 * 2, so v >> 2 recovers g6 and v >> 3 recovers g5. The two
  ;; ladders differ on the way OUT (which is the bug $gba_rgb documents) and
  ;; coincide on the way in. $gba_from5 is where the channel matters.
  (func $gba_to5 (param $rgba i32) (param $sh i32) (result i32)
    (i32.shr_u (i32.and (i32.shr_u (local.get $rgba) (local.get $sh))
                        (i32.const 0xFF)) (i32.const 3)))

  ;; Expand a blended 5-bit channel back to 8, on the same ladder $gba_rgb
  ;; uses - including green's 6-bit one.
  (func $gba_from5 (param $v i32) (param $sh i32) (result i32)
    (if (i32.eq (local.get $sh) (i32.const 8))
      (then
        (local.set $v (i32.shl (local.get $v) (i32.const 1)))
        (return (i32.or (i32.shl (local.get $v) (i32.const 2))
                        (i32.shr_u (local.get $v) (i32.const 4))))))
    (i32.or (i32.shl (local.get $v) (i32.const 3))
            (i32.shr_u (local.get $v) (i32.const 2))))

  ;; One channel of an alpha blend. \`sh\` names the byte: 16 red, 8 green,
  ;; 0 blue.
  (func $gba_chan (param $a i32) (param $b i32) (param $ea i32)
                  (param $eb i32) (param $sh i32) (result i32)
    (local $v i32)
    (local.set $v (i32.shr_u (i32.add
      (i32.mul (call $gba_to5 (local.get $a) (local.get $sh)) (local.get $ea))
      (i32.mul (call $gba_to5 (local.get $b) (local.get $sh)) (local.get $eb)))
      (i32.const 4)))
    (if (i32.gt_u (local.get $v) (i32.const 31))
      (then (local.set $v (i32.const 31))))
    (call $gba_from5 (local.get $v) (local.get $sh)))

  ;; Brighten (effect 2) / darken (effect 3): one colour toward white or
  ;; black by EVY/16. Same 5-bit space, same clamp at 16.
  (func $gba_fade (param $c i32) (param $up i32) (result i32)
    (local $ey i32) (local $o i32)
    (local.set $ey (i32.and (i32.load16_u (i32.const ${IOREG + BLDY}))
                            (i32.const 0x1F)))
    (if (i32.gt_u (local.get $ey) (i32.const 16))
      (then (local.set $ey (i32.const 16))))
    (i32.or (i32.const 0xFF000000)
      (i32.or (i32.shl (call $gba_fchan (local.get $c) (local.get $up)
                         (local.get $ey) (i32.const 16)) (i32.const 16))
      (i32.or (i32.shl (call $gba_fchan (local.get $c) (local.get $up)
                         (local.get $ey) (i32.const 8)) (i32.const 8))
              (call $gba_fchan (local.get $c) (local.get $up)
                (local.get $ey) (i32.const 0))))))

  (func $gba_fchan (param $c i32) (param $up i32) (param $ey i32)
                   (param $sh i32) (result i32)
    (local $v i32)
    (local.set $v (call $gba_to5 (local.get $c) (local.get $sh)))
    (if (local.get $up)
      (then (local.set $v (i32.add (local.get $v)
              (i32.shr_u (i32.mul (i32.sub (i32.const 31) (local.get $v))
                           (local.get $ey)) (i32.const 4)))))
      ;; DARKEN ROUNDS DIFFERENTLY PER CHANNEL IN THE REFERENCE, and it is
      ;; matched rather than "corrected". mGBA's 16-bit renderer darkens the
      ;; packed RGB565 word field by field: \`a - a*y/16\` masked back to the
      ;; field. For blue (bits 0-4) that is v - floor(v*y/16). For green and
      ;; red the field sits at bit 6 / bit 11, the product is exact, and the
      ;; MASK truncates the result - which is v - CEIL(v*y/16). Measured on
      ;; a title screen using BLDY=1: palette (20,3,7) comes out
      ;; (18,2,7) and (31,31,31) comes out (29,29,30); the textbook formula
      ;; gives (19,3,7) and (30,30,30) and scored 66% of content pixels.
      (else (local.set $v (i32.sub (local.get $v)
              (i32.shr_u (i32.add (i32.mul (local.get $v) (local.get $ey))
                                  (if (result i32) (local.get $sh)
                                    (then (i32.const 15)) (else (i32.const 0))))
                (i32.const 4))))))
    (call $gba_from5 (local.get $v) (local.get $sh)))

  ;; PLOT ONE PIXEL of layer \`lay\` at (x,y), applying whatever colour effect
  ;; BLDCNT asks for. This is the ONLY way the tiled path writes a pixel, so
  ;; a layer cannot accidentally bypass the effects unit.
  ;;
  ;; The second-target test reads the LAYER ID ALREADY AT THIS PIXEL, which
  ;; is why the id buffer exists: on hardware the blend combines the top two
  ;; layers at that dot, and a painter that kept only colour cannot say what
  ;; the lower one was. When the pixel underneath is NOT a second target,
  ;; hardware performs no blend at all and the top pixel is written plain -
  ;; it does not fall back to blending against whatever is there.
  (func $gba_plot (param $x i32) (param $y i32) (param $lay i32)
                  (param $rgb i32)
    (local $bld i32) (local $eff i32) (local $dst i32) (local $laddr i32)
    (local $under i32) (local $wm i32)
    ;; THE WINDOW MASK decides first: a layer the window hides at this dot is
    ;; not drawn at all, and effects apply only where bit 5 allows them.
    (local.set $wm (i32.load8_u (i32.add (i32.const ${GBAWIN}) (local.get $x))))
    (if (i32.eqz (i32.and (i32.shr_u (local.get $wm) (local.get $lay)) (i32.const 1)))
      (then (return)))
    (local.set $dst (i32.add (i32.const ${GBAFB}) (i32.shl (i32.add
      (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x))
      (i32.const 2))))
    (local.set $laddr (i32.add (i32.const ${GBALAY}) (i32.add
      (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x))))
    (local.set $bld (i32.load16_u (i32.const ${IOREG + BLDCNT})))
    (local.set $eff (i32.and (i32.shr_u (local.get $bld) (i32.const 6))
                             (i32.const 3)))
    ;; Effects apply only to a FIRST target. Everything else is a plain write.
    (if (i32.and (i32.and (i32.and (i32.shr_u (local.get $bld) (local.get $lay))
                                   (i32.const 1))
                          (i32.shr_u (local.get $wm) (i32.const 5)))
                 (i32.ne (local.get $eff) (i32.const 0)))
      (then
        (if (i32.eq (local.get $eff) (i32.const 1))
          (then
            (local.set $under (i32.load8_u (local.get $laddr)))
            ;; Second-target bits start at bit 8.
            (if (i32.and (i32.shr_u (local.get $bld)
                           (i32.add (local.get $under) (i32.const 8)))
                         (i32.const 1))
              (then (local.set $rgb (call $gba_blend (local.get $rgb)
                      (i32.load (local.get $dst)))))))
          (else (local.set $rgb (call $gba_fade (local.get $rgb)
                  (i32.eq (local.get $eff) (i32.const 2))))))))
    (i32.store (local.get $dst) (local.get $rgb))
    (i32.store8 (local.get $laddr) (local.get $lay)))

  ;; A SPRITE PIXEL. A semi-transparent OBJ (attr0 mode 1) is alpha-blended
  ;; with whatever second target lies under it WHETHER OR NOT BLDCNT selects
  ;; OBJ as a first target or even selects alpha blending at all - that is
  ;; what the mode is for. Where the pixel beneath is not a second target it
  ;; falls back to the ordinary path, brighten/darken included.
  (func $gba_plot_obj (param $x i32) (param $y i32) (param $rgb i32)
                      (param $semi i32)
    (local $dst i32) (local $laddr i32) (local $wm i32)
    (if (local.get $semi)
      (then
        (local.set $wm (i32.load8_u (i32.add (i32.const ${GBAWIN}) (local.get $x))))
        (if (i32.eq (i32.and (local.get $wm) (i32.const 0x30)) (i32.const 0x30))
          (then
            (local.set $dst (i32.add (i32.const ${GBAFB}) (i32.shl (i32.add
              (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x))
              (i32.const 2))))
            (local.set $laddr (i32.add (i32.const ${GBALAY}) (i32.add
              (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x))))
            (if (i32.and (i32.shr_u (i32.load16_u (i32.const ${IOREG + BLDCNT}))
                           (i32.add (i32.load8_u (local.get $laddr)) (i32.const 8)))
                         (i32.const 1))
              (then
                (i32.store (local.get $dst) (call $gba_blend (local.get $rgb)
                  (i32.load (local.get $dst))))
                (i32.store8 (local.get $laddr) (i32.const 4))
                (return)))))))
    (call $gba_plot (local.get $x) (local.get $y) (i32.const 4) (local.get $rgb)))
`;
}

/** One scanline, dispatching on the DISPCNT BG mode. */
export function renderWat() {
    return `
  ;; DISPCNT bits 0-2 select the BG mode; bit 4 is the Mode 4/5 page flip;
  ;; bits 8-11 enable BG0-BG3; bit 12 enables OBJ.
  (func $dispcnt (result i32)
    (i32.load16_u (i32.const ${IOREG + DISPCNT})))

  ;; ---- affine reference points -----------------------------------------
  ;; BG2X/BG2Y (and BG3's) are copied into INTERNAL registers at the top of
  ;; the frame and whenever the cart writes them; after every line the
  ;; internal registers advance by PB/PD. A cart that rewrites them from an
  ;; HBlank handler (a Mode 7 floor) therefore takes effect on the next
  ;; line, and one that never touches them mid-frame gets a smooth
  ;; rotation - both from the same rule the hardware uses.
  (global $aff2x (mut i32) (i32.const 0))
  (global $aff2y (mut i32) (i32.const 0))
  (global $aff3x (mut i32) (i32.const 0))
  (global $aff3y (mut i32) (i32.const 0))

  ;; 28-bit signed 20.8 fixed point, sign-extended from bit 27.
  (func $gba_ref28 (param $o i32) (result i32)
    (i32.shr_s (i32.shl (i32.load (i32.add (i32.const ${IOREG}) (local.get $o)))
                        (i32.const 4)) (i32.const 4)))

  (func $gba_aff_reload (param $bg i32)
    (if (i32.eq (local.get $bg) (i32.const 2))
      (then (global.set $aff2x (call $gba_ref28 (i32.const 0x28)))
            (global.set $aff2y (call $gba_ref28 (i32.const 0x2C))))
      (else (global.set $aff3x (call $gba_ref28 (i32.const 0x38)))
            (global.set $aff3y (call $gba_ref28 (i32.const 0x3C))))))

  (func $gba_ios16 (param $o i32) (result i32)
    (i32.load16_s (i32.add (i32.const ${IOREG}) (local.get $o))))

  (func $gba_render_line (param $y i32)
    (local $x i32) (local $dst i32)
    (if (i32.eqz (local.get $y))
      (then (call $gba_aff_reload (i32.const 2))
            (call $gba_aff_reload (i32.const 3))))
    ;; DISPCNT BIT 7 IS FORCED BLANK. The GBA drives the LCD WHITE while it
    ;; is set, and a cart sets it during every load so the player never sees
    ;; a half-built screen. Ignoring it means rendering VRAM the cart is
    ;; still writing - and before the first load that VRAM is uninitialised,
    ;; which reads as a full-colour noise picture rather than a blank one.
    (if (i32.and (call $dispcnt) (i32.const 0x80))
      (then
        (local.set $dst (i32.add (i32.const ${GBAFB})
          (i32.mul (local.get $y) (i32.const ${FB_W * 4}))))
        (local.set $x (i32.const 0))
        (block $wd (loop $wl
          (br_if $wd (i32.ge_u (local.get $x) (i32.const ${FB_W})))
          ;; white is BGR555 $7FFF through the same RGB565 lattice as every
          ;; other pixel: green 62 of 63 -> 251, not 255
          (i32.store (i32.add (local.get $dst)
            (i32.shl (local.get $x) (i32.const 2))) (i32.const 0xFFFFFBFF))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $wl)))
        (call $gba_aff_step)
        (return)))
    ;; Sprites first (the OBJ window is made of sprites), then the window
    ;; mask, then the picture itself.
    (call $gba_obj_line (local.get $y))
    (call $gba_win_line (local.get $y))
    (call $gba_compose (local.get $y))
    (call $gba_aff_step))

  (func $gba_aff_step
    (global.set $aff2x (i32.add (global.get $aff2x) (call $gba_ios16 (i32.const 0x22))))
    (global.set $aff2y (i32.add (global.get $aff2y) (call $gba_ios16 (i32.const 0x26))))
    (global.set $aff3x (i32.add (global.get $aff3x) (call $gba_ios16 (i32.const 0x32))))
    (global.set $aff3y (i32.add (global.get $aff3y) (call $gba_ios16 (i32.const 0x36)))))

  ;; ---- windows -----------------------------------------------------------
  ;; WINxH = (left << 8) | right, WINxV = (top << 8) | bottom, both
  ;; half-open. Out-of-range values are clamped the way mGBA clamps them,
  ;; and left > right WRAPS (inside = beyond left OR before right), which is
  ;; how a window straddling the screen edge is written.
  (func $gba_win_in (param $reg i32) (param $v i32) (param $lim i32) (result i32)
    (local $st i32) (local $en i32)
    (local.set $en (i32.and (local.get $reg) (i32.const 0xFF)))
    (local.set $st (i32.shr_u (i32.and (local.get $reg) (i32.const 0xFFFF)) (i32.const 8)))
    (if (i32.and (i32.gt_u (local.get $st) (local.get $lim))
                 (i32.gt_u (local.get $st) (local.get $en)))
      (then (local.set $st (i32.const 0))))
    (if (i32.gt_u (local.get $en) (local.get $lim))
      (then (local.set $en (local.get $lim))
            (if (i32.gt_u (local.get $st) (local.get $lim))
              (then (local.set $st (local.get $lim))))))
    (if (result i32) (i32.le_u (local.get $st) (local.get $en))
      (then (i32.and (i32.ge_u (local.get $v) (local.get $st))
                     (i32.lt_u (local.get $v) (local.get $en))))
      (else (i32.or (i32.ge_u (local.get $v) (local.get $st))
                    (i32.lt_u (local.get $v) (local.get $en))))))

  (func $gba_win_line (param $y i32)
    (local $dc i32) (local $x i32) (local $m i32) (local $out i32)
    (local $objin i32) (local $w0 i32) (local $w1 i32) (local $in0 i32) (local $in1 i32)
    (local.set $dc (call $dispcnt))
    (if (i32.eqz (i32.and (local.get $dc) (i32.const 0xE000)))
      (then
        (local.set $x (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $x) (i32.const ${FB_W})))
          (i32.store8 (i32.add (i32.const ${GBAWIN}) (local.get $x)) (i32.const 0x3F))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $l)))
        (return)))
    (local.set $out (i32.and (i32.load16_u (i32.const ${IOREG + WINOUT})) (i32.const 0x3F)))
    (local.set $objin (i32.and (i32.shr_u (i32.load16_u (i32.const ${IOREG + WINOUT}))
                                          (i32.const 8)) (i32.const 0x3F)))
    (local.set $w0 (i32.and (i32.load16_u (i32.const ${IOREG + WININ})) (i32.const 0x3F)))
    (local.set $w1 (i32.and (i32.shr_u (i32.load16_u (i32.const ${IOREG + WININ}))
                                       (i32.const 8)) (i32.const 0x3F)))
    (local.set $in0 (i32.and (i32.shr_u (local.get $dc) (i32.const 13))
      (call $gba_win_in (i32.load16_u (i32.const ${IOREG + WIN0H + 4}))
                        (local.get $y) (i32.const ${FB_H}))))
    (local.set $in1 (i32.and (i32.shr_u (local.get $dc) (i32.const 14))
      (call $gba_win_in (i32.load16_u (i32.const ${IOREG + WIN0H + 6}))
                        (local.get $y) (i32.const ${FB_H}))))
    (local.set $x (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (local.set $m (local.get $out))
      (if (i32.and (i32.shr_u (local.get $dc) (i32.const 15))
                   (i32.load8_u (i32.add (i32.const ${GBAOW}) (local.get $x))))
        (then (local.set $m (local.get $objin))))
      (if (i32.and (local.get $in1)
            (call $gba_win_in (i32.load16_u (i32.const ${IOREG + WIN0H + 2}))
                              (local.get $x) (i32.const ${FB_W})))
        (then (local.set $m (local.get $w1))))
      (if (i32.and (local.get $in0)
            (call $gba_win_in (i32.load16_u (i32.const ${IOREG + WIN0H}))
                              (local.get $x) (i32.const ${FB_W})))
        (then (local.set $m (local.get $w0))))
      (i32.store8 (i32.add (i32.const ${GBAWIN}) (local.get $x)) (local.get $m))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l2))))

  ;; ---- sprites -------------------------------------------------------------
  ;; Size from attr0 shape and attr1 size, packed w | h << 8.
  ;;   shape 0 square 8,16,32,64; 1 wide 16x8 32x8 32x16 64x32;
  ;;   2 tall 8x16 8x32 16x32 32x64.
  (func $gba_obj_dim (param $shape i32) (param $size i32) (result i32)
    (if (i32.eqz (local.get $shape))
      (then (return (i32.mul (i32.shl (i32.const 8) (local.get $size))
                             (i32.const 0x101)))))
    (if (i32.eq (local.get $shape) (i32.const 1))
      (then
        (if (i32.eqz (local.get $size)) (then (return (i32.const 0x0810))))
        (if (i32.eq (local.get $size) (i32.const 1)) (then (return (i32.const 0x0820))))
        (if (i32.eq (local.get $size) (i32.const 2)) (then (return (i32.const 0x1020))))
        (return (i32.const 0x2040))))
    (if (i32.eq (local.get $shape) (i32.const 2))
      (then
        (if (i32.eqz (local.get $size)) (then (return (i32.const 0x1008))))
        (if (i32.eq (local.get $size) (i32.const 1)) (then (return (i32.const 0x2008))))
        (if (i32.eq (local.get $size) (i32.const 2)) (then (return (i32.const 0x2010))))
        (return (i32.const 0x4020))))
    (i32.const 0))

  (func $gba_obj_line (param $y i32)
    (local $i i32) (local $x i32) (local $a0 i32) (local $a1 i32) (local $a2 i32)
    (local $aff i32) (local $md i32) (local $dim i32) (local $w i32) (local $h i32)
    (local $bw i32) (local $bh i32) (local $line i32) (local $ox i32) (local $bpp8 i32)
    (local $tile i32) (local $prio i32) (local $pal i32) (local $pa i32) (local $pb i32)
    (local $pc i32) (local $pd i32) (local $px i32) (local $sx i32) (local $tx i32)
    (local $ty i32) (local $tn i32) (local $ci i32) (local $cur i32) (local $pb2 i32)
    (local $dx i32) (local $dy i32) (local $ent i32) (local $d1 i32) (local $dc i32)
    (local $sy i32) (local $ly i32) (local $mosh i32) (local $mosr i32) (local $t i32) (local $cond i32)
    (local $xa i32) (local $ya i32) (local $rem i32) (local $last i32) (local $ocyc i32)
    (local $cbase i32) (local $ostr i32) (local $mlo i32) (local $mhi i32)
    (local.set $x (i32.const 0))
    (block $cd (loop $cl
      (br_if $cd (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (i32.store (i32.add (i32.const ${GBAOBJ}) (i32.shl (local.get $x) (i32.const 2)))
                 (i32.const 0))
      (i32.store8 (i32.add (i32.const ${GBAOW}) (local.get $x)) (i32.const 0))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $cl)))
    (local.set $dc (call $dispcnt))
    (if (i32.eqz (i32.and (local.get $dc) (i32.const 0x1000))) (then (return)))
    (local.set $d1 (i32.and (local.get $dc) (i32.const 0x40)))
    (local.set $mosr (i32.load16_u (i32.const ${IOREG + 0x4C})))
    ;; OBJ_LENGTH 1210, or OBJ_HBLANK_FREE_LENGTH 954 with DISPCNT bit 5
    (local.set $rem (if (result i32) (i32.and (local.get $dc) (i32.const 0x20)) (then (i32.const 954)) (else (i32.const 1210))))
    (local.set $last (i32.const 0))
    (local.set $i (i32.const 0))
    (block $od (loop $ol
      (br_if $od (i32.ge_u (local.get $i) (i32.const 128)))
      (local.set $ent (i32.add (i32.const ${OAM}) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $a0 (i32.load16_u (local.get $ent)))
      (local.set $a1 (i32.load16_u (i32.add (local.get $ent) (i32.const 2))))
      (local.set $a2 (i32.load16_u (i32.add (local.get $ent) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $aff (i32.and (local.get $a0) (i32.const 0x100)))
      ;; not affine + bit 9 = DISABLED
      (br_if $ol (i32.and (i32.eqz (local.get $aff))
                          (i32.ne (i32.and (local.get $a0) (i32.const 0x200)) (i32.const 0))))
      (local.set $md (i32.and (i32.shr_u (local.get $a0) (i32.const 10)) (i32.const 3)))
      (local.set $dim (call $gba_obj_dim (i32.shr_u (local.get $a0) (i32.const 14))
                                         (i32.shr_u (local.get $a1) (i32.const 14))))
      (local.set $w (i32.and (local.get $dim) (i32.const 0xFF)))
      (local.set $h (i32.shr_u (local.get $dim) (i32.const 8)))
      (local.set $bw (local.get $w))
      (local.set $bh (local.get $h))
      (if (i32.and (i32.ne (local.get $aff) (i32.const 0))
                   (i32.ne (i32.and (local.get $a0) (i32.const 0x200)) (i32.const 0)))
        (then (local.set $bw (i32.shl (local.get $w) (i32.const 1)))
              (local.set $bh (i32.shl (local.get $h) (i32.const 1)))))
      (local.set $ox (i32.and (local.get $a1) (i32.const 0x1FF)))
      (if (i32.and (local.get $ox) (i32.const 0x100))
        (then (local.set $ox (i32.sub (local.get $ox) (i32.const 512)))))
      ;; GBAVideoRendererCleanOAM: which sprites are on the list at all, and
      ;; the rendering cycles each costs (affine 8 + 2 per pixel of its box,
      ;; normal width - 2, less for the part left of the screen)
      (br_if $ol (i32.and (i32.eqz (local.get $aff)) (i32.lt_s (i32.add (local.get $ox) (local.get $bw)) (i32.const 0))))
      (br_if $ol (i32.and (i32.ge_u (i32.and (local.get $a0) (i32.const 0xFF)) (i32.const 160))
                          (i32.lt_u (i32.add (i32.and (local.get $a0) (i32.const 0xFF)) (local.get $bh)) (i32.const 228))))
      (br_if $ol (i32.and (i32.ge_u (i32.and (local.get $a1) (i32.const 0x1FF)) (i32.const ${FB_W}))
                          (i32.lt_u (i32.add (i32.and (local.get $a1) (i32.const 0x1FF)) (local.get $bw)) (i32.const 512))))
      (local.set $ocyc (if (result i32) (local.get $aff)
        (then (i32.add (i32.add (i32.const 8) (i32.shl (local.get $bw) (i32.const 1)))
                       (if (result i32) (i32.lt_s (local.get $ox) (i32.const 0)) (then (local.get $ox)) (else (i32.const 0)))))
        (else (i32.add (i32.sub (local.get $w) (i32.const 2))
                       (if (result i32) (i32.lt_s (local.get $ox) (i32.const 0)) (then (i32.shr_s (local.get $ox) (i32.const 1))) (else (i32.const 0)))))))
      ;; the OBJ line budget (video-software.c _preprocessSprites): 2 cycles
      ;; per OAM entry stepped over, the sprite's own cycles once visited
      (local.set $rem (i32.sub (local.get $rem) (i32.shl (i32.sub (i32.sub (local.get $i) (i32.const 1)) (local.get $last)) (i32.const 1))))
      (local.set $last (i32.sub (local.get $i) (i32.const 1)))
      (br_if $od (i32.le_s (local.get $rem) (i32.const 0)))
      ;; sprite rows: Y is 8 bits and wraps (y + height > 256 starts above 0)
      (local.set $sy (i32.and (local.get $a0) (i32.const 0xFF)))
      (if (i32.gt_s (i32.add (local.get $sy) (local.get $bh)) (i32.const 256))
        (then (local.set $sy (i32.sub (local.get $sy) (i32.const 256)))))
      (br_if $ol (i32.or (i32.lt_s (local.get $y) (local.get $sy))
                         (i32.ge_s (local.get $y) (i32.add (local.get $sy) (local.get $bh)))))
      (local.set $rem (i32.sub (local.get $rem) (local.get $ocyc)))
      (br_if $ol (i32.eqz (local.get $dim)))
      ;; OBJ MOSAIC: the first line of the OBJ_V+1 block, clamped into the
      ;; sprite; runs of OBJ_H+1 pixels (video-software.c, software-obj.c)
      (local.set $mosh (i32.const 1))
      (local.set $ly (local.get $y))
      (if (i32.and (local.get $a0) (i32.const 0x1000))
        (then
          (local.set $mosh (i32.add (i32.and (i32.shr_u (local.get $mosr) (i32.const 8)) (i32.const 0xF)) (i32.const 1)))
          (local.set $t (i32.add (i32.shr_u (local.get $mosr) (i32.const 12)) (i32.const 1)))
          (if (i32.gt_u (local.get $t) (i32.const 1))
            (then
              (local.set $ly (i32.sub (local.get $y) (i32.rem_u (local.get $y) (local.get $t))))
              (if (i32.and (i32.lt_s (local.get $ly) (local.get $sy)) (i32.lt_s (local.get $sy) (i32.const 160)))
                (then (local.set $ly (local.get $sy))))
              (if (i32.ge_s (local.get $ly) (i32.and (i32.add (local.get $sy) (local.get $bh)) (i32.const 0xFF)))
                (then (local.set $ly (i32.sub (i32.add (local.get $sy) (local.get $bh)) (i32.const 1)))))))))
      ;; inY = y - attribute Y, + 256 when negative (PreprocessSprite)
      (local.set $line (i32.sub (local.get $ly) (i32.and (local.get $a0) (i32.const 0xFF))))
      (if (i32.lt_s (local.get $line) (i32.const 0)) (then (local.set $line (i32.add (local.get $line) (i32.const 256)))))
      (local.set $bpp8 (i32.and (local.get $a0) (i32.const 0x2000)))
      (local.set $tile (i32.and (local.get $a2) (i32.const 0x3FF)))
      (local.set $prio (i32.and (i32.shr_u (local.get $a2) (i32.const 10)) (i32.const 3)))
      (local.set $pal (i32.shr_u (local.get $a2) (i32.const 12)))
      ;; In the bitmap modes the frame buffer occupies the low half of OBJ
      ;; tile space, and tiles below 512 are not displayed.
      (br_if $ol (i32.and (i32.ge_u (i32.and (local.get $dc) (i32.const 7)) (i32.const 3))
                          (i32.lt_u (local.get $tile) (i32.const 512))))
      (local.set $cbase (i32.shl (i32.and (local.get $tile)
        (if (result i32) (i32.and (i32.ne (local.get $bpp8) (i32.const 0)) (i32.eqz (local.get $d1))) (then (i32.const -2)) (else (i32.const -1))))
        (i32.const 5)))
      (local.set $ostr (if (result i32) (local.get $d1)
        (then (i32.shr_u (local.get $w) (if (result i32) (local.get $bpp8) (then (i32.const 0)) (else (i32.const 1)))))
        (else (i32.const 0x80))))
      (local.set $mlo (if (result i32) (local.get $d1) (then (i32.const 0x7FFE)) (else (i32.const 0x3FE))))
      (local.set $mhi (if (result i32) (local.get $d1) (then (i32.const 0)) (else (i32.and (local.get $cbase) (i32.const 0x7C00)))))
      ;; the first pixel drawn and the end (condition): the box's right edge
      ;; clipped to the screen, rounded up to a mosaic run
      (local.set $px (if (result i32) (i32.lt_s (local.get $ox) (i32.const 0)) (then (i32.sub (i32.const 0) (local.get $ox))) (else (i32.const 0))))
      (local.set $cond (i32.add (local.get $ox) (local.get $bw)))
      (if (i32.and (i32.gt_u (local.get $mosh) (i32.const 1))
                   (i32.or (i32.eqz (local.get $aff)) (i32.ne (local.get $cond) (i32.const ${FB_W}))))
        (then (if (i32.rem_s (local.get $cond) (local.get $mosh))
          (then (local.set $cond (i32.add (local.get $cond)
                  (i32.sub (local.get $mosh) (i32.rem_s (local.get $cond) (local.get $mosh)))))))))
      (if (i32.gt_s (local.get $cond) (i32.const ${FB_W})) (then (local.set $cond (i32.const ${FB_W}))))
      (if (local.get $aff)
        (then
          (local.set $pb2 (i32.add (i32.const ${OAM}) (i32.add
            (i32.shl (i32.and (i32.shr_u (local.get $a1) (i32.const 9)) (i32.const 0x1F))
                     (i32.const 5)) (i32.const 6))))
          (local.set $pa (i32.load16_s (local.get $pb2)))
          (local.set $pb (i32.load16_s (i32.add (local.get $pb2) (i32.const 8))))
          (local.set $pc (i32.load16_s (i32.add (local.get $pb2) (i32.const 16))))
          (local.set $pd (i32.load16_s (i32.add (local.get $pb2) (i32.const 24))))
          ;; SPRITE_TRANSFORMED_LOOP: accumulators start one pixel left of
          ;; the first drawn one; pixels left of the texture are skipped
          ;; along x up front ("clip off early pixels"), and the first pixel
          ;; that then falls outside it ENDS the line (mosaic: skips it)
          (local.set $dx (i32.sub (i32.sub (local.get $px) (i32.const 1)) (i32.shr_u (local.get $bw) (i32.const 1))))
          (local.set $dy (i32.sub (local.get $line) (i32.shr_u (local.get $bh) (i32.const 1))))
          (local.set $xa (i32.add (i32.add (i32.mul (local.get $pa) (local.get $dx)) (i32.mul (local.get $pb) (local.get $dy)))
                                  (i32.shl (local.get $w) (i32.const 7))))
          (local.set $ya (i32.add (i32.add (i32.mul (local.get $pc) (local.get $dx)) (i32.mul (local.get $pd) (local.get $dy)))
                                  (i32.shl (local.get $h) (i32.const 7))))
          (if (local.get $pa)
            (then
              (local.set $t (i32.const 0))
              (if (i32.lt_s (i32.shr_s (local.get $xa) (i32.const 8)) (i32.const 0))
                (then (local.set $t (i32.div_s (i32.sub (i32.sub (i32.const 0) (local.get $xa)) (i32.const 1)) (local.get $pa))))
                (else (if (i32.ge_s (i32.shr_s (local.get $xa) (i32.const 8)) (local.get $w))
                  (then (local.set $t (i32.div_s (i32.sub (i32.shl (local.get $w) (i32.const 8)) (local.get $xa)) (local.get $pa)))))))
              (local.set $xa (i32.add (local.get $xa) (i32.mul (local.get $pa) (local.get $t))))
              (local.set $ya (i32.add (local.get $ya) (i32.mul (local.get $pc) (local.get $t))))
              (local.set $px (i32.add (local.get $px) (local.get $t)))))
          ;; ... and then along y, through PC
          (if (local.get $pc)
            (then
              (local.set $t (i32.const 0))
              (if (i32.lt_s (i32.shr_s (local.get $ya) (i32.const 8)) (i32.const 0))
                (then (local.set $t (i32.div_s (i32.sub (i32.sub (i32.const 0) (local.get $ya)) (i32.const 1)) (local.get $pc))))
                (else (if (i32.ge_s (i32.shr_s (local.get $ya) (i32.const 8)) (local.get $h))
                  (then (local.set $t (i32.div_s (i32.sub (i32.shl (local.get $h) (i32.const 8)) (local.get $ya)) (local.get $pc)))))))
              (local.set $xa (i32.add (local.get $xa) (i32.mul (local.get $pa) (local.get $t))))
              (local.set $ya (i32.add (local.get $ya) (i32.mul (local.get $pc) (local.get $t))))
              (local.set $px (i32.add (local.get $px) (local.get $t)))))
          ;; clipped out of [start, condition): the sprite draws nothing on this line
          (br_if $ol (i32.or (i32.lt_s (i32.add (local.get $ox) (local.get $px)) (i32.const 0))
                             (i32.ge_s (i32.add (local.get $ox) (local.get $px)) (local.get $cond))))
          (local.set $tx (i32.shr_s (local.get $xa) (i32.const 8)))
          (local.set $ty (i32.shr_s (local.get $ya) (i32.const 8)))))
      (block $pd_ (loop $pl
        (local.set $sx (i32.add (local.get $ox) (local.get $px)))
        (br_if $pd_ (i32.ge_s (local.get $sx) (local.get $cond)))
        (local.set $px (i32.add (local.get $px) (i32.const 1)))
        (if (local.get $aff)
          (then
            (local.set $xa (i32.add (local.get $xa) (local.get $pa)))
            (local.set $ya (i32.add (local.get $ya) (local.get $pc)))
            (if (i32.or (i32.eq (local.get $mosh) (i32.const 1)) (i32.eqz (i32.rem_s (local.get $sx) (local.get $mosh))))
              (then (local.set $tx (i32.shr_s (local.get $xa) (i32.const 8)))
                    (local.set $ty (i32.shr_s (local.get $ya) (i32.const 8)))))
            (if (i32.or (i32.ge_u (local.get $tx) (local.get $w)) (i32.ge_u (local.get $ty) (local.get $h)))
              (then (br_if $pd_ (i32.eq (local.get $mosh) (i32.const 1))) (br $pl))))
          (else
            (local.set $tx (i32.sub (local.get $px) (i32.const 1)))
            (local.set $ty (local.get $line))
            (if (i32.and (local.get $a1) (i32.const 0x1000))
              (then (local.set $tx (i32.sub (i32.sub (local.get $w) (i32.const 1)) (local.get $tx)))))
            (if (i32.and (local.get $a1) (i32.const 0x2000))
              (then (local.set $ty (i32.sub (i32.sub (local.get $h) (i32.const 1)) (local.get $ty)))))
            ;; SPRITE_MOSAIC_LOOP: the run's first column, clamped to the sprite
            (if (i32.gt_u (local.get $mosh) (i32.const 1))
              (then
                (local.set $tx (if (result i32) (i32.and (local.get $a1) (i32.const 0x1000))
                  (then (i32.add (local.get $tx) (i32.rem_s (local.get $sx) (local.get $mosh))))
                  (else (i32.sub (local.get $tx) (i32.rem_s (local.get $sx) (local.get $mosh))))))
                (if (i32.lt_s (local.get $tx) (i32.const 0)) (then (local.set $tx (i32.const 0))))
                (if (i32.gt_s (local.get $tx) (i32.sub (local.get $w) (i32.const 1)))
                  (then (local.set $tx (i32.sub (local.get $w) (i32.const 1)))))))))
        (br_if $pl (i32.lt_s (local.get $sx) (i32.const 0)))
        ;; the OBJ VRAM halfword as mGBA addresses it (SPRITE_XBASE/_YBASE,
        ;; SPRITE_DRAW_PIXEL): 1D mapping, row stride = the sprite's width in
        ;; bytes; 2D mapping, a 32-cell (1KB) row that the x offset WRAPS
        ;; inside (maskLo $3FE + the row base in maskHi), and an 8bpp
        ;; sprite's tile number rounded down to even
        (local.set $tn (if (result i32) (local.get $bpp8)
          (then (i32.add (i32.add (i32.mul (i32.and (local.get $ty) (i32.const -8)) (local.get $ostr))
                                  (i32.shl (i32.and (local.get $ty) (i32.const 7)) (i32.const 3)))
                         (local.get $mhi)))
          (else (i32.add (i32.add (i32.mul (i32.and (local.get $ty) (i32.const -8)) (local.get $ostr))
                                  (i32.shl (i32.and (local.get $ty) (i32.const 7)) (i32.const 2)))
                         (local.get $mhi)))))
        (local.set $ci (if (result i32) (local.get $bpp8)
          (then (i32.add (i32.shl (i32.and (local.get $tx) (i32.const -8)) (i32.const 3)) (i32.and (local.get $tx) (i32.const 6))))
          (else (i32.add (i32.shl (i32.and (local.get $tx) (i32.const -8)) (i32.const 2)) (i32.and (i32.shr_u (local.get $tx) (i32.const 1)) (i32.const 2))))))
        (local.set $ci (i32.load16_u (i32.add (i32.const ${VRAM + 0x10000})
          (i32.and (i32.add (local.get $tn) (i32.and (i32.add (local.get $ci) (local.get $cbase)) (local.get $mlo)))
                   (i32.const 0x7FFE)))))
        (if (local.get $bpp8)
          (then (local.set $ci (i32.and (i32.shr_u (local.get $ci) (i32.shl (i32.and (local.get $tx) (i32.const 1)) (i32.const 3))) (i32.const 0xFF))))
          (else
            (local.set $ci (i32.and (i32.shr_u (local.get $ci) (i32.shl (i32.and (local.get $tx) (i32.const 3)) (i32.const 2))) (i32.const 0xF)))
            (if (local.get $ci)
              (then (local.set $ci (i32.or (local.get $ci)
                      (i32.shl (local.get $pal) (i32.const 4))))))))
        (br_if $pl (i32.eqz (local.get $ci)))
        (if (i32.eq (local.get $md) (i32.const 2))
          (then (i32.store8 (i32.add (i32.const ${GBAOW}) (local.get $sx)) (i32.const 1))
                (br $pl)))
        (local.set $cur (i32.load (i32.add (i32.const ${GBAOBJ})
                                           (i32.shl (local.get $sx) (i32.const 2)))))
        ;; Lower OAM index wins among equal priority (it was written first);
        ;; a strictly higher priority (lower number) always wins.
        (br_if $pl (i32.and (i32.ne (local.get $cur) (i32.const 0))
                            (i32.ge_u (local.get $prio)
                                      (i32.and (i32.shr_u (local.get $cur) (i32.const 16))
                                               (i32.const 3)))))
        (i32.store (i32.add (i32.const ${GBAOBJ}) (i32.shl (local.get $sx) (i32.const 2)))
          (i32.or (i32.or (i32.const 0x80000000)
                          (i32.shl (i32.eq (local.get $md) (i32.const 1)) (i32.const 30)))
                  (i32.or (i32.shl (local.get $prio) (i32.const 16))
                          (i32.add (i32.const 256) (local.get $ci)))))
        (br $pl)))
      (br $ol))))

  ;; ---- composition ---------------------------------------------------------
  ;; Back to front by PRIORITY (BGxCNT bits 0-1, 0 = front). Within one
  ;; priority the BGs go 3..0 and the sprites of that priority go LAST, i.e.
  ;; on top: an OBJ beats a BG of the same priority. Which BGs exist depends
  ;; on the mode: 0 = four text BGs; 1 = BG0/1 text + BG2 affine; 2 = BG2/3
  ;; affine; 3/4/5 = BG2 is a bitmap.
  (func $gba_compose (param $y i32)
    (local $prio i32) (local $bg i32) (local $x i32) (local $dst i32)
    (local $mode i32) (local $kind i32) (local $bd i32) (local $v i32)
    (local $bld i32)
    (local.set $dst (i32.add (i32.const ${GBAFB})
      (i32.mul (local.get $y) (i32.const ${FB_W * 4}))))
    (local.set $mode (i32.and (call $dispcnt) (i32.const 7)))
    ;; Backdrop first: palette entry 0 is what shows where nothing draws. It
    ;; is laid down without the alpha path (nothing lies under it), but it
    ;; IS a first target for brighten/darken, which is how a whole-screen
    ;; fade reaches the parts of the screen no layer covers.
    (local.set $bd (call $gba_pal (i32.const 0)))
    (local.set $bld (i32.load16_u (i32.const ${IOREG + BLDCNT})))
    (local.set $x (i32.const 0))
    (block $bdd (loop $bdl
      (br_if $bdd (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (i32.store (i32.add (local.get $dst) (i32.shl (local.get $x) (i32.const 2)))
        (if (result i32)
          (i32.and (i32.and (i32.shr_u (local.get $bld) (i32.const 5))
                            (i32.shr_u (i32.load8_u (i32.add (i32.const ${GBAWIN}) (local.get $x)))
                                       (i32.const 5)))
                   (i32.and (i32.ge_u (i32.and (i32.shr_u (local.get $bld) (i32.const 6))
                                               (i32.const 3)) (i32.const 2))
                            (i32.const 1)))
          (then (call $gba_fade (local.get $bd)
                  (i32.eq (i32.and (i32.shr_u (local.get $bld) (i32.const 6)) (i32.const 3))
                          (i32.const 2))))
          (else (local.get $bd))))
      (i32.store8 (i32.add (i32.const ${GBALAY}) (i32.add
          (i32.mul (local.get $y) (i32.const ${FB_W})) (local.get $x)))
        (i32.const 5))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $bdl)))
    (local.set $prio (i32.const 3))
    (block $pd (loop $pl
      (br_if $pd (i32.lt_s (local.get $prio) (i32.const 0)))
      (local.set $bg (i32.const 3))
      (block $gd (loop $gl
        (br_if $gd (i32.lt_s (local.get $bg) (i32.const 0)))
        ;; kind: 0 absent, 1 text, 2 affine, 3 bitmap
        (local.set $kind (i32.const 0))
        (if (i32.eqz (local.get $mode)) (then (local.set $kind (i32.const 1))))
        (if (i32.eq (local.get $mode) (i32.const 1))
          (then (if (i32.lt_u (local.get $bg) (i32.const 2)) (then (local.set $kind (i32.const 1))))
                (if (i32.eq (local.get $bg) (i32.const 2)) (then (local.set $kind (i32.const 2))))))
        (if (i32.eq (local.get $mode) (i32.const 2))
          (then (if (i32.ge_u (local.get $bg) (i32.const 2)) (then (local.set $kind (i32.const 2))))))
        (if (i32.and (i32.ge_u (local.get $mode) (i32.const 3))
                     (i32.le_u (local.get $mode) (i32.const 5)))
          (then (if (i32.eq (local.get $bg) (i32.const 2)) (then (local.set $kind (i32.const 3))))))
        ;; DISPCNT bit 8+n enables BG n.
        (if (i32.and (i32.ne (local.get $kind) (i32.const 0))
              (i32.ne (i32.and (call $dispcnt) (i32.shl (i32.const 0x100) (local.get $bg)))
                      (i32.const 0)))
          (then
            (if (i32.eq (i32.and (i32.load16_u (i32.add (i32.const ${IOREG + BG0CNT})
                                   (i32.shl (local.get $bg) (i32.const 1))))
                                 (i32.const 3))
                        (local.get $prio))
              (then
                (if (i32.eq (local.get $kind) (i32.const 1))
                  (then (call $gba_bg_line (local.get $bg) (local.get $y))))
                (if (i32.eq (local.get $kind) (i32.const 2))
                  (then (call $gba_aff_line (local.get $bg) (local.get $y))))
                (if (i32.eq (local.get $kind) (i32.const 3))
                  (then (call $gba_bmp_line (local.get $mode) (local.get $y))))))))
        (local.set $bg (i32.sub (local.get $bg) (i32.const 1)))
        (br $gl)))
      ;; sprites of this priority, on top of the BGs of this priority
      (local.set $x (i32.const 0))
      (block $sd (loop $sl
        (br_if $sd (i32.ge_u (local.get $x) (i32.const ${FB_W})))
        (local.set $v (i32.load (i32.add (i32.const ${GBAOBJ}) (i32.shl (local.get $x) (i32.const 2)))))
        (if (i32.and (i32.ne (local.get $v) (i32.const 0))
                     (i32.eq (i32.and (i32.shr_u (local.get $v) (i32.const 16)) (i32.const 3))
                             (local.get $prio)))
          (then (call $gba_plot_obj (local.get $x) (local.get $y)
                  (call $gba_pal (i32.and (local.get $v) (i32.const 0x1FF)))
                  (i32.and (i32.shr_u (local.get $v) (i32.const 30)) (i32.const 1)))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $sl)))
      (local.set $prio (i32.sub (local.get $prio) (i32.const 1)))
      (br $pl))))

  ;; ---- affine BG -------------------------------------------------------------
  ;; One byte per map entry, tiles always 8bpp, square map of 128 << size
  ;; pixels; BGxCNT bit 13 selects wraparound, otherwise outside is clear.
  (func $gba_aff_line (param $bg i32) (param $y i32)
    (local $cnt i32) (local $chbase i32) (local $scbase i32) (local $sz i32)
    (local $wrap i32) (local $pa i32) (local $pc i32) (local $rx i32) (local $ry i32)
    (local $x i32) (local $tx i32) (local $ty i32) (local $t i32) (local $ci i32)
    (local $po i32)
    (local $mh i32) (local $mwait i32) (local $held i32)
    (local.set $cnt (i32.load16_u (i32.add (i32.const ${IOREG + BG0CNT})
      (i32.shl (local.get $bg) (i32.const 1)))))
    (local.set $chbase (i32.add (i32.const ${VRAM})
      (i32.mul (i32.and (i32.shr_u (local.get $cnt) (i32.const 2)) (i32.const 3))
               (i32.const 0x4000))))
    (local.set $scbase (i32.add (i32.const ${VRAM})
      (i32.mul (i32.and (i32.shr_u (local.get $cnt) (i32.const 8)) (i32.const 0x1F))
               (i32.const 0x800))))
    (local.set $sz (i32.shl (i32.const 128) (i32.and (i32.shr_u (local.get $cnt) (i32.const 14))
                                                     (i32.const 3))))
    (local.set $wrap (i32.and (local.get $cnt) (i32.const 0x2000)))
    (local.set $po (i32.shl (i32.sub (local.get $bg) (i32.const 2)) (i32.const 4)))
    (local.set $pa (call $gba_ios16 (i32.add (i32.const 0x20) (local.get $po))))
    (local.set $pc (call $gba_ios16 (i32.add (i32.const 0x24) (local.get $po))))
    (if (i32.eq (local.get $bg) (i32.const 2))
      (then (local.set $rx (global.get $aff2x)) (local.set $ry (global.get $aff2y)))
      (else (local.set $rx (global.get $aff3x)) (local.set $ry (global.get $aff3y))))
    ;; MOSAIC (BACKGROUND_BITMAP_INIT / MODE_2_MOSAIC): the reference point of
    ;; the block's first line, and a pixel sampled only at the start of each
    ;; BG_H+1 run and held; a run start outside the (non-wrapping) map is
    ;; skipped WITHOUT starting the run, so the next pixel samples again.
    (local.set $mh (i32.const 0))
    (if (i32.and (local.get $cnt) (i32.const 0x40))
      (then
        (local.set $mh (i32.and (i32.load16_u (i32.const ${IOREG + 0x4C})) (i32.const 0xF)))
        (local.set $t (i32.rem_u (local.get $y)
          (i32.add (i32.and (i32.shr_u (i32.load16_u (i32.const ${IOREG + 0x4C})) (i32.const 4)) (i32.const 0xF)) (i32.const 1))))
        (local.set $rx (i32.sub (local.get $rx) (i32.mul (local.get $t) (call $gba_ios16 (i32.add (i32.const 0x22) (local.get $po))))))
        (local.set $ry (i32.sub (local.get $ry) (i32.mul (local.get $t) (call $gba_ios16 (i32.add (i32.const 0x26) (local.get $po))))))))
    (local.set $mwait (i32.const 0))
    (local.set $held (i32.const 0))
    (local.set $x (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (local.set $tx (i32.shr_s (i32.add (local.get $rx) (i32.mul (local.get $pa) (local.get $x)))
                                (i32.const 8)))
      (local.set $ty (i32.shr_s (i32.add (local.get $ry) (i32.mul (local.get $pc) (local.get $x)))
                                (i32.const 8)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (block $have
        (if (local.get $mwait)
          (then (local.set $mwait (i32.sub (local.get $mwait) (i32.const 1)))
                (local.set $ci (local.get $held)) (br $have)))
        (if (local.get $wrap)
          (then (local.set $tx (i32.and (local.get $tx) (i32.sub (local.get $sz) (i32.const 1))))
                (local.set $ty (i32.and (local.get $ty) (i32.sub (local.get $sz) (i32.const 1))))))
        (br_if $l (i32.or (i32.ge_u (local.get $tx) (local.get $sz))
                          (i32.ge_u (local.get $ty) (local.get $sz))))
        (local.set $t (i32.load8_u (i32.add (local.get $scbase)
          (i32.add (i32.mul (i32.shr_u (local.get $ty) (i32.const 3))
                            (i32.shr_u (local.get $sz) (i32.const 3)))
                   (i32.shr_u (local.get $tx) (i32.const 3))))))
        (local.set $ci (i32.load8_u (i32.add (i32.add (local.get $chbase)
            (i32.shl (local.get $t) (i32.const 6)))
          (i32.add (i32.shl (i32.and (local.get $ty) (i32.const 7)) (i32.const 3))
                   (i32.and (local.get $tx) (i32.const 7))))))
        (local.set $held (local.get $ci))
        (local.set $mwait (local.get $mh)))
      (if (local.get $ci)
        (then (call $gba_plot (i32.sub (local.get $x) (i32.const 1)) (local.get $y)
                (local.get $bg) (call $gba_pal (local.get $ci)))))
      (br $l))))

  ;; ---- bitmap BG2 (modes 3/4/5) ----------------------------------------------
  ;; Sampled through the same affine reference point as an affine BG (a
  ;; bitmap CAN be rotated and scaled; mode 5 is commonly stretched to full
  ;; screen), with BG2PA/PD defaulting to 1.0 as the BIOS leaves them.
  ;;   mode 3: 240x160 BGR555      mode 4: 240x160 8-bit, index 0 clear
  ;;   mode 5: 160x128 BGR555      DISPCNT bit 4 selects page 2 at +$A000
  (func $gba_bmp_line (param $mode i32) (param $y i32)
    (local $pa i32) (local $pc i32) (local $x i32) (local $tx i32) (local $ty i32)
    (local $w i32) (local $h i32) (local $base i32) (local $c i32)
    (local $rx i32) (local $ry i32) (local $mh i32) (local $mwait i32) (local $held i32)
    (local.set $pa (call $gba_ios16 (i32.const 0x20)))
    (local.set $pc (call $gba_ios16 (i32.const 0x24)))
    (local.set $w (i32.const 240))
    (local.set $h (i32.const 160))
    (if (i32.eq (local.get $mode) (i32.const 5))
      (then (local.set $w (i32.const 160)) (local.set $h (i32.const 128))))
    (local.set $base (i32.const ${VRAM}))
    (if (i32.and (i32.ne (local.get $mode) (i32.const 3))
                 (i32.ne (i32.and (call $dispcnt) (i32.const 0x10)) (i32.const 0)))
      (then (local.set $base (i32.const ${VRAM + 0xA000}))))
    ;; MOSAIC, as for an affine BG (BACKGROUND_BITMAP_INIT/_ITERATE)
    (local.set $rx (global.get $aff2x))
    (local.set $ry (global.get $aff2y))
    (local.set $mh (i32.const 0))
    (if (i32.and (i32.load16_u (i32.const ${IOREG + BG0CNT + 4})) (i32.const 0x40))
      (then
        (local.set $mh (i32.and (i32.load16_u (i32.const ${IOREG + 0x4C})) (i32.const 0xF)))
        (local.set $c (i32.rem_u (local.get $y)
          (i32.add (i32.and (i32.shr_u (i32.load16_u (i32.const ${IOREG + 0x4C})) (i32.const 4)) (i32.const 0xF)) (i32.const 1))))
        (local.set $rx (i32.sub (local.get $rx) (i32.mul (local.get $c) (call $gba_ios16 (i32.const 0x22)))))
        (local.set $ry (i32.sub (local.get $ry) (i32.mul (local.get $c) (call $gba_ios16 (i32.const 0x26)))))))
    (local.set $mwait (i32.const 0))
    (local.set $x (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (local.set $tx (i32.shr_s (i32.add (local.get $rx) (i32.mul (local.get $pa) (local.get $x)))
                                (i32.const 8)))
      (local.set $ty (i32.shr_s (i32.add (local.get $ry) (i32.mul (local.get $pc) (local.get $x)))
                                (i32.const 8)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (local.get $mwait)
        (then (local.set $mwait (i32.sub (local.get $mwait) (i32.const 1))))
        (else
          (br_if $l (i32.or (i32.ge_u (local.get $tx) (local.get $w))
                            (i32.ge_u (local.get $ty) (local.get $h))))
          (local.set $held (if (result i32) (i32.eq (local.get $mode) (i32.const 4))
            (then (i32.load8_u (i32.add (local.get $base)
                    (i32.add (i32.mul (local.get $ty) (local.get $w)) (local.get $tx)))))
            (else (i32.load16_u (i32.add (local.get $base)
                    (i32.shl (i32.add (i32.mul (local.get $ty) (local.get $w)) (local.get $tx))
                             (i32.const 1)))))))
          (local.set $mwait (local.get $mh))))
      (if (i32.eq (local.get $mode) (i32.const 4))
        (then
          (if (local.get $held)
            (then (call $gba_plot (i32.sub (local.get $x) (i32.const 1)) (local.get $y)
                    (i32.const 2) (call $gba_pal (local.get $held))))))
        (else
          (call $gba_plot (i32.sub (local.get $x) (i32.const 1)) (local.get $y) (i32.const 2)
            (call $gba_rgb (local.get $held)))))
      (br $l))))

  ;; One text-mode background layer for one scanline.
  ;;
  ;; BGxCNT: bits 2-3 char base block (16KB each), bit 7 = 8bpp,
  ;;         bits 8-12 screen base block (2KB each), bits 14-15 screen size.
  ;; BGxHOFS/BGxVOFS are 9-bit scroll offsets at $04000010 + bg*4.
  (func $gba_bg_line (param $bg i32) (param $y i32)
    (local $cnt i32) (local $chbase i32) (local $scbase i32) (local $size i32)
    (local $bpp8 i32) (local $hofs i32) (local $vofs i32)
    (local $sy i32) (local $sx i32) (local $x i32)
    (local $ty i32) (local $tx i32) (local $mapi i32) (local $ent i32)
    (local $tile i32) (local $pal i32) (local $px i32) (local $py i32)
    (local $ci i32) (local $dst i32) (local $sc i32) (local $mw i32) (local $mh i32)
    (local $mos i32) (local $y0 i32)
    (local.set $cnt (i32.load16_u (i32.add (i32.const ${IOREG + BG0CNT})
      (i32.shl (local.get $bg) (i32.const 1)))))
    (local.set $chbase (i32.add (i32.const ${VRAM})
      (i32.mul (i32.and (i32.shr_u (local.get $cnt) (i32.const 2)) (i32.const 3))
               (i32.const 0x4000))))
    (local.set $scbase (i32.add (i32.const ${VRAM})
      (i32.mul (i32.and (i32.shr_u (local.get $cnt) (i32.const 8)) (i32.const 0x1F))
               (i32.const 0x800))))
    (local.set $bpp8 (i32.and (i32.shr_u (local.get $cnt) (i32.const 7)) (i32.const 1)))
    (local.set $size (i32.and (i32.shr_u (local.get $cnt) (i32.const 14)) (i32.const 3)))
    ;; Screen size 0=256x256, 1=512x256, 2=256x512, 3=512x512 pixels.
    (local.set $mw (if (result i32) (i32.and (local.get $size) (i32.const 1))
      (then (i32.const 512)) (else (i32.const 256))))
    (local.set $mh (if (result i32) (i32.and (local.get $size) (i32.const 2))
      (then (i32.const 512)) (else (i32.const 256))))
    (local.set $hofs (i32.and (i32.load16_u (i32.add (i32.const ${IOREG + BG0HOFS})
      (i32.shl (local.get $bg) (i32.const 2)))) (i32.const 0x1FF)))
    (local.set $vofs (i32.and (i32.load16_u (i32.add (i32.const ${IOREG + BG0HOFS + 2})
      (i32.shl (local.get $bg) (i32.const 2)))) (i32.const 0x1FF)))
    ;; MOSAIC (BGxCNT bit 6): the line shown is the first of its block of
    ;; BG_V+1 lines, and each run of BG_H+1 pixels shows its first pixel
    ;; (software-mode0.c: y -= y % mosaicV; the mosaicWait hold)
    (local.set $mos (i32.const 1))
    (if (i32.and (local.get $cnt) (i32.const 0x40))
      (then
        (local.set $mos (i32.add (i32.and (i32.load16_u (i32.const ${IOREG + 0x4C})) (i32.const 0xF)) (i32.const 1)))
        (local.set $sy (i32.add (i32.and (i32.shr_u (i32.load16_u (i32.const ${IOREG + 0x4C})) (i32.const 4)) (i32.const 0xF)) (i32.const 1)))
        (local.set $y0 (i32.sub (local.get $y) (i32.rem_u (local.get $y) (local.get $sy)))))
      (else (local.set $y0 (local.get $y))))
    (local.set $sy (i32.rem_u (i32.add (local.get $y0) (local.get $vofs))
                              (local.get $mh)))
    (local.set $dst (i32.add (i32.const ${GBAFB})
      (i32.mul (local.get $y) (i32.const ${FB_W * 4}))))
    (local.set $x (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (i32.const ${FB_W})))
      (local.set $sx (i32.rem_u (i32.add (i32.sub (local.get $x) (i32.rem_u (local.get $x) (local.get $mos)))
                                         (local.get $hofs))
                                (local.get $mw)))
      (local.set $ty (i32.shr_u (local.get $sy) (i32.const 3)))
      (local.set $tx (i32.shr_u (local.get $sx) (i32.const 3)))
      ;; SCREEN BLOCKS. A 512-wide map is TWO 32x32 blocks side by side, each
      ;; 2KB - not one 64-entry-wide array. Treating it as the latter reads
      ;; the right half of the map from the wrong block and tears the picture
      ;; down a vertical line at x=256.
      (local.set $sc (i32.const 0))
      (if (i32.ge_u (local.get $tx) (i32.const 32))
        (then (local.set $sc (i32.const 1))
              (local.set $tx (i32.sub (local.get $tx) (i32.const 32)))))
      (if (i32.ge_u (local.get $ty) (i32.const 32))
        (then (local.set $sc (i32.add (local.get $sc)
                (if (result i32) (i32.eq (local.get $mw) (i32.const 512))
                  (then (i32.const 2)) (else (i32.const 1)))))
              (local.set $ty (i32.sub (local.get $ty) (i32.const 32)))))
      (local.set $mapi (i32.add (i32.add (local.get $scbase)
          (i32.mul (local.get $sc) (i32.const 0x800)))
        (i32.shl (i32.add (i32.mul (local.get $ty) (i32.const 32))
                          (local.get $tx)) (i32.const 1))))
      (local.set $ent (i32.load16_u (local.get $mapi)))
      (local.set $tile (i32.and (local.get $ent) (i32.const 0x3FF)))
      (local.set $pal (i32.shr_u (local.get $ent) (i32.const 12)))
      (local.set $px (i32.and (local.get $sx) (i32.const 7)))
      (local.set $py (i32.and (local.get $sy) (i32.const 7)))
      ;; bit 10 = horizontal flip, bit 11 = vertical.
      (if (i32.and (local.get $ent) (i32.const 0x400))
        (then (local.set $px (i32.sub (i32.const 7) (local.get $px)))))
      (if (i32.and (local.get $ent) (i32.const 0x800))
        (then (local.set $py (i32.sub (i32.const 7) (local.get $py)))))
      (if (local.get $bpp8)
        (then
          ;; 8bpp: 64 bytes per tile, one byte per pixel, palette 0 only.
          (local.set $ci (i32.load8_u (i32.add (i32.add (local.get $chbase)
              (i32.mul (local.get $tile) (i32.const 64)))
            (i32.add (i32.shl (local.get $py) (i32.const 3)) (local.get $px))))))
        (else
          ;; 4bpp: 32 bytes per tile, LOW nibble is the LEFT pixel of a pair.
          (local.set $ci (i32.load8_u (i32.add (i32.add (local.get $chbase)
              (i32.mul (local.get $tile) (i32.const 32)))
            (i32.add (i32.shl (local.get $py) (i32.const 2))
                     (i32.shr_u (local.get $px) (i32.const 1))))))
          (local.set $ci (if (result i32) (i32.and (local.get $px) (i32.const 1))
            (then (i32.shr_u (local.get $ci) (i32.const 4)))
            (else (i32.and (local.get $ci) (i32.const 0xF)))))
          (if (local.get $ci)
            (then (local.set $ci (i32.or (local.get $ci)
                    (i32.shl (local.get $pal) (i32.const 4))))))))
      ;; COLOUR INDEX 0 IS TRANSPARENT in every tiled mode. Drawing it opaque
      ;; paints a solid rectangle over whatever the lower-priority layer put
      ;; there, which hides the background behind every sprite-shaped hole.
      ;; Through $gba_plot, never a direct store: this is the only path a
      ;; background pixel takes, so the colour-effects unit cannot be
      ;; bypassed by a layer, and the pixel's layer id is recorded for
      ;; whatever draws over it.
      (if (local.get $ci)
        (then (call $gba_plot (local.get $x) (local.get $y) (local.get $bg)
                (call $gba_pal (local.get $ci)))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l))))
`;
}

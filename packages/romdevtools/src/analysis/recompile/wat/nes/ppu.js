// NES PPU for the WAT cart: a port of fceumm's ppu.c (the "old" PPU).
//
// The reference for verification is fceumm, so the PPU here follows its model
// rather than the hardware documents, and follows it closely enough that the
// same CPU timestamps produce the same pixels:
//
//   * the background is rendered LAZILY by RefreshLine(lastpixel), called from
//     every PPU register access that can change the picture ($2000/$2001/$2005/
//     $2006 writes, $2002/$2007 reads) via FCEUPPU_LineUpdate. `lastpixel` is
//     derived from the CPU timestamp, so a mid-line split lands on the same
//     tile it lands on in the reference;
//   * sprites for line N+1 are fetched at the end of line N (FetchSpriteData),
//     drawn into a line buffer (RefreshSprites) and composited when line N+1
//     finishes (CopySprites), with fceumm's 8-per-line limit and priority;
//   * sprite 0 hit is CheckSpriteHit, run as the background catches up, so a
//     $2002 poll sees the flag at the same instant the reference sets it;
//   * bit 6 of a background pixel marks "transparent" exactly as fceumm's
//     `Pal[0] |= 64` trick does, which is what sprite priority and the hit
//     test key on.
//
// The PPU always reads pattern data from the 8KB window at CHR; a mapper that
// banks CHR copies the selected bank(s) into that window on its register
// write, so this file never changes per mapper. Nametable mirroring is the
// mapper's `ntSel` expression.
//
// Ported from the earlier Python emitter; the emitted text is
// kept identical so the two can be diffed.
//
// Plain JS ESM + JSDoc.

export const FB_W = 256;
export const FB_H = 240;

// Linear memory. RAM is at 0 so zero page is a plain load8 at the operand address.
export const RAM = 0x00000;     // 2KB
export const NTRAM = 0x04000;   // 2KB CIRAM
export const PAL = 0x05000;     // 32 bytes PALRAM
export const UPAL = 0x05020;    // 3 bytes UPALRAM ($3F04/$3F08/$3F0C)
export const OAM = 0x05100;     // 256 bytes SPRAM
export const SPRBUF = 0x05200;  // 8 x {ca0, ca1, atr, x}
export const SPRLINE = 0x05300; // 256 + 8 bytes sprlinebuf
export const APUREG = 0x05500;  // $4000-$4017 write shadow
export const LUT1 = 0x06000;    // ppulut1[256] u32
export const LUT2 = 0x06400;    // ppulut2[256] u32
export const LUT3 = 0x06800;    // ppulut3[128] u32
export const EMPH = 0x05600;    // 240 bytes: each line's colour emphasis (fceumm XDBuf row)
export const RGBTAB = 0x07000;  // 512 x RGBA: 8 emphasis levels x 64 colours (fceumm palette[512])
export const CYCTAB = 0x06B00;  // fceumm CycTable, 256 bytes
export const DMCTAB = 0x06C00;  // NTSCDMCTable, 16 x u32
export const NESFB = 0x30000;   // XBuf: 256 x 240 palette indices (+ overflow slack)
export const PRG = 0x40000;     // PRG ROM image
export const WRAM = 0x50000;    // $6000-$7FFF 8KB (fceumm NROM maps WRAM here)
export const CHR = 0x60000;     // CHR ROM/RAM, the 8KB window the PPU reads

/** @param {number[]} arr */
function u32le(arr) {
  const b = new Uint8Array(arr.length * 4);
  const dv = new DataView(b.buffer);
  arr.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return b;
}

/**
 * fceumm makeppulut(), verbatim. These are computed, not copied: the code is
 * the provenance.
 * @returns {Array<[number, Uint8Array]>} [linear address, bytes]
 */
export function luts() {
  const l1 = new Array(256).fill(0), l2 = new Array(256).fill(0), l3 = new Array(128).fill(0);
  for (let x = 0; x < 256; x++) {
    for (let y = 0; y < 8; y++) l1[x] |= ((x >> (7 - y)) & 1) << (y * 4);
    l2[x] = (l1[x] << 1) >>> 0;
  }
  for (let cc = 0; cc < 16; cc++) {
    for (let xo = 0; xo < 8; xo++) {
      let v = 0;
      for (let pixel = 0; pixel < 8; pixel++) {
        const shiftr = Math.floor((pixel + xo) / 8) * 2;
        v |= ((cc >> shiftr) & 3) << (2 + pixel * 4);
      }
      l3[xo | (cc << 3)] = v >>> 0;
    }
  }
  return [[LUT1, u32le(l1)], [LUT2, u32le(l2)], [LUT3, u32le(l3)]];
}

/** PPU globals. */
export function globalsWat() {
  const g = ["ppu0", "ppu1", "ppustatus", "ppu3", "ppuspl", "genlatch", "vrambuf",
    "vtoggle", "xoff", "tmpaddr", "refaddr", "scanline", "pline",
    "plinef", "firsttile", "linestartts", "tofix", "pshift0", "pshift1",
    "atlatch", "sphitdata", "spork", "numsprites", "blurp", "kook"];
  let s = g.map((n) => `  (global $${n} (mut i32) (i32.const 0))\n`).join("");
  s += "  (global $sphitx (mut i32) (i32.const 0x100))\n";
  s += "  (global $ppudead (mut i32) (i32.const 2))\n";
  return s;
}

/**
 * The PPU functions.
 * @param {object} o
 * @param {string} o.NTSEL     WAT expression: nametable slot (local $slot, 0-3) -> CIRAM page (0/1)
 * @param {string} o.CHRWRITE  WAT statement for a $2007 write below $2000 (CHR RAM), or ''
 */
export function ppuWat({ NTSEL, CHRWRITE, HBHOOK = "" }) {
  // DoLine with a mapper GameHBIRQHook (MMC3's scanline counter): run 6,
  // Fixit2, run 4, hook, run 59 when rendering and (PPU[0] & $38) != $18;
  // otherwise the plain path, then the hook if that became true meanwhile.
  const hbCond = "(i32.and (i32.ne (i32.and (global.get $ppu1) (i32.const 0x18)) (i32.const 0)) " +
    "(i32.ne (i32.and (global.get $ppu0) (i32.const 0x38)) (i32.const 0x18)))";
  const hblank = HBHOOK ? `(if ${hbCond}
      (then
        (call $run (i32.const 6))
        (call $fixit2)
        (call $run (i32.const 4))
        ${HBHOOK}
        (call $run (i32.const ${85 - 16 - 10})))
      (else
        (call $run (i32.const 6))
        (call $fixit2)
        (call $run (i32.const ${85 - 6 - 16}))
        (if ${hbCond} (then ${HBHOOK}))))` : `(call $run (i32.const 6))
    (call $fixit2)
    (call $run (i32.const ${85 - 6 - 16}))`;
  return `
  ;; vnapage[slot] -> linear address of that 1KB nametable.
  (func $nt (param $slot i32) (result i32)
    (i32.add (i32.const ${NTRAM}) (i32.shl ${NTSEL} (i32.const 10))))

  ;; GETLASTPIXEL (NTSC): (timestamp*48 - linestartts) >> 4
  (func $lineupdate
    (if (global.get $pline)
      (then (call $refresh_line (i32.shr_s
        (i32.sub (i32.mul (global.get $ts) (i32.const 48)) (global.get $linestartts))
        (i32.const 4))))))

  (func $fixit1
    (local $rad i32)
    (if (i32.and (global.get $ppu1) (i32.const 0x18))
      (then
        (local.set $rad (global.get $refaddr))
        (if (i32.eq (i32.and (local.get $rad) (i32.const 0x7000)) (i32.const 0x7000))
          (then
            (local.set $rad (i32.xor (local.get $rad) (i32.const 0x7000)))
            (if (i32.eq (i32.and (local.get $rad) (i32.const 0x3E0)) (i32.const 0x3A0))
              (then (local.set $rad (i32.xor (local.get $rad) (i32.const 0xBA0))))
              (else (if (i32.eq (i32.and (local.get $rad) (i32.const 0x3E0)) (i32.const 0x3E0))
                (then (local.set $rad (i32.xor (local.get $rad) (i32.const 0x3E0))))
                (else (local.set $rad (i32.add (local.get $rad) (i32.const 0x20))))))))
          (else (local.set $rad (i32.add (local.get $rad) (i32.const 0x1000)))))
        (global.set $refaddr (local.get $rad)))))

  (func $fixit2
    (if (i32.and (global.get $ppu1) (i32.const 0x18))
      (then (global.set $refaddr (i32.or
        (i32.and (global.get $refaddr) (i32.const 0xFBE0))
        (i32.and (global.get $tmpaddr) (i32.const 0x041F)))))))

  (func $check_sprite_hit (param $p i32)
    (local $l i32) (local $x i32)
    (local.set $l (i32.sub (local.get $p) (i32.const 16)))
    (if (i32.eq (global.get $sphitx) (i32.const 0x100)) (then (return)))
    (local.set $x (global.get $sphitx))
    (block $d (loop $lp
      (br_if $d (i32.ge_s (local.get $x) (i32.add (global.get $sphitx) (i32.const 8))))
      (br_if $d (i32.ge_s (local.get $x) (local.get $l)))
      (if (i32.and (i32.and
            (i32.ne (i32.and (global.get $sphitdata)
                             (i32.shr_u (i32.const 0x80) (i32.sub (local.get $x) (global.get $sphitx))))
                    (i32.const 0))
            (i32.eqz (i32.and (i32.load8_u (i32.add (global.get $plinef) (local.get $x)))
                              (i32.const 64))))
            (i32.lt_s (local.get $x) (i32.const 255)))
        (then
          (global.set $ppustatus (i32.or (global.get $ppustatus) (i32.const 0x40)))
          (global.set $sphitx (i32.const 0x100))
          (br $d)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $lp))))

  (func $pal_mark (param $v i32)
    ;; Pal[0], Pal[4], Pal[8], Pal[0xC] |= 64 (v=1) or &= 63 (v=0)
    (if (local.get $v)
      (then
        (i32.store8 (i32.const ${PAL}) (i32.or (i32.load8_u (i32.const ${PAL})) (i32.const 64)))
        (i32.store8 (i32.const ${PAL + 4}) (i32.or (i32.load8_u (i32.const ${PAL + 4})) (i32.const 64)))
        (i32.store8 (i32.const ${PAL + 8}) (i32.or (i32.load8_u (i32.const ${PAL + 8})) (i32.const 64)))
        (i32.store8 (i32.const ${PAL + 12}) (i32.or (i32.load8_u (i32.const ${PAL + 12})) (i32.const 64))))
      (else
        (i32.store8 (i32.const ${PAL}) (i32.and (i32.load8_u (i32.const ${PAL})) (i32.const 63)))
        (i32.store8 (i32.const ${PAL + 4}) (i32.and (i32.load8_u (i32.const ${PAL + 4})) (i32.const 63)))
        (i32.store8 (i32.const ${PAL + 8}) (i32.and (i32.load8_u (i32.const ${PAL + 8})) (i32.const 63)))
        (i32.store8 (i32.const ${PAL + 12}) (i32.and (i32.load8_u (i32.const ${PAL + 12})) (i32.const 63))))))

  (func $refresh_line (param $lastpixel i32)
    (local $ra i32) (local $p i32) (local $lasttile i32) (local $numtiles i32)
    (local $vofs i32) (local $x1 i32) (local $pix i32) (local $c i32) (local $zz i32)
    (local $vadr i32) (local $cc i32) (local $tem i32) (local $tstart i32)
    (local $tcount i32) (local $k i32)
    (local.set $ra (global.get $refaddr))
    (local.set $lasttile (i32.shr_s (local.get $lastpixel) (i32.const 3)))
    (if (i32.and (i32.ne (global.get $sphitx) (i32.const 0x100))
                 (i32.eqz (i32.and (global.get $ppustatus) (i32.const 0x40))))
      (then
        (if (i32.and
              (i32.lt_s (global.get $sphitx) (i32.sub (local.get $lastpixel) (i32.const 16)))
              (i32.ge_s (global.get $sphitx)
                        (i32.mul (i32.sub (local.get $lasttile) (i32.const 2)) (i32.const 8))))
          (then (local.set $lasttile (i32.add (local.get $lasttile) (i32.const 1)))))))
    (if (i32.gt_s (local.get $lasttile) (i32.const 34)) (then (local.set $lasttile (i32.const 34))))
    (local.set $numtiles (i32.sub (local.get $lasttile) (global.get $firsttile)))
    (if (i32.le_s (local.get $numtiles) (i32.const 0)) (then (return)))
    (local.set $p (global.get $pline))
    (local.set $vofs (i32.or
      (i32.shl (i32.and (global.get $ppu0) (i32.const 0x10)) (i32.const 8))
      (i32.and (i32.shr_u (local.get $ra) (i32.const 12)) (i32.const 7))))
    (local.set $tem (i32.or (i32.load8_u (i32.const ${PAL})) (i32.const 0x40)))
    (if (i32.eqz (i32.and (global.get $ppu1) (i32.const 0x18)))
      (then
        (memory.fill (local.get $p) (local.get $tem) (i32.mul (local.get $numtiles) (i32.const 8)))
        (global.set $pline (i32.add (local.get $p) (i32.mul (local.get $numtiles) (i32.const 8))))
        (global.set $firsttile (local.get $lasttile))
        (if (i32.and (i32.ge_s (local.get $lastpixel) (i32.const 268)) (i32.ne (global.get $tofix) (i32.const 0)))
          (then (call $fixit1) (global.set $tofix (i32.const 0))))
        (return)))
    (call $pal_mark (i32.const 1))
    (local.set $x1 (global.get $firsttile))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $x1) (local.get $lasttile)))
      (if (i32.ge_s (local.get $x1) (i32.const 2))
        (then
          (local.set $pix (i32.or (i32.or
            (i32.load (i32.add (i32.const ${LUT1}) (i32.shl (i32.and
              (i32.shr_u (global.get $pshift0) (i32.sub (i32.const 8) (global.get $xoff)))
              (i32.const 0xFF)) (i32.const 2))))
            (i32.load (i32.add (i32.const ${LUT2}) (i32.shl (i32.and
              (i32.shr_u (global.get $pshift1) (i32.sub (i32.const 8) (global.get $xoff)))
              (i32.const 0xFF)) (i32.const 2)))))
            (i32.load (i32.add (i32.const ${LUT3}) (i32.shl
              (i32.or (global.get $xoff) (i32.shl (global.get $atlatch) (i32.const 3)))
              (i32.const 2))))))
          (local.set $k (i32.const 0))
          (block $pd (loop $pl
            (br_if $pd (i32.ge_u (local.get $k) (i32.const 8)))
            (i32.store8 (i32.add (local.get $p) (local.get $k))
              (i32.load8_u (i32.add (i32.const ${PAL})
                (i32.and (i32.shr_u (local.get $pix) (i32.shl (local.get $k) (i32.const 2)))
                         (i32.const 0xF)))))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br $pl)))
          (local.set $p (i32.add (local.get $p) (i32.const 8)))))
      (local.set $zz (i32.and (local.get $ra) (i32.const 0x1F)))
      (local.set $c (call $nt (i32.and (i32.shr_u (local.get $ra) (i32.const 10)) (i32.const 3))))
      (local.set $vadr (i32.add
        (i32.shl (i32.load8_u (i32.add (local.get $c) (i32.and (local.get $ra) (i32.const 0x3FF))))
                 (i32.const 4))
        (local.get $vofs)))
      (local.set $cc (i32.load8_u (i32.add (local.get $c) (i32.add (i32.const 0x3C0)
        (i32.add (i32.shr_u (local.get $zz) (i32.const 2))
                 (i32.shr_u (i32.and (local.get $ra) (i32.const 0x380)) (i32.const 4)))))))
      (local.set $cc (i32.and (i32.shr_u (local.get $cc)
        (i32.add (i32.and (local.get $zz) (i32.const 2))
                 (i32.shr_u (i32.and (local.get $ra) (i32.const 0x40)) (i32.const 4))))
        (i32.const 3)))
      (global.set $atlatch (i32.or (i32.shr_u (global.get $atlatch) (i32.const 2))
                                   (i32.shl (local.get $cc) (i32.const 2))))
      (global.set $pshift0 (i32.or (i32.shl (global.get $pshift0) (i32.const 8))
        (i32.load8_u (i32.add (i32.const ${CHR}) (i32.and (local.get $vadr) (i32.const 0x1FFF))))))
      (global.set $pshift1 (i32.or (i32.shl (global.get $pshift1) (i32.const 8))
        (i32.load8_u (i32.add (i32.const ${CHR})
          (i32.and (i32.add (local.get $vadr) (i32.const 8)) (i32.const 0x1FFF))))))
      (if (i32.eq (i32.and (local.get $ra) (i32.const 0x1F)) (i32.const 0x1F))
        (then (local.set $ra (i32.xor (local.get $ra) (i32.const 0x41F))))
        (else (local.set $ra (i32.add (local.get $ra) (i32.const 1)))))
      (local.set $x1 (i32.add (local.get $x1) (i32.const 1)))
      (br $l)))
    (call $pal_mark (i32.const 0))
    (global.set $refaddr (local.get $ra))
    (local.set $tem (i32.or (i32.load8_u (i32.const ${PAL})) (i32.const 0x40)))
    (if (i32.and (i32.and (i32.le_s (global.get $firsttile) (i32.const 2))
                          (i32.lt_s (i32.const 2) (local.get $lasttile)))
                 (i32.eqz (i32.and (global.get $ppu1) (i32.const 2))))
      (then (memory.fill (global.get $plinef) (local.get $tem) (i32.const 8))))
    (if (i32.eqz (i32.and (global.get $ppu1) (i32.const 8)))
      (then
        (local.set $tcount (i32.sub (local.get $lasttile) (global.get $firsttile)))
        (local.set $tstart (i32.sub (global.get $firsttile) (i32.const 2)))
        (if (i32.lt_s (local.get $tstart) (i32.const 0))
          (then (local.set $tcount (i32.add (local.get $tcount) (local.get $tstart)))
                (local.set $tstart (i32.const 0))))
        (if (i32.gt_s (local.get $tcount) (i32.const 0))
          (then (memory.fill (i32.add (global.get $plinef) (i32.shl (local.get $tstart) (i32.const 3)))
                             (local.get $tem) (i32.shl (local.get $tcount) (i32.const 3)))))))
    (if (i32.and (i32.ge_s (local.get $lastpixel) (i32.const 268)) (i32.ne (global.get $tofix) (i32.const 0)))
      (then (call $fixit1) (global.set $tofix (i32.const 0))))
    (call $check_sprite_hit (local.get $lastpixel))
    (global.set $pline (local.get $p))
    (global.set $firsttile (local.get $lasttile)))

  (func $reset_rl (param $target i32)
    (memory.fill (local.get $target) (i32.const 0xFF) (i32.const 256))
    (global.set $plinef (local.get $target))
    (global.set $pline (local.get $target))
    (global.set $firsttile (i32.const 0))
    (global.set $linestartts (i32.add (i32.mul (global.get $ts) (i32.const 48)) (global.get $cnt)))
    (global.set $tofix (i32.const 0))
    (call $lineupdate)
    (global.set $tofix (i32.const 1)))

  (func $end_rl
    (call $refresh_line (i32.const 272))
    (if (global.get $tofix) (then (call $fixit1)))
    (call $check_sprite_hit (i32.const 272))
    (global.set $pline (i32.const 0)))

  (func $fetch_sprite_data
    (local $ns i32) (local $sb i32) (local $n i32) (local $spr i32) (local $h i32)
    (local $vofs i32) (local $t i32) (local $vadr i32) (local $y i32) (local $no i32)
    (local $atr i32) (local $dst i32)
    (local.set $vofs (i32.shl (i32.and (i32.and (global.get $ppu0) (i32.const 8))
      (i32.shr_u (i32.xor (i32.and (global.get $ppu0) (i32.const 0x20)) (i32.const 0x20)) (i32.const 2)))
      (i32.const 9)))
    (local.set $h (i32.add (i32.const 8) (i32.shr_u (i32.and (global.get $ppu0) (i32.const 0x20)) (i32.const 2))))
    (local.set $n (i32.const 63))
    (local.set $spr (i32.const ${OAM}))
    (block $d (loop $l
      (br_if $d (i32.lt_s (local.get $n) (i32.const 0)))
      (local.set $y (i32.load8_u (local.get $spr)))
      (if (i32.lt_u (i32.sub (global.get $scanline) (local.get $y)) (local.get $h))
        (then
          (if (i32.lt_u (local.get $ns) (i32.const 8))
            (then
              (if (i32.eq (local.get $n) (i32.const 63)) (then (local.set $sb (i32.const 1))))
              (local.set $t (i32.sub (global.get $scanline) (local.get $y)))
              (local.set $no (i32.load8_u (i32.add (local.get $spr) (i32.const 1))))
              (local.set $atr (i32.load8_u (i32.add (local.get $spr) (i32.const 2))))
              (if (i32.and (global.get $ppu0) (i32.const 0x20))
                (then (local.set $vadr (i32.add
                  (i32.shl (i32.and (local.get $no) (i32.const 1)) (i32.const 12))
                  (i32.shl (i32.and (local.get $no) (i32.const 0xFE)) (i32.const 4)))))
                (else (local.set $vadr (i32.add (i32.shl (local.get $no) (i32.const 4)) (local.get $vofs)))))
              (if (i32.and (local.get $atr) (i32.const 0x80))
                (then (local.set $vadr (i32.sub (i32.add (i32.sub (i32.add (local.get $vadr) (i32.const 7))
                          (local.get $t))
                          (i32.shr_u (i32.and (global.get $ppu0) (i32.const 0x20)) (i32.const 1)))
                          (i32.and (local.get $t) (i32.const 8)))))
                (else (local.set $vadr (i32.add (i32.add (local.get $vadr) (local.get $t))
                          (i32.and (local.get $t) (i32.const 8))))))
              (local.set $dst (i32.add (i32.const ${SPRBUF}) (i32.shl (local.get $ns) (i32.const 2))))
              (i32.store8 (local.get $dst) (i32.load8_u (i32.add (i32.const ${CHR})
                (i32.and (local.get $vadr) (i32.const 0x1FFF)))))
              (i32.store8 (i32.add (local.get $dst) (i32.const 1)) (i32.load8_u (i32.add (i32.const ${CHR})
                (i32.and (i32.add (local.get $vadr) (i32.const 8)) (i32.const 0x1FFF)))))
              (i32.store8 (i32.add (local.get $dst) (i32.const 2)) (local.get $atr))
              (i32.store8 (i32.add (local.get $dst) (i32.const 3))
                (i32.load8_u (i32.add (local.get $spr) (i32.const 3))))
              (local.set $ns (i32.add (local.get $ns) (i32.const 1))))
            (else
              (global.set $ppustatus (i32.or (global.get $ppustatus) (i32.const 0x20)))
              (br $d)))))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (local.set $spr (i32.add (local.get $spr) (i32.const 4)))
      (br $l)))
    (global.set $numsprites (local.get $ns))
    (global.set $blurp (local.get $sb)))

  (func $refresh_sprites
    (local $n i32) (local $spr i32) (local $x i32) (local $ca0 i32) (local $ca1 i32)
    (local $atr i32) (local $j i32) (local $pix i32) (local $vb i32) (local $k i32)
    (local $pos i32) (local $v i32) (local $r i32)
    (global.set $spork (i32.const 0))
    (if (i32.eqz (global.get $numsprites)) (then (return)))
    (memory.fill (i32.const ${SPRLINE}) (i32.const 0x80) (i32.const 256))
    (local.set $n (i32.sub (global.get $numsprites) (i32.const 1)))
    (block $d (loop $l
      (br_if $d (i32.lt_s (local.get $n) (i32.const 0)))
      (local.set $spr (i32.add (i32.const ${SPRBUF}) (i32.shl (local.get $n) (i32.const 2))))
      (local.set $ca0 (i32.load8_u (local.get $spr)))
      (local.set $ca1 (i32.load8_u (i32.add (local.get $spr) (i32.const 1))))
      (local.set $atr (i32.load8_u (i32.add (local.get $spr) (i32.const 2))))
      (local.set $x (i32.load8_u (i32.add (local.get $spr) (i32.const 3))))
      (local.set $j (i32.or (local.get $ca0) (local.get $ca1)))
      (if (local.get $j)
        (then
          (if (i32.and (i32.and (i32.eqz (local.get $n)) (i32.ne (global.get $blurp) (i32.const 0)))
                       (i32.eqz (i32.and (global.get $ppustatus) (i32.const 0x40))))
            (then
              (global.set $sphitx (local.get $x))
              (global.set $sphitdata (local.get $j))
              (if (i32.and (local.get $atr) (i32.const 0x40))
                (then
                  ;; bit-reverse J
                  (local.set $r (i32.const 0))
                  (local.set $k (i32.const 0))
                  (block $rd (loop $rl
                    (br_if $rd (i32.ge_u (local.get $k) (i32.const 8)))
                    (local.set $r (i32.or (i32.shl (local.get $r) (i32.const 1))
                      (i32.and (i32.shr_u (local.get $j) (local.get $k)) (i32.const 1))))
                    (local.set $k (i32.add (local.get $k) (i32.const 1)))
                    (br $rl)))
                  (global.set $sphitdata (local.get $r))))))
          (local.set $pix (i32.or
            (i32.load (i32.add (i32.const ${LUT1}) (i32.shl (local.get $ca0) (i32.const 2))))
            (i32.load (i32.add (i32.const ${LUT2}) (i32.shl (local.get $ca1) (i32.const 2))))))
          (local.set $vb (i32.add (i32.const ${PAL + 0x10})
            (i32.shl (i32.and (local.get $atr) (i32.const 3)) (i32.const 2))))
          (local.set $k (i32.const 0))
          (block $pd (loop $pl
            (br_if $pd (i32.ge_u (local.get $k) (i32.const 8)))
            (if (i32.and (local.get $j) (i32.shr_u (i32.const 0x80) (local.get $k)))
              (then
                (local.set $pos (if (result i32) (i32.and (local.get $atr) (i32.const 0x40))
                  (then (i32.sub (i32.const 7) (local.get $k))) (else (local.get $k))))
                (local.set $v (i32.load8_u (i32.add (local.get $vb)
                  (i32.and (i32.shr_u (local.get $pix) (i32.shl (local.get $k) (i32.const 2)))
                           (i32.const 3)))))
                (if (i32.and (local.get $atr) (i32.const 0x20))
                  (then (local.set $v (i32.or (local.get $v) (i32.const 0x40)))))
                (i32.store8 (i32.add (i32.const ${SPRLINE}) (i32.add (local.get $x) (local.get $pos)))
                            (local.get $v))))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br $pl)))))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $l)))
    (global.set $blurp (i32.const 0))
    (global.set $spork (i32.const 1)))

  (func $copy_sprites (param $target i32)
    (local $n i32) (local $t i32)
    (local.set $n (i32.shl (i32.xor (i32.and (global.get $ppu1) (i32.const 4)) (i32.const 4)) (i32.const 1)))
    (if (i32.eqz (global.get $spork)) (then (return)))
    (global.set $spork (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $n) (i32.const 256)))
      (local.set $t (i32.load8_u (i32.add (i32.const ${SPRLINE}) (local.get $n))))
      (if (i32.eqz (i32.and (local.get $t) (i32.const 0x80)))
        (then
          (if (i32.or (i32.eqz (i32.and (local.get $t) (i32.const 0x40)))
                      (i32.ne (i32.and (i32.load8_u (i32.add (local.get $target) (local.get $n)))
                                       (i32.const 0x40)) (i32.const 0)))
            (then (i32.store8 (i32.add (local.get $target) (local.get $n)) (local.get $t))))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $l))))

  (func $do_line
    (local $target i32) (local $x i32) (local $v i32)
    (local.set $target (i32.add (i32.const ${NESFB}) (i32.shl (global.get $scanline) (i32.const 8))))
    (call $run (i32.const 256))
    (call $end_rl)
    (if (i32.and (global.get $ppu1) (i32.const 0x10))
      (then (call $copy_sprites (local.get $target))))
    ;; grayscale (only when rendering), then the 6-bit palette index
    (local.set $x (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $x) (i32.const 256)))
      (local.set $v (i32.load8_u (i32.add (local.get $target) (local.get $x))))
      (if (i32.and (i32.ne (i32.and (global.get $ppu1) (i32.const 0x18)) (i32.const 0))
                   (i32.ne (i32.and (global.get $ppu1) (i32.const 1)) (i32.const 0)))
        (then (local.set $v (i32.and (local.get $v) (i32.const 0x30)))))
      (i32.store8 (i32.add (local.get $target) (local.get $x)) (i32.and (local.get $v) (i32.const 0x3F)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $l)))
    ;; colour emphasis for the whole line, from PPU[1] as it is NOW (DoLine
    ;; writes XDBuf here; the libretro blit picks palette[256 + deemp*64 + pix])
    (i32.store8 (i32.add (i32.const ${EMPH}) (global.get $scanline)) (i32.shr_u (global.get $ppu1) (i32.const 5)))
    (if (i32.and (global.get $ppu1) (i32.const 0xE0))
      (then (global.set $nemph (i32.add (global.get $nemph) (i32.const 1)))))
    (global.set $sphitx (i32.const 0x100))
    (if (i32.and (global.get $ppu1) (i32.const 0x18)) (then (call $fetch_sprite_data)))
    ${hblank}
    (if (i32.and (global.get $ppu1) (i32.const 0x10)) (then (call $refresh_sprites)))
    (global.set $scanline (i32.add (global.get $scanline) (i32.const 1)))
    (if (i32.lt_s (global.get $scanline) (i32.const 240))
      (then (call $reset_rl (i32.add (i32.const ${NESFB}) (i32.shl (global.get $scanline) (i32.const 8))))))
    (call $run (i32.const 16)))

  ;; ---- CPU-side register file ---------------------------------------------
  (func $ppu_read (param $r i32) (result i32)
    (local $ret i32) (local $tmp i32) (local $rad i32)
    (call $lineupdate)
    (if (i32.eq (local.get $r) (i32.const 2))
      (then
        (local.set $ret (i32.or (global.get $ppustatus) (i32.and (global.get $genlatch) (i32.const 0x1F))))
        (global.set $vtoggle (i32.const 0))
        (global.set $ppustatus (i32.and (global.get $ppustatus) (i32.const 0x7F)))
        (global.set $genlatch (local.get $ret))
        (return (local.get $ret))))
    (if (i32.ne (local.get $r) (i32.const 7)) (then (return (global.get $genlatch))))
    (local.set $tmp (i32.and (global.get $refaddr) (i32.const 0x3FFF)))
    (if (i32.ge_u (local.get $tmp) (i32.const 0x3F00))
      (then
        (if (i32.eqz (i32.and (local.get $tmp) (i32.const 3)))
          (then (if (i32.eqz (i32.and (local.get $tmp) (i32.const 0xC)))
            (then (local.set $ret (i32.load8_u (i32.const ${PAL}))))
            (else (local.set $ret (i32.load8_u (i32.add (i32.const ${UPAL - 1})
              (i32.shr_u (i32.and (local.get $tmp) (i32.const 0xC)) (i32.const 2))))))))
          (else (local.set $ret (i32.load8_u (i32.add (i32.const ${PAL})
            (i32.and (local.get $tmp) (i32.const 0x1F)))))))
        (if (i32.and (global.get $ppu1) (i32.const 1))
          (then (local.set $ret (i32.and (local.get $ret) (i32.const 0x30)))))
        (global.set $vrambuf (i32.load8_u (i32.add
          (call $nt (i32.and (i32.shr_u (i32.sub (local.get $tmp) (i32.const 0x1000)) (i32.const 10)) (i32.const 3)))
          (i32.and (i32.sub (local.get $tmp) (i32.const 0x1000)) (i32.const 0x3FF))))))
      (else
        (local.set $ret (global.get $vrambuf))
        (global.set $genlatch (global.get $vrambuf))
        (if (i32.lt_u (local.get $tmp) (i32.const 0x2000))
          (then (global.set $vrambuf (i32.load8_u (i32.add (i32.const ${CHR}) (local.get $tmp)))))
          (else (global.set $vrambuf (i32.load8_u (i32.add
            (call $nt (i32.and (i32.shr_u (local.get $tmp) (i32.const 10)) (i32.const 3)))
            (i32.and (local.get $tmp) (i32.const 0x3FF)))))))))
    (if (i32.and (i32.ne (i32.and (global.get $ppu1) (i32.const 0x18)) (i32.const 0))
                 (i32.lt_s (global.get $scanline) (i32.const 240)))
      (then
        (local.set $rad (global.get $refaddr))
        (if (i32.eq (i32.and (local.get $rad) (i32.const 0x7000)) (i32.const 0x7000))
          (then
            (local.set $rad (i32.xor (local.get $rad) (i32.const 0x7000)))
            (if (i32.eq (i32.and (local.get $rad) (i32.const 0x3E0)) (i32.const 0x3A0))
              (then (local.set $rad (i32.xor (local.get $rad) (i32.const 0xBA0))))
              (else (if (i32.eq (i32.and (local.get $rad) (i32.const 0x3E0)) (i32.const 0x3E0))
                (then (local.set $rad (i32.xor (local.get $rad) (i32.const 0x3E0))))
                (else (local.set $rad (i32.add (local.get $rad) (i32.const 0x20))))))))
          (else (local.set $rad (i32.add (local.get $rad) (i32.const 0x1000)))))
        (global.set $refaddr (local.get $rad)))
      (else
        (global.set $refaddr (i32.add (global.get $refaddr)
          (if (result i32) (i32.and (global.get $ppu0) (i32.const 4))
            (then (i32.const 32)) (else (i32.const 1)))))))
    (local.get $ret))

  (func $ppu_write (param $r i32) (param $v i32)
    (local $tmp i32) (local $slot i32)
    (if (i32.eq (local.get $r) (i32.const 0))
      (then
        (call $lineupdate)
        (global.set $genlatch (local.get $v))
        (if (i32.and (i32.and
              (i32.eqz (i32.and (global.get $ppu0) (i32.const 0x80)))
              (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)))
              (i32.ne (i32.and (global.get $ppustatus) (i32.const 0x80)) (i32.const 0)))
          (then (global.set $irqlow (i32.or (global.get $irqlow) (i32.const 0x40)))))
        (global.set $ppu0 (local.get $v))
        (global.set $tmpaddr (i32.or (i32.and (global.get $tmpaddr) (i32.const 0xF3FF))
          (i32.shl (i32.and (local.get $v) (i32.const 3)) (i32.const 10))))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 1))
      (then
        (call $lineupdate)
        (global.set $genlatch (local.get $v))
        (global.set $ppu1 (local.get $v))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 2))
      (then (global.set $genlatch (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 3))
      (then
        (global.set $genlatch (local.get $v))
        (global.set $ppu3 (local.get $v))
        (global.set $ppuspl (i32.and (local.get $v) (i32.const 7)))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 4))
      (then (call $w2004 (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 5))
      (then
        (local.set $tmp (global.get $tmpaddr))
        (call $lineupdate)
        (global.set $genlatch (local.get $v))
        (if (i32.eqz (global.get $vtoggle))
          (then
            (local.set $tmp (i32.or (i32.and (local.get $tmp) (i32.const 0xFFE0))
                                    (i32.shr_u (local.get $v) (i32.const 3))))
            (global.set $xoff (i32.and (local.get $v) (i32.const 7))))
          (else
            (local.set $tmp (i32.and (local.get $tmp) (i32.const 0x8C1F)))
            (local.set $tmp (i32.or (local.get $tmp)
              (i32.shl (i32.and (local.get $v) (i32.const 0xF8)) (i32.const 2))))
            (local.set $tmp (i32.or (local.get $tmp)
              (i32.shl (i32.and (local.get $v) (i32.const 7)) (i32.const 12))))))
        (global.set $tmpaddr (local.get $tmp))
        (global.set $vtoggle (i32.xor (global.get $vtoggle) (i32.const 1)))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 6))
      (then
        (call $lineupdate)
        (global.set $genlatch (local.get $v))
        (if (i32.eqz (global.get $vtoggle))
          (then (global.set $tmpaddr (i32.or (i32.and (global.get $tmpaddr) (i32.const 0x00FF))
            (i32.shl (i32.and (local.get $v) (i32.const 0x3F)) (i32.const 8)))))
          (else
            (global.set $tmpaddr (i32.or (i32.and (global.get $tmpaddr) (i32.const 0xFF00))
                                         (local.get $v)))
            (global.set $refaddr (global.get $tmpaddr))))
        (global.set $vtoggle (i32.xor (global.get $vtoggle) (i32.const 1)))
        (return)))
    ;; $2007 (no LineUpdate in fceumm's B2007)
    (local.set $tmp (i32.and (global.get $refaddr) (i32.const 0x3FFF)))
    (global.set $genlatch (local.get $v))
    (global.set $nvram (i32.add (global.get $nvram) (i32.const 1)))
    (if (i32.lt_u (local.get $tmp) (i32.const 0x2000))
      (then ${CHRWRITE})
      (else (if (i32.lt_u (local.get $tmp) (i32.const 0x3F00))
        (then (i32.store8 (i32.add
          (call $nt (i32.shr_u (i32.and (local.get $tmp) (i32.const 0xF00)) (i32.const 10)))
          (i32.and (local.get $tmp) (i32.const 0x3FF))) (local.get $v)))
        (else
          (if (i32.eqz (i32.and (local.get $tmp) (i32.const 3)))
            (then (if (i32.eqz (i32.and (local.get $tmp) (i32.const 0xC)))
              (then
                (local.set $v (i32.and (local.get $v) (i32.const 0x3F)))
                (i32.store8 (i32.const ${PAL}) (local.get $v))
                (i32.store8 (i32.const ${PAL + 4}) (local.get $v))
                (i32.store8 (i32.const ${PAL + 8}) (local.get $v))
                (i32.store8 (i32.const ${PAL + 12}) (local.get $v)))
              (else (i32.store8 (i32.add (i32.const ${UPAL - 1})
                (i32.shr_u (i32.and (local.get $tmp) (i32.const 0xC)) (i32.const 2)))
                (i32.and (local.get $v) (i32.const 0x3F))))))
            (else (i32.store8 (i32.add (i32.const ${PAL}) (i32.and (local.get $tmp) (i32.const 0x1F)))
              (i32.and (local.get $v) (i32.const 0x3F)))))))))
    (global.set $refaddr (i32.add (global.get $refaddr)
      (if (result i32) (i32.and (global.get $ppu0) (i32.const 4))
        (then (i32.const 32)) (else (i32.const 1))))))

  (func $w2004 (param $v i32)
    (global.set $genlatch (local.get $v))
    (if (i32.ge_u (global.get $ppuspl) (i32.const 8))
      (then (if (i32.ge_u (global.get $ppu3) (i32.const 8))
        (then (i32.store8 (i32.add (i32.const ${OAM}) (global.get $ppu3)) (local.get $v)))))
      (else (i32.store8 (i32.add (i32.const ${OAM}) (global.get $ppuspl)) (local.get $v))))
    (global.set $ppu3 (i32.and (i32.add (global.get $ppu3) (i32.const 1)) (i32.const 0xFF)))
    (global.set $ppuspl (i32.and (i32.add (global.get $ppuspl) (i32.const 1)) (i32.const 0xFF))))
`;
}

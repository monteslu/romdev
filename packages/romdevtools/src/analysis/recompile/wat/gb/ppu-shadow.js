// gambatte's PPU timing state machine (libgambatte video/ppu.cpp) as a
// shadow the cart runs beside its own renderer, for the one thing the
// line-start prediction ($m3predict) cannot give: when a register the mode-3
// length depends on (LCDC, SCX, WX, WY) changes MID-LINE, gambatte re-predicts
// the rest of the line from the PPU's CURRENT state (LCD::mode3CyclesChange ->
// PPU::predictedNextXposTime). The shadow keeps that state: the M2/M3Start/
// M3Loop state functions with their cycle budget, xpos, endx, the window
// draw state, weMaster, the line's sprite list and next sprite, driven by
// PPU::update exactly as gambatte drives it, with pixel output left out
// (only what moves xpos and the cycle count is kept, including
// doFullTilesUnrolled's per-tile costs).
//
// Everything here is timing; the picture is the cart's renderer's job.
//
// State ids (the C function each one is):
//   0 M2_Ly0::f0   1 M2_LyNon0::f0   2 M2_LyNon0::f1   3 M3Start::f0   4 M3Start::f1
//   10-15 M3Loop::Tile::f0-f5   20-25 M3Loop::LoadSprites::f0-f5
//   30-35 M3Loop::StartWindowDraw::f0-f5
//
// Sprites: gambatte's SpriteMapper (sprite_mapper.cpp) is ported too: the
// OamReader's lagging copy of the OAM positions and sizes (read as the mode-2
// scan passes each entry, the OBJ size taken at that moment, $FF while an OAM
// DMA owns the bus), the per-line maps built at the SPRITE_MAP event, and
// the X sort done on first use.

/**
 * @param {{cgb: boolean, IO: number, OAM: number, GPSPX: number, GPMAP: number, GPMAP2: number,
 *   GPBUF: number, GPSZ: number, GPNUM: number, GPSMAP: number}} o
 */
export function ppuShadowWat({ cgb, IO, OAM, GPSPX, GPMAP, GPMAP2, GPBUF, GPSZ, GPNUM, GPSMAP }) {
  const C = cgb ? 1 : 0;
  const winEn = "(i32.ne (i32.and (global.get $gplcdc) (i32.const 0x20)) (i32.const 0))";
  const objEnOrCgb = cgb ? "(i32.const 1)" : "(i32.ne (i32.and (global.get $gplcdc) (i32.const 0x02)) (i32.const 0))";
  const spx = (i) => `(i32.load8_u (i32.add (i32.const ${GPSPX}) ${i}))`;
  // nextCall(c, S): cycles -= c; >= 0 runs S now, else S waits
  const nextCall = (c, s) => `(global.set $gpcyc (i32.sub (global.get $gpcyc) (i32.const ${c}))) (global.set $gpst (i32.const ${s})) (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0))) (return)`;
  const goto_ = (s) => `(global.set $gpst (i32.const ${s})) (br $run)`;
  const winChk = (s = 30) => `(if (i32.and (i32.and (global.get $gpwds) (i32.const 1)) (call $gp_hwsr (global.get $gpxpos))) (then ${goto_(s)}))`;
  // Tile::inc
  const tileInc = (nx) => `(call $gp_plotns) (if (i32.eq (global.get $gpxpos) (i32.const 168)) (then (call $gp_x168) (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0))) (return))) ${nextCall(1, nx)}`;
  // LoadSprites::inc / the end-of-tile rule
  const endOr = (nx) => `(if (i32.eq (global.get $gpxpos) (global.get $gpendx))
          (then (if (i32.lt_u (global.get $gpxpos) (i32.const 168)) (then ${nextCall(1, 10)}) (else (call $gp_x168) (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0))) (return)))))
        ${nextCall(1, nx)}`;
  const lsInc = (nx) => `(call $gp_plotns) ${endOr(nx)}`;
  // StartWindowDraw::inc
  const swdInc = (nx) => `${cgb ? `(if (i32.eqz ${winEn})
          (then (call $gp_plotns)
            (if (i32.eq (global.get $gpxpos) (global.get $gpendx))
              (then (if (i32.lt_u (global.get $gpxpos) (i32.const 168)) (then ${nextCall(1, 10)}) (else (call $gp_x168) (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0))) (return)))))))` : ""}
        ${nextCall(1, nx)}`;

  const arms = new Map();
  // M2_Ly0::f0
  arms.set(0, `(global.set $gpwem (i32.and ${winEn} (i32.eqz (global.get $gpwy))))
        ${nextCall(83, 3)}`);
  // M2_LyNon0::f0 / f1
  arms.set(1, `(global.set $gpwem (i32.or (global.get $gpwem) (i32.and ${winEn} (i32.eq (global.get $gply) (global.get $gpwy)))))
        ${nextCall(4, 2)}`);
  arms.set(2, `(global.set $gpwem (i32.or (global.get $gpwem) (i32.and ${winEn} (i32.eq (i32.add (global.get $gply) (i32.const 1)) (global.get $gpwy)))))
        ${nextCall(456 - (454 - C) + 83, 3)}`);
  // M3Start::f0
  arms.set(3, `(global.set $gpxpos (i32.const 0))
        (global.set $gpwds (if (result i32) (i32.and (i32.ne (i32.and (global.get $gpwds) (i32.const 1)) (i32.const 0)) ${winEn})
          (then (i32.const 2)) (else (i32.const 0))))
        ${goto_(4)}`);
  // M3Start::f1
  arms.set(4, `(global.set $gpst (i32.const 4))
        (block $m3s (loop $m3l
          (br_if $m3s (i32.ge_u (global.get $gpxpos) (i32.const 80)))
          (br_if $m3s (i32.eq (i32.and (global.get $gpxpos) (i32.const 7)) (i32.and (global.get $gpscx) (i32.const 7))))
          (global.set $gpxpos (i32.add (global.get $gpxpos) (i32.const 1)))
          (global.set $gpcyc (i32.sub (global.get $gpcyc) (i32.const 1)))
          (if (i32.lt_s (global.get $gpcyc) (i32.const 0)) (then (return)))
          (br $m3l)))
        (call $gp_loadlist)
        (global.set $gpnsp (i32.const 0))
        (global.set $gpxpos (i32.const 0))
        (global.set $gpendx (i32.sub (i32.const 8) (i32.and (global.get $gpscx) (i32.const 7))))
        (global.set $gpcyc (i32.sub (global.get $gpcyc) (i32.const ${1 - C})))
        (global.set $gpst (i32.add (i32.const 10) (select (i32.and (global.get $gpscx) (i32.const 7)) (i32.const 5)
          (i32.lt_u (i32.and (global.get $gpscx) (i32.const 7)) (i32.const 5)))))
        (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0)))
        (return)`);
  // M3Loop::Tile::f0
  arms.set(10, `${winChk()}
        (call $gp_dofull)
        (if (i32.eq (global.get $gpxpos) (i32.const 168))
          (then (global.set $gpcyc (i32.add (global.get $gpcyc) (i32.const 1))) (call $gp_x168) (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0))) (return)))
        (global.set $gpendx (if (result i32) (i32.lt_u (global.get $gpxpos) (i32.const 160))
          (then (i32.add (global.get $gpxpos) (i32.const 8))) (else (i32.const 168))))
        ${tileInc(11)}`);
  arms.set(11, `${winChk()} ${tileInc(12)}`);
  arms.set(12, `${winChk()} ${tileInc(13)}`);
  arms.set(13, `${winChk()} ${tileInc(14)}`);
  arms.set(14, `${winChk()}
        (call $gp_plotns)
        (if (i32.eq (global.get $gpxpos) (i32.const 168)) (then (call $gp_x168) (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0))) (return)))
        ${nextCall(1, 15)}`);
  // M3Loop::Tile::f5
  arms.set(15, `(local.set $e (global.get $gpendx))
        (global.set $gpst (i32.const 15))
        (loop $t5
          ${winChk()}
          (if (i32.eq ${spx("(global.get $gpnsp)")} (global.get $gpxpos))
            (then
              (if ${objEnOrCgb}
                (then (global.set $gpcsp (global.get $gpnsp)) ${goto_(20)}))
              (loop $sk
                (global.set $gpnsp (i32.add (global.get $gpnsp) (i32.const 1)))
                (br_if $sk (i32.eq ${spx("(global.get $gpnsp)")} (global.get $gpxpos))))))
          (call $gp_plot)
          (if (i32.eq (global.get $gpxpos) (local.get $e))
            (then (if (i32.lt_u (local.get $e) (i32.const 168)) (then ${nextCall(1, 10)}) (else (call $gp_x168) (br_if $run (i32.ge_s (global.get $gpcyc) (i32.const 0))) (return)))))
          (global.set $gpcyc (i32.sub (global.get $gpcyc) (i32.const 1)))
          (br_if $t5 (i32.ge_s (global.get $gpcyc) (i32.const 0))))
        (return)`);
  // M3Loop::LoadSprites
  arms.set(20, nextCall(1, 21));
  arms.set(21, `${winChk()} ${lsInc(22)}`);
  arms.set(22, `${winChk()} ${lsInc(23)}`);
  arms.set(23, `${winChk()} ${lsInc(24)}`);
  arms.set(24, `${winChk()} ${lsInc(25)}`);
  arms.set(25, `${winChk()}
        (call $gp_plotns)
        (local.set $e (global.get $gpcsp))
        (if (i32.eq (local.get $e) (global.get $gpnsp))
          (then (global.set $gpnsp (i32.add (global.get $gpnsp) (i32.const 1))))
          (else (local.set $e (i32.sub (global.get $gpnsp) (i32.const 1)))))
        (i32.store8 (i32.add (i32.const ${GPSPX}) (local.get $e)) (global.get $gpxpos))
        ${endOr(15)}`);
  // M3Loop::StartWindowDraw
  arms.set(30, `(if (i32.eq (global.get $gpxpos) (global.get $gpendx))
          (then (global.set $gpendx (if (result i32) (i32.lt_u (global.get $gpxpos) (i32.const 160))
                  (then (i32.add (global.get $gpxpos) (i32.const 8))) (else (i32.const 168))))))
        ${swdInc(31)}`);
  arms.set(31, swdInc(32));
  arms.set(32, swdInc(33));
  arms.set(33, swdInc(34));
  arms.set(34, swdInc(35));
  arms.set(35, swdInc(10));

  const ids = [...arms.keys()].sort((a, b) => a - b);
  const sel = new Array(36).fill("$bad");
  ids.forEach((id, k) => { sel[id] = `$a${k}`; });
  let dispatch = "";
  for (let k = ids.length - 1; k >= 0; k--) dispatch += `(block $a${k} `;
  dispatch += `(block $bad (br_table ${sel.join(" ")} $bad (global.get $gpst))) (return)`;
  ids.forEach((id, k) => { dispatch += `)\n        ;; state ${id}\n        ${arms.get(id)}\n        (br $run)`; });

  return `
  ;; ---- gambatte PPU timing shadow (ppu-shadow.js) ----
  (global $gpst (mut i32) (i32.const 0))
  (global $gpcyc (mut i32) (i32.const 0))
  (global $gpnow (mut i32) (i32.const 0))
  (global $gplastm0 (mut i32) (i32.const 0))
  (global $gpxpos (mut i32) (i32.const 0))
  (global $gpendx (mut i32) (i32.const 0))
  (global $gpwds (mut i32) (i32.const 0))
  (global $gpwem (mut i32) (i32.const 0))
  (global $gpnsp (mut i32) (i32.const 0))
  (global $gpcsp (mut i32) (i32.const 0))
  (global $gply (mut i32) (i32.const 0))
  (global $gptime (mut i32) (i32.const 0))
  (global $gpds (mut i32) (i32.const 0))
  (global $gplcdc (mut i32) (i32.const 0))
  (global $gpscx (mut i32) (i32.const 0))
  (global $gpwx (mut i32) (i32.const 0))
  (global $gpwy (mut i32) (i32.const 0))
  (global $gpwy2 (mut i32) (i32.const 0))
  (global $gpwy2t (mut i32) (i32.const 0))
  (global $gpwy2on (mut i32) (i32.const 0))

  (global $gplu (mut i32) (i32.const 0))
  (global $gplast (mut i32) (i32.const 0xFF))
  (global $gplsrc (mut i32) (i32.const 0))
  (global $gpoamdis (mut i32) (i32.const 0))
  (global $gpsmt (mut i32) (i32.const 0))
  (global $gpsmon (mut i32) (i32.const 0))

  ;; toPosCycles: the mode-2 scan position of cc on its line (unsigned)
  (func $gp_poscyc (param $cc i32) (result i32)
    (local $lc i32)
    (local.set $lc (i32.add (i32.sub (i32.const 456) (i32.shr_u (i32.sub (global.get $gptime) (local.get $cc)) (global.get $gpds)))
                            (i32.sub (i32.const 3) (i32.mul (global.get $gpds) (i32.const 3)))))
    (if (i32.ge_u (local.get $lc) (i32.const 456)) (then (local.set $lc (i32.sub (local.get $lc) (i32.const 456)))))
    (local.get $lc))

  (func $gp_min80 (param $v i32) (result i32)
    (select (local.get $v) (i32.const 80) (i32.lt_u (local.get $v) (i32.const 80))))

  (func $gp_oambyte (param $i i32) (result i32)
    (if (result i32) (global.get $gpoamdis) (then (i32.const 0xFF))
      (else (i32.load8_u (i32.add (i32.const ${OAM}) (local.get $i))))))

  ;; OamReader::update
  (func $gp_oamrd (param $cc i32)
    (local $lulc i32) (local $pos i32) (local $dist i32) (local $cclc i32) (local $tg i32)
    (if (i32.le_s (i32.sub (local.get $cc) (global.get $gplu)) (i32.const 0)) (then (return)))
    (if (i32.ne (global.get $gplast) (i32.const 0xFF))
      (then
        (local.set $lulc (call $gp_poscyc (global.get $gplu)))
        (local.set $pos (call $gp_min80 (local.get $lulc)))
        (local.set $dist (i32.const 80))
        (if (i32.lt_u (i32.shr_u (i32.sub (local.get $cc) (global.get $gplu)) (global.get $gpds)) (i32.const 456))
          (then
            (local.set $cclc (call $gp_poscyc (local.get $cc)))
            (local.set $dist (i32.add (i32.sub (call $gp_min80 (local.get $cclc)) (local.get $pos))
              (select (i32.const 80) (i32.const 0) (i32.lt_u (local.get $cclc) (local.get $lulc)))))))
        (local.set $tg (i32.add (i32.sub (global.get $gplast) (local.get $pos))
          (select (i32.const 80) (i32.const 0) (i32.le_u (global.get $gplast) (local.get $pos)))))
        (if (i32.le_u (local.get $tg) (local.get $dist))
          (then (local.set $dist (local.get $tg)) (global.set $gplast (i32.const 0xFF))))
        (block $d (loop $l
          (br_if $d (i32.eqz (local.get $dist)))
          (local.set $dist (i32.sub (local.get $dist) (i32.const 1)))
          (if (i32.eqz (i32.and (local.get $pos) (i32.const 1)))
            (then
              (if (i32.eq (local.get $pos) (i32.const 80)) (then (local.set $pos (i32.const 0))))
              ${cgb ? `(i32.store8 (i32.add (i32.const ${GPSZ}) (i32.shr_u (local.get $pos) (i32.const 1))) (global.get $gplsrc))` : ""}
              (i32.store8 (i32.add (i32.const ${GPBUF}) (local.get $pos)) (call $gp_oambyte (i32.shl (local.get $pos) (i32.const 1))))
              (i32.store8 (i32.add (i32.const ${GPBUF + 1}) (local.get $pos)) (call $gp_oambyte (i32.add (i32.shl (local.get $pos) (i32.const 1)) (i32.const 1)))))
            (else
              (i32.store8 (i32.add (i32.const ${GPSZ}) (i32.shr_u (local.get $pos) (i32.const 1)))
                (i32.or (i32.and (i32.load8_u (i32.add (i32.const ${GPSZ}) (i32.shr_u (local.get $pos) (i32.const 1)))) (i32.const ${C}))
                        (global.get $gplsrc)))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $l)))))
    (global.set $gplu (local.get $cc)))

  ;; OamReader::change
  (func $gp_oamchange (param $cc i32)
    (call $gp_oamrd (local.get $cc))
    (global.set $gplast (call $gp_min80 (call $gp_poscyc (global.get $gplu)))))

  ;; SpriteMapper::schedule: the next line cycle 80
  (func $gp_smsched (param $cc i32)
    (local $t i32)
    (local.set $t (i32.add (global.get $gptime) (i32.shl (i32.const 80) (global.get $gpds))))
    (if (i32.gt_u (i32.sub (local.get $t) (local.get $cc)) (i32.shl (i32.const 456) (global.get $gpds)))
      (then (local.set $t (i32.sub (local.get $t) (i32.shl (i32.const 456) (global.get $gpds))))))
    (global.set $gpsmt (local.get $t))
    (global.set $gpsmon (i32.const 1)))

  ;; SpriteMapper::mapSprites (lines flagged 0x80 still need their X sort)
  (func $gp_mapsprites
    (local $i i32) (local $h i32) (local $b i32) (local $ly i32) (local $end i32) (local $n i32)
    (memory.fill (i32.const ${GPNUM}) (i32.const 0x80) (i32.const 144))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 0x50)))
      (local.set $h (i32.shl (i32.const 8) (i32.load8_u (i32.add (i32.const ${GPSZ}) (i32.shr_u (local.get $i) (i32.const 1))))))
      (local.set $b (i32.sub (i32.load8_u (i32.add (i32.const ${GPBUF}) (local.get $i))) (i32.sub (i32.const 17) (local.get $h))))
      (if (i32.lt_u (local.get $b) (i32.add (i32.const 143) (local.get $h)))
        (then
          (local.set $ly (i32.add (i32.sub (local.get $b) (local.get $h)) (i32.const 1)))
          (if (i32.lt_s (local.get $ly) (i32.const 0)) (then (local.set $ly (i32.const 0))))
          (local.set $end (i32.add (select (local.get $b) (i32.const 143) (i32.lt_u (local.get $b) (i32.const 143))) (i32.const 1)))
          (loop $ll
            (local.set $n (i32.load8_u (i32.add (i32.const ${GPNUM}) (local.get $ly))))
            (if (i32.lt_u (local.get $n) (i32.const ${0x80 + 10}))
              (then
                (i32.store8 (i32.add (i32.const ${GPSMAP}) (i32.add (i32.mul (local.get $ly) (i32.const 10)) (i32.sub (local.get $n) (i32.const 0x80))))
                  (local.get $i))
                (i32.store8 (i32.add (i32.const ${GPNUM}) (local.get $ly)) (i32.add (local.get $n) (i32.const 1)))))
            (local.set $ly (i32.add (local.get $ly) (i32.const 1)))
            (br_if $ll (i32.ne (local.get $ly) (local.get $end))))))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br $l))))

  ;; SpriteMapper::sprites(ly): the line's entries (buf offsets), X-sorted
  ;; on first use (insertionSort, stable); the count comes back
  (func $gp_sprites (param $ly i32) (result i32)
    (local $n i32) (local $m i32) (local $i i32) (local $j i32) (local $v i32)
    (local.set $n (i32.load8_u (i32.add (i32.const ${GPNUM}) (local.get $ly))))
    (local.set $m (i32.add (i32.const ${GPSMAP}) (i32.mul (local.get $ly) (i32.const 10))))
    (if (i32.and (local.get $n) (i32.const 0x80))
      (then
        (local.set $n (i32.and (local.get $n) (i32.const 0x7F)))
        (i32.store8 (i32.add (i32.const ${GPNUM}) (local.get $ly)) (local.get $n))
        (local.set $i (i32.const 1))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
          (local.set $v (i32.load8_u (i32.add (local.get $m) (local.get $i))))
          (local.set $j (local.get $i))
          (block $id (loop $il
            (br_if $id (i32.eqz (local.get $j)))
            (br_if $id (i32.le_u
              (i32.load8_u (i32.add (i32.const ${GPBUF + 1}) (i32.load8_u (i32.add (local.get $m) (i32.sub (local.get $j) (i32.const 1))))))
              (i32.load8_u (i32.add (i32.const ${GPBUF + 1}) (local.get $v)))))
            (i32.store8 (i32.add (local.get $m) (local.get $j)) (i32.load8_u (i32.add (local.get $m) (i32.sub (local.get $j) (i32.const 1)))))
            (local.set $j (i32.sub (local.get $j) (i32.const 1)))
            (br $il)))
          (i32.store8 (i32.add (local.get $m) (local.get $j)) (local.get $v))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))))
    (local.get $n))

  ;; X positions of sprites(ly) into GPMAP2 (count at +15)
  (func $gp_map (param $ly i32) (result i32)
    (local $n i32) (local $i i32) (local $m i32)
    (if (i32.ge_u (local.get $ly) (i32.const 144))
      (then (i32.store8 (i32.const ${GPMAP2 + 15}) (i32.const 0)) (return (i32.const ${GPMAP2}))))
    (local.set $n (call $gp_sprites (local.get $ly)))
    (local.set $m (i32.add (i32.const ${GPSMAP}) (i32.mul (local.get $ly) (i32.const 10))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store8 (i32.add (i32.const ${GPMAP2}) (local.get $i))
        (i32.load8_u (i32.add (i32.const ${GPBUF + 1}) (i32.load8_u (i32.add (local.get $m) (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store8 (i32.const ${GPMAP2 + 15}) (local.get $n))
    (i32.const ${GPMAP2}))

  ;; LCD::oamChange(cc) (a CPU OAM write) and oamChange(oamram, cc) (an OAM
  ;; DMA taking or giving back the bus: $dis)
  (func $gp_oamw (param $cc i32)
    (if (i32.eqz (i32.and (global.get $gplcdc) (i32.const 0x80))) (then (return)))
    (call $gp_update (local.get $cc))
    (call $gp_oamchange (local.get $cc))
    (call $gp_smsched (local.get $cc)))
  (func $gp_oamptr (param $dis i32) (param $cc i32)
    (call $gp_update (local.get $cc))
    (call $gp_oamchange (local.get $cc))
    (global.set $gpoamdis (local.get $dis))
    (if (i32.and (global.get $gplcdc) (i32.const 0x80)) (then (call $gp_smsched (local.get $cc)))))

  ;; M3Start::f1's spriteList from sprites(ly); spx 0xFF ends it
  (func $gp_loadlist
    (local $m i32) (local $n i32) (local $i i32)
    (local.set $m (call $gp_map (global.get $gply)))
    (local.set $n (i32.load8_u (i32.add (local.get $m) (i32.const 15))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store8 (i32.add (i32.const ${GPSPX}) (local.get $i)) (i32.load8_u (i32.add (local.get $m) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store8 (i32.add (i32.const ${GPSPX}) (local.get $n)) (i32.const 0xFF)))

  ;; handleWinDrawStartReq(p, xpos, winDrawState) on $gpwds
  (func $gp_hwsr (param $xpos i32) (result i32)
    (local $s i32)
    (if (i32.or (i32.lt_s (local.get $xpos) (i32.const 167)) (i32.const ${C}))
      (then (global.set $gpwds (i32.and (global.get $gpwds) (i32.const 2)))
            (local.set $s (i32.ne (global.get $gpwds) (i32.const 0)))))
    (if (i32.eqz ${winEn}) (then (global.set $gpwds (i32.and (global.get $gpwds) (i32.const -3)))))
    (local.get $s))

  ;; plotPixel: the window-start check, then the next pixel
  (func $gp_plot
    (if (i32.and (i32.and (i32.eq (global.get $gpwx) (global.get $gpxpos))
                          (i32.or (global.get $gpwem) (i32.and (i32.eq (global.get $gpwy2) (global.get $gply)) ${winEn})))
                 (i32.lt_s (global.get $gpxpos) (i32.const 167)))
      (then
        (if (i32.and (i32.eqz (global.get $gpwds)) ${winEn})
          (then (global.set $gpwds (i32.const 3)))
          (else ${cgb ? "" : `(if (i32.or (i32.eqz (global.get $gpwds)) (i32.eq (global.get $gpxpos) (i32.const 166)))
                  (then (global.set $gpwds (i32.or (global.get $gpwds) (i32.const 1)))))`}))))
    (global.set $gpxpos (i32.add (global.get $gpxpos) (i32.const 1))))

  ;; plotPixelIfNoSprite
  (func $gp_plotns
    (if (i32.eq ${spx("(global.get $gpnsp)")} (global.get $gpxpos))
      (then
        (if (i32.eqz ${objEnOrCgb})
          (then
            (loop $sk
              (global.set $gpnsp (i32.add (global.get $gpnsp) (i32.const 1)))
              (br_if $sk (i32.eq ${spx("(global.get $gpnsp)")} (global.get $gpxpos))))
            (call $gp_plot))))
      (else (call $gp_plot))))

  ;; nextM2Time
  (func $gp_nextm2 (result i32)
    (local $t i32)
    (local.set $t (if (result i32) (global.get $gpds)
      (then (i32.add (global.get $gptime) (i32.const ${(449 + 3) * 2 - 912})))
      (else (i32.add (global.get $gptime) (i32.const ${(450 - C) - 456})))))
    (if (i32.eq (global.get $gply) (i32.const 143))
      (then (local.set $t (i32.add (local.get $t) (i32.shl (i32.const ${456 * 10 + 456 - (450 - C)}) (global.get $gpds))))))
    (local.get $t))

  ;; xpos168: the line's mode-0 time, and on to the next line's mode 2
  (func $gp_x168
    (local $m2 i32)
    (global.set $gplastm0 (i32.sub (global.get $gpnow) (i32.shl (global.get $gpcyc) (global.get $gpds))))
    (local.set $m2 (call $gp_nextm2))
    (global.set $gpcyc (if (result i32) (i32.ge_s (i32.sub (global.get $gpnow) (local.get $m2)) (i32.const 0))
      (then (i32.shr_s (i32.sub (global.get $gpnow) (local.get $m2)) (global.get $gpds)))
      (else (i32.sub (i32.const 0) (i32.shr_s (i32.sub (local.get $m2) (global.get $gpnow)) (global.get $gpds))))))
    (global.set $gpst (if (result i32) (i32.eq (global.get $gply) (i32.const 143)) (then (i32.const 0)) (else (i32.const 1)))))

  ;; doFullTilesUnrolled(Dmg|Cgb): whole tiles at a time, the cycles each
  ;; costs (8, plus the sprite fetches on it), no pixels
  (func $gp_tiles (param $xend i32)
    (local $xpos i32) (local $ns i32) (local $c i32) (local $i i32) (local $n i32) (local $s i32)
    (local.set $xpos (global.get $gpxpos))
    (block $out (loop $l
      (local.set $ns (global.get $gpnsp))
      (local.set $s ${spx("(local.get $ns)")})
      (block $cont
        (if (i32.lt_s (local.get $s) (i32.add (local.get $xpos) (i32.const 8)))
          (then
            (local.set $c (i32.sub (global.get $gpcyc) (i32.const 8)))
            (if ${objEnOrCgb}
              (then
                (local.set $n (i32.sub (i32.const 11) (i32.sub (local.get $s) (local.get $xpos))))
                (local.set $c (i32.sub (local.get $c) (select (local.get $n) (i32.const 6) (i32.gt_s (local.get $n) (i32.const 6)))))
                (local.set $i (i32.add (local.get $ns) (i32.const 1)))
                (block $d (loop $il
                  (br_if $d (i32.ge_s ${spx("(local.get $i)")} (i32.add (local.get $xpos) (i32.const 8))))
                  (local.set $c (i32.sub (local.get $c) (i32.const 6)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $il)))))
            (br_if $out (i32.lt_s (local.get $c) (i32.const 0)))
            (global.set $gpcyc (local.get $c))
            (loop $sl
              (local.set $ns (i32.add (local.get $ns) (i32.const 1)))
              (br_if $sl (i32.lt_s ${spx("(local.get $ns)")} (i32.add (local.get $xpos) (i32.const 8)))))
            (global.set $gpnsp (local.get $ns)))
          (else
            (if (i32.or (i32.lt_s (i32.sub (local.get $ns) (i32.const 1)) (i32.const 0))
                        (i32.le_s ${spx("(i32.sub (local.get $ns) (i32.const 1))")} (i32.sub (local.get $xpos) (i32.const 8))))
              (then
                (br_if $out (i32.eqz (i32.and (global.get $gpcyc) (i32.const -8))))
                (local.set $n (i32.add (local.get $xend) (i32.const 7)))
                (if (i32.ge_s (local.get $n) (local.get $s)) (then (local.set $n (local.get $s))))
                (local.set $n (i32.and (i32.sub (local.get $n) (local.get $xpos)) (i32.const -8)))
                (if (i32.lt_s (i32.and (global.get $gpcyc) (i32.const -8)) (local.get $n))
                  (then (local.set $n (i32.and (global.get $gpcyc) (i32.const -8)))))
                (global.set $gpcyc (i32.sub (global.get $gpcyc) (local.get $n)))
                (local.set $xpos (i32.add (local.get $xpos) (local.get $n)))
                (br $cont))
              (else
                (local.set $c (i32.sub (global.get $gpcyc) (i32.const 8)))
                (br_if $out (i32.lt_s (local.get $c) (i32.const 0)))
                (global.set $gpcyc (local.get $c))))))
        (local.set $xpos (i32.add (local.get $xpos) (i32.const 8))))
      (br_if $l (i32.lt_s (local.get $xpos) (local.get $xend)))))
    (global.set $gpxpos (local.get $xpos)))

  (func $gp_dofull
    (local $xend i32)
    (local.set $xend (if (result i32) (i32.or (i32.lt_s (global.get $gpwx) (global.get $gpxpos)) (i32.ge_u (global.get $gpwx) (i32.const 168)))
      (then (i32.const 161)) (else (i32.sub (global.get $gpwx) (i32.const 7)))))
    (if (i32.ge_s (global.get $gpxpos) (local.get $xend)) (then (return)))
    (if (i32.lt_s (global.get $gpxpos) (i32.const 8))
      (then
        (call $gp_tiles (select (local.get $xend) (i32.const 8) (i32.lt_s (local.get $xend) (i32.const 8))))
        (if (i32.lt_s (global.get $gpxpos) (i32.const 8)) (then (return)))
        (if (i32.ge_s (global.get $gpxpos) (local.get $xend)) (then (return)))))
    (call $gp_tiles (local.get $xend)))

  ;; the state functions, run while the budget lasts (nextCall / f(p))
  (func $gp_run
    (local $e i32)
    (loop $run
        ${dispatch}))

  ;; PPU::update(cc)
  (func $gp_ppuupd (param $cc i32)
    (local $c i32)
    ;; an update to a cycle already passed changes nothing that a later one
    ;; would not undo (gambatte moves now back and forward again)
    (if (i32.lt_s (i32.sub (local.get $cc) (global.get $gpnow)) (i32.const 0)) (then (return)))
    (local.set $c (i32.shr_s (i32.sub (local.get $cc) (global.get $gpnow)) (global.get $gpds)))
    (global.set $gpnow (i32.add (global.get $gpnow) (i32.shl (local.get $c) (global.get $gpds))))
    (global.set $gpcyc (i32.add (global.get $gpcyc) (local.get $c)))
    (if (i32.ge_s (global.get $gpcyc) (i32.const 0)) (then (call $gp_run))))

  ;; LCD::update(cc) for the shadow: the LY counter's events and the CGB
  ;; wy2 one-shot at their own times, the PPU up to each
  (func $gp_update (param $cc i32)
    (local $t i32) (local $k i32)
    (if (i32.eqz (i32.and (global.get $gplcdc) (i32.const 0x80))) (then (return)))
    (block $d (loop $l
      ;; the earliest of the LY event, the sprite-map event and a pending
      ;; CGB wy2 update, if due by cc (LCD::update's event loop)
      (local.set $t (global.get $gptime)) (local.set $k (i32.const 0))
      (if (i32.and (global.get $gpsmon) (i32.lt_s (i32.sub (global.get $gpsmt) (local.get $t)) (i32.const 0)))
        (then (local.set $t (global.get $gpsmt)) (local.set $k (i32.const 1))))
      (if (i32.and (global.get $gpwy2on) (i32.lt_s (i32.sub (global.get $gpwy2t) (local.get $t)) (i32.const 0)))
        (then (local.set $t (global.get $gpwy2t)) (local.set $k (i32.const 2))))
      (br_if $d (i32.gt_s (i32.sub (local.get $t) (local.get $cc)) (i32.const 0)))
      (call $gp_ppuupd (local.get $t))
      (if (i32.eqz (local.get $k))
        (then
          (global.set $gply (i32.add (global.get $gply) (i32.const 1)))
          (if (i32.eq (global.get $gply) (i32.const 154)) (then (global.set $gply (i32.const 0))))
          (global.set $gptime (i32.add (global.get $gptime) (i32.shl (i32.const 456) (global.get $gpds))))))
      (if (i32.eq (local.get $k) (i32.const 1))
        (then
          ;; SpriteMapper::doEvent, then mode3CyclesChange
          (call $gp_oamrd (local.get $t))
          (call $gp_mapsprites)
          (if (i32.ne (global.get $gplast) (i32.const 0xFF))
            (then (global.set $gpsmt (i32.add (local.get $t) (i32.shl (i32.const 456) (global.get $gpds)))))
            (else (global.set $gpsmon (i32.const 0))))
          (call $gp_m3change)))
      (if (i32.eq (local.get $k) (i32.const 2))
        (then (global.set $gpwy2on (i32.const 0)) (global.set $gpwy2 (global.get $gpwy)) (call $gp_m3change)))
      (br $l)))
    (call $gp_ppuupd (local.get $cc)))

  ;; ---- predictCyclesUntilXpos ----
  (func $gp_addspr (param $m i32) (param $s i32) (param $end i32) (param $max i32) (param $first i32) (param $prev i32) (result i32)
    (local $x i32) (local $c i32) (local $d i32) (local $t i32)
    (block $dn (loop $l
      (br_if $dn (i32.ge_u (local.get $s) (local.get $end)))
      (local.set $x (i32.load8_u (i32.add (local.get $m) (local.get $s))))
      (br_if $dn (i32.gt_u (local.get $x) (local.get $max)))
      (local.set $c (i32.const 6))
      (local.set $d (i32.and (i32.sub (local.get $x) (local.get $first)) (i32.const 7)))
      (local.set $t (i32.and (i32.sub (local.get $x) (local.get $first)) (i32.const -8)))
      (if (i32.and (i32.lt_u (local.get $d) (i32.const 5)) (i32.ne (local.get $t) (local.get $prev)))
        (then (local.set $c (i32.sub (i32.const 11) (local.get $d)))))
      (local.set $prev (local.get $t))
      (global.set $gpacc (i32.add (global.get $gpacc) (local.get $c)))
      (local.set $s (i32.add (local.get $s) (i32.const 1)))
      (br $l)))
    (local.get $s))
  (global $gpacc (mut i32) (i32.const 0))

  (func $gp_ptile (param $xpos i32) (param $endx i32) (param $ly i32) (param $ns i32) (param $wem i32) (param $wds i32)
                  (param $fno i32) (param $tx i32) (param $cyc i32) (result i32)
    (local $nwx i32) (local $m i32) (local $n i32) (local $s i32) (local $x i32) (local $first i32) (local $prev i32) (local $sw i32)
    (if (i32.and (local.get $wds) (i32.const 1))
      (then
        (local.set $sw (global.get $gpwds))
        (global.set $gpwds (local.get $wds))
        (if (call $gp_hwsr (local.get $xpos))
          (then (local.set $wds (global.get $gpwds)) (global.set $gpwds (local.get $sw))
                (return (call $gp_pswd (local.get $xpos) (local.get $endx) (local.get $ly) (local.get $ns) (local.get $wem)
                          (local.get $wds) (i32.const 0) (local.get $tx) (local.get $cyc)))))
        (local.set $wds (global.get $gpwds))
        (global.set $gpwds (local.get $sw))))
    (if (i32.gt_s (local.get $xpos) (local.get $tx))
      (then (return (call $gp_pnextline (local.get $wds) (local.get $tx)))))
    (local.set $nwx (i32.const 0xFF))
    (local.set $cyc (i32.add (local.get $cyc) (i32.sub (local.get $tx) (local.get $xpos))))
    (if (i32.and (i32.and (i32.lt_u (i32.sub (global.get $gpwx) (local.get $xpos)) (i32.sub (local.get $tx) (local.get $xpos)))
                          ${winEn})
                 (i32.and (i32.or (local.get $wem) (i32.eq (global.get $gpwy2) (local.get $ly)))
                          (i32.and (i32.eqz (i32.and (local.get $wds) (i32.const 2)))
                                   (i32.or (i32.const ${C}) (i32.ne (global.get $gpwx) (i32.const 166))))))
      (then (local.set $nwx (global.get $gpwx)) (local.set $cyc (i32.add (local.get $cyc) (i32.const 6)))))
    (if ${objEnOrCgb}
      (then
        (local.set $m (call $gp_map (local.get $ly)))
        (local.set $n (i32.load8_u (i32.add (local.get $m) (i32.const 15))))
        (local.set $s (local.get $ns))
        (if (i32.lt_u (local.get $s) (local.get $n))
          (then
            (local.set $x (i32.load8_u (i32.add (local.get $m) (local.get $s))))
            (local.set $first (i32.and (local.get $endx) (i32.const 7)))
            (local.set $prev (i32.and (i32.sub (local.get $xpos) (local.get $first)) (i32.const -8)))
            (if (i32.and (i32.lt_s (i32.sub (i32.add (local.get $fno) (local.get $x)) (local.get $xpos)) (i32.const 5))
                         (i32.le_s (local.get $x) (local.get $nwx)))
              (then (local.set $cyc (i32.add (local.get $cyc)
                      (i32.sub (i32.const 11) (i32.sub (i32.add (local.get $fno) (local.get $x)) (local.get $xpos)))))
                    (local.set $s (i32.add (local.get $s) (i32.const 1)))))
            (global.set $gpacc (i32.const 0))
            (if (i32.lt_s (local.get $nwx) (local.get $tx))
              (then
                (local.set $s (call $gp_addspr (local.get $m) (local.get $s) (local.get $n) (local.get $nwx) (local.get $first) (local.get $prev)))
                (local.set $first (i32.add (local.get $nwx) (i32.const 1)))
                (local.set $prev (i32.const 1))))
            (drop (call $gp_addspr (local.get $m) (local.get $s) (local.get $n) (local.get $tx) (local.get $first) (local.get $prev)))
            (local.set $cyc (i32.add (local.get $cyc) (global.get $gpacc)))))))
    (local.get $cyc))

  (func $gp_pswd (param $xpos i32) (param $endx i32) (param $ly i32) (param $ns i32) (param $wem i32) (param $wds i32)
                 (param $fno i32) (param $tx i32) (param $cyc i32) (result i32)
    (local $cinc i32) (local $xinc i32) (local $t i32)
    (if (i32.gt_s (local.get $xpos) (local.get $tx))
      (then (return (call $gp_pnextline (local.get $wds) (local.get $tx)))))
    (local.set $cinc (i32.sub (i32.const 6) (local.get $fno)))
    ${cgb ? `(if (i32.eqz ${winEn})
      (then
        (local.set $t (i32.add (local.get $tx) (i32.const 1)))
        (if (i32.lt_s (local.get $endx) (local.get $t)) (then (local.set $t (local.get $endx))))
        (local.set $xinc (i32.sub (local.get $t) (local.get $xpos)))
        (if (i32.lt_s (local.get $cinc) (local.get $xinc)) (then (local.set $xinc (local.get $cinc))))
        (if (i32.lt_u ${spx("(local.get $ns)")} (i32.add (local.get $xpos) (local.get $xinc)))
          (then (local.set $xpos ${spx("(local.get $ns)")}))
          (else (local.set $cinc (local.get $xinc)) (local.set $xpos (i32.add (local.get $xpos) (local.get $xinc)))))))` : ""}
    (local.set $cyc (i32.add (local.get $cyc) (local.get $cinc)))
    (if (i32.le_s (local.get $xpos) (local.get $tx))
      (then (return (call $gp_ptile (local.get $xpos)
        (if (result i32) (i32.lt_s (local.get $xpos) (i32.const 160)) (then (i32.add (local.get $xpos) (i32.const 8))) (else (i32.const 168)))
        (local.get $ly) (local.get $ns) (local.get $wem) (local.get $wds) (i32.const 0) (local.get $tx) (local.get $cyc)))))
    (i32.sub (local.get $cyc) (i32.const 1)))

  (func $gp_pm3s1 (param $xpos i32) (param $ly i32) (param $wem i32) (param $wds i32) (param $tx i32) (param $cyc i32) (result i32)
    (local $a i32) (local $b i32)
    (local.set $a (i32.and (i32.sub (global.get $gpscx) (local.get $xpos)) (i32.const 7)))
    (local.set $b (i32.sub (i32.const 80) (local.get $xpos)))
    (local.set $cyc (i32.add (local.get $cyc) (i32.add (select (local.get $a) (local.get $b) (i32.lt_u (local.get $a) (local.get $b))) (i32.const ${1 - C}))))
    (local.set $a (i32.and (global.get $gpscx) (i32.const 7)))
    (call $gp_ptile (i32.const 0) (i32.sub (i32.const 8) (local.get $a)) (local.get $ly) (i32.const 0) (local.get $wem) (local.get $wds)
      (select (local.get $a) (i32.const 5) (i32.lt_u (local.get $a) (i32.const 5))) (local.get $tx) (local.get $cyc)))

  (func $gp_pm3s0 (param $ly i32) (param $wem i32) (param $wds i32) (param $tx i32) (param $cyc i32) (result i32)
    (call $gp_pm3s1 (i32.const 0) (local.get $ly) (local.get $wem)
      (if (result i32) (i32.and (i32.ne (i32.and (local.get $wds) (i32.const 1)) (i32.const 0)) ${winEn}) (then (i32.const 2)) (else (i32.const 0)))
      (local.get $tx) (local.get $cyc)))

  (func $gp_pm2ly0 (param $wds i32) (param $tx i32) (param $cyc i32) (result i32)
    (call $gp_pm3s0 (i32.const 0) (i32.and ${winEn} (i32.eqz (global.get $gpwy))) (local.get $wds) (local.get $tx)
      (i32.add (local.get $cyc) (i32.const 83))))

  (func $gp_pm2n1 (param $wem i32) (param $wds i32) (param $tx i32) (param $cyc i32) (result i32)
    (local $ly i32)
    (local.set $ly (i32.add (global.get $gply) (i32.const 1)))
    (call $gp_pm3s0 (local.get $ly) (i32.or (local.get $wem) (i32.and ${winEn} (i32.eq (local.get $ly) (global.get $gpwy))))
      (local.get $wds) (local.get $tx) (i32.add (local.get $cyc) (i32.const ${456 - (454 - C) + 83}))))

  (func $gp_pm2n0 (param $wds i32) (param $tx i32) (param $cyc i32) (result i32)
    (call $gp_pm2n1 (i32.or (global.get $gpwem) (i32.and ${winEn} (i32.eq (global.get $gply) (global.get $gpwy))))
      (local.get $wds) (local.get $tx) (i32.add (local.get $cyc) (i32.const 4))))

  (func $gp_pnextline (param $wds i32) (param $tx i32) (result i32)
    (local $c i32)
    ${cgb ? "" : `(if (i32.and (i32.and (i32.eq (global.get $gpwx) (i32.const 166)) (i32.lt_s (global.get $gpxpos) (i32.const 167)))
                 (i32.or (global.get $gpwem) (i32.and (i32.eq (global.get $gpwy2) (global.get $gply)) ${winEn})))
      (then (local.set $wds (i32.or (i32.const 1) (select (i32.const 2) (i32.const 0) ${winEn})))))`}
    (local.set $c (i32.shr_u (i32.sub (call $gp_nextm2) (global.get $gpnow)) (global.get $gpds)))
    (if (result i32) (i32.eq (global.get $gply) (i32.const 143))
      (then (call $gp_pm2ly0 (local.get $wds) (local.get $tx) (local.get $c)))
      (else (call $gp_pm2n0 (local.get $wds) (local.get $tx) (local.get $c)))))

  ;; PPU::predictedNextXposTime(tx): an absolute cycle
  (func $gp_predict (param $tx i32) (result i32)
    (local $c i32) (local $s i32) (local $f i32) (local $endx i32)
    (local.set $c (i32.sub (i32.const 0) (global.get $gpcyc)))
    (local.set $s (global.get $gpst))
    (local.set $f (i32.rem_u (local.get $s) (i32.const 10)))
    (local.set $c
      (if (result i32) (i32.eqz (local.get $s)) (then (call $gp_pm2ly0 (global.get $gpwds) (local.get $tx) (local.get $c)))
      (else (if (result i32) (i32.eq (local.get $s) (i32.const 1)) (then (call $gp_pm2n0 (global.get $gpwds) (local.get $tx) (local.get $c)))
      (else (if (result i32) (i32.eq (local.get $s) (i32.const 2)) (then (call $gp_pm2n1 (global.get $gpwem) (global.get $gpwds) (local.get $tx) (local.get $c)))
      (else (if (result i32) (i32.eq (local.get $s) (i32.const 3))
        (then (call $gp_pm3s0 (i32.add (global.get $gply) (i32.lt_u (i32.sub (global.get $gptime) (global.get $gpnow)) (i32.const 16)))
                (global.get $gpwem) (global.get $gpwds) (local.get $tx) (local.get $c)))
      (else (if (result i32) (i32.eq (local.get $s) (i32.const 4))
        (then (call $gp_pm3s1 (global.get $gpxpos) (global.get $gply) (global.get $gpwem) (global.get $gpwds) (local.get $tx) (local.get $c)))
      (else (if (result i32) (i32.lt_u (local.get $s) (i32.const 20))
        (then (call $gp_ptile (global.get $gpxpos)
                (if (result i32) (local.get $f) (then (global.get $gpendx))
                  (else (if (result i32) (i32.lt_u (global.get $gpxpos) (i32.const 160)) (then (i32.add (global.get $gpxpos) (i32.const 8))) (else (i32.const 168)))))
                (global.get $gply) (global.get $gpnsp) (global.get $gpwem) (global.get $gpwds) (local.get $f) (local.get $tx) (local.get $c)))
      (else (if (result i32) (i32.lt_u (local.get $s) (i32.const 30))
        ;; LoadSprites::predictCyclesUntilXpos_fn
        (then (call $gp_ptile (global.get $gpxpos) (global.get $gpendx) (global.get $gply)
                (i32.add (global.get $gpnsp) (select (i32.const 1) (i32.const 0) ${objEnOrCgb}))
                (global.get $gpwem) (global.get $gpwds) (i32.const 5) (local.get $tx)
                (i32.add (local.get $c) (select (i32.sub (i32.const 6) (local.get $f)) (i32.const 0) ${objEnOrCgb}))))
        (else
          (local.set $endx (global.get $gpendx))
          (if (i32.and (i32.eqz (local.get $f)) (i32.eq (global.get $gpxpos) (global.get $gpendx)))
            (then (local.set $endx (if (result i32) (i32.lt_u (global.get $gpxpos) (i32.const 160)) (then (i32.add (global.get $gpxpos) (i32.const 8))) (else (i32.const 168))))))
          (call $gp_pswd (global.get $gpxpos) (local.get $endx) (global.get $gply) (global.get $gpnsp) (global.get $gpwem) (global.get $gpwds)
            (local.get $f) (local.get $tx) (local.get $c)))))))))))))))))
    (i32.add (global.get $gpnow) (i32.shl (local.get $c) (global.get $gpds))))

  ;; the register writes that reach the PPU (LCD::lcdcChange, scxChange,
  ;; wxChange, wyChange), at the write's cycle
  (func $gp_lcdc (param $v i32) (param $cc i32)
    (local $old i32)
    (local.set $old (global.get $gplcdc))
    (if (i32.and (i32.xor (local.get $old) (local.get $v)) (i32.const 0x80))
      (then
        (call $gp_update (local.get $cc))
        (call $gp_setlcdc (local.get $v) (local.get $cc))
        (if (i32.and (local.get $v) (i32.const 0x80)) (then (call $gp_smsched (local.get $cc))))
        (return)))
    (if (i32.eqz (i32.and (local.get $v) (i32.const 0x80)))
      (then (global.set $gplcdc (local.get $v)) (return)))
    (call $gp_update (local.get $cc))
    ${cgb ? `(call $gp_setlcdc (i32.or (i32.and (local.get $old) (i32.const -21)) (i32.and (local.get $v) (i32.const 0x14))) (local.get $cc))
    (if (i32.and (i32.xor (local.get $old) (local.get $v)) (i32.const 0x04)) (then (call $gp_smsched (local.get $cc))))
    (call $gp_update (i32.add (local.get $cc) (i32.add (global.get $gpds) (i32.const 1))))
    (call $gp_setlcdc (local.get $v) (i32.add (local.get $cc) (i32.add (global.get $gpds) (i32.const 1))))
    (if (i32.and (i32.xor (local.get $old) (local.get $v)) (i32.const 0x20)) (then (call $gp_m3change)))`
    : `(call $gp_setlcdc (local.get $v) (local.get $cc))
    (if (i32.and (i32.xor (local.get $old) (local.get $v)) (i32.const 0x04)) (then (call $gp_smsched (local.get $cc))))
    (if (i32.and (i32.xor (local.get $old) (local.get $v)) (i32.const 0x22)) (then (call $gp_m3change)))`})

  (func $gp_scx (param $v i32) (param $cc i32)
    (call $gp_update (i32.add (local.get $cc) (i32.add (global.get $gpds) (i32.const ${C}))))
    (global.set $gpscx (local.get $v))
    (call $gp_m3change))

  (func $gp_wx (param $v i32) (param $cc i32)
    (call $gp_update (i32.add (local.get $cc) (i32.add (global.get $gpds) (i32.const 1))))
    (global.set $gpwx (local.get $v))
    (call $gp_m3change))

  (func $gp_wy (param $v i32) (param $cc i32)
    (call $gp_update (i32.add (local.get $cc) (i32.const 1)))
    (global.set $gpwy (local.get $v))
    ${cgb ? `(if (i32.and (global.get $gplcdc) (i32.const 0x80))
      (then (global.set $gpwy2t (i32.add (local.get $cc) (i32.const 5))) (global.set $gpwy2on (i32.const 1)) (return)))` : ""}
    (call $gp_update (i32.add (local.get $cc) (i32.const 2)))
    (global.set $gpwy2 (local.get $v))
    (call $gp_m3change))

  ;; LCD::speedChange / PPU::speedChange at cc (after STOP's own cycles)
  (func $gp_speed (param $cc i32)
    (local $vc i32) (local $old i32)
    (call $gp_update (local.get $cc))
    (call $gp_oamrd (local.get $cc))
    (local.set $old (global.get $gpds))
    (local.set $vc (if (result i32) (i32.and (global.get $gplcdc) (i32.const 0x80))
      (then (i32.add (i32.mul (global.get $gply) (i32.const 456))
              (i32.sub (i32.const 456) (i32.shr_u (i32.sub (global.get $gptime) (global.get $gpnow)) (local.get $old)))))
      (else (i32.const 0))))
    (global.set $gpds (i32.xor (local.get $old) (i32.const 1)))
    (global.set $gply (i32.div_u (local.get $vc) (i32.const 456)))
    (global.set $gptime (i32.add (global.get $gpnow)
      (i32.shl (i32.sub (i32.const 456) (i32.rem_u (local.get $vc) (i32.const 456))) (global.get $gpds))))
    (call $gp_oamchange (local.get $cc))
    (if (i32.and (global.get $gplcdc) (i32.const 0x80)) (then (call $gp_smsched (local.get $cc))))
    (if (i32.le_u (global.get $gpst) (i32.const 1))
      (then (global.set $gpcyc (if (result i32) (local.get $old)
              (then (i32.sub (global.get $gpcyc) (i32.const 3))) (else (i32.add (global.get $gpcyc) (i32.const 3))))))))

  ;; PPU::setLcdc(lcdc, cc) (the enable reset and the window-enable rules)
  (func $gp_setlcdc (param $v i32) (param $cc i32)
    (local $x i32)
    (local.set $x (i32.xor (global.get $gplcdc) (local.get $v)))
    (if (i32.and (i32.and (local.get $x) (local.get $v)) (i32.const 0x80))
      (then
        (global.set $gpnow (local.get $cc))
        (global.set $gplastm0 (i32.const 0))
        (global.set $gply (i32.const 0))
        (global.set $gptime (i32.add (local.get $cc) (i32.shl (i32.const 456) (global.get $gpds))))
        (global.set $gpwem (i32.and (i32.ne (i32.and (local.get $v) (i32.const 0x20)) (i32.const 0)) (i32.eqz (global.get $gpwy))))
        (global.set $gpwds (i32.const 0))
        (global.set $gpst (i32.const 3))
        (global.set $gpcyc (i32.sub (i32.const 0) (i32.add (i32.const 83) (i32.mul (i32.const 3) (global.get $gpds)))))
        ;; OamReader::enableDisplay
        (memory.fill (i32.const ${GPBUF}) (i32.const 0) (i32.const 80))
        (memory.fill (i32.const ${GPSZ}) (i32.const 0) (i32.const 40))
        (global.set $gplu (i32.add (local.get $cc) (i32.shl (i32.const 80) (global.get $gpds))))
        (global.set $gplast (i32.const 80)))
      (else (if (i32.and (local.get $x) (i32.const 0x20))
        (then
          (if (i32.eqz (i32.and (local.get $v) (i32.const 0x20)))
            (then (if (i32.or (i32.eq (global.get $gpwds) (i32.const 2)) (i32.eq (global.get $gpxpos) (i32.const 168)))
                    (then (global.set $gpwds (i32.and (global.get $gpwds) (i32.const -3))))))
            (else (if (i32.eq (global.get $gpwds) (i32.const 1))
                    (then (global.set $gpwds (i32.const 3))))))))))
    (if (i32.and (local.get $x) (i32.const 0x04))
      (then
        (if (i32.and (i32.and (global.get $gplcdc) (local.get $v)) (i32.const 0x80)) (then (call $gp_oamchange (local.get $cc))))
        (global.set $gplsrc (i32.ne (i32.and (local.get $v) (i32.const 0x04)) (i32.const 0)))))
    (global.set $gplcdc (local.get $v)))
`;
}

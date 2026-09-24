// genesis_plus_gx's YM2612 in WAT: the MAME OPN2 core as gpgx ships it
// (core/sound/ym2612.c, YM2612_DISCRETE: 9-bit DAC operator masks and the
// ladder effect), its DAC, and sound.c's MD glue (YM2612_Write/_Read/_Reset,
// fm_update, the frame flush of sound_update with fm_cycles_start), plus the
// PSG writes of the 68000 ($C00011) and the Z80 ($7F11), all into the shared
// blip buffer of ../sms/psg.js. The output is the s16 44100 Hz stereo stream
// gpgx hands its libretro audio callback, sample for sample.
//
// The YM's CPU-visible side (BUSY, timers A/B, status) stays where it was in
// runtime.js ($ym_mode/$ym_tac/$ym_tal/$ym_tbc/$ym_tbl/$ym_status). The
// hooks patch that text: $fm_update renders through $ym_render (which runs
// INTERNAL_TIMER_A per sample and INTERNAL_TIMER_B per call exactly as
// YM2612Update does, now with the CSM key-on the audio needs), $fm_write
// forwards the register write, $fm_reset resets the chip, $ym_set_timers
// runs set_timers' CSM/3-slot part first.
//
// State layout, tables and constants follow ym2612.c; the tables come from
// ../sms/gpgx-sound.json (parsed from gpgx's source, tl_tab/sin_tab checked
// against the reference core's heap). LICENSE: derived from Genesis Plus GX
// (non-commercial, see NOTICE).
//
// Plain JS ESM + JSDoc.

import { gpgxSoundTables, soundLayout, soundCoreWat, MCLOCK_NTSC, MCLOCK_PAL, SOUND_RATE } from "../sms/psg.js";

/** YM2612 internal clock ratio (sound.c YM2612_CLOCK_RATIO * 24): master cycles per sample. */
export const FM_RATIO = 7 * 6 * 24;
/** sound.c fm_buffer[1080 * 2]: stereo samples a frame can hold. */
export const FMCAP = 1080;

// slot struct (i32 fields)
const S = {
  DT: 0, KSR: 4, ar: 8, d1r: 12, d2r: 16, rr: 20, ksr: 24, mul: 28, phase: 32, Incr: 36, state: 40, tl: 44,
  volume: 48, sl: 52, vol_out: 56, sh_ar: 60, sel_ar: 64, sh_d1r: 68, sel_d1r: 72, sh_d2r: 76, sel_d2r: 80,
  sh_rr: 84, sel_rr: 88, ssg: 92, ssgn: 96, key: 100, AMmask: 104,
};
const SLSZ = 128;
// channel struct: SLOT[4] then these
const C = {
  ALGO: 512, FB: 516, op1a: 520, op1b: 524, conn1: 528, conn3: 532, conn2: 536, conn4: 540, memc: 544,
  memv: 548, pms: 552, ams: 556, fc: 560, kcode: 564, block_fnum: 568,
};
const CHSZ = 576;
const EG_ATT = 4, EG_DEC = 3, EG_SUS = 2, EG_REL = 1, EG_OFF = 0;
const MAX_ATT = 1023, ENV_QUIET = (13 * 2 * 256) >> 3, TL_TAB_LEN = 13 * 2 * 256, DT_MASK = (1 << 17) - 1;

const bytes = (arr, size, signed = false) => {
  const b = Buffer.alloc(arr.length * size);
  arr.forEach((v, i) => {
    if (size === 1) signed ? b.writeInt8(v, i) : b.writeUInt8(v, i);
    else if (size === 2) signed ? b.writeInt16LE(v, i * 2) : b.writeUInt16LE(v, i * 2);
    else b.writeInt32LE(v | 0, i * 4);
  });
  return [...b].map((x) => "\\" + x.toString(16).padStart(2, "0")).join("");
};

/** ym2612.c init_tables' lfo_pm_table (integer only). */
function lfoPmTable(out) {
  const t = new Int8Array(128 * 8 * 32);
  for (let i = 0; i < 8; i++) {
    for (let fnum = 0; fnum < 128; fnum++) {
      for (let step = 0; step < 8; step++) {
        let value = 0;
        for (let bit = 0; bit < 7; bit++) if (fnum & (1 << bit)) value += out[(bit * 8 + i) * 8 + step];
        value &= 0xFF; // UINT8 value
        t[fnum * 256 + i * 32 + step] = value;
        t[fnum * 256 + i * 32 + (step ^ 7) + 8] = value;
        t[fnum * 256 + i * 32 + step + 16] = -value;
        t[fnum * 256 + i * 32 + (step ^ 7) + 24] = -value;
      }
    }
  }
  return t;
}

/**
 * Memory the Genesis sound code owns, from `base`.
 * @param {number} base
 */
export function mdSoundLayout(base) {
  const snd = soundLayout(base, 2048, 1024);
  let p = (snd.end + 15) & ~15;
  const take = (n) => { const a = p; p = (p + n + 15) & ~15; return a; };
  const L = {
    snd,
    TL: take(TL_TAB_LEN * 2), SIN: take(1024 * 2), LFOPM: take(128 * 8 * 32), EGINC: take(19 * 8), EGSEL: take(128),
    EGSH: take(128), DT: take(8 * 32 * 4), FKT: take(16), SL: take(16 * 4), LFOSTEP: take(8 * 4), AMSSH: take(4),
    OPMASK: take(8 * 4 * 4), WIRES: take(16 * 4), PAN: take(12 * 4), SL3: take(9 * 4), CH: take(6 * CHSZ),
  };
  L.end = p;
  return L;
}

/**
 * The YM2612 + PSG + blip WAT for the Genesis backend.
 * @param {object} o
 * @param {number} o.base        free memory for the sound state and tables
 * @param {number} o.cursorAddr  wasmcart audio write cursor
 * @param {number} o.fmBuf       fm_buffer: FMCAP stereo i32 samples
 * @param {boolean} o.pal
 * @param {{offset:number, countOffset:number, capacity:number}} [o.deltas] options.audioDeltas debug stream
 */
export function ymWat(o) {
  const T = gpgxSoundTables().ym2612;
  const L = mdSoundLayout(o.base);
  const lines = o.pal ? 313 : 262;
  const FRAME = lines * 3420;
  const W = { m2: L.WIRES, c1: L.WIRES + 4, c2: L.WIRES + 8, mem: L.WIRES + 12, out: L.WIRES + 16 };
  // ST.dt_tab[8][32]: rows 0-3 from dt_tab, 4-7 negated
  const dt = [];
  for (let d = 0; d < 8; d++) for (let i = 0; i < 32; i++) dt.push(d < 4 ? T.dtTab[d * 32 + i] : -T.dtTab[(d - 4) * 32 + i]);
  // YM2612Config(YM2612_DISCRETE): carrier outputs masked to 9 bits
  const opmask = new Array(32).fill(-1);
  for (const [a, s] of [[0, 3], [1, 3], [2, 3], [3, 3], [4, 1], [4, 3], [5, 1], [5, 2], [5, 3], [6, 1], [6, 2], [6, 3], [7, 0], [7, 1], [7, 2], [7, 3]]) opmask[a * 4 + s] = 0xffffffe0 | 0;
  const MUTE = L.snd.mute;
  const ch = (c) => L.CH + c * CHSZ;
  // SLOT1..SLOT4 = array index 0, 2, 1, 3
  const slotOf = (base, n) => base + [0, 2, 1, 3][n - 1] * SLSZ;
  const ld = (base, off) => `(i32.load offset=${off} ${base})`;
  const st = (base, off, v) => `(i32.store offset=${off} ${base} ${v})`;
  const sl = (f) => ld("(local.get $s)", S[f]);
  const sst = (f, v) => st("(local.get $s)", S[f], v);
  const g = (n, v = 0) => `  (global $${n} (mut i32) (i32.const ${v}))`;
  // vol_out with SSG-EG output inversion when (ssg&8) && (ssgn ^ (ssg&4)) [&& extra]
  const volOut = (extra = "") => `(if (i32.and (i32.and (i32.ne (i32.and ${sl("ssg")} (i32.const 8)) (i32.const 0)) (i32.ne (i32.xor ${sl("ssgn")} (i32.and ${sl("ssg")} (i32.const 4))) (i32.const 0)))${extra ? " " + extra : " (i32.const 1)"})
      (then ${sst("vol_out", `(i32.add (i32.and (i32.sub (i32.const 0x200) ${sl("volume")}) (i32.const ${MAX_ATT})) ${sl("tl")})`)})
      (else ${sst("vol_out", `(i32.add ${sl("volume")} ${sl("tl")})`)}))`;
  const volOutInv = `(if (i32.xor ${sl("ssgn")} (i32.and ${sl("ssg")} (i32.const 4)))
      (then ${sst("vol_out", `(i32.add (i32.and (i32.sub (i32.const 0x200) ${sl("volume")}) (i32.const ${MAX_ATT})) ${sl("tl")})`)})
      (else ${sst("vol_out", `(i32.add ${sl("volume")} ${sl("tl")})`)}))`;
  const decOrSus = `(select (i32.const ${EG_SUS}) (i32.const ${EG_DEC}) (i32.eqz ${sl("sl")}))`;
  const rate = (sh, sel, idx) => `${sst(sh, `(i32.load8_u (i32.add (i32.const ${L.EGSH}) ${idx}))`)}
    ${sst(sel, `(i32.load8_u (i32.add (i32.const ${L.EGSEL}) ${idx}))`)}`;
  const arRate = (kc) => `(if (i32.lt_u (i32.add ${sl("ar")} ${kc}) (i32.const 94))
      (then ${rate("sh_ar", "sel_ar", `(i32.add ${sl("ar")} ${kc})`)})
      (else ${sst("sh_ar", "(i32.const 0)")} ${sst("sel_ar", "(i32.const 144)")}))`;
  // FM_KEYON / FM_KEYON_CSM body (restart PG, EG to attack/decay/sustain)
  const keyonBody = `
    ${sst("phase", "(i32.const 0)")}
    ${sst("ssgn", "(i32.const 0)")}
    (if (i32.lt_u (i32.add ${sl("ar")} ${sl("ksr")}) (i32.const 94))
      (then ${sst("state", `(select (i32.const ${EG_ATT}) ${decOrSus} (i32.gt_s ${sl("volume")} (i32.const 0)))`)})
      (else ${sst("volume", "(i32.const 0)")} ${sst("state", decOrSus)}))
    ${volOut()}`;
  const keyoffBody = `
    (if (i32.gt_u ${sl("state")} (i32.const ${EG_REL}))
      (then
        ${sst("state", `(i32.const ${EG_REL})`)}
        (if (i32.and ${sl("ssg")} (i32.const 8))
          (then
            (if (i32.xor ${sl("ssgn")} (i32.and ${sl("ssg")} (i32.const 4)))
              (then ${sst("volume", `(i32.and (i32.sub (i32.const 0x200) ${sl("volume")}) (i32.const ${MAX_ATT}))`)}))
            (if (i32.ge_s ${sl("volume")} (i32.const 0x200))
              (then ${sst("volume", `(i32.const ${MAX_ATT})`)} ${sst("state", `(i32.const ${EG_OFF})`)}))
            ${sst("vol_out", `(i32.add ${sl("volume")} ${sl("tl")})`)}))))`;
  const ch2 = ch(2);
  const csm4 = (fn) => [1, 2, 3, 4].map((n) => `(call ${fn} (i32.const ${slotOf(ch2, n)}))`).join(" ");

  // advance_eg_channels, one slot
  const egStep = (shF, selF) => `(i32.load8_u (i32.add (i32.const ${L.EGINC}) (i32.add ${sl(selF)} (i32.and (i32.shr_u (local.get $cnt) ${sl(shF)}) (i32.const 7)))))`;
  const egDue = (shF) => `(i32.eqz (i32.and (local.get $cnt) (i32.sub (i32.shl (i32.const 1) ${sl(shF)}) (i32.const 1))))`;
  const ssgDecay = (shF, selF) => `
          (if (i32.and ${sl("ssg")} (i32.const 8))
            (then
              (if (i32.lt_s ${sl("volume")} (i32.const 0x200))
                (then ${sst("volume", `(i32.add ${sl("volume")} (i32.shl ${egStep(shF, selF)} (i32.const 2)))`)}
                      ${volOutInv}))`;

  const slots = [];
  for (let c = 0; c < 6; c++) for (let s = 0; s < 4; s++) slots.push(ch(c) + s * SLSZ);
  const onAll = (fn, extra = "") => slots.map((a) => `(call ${fn} (i32.const ${a})${extra})`).join("\n      ");

  // op_calc / op_calc1
  const opCalc = (phase, env, pm, mask) => `(call $op_calc ${phase} ${env} ${pm} ${mask})`;

  // chan_calc for one channel (runtime base)
  const volCalc = (slot) => `(i32.add ${ld(slot, S.vol_out)} (i32.and (local.get $am) ${ld(slot, S.AMmask)}))`;
  const chanCalc = `
  (func $chan_calc (param $c i32)
    (local $am i32) (local $eg i32) (local $out i32) (local $mask i32) (local $s1 i32) (local $s2 i32) (local $s3 i32) (local $s4 i32)
    (local.set $s1 (local.get $c))
    (local.set $s3 (i32.add (local.get $c) (i32.const ${SLSZ})))
    (local.set $s2 (i32.add (local.get $c) (i32.const ${2 * SLSZ})))
    (local.set $s4 (i32.add (local.get $c) (i32.const ${3 * SLSZ})))
    (local.set $am (i32.shr_u (global.get $lfo_am) ${ld("(local.get $c)", C.ams)}))
    (local.set $eg ${volCalc("(local.get $s1)")})
    (local.set $mask (i32.add (i32.const ${L.OPMASK}) (i32.shl ${ld("(local.get $c)", C.ALGO)} (i32.const 4))))
    (i32.store (i32.const ${W.m2}) (i32.const 0)) (i32.store (i32.const ${W.c1}) (i32.const 0))
    (i32.store (i32.const ${W.c2}) (i32.const 0)) (i32.store (i32.const ${W.mem}) (i32.const 0))
    (i32.store ${ld("(local.get $c)", C.memc)} ${ld("(local.get $c)", C.memv)})
    (if (i32.lt_u (local.get $eg) (i32.const ${ENV_QUIET}))
      (then
        (if (i32.lt_u ${ld("(local.get $c)", C.FB)} (i32.const 10))
          (then (local.set $out (i32.shr_s (i32.add ${ld("(local.get $c)", C.op1a)} ${ld("(local.get $c)", C.op1b)}) ${ld("(local.get $c)", C.FB)}))))
        (local.set $out (call $op_calc1 ${ld("(local.get $s1)", S.phase)} (local.get $eg) (local.get $out) (i32.load (local.get $mask))))))
    ${st("(local.get $c)", C.op1a, ld("(local.get $c)", C.op1b))}
    ${st("(local.get $c)", C.op1b, "(local.get $out)")}
    (if (i32.eqz ${ld("(local.get $c)", C.conn1)})
      (then (i32.store (i32.const ${W.mem}) (local.get $out)) (i32.store (i32.const ${W.c1}) (local.get $out)) (i32.store (i32.const ${W.c2}) (local.get $out)))
      (else (i32.store ${ld("(local.get $c)", C.conn1)} (local.get $out))))
    (local.set $eg ${volCalc("(local.get $s3)")})
    (if (i32.lt_u (local.get $eg) (i32.const ${ENV_QUIET}))
      (then (i32.store ${ld("(local.get $c)", C.conn3)} (i32.add (i32.load ${ld("(local.get $c)", C.conn3)})
        ${opCalc(ld("(local.get $s3)", S.phase), "(local.get $eg)", `(i32.load (i32.const ${W.m2}))`, "(i32.load offset=8 (local.get $mask))")}))))
    (local.set $eg ${volCalc("(local.get $s2)")})
    (if (i32.lt_u (local.get $eg) (i32.const ${ENV_QUIET}))
      (then (i32.store ${ld("(local.get $c)", C.conn2)} (i32.add (i32.load ${ld("(local.get $c)", C.conn2)})
        ${opCalc(ld("(local.get $s2)", S.phase), "(local.get $eg)", `(i32.load (i32.const ${W.c1}))`, "(i32.load offset=4 (local.get $mask))")}))))
    (local.set $eg ${volCalc("(local.get $s4)")})
    (if (i32.lt_u (local.get $eg) (i32.const ${ENV_QUIET}))
      (then (i32.store ${ld("(local.get $c)", C.conn4)} (i32.add (i32.load ${ld("(local.get $c)", C.conn4)})
        ${opCalc(ld("(local.get $s4)", S.phase), "(local.get $eg)", `(i32.load (i32.const ${W.c2}))`, "(i32.load offset=12 (local.get $mask))")}))))
    ${st("(local.get $c)", C.memv, `(i32.load (i32.const ${W.mem}))`)}
    ;; phase counters AFTER the output
    (if ${ld("(local.get $c)", C.pms)}
      (then
        (if (i32.and (i32.ne (i32.and (global.get $ym_mode) (i32.const 0xC0)) (i32.const 0)) (i32.eq (local.get $c) (i32.const ${ch2})))
          (then
            ;; 3-slot mode: each operator has its own fnum (operator order 0,1,3,2)
            (call $lfo_slot (local.get $s1) (i32.add ${ld(`(i32.const ${ch2})`, C.pms)} (global.get $lfo_pm)) ${ld(`(i32.const ${ch2})`, C.kcode)} (i32.load (i32.const ${L.SL3 + 24 + 4})))
            (call $lfo_slot (local.get $s2) (i32.add ${ld(`(i32.const ${ch2})`, C.pms)} (global.get $lfo_pm)) ${ld(`(i32.const ${ch2})`, C.kcode)} (i32.load (i32.const ${L.SL3 + 24 + 8})))
            (call $lfo_slot (local.get $s3) (i32.add ${ld(`(i32.const ${ch2})`, C.pms)} (global.get $lfo_pm)) ${ld(`(i32.const ${ch2})`, C.kcode)} (i32.load (i32.const ${L.SL3 + 24})))
            (call $lfo_slot (local.get $s4) (i32.add ${ld(`(i32.const ${ch2})`, C.pms)} (global.get $lfo_pm)) ${ld(`(i32.const ${ch2})`, C.kcode)} ${ld(`(i32.const ${ch2})`, C.block_fnum)}))
          (else (call $lfo_chan (local.get $c)))))
      (else
        ${["$s1", "$s2", "$s3", "$s4"].map((s) => st(`(local.get ${s})`, S.phase, `(i32.add ${ld(`(local.get ${s})`, S.phase)} ${ld(`(local.get ${s})`, S.Incr)})`)).join("\n        ")})))
`;

  // OPNWriteReg
  const writeReg = `
  (func $ym_reg (param $r i32) (param $v i32)
    (local $c i32) (local $ch i32) (local $s i32) (local $fn i32) (local $blk i32) (local $old i32)
    (local.set $c (i32.and (local.get $r) (i32.const 3)))
    (if (i32.eq (local.get $c) (i32.const 3)) (then (return)))
    (if (i32.ge_u (local.get $r) (i32.const 0x100)) (then (local.set $c (i32.add (local.get $c) (i32.const 3)))))
    (local.set $ch (i32.add (i32.const ${L.CH}) (i32.mul (local.get $c) (i32.const ${CHSZ}))))
    (local.set $s (i32.add (local.get $ch) (i32.mul (i32.and (i32.shr_u (local.get $r) (i32.const 2)) (i32.const 3)) (i32.const ${SLSZ}))))
    (block $done
    ;; 0x30 DET, MUL
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0x30))
      (then
        ${sst("mul", "(select (i32.shl (i32.and (local.get $v) (i32.const 15)) (i32.const 1)) (i32.const 1) (i32.and (local.get $v) (i32.const 15)))")}
        ${sst("DT", `(i32.add (i32.const ${L.DT}) (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const 4)) (i32.const 7)) (i32.const 7)))`)}
        ${st("(local.get $ch)", S.Incr, "(i32.const -1)")}
        (br $done)))
    ;; 0x40 TL
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0x40))
      (then
        ${sst("tl", "(i32.shl (i32.and (local.get $v) (i32.const 0x7f)) (i32.const 3))")}
        ${volOut(`(i32.gt_u ${sl("state")} (i32.const ${EG_REL}))`)}
        (br $done)))
    ;; 0x50 KS, AR
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0x50))
      (then
        (local.set $old ${sl("KSR")})
        ${sst("ar", "(select (i32.add (i32.const 32) (i32.shl (i32.and (local.get $v) (i32.const 0x1f)) (i32.const 1))) (i32.const 0) (i32.and (local.get $v) (i32.const 0x1f)))")}
        ${sst("KSR", "(i32.sub (i32.const 3) (i32.shr_u (local.get $v) (i32.const 6)))")}
        (if (i32.ne ${sl("KSR")} (local.get $old)) (then ${st("(local.get $ch)", S.Incr, "(i32.const -1)")}))
        ${arRate(sl("ksr"))}
        (br $done)))
    ;; 0x60 AM, DR
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0x60))
      (then
        ${sst("d1r", "(select (i32.add (i32.const 32) (i32.shl (i32.and (local.get $v) (i32.const 0x1f)) (i32.const 1))) (i32.const 0) (i32.and (local.get $v) (i32.const 0x1f)))")}
        ${rate("sh_d1r", "sel_d1r", `(i32.add ${sl("d1r")} ${sl("ksr")})`)}
        ${sst("AMmask", "(select (i32.const -1) (i32.const 0) (i32.and (local.get $v) (i32.const 0x80)))")}
        (br $done)))
    ;; 0x70 SR
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0x70))
      (then
        ${sst("d2r", "(select (i32.add (i32.const 32) (i32.shl (i32.and (local.get $v) (i32.const 0x1f)) (i32.const 1))) (i32.const 0) (i32.and (local.get $v) (i32.const 0x1f)))")}
        ${rate("sh_d2r", "sel_d2r", `(i32.add ${sl("d2r")} ${sl("ksr")})`)}
        (br $done)))
    ;; 0x80 SL, RR
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0x80))
      (then
        ${sst("sl", `(i32.load (i32.add (i32.const ${L.SL}) (i32.shl (i32.shr_u (local.get $v) (i32.const 4)) (i32.const 2))))`)}
        (if (i32.and (i32.eq ${sl("state")} (i32.const ${EG_DEC})) (i32.ge_s ${sl("volume")} ${sl("sl")}))
          (then ${sst("state", `(i32.const ${EG_SUS})`)}))
        ${sst("rr", "(i32.add (i32.const 34) (i32.shl (i32.and (local.get $v) (i32.const 15)) (i32.const 2)))")}
        ${rate("sh_rr", "sel_rr", `(i32.add ${sl("rr")} ${sl("ksr")})`)}
        (br $done)))
    ;; 0x90 SSG-EG
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0x90))
      (then
        ${sst("ssg", "(i32.and (local.get $v) (i32.const 15))")}
        (if (i32.gt_u ${sl("state")} (i32.const ${EG_REL})) (then ${volOut()}))
        (br $done)))
    ;; 0xa0-0xae
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0xa0))
      (then
        (block $a
        (if (i32.eqz (i32.and (i32.shr_u (local.get $r) (i32.const 2)) (i32.const 3)))
          (then
            ;; FNUM1: latch fn_h, keyscale code, fc, block_fnum
            (local.set $fn (i32.add (i32.shl (i32.and (global.get $ym_fnh) (i32.const 7)) (i32.const 8)) (local.get $v)))
            (local.set $blk (i32.shr_u (global.get $ym_fnh) (i32.const 3)))
            ${st("(local.get $ch)", C.kcode, `(i32.or (i32.shl (local.get $blk) (i32.const 2)) (i32.load8_u (i32.add (i32.const ${L.FKT}) (i32.shr_u (local.get $fn) (i32.const 7)))))`)}
            ${st("(local.get $ch)", C.fc, "(i32.shr_u (i32.shl (local.get $fn) (local.get $blk)) (i32.const 1))")}
            ${st("(local.get $ch)", C.block_fnum, "(i32.or (i32.shl (local.get $blk) (i32.const 11)) (local.get $fn))")}
            ${st("(local.get $ch)", S.Incr, "(i32.const -1)")}
            (br $a)))
        (if (i32.eq (i32.and (i32.shr_u (local.get $r) (i32.const 2)) (i32.const 3)) (i32.const 1))
          (then (global.set $ym_fnh (i32.and (local.get $v) (i32.const 0x3f))) (br $a)))
        (if (i32.eq (i32.and (i32.shr_u (local.get $r) (i32.const 2)) (i32.const 3)) (i32.const 2))
          (then
            (if (i32.lt_u (local.get $r) (i32.const 0x100))
              (then
                (local.set $fn (i32.add (i32.shl (i32.and (global.get $sl3_fnh) (i32.const 7)) (i32.const 8)) (local.get $v)))
                (local.set $blk (i32.shr_u (global.get $sl3_fnh) (i32.const 3)))
                (i32.store (i32.add (i32.const ${L.SL3 + 12}) (i32.shl (local.get $c) (i32.const 2)))
                  (i32.or (i32.shl (local.get $blk) (i32.const 2)) (i32.load8_u (i32.add (i32.const ${L.FKT}) (i32.shr_u (local.get $fn) (i32.const 7))))))
                (i32.store (i32.add (i32.const ${L.SL3}) (i32.shl (local.get $c) (i32.const 2)))
                  (i32.shr_u (i32.shl (local.get $fn) (local.get $blk)) (i32.const 1)))
                (i32.store (i32.add (i32.const ${L.SL3 + 24}) (i32.shl (local.get $c) (i32.const 2)))
                  (i32.or (i32.shl (local.get $blk) (i32.const 11)) (local.get $fn)))
                ${st(`(i32.const ${ch2})`, S.Incr, "(i32.const -1)")}))
            (br $a)))
        (if (i32.lt_u (local.get $r) (i32.const 0x100))
          (then (global.set $sl3_fnh (i32.and (local.get $v) (i32.const 0x3f))))))
        (br $done)))
    ;; 0xb0-0xb6
    (if (i32.eq (i32.and (local.get $r) (i32.const 0xf0)) (i32.const 0xb0))
      (then
        (if (i32.eqz (i32.and (i32.shr_u (local.get $r) (i32.const 2)) (i32.const 3)))
          (then
            ${st("(local.get $ch)", C.ALGO, "(i32.and (local.get $v) (i32.const 7))")}
            ${st("(local.get $ch)", C.FB, "(i32.sub (i32.const 10) (i32.and (i32.shr_u (local.get $v) (i32.const 3)) (i32.const 7)))")}
            (call $setup_connection (local.get $ch) (local.get $c))))
        (if (i32.eq (i32.and (i32.shr_u (local.get $r) (i32.const 2)) (i32.const 3)) (i32.const 1))
          (then
            ${st("(local.get $ch)", C.pms, "(i32.shl (i32.and (local.get $v) (i32.const 7)) (i32.const 5))")}
            ${st("(local.get $ch)", C.ams, `(i32.load8_u (i32.add (i32.const ${L.AMSSH}) (i32.and (i32.shr_u (local.get $v) (i32.const 4)) (i32.const 3))))`)}
            (i32.store (i32.add (i32.const ${L.PAN}) (i32.shl (local.get $c) (i32.const 3))) (select (i32.const -1) (i32.const 0) (i32.and (local.get $v) (i32.const 0x80))))
            (i32.store offset=4 (i32.add (i32.const ${L.PAN}) (i32.shl (local.get $c) (i32.const 3))) (select (i32.const -1) (i32.const 0) (i32.and (local.get $v) (i32.const 0x40)))))))))
  )
`;

  // setup_connection
  const conns = [
    [W.c1, W.c2, W.mem, W.m2], // om1(conn1), om2(conn3), oc1(conn2), memc
    [W.mem, W.c2, W.mem, W.m2],
    [W.c2, W.c2, W.mem, W.m2],
    [W.c1, W.c2, W.mem, W.c2],
    [W.c1, W.c2, "carrier", W.mem],
    [0, "carrier", "carrier", W.m2],
    [W.c1, "carrier", "carrier", W.mem],
    ["carrier", "carrier", "carrier", W.mem],
  ];
  const cv = (x) => (x === "carrier" ? "(local.get $car)" : `(i32.const ${x})`);
  const setupConn = `
  (func $setup_connection (param $ch i32) (param $c i32)
    (local $car i32) (local $a i32)
    (local.set $car (i32.add (i32.const ${W.out}) (i32.shl (local.get $c) (i32.const 2))))
    (local.set $a ${ld("(local.get $ch)", C.ALGO)})
${conns.map(([c1, c3, c2, mc], i) => `    (if (i32.eq (local.get $a) (i32.const ${i}))
      (then ${st("(local.get $ch)", C.conn1, cv(c1))} ${st("(local.get $ch)", C.conn3, cv(c3))} ${st("(local.get $ch)", C.conn2, cv(c2))} ${st("(local.get $ch)", C.memc, cv(mc))}))`).join("\n")}
    ${st("(local.get $ch)", C.conn4, "(local.get $car)")})
`;

  // refresh_fc_eg_slot
  const refreshSlot = `
  (func $refresh_slot (param $s i32) (param $fc i32) (param $kc i32)
    (local.set $fc (i32.and (i32.add (local.get $fc) (i32.load (i32.add ${sl("DT")} (i32.shl (local.get $kc) (i32.const 2))))) (i32.const ${DT_MASK})))
    ${sst("Incr", `(i32.shr_u (i32.mul (local.get $fc) ${sl("mul")}) (i32.const 1))`)}
    (local.set $kc (i32.shr_u (local.get $kc) ${sl("KSR")}))
    (if (i32.ne ${sl("ksr")} (local.get $kc))
      (then
        ${sst("ksr", "(local.get $kc)")}
        ${arRate("(local.get $kc)")}
        ${rate("sh_d1r", "sel_d1r", `(i32.add ${sl("d1r")} (local.get $kc))`)}
        ${rate("sh_d2r", "sel_d2r", `(i32.add ${sl("d2r")} (local.get $kc))`)}
        ${rate("sh_rr", "sel_rr", `(i32.add ${sl("rr")} (local.get $kc))`)})))
  (func $refresh_chan (param $c i32)
    (if (i32.eq ${ld("(local.get $c)", S.Incr)} (i32.const -1))
      (then
        (call $refresh_slot (local.get $c) ${ld("(local.get $c)", C.fc)} ${ld("(local.get $c)", C.kcode)})
        (call $refresh_slot (i32.add (local.get $c) (i32.const ${2 * SLSZ})) ${ld("(local.get $c)", C.fc)} ${ld("(local.get $c)", C.kcode)})
        (call $refresh_slot (i32.add (local.get $c) (i32.const ${SLSZ})) ${ld("(local.get $c)", C.fc)} ${ld("(local.get $c)", C.kcode)})
        (call $refresh_slot (i32.add (local.get $c) (i32.const ${3 * SLSZ})) ${ld("(local.get $c)", C.fc)} ${ld("(local.get $c)", C.kcode)}))))
`;

  // update_phase_lfo_slot / _channel
  const lfo = `
  (func $lfo_slot (param $s i32) (param $pm i32) (param $kc i32) (param $fc i32)
    (local $off i32) (local $blk i32)
    (local.set $off (i32.load8_s (i32.add (i32.const ${L.LFOPM}) (i32.add (i32.shl (i32.and (local.get $fc) (i32.const 0x7f0)) (i32.const 4)) (local.get $pm)))))
    (if (local.get $off)
      (then
        (local.set $blk (i32.and (i32.shr_u (local.get $fc) (i32.const 11)) (i32.const 0xFF)))
        (local.set $fc (i32.and (i32.add (i32.shl (local.get $fc) (i32.const 1)) (local.get $off)) (i32.const 0xfff)))
        (local.set $fc (i32.and (i32.add (i32.shr_u (i32.shl (local.get $fc) (local.get $blk)) (i32.const 2))
          (i32.load (i32.add ${sl("DT")} (i32.shl (local.get $kc) (i32.const 2))))) (i32.const ${DT_MASK})))
        ${sst("phase", `(i32.add ${sl("phase")} (i32.shr_u (i32.mul (local.get $fc) ${sl("mul")}) (i32.const 1)))`)})
      (else ${sst("phase", `(i32.add ${sl("phase")} ${sl("Incr")})`)})))
  (func $lfo_chan (param $c i32)
    (local $fc i32) (local $off i32) (local $blk i32) (local $kc i32) (local $s i32) (local $i i32)
    (local.set $fc ${ld("(local.get $c)", C.block_fnum)})
    (local.set $off (i32.load8_s (i32.add (i32.const ${L.LFOPM}) (i32.add (i32.add (i32.shl (i32.and (local.get $fc) (i32.const 0x7f0)) (i32.const 4)) ${ld("(local.get $c)", C.pms)}) (global.get $lfo_pm)))))
    (if (local.get $off)
      (then
        (local.set $blk (i32.and (i32.shr_u (local.get $fc) (i32.const 11)) (i32.const 0xFF)))
        (local.set $kc ${ld("(local.get $c)", C.kcode)})
        (local.set $fc (i32.and (i32.add (i32.shl (local.get $fc) (i32.const 1)) (local.get $off)) (i32.const 0xfff)))
        (local.set $fc (i32.shr_u (i32.shl (local.get $fc) (local.get $blk)) (i32.const 2)))
        (block $d (loop $l
          (br_if $d (i32.ge_u (local.get $i) (i32.const 4)))
          (local.set $s (i32.add (local.get $c) (i32.mul (local.get $i) (i32.const ${SLSZ}))))
          ${sst("phase", `(i32.add ${sl("phase")} (i32.shr_u (i32.mul (i32.and (i32.add (local.get $fc) (i32.load (i32.add ${sl("DT")} (i32.shl (local.get $kc) (i32.const 2))))) (i32.const ${DT_MASK})) ${sl("mul")}) (i32.const 1)))`)}
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l))))
      (else
        (block $d2 (loop $l2
          (br_if $d2 (i32.ge_u (local.get $i) (i32.const 4)))
          (local.set $s (i32.add (local.get $c) (i32.mul (local.get $i) (i32.const ${SLSZ}))))
          ${sst("phase", `(i32.add ${sl("phase")} ${sl("Incr")})`)}
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l2))))))
`;

  // op_calc / op_calc1
  const ops = `
  (func $op_calc (param $phase i32) (param $env i32) (param $pm i32) (param $mask i32) (result i32)
    (local $p i32)
    (local.set $p (i32.add (i32.shl (local.get $env) (i32.const 3))
      (i32.load16_u (i32.add (i32.const ${L.SIN}) (i32.shl (i32.and (i32.add (i32.shr_u (local.get $phase) (i32.const 10)) (i32.shr_u (local.get $pm) (i32.const 1))) (i32.const 1023)) (i32.const 1))))))
    (if (i32.ge_u (local.get $p) (i32.const ${TL_TAB_LEN})) (then (return (i32.const 0))))
    (i32.and (i32.load16_s (i32.add (i32.const ${L.TL}) (i32.shl (local.get $p) (i32.const 1)))) (local.get $mask)))
  (func $op_calc1 (param $phase i32) (param $env i32) (param $pm i32) (param $mask i32) (result i32)
    (local $p i32)
    (local.set $p (i32.add (i32.shl (local.get $env) (i32.const 3))
      (i32.load16_u (i32.add (i32.const ${L.SIN}) (i32.shl (i32.and (i32.add (i32.shr_u (local.get $phase) (i32.const 10)) (local.get $pm)) (i32.const 1023)) (i32.const 1))))))
    (if (i32.ge_u (local.get $p) (i32.const ${TL_TAB_LEN})) (then (return (i32.const 0))))
    (i32.and (i32.load16_s (i32.add (i32.const ${L.TL}) (i32.shl (local.get $p) (i32.const 1)))) (local.get $mask)))
`;

  // key on/off, SSG-EG, EG
  const keys = `
  (func $keyon (param $s i32)
    (if (i32.and (i32.eqz ${sl("key")}) (i32.eqz (global.get $key_csm)))
      (then ${keyonBody}))
    ${sst("key", "(i32.const 1)")})
  (func $keyoff (param $s i32)
    (if (i32.and (i32.ne ${sl("key")} (i32.const 0)) (i32.eqz (global.get $key_csm)))
      (then ${keyoffBody}))
    ${sst("key", "(i32.const 0)")})
  (func $keyon_csm (param $s i32)
    (if (i32.and (i32.eqz ${sl("key")}) (i32.eqz (global.get $key_csm)))
      (then ${keyonBody})))
  (func $keyoff_csm (param $s i32)
    (if (i32.eqz ${sl("key")})
      (then ${keyoffBody})))
  (func $ssg_slot (param $s i32)
    (if (i32.and (i32.and (i32.ne (i32.and ${sl("ssg")} (i32.const 8)) (i32.const 0)) (i32.ge_s ${sl("volume")} (i32.const 0x200)))
                 (i32.gt_u ${sl("state")} (i32.const ${EG_REL})))
      (then
        (if (i32.and ${sl("ssg")} (i32.const 1))
          (then
            (if (i32.and ${sl("ssg")} (i32.const 2)) (then ${sst("ssgn", "(i32.const 4)")}))
            (if (i32.and (i32.ne ${sl("state")} (i32.const ${EG_ATT})) (i32.eqz (i32.xor ${sl("ssgn")} (i32.and ${sl("ssg")} (i32.const 4)))))
              (then ${sst("volume", `(i32.const ${MAX_ATT})`)})))
          (else
            (if (i32.and ${sl("ssg")} (i32.const 2))
              (then ${sst("ssgn", `(i32.xor ${sl("ssgn")} (i32.const 4))`)})
              (else ${sst("phase", "(i32.const 0)")}))
            (if (i32.ne ${sl("state")} (i32.const ${EG_ATT}))
              (then
                (if (i32.lt_u (i32.add ${sl("ar")} ${sl("ksr")}) (i32.const 94))
                  (then ${sst("state", `(select (i32.const ${EG_ATT}) ${decOrSus} (i32.gt_s ${sl("volume")} (i32.const 0)))`)})
                  (else ${sst("volume", "(i32.const 0)")} ${sst("state", decOrSus)}))))))
        ${volOutInv})))
  (func $eg_slot (param $s i32) (param $cnt i32)
    (local $st i32)
    (local.set $st ${sl("state")})
    (if (i32.eq (local.get $st) (i32.const ${EG_ATT}))
      (then
        (if ${egDue("sh_ar")}
          (then
            ${sst("volume", `(i32.add ${sl("volume")} (i32.shr_s (i32.mul (i32.xor ${sl("volume")} (i32.const -1)) ${egStep("sh_ar", "sel_ar")}) (i32.const 4)))`)}
            (if (i32.le_s ${sl("volume")} (i32.const 0))
              (then ${sst("volume", "(i32.const 0)")} ${sst("state", decOrSus)}))
            ${volOut()}))
        (return)))
    (if (i32.eq (local.get $st) (i32.const ${EG_DEC}))
      (then
        (if ${egDue("sh_d1r")}
          (then${ssgDecay("sh_d1r", "sel_d1r")})
            (else
              ${sst("volume", `(i32.add ${sl("volume")} ${egStep("sh_d1r", "sel_d1r")})`)}
              ${sst("vol_out", `(i32.add ${sl("volume")} ${sl("tl")})`)}))
            (if (i32.ge_s ${sl("volume")} ${sl("sl")}) (then ${sst("state", `(i32.const ${EG_SUS})`)}))))
        (return)))
    (if (i32.eq (local.get $st) (i32.const ${EG_SUS}))
      (then
        (if ${egDue("sh_d2r")}
          (then${ssgDecay("sh_d2r", "sel_d2r")})
            (else
              ${sst("volume", `(i32.add ${sl("volume")} ${egStep("sh_d2r", "sel_d2r")})`)}
              (if (i32.ge_s ${sl("volume")} (i32.const ${MAX_ATT})) (then ${sst("volume", `(i32.const ${MAX_ATT})`)}))
              ${sst("vol_out", `(i32.add ${sl("volume")} ${sl("tl")})`)}))))
        (return)))
    (if (i32.eq (local.get $st) (i32.const ${EG_REL}))
      (then
        (if ${egDue("sh_rr")}
          (then
            (if (i32.and ${sl("ssg")} (i32.const 8))
              (then
                (if (i32.lt_s ${sl("volume")} (i32.const 0x200))
                  (then ${sst("volume", `(i32.add ${sl("volume")} (i32.shl ${egStep("sh_rr", "sel_rr")} (i32.const 2)))`)}))
                (if (i32.ge_s ${sl("volume")} (i32.const 0x200))
                  (then ${sst("volume", `(i32.const ${MAX_ATT})`)} ${sst("state", `(i32.const ${EG_OFF})`)})))
              (else
                ${sst("volume", `(i32.add ${sl("volume")} ${egStep("sh_rr", "sel_rr")})`)}
                (if (i32.ge_s ${sl("volume")} (i32.const ${MAX_ATT}))
                  (then ${sst("volume", `(i32.const ${MAX_ATT})`)} ${sst("state", `(i32.const ${EG_OFF})`)}))))
            ${sst("vol_out", `(i32.add ${sl("volume")} ${sl("tl")})`)})))))
`;

  // YM2612Update into sound.c's fm_buffer (flushed by $md_fm_flush).
  const outs = [0, 1, 2, 3, 4, 5].map((i) => `(i32.load (i32.const ${W.out + 4 * i}))`);
  const clip = [0, 1, 2, 3, 4, 5].map((i) => `
      (local.set $o (i32.load (i32.const ${W.out + 4 * i})))
      (if (i32.gt_s (local.get $o) (i32.const 8191)) (then (local.set $o (i32.const 8191)))
        (else (if (i32.lt_s (local.get $o) (i32.const -8192)) (then (local.set $o (i32.const -8192))))))
      (if (i32.and (i32.load16_u (i32.const ${MUTE})) (i32.const ${1 << i})) (then (local.set $o (i32.const 0))))
      (i32.store (i32.const ${W.out + 4 * i}) (local.get $o))
      (local.set $lt (i32.add (local.get $lt) (i32.and (local.get $o) (i32.load (i32.const ${L.PAN + 8 * i})))))
      (local.set $rt (i32.add (local.get $rt) (i32.and (local.get $o) (i32.load (i32.const ${L.PAN + 8 * i + 4})))))`).join("");
  const ladder = [0, 1, 2, 3, 4, 5].map((i) => `
      (if (i32.lt_s ${outs[i]} (i32.const 0))
        (then (local.set $lt (i32.sub (local.get $lt) (i32.shl (i32.sub (i32.const 4) (i32.and (i32.load (i32.const ${L.PAN + 8 * i})) (i32.const 1))) (i32.const 5))))
              (local.set $rt (i32.sub (local.get $rt) (i32.shl (i32.sub (i32.const 4) (i32.and (i32.load (i32.const ${L.PAN + 8 * i + 4})) (i32.const 1))) (i32.const 5)))))
        (else (local.set $lt (i32.add (local.get $lt) (i32.const 128))) (local.set $rt (i32.add (local.get $rt) (i32.const 128)))))`).join("");
  const render = `
  (func $ym_render (param $n i32)
    (local $i i32) (local $lt i32) (local $rt i32) (local $o i32)
    (call $refresh_chan (i32.const ${ch(0)}))
    (call $refresh_chan (i32.const ${ch(1)}))
    (if (i32.eqz (i32.and (global.get $ym_mode) (i32.const 0xC0)))
      (then (call $refresh_chan (i32.const ${ch2})))
      (else
        (if (i32.eq ${ld(`(i32.const ${ch2})`, S.Incr)} (i32.const -1))
          (then
            (call $refresh_slot (i32.const ${slotOf(ch2, 1)}) (i32.load (i32.const ${L.SL3 + 4})) (i32.load (i32.const ${L.SL3 + 16})))
            (call $refresh_slot (i32.const ${slotOf(ch2, 2)}) (i32.load (i32.const ${L.SL3 + 8})) (i32.load (i32.const ${L.SL3 + 20})))
            (call $refresh_slot (i32.const ${slotOf(ch2, 3)}) (i32.load (i32.const ${L.SL3})) (i32.load (i32.const ${L.SL3 + 12})))
            (call $refresh_slot (i32.const ${slotOf(ch2, 4)}) ${ld(`(i32.const ${ch2})`, C.fc)} ${ld(`(i32.const ${ch2})`, C.kcode)})))))
    (call $refresh_chan (i32.const ${ch(3)}))
    (call $refresh_chan (i32.const ${ch(4)}))
    (call $refresh_chan (i32.const ${ch(5)}))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
      (memory.fill (i32.const ${W.out}) (i32.const 0) (i32.const 24))
      ${onAll("$ssg_slot")}
      (if (i32.eqz (global.get $ym_dacen))
        (then ${[0, 1, 2, 3, 4, 5].map((c) => `(call $chan_calc (i32.const ${ch(c)}))`).join(" ")})
        (else (i32.store (i32.const ${W.out + 20}) (global.get $ym_dacout))
              ${[0, 1, 2, 3, 4].map((c) => `(call $chan_calc (i32.const ${ch(c)}))`).join(" ")}))
      ;; advance_lfo
      (if (global.get $lfo_ovf)
        (then
          (global.set $lfo_timer (i32.add (global.get $lfo_timer) (i32.const 1)))
          (if (i32.ge_u (global.get $lfo_timer) (global.get $lfo_ovf))
            (then
              (global.set $lfo_timer (i32.const 0))
              (global.set $lfo_cnt (i32.and (i32.add (global.get $lfo_cnt) (i32.const 1)) (i32.const 127)))
              (global.set $lfo_am (select (i32.shl (i32.xor (global.get $lfo_cnt) (i32.const 63)) (i32.const 1))
                                          (i32.shl (i32.and (global.get $lfo_cnt) (i32.const 63)) (i32.const 1))
                                          (i32.lt_u (global.get $lfo_cnt) (i32.const 64))))
              (global.set $lfo_pm (i32.shr_u (global.get $lfo_cnt) (i32.const 2)))))))
      ;; EG every 3 samples; the 12-bit counter skips 0
      (global.set $eg_timer (i32.add (global.get $eg_timer) (i32.const 1)))
      (if (i32.ge_u (global.get $eg_timer) (i32.const 3))
        (then
          (global.set $eg_timer (i32.const 0))
          (global.set $eg_cnt (i32.add (global.get $eg_cnt) (i32.const 1)))
          (if (i32.eq (global.get $eg_cnt) (i32.const 4096)) (then (global.set $eg_cnt (i32.const 1))))
          ${onAll("$eg_slot", " (global.get $eg_cnt)")}))
      ;; 14-bit accumulator clip (muteMask bits 0-5 silence FM channels in the mix), pan, the discrete DAC ladder
      (local.set $lt (i32.const 0)) (local.set $rt (i32.const 0))${clip}${ladder}
      ;; fm_buffer (flushed into blip_buf at the frame end, see $md_fm_flush)
      (if (i32.lt_u (global.get $fm_ptr) (i32.const ${FMCAP}))
        (then (i32.store (i32.add (i32.const ${o.fmBuf}) (i32.shl (global.get $fm_ptr) (i32.const 3))) (local.get $lt))
              (i32.store offset=4 (i32.add (i32.const ${o.fmBuf}) (i32.shl (global.get $fm_ptr) (i32.const 3))) (local.get $rt))))
      (global.set $fm_ptr (i32.add (global.get $fm_ptr) (i32.const 1)))
      ;; CSM: key off unless timer A overflowed again
      (global.set $key_csm (i32.and (i32.shl (global.get $key_csm) (i32.const 1)) (i32.const 0xFF)))
      ;; INTERNAL_TIMER_A
      (if (i32.and (global.get $ym_mode) (i32.const 1))
        (then (global.set $ym_tac (i32.sub (global.get $ym_tac) (i32.const 1)))
              (if (i32.le_s (global.get $ym_tac) (i32.const 0))
                (then (if (i32.and (global.get $ym_mode) (i32.const 4))
                        (then (global.set $ym_status (i32.or (global.get $ym_status) (i32.const 1)))))
                      (global.set $ym_tac (global.get $ym_tal))
                      (if (i32.eq (i32.and (global.get $ym_mode) (i32.const 0xC0)) (i32.const 0x80))
                        (then ${csm4("$keyon_csm")} (global.set $key_csm (i32.const 1))))))))
      (if (i32.and (global.get $key_csm) (i32.const 2))
        (then ${csm4("$keyoff_csm")} (global.set $key_csm (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ;; INTERNAL_TIMER_B(length)
    (if (i32.and (global.get $ym_mode) (i32.const 2))
      (then (global.set $ym_tbc (i32.sub (global.get $ym_tbc) (local.get $n)))
            (if (i32.le_s (global.get $ym_tbc) (i32.const 0))
              (then (if (i32.and (global.get $ym_mode) (i32.const 8))
                      (then (global.set $ym_status (i32.or (global.get $ym_status) (i32.const 2)))))
                    (block $d2 (loop $l2
                      (global.set $ym_tbc (i32.add (global.get $ym_tbc) (global.get $ym_tbl)))
                      (br_if $l2 (i32.le_s (global.get $ym_tbc) (i32.const 0))))))))))
`;

  // YM2612Write (the OPN side; the timer registers stay in runtime.js)
  const write = `
  (func $ym_write (param $a i32) (param $v i32)
    (local $r i32)
    (if (i32.eqz (local.get $a)) (then (global.set $ym_address (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 2)) (then (global.set $ym_address (i32.or (local.get $v) (i32.const 0x100))) (return)))
    (local.set $r (global.get $ym_address))
    (if (i32.ne (i32.and (local.get $r) (i32.const 0x1f0)) (i32.const 0x20)) (then (call $ym_reg (local.get $r) (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x2a))
      (then (global.set $ym_dacout (i32.shl (i32.sub (local.get $v) (i32.const 0x80)) (i32.const 6))) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x2b)) (then (global.set $ym_dacen (i32.and (local.get $v) (i32.const 0x80))) (return)))
    ;; OPNWriteMode: 0x22 LFO, 0x28 key on/off (0x24-0x27: runtime.js)
    (if (i32.eq (local.get $r) (i32.const 0x22))
      (then
        (if (i32.and (local.get $v) (i32.const 8))
          (then (global.set $lfo_ovf (i32.load (i32.add (i32.const ${L.LFOSTEP}) (i32.shl (i32.and (local.get $v) (i32.const 7)) (i32.const 2))))))
          (else (global.set $lfo_ovf (i32.const 0)) (global.set $lfo_timer (i32.const 0)) (global.set $lfo_cnt (i32.const 0))
                (global.set $lfo_pm (i32.const 0)) (global.set $lfo_am (i32.const 126))))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 0x28)) (then (call $ym_key (local.get $v)))))
  (func $ym_key (param $v i32)
    (local $c i32) (local $ch i32)
    (local.set $c (i32.and (local.get $v) (i32.const 3)))
    (if (i32.eq (local.get $c) (i32.const 3)) (then (return)))
    (if (i32.and (local.get $v) (i32.const 4)) (then (local.set $c (i32.add (local.get $c) (i32.const 3)))))
    (local.set $ch (i32.add (i32.const ${L.CH}) (i32.mul (local.get $c) (i32.const ${CHSZ}))))
${[[0x10, 0], [0x20, 2], [0x40, 1], [0x80, 3]].map(([bit, idx]) => `    (if (i32.and (local.get $v) (i32.const ${bit}))
      (then (call $keyon (i32.add (local.get $ch) (i32.const ${idx * SLSZ}))))
      (else (call $keyoff (i32.add (local.get $ch) (i32.const ${idx * SLSZ})))))`).join("\n")})
  ;; set_timers' CSM / 3-slot part, before runtime.js's $ym_set_timers updates $ym_mode
  (func $ym_mode_w (param $v i32)
    (if (i32.and (i32.xor (global.get $ym_mode) (local.get $v)) (i32.const 0xC0))
      (then
        ${st(`(i32.const ${ch2})`, S.Incr, "(i32.const -1)")}
        (if (i32.and (i32.ne (i32.and (local.get $v) (i32.const 0xC0)) (i32.const 0x80)) (i32.ne (global.get $key_csm) (i32.const 0)))
          (then ${csm4("$keyoff_csm")} (global.set $key_csm (i32.const 0)))))))
  ;; YM2612ResetChip's OPN side (runtime.js resets the timers)
  (func $ym_reset
    (local $c i32) (local $s i32) (local $i i32)
    (global.set $eg_timer (i32.const 0)) (global.set $eg_cnt (i32.const 0))
    (global.set $lfo_ovf (i32.const 0)) (global.set $lfo_timer (i32.const 0)) (global.set $lfo_cnt (i32.const 0))
    (global.set $lfo_am (i32.const 126)) (global.set $lfo_pm (i32.const 0))
    (global.set $key_csm (i32.const 0)) (global.set $ym_dacen (i32.const 0)) (global.set $ym_dacout (i32.const 0))
    ;; reset_channels
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $c) (i32.const 6)))
      (local.set $s (i32.add (i32.const ${L.CH}) (i32.mul (local.get $c) (i32.const ${CHSZ}))))
      ${st("(local.get $s)", C.memv, "(i32.const 0)")} ${st("(local.get $s)", C.op1a, "(i32.const 0)")} ${st("(local.get $s)", C.op1b, "(i32.const 0)")}
      (local.set $i (i32.const 0))
      (block $d2 (loop $l2
        (br_if $d2 (i32.ge_u (local.get $i) (i32.const 4)))
        ${sst("Incr", "(i32.const -1)")} ${sst("key", "(i32.const 0)")} ${sst("phase", "(i32.const 0)")} ${sst("ssgn", "(i32.const 0)")}
        ${sst("state", `(i32.const ${EG_OFF})`)} ${sst("volume", `(i32.const ${MAX_ATT})`)} ${sst("vol_out", `(i32.const ${MAX_ATT})`)}
        (local.set $s (i32.add (local.get $s) (i32.const ${SLSZ})))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l2)))
      (local.set $c (i32.add (local.get $c) (i32.const 1)))
      (br $l)))
    (local.set $i (i32.const 0xb6))
    (block $d3 (loop $l3
      (br_if $d3 (i32.lt_u (local.get $i) (i32.const 0xb4)))
      (call $ym_reg (local.get $i) (i32.const 0xc0))
      (call $ym_reg (i32.or (local.get $i) (i32.const 0x100)) (i32.const 0xc0))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $l3)))
    (local.set $i (i32.const 0xb2))
    (block $d4 (loop $l4
      (br_if $d4 (i32.lt_u (local.get $i) (i32.const 0x30)))
      (call $ym_reg (local.get $i) (i32.const 0))
      (call $ym_reg (i32.or (local.get $i) (i32.const 0x100)) (i32.const 0))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $l4))))
`;

  const globals = [
    g("ym_address"), g("ym_fnh"), g("sl3_fnh"), g("key_csm"), g("eg_cnt"), g("eg_timer"), g("lfo_cnt"), g("lfo_timer"),
    g("lfo_ovf"), g("lfo_am", 126), g("lfo_pm"), g("ym_dacen"), g("ym_dacout"), g("fm_prev_l"), g("fm_prev_r"), g("fm_start"), g("fm_ptr"),
  ].join("\n");
  const data = [
    [L.TL, bytes(T.tlTab, 2, true)], [L.SIN, bytes(T.sinTab, 2)], [L.LFOPM, bytes([...lfoPmTable(T.lfoPmOutput)], 1, true)],
    [L.EGINC, bytes(T.egInc, 1)], [L.EGSEL, bytes(T.egRateSelect, 1)], [L.EGSH, bytes(T.egRateShift, 1)], [L.DT, bytes(dt, 4)],
    [L.FKT, bytes(T.opnFktable, 1)], [L.SL, bytes(T.slTable, 4)], [L.LFOSTEP, bytes(T.lfoSamplesPerStep, 4)],
    [L.AMSSH, bytes(T.lfoAmsDepthShift, 1)], [L.OPMASK, bytes(opmask, 4)],
  ].map(([a, s]) => `  (data (i32.const ${a}) "${s}")`).join("\n");

  // sound_update's FM part: the flush of fm_buffer into blip_buf, sample k
  // at fm_cycles_start + k * ratio, do/while time < cycles (samples rendered
  // past the frame end are dropped, the chip having advanced for them), then
  // fm_cycles_count = fm_cycles_start = time - cycles
  const frameEnd = `
  (func $md_fm_flush (param $cycles i32)
    (local $time i32) (local $k i32) (local $l i32) (local $r i32) (local $a i32)
    (local.set $time (global.get $fm_start))
    (loop $l
      (local.set $a (i32.add (i32.const ${o.fmBuf}) (i32.shl (local.get $k) (i32.const 3))))
      (local.set $l (i32.load (local.get $a)))
      (local.set $r (i32.load offset=4 (local.get $a)))
      (call $blip_add (local.get $time) (i32.sub (local.get $l) (global.get $fm_prev_l)) (i32.sub (local.get $r) (global.get $fm_prev_r)))
      (global.set $fm_prev_l (local.get $l))
      (global.set $fm_prev_r (local.get $r))
      (local.set $time (i32.add (local.get $time) (i32.const ${FM_RATIO})))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br_if $l (i32.lt_s (local.get $time) (local.get $cycles))))
    (global.set $fm_ptr (i32.const 0))
    (global.set $fm_count (i32.sub (local.get $time) (local.get $cycles)))
    (global.set $fm_start (global.get $fm_count)))
  ;; the PSG from the 68000 ($C00011/$C00013..17 byte, any word) and the Z80 ($7F11)
  (func $psg_write_md (param $cycles i32) (param $v i32)
    (call $psg_w (local.get $cycles) (i32.and (local.get $v) (i32.const 0xFF))))
`;

  return `
${globals}
${data}
${soundCoreWat({ lay: L.snd, clock: o.pal ? MCLOCK_PAL : MCLOCK_NTSC, cursorAddr: o.cursorAddr, muteAddr: MUTE, muteShift: 6,
    beforeBlipEnd: "    (call $md_fm_flush (local.get $clocks))", deltas: o.deltas })}
${ops}${keys}${refreshSlot}${lfo}${chanCalc}${setupConn}${writeReg}${render}${write}${frameEnd}`;
}

/**
 * wasmcart info fields + the section's audio block.
 * @param {number} base
 * @param {{offset:number, countOffset:number, capacity:number}} [deltas] the options.audioDeltas stream
 */
export function mdSoundInfo(base, deltas) {
  const L = mdSoundLayout(base);
  return {
    audio: L.snd.ring, audioCap: L.snd.ringCap, sampleRate: SOUND_RATE, flags: 0, end: L.end,
    section: { sampleRate: SOUND_RATE, channels: 2, format: "s16", reference: "output",
      muteMask: { offset: L.snd.mute, size: 2, channels: ["fm1", "fm2", "fm3", "fm4", "fm5", "fm6", "psg0", "psg1", "psg2", "noise"] },
      ...(deltas ? { streams: { blip: { ...deltas, channels: 3, format: "s32", ref: "gpgx_blip_deltas" } } } : {}) },
  };
}

/** options.audioDeltas: where the debug stream goes (above everything else, `top` 64KB-aligned). */
export function deltasLayout(top, capacity = 32768) {
  return { countOffset: top, offset: top + 32, capacity, end: top + 32 + capacity * 12 };
}

/** Replace `from` with `to` in `text` exactly once, or throw naming `what`. */
function patchOnce(text, from, to, what) {
  const i = text.indexOf(from);
  if (i < 0 || text.indexOf(from, i + 1) >= 0) throw new Error(`genesis audio: cannot hook ${what} (runtime.js text changed)`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

/**
 * Hook the YM2612 into runtime.js's z80Wat text: $fm_update renders the
 * samples, $fm_write forwards the register write, $fm_reset resets the chip,
 * $ym_set_timers runs set_timers' CSM part first, the Z80's $7F11 reaches the
 * PSG.
 * @param {string} z80 the text of RT.z80Wat(...)
 * @param {number} zcyc address of the Z80 cycle counter (Z80.cycles, master cycles)
 */
export function hookZ80Wat(z80, zcyc) {
  const a = z80.indexOf("  (func $fm_update (param $cycles i32)");
  const b = z80.indexOf("  (func $ym_set_timers", a);
  if (a < 0 || b < 0 || !z80.slice(a, b).includes("INTERNAL_TIMER_A") || !z80.slice(a, b).includes("INTERNAL_TIMER_B(length)")) {
    throw new Error("genesis audio: cannot hook $fm_update (runtime.js text changed)");
  }
  let t = z80.slice(0, a) + `  ;; sound.c fm_update: YM2612Update (samples + timers) through ym2612.js
  (func $fm_update (param $cycles i32)
    (local $n i32)
    (if (i32.gt_s (local.get $cycles) (global.get $fm_count))
      (then
        (local.set $n (i32.div_s (i32.add (i32.sub (local.get $cycles) (global.get $fm_count)) (i32.const ${FM_RATIO - 1})) (i32.const ${FM_RATIO})))
        (call $ym_render (local.get $n))
        (global.set $fm_count (i32.add (global.get $fm_count) (i32.mul (local.get $n) (i32.const ${FM_RATIO})))))))

` + z80.slice(b);
  t = patchOnce(t, "  (func $ym_set_timers (param $v i32)\n", "  (func $ym_set_timers (param $v i32)\n    (call $ym_mode_w (local.get $v))\n", "$ym_set_timers");
  t = patchOnce(t, "    (if (i32.eqz (local.get $a)) (then (global.set $ym_addr (local.get $v)) (return)))\n",
    "    (call $ym_write (local.get $a) (local.get $v))\n    (if (i32.eqz (local.get $a)) (then (global.set $ym_addr (local.get $v)) (return)))\n", "$fm_write");
  t = patchOnce(t, "  (func $fm_reset (param $cycles i32)\n    (call $fm_update (local.get $cycles))\n",
    "  (func $fm_reset (param $cycles i32)\n    (call $fm_update (local.get $cycles))\n    (call $ym_reset)\n", "$fm_reset");
  t = patchOnce(t, `    ;; $10/$14 PSG (audio is not produced), $18 unused, $1C the VDP test register
    (if (i32.or (i32.or (i32.eq (local.get $o) (i32.const 0x10)) (i32.eq (local.get $o) (i32.const 0x14)))`,
  `    ;; $10/$14 PSG (odd address: psg_write(Z80.cycles)), $18 unused, $1C the VDP test register
    (if (i32.and (i32.or (i32.eq (local.get $o) (i32.const 0x10)) (i32.eq (local.get $o) (i32.const 0x14))) (i32.and (local.get $a) (i32.const 1)))
      (then (call $psg_write_md (i32.load (i32.const ${zcyc})) (local.get $v)) (return)))
    (if (i32.or (i32.or (i32.eq (local.get $o) (i32.const 0x10)) (i32.eq (local.get $o) (i32.const 0x14)))`, "zbank_write_vdp");
  return t;
}

/**
 * Hook the 68000's PSG writes into runtime.js's VDP text ($vdp_wr8 odd
 * address, $vdp_wr16 any): psg_write(m68k.cycles, data).
 * @param {string} vdp the text holding $vdp_wr8 / $vdp_wr16
 */
export function hookVdpWat(vdp) {
  const psg = "    (if (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x14))) (then (return)))\n";
  const w8 = vdp.indexOf("  (func $vdp_wr8 (param $a i32) (param $v i32)");
  const w16 = vdp.indexOf("  (func $vdp_wr16 (param $a i32) (param $v i32)");
  if (w8 < 0 || w16 < 0) throw new Error("genesis audio: cannot hook $vdp_wr8/$vdp_wr16 (runtime.js text changed)");
  const p8 = vdp.indexOf(psg, w8), p16 = vdp.indexOf(psg, w16);
  if (p8 < 0 || p8 > w16 || p16 < 0) throw new Error("genesis audio: cannot hook the 68000 PSG write (runtime.js text changed)");
  const to8 = "    (if (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x14)))\n      (then (if (i32.and (local.get $a) (i32.const 1)) (then (call $psg_write_md (global.get $mc) (local.get $v)))) (return)))\n";
  const to16 = "    (if (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x14))) (then (call $psg_write_md (global.get $mc) (local.get $v)) (return)))\n";
  return vdp.slice(0, p8) + to8 + vdp.slice(p8 + psg.length, p16) + to16 + vdp.slice(p16 + psg.length);
}

/**
 * Hook the frame (index.js frameWat text): sound_update + audio_update at
 * the frame end, the wasmcart audio ring in wc_get_info, and the YM2612's
 * power-on reset (sound_reset) in wc_init.
 * @param {string} frame
 * @param {{abi:number, base:number}} o
 */
export function hookFrameWat(frame, o) {
  const info = mdSoundInfo(o.base);
  let t = patchOnce(frame, `    ;; sound_update: run FM to the frame end; timers and BUSY carry over
    (call $fm_update (global.get $mcvdp))
    (global.set $fm_count (i32.sub (global.get $fm_count) (global.get $mcvdp)))
`, `    ;; sound_update + audio_update (ym2612.js, ../sms/psg.js): FM to the frame end,
    ;; PSG, the fm_buffer flush (fm_cycles_start), blip, samples into the ring
    (call $fm_update (global.get $mcvdp))
    (call $snd_end_frame (global.get $mcvdp))
`, "the frame end");
  t = patchOnce(t, `    (i32.store (i32.const ${o.abi + 16}) (i32.const 0))
    (i32.store (i32.const ${o.abi + 20}) (i32.const 0))
`, `    (i32.store (i32.const ${o.abi + 16}) (i32.const ${info.audio}))
    (i32.store (i32.const ${o.abi + 20}) (i32.const ${info.audioCap}))
    (i32.store (i32.const ${o.abi + 48}) (i32.const ${info.flags}))
    (i32.store (i32.const ${o.abi + 52}) (i32.const ${info.sampleRate}))
`, "wc_get_info");
  t = patchOnce(t, `  (func (export "wc_render")
    (local $i i32)
    (call $frame)`, `  (func (export "wc_render")
    (local $i i32)
    (call $snd_frame_begin)
    (call $frame)`, "wc_render");
  t = patchOnce(t, "    (call $z80_reset)\n", "    (call $z80_reset)\n    ;; sound_reset: YM2612ResetChip (the PSG powers on in its reset state)\n    (call $ym_reset)\n", "wc_init");
  return t;
}

/**
 * Hook runtime.js's memWat text: gen_zreset_w with !ZRESET asserted also
 * resets the YM2612 ("stop YM2612": fm_reset(cycles) on every assert).
 * The CPU-visible part (timers, BUSY) was not observed by the verified
 * carts; the chip's envelopes restart there, so the audio needs it.
 * @param {string} mem the text of RT.memWat(...)
 */
export function hookMemWat(mem) {
  return patchOnce(mem, `            (global.set $zstate (i32.and (global.get $zstate) (i32.const 2))))))`,
    `            (call $fm_reset (global.get $mc))
            (global.set $zstate (i32.and (global.get $zstate) (i32.const 2))))))`, "$zreset_w");
}

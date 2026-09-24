// genesis_plus_gx's sound output in WAT: the SN76489 PSG (core/sound/psg.c,
// incl. the Game Gear stereo register), Blip_Buffer band-limited resampling
// to 44100 Hz stereo (core/sound/blip_buf.c, stereo build, 64-bit fixed_t as
// on wasm32) and the frame hand-off of sound.c sound_update / system.c
// audio_update, ported line for line so a cart's int16 samples equal the
// ones gpgx gives its libretro audio callback.
//
// Shared by the SMS/GG backend (smsSoundWat) and the Genesis backend, which
// adds the YM2612 (../genesis/ym2612.js) through the same blip buffer.
//
// The reference configuration is romdev's genesis_plus_gx with its libretro
// option defaults (SOUND_FREQUENCY 44100, audio_init(44100, 0) so the blip
// clock is system_clock, psg_preamp 150, per-channel PSG volumes 100,
// audio_filter disabled, stereo, config.hq_psg = config.hq_fm = 1, no
// ALIGN_SND). The YM2413 is not part of it: its "auto" option leaves
// config.ym2413 = 2, and gpgx gates the FM unit on bit 0, so the reference
// renders no FM on SMS.
//
// Tables come from ./gpgx-sound.json (scripts/recompile-gen/gpgx-sound.mjs,
// parsed from gpgx's source). LICENSE: derived from Genesis Plus GX
// (non-commercial, see NOTICE).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";

let tables = null;
/** The generated gpgx sound tables (gpgx-sound.json). */
export function gpgxSoundTables() {
  if (!tables) tables = JSON.parse(readFileSync(new URL("./gpgx-sound.json", import.meta.url), "utf8"));
  return tables;
}

/** gpgx system.h master clocks. */
export const MCLOCK_NTSC = 53693175, MCLOCK_PAL = 53203424;
/** libretro.c SOUND_FREQUENCY. */
export const SOUND_RATE = 44100;
/** config.psg_preamp default (libretro option genesis_plus_gx_psg_preamp). */
export const PSG_PREAMP = 150;

/**
 * blip_set_rates(m, clock, 44100): factor = ceil(time_unit * rate / clock)
 * with time_unit = 1 << 52 (fixed_t is 64-bit, pre_shift 32).
 * @param {number} clock master clock (system_clock)
 * @returns {bigint}
 */
export function blipFactor(clock, rate = SOUND_RATE) {
  const f = 2 ** 52 * rate / clock;
  let fi = BigInt(Math.floor(f));
  if (Number(fi) < f) fi++;
  return fi;
}

/**
 * Memory the sound code owns, from `base` (4-aligned): the output ring
 * (int16 stereo frames), the two blip sample buffers, bl_step, chanVolume.
 * @param {number} base
 * @param {number} [ringCap=2048] stereo frames in the ring (power of two)
 * @param {number} [blipCap=1024] samples a frame can produce (gpgx allocates rate/10; a frame uses < 900)
 */
export function soundLayout(base, ringCap = 2048, blipCap = 1024) {
  if (ringCap & (ringCap - 1)) throw new Error("sound: ringCap must be a power of two");
  const ring = base;
  const bl = ring + ringCap * 4;
  const blen = (blipCap + 18) * 4; // buf_extra = half_width*2 + end_frame_extra
  const br = bl + blen;
  const blstep = br + blen;
  const chanvol = blstep + 33 * 8 * 4;
  const mute = chanvol + 16 * 4;
  const end = mute + 4;
  return { ring, ringCap, bl, br, blipCap, blstep, chanvol, mute, end, bytes: end - base };
}

const i32data = (vals) => {
  const b = Buffer.alloc(vals.length * 4);
  vals.forEach((v, i) => b.writeInt32LE(v, i * 4));
  return [...b].map((x) => "\\" + x.toString(16).padStart(2, "0")).join("");
};

/**
 * Blip_Buffer (stereo) + PSG core + frame output. Functions:
 *   $blip_add (t dl dr)        blip_add_delta
 *   $psg_w (clocks data)       psg_write
 *   $psg_cfg (clocks preamp panning)  psg_config
 *   $snd_end_frame (clocks)    psg_end_frame; [FM flush is incremental]; blip_end_frame;
 *                              blip_read_samples into the ring at the cursor in `cursorAddr`
 * @param {object} o
 * @param {ReturnType<typeof soundLayout>} o.lay
 * @param {number} o.clock      system_clock (blip input rate)
 * @param {number} o.cursorAddr address of the wasmcart audio write cursor (u32, in stereo frames)
 * @param {string} [o.beforeBlipEnd] WAT run at frame end after psg_end_frame, before blip_end_frame (the FM flush)
 * @param {number} [o.muteAddr] u16 mute mask (0 at power-on, never written by the cart)
 * @param {number} [o.muteShift=0] bit of PSG channel 0 in the mask
 * @param {{offset:number, countOffset:number, capacity:number}} [o.deltas] debug stream of every
 *   blip delta (gpgx_blip_deltas' layout); $snd_frame_begin resets it (call at the top of wc_render)
 */
export function soundCoreWat(o) {
  const T = gpgxSoundTables();
  const { lay } = o;
  const R = T.psg.mcyclesRatio; // 15*16
  const zeroInc = 1 * R; // PSG_INTEGRATED
  const NW = 15, NMASK = 9; // noiseShiftWidth[PSG_INTEGRATED], noiseBitMask
  // noiseFeedback[v & 9]: only indices 0, 1, 8, 9 are reachable (mask 9)
  const fb = T.psg.noiseFeedback;
  if (fb[0] !== 0 || fb[1] !== 1 || fb[8] !== 1 || fb[9] !== 0) throw new Error("psg: noiseFeedback is not the parity of bits 0 and 3");
  const factor = blipFactor(o.clock);
  const g = (n, v = 0) => `  (global $${n} (mut i32) (i32.const ${v}))`;
  const globals = [
    g("psg_clocks"), g("psg_latch", 3), g("psg_nsv", 1 << NW),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => g(`psg_r${i}`)),
    ...[0, 1, 2, 3].flatMap((i) => [
      g(`psg_inc${i}`, i < 3 ? zeroInc : 16 * R), g(`psg_cnt${i}`), g(`psg_pol${i}`, -1),
      g(`psg_dl${i}`), g(`psg_dr${i}`), g(`psg_ol${i}`), g(`psg_or${i}`),
      g(`psg_al${i}`, PSG_PREAMP), g(`psg_ar${i}`, PSG_PREAMP),
    ]),
    `  (global $blip_off (mut i64) (i64.const ${factor / 2n}))`,
    g("blip_il"), g("blip_ir"),
  ].join("\n");

  // blip_add_delta, unrolled as blip_buf.c writes it
  const side = (outBase, dv) => {
    const lines = [];
    lines.push(`    (local.set $d (i32.shr_s (i32.mul (local.get ${dv}) (local.get $interp)) (i32.const 15)))`);
    lines.push(`    (local.set ${dv} (i32.sub (local.get ${dv}) (local.get $d)))`);
    lines.push(`    (local.set $o (i32.add (i32.const ${outBase}) (i32.shl (local.get $pos) (i32.const 2))))`);
    for (let j = 0; j < 8; j++) {
      lines.push(`    (i32.store offset=${4 * j} (local.get $o) (i32.add (i32.load offset=${4 * j} (local.get $o))
      (i32.add (i32.mul (i32.load offset=${4 * j} (local.get $in)) (local.get ${dv})) (i32.mul (i32.load offset=${4 * (8 + j)} (local.get $in)) (local.get $d)))))`);
    }
    for (let j = 0; j < 8; j++) {
      // rev[7-j]*delta_l + rev[7-j-half_width]*delta ; rev[-1-j] = (rev-32)[7-j]
      lines.push(`    (i32.store offset=${4 * (8 + j)} (local.get $o) (i32.add (i32.load offset=${4 * (8 + j)} (local.get $o))
      (i32.add (i32.mul (i32.load offset=${4 * (7 - j) + 32} (local.get $revm)) (local.get ${dv})) (i32.mul (i32.load offset=${4 * (7 - j)} (local.get $revm)) (local.get $d)))))`);
    }
    return lines.join("\n");
  };
  const blipAdd = `
  (func $blip_add (param $t i32) (param $dl i32) (param $dr i32)
    (local $fx i32) (local $ph i32) (local $in i32) (local $revm i32) (local $interp i32) (local $pos i32) (local $d i32) (local $o i32)
    (if (i32.eqz (i32.or (local.get $dl) (local.get $dr))) (then (return)))${o.deltas ? `
    ;; options.audioDeltas: (time, delta_l, delta_r) as gpgx_blip_deltas records them
    (local.set $d (i32.load (i32.const ${o.deltas.countOffset})))
    (if (i32.lt_u (local.get $d) (i32.const ${o.deltas.capacity}))
      (then (local.set $o (i32.add (i32.const ${o.deltas.offset}) (i32.mul (local.get $d) (i32.const 12))))
            (i32.store (local.get $o) (local.get $t))
            (i32.store offset=4 (local.get $o) (local.get $dl))
            (i32.store offset=8 (local.get $o) (local.get $dr))))
    (i32.store (i32.const ${o.deltas.countOffset}) (i32.add (local.get $d) (i32.const 1)))` : ""}
    (local.set $fx (i32.wrap_i64 (i64.shr_u (i64.add (i64.mul (i64.extend_i32_u (local.get $t)) (i64.const ${factor})) (global.get $blip_off)) (i64.const 32))))
    (local.set $ph (i32.and (i32.shr_u (local.get $fx) (i32.const 15)) (i32.const 31)))
    (local.set $in (i32.add (i32.const ${lay.blstep}) (i32.shl (local.get $ph) (i32.const 5))))
    ;; rev = bl_step[phase_count - phase]; $revm = rev - half_width
    (local.set $revm (i32.add (i32.const ${lay.blstep - 32}) (i32.shl (i32.sub (i32.const 32) (local.get $ph)) (i32.const 5))))
    (local.set $interp (i32.and (local.get $fx) (i32.const 0x7FFF)))
    (local.set $pos (i32.shr_u (local.get $fx) (i32.const 20)))
${side(lay.bl, "$dl")}
${side(lay.br, "$dr")})
`;

  // muteMask (verifyRecompile's channelDrop control): bit muteShift+i
  // silences PSG channel i in the mix only; the chip state runs on
  const live = (i, call) => o.muteAddr == null ? call
    : `(if (i32.eqz (i32.and (i32.load16_u (i32.const ${o.muteAddr})) (i32.const ${1 << ((o.muteShift ?? 0) + i)}))) (then ${call}))`;
  // psg_update(clocks)
  const tone = (i) => `
    (if (i32.or (global.get $psg_dl${i}) (global.get $psg_dr${i}))
      (then ${live(i, "(call $blip_add (global.get $psg_clocks) (global.get $psg_dl" + i + ") (global.get $psg_dr" + i + "))")}
            (global.set $psg_dl${i} (i32.const 0)) (global.set $psg_dr${i} (i32.const 0))))
    (local.set $ts (global.get $psg_cnt${i}))
    (local.set $pol (global.get $psg_pol${i}))
    (block $d${i} (loop $l${i}
      (br_if $d${i} (i32.ge_u (local.get $ts) (local.get $clocks)))
      (local.set $pol (i32.sub (i32.const 0) (local.get $pol)))
      ${live(i, "(call $blip_add (local.get $ts) (i32.mul (local.get $pol) (global.get $psg_ol" + i + ")) (i32.mul (local.get $pol) (global.get $psg_or" + i + ")))")}
      (local.set $ts (i32.add (local.get $ts) (global.get $psg_inc${i})))
      (br $l${i})))
    (global.set $psg_cnt${i} (local.get $ts))
    (global.set $psg_pol${i} (local.get $pol))`;
  const noise = `
    (if (i32.or (global.get $psg_dl3) (global.get $psg_dr3))
      (then ${live(3, "(call $blip_add (global.get $psg_clocks) (global.get $psg_dl3) (global.get $psg_dr3))")}
            (global.set $psg_dl3 (i32.const 0)) (global.set $psg_dr3 (i32.const 0))))
    (local.set $ts (global.get $psg_cnt3))
    (local.set $pol (global.get $psg_pol3))
    (local.set $sv (global.get $psg_nsv))
    (block $d3 (loop $l3
      (br_if $d3 (i32.ge_u (local.get $ts) (local.get $clocks)))
      (local.set $pol (i32.sub (i32.const 0) (local.get $pol)))
      (if (i32.gt_s (local.get $pol) (i32.const 0))
        (then
          (local.set $so (i32.and (local.get $sv) (i32.const 1)))
          (if (i32.and (global.get $psg_r6) (i32.const 4))
            ;; white noise: XOR feedback (noiseFeedback[v & ${NMASK}] = parity of bits 0 and 3)
            (then (local.set $sv (i32.or (i32.shr_u (local.get $sv) (i32.const 1))
                    (i32.shl (i32.and (i32.xor (local.get $sv) (i32.shr_u (local.get $sv) (i32.const 3))) (i32.const 1)) (i32.const ${NW})))))
            (else (local.set $sv (i32.or (i32.shr_u (local.get $sv) (i32.const 1)) (i32.shl (local.get $so) (i32.const ${NW}))))))
          (local.set $so (i32.sub (i32.and (local.get $sv) (i32.const 1)) (local.get $so)))
          ${live(3, "(call $blip_add (local.get $ts) (i32.mul (local.get $so) (global.get $psg_ol3)) (i32.mul (local.get $so) (global.get $psg_or3)))")}))
      (local.set $ts (i32.add (local.get $ts) (global.get $psg_inc3)))
      (br $l3)))
    (global.set $psg_nsv (local.get $sv))
    (global.set $psg_cnt3 (local.get $ts))
    (global.set $psg_pol3 (local.get $pol))`;
  const sync = `
    (if (i32.gt_u (local.get $clocks) (global.get $psg_clocks))
      (then (call $psg_upd (local.get $clocks))
            (global.set $psg_clocks (i32.add (global.get $psg_clocks)
              (i32.mul (i32.div_u (i32.add (i32.sub (local.get $clocks) (global.get $psg_clocks)) (i32.const ${R - 1})) (i32.const ${R})) (i32.const ${R}))))))`;
  const volWrite = (i, cond) => `
        (local.set $data (i32.load (i32.add (i32.const ${lay.chanvol}) (i32.shl (i32.and (local.get $data) (i32.const 15)) (i32.const 2)))))
        (local.set $cl (i32.div_s (i32.mul (local.get $data) (global.get $psg_al${i})) (i32.const 100)))
        (local.set $cr (i32.div_s (i32.mul (local.get $data) (global.get $psg_ar${i})) (i32.const 100)))
        (if ${cond}
          (then (global.set $psg_dl${i} (i32.add (global.get $psg_dl${i}) (i32.sub (local.get $cl) (global.get $psg_ol${i}))))
                (global.set $psg_dr${i} (i32.add (global.get $psg_dr${i}) (i32.sub (local.get $cr) (global.get $psg_or${i}))))))
        (global.set $psg_ol${i} (local.get $cl))
        (global.set $psg_or${i} (local.get $cr))`;
  const freqWrite = (idx) => `
        (if (i32.and (local.get $data) (i32.const 0x80))
          (then (local.set $data (i32.or (i32.and (global.get $psg_r${idx}) (i32.const 0x3f0)) (i32.and (local.get $data) (i32.const 0x0f)))))
          (else (local.set $data (i32.or (i32.and (global.get $psg_r${idx}) (i32.const 0x00f)) (i32.shl (i32.and (local.get $data) (i32.const 0x3f)) (i32.const 4))))))
        (global.set $psg_inc${idx >> 1} (select (i32.mul (local.get $data) (i32.const ${R})) (i32.const ${zeroInc}) (local.get $data)))${idx === 4 ? `
        (if (i32.eq (i32.and (global.get $psg_r6) (i32.const 3)) (i32.const 3))
          (then (global.set $psg_inc3 (global.get $psg_inc2))))` : ""}`;
  const cases = [];
  for (let idx = 0; idx < 8; idx++) {
    let body;
    if (idx === 0 || idx === 2 || idx === 4) body = freqWrite(idx);
    else if (idx === 6) body = `
        (if (i32.eq (i32.and (local.get $data) (i32.const 3)) (i32.const 3))
          (then (global.set $psg_inc3 (global.get $psg_inc2)) (global.set $psg_cnt3 (global.get $psg_cnt2)))
          (else (global.set $psg_inc3 (i32.mul (i32.shl (i32.const 0x10) (i32.and (local.get $data) (i32.const 3))) (i32.const ${R})))))
        (if (i32.and (global.get $psg_nsv) (i32.const 1))
          (then (global.set $psg_dl3 (i32.sub (global.get $psg_dl3) (global.get $psg_ol3)))
                (global.set $psg_dr3 (i32.sub (global.get $psg_dr3) (global.get $psg_or3)))))
        (global.set $psg_nsv (i32.const ${1 << NW}))`;
    else if (idx === 7) body = volWrite(3, "(i32.and (global.get $psg_nsv) (i32.const 1))");
    else body = volWrite(idx >> 1, `(i32.gt_s (global.get $psg_pol${idx >> 1}) (i32.const 0))`);
    cases.push(`    (if (i32.eq (local.get $idx) (i32.const ${idx}))
      (then${body}
        (global.set $psg_r${idx} (local.get $data))
        (return)))`);
  }
  const cfgChan = (i) => `
    (local.set $vol (global.get $psg_r${i * 2 + 1}))
    (global.set $psg_al${i} (i32.mul (local.get $preamp) (i32.and (i32.shr_u (local.get $pan) (i32.const ${i + 4})) (i32.const 1))))
    (global.set $psg_ar${i} (i32.mul (local.get $preamp) (i32.and (i32.shr_u (local.get $pan) (i32.const ${i})) (i32.const 1))))
    (local.set $cl (i32.div_s (i32.mul (local.get $vol) (global.get $psg_al${i})) (i32.const 100)))
    (local.set $cr (i32.div_s (i32.mul (local.get $vol) (global.get $psg_ar${i})) (i32.const 100)))
    (if ${i < 3 ? `(i32.gt_s (global.get $psg_pol${i}) (i32.const 0))` : "(i32.and (global.get $psg_nsv) (i32.const 1))"}
      (then (global.set $psg_dl${i} (i32.add (global.get $psg_dl${i}) (i32.sub (local.get $cl) (global.get $psg_ol${i}))))
            (global.set $psg_dr${i} (i32.add (global.get $psg_dr${i}) (i32.sub (local.get $cr) (global.get $psg_or${i}))))))
    (global.set $psg_ol${i} (local.get $cl))
    (global.set $psg_or${i} (local.get $cr))`;
  const readSide = (buf, integ, off) => `
      (local.set $s (i32.shr_s (global.get ${integ}) (i32.const 15)))
      (global.set ${integ} (i32.add (global.get ${integ}) (i32.load (i32.add (i32.const ${buf}) (i32.shl (local.get $i) (i32.const 2))))))
      (if (i32.gt_s (local.get $s) (i32.const 32767)) (then (local.set $s (i32.const 32767)))
        (else (if (i32.lt_s (local.get $s) (i32.const -32768)) (then (local.set $s (i32.const -32768))))))
      (i32.store16 offset=${off} (local.get $a) (local.get $s))
      (global.set ${integ} (i32.sub (global.get ${integ}) (i32.shl (local.get $s) (i32.const 6))))`;

  return `${globals}
  (func $snd_frame_begin${o.deltas ? ` (i32.store (i32.const ${o.deltas.countOffset}) (i32.const 0))` : ""})
  (data (i32.const ${lay.blstep}) "${i32data(T.blip.blStep)}")
  (data (i32.const ${lay.chanvol}) "${i32data(T.psg.chanVolume)}")
${blipAdd}
  ;; psg.c psg_update: pending volume steps, then every transition before $clocks
  (func $psg_upd (param $clocks i32)
    (local $ts i32) (local $pol i32) (local $sv i32) (local $so i32)${tone(0)}${tone(1)}${tone(2)}${noise})

  ;; psg.c psg_write
  (func $psg_w (param $clocks i32) (param $data i32)
    (local $idx i32) (local $cl i32) (local $cr i32)${sync}
    (if (i32.and (local.get $data) (i32.const 0x80))
      (then (local.set $idx (i32.and (i32.shr_u (local.get $data) (i32.const 4)) (i32.const 7)))
            (global.set $psg_latch (local.get $idx)))
      (else (local.set $idx (global.get $psg_latch))))
${cases.join("\n")})

  ;; psg.c psg_config (per-channel volumes at their default 100)
  (func $psg_cfg (param $clocks i32) (param $preamp i32) (param $pan i32)
    (local $vol i32) (local $cl i32) (local $cr i32)${sync}${cfgChan(0)}${cfgChan(1)}${cfgChan(2)}${cfgChan(3)})

  ;; sound_update + audio_update at the end of a frame of $clocks master cycles:
  ;; psg_end_frame, the FM flush, blip_end_frame, blip_read_samples into the
  ;; wasmcart ring (int16 stereo frames), remove_samples
  (func $snd_end_frame (param $clocks i32)
    (local $n i32) (local $i i32) (local $s i32) (local $cur i32) (local $a i32)${sync}
    (global.set $psg_clocks (i32.sub (global.get $psg_clocks) (local.get $clocks)))
    (global.set $psg_cnt0 (i32.sub (global.get $psg_cnt0) (local.get $clocks)))
    (global.set $psg_cnt1 (i32.sub (global.get $psg_cnt1) (local.get $clocks)))
    (global.set $psg_cnt2 (i32.sub (global.get $psg_cnt2) (local.get $clocks)))
    (global.set $psg_cnt3 (i32.sub (global.get $psg_cnt3) (local.get $clocks)))
${o.beforeBlipEnd ?? ""}
    (global.set $blip_off (i64.add (global.get $blip_off) (i64.mul (i64.extend_i32_u (local.get $clocks)) (i64.const ${factor}))))
    (local.set $n (i32.wrap_i64 (i64.shr_u (global.get $blip_off) (i64.const 52))))
    (local.set $cur (i32.load (i32.const ${o.cursorAddr})))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $a (i32.add (i32.const ${lay.ring}) (i32.shl (local.get $cur) (i32.const 2))))${readSide(lay.bl, "$blip_il", 0)}${readSide(lay.br, "$blip_ir", 2)}
      (local.set $cur (i32.and (i32.add (local.get $cur) (i32.const 1)) (i32.const ${lay.ringCap - 1})))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store (i32.const ${o.cursorAddr}) (local.get $cur))
    (global.set $blip_off (i64.sub (global.get $blip_off) (i64.shl (i64.extend_i32_u (local.get $n)) (i64.const 52))))
    (memory.copy (i32.const ${lay.bl}) (i32.add (i32.const ${lay.bl}) (i32.shl (local.get $n) (i32.const 2))) (i32.const 72))
    (memory.fill (i32.const ${lay.bl + 72}) (i32.const 0) (i32.shl (local.get $n) (i32.const 2)))
    (memory.copy (i32.const ${lay.br}) (i32.add (i32.const ${lay.br}) (i32.shl (local.get $n) (i32.const 2))) (i32.const 72))
    (memory.fill (i32.const ${lay.br + 72}) (i32.const 0) (i32.shl (local.get $n) (i32.const 2))))
`;
}

/**
 * The SMS/GG glue: $psg_write (v) and $psg_stereo (v) at the Z80's master
 * cycle, and $psg_render at the end of the frame.
 *
 * gpgx calls psg_write(Z80.cycles, data) with Z80.cycles in master cycles
 * (15 per T-state) from the start of the frame, charged with the whole
 * instruction before its port access. The cart knows the T-state as
 * `$snd_tend - $curbudget`: the emitter publishes the line budget left after
 * an OUT's cost in $curbudget, and the frame loop sets $snd_tend to the
 * frame T-state at which that budget reaches 0 before each $run.
 *
 * @param {object} o
 * @param {number} o.base        AUDIO region (0xB000 bytes)
 * @param {number} o.cursorAddr  wasmcart audio write cursor
 * @param {boolean} o.pal
 */
export function smsSoundWat(o) {
  const lay = soundLayout(o.base, 2048, 1024);
  if (lay.bytes > 0xB000) throw new Error("sms sound: layout exceeds the AUDIO region");
  const lines = o.pal ? 313 : 262;
  return `
  (global $snd_tend (mut i32) (i32.const 228))
${soundCoreWat({ lay, clock: o.pal ? MCLOCK_PAL : MCLOCK_NTSC, cursorAddr: o.cursorAddr, muteAddr: lay.mute })}
  (func $psg_write (param $v i32)
    (call $psg_w (i32.mul (i32.sub (global.get $snd_tend) (global.get $curbudget)) (i32.const 15)) (local.get $v)))
  ;; Game Gear port $06 (io_ctrl.c io_gg_write): psg_config(Z80.cycles, psg_preamp, data)
  (func $psg_stereo (param $v i32)
    (call $psg_cfg (i32.mul (i32.sub (global.get $snd_tend) (global.get $curbudget)) (i32.const 15)) (i32.const ${PSG_PREAMP}) (local.get $v)))
  ;; audio_update at the end of the frame (mcycles_vdp = lines x 3420)
  (func $psg_render
    (call $snd_end_frame (i32.const ${lines * 3420})))
`;
}

/** The wasmcart info fields and the section's audio block for the SMS/GG sound output. */
export function smsSoundInfo(base) {
  const lay = soundLayout(base, 2048, 1024);
  return {
    audio: lay.ring, audioCap: lay.ringCap, sampleRate: SOUND_RATE, flags: 0,
    section: { sampleRate: SOUND_RATE, channels: 2, format: "s16", reference: "output",
      muteMask: { offset: lay.mute, size: 2, channels: ["tone0", "tone1", "tone2", "noise"] } },
  };
}

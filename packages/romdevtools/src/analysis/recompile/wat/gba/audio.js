// GBA sound output for the WAT cart, ported from mGBA 0.11 so the cart hands
// the host the same int16 stereo samples romdev's mGBA core hands its
// libretro frontend:
//
//   src/gba/audio.c   DirectSound A/B (FIFO -> per-sample int8 slots, filled
//                     from the timer overflow that clocks the FIFO),
//                     SOUNDCNT_L/H/X, SOUNDBIAS (bias, clipping, resolution =
//                     the native sampling rate), GBAAudioSample's mix
//   src/gb/audio.c    the four PSG channels in their GB_AUDIO_GBA style
//                     (timingFactor 4, no DC offset, the 32-nibble wave RAM
//                     that rotates as it plays), GBAudioRun's lazy update,
//                     the frame sequencer (length, sweep, envelope)
//   src/util/audio-buffer.c, audio-resampler.c, interpolator.c and
//   src/platform/libretro/libretro.c
//                     the frontend half: mGBA's PSG buffer (0x4000 frames)
//                     drained after every retro_run, resampled to 65536 Hz by
//                     the windowed-sinc interpolator unless the native rate
//                     already is 65536 Hz (SOUNDBIAS resolution 1), in which
//                     case the samples are passed through
//
// None of this state is visible to the CPU except SOUNDCNT_X's four
// "channel playing" bits (mGBA keeps them in the I/O page: the cart does
// too) and the wave RAM, which ch3 rotates while it plays (the cart's WAVE
// block is that RAM). So the cart's CPU/state verification is unaffected.
//
// Every function names the mGBA function it ports. The C integer types are
// kept: int8_t sample slots, int16_t mix accumulators (i32.extend16_s where
// C truncates), unsigned table indices in the interpolator, and the
// interpolator's doubles (f64, same operation order, no fused multiply-add
// on either side). The sinc/window tables are computed with musl's sin/cos
// (musl-trig.js), bit-identical to the tables in the core's heap.
//
// Hook points in sys.js/index.js (the only edits outside this file):
//   $io_write sound block          (call $au_io_write a v)   GBAIOWrite
//   $io8_psg                       (call $au_io_write8 a v)  GBAIOWrite8
//   $io_write32 FIFO branch        (call $au_fifo_write b v) GBAAudioWriteFIFO
//   $fifo_sample                   $au_fifo_load / $au_fifo_fill (GBAAudioSampleFIFO)
//   $wave_read / $wave_write32     (call $au_wave_run)       GBAAudioRead/WriteWaveRAM
//   $event EV_FRAME / EV_SAMPLE    $au_frame_event / $au_sample_event
//   wc_init / wc_get_info / after every $run_frame in wc_render
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { muslTrig, sincTables } from "./musl-trig.js";

/** mGBA/musl-derived audio constants (scripts/recompile-gen/gba-mgba-audio.mjs). */
export const MGBA_AUDIO = JSON.parse(readFileSync(new URL("./mgba-audio.json", import.meta.url), "utf8"));

const J = MGBA_AUDIO;
/** output rate: libretro.c GBA_RESAMPLED_RATE (the frontend does not ask for another) */
export const AUDIO_RATE = J.libretro.resampledRate;
const RES = J.sinc.resolution, WIDTH = J.sinc.width;
const LUTN = RES * WIDTH + 1;
/** the PSG's mAudioBuffer (AUDIO_BUFFER_SAMPLES stereo frames) */
const SRC_CAP = J.gb.audioBufferSamples;
/** libretro.c audioResampleBuffer: nominal samples a frame rounded up to 1024 */
const DEST_CAP = Math.ceil(Math.round(AUDIO_RATE * 280896 / J.gba.cpuFrequency) / 1024) * 1024;
/** the wasmcart ring the host drains after every wc_render (5 frames of DEST_CAP fit) */
export const OUT_CAP = 16384;
/** the pre-resample debug stream: one frame of native samples (262144 Hz is 4389 a frame) */
const NATIVE_CAP = 8192;
const TF = J.gb.timingFactor;

// state block offsets (from A.STATE)
const S = { OUTW: 0, MUTE: 32, CUR: 64, SNAP: 1024, FIFOA: 128, FIFOB: 160, SMPA: 192, SMPB: 208, DUTY: 224, NMASK: 256, NPOP: 320,
  CH1: 384, CH2: 480, ENV4: 576, SIZE: 4096 };
// square channel struct (GBAudioSquareChannel): sweep, envelope, control, ...
const SW_SHIFT = 0, SW_TIME = 4, SW_STEP = 8, SW_DIR = 12, SW_EN = 16, SW_OCC = 20, SW_REAL = 24;
const ENV = 28;
// envelope struct (GBAudioEnvelope)
const E_LEN = 0, E_DUTY = 4, E_STEP = 8, E_INIT = 12, E_CUR = 16, E_DIR = 20, E_DEAD = 24, E_NEXT = 28;
const C_FREQ = 60, C_LEN = 64, C_STOP = 68, LASTUPD = 72, INDEX = 76, SAMPLE = 80;
/** state-block offsets and the square channel / envelope struct fields, for tools that read the cart */
export const AUDIO_STATE = Object.freeze({ ...S, square: { SW_SHIFT, SW_TIME, SW_STEP, SW_DIR, SW_EN, SW_OCC, SW_REAL, ENV,
  C_FREQ, C_LEN, C_STOP, LASTUPD, INDEX, SAMPLE }, envelope: { E_LEN, E_DUTY, E_STEP, E_INIT, E_CUR, E_DIR, E_DEAD, E_NEXT } });

/** The scalar state mirrored at STATE + SNAP after every frame (u32 each, in this order): a divergence finder reads it. */
export const AUDIO_SNAPSHOT = Object.freeze(["ps_enable", "ps_frame", "ps_skip", "ps_volL", "ps_volR", "ps_nr51", "ps_p1", "ps_p2", "ps_p3", "ps_p4", "c3_size", "c3_bank", "c3_enable", "c3_sample", "c3_length", "c3_volume", "c3_rate", "c3_stop", "c3_window", "c3_readable", "c3_next", "c4_ratio", "c4_freq", "c4_power", "c4_stop", "c4_length", "c4_lfsr", "c4_last", "c4_sample", "au_bias", "au_interval", "au_last", "au_idx", "au_vol", "au_volA", "au_volB", "au_aR", "au_aL", "au_bR", "au_bL", "au_intA", "au_intB", "src_r", "src_n"]);

/**
 * Linear-memory block for the audio, placed after the machine (L.END), so
 * no existing address moves.
 * @param {Record<string, number>} L
 */
export function audioLayout(L) {
  const base = Math.ceil(L.END / 0x1000) * 0x1000;
  const A = {};
  A.SINC = base;
  A.WIN = A.SINC + 8 * LUTN;
  A.SRC = Math.ceil((A.WIN + 8 * LUTN) / 16) * 16;
  A.OUT = A.SRC + 4 * SRC_CAP;
  A.STATE = A.OUT + 4 * OUT_CAP;
  A.NATIVE = A.STATE + S.SIZE;
  A.END = A.NATIVE + 16 + 4 * NATIVE_CAP;
  A.TRACE = A.END;
  A.TRACE_ENTRIES = 1 << 16;
  A.END_TRACE = A.TRACE + 12 * A.TRACE_ENTRIES;
  return A;
}

let LUT_CACHE = null;
/** The sinc and window tables as mInterpolatorSincInit fills them (musl sin/cos). */
export function sincLuts() {
  if (LUT_CACHE) return LUT_CACHE;
  const t = sincTables(muslTrig(J.musl), RES, WIDTH, J.sinc.window, J.sinc.pi);
  const sha = createHash("sha256").update(Buffer.from(t.sinc.buffer)).update(Buffer.from(t.window.buffer)).digest("hex");
  if (sha !== J.sinc.lutSha256) throw new Error(`gba audio: sinc tables hash ${sha}, mgba-audio.json pins ${J.sinc.lutSha256}`);
  LUT_CACHE = t;
  return t;
}

/**
 * Data segments for the audio block: [address, bytes].
 * @param {Record<string, number>} A audioLayout()
 */
export function audioData(A) {
  const t = sincLuts();
  const small = new Uint8Array(160);
  J.gb.duty.forEach((v, i) => { small[i] = v; });
  J.gb.noiseMask.forEach((v, i) => { small[32 + i] = v; });
  J.gb.noisePopulation.forEach((v, i) => { small[96 + i] = v; });
  return [
    [A.SINC, new Uint8Array(t.sinc.buffer)],
    [A.WIN, new Uint8Array(t.window.buffer)],
    [A.STATE + S.DUTY, small],
  ];
}

/**
 * The `audio` block of the romdev.recompile section: what the cart's audio
 * stream is and where its state lives.
 * @param {Record<string, number>} A
 */
export function audioSection(A) {
  return {
    sampleRate: AUDIO_RATE, channels: 2, format: "s16", reference: "output",
    note: "mGBA 0.11 libretro's audio_batch_cb stream: the GBA core's samples (native rate 16777216 / (0x200 >> SOUNDBIAS "
      + `resolution)) drained after every retro_run and resampled to ${AUDIO_RATE} Hz by mGBA's windowed-sinc resampler `
      + `(passed through when the native rate already is ${AUDIO_RATE} Hz); the first wc_render carries the warm-up frames' samples too`,
    // the native (pre-resample) samples of the last frame, as mGBA's
    // gba_audio_raw stream region taps them from _sample
    streams: { native: { offset: A.NATIVE + 16, countOffset: A.NATIVE, capacity: NATIVE_CAP, channels: 2, format: "s16", ref: "gba_audio_raw" } },
    // mGBA's own mute switches: GBAudio forceDisableCh[0..3], GBAAudio forceDisableChA/B
    muteMask: { offset: A.STATE + S.MUTE, size: 1, channels: ["sq1", "sq2", "wave", "noise", "fifoA", "fifoB"] },
  };
}

/**
 * wc_get_info's audio fields (call from wc_get_info with the info address).
 * @param {Record<string, number>} A
 * @param {number} info
 */
export function audioInfoWat(A, info) {
  return `
    (i32.store (i32.const ${info + 16}) (i32.const ${A.OUT}))
    (i32.store (i32.const ${info + 20}) (i32.const ${OUT_CAP}))
    (i32.store (i32.const ${info + 24}) (i32.const ${A.STATE + S.OUTW}))
    (i32.store (i32.const ${info + 52}) (i32.const ${AUDIO_RATE}))`;
}

/**
 * The audio WAT (functions + globals). Needs sys.js's $now, $until and the
 * cart's FIFO globals.
 * @param {Record<string, number>} L machine layout (IO, WAVE)
 * @param {Record<string, number>} A audioLayout(L)
 * @param {number} evSample the sample event id (for mTimingUntil)
 */
export function audioWat(L, A, evSample, opts = {}) {
  const ST = A.STATE;
  const NR52 = L.IO + 0x84;
  const WAVE = L.WAVE;
  const CH1 = ST + S.CH1, CH2 = ST + S.CH2, ENV4 = ST + S.ENV4;
  const g = (n) => `(global.get $${n})`;
  const set = (n, v) => `(global.set $${n} ${v})`;
  const c = (v) => `(i32.const ${v})`;
  const lg = (n) => `(local.get $${n})`;
  const ld = (p, o) => `(i32.load offset=${o} ${p})`;
  const st = (p, o, v) => `(i32.store offset=${o} ${p} ${v})`;
  const sx16 = (v) => `(i32.extend16_s ${v})`;
  const sx8 = (v) => `(i32.extend8_s ${v})`;
  const res = `(i32.and (i32.shr_u ${g("au_bias")} ${c(14)}) ${c(3)})`;
  const volShift = (v) => `(if (result i32) (i32.eqz ${v}) (then ${c(4)}) (else (if (result i32) (i32.eq ${v} ${c(1)}) (then ${c(0)})
      (else (if (result i32) (i32.eq ${v} ${c(2)}) (then ${c(1)}) (else ${c(2)}))))))`;

  // the square channel's NRx4 (GBAudioWriteNR14 / NR24); ch1 also resets the sweep
  const nrx4 = (name, ch, bit, sweep) => `
  (func $${name} (param $v i32)
    (local $was i32) (local $p i32)
    (call $ps_run (call $now) ${c(bit)})
    ${st(c(ch), C_FREQ, `(i32.or (i32.and ${ld(c(ch), C_FREQ)} ${c(0xFF)}) (i32.and (i32.shl ${lg("v")} ${c(8)}) ${c(0x700)}))`)}
    (local.set $was ${ld(c(ch), C_STOP)})
    ${st(c(ch), C_STOP, `(i32.and (i32.shr_u ${lg("v")} ${c(6)}) ${c(1)})`)}
    (if (i32.and (i32.and (i32.eqz ${lg("was")}) (i32.ne ${ld(c(ch), C_STOP)} ${c(0)}))
                 (i32.and (i32.ne ${ld(c(ch), C_LEN)} ${c(0)}) (i32.eqz (i32.and ${g("ps_frame")} ${c(1)}))))
      (then ${st(c(ch), C_LEN, `(i32.sub ${ld(c(ch), C_LEN)} ${c(1)})`)}
            (if (i32.eqz ${ld(c(ch), C_LEN)}) (then ${set(`ps_p${bit === 1 ? 1 : 2}`, c(0))}))))
    (if (i32.and ${lg("v")} ${c(0x80)})
      (then
        (local.set $p (call $env_reset ${c(ch + ENV)}))
        ${set(`ps_p${bit === 1 ? 1 : 2}`, lg("p"))}
        ${sweep ? `${st(c(ch), SW_REAL, ld(c(ch), C_FREQ))}
        (call $sweep_reset ${c(ch)})
        (if (i32.and (i32.ne ${g("ps_p1")} ${c(0)}) (i32.ne ${ld(c(ch), SW_SHIFT)} ${c(0)}))
          (then ${set("ps_p1", `(call $sweep_update ${c(ch)} ${c(1)})`)}))` : ""}
        (if (i32.eqz ${ld(c(ch), C_LEN)})
          (then ${st(c(ch), C_LEN, c(64))}
                (if (i32.and (i32.ne ${ld(c(ch), C_STOP)} ${c(0)}) (i32.eqz (i32.and ${g("ps_frame")} ${c(1)})))
                  (then ${st(c(ch), C_LEN, c(63))}))))
        (call $sq_sample ${c(ch)})))
    (call $nr52_put ${c(bit)} ${g(`ps_p${bit === 1 ? 1 : 2}`)}))`;

  // the three length decrements on an NRx4 write with the stop bit newly set
  const lenStopRule = (lenG, playG) => `
    (if (i32.and (i32.and (i32.eqz ${lg("was")}) (i32.ne ${lg("stop")} ${c(0)}))
                 (i32.and (i32.ne ${g(lenG)} ${c(0)}) (i32.eqz (i32.and ${g("ps_frame")} ${c(1)}))))
      (then ${set(lenG, `(i32.sub ${g(lenG)} ${c(1)})`)}
            (if (i32.eqz ${g(lenG)}) (then ${set(playG, c(0))}))))`;

  // GBAudioUpdateFrame's length step for one channel
  const lenStep = (lenExpr, lenSet, stopExpr, playG, bit) => `
    (if (i32.and (i32.ne ${lenExpr} ${c(0)}) (i32.ne ${stopExpr} ${c(0)}))
      (then ${lenSet(`(i32.sub ${lenExpr} ${c(1)})`)}
            (if (i32.eqz ${lenExpr}) (then ${set(playG, c(0))} (call $nr52_clr ${c(bit)})))))`;

  // GBAudioUpdateFrame's envelope step for a square channel
  const envStep = (ch, playG) => `
    (if (i32.and (i32.ne ${g(playG)} ${c(0)}) (i32.eqz ${ld(c(ch + ENV), E_DEAD)}))
      (then ${st(c(ch + ENV), E_NEXT, `(i32.sub ${ld(c(ch + ENV), E_NEXT)} ${c(1)})`)}
            (if (i32.eqz ${ld(c(ch + ENV), E_NEXT)})
              (then (call $env_update ${c(ch + ENV)}) (call $sq_sample ${c(ch)})))))`;

  // GBAudioRun's square channel step
  const sqRun = (ch, bit, playG) => `
    (if (i32.and (i32.ne (i32.and ${lg("chs")} ${c(bit)}) ${c(0)})
                 (i32.or (i32.or (i32.and (i32.ne ${g(playG)} ${c(0)}) (i32.ne ${ld(c(ch + ENV), E_DEAD)} ${c(2)}))
                                 (i32.gt_s (i32.sub ${lg("ts")} ${ld(c(ch), LASTUPD)}) ${c(0x40000000)}))
                         (i32.eq ${lg("chs")} ${c(bit)})))
      (then
        (local.set $period (i32.mul (i32.mul ${c(4)} (i32.sub ${c(2048)} ${ld(c(ch), C_FREQ)})) ${c(TF)}))
        (local.set $diff (i32.sub ${lg("ts")} ${ld(c(ch), LASTUPD)}))
        (if (i32.ge_s ${lg("diff")} ${lg("period")})
          (then
            (local.set $diff (i32.div_s ${lg("diff")} ${lg("period")}))
            ${st(c(ch), INDEX, `(i32.and (i32.add ${ld(c(ch), INDEX)} ${lg("diff")}) ${c(7)})`)}
            ${st(c(ch), LASTUPD, `(i32.add ${ld(c(ch), LASTUPD)} (i32.mul ${lg("diff")} ${lg("period")}))`)}
            (call $sq_sample ${c(ch)})))))`;

  // GBAAudioSample: one DirectSound channel into a side
  const dsAdd = (side, smp, lrG, volG, bit) => `
        (if (i32.and ${g(lrG)} (i32.eqz (i32.and ${lg("mute")} ${c(bit)}))) (then (local.set $${side} ${sx16(`(i32.add ${lg(side)} (i32.shr_s (i32.shl (i32.load8_s (i32.add ${c(smp)} ${lg("s")})) ${c(2)}) (i32.eqz ${g(volG)})))`)})))`;

  const anyOf = (l, vals) => vals.map((v) => `(i32.eq ${lg(l)} ${c(v)})`).reduce((x, y) => `(i32.or ${x} ${y})`);
  const psgAdd = (side, bitsMask, val) => `(if (i32.and (i32.ne (i32.and ${g("ps_nr51")} ${c(bitsMask)}) ${c(0)}) (i32.eqz (i32.and ${lg("mute")} ${c(bitsMask & 0xF | bitsMask >> 4)}))) (then (local.set $${side} (i32.add ${lg(side)} ${val}))))`;

  return `
  ;; ======================= sound output (gba/audio.c, gb/audio.c) =========
  (global $au_bias (mut i32) (i32.const 0x200))       ;; soundbias
  (global $au_interval (mut i32) (i32.const ${J.gba.resetSampleInterval}))   ;; sampleInterval
  (global $au_last (mut i32) (i32.const 0))           ;; lastSample
  (global $au_idx (mut i32) (i32.const 0))            ;; sampleIndex
  (global $au_vol (mut i32) (i32.const 0))            ;; volume (PSG)
  (global $au_volA (mut i32) (i32.const 0)) (global $au_volB (mut i32) (i32.const 0))
  (global $au_aR (mut i32) (i32.const 0)) (global $au_aL (mut i32) (i32.const 0))
  (global $au_bR (mut i32) (i32.const 0)) (global $au_bL (mut i32) (i32.const 0))
  (global $au_intA (mut i32) (i32.const 0)) (global $au_intB (mut i32) (i32.const 0))   ;; internalSample
  ;; the PSG (struct GBAudio)
  (global $ps_enable (mut i32) (i32.const 0))
  (global $ps_frame (mut i32) (i32.const 0))
  (global $ps_skip (mut i32) (i32.const 0))
  (global $ps_volL (mut i32) (i32.const 0)) (global $ps_volR (mut i32) (i32.const 0))
  (global $ps_nr51 (mut i32) (i32.const 0))           ;; ch1Right..ch4Right, ch1Left..ch4Left
  (global $ps_p1 (mut i32) (i32.const 0)) (global $ps_p2 (mut i32) (i32.const 0))
  (global $ps_p3 (mut i32) (i32.const 0)) (global $ps_p4 (mut i32) (i32.const 0))
  ;; ch3 (GBAudioWaveChannel; the wave RAM is the cart's WAVE block)
  (global $c3_size (mut i32) (i32.const 0)) (global $c3_bank (mut i32) (i32.const 0))
  (global $c3_enable (mut i32) (i32.const 0)) (global $c3_sample (mut i32) (i32.const 0))
  (global $c3_length (mut i32) (i32.const 0)) (global $c3_volume (mut i32) (i32.const 0))
  (global $c3_rate (mut i32) (i32.const 0)) (global $c3_stop (mut i32) (i32.const 0))
  (global $c3_window (mut i32) (i32.const 0)) (global $c3_readable (mut i32) (i32.const 0))
  (global $c3_next (mut i32) (i32.const 0))
  ;; ch4 (GBAudioNoiseChannel; envelope at ENV4)
  (global $c4_ratio (mut i32) (i32.const 0)) (global $c4_freq (mut i32) (i32.const 0))
  (global $c4_power (mut i32) (i32.const 0)) (global $c4_stop (mut i32) (i32.const 0))
  (global $c4_length (mut i32) (i32.const 0)) (global $c4_lfsr (mut i32) (i32.const 0))
  (global $c4_last (mut i32) (i32.const 0)) (global $c4_sample (mut i32) (i32.const 0))
  ;; the PSG's mAudioBuffer (read index, size in frames) and the resampler
  (global $src_r (mut i32) (i32.const 0)) (global $src_n (mut i32) (i32.const 0))
  (global $rs_ts (mut f64) (f64.const 0))

  ;; GBAAudioReset / GBAudioReset: the non-zero fields
  (func $au_reset
    ${st(c(CH1), SW_TIME, c(8))}
    ${st(c(CH1 + ENV), E_DEAD, c(2))}
    ${st(c(CH2 + ENV), E_DEAD, c(2))}
    ${st(c(ENV4), E_DEAD, c(2))})

  ;; SOUNDCNT_X's low nibble is the PSG's nr52 (mGBA points nr52 at the I/O page)
  (func $nr52_clr (param $bit i32)
    (i32.store8 (i32.const ${NR52}) (i32.and (i32.load8_u (i32.const ${NR52})) (i32.xor ${lg("bit")} ${c(-1)}))))
  (func $nr52_put (param $bit i32) (param $on i32)
    (call $nr52_clr ${lg("bit")})
    (if ${lg("on")} (then (i32.store8 (i32.const ${NR52}) (i32.or (i32.load8_u (i32.const ${NR52})) ${lg("bit")})))))

  ;; ---- envelopes and sweep (gb/audio.c statics, GB_AUDIO_GBA style) ----
  (func $env_dead (param $e i32)   ;; _updateEnvelopeDead
    (if (i32.eqz ${ld(lg("e"), E_STEP)})
      (then ${st(lg("e"), E_DEAD, `(if (result i32) ${ld(lg("e"), E_CUR)} (then ${c(1)}) (else ${c(2)}))`)} (return)))
    (if (i32.and (i32.eqz ${ld(lg("e"), E_DIR)}) (i32.eqz ${ld(lg("e"), E_CUR)}))
      (then ${st(lg("e"), E_DEAD, c(2))} (return)))
    (if (i32.and (i32.ne ${ld(lg("e"), E_DIR)} ${c(0)}) (i32.eq ${ld(lg("e"), E_CUR)} ${c(15)}))
      (then ${st(lg("e"), E_DEAD, c(1))} (return)))
    (if ${ld(lg("e"), E_DEAD)}
      (then ${st(lg("e"), E_NEXT, ld(lg("e"), E_STEP))} ${st(lg("e"), E_DEAD, c(0))})))

  (func $env_write (param $e i32) (param $v i32) (result i32)   ;; _writeEnvelope
    ${st(lg("e"), E_STEP, `(i32.and ${lg("v")} ${c(7)})`)}
    ${st(lg("e"), E_DIR, `(i32.and (i32.shr_u ${lg("v")} ${c(3)}) ${c(1)})`)}
    ${st(lg("e"), E_INIT, `(i32.and (i32.shr_u ${lg("v")} ${c(4)}) ${c(15)})`)}
    (if (i32.eqz ${ld(lg("e"), E_STEP)})
      (then ${st(lg("e"), E_CUR, `(i32.and ${ld(lg("e"), E_CUR)} ${c(15)})`)}))
    (call $env_dead ${lg("e")})
    (i32.or (i32.ne ${ld(lg("e"), E_INIT)} ${c(0)}) (i32.ne ${ld(lg("e"), E_DIR)} ${c(0)})))

  (func $env_reset (param $e i32) (result i32)   ;; _resetEnvelope
    ${st(lg("e"), E_CUR, ld(lg("e"), E_INIT))}
    ${st(lg("e"), E_NEXT, ld(lg("e"), E_STEP))}
    (call $env_dead ${lg("e")})
    (i32.or (i32.ne ${ld(lg("e"), E_INIT)} ${c(0)}) (i32.ne ${ld(lg("e"), E_DIR)} ${c(0)})))

  (func $env_update (param $e i32)   ;; _updateEnvelope
    ${st(lg("e"), E_CUR, `(i32.add ${ld(lg("e"), E_CUR)} (if (result i32) ${ld(lg("e"), E_DIR)} (then ${c(1)}) (else ${c(-1)})))`)}
    (if (i32.ge_s ${ld(lg("e"), E_CUR)} ${c(15)})
      (then ${st(lg("e"), E_CUR, c(15))} ${st(lg("e"), E_DEAD, c(1))})
      (else (if (i32.le_s ${ld(lg("e"), E_CUR)} ${c(0)})
        (then ${st(lg("e"), E_CUR, c(0))} ${st(lg("e"), E_DEAD, c(2))})
        (else ${st(lg("e"), E_NEXT, ld(lg("e"), E_STEP))})))))

  (func $write_duty (param $e i32) (param $v i32)   ;; _writeDuty
    ${st(lg("e"), E_LEN, `(i32.and ${lg("v")} ${c(0x3F)})`)}
    ${st(lg("e"), E_DUTY, `(i32.and (i32.shr_u ${lg("v")} ${c(6)}) ${c(3)})`)})

  (func $sq_sample (param $ch i32)   ;; _updateSquareSample
    ${st(lg("ch"), SAMPLE, `(i32.mul (i32.load8_u (i32.add ${c(ST + S.DUTY)} (i32.add (i32.shl ${ld(lg("ch"), ENV + E_DUTY)} ${c(3)}) ${ld(lg("ch"), INDEX)})))
                                   ${ld(lg("ch"), ENV + E_CUR)})`)})

  (func $sweep_write (param $ch i32) (param $v i32) (result i32)   ;; _writeSweep
    (local $old i32) (local $on i32)
    ${st(lg("ch"), SW_SHIFT, `(i32.and ${lg("v")} ${c(7)})`)}
    (local.set $old ${ld(lg("ch"), SW_DIR)})
    ${st(lg("ch"), SW_DIR, `(i32.and (i32.shr_u ${lg("v")} ${c(3)}) ${c(1)})`)}
    (local.set $on ${c(1)})
    (if (i32.and (i32.and (i32.ne ${ld(lg("ch"), SW_OCC)} ${c(0)}) (i32.ne ${lg("old")} ${c(0)})) (i32.eqz ${ld(lg("ch"), SW_DIR)}))
      (then (local.set $on ${c(0)})))
    ${st(lg("ch"), SW_OCC, c(0))}
    ${st(lg("ch"), SW_TIME, `(i32.and (i32.shr_u ${lg("v")} ${c(4)}) ${c(7)})`)}
    (if (i32.eqz ${ld(lg("ch"), SW_TIME)}) (then ${st(lg("ch"), SW_TIME, c(8))}))
    ${lg("on")})

  (func $sweep_reset (param $ch i32)   ;; _resetSweep
    ${st(lg("ch"), SW_STEP, ld(lg("ch"), SW_TIME))}
    ${st(lg("ch"), SW_EN, `(i32.or (i32.ne ${ld(lg("ch"), SW_STEP)} ${c(8)}) (i32.ne ${ld(lg("ch"), SW_SHIFT)} ${c(0)}))`)}
    ${st(lg("ch"), SW_OCC, c(0))})

  (func $sweep_update (param $ch i32) (param $initial i32) (result i32)   ;; _updateSweep
    (local $f i32)
    (if (i32.or ${lg("initial")} (i32.ne ${ld(lg("ch"), SW_TIME)} ${c(8)}))
      (then
        (local.set $f ${ld(lg("ch"), SW_REAL)})
        (if ${ld(lg("ch"), SW_DIR)}
          (then
            (local.set $f (i32.sub ${lg("f")} (i32.shr_s ${lg("f")} ${ld(lg("ch"), SW_SHIFT)})))
            (if (i32.and (i32.eqz ${lg("initial")}) (i32.ge_s ${lg("f")} ${c(0)}))
              (then ${st(lg("ch"), C_FREQ, lg("f"))} ${st(lg("ch"), SW_REAL, lg("f"))})))
          (else
            (local.set $f (i32.add ${lg("f")} (i32.shr_s ${lg("f")} ${ld(lg("ch"), SW_SHIFT)})))
            (if (i32.lt_s ${lg("f")} ${c(2048)})
              (then
                (if (i32.and (i32.eqz ${lg("initial")}) (i32.ne ${ld(lg("ch"), SW_SHIFT)} ${c(0)}))
                  (then ${st(lg("ch"), C_FREQ, lg("f"))} ${st(lg("ch"), SW_REAL, lg("f"))}
                        (if (i32.eqz (call $sweep_update ${lg("ch")} ${c(1)})) (then (return ${c(0)}))))))
              (else (return ${c(0)})))))
        ${st(lg("ch"), SW_OCC, c(1))}))
    ${st(lg("ch"), SW_STEP, ld(lg("ch"), SW_TIME))}
    ${c(1)})

  ;; ---- GBAudioRun (GB_AUDIO_GBA, no GB attached: no mid-run sampling) ----
  (func $ps_run (param $ts i32) (param $chs i32)
    (local $period i32) (local $diff i32) (local $vol i32) (local $start i32) (local $end i32) (local $mask i32)
    (local $iter i32) (local $n i32) (local $carry i32) (local $bits i32) (local $i i32) (local $w i32) (local $p i32)
    (local $cyc i32) (local $last i32) (local $lsb i32) (local $coeff i32)
    (if (i32.eqz ${g("ps_enable")}) (then (return)))
    ${sqRun(CH1, 1, "ps_p1")}
    ${sqRun(CH2, 2, "ps_p2")}
    (if (i32.and ${g("ps_p3")} (i32.ne (i32.and ${lg("chs")} ${c(4)}) ${c(0)}))
      (then
        (local.set $cyc (i32.mul (i32.mul ${c(2)} (i32.sub ${c(2048)} ${g("c3_rate")})) ${c(TF)}))
        (local.set $diff (i32.sub ${lg("ts")} ${g("c3_next")}))
        (if (i32.ge_s ${lg("diff")} ${c(0)})
          (then
            (local.set $diff (i32.add (i32.div_s ${lg("diff")} ${lg("cyc")}) ${c(1)}))
            (local.set $vol ${volShift(g("c3_volume"))})
            (local.set $start ${c(7)}) (local.set $end ${c(0)}) (local.set $mask ${c(0x1F)})
            (if ${g("c3_size")} (then (local.set $mask ${c(0x3F)}))
              (else (if ${g("c3_bank")} (then (local.set $end ${c(4)})) (else (local.set $start ${c(3)})))))
            (local.set $n (i32.and ${lg("diff")} ${lg("mask")}))
            (local.set $iter ${c(0)})
            (block $d (loop $l
              (br_if $d (i32.ge_s ${lg("iter")} ${lg("n")}))
              (local.set $carry (i32.and (i32.load (i32.add ${c(WAVE)} (i32.shl ${lg("end")} ${c(2)}))) ${c(0xF0)}))
              (local.set $i ${lg("start")})
              (block $d2 (loop $l2
                (br_if $d2 (i32.lt_s ${lg("i")} ${lg("end")}))
                (local.set $p (i32.add ${c(WAVE)} (i32.shl ${lg("i")} ${c(2)})))
                (local.set $w (i32.load ${lg("p")}))
                (local.set $bits (i32.and ${lg("w")} ${c(0xF0)}))
                (i32.store ${lg("p")} (i32.or (i32.or (i32.shl (i32.and ${lg("w")} ${c(0x0F0F0F0F)}) ${c(4)})
                                                      (i32.shr_u (i32.and ${lg("w")} ${c(0xF0F0F000 | 0)}) ${c(12)}))
                                              (i32.shl ${lg("carry")} ${c(20)})))
                (local.set $carry ${lg("bits")})
                (local.set $i (i32.sub ${lg("i")} ${c(1)}))
                (br $l2)))
              ${set("c3_sample", sx8(`(i32.shr_u ${lg("carry")} ${c(4)})`))}
              (local.set $iter (i32.add ${lg("iter")} ${c(1)}))
              (br $l)))
            (if (i32.gt_s ${g("c3_volume")} ${c(3)})
              (then ${set("c3_sample", sx8(`(i32.add ${g("c3_sample")} (i32.shl ${g("c3_sample")} ${c(1)}))`))}))
            ${set("c3_sample", sx8(`(i32.shr_s ${g("c3_sample")} ${lg("vol")})`))}
            ${set("c3_next", `(i32.add ${g("c3_next")} (i32.mul ${lg("diff")} ${lg("cyc")}))`)}
            ${set("c3_readable", c(1))}))))
    (if (i32.and ${g("ps_p4")} (i32.ne (i32.and ${lg("chs")} ${c(8)}) ${c(0)}))
      (then
        (local.set $cyc (if (result i32) ${g("c4_ratio")} (then (i32.mul ${c(2)} ${g("c4_ratio")})) (else ${c(1)})))
        (local.set $cyc (i32.shl ${lg("cyc")} ${g("c4_freq")}))
        (local.set $cyc (i32.mul ${lg("cyc")} ${c(8 * TF)}))
        (local.set $diff (i32.sub ${lg("ts")} ${g("c4_last")}))
        (if (i32.ge_s ${lg("diff")} ${lg("cyc")})
          (then
            (local.set $last ${c(0)}) (local.set $lsb ${c(0)})
            (if ${g("c4_power")}
              (then (local.set $coeff ${c(0x4040)}))
              (else
                (local.set $bits ${c(0)})
                (block $d (loop $l
                  (br_if $d (i32.gt_s (i32.add ${lg("last")} (i32.mul ${lg("cyc")} ${c(5)})) ${lg("diff")}))
                  (local.set $bits (i32.and ${g("c4_lfsr")} ${c(0x3F)}))
                  ${set("c4_lfsr", `(i32.shr_u ${g("c4_lfsr")} ${c(5)})`)}
                  ${set("c4_lfsr", `(i32.or ${g("c4_lfsr")} (i32.shr_s (i32.mul ${c(0x4000)} (i32.load8_u (i32.add ${c(ST + S.NMASK)} ${lg("bits")}))) ${c(4)}))`)}
                  ${set("c4_lfsr", `(i32.and ${g("c4_lfsr")} ${c(0x7FFF)})`)}
                  (local.set $last (i32.add ${lg("last")} (i32.mul ${lg("cyc")} ${c(5)})))
                  (br $l)))
                (local.set $lsb (i32.and (i32.load8_u (i32.add ${c(ST + S.NMASK)} ${lg("bits")})) ${c(1)}))
                (local.set $coeff ${c(0x4000)})))
            (block $d (loop $l
              (br_if $d (i32.gt_s (i32.add ${lg("last")} ${lg("cyc")}) ${lg("diff")}))
              (local.set $lsb (i32.and (i32.xor (i32.xor ${g("c4_lfsr")} (i32.shr_u ${g("c4_lfsr")} ${c(1)})) ${c(1)}) ${c(1)}))
              ${set("c4_lfsr", `(i32.shr_u ${g("c4_lfsr")} ${c(1)})`)}
              (if ${lg("lsb")}
                (then ${set("c4_lfsr", `(i32.or ${g("c4_lfsr")} ${lg("coeff")})`)})
                (else ${set("c4_lfsr", `(i32.and ${g("c4_lfsr")} (i32.xor ${lg("coeff")} ${c(-1)}))`)}))
              (local.set $last (i32.add ${lg("last")} ${lg("cyc")}))
              (br $l)))
            ${set("c4_sample", sx8(`(i32.mul ${lg("lsb")} ${ld(c(ENV4), E_CUR)})`))}
            ${set("c4_last", `(i32.add ${g("c4_last")} ${lg("last")})`)})))))

  ;; ---- GBAudioUpdateFrame (the frame sequencer event's PSG half) ----
  (func $ps_update_frame
    (local $f i32) (local $old i32)
    (if (i32.eqz ${g("ps_enable")}) (then (return)))
    (if ${g("ps_skip")} (then ${set("ps_skip", c(0))} (return)))
    (call $ps_run (call $now) ${c(7)})
    (local.set $f (i32.and (i32.add ${g("ps_frame")} ${c(1)}) ${c(7)}))
    ${set("ps_frame", lg("f"))}
    (if (i32.or (i32.eq ${lg("f")} ${c(2)}) (i32.eq ${lg("f")} ${c(6)}))
      (then
        (if ${ld(c(CH1), SW_EN)}
          (then
            ${st(c(CH1), SW_STEP, `(i32.sub ${ld(c(CH1), SW_STEP)} ${c(1)})`)}
            (if (i32.eqz ${ld(c(CH1), SW_STEP)})
              (then
                (if (i32.eqz (call $sweep_update ${c(CH1)} ${c(0)})) (then ${set("ps_p1", c(0))}))
                (call $nr52_put ${c(1)} ${g("ps_p1")})))))))
    (if (i32.eqz (i32.and ${lg("f")} ${c(1)}))
      (then
        ${lenStep(ld(c(CH1), C_LEN), (v) => st(c(CH1), C_LEN, v), ld(c(CH1), C_STOP), "ps_p1", 1)}
        ${lenStep(ld(c(CH2), C_LEN), (v) => st(c(CH2), C_LEN, v), ld(c(CH2), C_STOP), "ps_p2", 2)}
        ${lenStep(g("c3_length"), (v) => set("c3_length", v), g("c3_stop"), "ps_p3", 4)}
        ${lenStep(g("c4_length"), (v) => set("c4_length", v), g("c4_stop"), "ps_p4", 8)}
        (return)))
    (if (i32.eq ${lg("f")} ${c(7)})
      (then
        ${envStep(CH1, "ps_p1")}
        ${envStep(CH2, "ps_p2")}
        (if (i32.and (i32.ne ${g("ps_p4")} ${c(0)}) (i32.eqz ${ld(c(ENV4), E_DEAD)}))
          (then ${st(c(ENV4), E_NEXT, `(i32.sub ${ld(c(ENV4), E_NEXT)} ${c(1)})`)}
                (if (i32.eqz ${ld(c(ENV4), E_NEXT)})
                  (then
                    (local.set $old ${g("c4_sample")})
                    (call $env_update ${c(ENV4)})
                    ${set("c4_sample", sx8(`(i32.mul (i32.gt_s ${lg("old")} ${c(0)}) ${ld(c(ENV4), E_CUR)})`))})))))))

  ;; ---- the PSG register writes (GBAudioWriteNRxx, value as uint8_t) ----
  (func $nr10 (param $v i32)
    (call $ps_run (call $now) ${c(1)})
    (if (i32.eqz (call $sweep_write ${c(CH1)} ${lg("v")})) (then ${set("ps_p1", c(0))} (call $nr52_clr ${c(1)}))))
  (func $nr11 (param $v i32)
    (call $ps_run (call $now) ${c(1)})
    (call $write_duty ${c(CH1 + ENV)} ${lg("v")})
    ${st(c(CH1), C_LEN, `(i32.sub ${c(64)} ${ld(c(CH1 + ENV), E_LEN)})`)})
  (func $nr12 (param $v i32)
    (call $ps_run (call $now) ${c(1)})
    (if (i32.eqz (call $env_write ${c(CH1 + ENV)} ${lg("v")})) (then ${set("ps_p1", c(0))} (call $nr52_clr ${c(1)}))))
  (func $nr13 (param $v i32)
    (call $ps_run (call $now) ${c(1)})
    ${st(c(CH1), C_FREQ, `(i32.or (i32.and ${ld(c(CH1), C_FREQ)} ${c(0x700)}) ${lg("v")})`)})
  ${nrx4("nr14", CH1, 1, true)}
  (func $nr21 (param $v i32)
    (call $ps_run (call $now) ${c(2)})
    (call $write_duty ${c(CH2 + ENV)} ${lg("v")})
    ${st(c(CH2), C_LEN, `(i32.sub ${c(64)} ${ld(c(CH2 + ENV), E_LEN)})`)})
  (func $nr22 (param $v i32)
    (call $ps_run (call $now) ${c(2)})
    (if (i32.eqz (call $env_write ${c(CH2 + ENV)} ${lg("v")})) (then ${set("ps_p2", c(0))} (call $nr52_clr ${c(2)}))))
  (func $nr23 (param $v i32)
    (call $ps_run (call $now) ${c(2)})
    ${st(c(CH2), C_FREQ, `(i32.or (i32.and ${ld(c(CH2), C_FREQ)} ${c(0x700)}) ${lg("v")})`)})
  ${nrx4("nr24", CH2, 2, false)}
  (func $nr30 (param $v i32)
    (call $ps_run (call $now) ${c(4)})
    ${set("c3_enable", `(i32.and (i32.shr_u ${lg("v")} ${c(7)}) ${c(1)})`)}
    (if (i32.eqz ${g("c3_enable")}) (then ${set("ps_p3", c(0))} (call $nr52_clr ${c(4)}))))
  (func $nr31 (param $v i32)
    (call $ps_run (call $now) ${c(4)})
    ${set("c3_length", `(i32.sub ${c(256)} ${lg("v")})`)})
  (func $nr32 (param $v i32)   ;; only reached from NR52's power-off
    (local $s i32)
    (call $ps_run (call $now) ${c(4)})
    ${set("c3_volume", `(i32.and (i32.shr_u ${lg("v")} ${c(5)}) ${c(3)})`)}
    (local.set $s ${sx8(`(i32.load8_u (i32.add ${c(WAVE)} (i32.shr_u ${g("c3_window")} ${c(1)})))`)})
    (if (i32.eqz (i32.and ${g("c3_window")} ${c(1)})) (then (local.set $s (i32.shr_s ${lg("s")} ${c(4)}))))
    (local.set $s (i32.and ${lg("s")} ${c(0xF)}))
    ${set("c3_sample", `(i32.shr_s ${lg("s")} ${volShift(g("c3_volume"))})`)})
  (func $nr33 (param $v i32)
    (call $ps_run (call $now) ${c(4)})
    ${set("c3_rate", `(i32.or (i32.and ${g("c3_rate")} ${c(0x700)}) ${lg("v")})`)})
  (func $nr34 (param $v i32)
    (local $was i32) (local $stop i32)
    (call $ps_run (call $now) ${c(4)})
    ${set("c3_rate", `(i32.or (i32.and ${g("c3_rate")} ${c(0xFF)}) (i32.and (i32.shl ${lg("v")} ${c(8)}) ${c(0x700)}))`)}
    (local.set $was ${g("c3_stop")})
    (local.set $stop (i32.and (i32.shr_u ${lg("v")} ${c(6)}) ${c(1)}))
    ${set("c3_stop", lg("stop"))}
    ${lenStopRule("c3_length", "ps_p3")}
    (if (i32.and ${lg("v")} ${c(0x80)})
      (then
        ${set("ps_p3", g("c3_enable"))}
        (if (i32.eqz ${g("c3_length")})
          (then ${set("c3_length", c(256))}
                (if (i32.and (i32.ne ${g("c3_stop")} ${c(0)}) (i32.eqz (i32.and ${g("ps_frame")} ${c(1)})))
                  (then ${set("c3_length", c(255))}))))
        ${set("c3_window", c(0))}))
    (if ${g("ps_p3")}
      (then ${set("c3_readable", c(1))}
            ${set("c3_next", `(i32.add (call $now) (i32.mul (i32.add ${c(6)} (i32.mul ${c(2)} (i32.sub ${c(2048)} ${g("c3_rate")}))) ${c(TF)}))`)}))
    (call $nr52_put ${c(4)} ${g("ps_p3")}))
  (func $nr41 (param $v i32)
    (call $ps_run (call $now) ${c(8)})
    (call $write_duty ${c(ENV4)} ${lg("v")})
    ${set("c4_length", `(i32.sub ${c(64)} ${ld(c(ENV4), E_LEN)})`)})
  (func $nr42 (param $v i32)
    (call $ps_run (call $now) ${c(8)})
    (if (i32.eqz (call $env_write ${c(ENV4)} ${lg("v")})) (then ${set("ps_p4", c(0))} (call $nr52_clr ${c(8)}))))
  (func $nr43 (param $v i32)
    (call $ps_run (call $now) ${c(8)})
    ${set("c4_ratio", `(i32.and ${lg("v")} ${c(7)})`)}
    ${set("c4_freq", `(i32.and (i32.shr_u ${lg("v")} ${c(4)}) ${c(15)})`)}
    ${set("c4_power", `(i32.and (i32.shr_u ${lg("v")} ${c(3)}) ${c(1)})`)})
  (func $nr44 (param $v i32)
    (local $was i32) (local $stop i32)
    (call $ps_run (call $now) ${c(8)})
    (local.set $was ${g("c4_stop")})
    (local.set $stop (i32.and (i32.shr_u ${lg("v")} ${c(6)}) ${c(1)}))
    ${set("c4_stop", lg("stop"))}
    ${lenStopRule("c4_length", "ps_p4")}
    (if (i32.and ${lg("v")} ${c(0x80)})
      (then
        ${set("ps_p4", `(call $env_reset ${c(ENV4)})`)}
        ${set("c4_lfsr", c(0))}
        (if (i32.eqz ${g("c4_length")})
          (then ${set("c4_length", c(64))}
                (if (i32.and (i32.ne ${g("c4_stop")} ${c(0)}) (i32.eqz (i32.and ${g("ps_frame")} ${c(1)})))
                  (then ${set("c4_length", c(63))}))))
        (if ${g("ps_p4")} (then ${set("c4_last", "(call $now)")}))))
    (call $nr52_put ${c(8)} ${g("ps_p4")}))
  (func $nr50 (param $v i32)
    (call $ps_run (call $now) ${c(15)})
    ${set("ps_volR", `(i32.and ${lg("v")} ${c(7)})`)}
    ${set("ps_volL", `(i32.and (i32.shr_u ${lg("v")} ${c(4)}) ${c(7)})`)})
  (func $nr51 (param $v i32)
    (call $ps_run (call $now) ${c(15)})
    ${set("ps_nr51", lg("v"))})
  (func $nr52 (param $v i32)
    (local $was i32)
    (local.set $was ${g("ps_enable")})
    ${set("ps_enable", `(i32.and (i32.shr_u ${lg("v")} ${c(7)}) ${c(1)})`)}
    (if (i32.eqz ${g("ps_enable")})
      (then
        ${set("ps_p1", c(0))} ${set("ps_p2", c(0))} ${set("ps_p3", c(0))} ${set("ps_p4", c(0))}
        (call $nr10 ${c(0)}) (call $nr12 ${c(0)}) (call $nr13 ${c(0)}) (call $nr14 ${c(0)})
        (call $nr22 ${c(0)}) (call $nr23 ${c(0)}) (call $nr24 ${c(0)})
        (call $nr30 ${c(0)}) (call $nr32 ${c(0)}) (call $nr33 ${c(0)}) (call $nr34 ${c(0)})
        (call $nr42 ${c(0)}) (call $nr43 ${c(0)}) (call $nr44 ${c(0)})
        (call $nr50 ${c(0)}) (call $nr51 ${c(0)})
        (call $nr11 ${c(0)}) (call $nr21 ${c(0)}) (call $nr31 ${c(0)}) (call $nr41 ${c(0)})
        (call $nr52_clr ${c(15)}))
      (else (if (i32.eqz ${lg("was")})
        (then ${set("ps_skip", c(0))} ${set("ps_frame", c(7))})))))

  ;; ---- GBAudioSamplePSG (GB_AUDIO_GBA: no DC offset, raw noise) ----
  (func $ps_sample (result i64)   ;; left | right << 32, each int16_t
    (local $l i32) (local $r i32) (local $n i32) (local $mute i32)
    (local.set $mute (i32.load8_u (i32.const ${ST + S.MUTE})))
    ${psgAdd("l", 0x10, ld(c(CH1), SAMPLE))} ${psgAdd("r", 0x01, ld(c(CH1), SAMPLE))}
    ${psgAdd("l", 0x20, ld(c(CH2), SAMPLE))} ${psgAdd("r", 0x02, ld(c(CH2), SAMPLE))}
    ${psgAdd("l", 0x40, g("c3_sample"))} ${psgAdd("r", 0x04, g("c3_sample"))}
    (local.set $l (i32.shl ${lg("l")} ${c(3)}))
    (local.set $r (i32.shl ${lg("r")} ${c(3)}))
    (local.set $n ${sx16(`(i32.shl ${g("c4_sample")} ${c(3)})`)})
    ${psgAdd("l", 0x80, lg("n"))} ${psgAdd("r", 0x08, lg("n"))}
    (local.set $l ${sx16(`(i32.mul ${lg("l")} (i32.add ${c(1)} ${g("ps_volL")}))`)})
    (local.set $r ${sx16(`(i32.mul ${lg("r")} (i32.add ${c(1)} ${g("ps_volR")}))`)})
    (i64.or (i64.extend_i32_u (i32.and ${lg("l")} ${c(0xFFFF)})) (i64.shl (i64.extend_i32_u (i32.and ${lg("r")} ${c(0xFFFF)})) (i64.const 32))))

  ;; _applyBias
  (func $au_bias_apply (param $s i32) (result i32)
    (local $b i32)
    (local.set $b (i32.and ${g("au_bias")} ${c(0x3FF)}))
    (local.set $s (i32.add ${lg("s")} ${lg("b")}))
    (if (i32.ge_s ${lg("s")} ${c(0x400)}) (then (local.set $s ${c(0x3FF)}))
      (else (if (i32.lt_s ${lg("s")} ${c(0)}) (then (local.set $s ${c(0)})))))
    (i32.shr_s (i32.mul (i32.mul (i32.sub ${lg("s")} ${lg("b")}) ${c(J.gba.volumeMax)}) ${c(3)}) ${c(4)}))

  ;; GBAAudioSample
  (func $au_sample (param $ts i32)
    (local $max i32) (local $s i32) (local $l i32) (local $r i32) (local $shift i32) (local $lr i64) (local $p i32) (local $mute i32)
    (local.set $mute (i32.load8_u (i32.const ${ST + S.MUTE})))
    (local.set $ts (i32.sub ${lg("ts")} ${g("au_last")}))
    (local.set $ts (i32.sub ${lg("ts")} (i32.mul ${g("au_idx")} ${g("au_interval")})))
    (local.set $max (i32.shl ${c(2)} ${res}))
    (local.set $s ${g("au_idx")})
    (block $d (loop $l
      (br_if $d (i32.lt_s ${lg("ts")} ${g("au_interval")}))
      (br_if $d (i32.ge_s ${lg("s")} ${lg("max")}))
      (local.set $shift (i32.sub ${c(4)} ${g("au_vol")}))
      (call $ps_run (i32.add (i32.mul ${lg("s")} ${g("au_interval")}) ${g("au_last")}) ${c(15)})
      (local.set $lr (call $ps_sample))
      (local.set $l (i32.shr_s ${sx16(`(i32.wrap_i64 ${lg("lr")})`)} ${lg("shift")}))
      (local.set $r (i32.shr_s ${sx16(`(i32.wrap_i64 (i64.shr_u ${lg("lr")} (i64.const 32)))`)} ${lg("shift")}))
      ${dsAdd("l", ST + S.SMPA, "au_aL", "au_volA", 16)}
      ${dsAdd("r", ST + S.SMPA, "au_aR", "au_volA", 16)}
      ${dsAdd("l", ST + S.SMPB, "au_bL", "au_volB", 32)}
      ${dsAdd("r", ST + S.SMPB, "au_bR", "au_volB", 32)}
      (local.set $p (i32.add ${c(ST + S.CUR)} (i32.shl ${lg("s")} ${c(2)})))
      (i32.store16 ${lg("p")} (call $au_bias_apply ${lg("l")}))
      (i32.store16 offset=2 ${lg("p")} (call $au_bias_apply ${lg("r")}))
      (local.set $s (i32.add ${lg("s")} ${c(1)}))
      (local.set $ts (i32.sub ${lg("ts")} ${g("au_interval")}))
      (br $l)))
    ${set("au_idx", lg("s"))}
    (if (i32.eq ${lg("s")} ${lg("max")})
      (then ${set("au_last", `(i32.add ${g("au_last")} ${c(J.gba.sampleEventCycles)})`)} ${set("au_idx", c(0))})))

  ;; _sample (the GBA sample event): mix, then append 2 << resolution frames
  ;; to the PSG's mAudioBuffer (a full buffer takes what fits)
  (func $au_sample_event (param $late i32)
    (local $n i32) (local $i i32) (local $w i32)
    (call $au_sample (i32.sub (call $now) ${lg("late")}))
    (local.set $n (i32.shl ${c(2)} ${res}))
    (memory.fill ${c(ST + S.SMPA)} (i32.load8_u (i32.add ${c(ST + S.SMPA - 1)} ${lg("n")})) ${c(J.gba.maxSamples)})
    (memory.fill ${c(ST + S.SMPB)} (i32.load8_u (i32.add ${c(ST + S.SMPB - 1)} ${lg("n")})) ${c(J.gba.maxSamples)})
    ;; the debug copy of what this event hands the buffer (the whole block, before the buffer's own limit)
    (local.set $w (i32.load (i32.const ${A.NATIVE})))
    (if (i32.le_u (i32.add ${lg("w")} ${lg("n")}) ${c(NATIVE_CAP)})
      (then (memory.copy (i32.add ${c(A.NATIVE + 16)} (i32.shl ${lg("w")} ${c(2)})) ${c(ST + S.CUR)} (i32.shl ${lg("n")} ${c(2)}))
            (i32.store (i32.const ${A.NATIVE}) (i32.add ${lg("w")} ${lg("n")}))))
    (if (i32.gt_u ${lg("n")} (i32.sub ${c(SRC_CAP)} ${g("src_n")})) (then (local.set $n (i32.sub ${c(SRC_CAP)} ${g("src_n")}))))
    (local.set $i ${c(0)})
    (block $d (loop $l
      (br_if $d (i32.ge_u ${lg("i")} ${lg("n")}))
      (local.set $w (i32.and (i32.add ${g("src_r")} ${g("src_n")}) ${c(SRC_CAP - 1)}))
      (i32.store (i32.add ${c(A.SRC)} (i32.shl ${lg("w")} ${c(2)})) (i32.load (i32.add ${c(ST + S.CUR)} (i32.shl ${lg("i")} ${c(2)}))))
      ${set("src_n", `(i32.add ${g("src_n")} ${c(1)})`)}
      (local.set $i (i32.add ${lg("i")} ${c(1)}))
      (br $l))))

  ;; top of every emulated frame (retro_run): the native debug stream restarts
  (func $au_frame_begin
    (i32.store (i32.const ${A.NATIVE}) ${c(0)}))

  ;; _updateFrame (the PSG frame sequencer event, GBA side)
  (func $au_frame_event (param $late i32)
    (call $au_sample (call $now))
    (call $ps_update_frame))

  ;; GBAAudioSampleFIFO, the half the cart's $fifo_sample does not do: the
  ;; channel's internal sample and its per-sample slots
  (func $au_fifo_load (param $id i32) (param $rd i32)
    (if ${lg("id")}
      (then ${set("au_intB", `(i32.load (i32.add ${c(ST + S.FIFOB)} (i32.shl ${lg("rd")} ${c(2)})))`)})
      (else ${set("au_intA", `(i32.load (i32.add ${c(ST + S.FIFOA)} (i32.shl ${lg("rd")} ${c(2)})))`)})))
  (func $au_fifo_fill (param $id i32) (param $rem i32)
    (local $until i32) (local $bits i32) (local $sh i32) (local $i i32) (local $smp i32) (local $v i32)
    (local.set $sh (i32.sub ${c(9)} ${res}))
    (local.set $until (i32.sub (call $until ${c(evSample)}) ${c(1)}))
    (local.set $bits (i32.shl ${c(2)} ${res}))
    (local.set $until (i32.add ${lg("until")} (i32.shl ${c(1)} ${lg("sh")})))
    (local.set $until (i32.shr_s ${lg("until")} ${lg("sh")}))
    (if (i32.lt_s ${lg("bits")} ${lg("until")}) (then (local.set $until ${lg("bits")})))
    (local.set $smp (if (result i32) ${lg("id")} (then ${c(ST + S.SMPB)}) (else ${c(ST + S.SMPA)})))
    (local.set $v (if (result i32) ${lg("id")} (then ${g("au_intB")}) (else ${g("au_intA")})))
    (local.set $i (i32.sub ${lg("bits")} ${lg("until")}))
    (block $d (loop $l
      (br_if $d (i32.ge_s ${lg("i")} ${lg("bits")}))
      (i32.store8 (i32.add ${lg("smp")} ${lg("i")}) ${lg("v")})
      (local.set $i (i32.add ${lg("i")} ${c(1)}))
      (br $l)))
    (if ${lg("rem")}
      (then (if ${lg("id")}
        (then ${set("au_intB", `(i32.shr_u ${g("au_intB")} ${c(8)})`)})
        (else ${set("au_intA", `(i32.shr_u ${g("au_intA")} ${c(8)})`)})))))
  ;; GBAAudioWriteFIFO's store (the cart advances the ring)
  (func $au_fifo_write (param $b i32) (param $v i32)
    (if ${lg("b")}
      (then (i32.store (i32.add ${c(ST + S.FIFOB)} (i32.shl (global.get $chBWrite) ${c(2)})) ${lg("v")}))
      (else (i32.store (i32.add ${c(ST + S.FIFOA)} (i32.shl (global.get $chAWrite) ${c(2)})) ${lg("v")}))))

  ;; GBAAudioRead/WriteWaveRAM run ch3 up to now before the access
  (func $au_wave_run
    (call $ps_run (call $now) ${c(4)}))

  ;; debug builds (options.audioTrace): every sound register write, as
  ;; (time, address | width << 16, value), into a ring after the audio block;
  ;; the u32 before the ring counts entries
  (func $au_trace (param $a i32) (param $v i32)
    ${opts.trace ? `(local $n i32) (local $p i32)
    (local.set $n (i32.load (i32.const ${A.TRACE - 4})))
    (local.set $p (i32.add ${c(A.TRACE)} (i32.mul (i32.and ${lg("n")} ${c(A.TRACE_ENTRIES - 1)}) ${c(12)})))
    (i32.store ${lg("p")} (call $now))
    (i32.store offset=4 ${lg("p")} ${lg("a")})
    (i32.store offset=8 ${lg("p")} ${lg("v")})
    (i32.store (i32.const ${A.TRACE - 4}) (i32.add ${lg("n")} ${c(1)}))` : ""})

  ;; GBAIOWrite's sound cases (value as written, before the register mask),
  ;; after its "audio off" filter
  (func $au_io_write (param $a i32) (param $v i32)
    (local $ts i32) (local $old i32) (local $r i32)
    (call $au_trace (i32.or ${lg("a")} ${c(0x20000)}) ${lg("v")})
    (if (i32.eq ${lg("a")} ${c(0x82)})   ;; GBAAudioWriteSOUNDCNT_HI
      (then
        ${set("au_vol", `(i32.and ${lg("v")} ${c(3)})`)}
        ${set("au_volA", `(i32.and (i32.shr_u ${lg("v")} ${c(2)}) ${c(1)})`)}
        ${set("au_volB", `(i32.and (i32.shr_u ${lg("v")} ${c(3)}) ${c(1)})`)}
        ${set("au_aR", `(i32.and (i32.shr_u ${lg("v")} ${c(8)}) ${c(1)})`)}
        ${set("au_aL", `(i32.and (i32.shr_u ${lg("v")} ${c(9)}) ${c(1)})`)}
        ${set("au_bR", `(i32.and (i32.shr_u ${lg("v")} ${c(12)}) ${c(1)})`)}
        ${set("au_bL", `(i32.and (i32.shr_u ${lg("v")} ${c(13)}) ${c(1)})`)}
        (return)))
    (if (i32.eq ${lg("a")} ${c(0x88)})   ;; GBAAudioWriteSOUNDBIAS (GBAIOWrite masks first)
      (then
        (local.set $v (i32.and ${lg("v")} ${c(0xC3FE)}))
        (local.set $ts (call $now))
        (call $au_sample ${lg("ts")})
        ${set("au_bias", lg("v"))}
        (local.set $old ${g("au_interval")})
        (local.set $r (i32.and (i32.shr_u ${lg("v")} ${c(14)}) ${c(3)}))
        ${set("au_interval", `(i32.shr_u ${c(0x200)} ${lg("r")})`)}
        (if (i32.ne ${lg("old")} ${g("au_interval")})
          (then
            (local.set $ts (i32.sub ${lg("ts")} ${g("au_last")}))
            ${set("au_idx", `(i32.shr_s ${lg("ts")} (i32.sub ${c(9)} ${lg("r")}))`)}
            (if (i32.ge_s ${g("au_idx")} ${c(J.gba.maxSamples)}) (then ${set("au_idx", c(0))}))))
        (return)))
    (if (i32.eq ${lg("a")} ${c(0x60)}) (then (call $au_sample (call $now)) (call $nr10 (i32.and ${lg("v")} ${c(0xFF)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x62)}) (then (call $au_sample (call $now)) (call $nr11 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr12 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x64)}) (then (call $au_sample (call $now)) (call $nr13 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr14 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x68)}) (then (call $au_sample (call $now)) (call $nr21 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr22 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x6C)}) (then (call $au_sample (call $now)) (call $nr23 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr24 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x70)})
      (then (call $au_sample (call $now)) ${set("c3_size", `(i32.and (i32.shr_u ${lg("v")} ${c(5)}) ${c(1)})`)}
            ${set("c3_bank", `(i32.and (i32.shr_u ${lg("v")} ${c(6)}) ${c(1)})`)}
            (call $nr30 (i32.and ${lg("v")} ${c(0xFF)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x72)})
      (then (call $au_sample (call $now)) (call $nr31 (i32.and ${lg("v")} ${c(0xFF)}))
            ${set("c3_volume", `(i32.and (i32.shr_u ${lg("v")} ${c(13)}) ${c(7)})`)} (return)))
    (if (i32.eq ${lg("a")} ${c(0x74)}) (then (call $au_sample (call $now)) (call $nr33 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr34 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x78)}) (then (call $au_sample (call $now)) (call $nr41 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr42 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x7C)}) (then (call $au_sample (call $now)) (call $nr43 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr44 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x80)}) (then (call $au_sample (call $now)) (call $nr50 (i32.and ${lg("v")} ${c(0xFF)})) (call $nr51 (i32.shr_u ${lg("v")} ${c(8)})) (return)))
    (if (i32.eq ${lg("a")} ${c(0x84)})   ;; GBAAudioWriteSOUNDCNT_X
      (then
        (call $au_sample (call $now))
        (call $nr52 (i32.and ${lg("v")} ${c(0xFF)}))
        (if (i32.eqz (i32.and ${lg("v")} ${c(0x80)}))
          (then ${set("c3_size", c(0))} ${set("c3_bank", c(0))} ${set("c3_volume", c(0))}
                ${set("au_vol", c(0))} ${set("au_volA", c(0))} ${set("au_volB", c(0))})))))

  ;; GBAIOWrite8's PSG byte cases
  (func $au_io_write8 (param $a i32) (param $v i32)
    (call $au_trace (i32.or ${lg("a")} ${c(0x10000)}) ${lg("v")})
    (if (i32.or (i32.lt_u ${lg("a")} ${c(0x62)}) (i32.gt_u ${lg("a")} ${c(0x7D)})) (then (return)))
    (block $sw
      (br_if $sw (i32.eqz ${anyOf("a", [0x62, 0x63, 0x64, 0x65, 0x68, 0x69, 0x6C, 0x6D, 0x72, 0x73, 0x74, 0x75, 0x78, 0x79, 0x7C, 0x7D])}))
      (call $au_sample (call $now))
      (if (i32.eq ${lg("a")} ${c(0x62)}) (then (call $nr11 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x63)}) (then (call $nr12 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x64)}) (then (call $nr13 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x65)}) (then (call $nr14 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x68)}) (then (call $nr21 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x69)}) (then (call $nr22 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x6C)}) (then (call $nr23 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x6D)}) (then (call $nr24 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x72)}) (then (call $nr31 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x73)}) (then ${set("c3_volume", `(i32.and (i32.shr_u ${lg("v")} ${c(5)}) ${c(7)})`)}))
      (if (i32.eq ${lg("a")} ${c(0x74)}) (then (call $nr33 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x75)}) (then (call $nr34 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x78)}) (then (call $nr41 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x79)}) (then (call $nr42 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x7C)}) (then (call $nr43 ${lg("v")})))
      (if (i32.eq ${lg("a")} ${c(0x7D)}) (then (call $nr44 ${lg("v")})))))

  ;; ---- the libretro frontend: drain after retro_run, resample to ${AUDIO_RATE} Hz ----
  ;; _sampleAt: mAudioBufferPeek (0 before the start or past the end)
  (func $src_at (param $i i32) (param $ch i32) (result i32)
    (if (i32.lt_s ${lg("i")} ${c(0)}) (then (return ${c(0)})))
    (if (i32.ge_u ${lg("i")} ${g("src_n")}) (then (return ${c(0)})))
    (i32.load16_s (i32.add (i32.add ${c(A.SRC)} (i32.shl (i32.and (i32.add ${g("src_r")} ${lg("i")}) ${c(SRC_CAP - 1)}) ${c(2)}))
                           (i32.shl ${lg("ch")} ${c(1)}))))

  ;; mInterpolatorSincInterpolate
  (func $sinc_interp (param $time f64) (param $step f64) (param $ch i32) (result i32)
    (local $index i32) (local $sub f64) (local $stp i32) (local $ys i32) (local $xs i32)
    (local $sum f64) (local $ksum f64) (local $k f64) (local $i i32) (local $a i32) (local $w i32) (local $s i32)
    (local.set $index (i32.trunc_sat_f64_s ${lg("time")}))
    (local.set $sub (f64.sub ${lg("time")} (f64.floor ${lg("time")})))
    (local.set $stp (if (result i32) (f64.lt ${lg("step")} (f64.const 1))
      (then (i32.trunc_sat_f64_u (f64.mul (f64.const ${RES}) ${lg("step")}))) (else ${c(RES)})))
    (local.set $ys (i32.trunc_sat_f64_u (f64.mul ${lg("sub")} (f64.convert_i32_u ${lg("stp")}))))
    (local.set $xs (i32.trunc_sat_f64_u (f64.mul ${lg("sub")} (f64.const ${RES}))))
    (local.set $i ${c(1 - WIDTH)})
    (block $d (loop $l
      (br_if $d (i32.gt_s ${lg("i")} ${c(WIDTH)}))
      (local.set $a (if (result i32) (i32.ge_s ${lg("i")} ${c(0)}) (then ${lg("i")}) (else (i32.sub ${c(0)} ${lg("i")}))))
      (local.set $w (i32.mul ${lg("a")} ${c(RES)}))
      (local.set $w (if (result i32) (i32.gt_u ${lg("ys")} ${lg("w")}) (then (i32.sub ${lg("ys")} ${lg("w")})) (else (i32.sub ${lg("w")} ${lg("ys")}))))
      (local.set $s (i32.mul ${lg("a")} ${lg("stp")}))
      (local.set $s (if (result i32) (i32.gt_u ${lg("xs")} ${lg("s")}) (then (i32.sub ${lg("xs")} ${lg("s")})) (else (i32.sub ${lg("s")} ${lg("xs")}))))
      (local.set $k (f64.mul (f64.load (i32.add ${c(A.SINC)} (i32.shl ${lg("s")} ${c(3)})))
                             (f64.load (i32.add ${c(A.WIN)} (i32.shl ${lg("w")} ${c(3)})))))
      (local.set $ksum (f64.add ${lg("ksum")} ${lg("k")}))
      (local.set $sum (f64.add ${lg("sum")} (f64.mul (f64.convert_i32_s (call $src_at (i32.add ${lg("index")} ${lg("i")}) ${lg("ch")})) ${lg("k")})))
      (local.set $i (i32.add ${lg("i")} ${c(1)}))
      (br $l)))
    (i32.trunc_sat_f64_s (f64.div ${lg("sum")} ${lg("ksum")})))

  (func $out_put (param $lr i32)   ;; one stereo frame into the wasmcart ring
    (local $w i32)
    (local.set $w (i32.load (i32.const ${ST + S.OUTW})))
    (i32.store (i32.add ${c(A.OUT)} (i32.shl ${lg("w")} ${c(2)})) ${lg("lr")})
    (i32.store (i32.const ${ST + S.OUTW}) (i32.and (i32.add ${lg("w")} ${c(1)}) ${c(OUT_CAP - 1)})))

  ;; the scalar audio state, mirrored into memory for a divergence finder
  (func $au_snap
${AUDIO_SNAPSHOT.map((n, i) => `    (i32.store (i32.const ${ST + S.SNAP + 4 * i}) (global.get $${n}))`).join("\n")}
    (f64.store (i32.const ${ST + S.SNAP + 4 * AUDIO_SNAPSHOT.length}) (global.get $rs_ts)))

  ;; retro_run's GBA audio tail + mAudioResamplerProcess
  (func $au_frame_end
    (local $rate i32) (local $step f64) (local $ts f64) (local $made i32) (local $l i32) (local $r i32) (local $drop i32) (local $i i32)
    (call $au_snap)
    (if (i32.eqz ${g("src_n")}) (then (return)))
    (local.set $rate (i32.div_u ${c(J.gba.cpuFrequency)} ${g("au_interval")}))
    (if (i32.eq ${lg("rate")} ${c(AUDIO_RATE)})
      (then
        (local.set $i ${c(0)})
        (block $d (loop $l
          (br_if $d (i32.ge_u ${lg("i")} ${g("src_n")}))
          (call $out_put (i32.load (i32.add ${c(A.SRC)} (i32.shl (i32.and (i32.add ${g("src_r")} ${lg("i")}) ${c(SRC_CAP - 1)}) ${c(2)}))))
          (local.set $i (i32.add ${lg("i")} ${c(1)}))
          (br $l)))
        ${set("src_r", `(i32.and (i32.add ${g("src_r")} ${g("src_n")}) ${c(SRC_CAP - 1)})`)}
        ${set("src_n", c(0))}
        (return)))
    (local.set $step (f64.div (f64.convert_i32_u ${lg("rate")}) (f64.const ${AUDIO_RATE})))
    (local.set $ts ${g("rs_ts")})
    (block $d (loop $l
      (br_if $d (f64.ge (f64.add ${lg("ts")} (f64.const ${WIDTH})) (f64.convert_i32_u ${g("src_n")})))
      (br_if $d (i32.ge_u ${lg("made")} ${c(DEST_CAP)}))
      (local.set $l (call $sinc_interp ${lg("ts")} ${lg("step")} ${c(0)}))
      (local.set $r (call $sinc_interp ${lg("ts")} ${lg("step")} ${c(1)}))
      (call $out_put (i32.or (i32.and ${lg("l")} ${c(0xFFFF)}) (i32.shl ${lg("r")} ${c(16)})))
      (local.set $ts (f64.add ${lg("ts")} ${lg("step")}))
      (local.set $made (i32.add ${lg("made")} ${c(1)}))
      (br $l)))
    (if (f64.gt ${lg("ts")} (f64.const ${WIDTH}))
      (then
        (local.set $drop (i32.trunc_sat_f64_u (f64.sub ${lg("ts")} (f64.const ${WIDTH}))))
        (if (i32.gt_u ${lg("drop")} ${g("src_n")}) (then (local.set $drop ${g("src_n")})))
        ${set("src_r", `(i32.and (i32.add ${g("src_r")} ${lg("drop")}) ${c(SRC_CAP - 1)})`)}
        ${set("src_n", `(i32.sub ${g("src_n")} ${lg("drop")})`)}
        (local.set $ts (f64.sub ${lg("ts")} (f64.convert_i32_u ${lg("drop")})))))
    ${set("rs_ts", lg("ts"))})
`;
}

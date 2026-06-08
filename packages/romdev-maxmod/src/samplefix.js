// romdev-maxmod — samplefix.js
//
// Faithful pure-JS port of mmutil's samplefix.c. This is the SEPARATE
// translation unit that every loader (mod/xm/it/s3m) calls via FixSample(samp)
// immediately after delta-decoding a sample's PCM. It performs the
// target-system-specific sample massaging:
//
//   GBA: down-convert to 8-bit, trim post-loop data, unroll BIDI loops, and
//        (the load-bearing one for chiptunes) unroll short forward loops up to
//        GBA_MIN_LOOP_SIZE so the hardware's minimum loop length is satisfied.
//   NDS: signing + IMA-ADPCM + alignment (ported for parity; GBA is the target
//        this package emits, so the NDS path here mirrors the C but is not the
//        primary code path).
//
// Data representation note: our model stores 8-bit PCM as a Uint8Array and
// 16-bit PCM as a Uint16Array (both UNSIGNED with the +128 / +32768 bias the
// loaders apply), exactly matching the C's `u8* data` / `u16* data` after the
// delta decode. samp.format & SAMPF_16BIT selects which.

import { SAMPF_16BIT, SAMPF_SIGNED, CLAMP } from './util.js';

// eslint-disable-next-line no-unused-vars -- NDS-only value, kept for mmutil parity
const MAX_UNROLL_THRESHOLD = 1024; // will unroll upto 1kb more of data (NDS)
const GBA_MIN_LOOP_SIZE = 512;

/** Allocate the right typed array for this sample's bit-depth. */
function allocData(samp, count) {
  return samp.format & SAMPF_16BIT ? new Uint16Array(count) : new Uint8Array(count);
}

/**
 * samplefix.c Sample_PadStart(): pad the beginning of a sample with silence
 * (128 for 8-bit, 32768 for 16-bit, both the unsigned zero point).
 * @param {object} samp
 * @param {number} count
 */
export function Sample_PadStart(samp, count) {
  if (count === 0) return; // nothing to do
  const newdata = allocData(samp, samp.sample_length + count);
  const silence = samp.format & SAMPF_16BIT ? 32768 : 128;
  for (let x = 0; x < count; x++) newdata[x] = silence;
  for (let x = 0; x < samp.sample_length; x++) newdata[count + x] = samp.data[x];
  samp.data = newdata;
  samp.loop_start += count;
  samp.loop_end += count;
  samp.sample_length += count;
}

/**
 * samplefix.c Sample_PadEnd(): pad the end of a sample with silence.
 * @param {object} samp
 * @param {number} count
 */
export function Sample_PadEnd(samp, count) {
  if (count === 0) return; // nothing to do
  const newdata = allocData(samp, samp.sample_length + count);
  const silence = samp.format & SAMPF_16BIT ? 32768 : 128;
  for (let x = 0; x < samp.sample_length; x++) newdata[x] = samp.data[x];
  for (let x = 0; x < count; x++) newdata[samp.sample_length + x] = silence;
  samp.data = newdata;
  samp.loop_end += count;
  samp.sample_length += count;
}

/**
 * samplefix.c Unroll_Sample_Loop(): append (count) extra copies of the loop
 * region so the playback loop is physically longer. loop_end MUST equal
 * sample_length on entry (the C asserts this in a comment).
 * @param {object} samp
 * @param {number} count
 */
export function Unroll_Sample_Loop(samp, count) {
  const looplen = samp.loop_end - samp.loop_start;
  const newlen = samp.sample_length + looplen * count;
  const newdata = allocData(samp, newlen);
  for (let x = 0; x < samp.sample_length; x++) newdata[x] = samp.data[x];
  for (let x = 0; x < looplen * count; x++) {
    newdata[samp.sample_length + x] = samp.data[samp.loop_start + (x % looplen)];
  }
  samp.data = newdata;
  samp.loop_end += looplen * count;
  samp.sample_length += looplen * count;
}

/**
 * samplefix.c Unroll_BIDI_Sample(): convert a ping-pong (BIDI, loop_type==2)
 * loop into a forward loop by appending the reversed loop region. sample_length
 * MUST equal loop_end on entry.
 * @param {object} samp
 */
export function Unroll_BIDI_Sample(samp) {
  const looplen = samp.loop_end - samp.loop_start;
  const newlen = samp.sample_length + looplen;
  const newdata = allocData(samp, newlen);
  for (let x = 0; x < samp.sample_length; x++) newdata[x] = samp.data[x];
  for (let x = 0; x < looplen; x++) {
    newdata[x + samp.sample_length] = samp.data[samp.loop_end - 1 - x];
  }
  samp.data = newdata;
  samp.loop_type = 1;
  samp.sample_length += looplen;
  samp.loop_end += looplen;
}

/**
 * samplefix.c Resample(): cubic (Catmull-Rom-ish) resample to newsize samples.
 * "stolen from CHIBITRACKER (thanks reduz!)" per the C. Only the NDS fixup path
 * reaches this for GBA targets; kept faithful for parity.
 * @param {object} samp
 * @param {number} newsize
 */
export function Resample(samp, newsize) {
  const bit16 = !!(samp.format & SAMPF_16BIT);
  const src = samp.data;
  const oldlength = samp.sample_length;
  const lpoint = samp.loop_start;
  const dst = allocData(samp, newsize);
  const sign_diff = bit16 ? 32768.0 : 128.0;

  const tscale = oldlength / newsize;

  for (let i = 0; i < newsize; i++) {
    const posf = i * tscale;
    const posi = Math.floor(posf);
    const mu = posf - posi;

    // previous, current, next, and after-next samples
    let s0 = posi - 1 < 0 ? 0 : src[posi - 1];
    let s1 = src[posi];
    let s2 =
      posi + 1 >= oldlength
        ? samp.loop_type
          ? src[lpoint + (posi + 1 - oldlength)]
          : 0
        : src[posi + 1];
    let s3 =
      posi + 1 >= oldlength
        ? samp.loop_type
          ? src[lpoint + (posi + 2 - oldlength)]
          : 0
        : src[posi + 2];

    s0 -= sign_diff;
    s1 -= sign_diff;
    s2 -= sign_diff;
    s3 -= sign_diff;

    const mu2 = mu * mu;
    const a0 = s3 - s2 - s0 + s1;
    const a1 = s0 - s1 - a0;
    const a2 = s2 - s0;
    const a3 = s1;

    const res = a0 * mu * mu2 + a1 * mu2 + a2 * mu + a3;
    let resi = Math.floor(res + 0.5);

    if (bit16) {
      if (resi < -32768) resi = -32768;
      if (resi > 32767) resi = 32767;
      dst[i] = (resi + 32768) & 0xffff;
    } else {
      if (resi < -128) resi = -128;
      if (resi > 127) resi = 127;
      dst[i] = (resi + 128) & 0xff;
    }
  }

  samp.data = dst;
  samp.sample_length = newsize;
  samp.loop_end = newsize;
  // integer rounding identical to the C ((a*N + old/2)/old) integer div:
  samp.loop_start = Math.trunc((samp.loop_start * newsize + oldlength / 2) / oldlength);
  samp.frequency = Math.trunc((samp.frequency * newsize + oldlength / 2) / oldlength);
}

/**
 * samplefix.c Sample_8bit(): down-convert 16-bit PCM to 8-bit by taking the
 * high byte (value / 256), clearing SAMPF_16BIT.
 * @param {object} samp
 */
export function Sample_8bit(samp) {
  if (samp.format & SAMPF_16BIT) {
    const newdata = new Uint8Array(samp.sample_length);
    for (let t = 0; t < samp.sample_length; t++) {
      newdata[t] = (samp.data[t] / 256) & 0xff; // integer truncation, matches C u16/256
    }
    samp.data = newdata;
    samp.format &= ~SAMPF_16BIT;
  }
}

/**
 * samplefix.c Sample_Sign(): convert unsigned PCM to signed (subtract the zero
 * point). Used by the NDS path; included for parity.
 * @param {object} samp
 */
export function Sample_Sign(samp) {
  if (samp.format & SAMPF_16BIT) {
    for (let x = 0; x < samp.sample_length; x++) {
      let a = samp.data[x] - 32768;
      if (a < -32767) a = -32767; // clamp LOW (leave space for interpolation error)
      samp.data[x] = a & 0xffff;
    }
  } else {
    for (let x = 0; x < samp.sample_length; x++) {
      let a = samp.data[x] - 128;
      if (a === -128) a = -127;
      samp.data[x] = a & 0xff;
    }
  }
  samp.format |= SAMPF_SIGNED;
}

/**
 * samplefix.c FixSample_GBA(): the GBA sample-massaging pipeline.
 *   1. down-convert to 8-bit
 *   2. drop data after loop_end (when a loop exists)
 *   3. unroll BIDI (ping-pong) loops into forward loops
 *   4. unroll short forward loops so loop length >= GBA_MIN_LOOP_SIZE (512)
 * @param {object} samp
 */
export function FixSample_GBA(samp) {
  // convert to 8-bit if neccesary
  Sample_8bit(samp);

  // delete data after loop_end if loop exists
  if (samp.loop_type !== 0) samp.sample_length = samp.loop_end;

  // unroll BIDI loop
  if (samp.loop_type === 2) Unroll_BIDI_Sample(samp);

  if (samp.loop_type) {
    if (samp.loop_end - samp.loop_start < GBA_MIN_LOOP_SIZE) {
      // (GBA_MIN_LOOP_SIZE / looplen)+1 — integer division, matches the C.
      const count = Math.trunc(GBA_MIN_LOOP_SIZE / (samp.loop_end - samp.loop_start)) + 1;
      Unroll_Sample_Loop(samp, count);
    }
  }
}

// strcmpshit() / FixSample_NDS() name-flag handling (%o, %c) operate on the
// sample name; for the GBA target they are not reached. The NDS path is ported
// here only as far as the shared helpers above; the full NDS fixer is omitted
// because this package emits GBA soundbanks exclusively (target_system==GBA).

/**
 * samplefix.c FixSample(): the dispatcher every loader calls. Clamps the loop
 * bounds (f.e. FR_TOWER.MOD), then runs the target-system fixer. This package
 * targets the GBA, so it always takes the GBA path.
 * @param {object} samp
 */
export function FixSample(samp) {
  // Clamp loop_start and loop_end (f.e. FR_TOWER.MOD)
  samp.loop_start = CLAMP(samp.loop_start, 0, samp.sample_length);
  samp.loop_end = CLAMP(samp.loop_end, 0, samp.sample_length);

  FixSample_GBA(samp);
}

export default FixSample;

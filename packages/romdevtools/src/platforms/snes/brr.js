// BRR encoder for SNES SPC700 samples.
//
// Bit-accurate against snes9x's SPC_DSP::decode_brr (see
// snes9x/src/apu/bapu/dsp/SPC_DSP.cpp). Earlier versions of this file
// guessed at the decode math from wiki descriptions and produced buzz —
// real BRR encoding requires simulating the actual DSP at encode time
// because:
//   1. The DSP multiplies the decoded sample by 2 AFTER clamping to int16
//      and re-wraps (`s = (int16_t)(s * 2)`). So values outside [-16384,
//      +16383] wrap into noise. Encoder MUST keep reconstructed values
//      inside that window.
//   2. Filter prediction uses the PREVIOUS DECODED SAMPLES (post-clamp,
//      post-doubling). Encoder must track p1/p2 state exactly the way
//      the DSP will, or filters 1-3 produce drift.
//   3. p2 is right-shifted by 1 before use in filters 2/3.
//   4. The "decoded sample" stored as p1 is `s * 2 (wrapped int16)`,
//      which is the final post-multiply value.
//
// Algorithm: brute-force every (filter 0..3, shift 0..12) combo per
// block. For each combo, encode each sample by inverting the DSP formula
// to get the ideal nibble, clamp to [-8,+7], then run the exact decode
// to update p1/p2 and accumulate squared error. Pick the combo with the
// lowest error and use that. The first block of any sample MUST use
// filter 0 (no other choice has valid p1/p2 history).

/** snes9x CLAMP16: saturate to int16. */
function clamp16(io) {
  // The macro: if int16(io) != io, io = (io >> 31) ^ 0x7FFF
  // i.e. if out of range, pick whichever signed-saturation matches the
  // sign of the overflow.
  const asI16 = (io << 16) >> 16;
  if (asI16 !== io) {
    return (io >> 31) ^ 0x7FFF;
  }
  return io;
}

/** Apply the DSP filter prediction. p1/p2 are post-clamp post-doubled prior decoded samples. */
function applyFilter(filter, p1, p2) {
  // p2 is read pre-shifted by 1 in the source code; we pass actual p2
  // and divide here to match.
  const p2h = p2 >> 1;
  switch (filter) {
    case 0: return 0;
    case 1: // s += p1 + (-p1 >> 4)  →  ~p1 * 15/16
      return p1 + ((-p1) >> 4);
    case 2: // s += p1 + p1 + (p1*-3 >> 6) - p2h + (p2h >> 4)
      return p1 + p1 + ((p1 * -3) >> 6) - p2h + (p2h >> 4);
    case 3: // s += p1 + p1 + (p1*-13 >> 7) - p2h + (p2h*3 >> 4)
      return p1 + p1 + ((p1 * -13) >> 7) - p2h + ((p2h * 3) >> 4);
    default: return 0;
  }
}

/**
 * Decode one sample exactly as snes9x does, given the encoded nibble,
 * shift, filter, and prior decoded samples p1/p2.
 *
 * Returns the new decoded sample (post-clamp, post-doubling, as int16).
 */
function decodeSample(nib, shift, filter, p1, p2) {
  // sign-extend 4-bit (snes9x: `(int16_t)nybbles >> 12`)
  let s = (nib & 0x08) ? (nib | 0xFFFFFFF0) : (nib & 0x0F);
  if (shift <= 12) {
    s = (s << shift) >> 1;
  } else {
    s = s & ~0x7FF;  // clears low 11 bits → 0 or 0xFFFFF800 (= -2048)
  }
  s += applyFilter(filter, p1, p2);
  s = clamp16(s);
  s = ((s * 2) << 16) >> 16;  // (int16_t)(s*2), wrapping
  return s;
}

/**
 * Encode 16-bit signed PCM (mono, little-endian s16) into BRR blocks.
 *
 * @param {Int16Array | Buffer} pcm  signed 16-bit samples, mono
 * @param {{ loop?: boolean }} [opts]
 *   loop: if true, set the LOOP bit on the final block so the sample
 *         repeats. Default false (one-shot SFX).
 * @returns {{ brr: Uint8Array, blocks: number, samples: number }}
 */
export function pcmToBrr(pcm, opts = {}) {
  // Normalize input to Int16Array.
  let samples;
  if (pcm instanceof Int16Array) {
    samples = pcm;
  } else {
    const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
    samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  }

  // The DSP's post-decode `*2` wraps int16, so reconstructed samples must
  // stay inside [-16384, +16383] to not wrap into noise. Pre-scale the
  // input to fit safely inside that envelope. Real BRR tools (BRRtools,
  // snesbrr) do the same; the alternative is brutal high-amplitude buzz.
  const SAFE_MAX = 16000;  // a hair under 16384 for filter-prediction headroom
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  let scaled = samples;
  if (peak > SAFE_MAX) {
    const factor = SAFE_MAX / peak;
    scaled = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      scaled[i] = Math.round(samples[i] * factor);
    }
  }

  // Pad up to a multiple of 16 samples so we emit whole blocks.
  const padded = scaled.length % 16 === 0
    ? scaled
    : (() => {
        const out = new Int16Array(scaled.length + (16 - scaled.length % 16));
        out.set(scaled);
        return out;
      })();

  const blockCount = padded.length / 16;
  const brr = new Uint8Array(blockCount * 9);

  // Running state — the decoder's p1/p2 (post-clamp post-doubled samples).
  // Must match exactly across the encode so filters 1-3 stay in sync with
  // what the DSP will reconstruct.
  let p1 = 0;
  let p2 = 0;

  for (let b = 0; b < blockCount; b++) {
    const blockStart = b * 16;
    const isFirstBlock = b === 0;
    const isLastBlock = b === blockCount - 1;

    // Try every (filter, shift) combination; pick the one with lowest
    // squared reconstruction error vs the source PCM. The first block of
    // a sample MUST use filter 0 — filters 1-3 reference p1/p2 which are
    // undefined at sample start (DSP fills them with whatever was there
    // before KON, which we can't predict).
    let bestError = Infinity;
    let bestFilter = 0;
    let bestShift = 0;
    let bestNibbles = new Int8Array(16);
    let bestP1 = p1, bestP2 = p2;

    const filterRange = isFirstBlock ? [0] : [0, 1, 2, 3];
    for (const filter of filterRange) {
      for (let shift = 0; shift <= 12; shift++) {
        let trialP1 = p1, trialP2 = p2;
        let error = 0;
        const nibs = new Int8Array(16);
        for (let i = 0; i < 16; i++) {
          const target = padded[blockStart + i];
          // Want: decoded == target, where decoded comes from decodeSample.
          // Invert the filter: ideal pre-filter value = target/2 - prediction
          // (since the final step is s = (clamp16(s) * 2) & int16).
          // We choose the nibble that minimizes |decoded - target|.
          // Brute force all 16 nibble values — way cheaper than algebra
          // and guaranteed correct against the DSP code.
          let bestNib = 0;
          let bestNibErr = Infinity;
          for (let nib = -8; nib <= 7; nib++) {
            const reconstructed = decodeSample(nib & 0x0F, shift, filter, trialP1, trialP2);
            const diff = reconstructed - target;
            const sq = diff * diff;
            if (sq < bestNibErr) {
              bestNibErr = sq;
              bestNib = nib;
            }
          }
          nibs[i] = bestNib;
          const reconstructed = decodeSample(bestNib & 0x0F, shift, filter, trialP1, trialP2);
          error += bestNibErr;
          trialP2 = trialP1;
          trialP1 = reconstructed;
        }
        if (error < bestError) {
          bestError = error;
          bestFilter = filter;
          bestShift = shift;
          bestNibbles = nibs;
          bestP1 = trialP1;
          bestP2 = trialP2;
        }
      }
    }

    // Commit the running state forward.
    p1 = bestP1;
    p2 = bestP2;

    const header = ((bestShift & 0x0F) << 4)
                 | ((bestFilter & 0x03) << 2)
                 | (opts.loop && isLastBlock ? 0x02 : 0)
                 | (isLastBlock ? 0x01 : 0);
    brr[b * 9] = header;
    for (let i = 0; i < 8; i++) {
      const hi = bestNibbles[i * 2 + 0] & 0x0F;
      const lo = bestNibbles[i * 2 + 1] & 0x0F;
      brr[b * 9 + 1 + i] = (hi << 4) | lo;
    }
  }

  return { brr, blocks: blockCount, samples: samples.length };
}

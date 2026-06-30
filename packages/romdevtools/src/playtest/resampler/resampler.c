/* ── resampler.c — WASM+SIMD linear resampler for the romdev playtest audio sink ─
 *
 * Resamples interleaved S16 STEREO PCM from a source rate to a device rate.
 *
 * WHY this exists: the libretro CONTRACT is that a core declares its native audio
 * rate in get_system_av_info and emits raw samples at that rate; the FRONTEND is
 * responsible for resampling to the audio device (RetroArch does this in C with a
 * sinc resampler). Every romdev core sits at 31–48 kHz EXCEPT the GameTank ACP at
 * ~13983 Hz — 2.3x lower than the next core. At that rate SDL's fixed device
 * buffer (4096 samples ≈ 293 ms) starves between 60 fps ticks that each feed only
 * ~233 samples → clicks and pops. So the playtest sink opens the device at 48 kHz
 * and resamples low-rate cores up to it. Doing that per-frame in JS is wasteful;
 * this is the native-speed SIMD path (linear interp, 4 output frames/iteration).
 *
 * Build: see build.sh (emcc -O3 -msimd128). Exports rs_alloc/rs_free/rs_resample.
 *
 * Contract:
 *   rs_resample(inPtr, inFrames, outPtr, outCap, srcRate, dstRate) -> outFrames
 *     inPtr  : int16_t* interleaved L,R,L,R… at srcRate (inFrames stereo frames)
 *     outPtr : int16_t* interleaved buffer with room for outCap stereo frames
 *     returns the number of stereo frames written (<= outCap).
 * The caller sizes outCap >= ceil(inFrames * dstRate/srcRate) + 1.
 */
#include <stdint.h>
#include <wasm_simd128.h>
#include <emscripten.h>

#define EXPORT EMSCRIPTEN_KEEPALIVE

/* scratch buffers live in the WASM heap, allocated from JS via rs_alloc. */
EXPORT void *rs_alloc(int bytes) { return __builtin_malloc((unsigned long)bytes); }
EXPORT void  rs_free(void *p)    { __builtin_free(p); }

/* Linear-resample interleaved S16 stereo. Returns stereo frames written.
 *
 * For output frame i: srcPos = i / ratio = i * srcRate/dstRate. We split srcPos
 * into integer index i0 and fraction f in [0,1): out = in[i0]*(1-f) + in[i0+1]*f
 * per channel. We vectorize across 4 consecutive output frames: compute their 4
 * srcPos in f32x4, their 4 integer indices and 4 fractions, gather the 8 source
 * samples (can't SIMD-gather in wasm128, so scalar gather) but do the lerp math in
 * SIMD. The gather dominates, but keeping the arithmetic in f32x4 + a single
 * saturating narrow per 4 frames is still a clear win over per-sample JS.
 */
EXPORT int rs_resample(const int16_t *in, int inFrames,
                       int16_t *out, int outCap,
                       int srcRate, int dstRate) {
  if (inFrames < 2 || srcRate <= 0 || dstRate <= 0) return 0;
  if (srcRate == dstRate) {
    int n = inFrames < outCap ? inFrames : outCap;
    for (int i = 0; i < n * 2; i++) out[i] = in[i];
    return n;
  }

  /* step = srcRate/dstRate in source frames per output frame (fixed math in f64). */
  const double step = (double)srcRate / (double)dstRate;
  long outFrames = (long)((double)inFrames * (double)dstRate / (double)srcRate);
  if (outFrames > outCap) outFrames = outCap;
  const int maxI0 = inFrames - 2; /* so i0+1 is valid */

  long i = 0;
  /* SIMD body: 4 output frames per iteration. */
  for (; i + 4 <= outFrames; i += 4) {
    /* source positions for the 4 frames */
    double p0 = (double)(i + 0) * step;
    double p1 = (double)(i + 1) * step;
    double p2 = (double)(i + 2) * step;
    double p3 = (double)(i + 3) * step;

    int i0_0 = (int)p0, i0_1 = (int)p1, i0_2 = (int)p2, i0_3 = (int)p3;
    if (i0_0 > maxI0) i0_0 = maxI0; if (i0_1 > maxI0) i0_1 = maxI0;
    if (i0_2 > maxI0) i0_2 = maxI0; if (i0_3 > maxI0) i0_3 = maxI0;

    /* fractions as f32x4 */
    v128_t frac = wasm_f32x4_make((float)(p0 - i0_0), (float)(p1 - i0_1),
                                  (float)(p2 - i0_2), (float)(p3 - i0_3));
    v128_t inv  = wasm_f32x4_sub(wasm_f32x4_splat(1.0f), frac);

    /* gather the 8 source samples per channel (scalar — no wasm128 gather). */
    v128_t l0 = wasm_f32x4_make((float)in[(i0_0*2)],   (float)in[(i0_1*2)],
                                (float)in[(i0_2*2)],   (float)in[(i0_3*2)]);
    v128_t l1 = wasm_f32x4_make((float)in[(i0_0*2)+2], (float)in[(i0_1*2)+2],
                                (float)in[(i0_2*2)+2], (float)in[(i0_3*2)+2]);
    v128_t r0 = wasm_f32x4_make((float)in[(i0_0*2)+1], (float)in[(i0_1*2)+1],
                                (float)in[(i0_2*2)+1], (float)in[(i0_3*2)+1]);
    v128_t r1 = wasm_f32x4_make((float)in[(i0_0*2)+3], (float)in[(i0_1*2)+3],
                                (float)in[(i0_2*2)+3], (float)in[(i0_3*2)+3]);

    /* lerp: l = l0*inv + l1*frac */
    v128_t lo = wasm_f32x4_add(wasm_f32x4_mul(l0, inv), wasm_f32x4_mul(l1, frac));
    v128_t ro = wasm_f32x4_add(wasm_f32x4_mul(r0, inv), wasm_f32x4_mul(r1, frac));

    /* round to nearest, convert to i32, store interleaved. */
    v128_t half = wasm_f32x4_splat(0.5f);
    v128_t lneg = wasm_f32x4_lt(lo, wasm_f32x4_splat(0.0f));
    v128_t rneg = wasm_f32x4_lt(ro, wasm_f32x4_splat(0.0f));
    lo = wasm_f32x4_add(lo, wasm_v128_bitselect(wasm_f32x4_splat(-0.5f), half, lneg));
    ro = wasm_f32x4_add(ro, wasm_v128_bitselect(wasm_f32x4_splat(-0.5f), half, rneg));
    v128_t li = wasm_i32x4_trunc_sat_f32x4(lo);
    v128_t ri = wasm_i32x4_trunc_sat_f32x4(ro);

    int li_[4], ri_[4];
    wasm_v128_store(li_, li);
    wasm_v128_store(ri_, ri);
    for (int k = 0; k < 4; k++) {
      int lv = li_[k], rv = ri_[k];
      if (lv > 32767) lv = 32767; else if (lv < -32768) lv = -32768;
      if (rv > 32767) rv = 32767; else if (rv < -32768) rv = -32768;
      out[(i + k) * 2]     = (int16_t)lv;
      out[(i + k) * 2 + 1] = (int16_t)rv;
    }
  }

  /* scalar tail */
  for (; i < outFrames; i++) {
    double p = (double)i * step;
    int i0 = (int)p; if (i0 > maxI0) i0 = maxI0;
    float f = (float)(p - i0), invf = 1.0f - f;
    float l = in[i0*2]   * invf + in[(i0+1)*2]   * f;
    float r = in[i0*2+1] * invf + in[(i0+1)*2+1] * f;
    int lv = (int)(l < 0 ? l - 0.5f : l + 0.5f);
    int rv = (int)(r < 0 ? r - 0.5f : r + 0.5f);
    if (lv > 32767) lv = 32767; else if (lv < -32768) lv = -32768;
    if (rv > 32767) rv = 32767; else if (rv < -32768) rv = -32768;
    out[i*2]   = (int16_t)lv;
    out[i*2+1] = (int16_t)rv;
  }

  return (int)outFrames;
}

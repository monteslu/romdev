/* ── resampler/index.mjs — JS wrapper for the WASM+SIMD audio resampler ────────
 *
 * Loads the WASM module once and exposes resampleS16Stereo(buf, src, dst) that
 * resamples an interleaved S16LE stereo Node Buffer. Used by the playtest audio
 * sink for low-rate cores (the GameTank ACP at ~13983 Hz) — see resampler.c for
 * the why (libretro frontends resample; only GameTank is low enough to need it).
 *
 * The WASM scratch buffers are sized once to the largest chunk seen and reused.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mod = null;        // the emscripten Module
let inPtr = 0, inCap = 0;    // input scratch (bytes)
let outPtr = 0, outCap = 0;  // output scratch (bytes)

/** Lazily instantiate the WASM module. Returns true once ready, false if it
 * failed to load (caller falls back to passing audio through unresampled). */
export async function initResampler() {
  if (mod) return true;
  try {
    const factory = (await import(path.join(__dirname, "resampler.mjs"))).default;
    mod = await factory();
    return true;
  } catch (e) {
    mod = null;
    return false;
  }
}

function ensureCap(needIn, needOut) {
  if (needIn > inCap) {
    if (inPtr) mod._rs_free(inPtr);
    inCap = needIn * 2; // grow with headroom
    inPtr = mod._rs_alloc(inCap);
  }
  if (needOut > outCap) {
    if (outPtr) mod._rs_free(outPtr);
    outCap = needOut * 2;
    outPtr = mod._rs_alloc(outCap);
  }
}

/**
 * Resample an interleaved S16LE stereo Buffer from srcRate to dstRate using the
 * WASM+SIMD core. Synchronous; initResampler() must have resolved true first.
 * Falls back to returning the input unchanged if the module isn't loaded.
 * @param {Buffer} buf interleaved S16LE stereo at srcRate
 * @param {number} srcRate
 * @param {number} dstRate
 * @returns {Buffer} interleaved S16LE stereo at dstRate
 */
export function resampleS16Stereo(buf, srcRate, dstRate) {
  if (!mod || srcRate === dstRate || srcRate <= 0 || dstRate <= 0) return buf;
  const inFrames = (buf.length / 4) | 0; // 4 bytes/stereo frame
  if (inFrames < 2) return buf;
  const maxOutFrames = Math.ceil(inFrames * (dstRate / srcRate)) + 2;

  ensureCap(inFrames * 4, maxOutFrames * 4);

  // copy input into WASM heap
  mod.HEAPU8.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), inPtr);

  const outFrames = mod._rs_resample(
    inPtr, inFrames, outPtr, maxOutFrames, srcRate, dstRate
  );
  if (outFrames <= 0) return buf;

  // copy result out into a fresh Buffer (the audio device owns its own memory,
  // and the WASM heap may move on the next call).
  const outBytes = outFrames * 4;
  return Buffer.from(new Uint8Array(mod.HEAPU8.buffer, outPtr, outBytes));
}

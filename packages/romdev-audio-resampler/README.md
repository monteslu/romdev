# romdev-audio-resampler

A tiny **WASM + SIMD** linear audio resampler for interleaved **S16LE stereo** PCM.

Emulator cores report their audio at a native sample rate — usually 31–48 kHz, but
sometimes a *fractional* rate derived from real hardware (e.g. the GameTank ACP at
`315000000 / (88·256) ≈ 13983 Hz`). A frontend that opens a fixed-rate audio device
(SDL wants an integer frequency) must resample the core's stream to the device rate —
exactly what a libretro frontend does. This package is that resampler, as a standalone
native-speed WASM module (linear interpolation, 4 output frames per SIMD iteration).

Zero dependencies (only `node:path` / `node:url`). ~8 KB of wasm.

## Usage

```js
import { initResampler, resampleS16Stereo } from "romdev-audio-resampler";

await initResampler();               // lazily instantiate the wasm (returns false on failure)

// interleaved S16LE stereo Buffer from the core, at its native rate → device rate:
const out = resampleS16Stereo(coreBuffer, coreRate /* e.g. 13983 */, 48000);
device.enqueue(out);                 // out is a fresh S16LE stereo Buffer at 48000 Hz
```

- `initResampler(): Promise<boolean>` — instantiate once. If it returns `false` (wasm
  failed to load), `resampleS16Stereo` passes the input through unchanged, so callers
  degrade gracefully to the native rate rather than crashing.
- `resampleS16Stereo(buf, srcRate, dstRate): Buffer` — synchronous. Returns `buf`
  unchanged when `srcRate === dstRate` or the module isn't loaded.

## Scope

Linear interpolation — cheap, small, and inaudible for upsampling low-rate cores (the
target use). Not a sinc resampler; if you need studio-grade downsampling, resample with
a higher-order kernel upstream. Good enough for real-time console audio, which is the job.

## Build

`./build.sh` (needs an activated Emscripten SDK on `PATH`) → `resampler.mjs` + `resampler.wasm`.

## License

MIT.

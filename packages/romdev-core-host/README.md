# romdev-core-host

The [romdev](https://github.com/monteslu/romdev) libretro host runtime,
published standalone: load a `romdev-core-*` emulator core (WASM), run
frames, read the framebuffer / audio / memory, drive input, save and load
state. This is the SAME host the romdev MCP server runs (the server consumes
this package too), so there is exactly one host implementation in the
ecosystem. Bundles NO cores; pass any `romdev-core-*` package.

```js
import { LibretroHost } from "romdev-core-host";
import * as core from "romdev-core-fceumm"; // any romdev-core-* package

const host = new LibretroHost();
await host.loadCore(core.core.jsPath, core.core.wasmPath);
await host.loadMedia({ platform: "nes", path: "game.nes" });

host.stepFrames(60);
const shot = host.screenshot();            // { pngBase64, width, height }
host.setInput({ ports: [{ start: true }] });
host.stepFrames(2);
```

ROMs load from disk (`path`) or from memory (`bytes` + an optional `name`
whose extension tells the core what it is):

```js
host.loadMedia({ platform: "nes", bytes: romBytes, name: "game.nes" });
```

## API map

Every optional capability is feature-detected: if the loaded core supports
it there is a matching `*Supported()` method, and unsupported calls throw a
descriptive error rather than failing silently.

**Lifecycle.** `new LibretroHost({ systemDir, saveDir, log })`,
`loadCore(jsPath, wasmPath, { hwRender })`,
`loadMedia({ platform, path | bytes, name, mediaKind, systemDir })`,
`unloadMedia()`, `reset()`, `hardReset()`, `pause()` / `resume()`,
`getStatus()` (platform, frameCount, framebuffer size, `audioSampleRate`).

**Frames and video.** `stepFrames(n)`, `renderOneFrame()`,
`getFramebuffer()` (raw pixels + pitch + format), `screenshot()` (PNG),
`screenshotRgba()`, `framebufferHash()` for cheap change detection.

**Audio.** Cores push interleaved signed 16-bit stereo into
`host.state.audioRing` (an array of chunks); drain it each frame and play
at `host.status.audioSampleRate`. `romdev-core-runner` does exactly this.

**Input.** `setInput({ ports: [{ up, down, left, right, a, b, x, y, l, r,
l2, r2, l3, r3, start, select }] })` with one object per controller port,
named after RetroPad buttons. Held state persists until the next call.

**Save states.** `saveState(name)` / `loadState(name)` / `listStates()` /
`getStateBlob(name)` for named in-memory states, or `serializeState()` /
`unserializeState(blob)` for raw `Uint8Array` blobs you persist yourself.

**Memory.** `readMemory(region, offset, length)`, `writeMemory(region,
offset, bytes)`, `regionSize(region)`, `getCartRom()`, and
`writeMemoryCpuAddr(cpuAddr, bytes)` for CPU-address writes. Region names
are platform-keyed; `MemoryRegionToRetro` (exported from the index) is the
single source of truth.

**Cheats.** `setCheat(index, code)`, `clearCheats()`, `listActiveCheats()`.
The encoder/decoder for the native cheat-device formats lives at
`romdev-core-host/gamegenie.js` (`decodeCode`, `encodeForDevice`,
`nativeDevicesFor`, and per-device helpers).

**Debug / reverse-engineering tier** (all feature-detected per core):
write watchpoints, read watches, PC breakpoints, `runUntilPC(addr)` /
`runUntilRead(addr)`, `stepInstruction()`, `getReg(id)` / `setReg(id, v)`,
`callSubroutine(...)` with a no-hang watchdog, `watchVram(lo, hi, frames)`,
`watchDma(frames)`, and `getRegSnapshot()`.

**Platform extras.** C64: keyboard-matrix typing (`pressC64Key`,
`typeC64Text`, `setC64HeldKeys`) and disk-image import/export
(`exportDiskImage`, `importDiskImage`, `putDiskFile`). MSX: the bundled
open C-BIOS system dir resolves automatically. The 3D cores (N64, PS1,
Dreamcast) hardware-render through a headless GL context: pass
`{ hwRender: true }` to `loadCore` and install the optional `native-gles`
dependency; the software-rendered cores need neither.

## Subpath exports

The index exports `LibretroHost`, the framebuffer codecs
(`framebufferToPng` / `framebufferToRgba` / `framebufferToScreenshot`),
every retro constant, and the shared type helpers. Everything else is
addressable directly, e.g.:

```js
import { decodeCode } from "romdev-core-host/gamegenie.js";
import { framebufferToPng } from "romdev-core-host/framebuffer.js";
```

Per-chip audio/state decoders (`nes-apu-state.js`, `gb-apu-state.js`,
`dsp-state.js`, `gpgx-state.js`, `snes9x-state.js`, `c64-sid-state.js`,
`gba-video-state.js`, and friends) follow the same pattern.

## Requirements

Node >= 24, ESM only. For a ready-made SDL window over this host (keyboard
+ hot-plug gamepad input, audio, aspect-correct scaling) see
[`romdev-core-runner`](https://www.npmjs.com/package/romdev-core-runner).
For the full agent tooling surface (MCP server, build toolchains,
disassembly, playtest) see
[`romdevtools`](https://www.npmjs.com/package/romdevtools).

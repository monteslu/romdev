# M1: deterministic core contract

This is the lower layer for chiptoy issue 96. It adds no room, network transport,
ROM lobby, or app integration. The browser harness is a separate GPL program with
fixed public fixtures. Reports stay client-side; the authenticated dev benchmark
upload and physical phone performance gates belong to M2b/M4v.

## Boot, inputs and state identity

`loadMedia({platform, bytes, deterministic: {rtcEpochSeconds: 0},
controllerTopology: {kind: "nes", playerMask: 15}})` opts into the new snapshot
schemas. The topology option is NES-only. Bits 0–3 denote fixed controller slots,
including gaps. Native `$4016/$4017` reads are the input authority: ports 3/4 enable
Four Score, and absent logical pads receive zero. No injected pad RAM exists.
Reloading a normal ROM disconnects extra pads; counts 1/2 do not enable Four Score.
A deterministic load skips hidden framebuffer warm-up: the CPU has not executed
the ROM, so the adapter can control every bootstrap step. M2 must still establish
an engine-ready/pre-world yield before M3; raw load alone cannot preserve an
ordinary context through the ROM startup code that initializes its BSS.

At synchronized frame boundaries use `serializeState()`, `unserializeState(blob)`
and `stateDigest()` → `{schema, bytes: Uint8Array(32)}`. The digest is SHA-256 over
the entire **core-defined deterministic snapshot**, without client-side masks or
byte-offset exclusions. A snapshot requires the same pinned WASM build, ROM,
platform, core option map, controller topology and RTC epoch. M2's session manifest
must bind those immutable identities and standardized battery RAM, initialize the
ROM ABI before the first world update, and drain replay audio. Inputs contain only
native digital buttons (up/down/left/right/A/B/Start/Select); turbo, palette
switching, cheats, debugger stops, changing core options and asynchronous memory
writes are outside this contract. These hashes describe state at frame boundaries,
not arbitrary CPU breakpoints. They are consistency checks, not proof of honest
execution. The state page's reserved-header enforcement belongs to M2/M3.

GB/GBC clock initialization and RTC/HuC3 reads use a fixed epoch plus accumulated
emulated audio-clock cycles at 4,194,304 Hz, updated at each `runFor` boundary.
CPU double-speed changes do not change the clock's physical rate. Wall-clock waits
and frontend duplicate video frames do not advance it. Soft reset preserves RTC
elapsed time; a new deterministic boot resets it. NES already seeds power-on RAM
from ROM identity and emulates its timers from CPU cycles.

## Versioned causal state

| Core | Schema | Snapshot additions and normalization |
| --- | --- | --- |
| gambatte | `0x47420102` | Full CPU/mapper/RTC/HuC3/timer/serial/APU/PPU/WRAM/VRAM/OAM/HRAM/cart-RAM serializer; epoch and emulated clock; frontend frame/sample counters, turbo phase/config, both blipper buffers, phase, integrator and last sample; native blit deadline and blank-LCD phase. CC resampler and interframe blending are disabled in this mode. |
| fceumm | `0x4e450101` | Full CPU/mapper/PPU/APU/DMA/RAM/cart-RAM/controller serializer, Four Score enable flag and exact native device configuration, FIR interpolation index and full low/high quality wave histories. Existing DC filter accumulators remain included. Stereo widening is unsupported (digest refuses it). |

Gambatte's `endx` was a cached next-tile boundary reconstructed on load from `xpos`
and its low three bits. Deterministic save applies that same reconstruction, retaining all
PPU causal fields. The unused DMG-only `dmgPalette` payload previously contained
uninitialized stack bytes; deterministic save writes explicit zeros when `isCgb()` is false.
CGB palette data remains intact. No known byte is hidden from the digest.

The MP bootstrap can spend many native frames with the LCD off before world
initialization. Gambatte's ordinary loader recomputes the blit deadline and resets
the blank-LCD phase, changing the first restored native frame. Deterministic
schema `0x47420102` retains both in its 80-byte envelope (64-byte v1 envelopes
are rejected). Its loader also restores all captured sprite attributes/words,
including the dormant suffix that the ordinary loader leaves from a later frame,
and preserves the LCD-off initial current-sprite sentinel. A disabled mode-0 STAT
IRQ deadline is normalized only when the loader ignores it; active deadlines
remain part of the snapshot and digest. These changes are deterministic-only.

The LCD-off regression restores four differently aged boot checkpoints after
LCD enable, visible sprite processing and active STAT timing. Each restore compares
40 subsequent native frames' CPU/RAM/pixels/audio/digest, including the transition
out of the wait. The browser harness performs the same checks.

Blipper serialization uses fixed-width little-endian integers and excludes its
immutable coefficient table and pointers. Its signed residual phase can be
negative after rounding to the next output sample; restore validates that range.
NES filter/wave histories cost extra snapshot bytes (~184 KB for the fixture),
so phone rollback performance must still pass M2b. A deterministic GB/GBC snapshot
is ~72/97 KB for these fixtures. This is not a mobile performance certification.

## Ordinary disk-state compatibility

romdev persists whole-machine states through MCP `state({op:"save"/"load", path})`,
auto snapshots and playtest recovery. romdev-browser's probe/rollback snapshots
stay inside the worker; its headless service/gamelab and chiptoy persist battery
RAM, not whole-machine states. Ordinary GB/GBC/NES serialization therefore keeps
the pre-M1 fields, sizes and behavior. PPU cache/DMG palette normalization and
NES's Four Score flag, FIR index and full wave histories apply only in
`deterministic` mode. Switching modes invalidates the NES size cache.

`test/fixtures/multiplayer/legacy-*.state.gz` were captured with the pinned
pre-M1 cores at `0316acbf`; `legacy-states.json` records core/ROM/state SHA-256
values and 16 subsequent frames. GB fixtures halt the cartridge RTC through its
native register so the reference is independent of wall time, without masking
state bytes. Tests restore these existing disk blobs, compare the full WRAM and
framebuffer futures, and verify returning from deterministic mode restores the
ordinary format. Regeneration requires those old cores explicitly:

```sh
node packages/romdevtools/scripts/multiplayer/capture-legacy-states.mjs <pre-M1-repo>
```

## Compiler allocation records

No new compiler record format is introduced. SDCC's existing `--debug` `.adb`
`S:` entries provide symbol type and byte size; assembly absolute symbol definitions
provide addresses, including static, unused `__at` arrays. With preprocessed stdin
`--c1mode`, SDCC cleared `fullSrcFileName` and skipped opening `.adb`: a one-line
condition now permits this existing output. The compiler's normal symbol/type
emission remains unchanged. M2 must request/retain debug output and join it to the
linked address records, fail closed on unclassified allocated objects, and reject
any overlap with the reserved header and touch areas across all translation units.

cc65 requires **no changes**. `--debug-info`, ca65 `-g`, and ld65 `--dbgfile` expose
symbols with address/definition line plus allocation spans. Joining the symbol's
`def` to its line's `span` yields object size. The test places a four-byte object
at `$03EE`, crossing the future `$03F0` header, and checks both address and size.
Compile/assembly/link records must be retained, not inferred from source regexes.
These are evidence probes for M2's build rejection, not the rejection itself.

## Reproduce and inspect

From the repository root, using the pinned Docker WASM builder:

```sh
ROMDEV_BUILD_CWD=packages/romdevtools build-image/build-wasm.sh build-sdcc.sh
ROMDEV_BUILD_CWD=packages/romdevtools build-image/build-wasm.sh build-gambatte.sh
ROMDEV_BUILD_CWD=packages/romdevtools build-image/build-wasm.sh build-fceumm.sh
node --test packages/romdevtools/test/multiplayer-core.test.js packages/romdevtools/test/browser-surface-imports.test.js
```

The core/compiler tests independently boot GB/GBC/NES across a wall-clock
second without sharing state. They compare 32 replay frames' RAM, CPU registers,
pixels, audio and digest, check against Node SHA-256, require visible fixture
pixels, and cover 1/2/3/4 pads, gapped slots, release and reload, plus all three NES filter qualities and invalid bootstrap rejection. The GBC fixture
proves bank-1 header visibility and fixed-bank context survive bank-2 writes.
The MBC3 fixtures actively latch RTC, run timer/serial and HRAM-based OAM DMA, and generate audio. Core-only mutation probes cover CPU, RAM, mapper/cart, timer/clock, PPU/palette/OAM, DMA, serial/controller and audio histories. An MMC3 variant proves changing a saved bank register changes the digest and the next CPU-visible ROM read. An equivalent cached PPU boundary representation preserves both digest and the next eight frames. Pinned snapshot formats are parsed only inside these core tests; the app never parses them.
A passing fixture cannot establish that every third-party cartridge or mapper is
rollback-safe; unsupported options and future serializer changes require schema
review and matching future-output tests.

After building romdev-browser against this checkout, stage the read-only harness:

```sh
node packages/romdevtools/scripts/multiplayer/build-harness.mjs ../romdev-browser/dist
```

The app's existing `prepare-lib` copies it under a content-addressed library URL;
no app source imports this code. Open `m1/index.html`: it automatically checks the
same platform futures and native four-pad signatures. It reports build commit and
artifact SHA-256 values. A final live NES screen shows four colored players; choose
P1–P4 and hold Left/Right/A for **at least 50 ms**, observe the selected player's
position changing and every other player's position staying fixed. No sign-in is
needed: this static fixture contains no private game or account data. Copy the
report for the external test partner. The UI test harness compares audio bytes;
it does not play them through speakers.

WASM payloads are published with `scripts/browser-payloads.sh publish` after pushing
the source commit; commit its updated manifest so fresh checkouts reproduce the
same binaries. Source pins and existing patches remain in scripts/versions.json;
the recipes additionally apply the multiplayer patches and shared helper here.

## Clean checkout and CI payloads

The consumer packages pin the new in-tree core/tool versions. Regenerate the
workspace lockfile together with those pins; a partial version bump can make
`npm ci` resolve a second, older registry copy or reject the lockfile.

`node scripts/fetch-payloads.mjs --browser-payloads` verifies/fills the five
browser packages from `browser-payloads.json`, then fills unrelated packages
from their normal npm versions. This fork does not substitute upstream npm
binaries for its modified SDCC/gambatte/fceumm builds. CI uses this mode and
keys its payload cache on both the dependency lockfile and payload manifest.
The original npm-only mode remains available for upstream development.

## Pre-render world publications

The shared debug observer used by the GB/GBC/NES recipes records physical RAM
at a trusted engine's publication write, after world update and before view
rendering. It neither freezes nor advances the CPU and is not serialized.
The ROM owns an ordinary unbanked LE32 tick and a marker written with `0xa5`;
boot-time RAM clearing therefore does not publish spurious ticks. The host
binds the linked addresses and physical field ranges rather than interpreting
display-boundary RAM as a completed logical tick. Eight publications, 32 spans
and 1024 field bytes are hard bounds. Overflow is reported, never silently
accepted. Consumers must compare matching logical ticks and reject skipped or
repeated publications. Disarm/rebind around restore, reset and media changes.

Run `node --test packages/romdevtools/test/world-observation.test.js` after rebuilding
Gambatte and fceumm. Tests compare instrumented and uninstrumented causal state,
CPU registers, raw snapshots, pixels and audio for 130 frames on all three
platforms, retain pre-view bytes after later writes, and cover bounded overflow,
owned copies, lifecycle cleanup and the native C ABI. The engine publisher and
author world schema are separate upper-layer responsibilities.

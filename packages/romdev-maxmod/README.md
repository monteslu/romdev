# romdev-maxmod

Pure-JS **Maxmod soundbank compiler for the GBA** — a faithful port of devkitPro
`mmutil`. Parses a tracker module (**.xm / .mod / .it / .s3m**) and emits a Maxmod
**MAS soundbank** (`.bin` + `.h`) you link into a GBA ROM and play with the Maxmod
runtime (`mmStart()`). No native binary, no devkitPro.

Output is **byte-for-byte identical to real mmutil** (verified on .xm/.mod/.it).

```js
import { soundbankFromModule } from "romdev-maxmod";

const { bin, header } = soundbankFromModule(xmBytes, { name: "mysong" });
// bin    → the soundbank .bin (link as your soundbank_bin)
// header → "#define MOD_MYSONG 0\n#define MSL_NSONGS 1 ..." (the .h)
```

## API

- `soundbankFromModule(bytes, { name?, format? })` → `{ bin, header }`. One-call
  compile; sniffs the module format from content (override with `format`).
- `parseModule(bytes, opts?)` → the parsed MAS module model.
- `detectModuleFormat(bytes)` → `'it'|'xm'|'s3m'|'mod'|null`.
- `writeSoundbank(modules, samples?, opts?)` → `{ bin, header }` (multi-module banks).
- Format parsers: `parseXm`, `parseMod`, `parseIt`, `parseS3m`.

In romdev this is surfaced as `encodeAudio({ target:'maxmod' })`.

## Provenance

A faithful JS port of devkitPro/blocksds `mmutil` (mas.c/msl.c/xm.c/mod.c/it.c/
s3m.c/samplefix.c). Original C © 2008 Mukunda Johnson (ISC-style license). The
GBA `FixSample` loop-unroll (short forward loops → ≥512 samples) is ported in
`samplefix.js` — it's mandatory for byte-correct output. This port is MIT.

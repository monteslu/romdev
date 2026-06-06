# romdev-xgm2

Pure-JS **VGM → XGM2** music converter for the Sega Genesis / Mega Drive (SGDK's
XGM2 driver). A faithful port of SGDK's `xgm2tool` — **no Java, no jar, no native
binary.** Parse a `.vgm` (or gzipped `.vgz`), get the compiled XGM2 blob you
`.incbin` into a ROM and play with `XGM2_play()`.

Why this exists: `XGM2_play()` needs a *compiled* XGM2 blob (split FM/PSG streams
+ sample table), not raw VGM. SGDK's only official VGM→XGM2 compiler is
`xgm2tool`, a **Java** tool — heavy to bundle in a WASM-only toolchain. This is
that tool, ported to JS, so a music path needs zero external dependencies.
(ffmpeg cannot do this — XGM2 is a chiptune *register stream*, not audio samples.)

## Usage

```js
import { readFileSync } from "node:fs";
import { vgmToXgm2C } from "romdev-xgm2";

const vgm = readFileSync("song.vgm");           // or a gzipped .vgz
const { blob, cSource, lenDefine } = vgmToXgm2C(vgm, "bgm_level1");

// blob      -> Uint8Array, the XGM2 data (256-byte aligned in ROM)
// cSource   -> ready-to-#include C: `const u8 bgm_level1[] __attribute__((aligned(256)))` + BGM_LEVEL1_LEN
// then in your game:  XGM2_play(bgm_level1);
```

Lower-level:

```js
import { vgmToXgm2, emitC } from "romdev-xgm2";
const blob = vgmToXgm2(vgm, { packed: true, system: "ntsc" }); // packed = compiled/.xgc form
const c    = emitC(blob, "bgm_level1");
```

### Options
- `packed` (default `true`) — emit the **compiled** XGM2 blob (Z80-ready, what
  you embed and play). `false` emits the uncompiled `.xgm` form.
- `system` (`'ntsc'` | `'pal'` | `null`) — force the VGM timing flag (offset
  `0x24`). `null` keeps the VGM's own value.

## In romdev

`romdev-mcp` wraps this as `encodeAudio({target:'xgm2', vgmPath, name})` — emits
the C array directly. See the Genesis MENTAL_MODEL "music how-to".

## Provenance

Ported from [SGDK](https://github.com/Stephane-D/SGDK)'s `tools/xgm2tool` (MIT) at
the pinned SGDK commit. The XGM2 binary format is specified in SGDK's `bin/xgm2.txt`.

## License

MIT (matches SGDK).

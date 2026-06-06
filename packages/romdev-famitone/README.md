# romdev-famitone

Pure-JS **FamiTone2 music compiler for the NES** — a faithful port of Shiru's
`text2data` (nesdoug bug-fix fork). Parses a **FamiTracker `.txt` export** and
emits **FamiTone2-format music data** as ca65 `.s` source you assemble with the
FamiTone2 driver and play on the NES APU. No native binary, no Windows `.exe`.

```js
import { emitFamiTone2 } from "romdev-famitone";

const asm = emitFamiTone2(famitrackerTxt, { name: "mysong" });
// → ca65 .s text: `_mysong_music_data:` + instruments/envelopes/pattern bytecode
// assemble alongside famitone2.s and call FamiToneInit / FamiToneMusicPlay.
```

## API

- `emitFamiTone2(txt, { name })` → ca65 `.s` string. Accepts the raw FamiTracker
  text export directly (parses for you).
- `parseFamiTrackerTxt(txt)` → the parsed song model (inspect before emitting).
- `isFamiTrackerTextExport(txt)` → boolean sniff.

Output is byte-for-byte compatible with `text2data -ca65` and the FamiTone2 driver.
In romdev this is surfaced as `encodeAudio({ target:'famitone' })`.

## Provenance

A faithful JS port of `text2data.cpp` (FamiTone2 / famitone2d, by Shiru; nesdoug
fork). FamiTone2 is public domain. This port is MIT.

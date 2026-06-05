# romdev-cheats

The bundled cheat database for [romdev](https://github.com/monteslu/romdev),
split into its own package so the main `romdev-mcp` package stays small and the
database can grow and version independently.

It is a **data package** — no runtime logic of its own beyond a tiny lazy
loader. `romdev-mcp` depends on it and resolves it at runtime, then reads **one
platform's index at a time** (never the whole DB into memory).

## What's inside

`index/<platform>.json` — one compact `name → entries` map per platform. Each
entry is `{ desc, code, parts }` where `code` is the raw RetroArch cheat code
(applied to the core verbatim) and `parts` is the decoded address/value/kind for
inspection.

Platforms are limited to those romdev supports **and** that the
RetroArch/RetroDECK community cheats tree actually carries:

| Platform | id |
|---|---|
| NES | `nes` |
| Game Boy / Color | `gb`, `gbc` |
| Game Boy Advance | `gba` |
| SNES | `snes` |
| Sega Genesis / Mega Drive | `genesis` |
| Sega Master System | `sms` |
| Sega Game Gear | `gg` |
| Atari 2600 / 7800 | `atari2600`, `atari7800` |
| Atari Lynx | `lynx` |
| PC Engine / TurboGrafx-16 | `pce` |
| MSX | `msx` |

(C64 has no entry: the community cheats tree ships no Commodore-64 cheat folder.
Raw `ADDR:VAL` pokes via `makeCheat` still work on C64 in romdev.)

## API

```js
import { loadPlatformIndex, hasPlatform, listPlatforms, indexDir } from "romdev-cheats";

if (hasPlatform("genesis")) {
  const idx = await loadPlatformIndex("genesis"); // { platform, source, gameCount, games }
}
listPlatforms(); // ["atari2600","atari7800","gb","gba",...]
```

## Provenance

Cheat codes are community-aggregated data from the libretro-database / RetroArch
cheats lineage (originally Game Genie code books and GameHacking.org). The index
here is **pre-parsed** (decoded + compacted) by
`romdev/scripts/build-cheat-index.mjs` rather than a redistribution of the raw
`.cht` tree.

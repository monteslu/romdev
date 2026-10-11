# Assets guide: art, tiles, audio and cross-platform moves

romdev converts art and audio into platform-native data in the server. Host art and audio tools (LibreSprite/Aseprite, GIMP, Tiled, Audacity, a tracker, ImageMagick) are fine for producing source PNGs, `.ase`, `.tmj`, `.wav` or `.vgm` files; romdev imports and packs them. Read this with `platform({op:'doc', platform:'guide', name:'assets'})`.

## Pass paths, not bytes

The server runs on the same machine and shares the filesystem. Every tool that takes large binary input accepts a path; prefer it over base64. A 256 KB SNES ROM rebuilt 20 times is about 7 MB of base64 in your context; a path costs about 60 bytes.

- `loadMedia({platform, path})` instead of `base64`.
- `build({output:'rom', sourcePath, binaryIncludePaths, includePaths, outputPath})`, or `build({output:'project', path})` for a whole directory.
- `frame({op:'screenshot', path})`; add `scale:0.5` for a cheap "did it change?" check (not for reading text), or `crop:{x,y,w,h}` for a native-resolution strip of a HUD.
- `tiles({op:'png', source:'path', outputPath})` renders a ROM file's tiles to a sheet.

## Images to tiles

- `encodeArt({stage:'quantize'})` maps a PNG onto the platform palette; `stage:'tiles'` packs native tile bytes (`tileOrder:'sprite'` for column-major multi-cell sprite order on Genesis and Lynx); `stage:'tilemap'` packs a full screen; `stage:'crop'` and `stage:'validate'` crop and check. `encodeArt({stage:'tiles'})` checks the input against the platform's master palette (+-8 per channel) and reports out-of-gamut colours in `warnings[]`.
- `palette({source:'platformMaster', platform, format})`: `"png"` is a swatch sheet for remap dithering, `"lospec"` returns `{name, author, colors}` for LibreSprite or lospec.com, `"hex"` one `#RRGGBB` per line. `palette({source:'lospec'})` imports a Lospec palette. `palette({source:'live'})` reads the running game's palette.

### Full-screen pictures (splash, title, cutscene): use `encodeArt({stage:'tilemap'})`

Do not hand-roll a PNG-to-tile loop. The usual failure is right shapes, wrong colours and vertical striping: raw RGB values instead of palette indices, or wrong bit packing. Supported: nes, snes, genesis, sms, gg, gb, gbc, c64.

1. Size the source to the screen: Genesis 320x224, NES/SNES 256x224, SMS 256x192, GB 160x144, C64 320x200.
2. Quantize to the platform palette: `encodeArt({stage:'quantize'})`, or with a host tool against `palette({source:'platformMaster', platform, format:'png', outputPath:'/proj/art/pal.png'})`.
3. `encodeArt({stage:'tilemap', platform, pngPath, outputDir})` writes `chr.bin` (deduped tiles), `nametable.bin`, `palette.bin` and `preview.png`. The preview is rendered from the exported data: if it is right, the in-game result will be.
4. Upload `chr.bin` to VRAM, `palette.bin` to CRAM/CGRAM, `nametable.bin` to the BG plane. The response `note` gives sizes and destinations per platform.

Genesis: 4bpp tiles (32 bytes each), 40x28 cells, up to 4 palette lines of 16 colours; the encoder bin-packs colours across lines and picks a line per 8x8 cell. Name-table entries are 16-bit big-endian; set Plane A to 64 cells wide. `genesis.warnings[]` flags any cell needing more than 16 colours. NES: at most 256 unique tiles per pattern table, so busy art warns.

Platforms without a tilemap (Atari 2600 races the beam; the 7800 uses display lists) get an error with the reason; they need hand-authored per-scanline data.

## Editor formats: `importArt`

- `importArt({from:'aseprite', path, platform, outputDir})`: `.ase` (LibreSprite, Aseprite). Deduped `tile_bytes`, named `tiles[sliceName] = {tile_indices, width_tiles, height_tiles}`, and `tags[name] = {from, to, delays_ms[]}` animations. Indexed files keep the artist's palette; RGBA falls back to the platform master palette.
- `importArt({from:'tiled', path, platform, outputDir})`: Tiled `.tmj` (export JSON, not `.tmx`). Per-layer `data`, an `empty_mask` so "no tile" differs from tile 0, and `object_layers[name]` with named placements and properties.
- `importArt({from:'gif', path, platform, outputDir, frame_indices?})`: frames and delays from any GIF. GIF disposal is not applied; export with "Disposal: Replace".
- `importArt({from:'texturepacker', pngPath, manifestPath, platform, outputDir})`: TexturePacker-style PNG plus JSON (LibreSprite's "Export Sprite Sheet" JSON-Hash), with `meta.frameTags` animation groups.
- `importArt({from:'rom'})` pulls tiles out of a ROM; `emit` picks raw, C, ca65 or rgbasm output.

A worked example from palette to ROM is in the package at `examples/art-first-workflow/README.md`.

## Lifting a character from a game: meta-sprite capture

Rectangular tile regions (`tiles({op:'png', source:'path'})`, `encodeArt({stage:'crop'})`, `importArt({from:'rom'})`) are the wrong model for a character built from several hardware sprites, each with its own position, size, tile, palette, flips and priority. Multi-cell tile order differs per platform (Genesis is column-major; SNES large OBJ and NES/GB 8x16 have their own orders). Supported on genesis, snes, nes, gb, gbc, sms, gg (not C64, whose sprites are 24x21 bitmaps).

1. `loadMedia`, then step or press to a frame with the character fully on screen (not a menu; with no sprites up, captures are empty).
2. `sprites({op:'group', platform})` clusters on-screen OAM/SAT entries into objects, largest first. Pick a group's `slots`.
3. `sprites({op:'capture', platform, slots:[...] /* or rect */, name, emit:'both', outputDir})` writes `tiles.bin`, `palette.bin`/`.json`, `layout.json`, `preview.png` (rendered from the exported data) and a platform-idiomatic `<name>.h`, keeping hardware tile order.
4. Check `preview.png`; re-check any time with `sprites({op:'render', tilesPath, layoutPath})`.
5. Include `<name>.h` (Genesis: an SGDK draw helper; NES/GB: a shadow-OAM cell table; SNES: oamSet pieces; SMS: SAT cells), or get it later with `sprites({op:'emitC'})`.

`sprites({op:'preview'})` does step 2 plus a thumbnail and a ready capture call per group. `sprites({op:'extractScreenshot'})` is the lossy fallback when capture cannot be used: it crops a screenshot and flood-fills the background away.

## Moving a game between platforms

1. Study the source: `loadMedia({platform: A, path})`, `recordSession`, `disasm({target:'rom'})`.
2. Rip art: `tiles({op:'png', source:'path', platform: A, path})`.
3. Re-encode: `encodeArt({stage:'tiles', platform: B, pngPath})` in B's tile format and depth.
4. Write the target game: `build({output:'run', platform: B, source})`.
5. Inject converted art with `romPatch({op:'writeMany'})` where needed.

The tile codec handles 4 bit layouts by 4 depths. NES to GB is byte-exact at 2bpp; going up in depth (NES to SNES) gains palette room; going down (Genesis to GB) quantizes automatically. For a whole-ROM recompile instead of a remake, see the recompile guide.

## Audio

`encodeAudio({target})` converts audio to each platform's format:

- `brr`: raw 16-bit PCM to SNES BRR samples (the SPC700's only sample format), from `pcmPath`; `loop` sets the loop bit.
- `spc`: a note/duration `song` to the bundled SNES apu_blob driver's row table.
- `xgm2pcm`: Genesis sample SFX from a WAV (8-bit signed mono, 13.3 kHz or 6.65 kHz with `halfRate`, 256-padded) plus a 256-aligned C array for `XGM2_playPCM`.
- `xgm2`: Genesis music: a `.vgm`/`.vgz` compiled to an XGM2 blob plus a C array for `XGM2_play()` (a JS port of SGDK's xgm2tool; no Java). `system:'ntsc'|'pal'` forces timing.
- `maxmod`: GBA music: a tracker module (`.xm`, `.mod`, `.it`, `.s3m`) to a Maxmod soundbank (a JS port of mmutil, byte-identical to it).
- `famitone`: NES music: a FamiTracker text export to FamiTone2 ca65 data.
- `gg`, `sms`, `c64`, `lynx`, `atari7800`, `gb`, `gbc`: a note/duration `song` to that platform's bundled-driver note table (gb and gbc take multi-channel hUGEDriver songs).
- `sync32`: a note/duration `song` (up to 8 voices) to event tables for a game's own software synth. `sync32pcm`: a WAV to s16 mono samples at a ring-dividing rate.

Each target's exact input and output parameters are in the `encodeAudio` tool description. For where to get music in the first place (MIDI, trackers, transcription), read `platform({op:'doc', platform:'guide', name:'music'})`.

SNES sound is a separate SPC700 build (`platform:"spc700"`, then `.incbin` and the $2140-$2143 handshake); see the snes mental model.

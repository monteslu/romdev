# Game Boy Color — source you can read

GBC shares its toolchain (SDCC sm83) + emulator (gambatte) + most
of the runtime (`gb_runtime.c`, `gb_crt0.s`, `patch-header.js`,
hUGEDriver) with DMG. The CGB tree (`src/platforms/gbc/`) holds
the color-aware scaffolds; everything below is in lockstep with
the GB tree.

CGB-specific:
- `romPatch({op:'gbHeader', cgb: true})` sets $0143 = $80 → gambatte boots
  in CGB mode with color palette RAM active
- VRAM bank 1 (selected via VBK = $FF4F) holds per-tile attribute
  bytes (palette index, H/V flip, BG-OAM priority)
- BCPS/BCPD ($FF68/$FF69) — 8 BG palettes × 4 colors × BGR555
- OCPS/OCPD ($FF6A/$FF6B) — same shape, sprite palettes
- DMG-only BGP/OBP* registers are ignored in CGB mode

Reference: Pan Docs § "CGB Registers" + § "CGB Mode".

Trust hierarchy:

1. **Bundled examples** (`examples/gbc/templates/*.c`).
2. **Bundled runtime** — `src/platforms/gb/lib/c/gb_runtime.c`,
   `gb_crt0.s`, `patch-header.js`, `hUGEDriver.c` (full source).
3. **SDCC sm83 port** — we ship the WASM compiler but NOT the SDCC
   source tree. For SDCC bugs, see upstream below.
4. **Upstream GitHub**:

   | What | Upstream |
   |---|---|
   | SDCC | http://sdcc.sourceforge.net/ + https://sourceforge.net/projects/sdcc/ |
   | hUGEDriver | https://github.com/SuperDisk/hUGEDriver |
   | RGBDS (asm path) | https://github.com/gbdev/rgbds |
   | gambatte libretro core | https://github.com/libretro/gambatte-libretro |
   | gambatte proper | https://github.com/sinamas/gambatte |

## GB hardware docs

- **Pan Docs** (canonical, everything): https://gbdev.io/pandocs/
- **GBDev community resources**: https://gbdev.io/
- **opcode reference**: https://gbdev.io/gb-opcodes/optables/
- **SDCC sm83 specifics**: see `src/platforms/gb/lib/c/SDCC_GOTCHAS.md`

## hUGEDriver music format

See `src/platforms/gb/lib/c/hUGEDriver.c` header comment + the
upstream README. Songs are exported from hUGETracker
(https://github.com/SuperDisk/hUGETracker) as `.c` files —
`song_data.c` in our bundle is one such export.

## When to use what

- "OAM DMA wedges sprites" → see `MENTAL_MODEL.md` § R26 footguns +
  `gb_runtime.c` `oam_dma_copy` implementation
- "BGP write does nothing" → check $0143 (CGB flag) via
  `romPatch({op:'gbHeader'})` + Pan Docs § "The Cartridge Header"
- "How does hUGEDriver process a song row?" → `hUGEDriver.c`
  `hUGE_dosound` body — fully readable
- "Why is gambatte refusing my ROM?" → check the header, then
  libretro-gambatte source for the load path

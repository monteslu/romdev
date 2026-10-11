# Game Boy - source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/gb/templates/*.c`).
2. **Bundled runtime** - `src/platforms/gb/lib/c/gb_runtime.c`,
   `gb_crt0.s`, `patch-header.js`, `hUGEDriver.c` (full source).
3. **SDCC sm83 port** - romdev ships the WASM compiler but NOT the SDCC
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
- **SDCC sm83 specifics**: the romdev SDCC gotchas list, https://github.com/monteslu/romdev/blob/main/packages/romdevtools/src/platforms/gb/lib/c/SDCC_GOTCHAS.md

## hUGEDriver music format

See the header comment of the bundled `hUGEDriver.c` + the
upstream README. Songs are exported from hUGETracker
(https://github.com/SuperDisk/hUGETracker) as `.c` files -
`song_data.c` in the bundle is one such export.

## When to use what

- "OAM DMA wedges sprites" → see the silent-failure footguns in `platform({op:'doc', platform:'gb', name:'mental_model'})` +
  `gb_runtime.c` `oam_dma_copy` implementation
- "BGP write does nothing" → check $0143 (CGB flag) via
  `romPatch({op:'gbHeader'})` + Pan Docs § "The Cartridge Header"
- "How does hUGEDriver process a song row?" → `hUGEDriver.c`
  `hUGE_dosound` body - fully readable
- "Why is gambatte refusing my ROM?" → check the header, then
  libretro-gambatte source for the load path

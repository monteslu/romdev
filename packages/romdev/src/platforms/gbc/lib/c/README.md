# GB / GBC C runtime + headers

These are the source files that back the GB/GBC C templates. They're
**not** auto-injected at build time — `createProject({platform:"gb"|"gbc",
template:"..."})` copies them into your project directory so the
project is self-describing. Build calls then point at your project's
copy of these files via `sourcesPaths` / `includePaths` / `crt0Path`.

| File           | Copied as | What's in it |
|---|---|---|
| `gb_hardware.h` | header `gb_hardware.h` in include path | Symbolic names for every GB / GBC I/O register (`LCDC`, `BGP`, `JOYP`, `BCPS`, etc.) plus LCDC bit masks. Uses SDCC's `__sfr __at 0xFFNN` form (full 16-bit address, not port number). |
| `gb_runtime.h` | header `gb_runtime.h` in include path | Declarations for the helper functions below. |
| `gb_runtime.c` | extra translation unit, linked automatically | `wait_vblank()`, `joypad_read()`, `oam_dma_copy()`, `memcpy_vram()`, `lcd_init_default()`, plus the OAM helpers `oam_clear()`, `oam_set(slot,y,x,tile,attr)`, `oam_dma_flush()` driving the 160-byte `shadow_oam[]` global. |
| `gb_crt0.s` | replaces stock SDCC sm83 crt0 (assembled internally) | Lays out a real cartridge: reset/IRQ vectors at $0000-$0060, entry stub at $0100, reserves $0104-$014F as the header window, puts `init:` in `_CODE` at $0150. |
| `unroll.h` | header `unroll.h` in include path | `UNROLL_2..UNROLL_64` macros for manual loop unrolling. Originally a workaround for the now-fixed sm83 register-allocator crash family; left in for code that still uses it. You don't need it for new code. |

Just `#include "gb_hardware.h"` and (optionally) `#include "gb_runtime.h"` —
both work in any GB/GBC C build the agent submits. Caller-supplied files
of the same name win on collision, so you can override.

**Cart header is auto-fixed at build time.** `build({output:'rom'})` / `build({output:'run'})`
run rgbfix on the linked GB/GBC ROM — valid Nintendo logo at $0104,
header checksum at $014D, global checksum at $014E, cartridge-type /
RAM-size bytes, and the CGB flag at $0143 ($80/$C0 for `.gbc`, $00 for
`.gb`). A freshly built ROM boots on hardware and strict cores with **no
extra step** — you do not call `patchGbHeader` after a normal build.

Reach for header tooling only when working with a ROM the build pipeline
didn't produce, or to override a field:

- `patchGbHeader({path: "out.gb"})` — MCP tool (loadCategory:"project").
  Fixes up / overrides the header of an existing ROM on disk (title, cart
  type, ROM/RAM size, CGB flag, etc.).
- `node patch-header.js out.gb` — standalone Node script, copied into
  every GB project by `scaffold({op:'project'})`. Same logic, no MCP needed.
- `rgbfix -v -p 0 out.gb` — what the build pipeline runs under the hood;
  RGBDS asm projects can invoke it directly.

## Companion docs

- **[`../../TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md)** — symptom →
  fix table. Start here when your ROM compiles but doesn't render right
  ("screen blank", "sprite invisible", "wrong colors", "freezes").
- **[`../../MENTAL_MODEL.md`](../../MENTAL_MODEL.md)** — one-page
  architecture overview: VRAM banks, palettes (DMG vs CGB), sprite
  hardware, OAM DMA timing, joypad layout. Read this before your first
  GB/GBC project.

## Project templates

Bootstrap a working game-loop skeleton with `scaffold({op:'project'})`:

```js
createProject({
  platform: "gbc",
  template: "tile_engine",   // or "hello_sprite", or "default"
  name:     "mygame",
  path:     "/abs/path",
})
```

Templates ship in `examples/{gb,gbc}/templates/`:

| Template | What you get |
|---|---|
| `default` | Minimal palette-cycle hello-world. Use when you're not sure what to build yet. |
| `hello_sprite` | LCD init + 16-byte tile upload + 4-color OBJ palette + sprite slot 0 + d-pad movement. ~80 lines, tested end-to-end. |
| `tile_engine` | 20×18 BG map render from a `room[]` array + collision + multi-room transitions via doors. ~200 lines. Covers the Adventure / Zelda-1 / Sokoban shape. |

## SDCC 4.4.0 quirks

**Read first: [`SDCC_GOTCHAS.md`](./SDCC_GOTCHAS.md).** Short doc —
mostly covers C89 syntax requirements. The big "register allocator
crash family" that motivated this whole document originally was
diagnosed as an emscripten stack overflow on 2026-05-25; fixed at the
build level. Patterns that used to require `unroll.h` workarounds
compile cleanly now.

`build({output:'rom'})` runs a **pre-flight linter** that catches C89 violations
(mid-block declarations, C99 inline for-loop counters) before SDCC's
own misleading error messages. Hits come back as warnings in the
`issues[]` array tagged `stage: "lint"`.

Pass `lint: "strict"` to fail the build on any lint hit. Default is
advisory.

## Splitting into multiple `.c` files (optional)

Not required for correctness anymore, but still useful for iteration
speed: smaller TUs rebuild faster. Use `sourcesPaths` (or `sources` for
inline text) when it helps:

```js
buildSource({
  platform: "gbc",
  language: "c",
  sourcesPaths: {
    "main.c":    "./src/main.c",      // game state, vblank loop
    "render.c":  "./src/render.c",    // VRAM writes, sprite list
    "objects.c": "./src/objects.c",   // game-object logic
    "data.c":    "./src/data.c",      // const tables
  },
  outputPath: "./mygame.gbc",
})
```

Each `.c` becomes its own SDCC translation unit. The linker glues
them together; `extern` globals tie shared state across files.

When a multi-TU build fails, the response includes `failedTU` (the
file that died) and `compiledOK` (the TUs that compiled cleanly
before the failure). That tells you exactly which file to bisect
without grepping the log.

## Stock GBDK alternative

The bundled runtime is intentionally minimal (~10 helpers). If you
need the full GBDK-2020 surface (sprites, tile sets, font, sound driver),
write asm-level RGBDS code via `language: "asm"` or pull the runtime
code you need into your project's `sources`.

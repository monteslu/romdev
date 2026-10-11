# Active Bezels guide

An Active Bezel is an executable companion to a specific ROM (a `.ab` package). It runs once per emulated frame, reads the core's live memory, and renders the final scene (a map, a HUD, reconstructed graphics) around or over the game. Read this with `platform({op:'doc', platform:'guide', name:'bezels'})`.

## Loading one

```js
loadMedia({platform:'nes', path:'/roms/Game.nes', useActiveBezel:true})
```

This looks for a same-basename sidecar (`Game.nes` to `Game.ab`) and fails if there is none, rather than loading the ROM alone.

Development overrides (ordinary use relies on the sidecar): `activeBezelPath` points at a package elsewhere (an unpacked directory works), `activeBezelConfig` passes per-package settings, `activeBezelForce:true` loads despite a ROM-hash mismatch (the composite may then be meaningless: a map keyed to another revision's RAM draws wrong things), and `activeBezelRenderer:'software'` pins the deterministic CPU compositor for golden-frame comparisons. `coreOptions` can hide a core layer at the renderer (e.g. `{"snes9x_layer_3":"disabled"}`) so the bezel owns it.

Not supported on `slot:'b'`, which is comparison scratch for `frame({op:'sideBySide'})`.

## Screenshots are the composite

With a bezel running, `frame({op:'screenshot'})` returns the composite by default, not the raw framebuffer. Before interpreting a capture in an unfamiliar session, check `catalog({op:'status'})`: it reports `activeBezel` whenever one is attached.

A package can load, tick without trapping, draw valid commands, and still have nothing to do with the game. Check meaning by observing three things at the same frame:

```js
frame({op:'screenshot', source:'both', path:'/proj/shots/check.png'})
```

`source` is `'composite'` (default with a bezel, what the human sees), `'core'` (the raw framebuffer), or `'both'` (the pair for the same frame plus the geometry). Compare the two against your own region reads.

Geometry keys under `geometry`:

| Key | What it is |
|---|---|
| `core` | the raw framebuffer the emulator produced; not the intended shape (Atari 2600 pixels are not square) |
| `scene` | the bezel's logical composition, which the host may scale |
| `display` | the runtime's account: `logicalWidth/Height`, `internalWidth/Height`, `physicalWidth/Height`, `pictureEffect`, `rendererBackend` (`opengl-es-3` or `cpu`) |

When a golden frame stops matching, check `display.rendererBackend` first.

## Lifecycle

- The bezel ticks on every `frame({op:'step'})`, not only at capture time.
- `host({op:'unload'})` and `host({op:'shutdown'})` detach it, and a plain `loadMedia` without the flag detaches the previous one. A package is bound to a ROM hash.
- `host({op:'reset'})` and `state({op:'load'})` keep the package and notify it that continuity broke, so it drops caches from the abandoned timeline.
- A guest fault is recorded in `activeBezel.lastError` and the capture falls back to the core frame.
- A script error is not a guest fault: the scripting runtimes catch it and draw an error panel, so `error` and `lastError` stay null. `catalog({op:'status'})` reports it as `activeBezel.BEZEL_SCRIPT_ERROR` (from the runtime's `scriptError`); check that key before calling a bezel healthy.
- `playtest({op:'bezel', show:false})` (or the human's B hotkey) suspends the bezel without teardown: captures and the window show the core frame, `pre_frame` stops, and the guest keeps its state (resuming does not re-run `init()`). `catalog({op:'status'})` shows `activeBezel.bypassed`.

## pre_frame: shaping the frame (ABI 2)

A package may define `pre_frame(frame)`, which the host calls before every core frame on every driver (`frame` steps, `runUntil`, watch and breakpoint runs, playtest). Inside it the bezel can write live regions (a `tick`-time write would be one frame late) and call `ab.input_override(port, device, index, id, value)` to replace what the core is polled with (id 256 is the whole joypad mask). Overrides clear at the top of every frame, and `ab.input` keeps reporting the physical pad.

When debugging a session with such a bezel:

- `catalog({op:'status'})` reports `activeBezel.preFrame` `{defined, calls}`. Check it before trusting a negative input result or a "value changed with no writer" observation: pre_frame writes are host-side pokes, invisible to `breakpoint` and `watch`, and an input you pressed may never reach the game.
- `input({op:'set'})` still sets the physical pad; the core sees physical plus override. `activeBezel.preFrameHookError` reports a hook that threw.

`input({op:'set'})` also takes a raw analog channel per port: `ports:[{right:true, axes:{lx:0.6, rt:1}}]` (sticks -1..1, triggers 0..1). Axes feed the libretro analog device and a bezel's analog `ab.input` reads (`ab.DEVICE.ANALOG`, index `ab.ANALOG.LEFT/RIGHT` with id `ab.ANALOG.X/Y`, or index `ab.ANALOG.BUTTON` with id `ab.BTN.L2/R2` for trigger pressure). In the playtest window a physical pad's triggers land on the L2/R2 mask bits (with a baseline and hysteresis) and both sticks and trigger pressures flow through as axes. Most retro games ignore L2/R2/L3/R3, which makes them free for bezel controls.

## Writing one

The `active-bezel` package ships prebuilt runtimes, so a bezel needs no toolchain:

```sh
npx --package active-bezel abtool scaffold my-bezel lua
```

| Language | Scaffold | Script | API root |
|---|---|---|---|
| Lua 5.4 | `abtool scaffold my-bezel lua` | `main.lua` | `ab.` |
| Python (MicroPython) | `abtool scaffold my-bezel python` | `main.py` | `ab.` |
| JavaScript (QuickJS) | `abtool scaffold my-bezel js` | `main.js` | `ab.` |
| Ruby (mruby) | `abtool scaffold my-bezel ruby` | `main.rb` | `AB.` |
| C | `abtool scaffold my-bezel c` | `main.c` | `ab_*()` |

The scaffold is a complete, working package: runtime wasm, a commented script with an example of each capability (2D shapes, the live game, TrueType and bitmap text, memory reads, transforms, a decoded PNG, a per-vertex mesh, a GLSL effect) and a manifest. The four scripting languages expose the same API.

```lua
function tick(frame)
  ab.clear(ab.rgb(14, 16, 26))
  ab.draw_game(0, 0, 1440, 1080, ab.SAMPLE.NEAREST)
  local ram = ab.region('system_ram')
  ab.print(font, ('HP %d'):format(ab.read_u8(ram, 0x0E)), 1500, 80, 40, 0xffffffff)
end
```

Iteration: `activeBezelPath` takes an unpacked directory, so edit the script, `loadMedia` again, take a screenshot. To keep game state across a reload: `state({op:'save'})`, `loadMedia`, `state({op:'load'})`.

The script contract is `init()` / `pre_frame(frame)` / `tick(frame)` / `event(kind)`; only `tick` is required. `ab.input_override` is honoured only inside `pre_frame`. A script error draws the message and failing line on screen and the bezel keeps ticking.

- Single-pass RetroArch shaders port into `ab.effect_set()` almost verbatim (rename `Texture` to `u_texture`, `vTexCoord` to `v_uv`, `FragColor` to `out_color`, add `#version 300 es`). Gate on `v_uv` to treat only the game rect.
- `ab.surface_create(w, h)` is an offscreen render target; `ab.surface_filter(src, dst, glsl)` runs one shader into it; `ab.surface_preset(src, dst, 'crt.glslp')` runs a multi-pass RetroArch preset at the source's own scale. `ab.GAME` is the live frame as a texture. No shaders ship; use [libretro/glsl-shaders](https://github.com/libretro/glsl-shaders) or a RetroArch install.
- `ab.input(port, ab.DEVICE.JOYPAD, 0, ab.BTN.A)` reads the same libretro state the core does, so an on-screen input display agrees with the game.

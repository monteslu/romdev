# wasmcart guide

A wasmcart is a game compiled to WebAssembly against the wasmcart ABI, run by romdev's wasmcart host instead of an emulator core. This covers loading, input, GPU carts, the playtest window and cart introspection. Read it with `platform({op:'doc', platform:'guide', name:'wasmcart'})`.

## Loading

```js
loadMedia({platform:'wasmcart', path:'/proj/game.wasc'})   // a .wasc package or a bare .wasm
```

- romdev requires wasmcart ABI v4 or later. Carts built against an older ABI are refused at load with the reason; rebuild them against current wasmcart headers.
- Host-to-cart writes (GL strings, WebGPU messages, text payloads) need the cart to export `wc_alloc` and `wc_free`.
- A cart whose input or clock pointer is zero or misaligned is not written through; the load result and `catalog({op:'status'})` report `abiWarnings`, and `wasm({op:'conformance'})` fails the cart (`input-span-overlap`).
- `deterministicSeed` with `deterministicStepMs` (a whole number such as 16) steps a virtual clock by a fixed step, so a run can be compared frame for frame with a native build that uses a fixed frame time.
- Every GL cart gets its own GL context. Setting `ROMDEV_SHARED_GL=1` in the server's environment restores the older shared context.
- `pack({target:'wasc'})` builds a `.wasc` from a `.wasm` and its assets. The manifest's `version` is `version` if given (semver, else an error), else the source's git checkout: at a clean `v1.4.2` tag `1.4.2`, anywhere else `1.4.2-dev.g<commit>` (`0.0.0-dev.g<commit>` before the first tag); outside git a source manifest's own version, else `0.1.0`. Same rule as `wasmcart-pack` and cartwheel's build.

## Input

- Buttons are mapped by position, as on every libretro core: `input({op:'set', ports:[{a:true}]})` presses the east face button (`WC_BTN_B`), `b` presses south (`WC_BTN_A`). The spatial names `south`, `east`, `west` and `north` are accepted and say what they mean.
- Stick axes from `input({op:'set'})` reach the cart (`axes:{lx, ly, rx, ry, lt, rt}`; sticks -1..1, triggers 0..1). Triggers reach the cart as 0..32767. An axes-only set echoes `requestedAxes`.
- `input({op:'pointer', x, y, left?, right?, id?, active?})` is absolute mouse or touch for carts that declare `FLAG_POINTER`. `id` selects the slot: 0 is the mouse (default), 1 to 9 are touch fingers; several slots at once is a multi-finger gesture. `active:false` releases a slot, as a real host does on touchend. Test with `id:1` or higher: a cart that polls only pointer 0 works with a desktop mouse and ignores every touch on a phone.
- wasmcart's test cart shows everything a cart receives: every pad with all 21 button bits, sticks and triggers, every pointer slot, the wheel and the keyboard, a note per face button (L and R pan it to one channel), and a save checked byte for byte at every start. It ships in the wasmcart package romdev runs on, at `node_modules/wasmcart/testcart/testcart.wasc` (inside romdevtools' own `node_modules`, or the one it was installed into). Load it to check what `input` delivers, or open it in the playtest window to check a real controller; its debug fields (`pad.buttons`, `pad.lt`, `ptr.active`, `audio.tones`, `save.status`, ...) give the same values by name. In the playtest window a controller's Guide and back paddles reach a wasmcart cart as `WC_BTN_GUIDE` and `WC_BTN_PADDLE1`-`4` (on a libretro core Guide is Select).
- The keyboard: `input({op:'set', ports, keys:['space', 'w']})` holds keys from the next frame on, and each step of `input({op:'sequence'})` takes `keys` the same way (`{input:{ports:[...], keys:['d']}, frames}`), held while the step holds. Names are SDL scancode names (`a`-`z`, `0`-`9`, `space`, `return`, `escape`, `tab`, `backspace`, `left`/`right`/`up`/`down`, `lshift`, `lctrl`, `lalt`, `f1`-`f24`, `-`, `=`, `[`, keypad keys as `kp1` or `keypadenter`; case and spaces do not matter, so `Left Shift` works), or USB HID scancode numbers. A set or step that names no keys releases them all, as it releases the buttons it does not name; a pointer or wheel call leaves them held. Delivery is a real host's: `wc_kb_on_down`/`wc_kb_on_up` once per change with the modifier bits of the keys then held, and the 256-bit held mask written before every frame, so a cart's `key:space` binding is driven exactly as a player's keyboard drives it. The result names the keys (`keys`, `scancodes`) and says `keyboard:false` with a note when the cart never set `WC_FLAG_KEYBOARD` (a real host sends such a cart no keys either). Keys are wasmcart only; the C64 keeps `pressKey`/`typeText`. The test cart's `key.held`, `key.downs`, `key.ups`, `key.mods` and `key.log` show what arrived.
- A bot looks ONCE per decision: `input({op:'sequence', steps, fields:['cue.arrow', 'game.done'], stopWhen:{field:'game.done', equals:1}})` runs the range and returns `fields:{name: value}` read from the cart's debug ABI after the last frame (a number, an array for array fields, a bytes field's text; never the capped listing), and ends the range the frame the goal field gets there (`stopped:{field, value, step, frameCount}`, or `false`; `framesRun` counts what ran). `frame({op:'step', frames, fields, stopWhen})` does the same for a plain step. `stopWhen` takes `equals`, `atLeast` or `atMost`, `index` for an element of an array field and `every` (frames between checks, default 1). An unknown field name is an error, never an empty value. Never step then read in two requests, and never a request per frame.
- `input({op:'wheel', notches})` is the scroll wheel. One click of a detented wheel is `notches:1`; fractions are allowed (0.25 is a trackpad nudge); positive is up, as in SDL. `notchesX` scrolls horizontally; `dx`/`dy` are raw 1/120-notch units. The delta belongs to the next frame stepped and is cleared after it, so step a frame to observe it; calls before that step accumulate. A zero delta is refused.

## WebGPU carts

A cart that imports WebGPU (wasmcart's optional `gpu_api` 2 tier: `webgpu.h` from Dawn's emdawnwebgpu port, built with Emscripten or wasi-sdk, threads included; see wasmcart's `docs/webgpu.md`) loads with the same `loadMedia` call.

- The load result reports `gpu` (`'webgpu'`, `'gl'`, or null for 2D) and `capabilities.hasWgpuRendering`.
- Frame steps yield to the event loop between every two frames, and input ops (`press`, `sequence`, `timeline`, `navigate`) await each step. Pixels come back by an asynchronous GPU readback at the end of each step, so screenshots show the cart's real frame.
- A WebGPU cart's own async results (a compute readback, an error scope) arrive between tool calls; step again if a value it waits for has not landed.
- Frames are not bit-identical across GPUs or backends. Compare named debug state (`wasm({op:'debugState'})`), not frame hashes, across machines.
- A WebGPU-only cart on a host without WebGPU is refused at load. A cart importing both GPU APIs runs on whichever the host has; `loadMedia({..., wgpu:false})` makes the load act as a host without WebGPU, so you can compare both renderers on one server.
- A WebGPU cart gets a core device where the GPU has one, else compatibility mode, and `status.gpuAdapter.featureLevel` says which. A core device does not enforce compatibility mode's limits, and every cart that does not request core must run within them: test with `loadMedia({..., wgpuFeatureLevel: "compatibility"})`.
- On a machine with two GPUs, `gpuPower:'low-power'` puts the cart on the integrated GPU and `'high-performance'` on the discrete one (unset: the server's `WASMCART_WGPU_POWER`, else the driver default). The result's `gpuAdapter` names the GPU it got; assert on it if your work must stay off a GPU. Set at load time.
- `playtest()` works on a WebGPU cart (the window draws each read-back frame).
- `gpuTiming:true` makes the cart's WebGPU device with the timestamp-query feature (where the adapter has it), which `frame({op:'timing'})` needs for GPU time and the cart's own pass timers need to run; `gpuAdapter.timestampQuery` in the load result says whether it got it. Off by default, so the device is wasmcart's floor, as in a browser host. GL carts need nothing: their timer queries are always there, and the load result's `glRenderer` names the GPU the GL context is on.
- `preferredSize:{width, height}` is written into the cart's host info before `wc_init` (wasmcart's preferredWidth/preferredHeight), so a cart that sizes itself from the host renders at that size. `firstCommand:'...'` posts a debug-channel request (as `wasm({op:'command'})` sends) before the cart's first frame, which the load runs, so the cart answers it in that frame; the reply is the load result's `firstCommandReply` (`{error}` if the cart did not answer). A switch the game reads from its first frame reaches it this way. All three are set at load time.
- `frame({op:'timing'})` times a span of frames in one call (wall, CPU and GPU per frame, windows, the worst frame, the cart's pass timers, A/B variants, and which GPU did the work); `frame({op:'flash'})` checks a range of frames for photosensitive flashing with a strobe control that must fail, and `frame({op:'record'})` writes the range to one file. All three run on GL and WebGPU carts; the agent guide's "Frame and GPU timing" and "Flash check and ranged frame capture" sections have the details.

## The playtest window on GL carts: `presentWindow:true`

Without it, a GL cart's frames are read back to the CPU so SDL can draw them, which costs about a third of a frame at 1080p. `loadMedia({platform:'wasmcart', path, presentWindow:true})` lets the window present by GPU blit and swap instead (measured on a 1080p 3D cart: `convertMs` 3.52 to 0, window cost about 7.45 ms to 2.0 ms).

- Set it at load time; the GL context binds when the cart's wasm loads and cannot be swapped afterwards.
- Screenshots are unaffected: `frame({op:'screenshot'})` and `playtest({op:'framebuffer'})` return the full cart frame at the cart's resolution, byte-identical to a plain load, whatever the human does to the window. A difference is a bug to report.
- Skip it for headless work: it costs one extra GL context per cart and buys nothing without a window.
- GL carts only.

## Looking inside a cart: the `wasm` tool

- `conformance`: validates the cart against the wasmcart spec (required exports, manifest ABI vs the instance, declared vs actual resolution, manifest shape) and returns `{conforms, issues[]}`, each issue naming the fix.
- `info`, `exports`, `save`: the running WCInfo, the module's exports, the declared save bytes.
- `debugState`: the cart's opt-in named debug table (`WC_FLAG_DEBUG` plus `wc_debug_state()`), each field with type and value. Bytes fields render as `{length, hex, text}`, capped at 256 bytes.
- `read` / `write`: a named debug field (`name`, with `value`, or `hex` for a bytes field) or raw linear memory (`offset`).
- `events`: drains the frame-stamped `wc_log` / `wc_debug_mark` trace since the last drain.
- `command` `{text}`: a request and reply channel through named debug fields (`dbg.cmd`, `dbg.reply`, `dbg.cmd_seq`, `dbg.reply_seq`, `dbg.reply_len`). The op writes the request, steps until the cart answers (one frame per command), and returns the reply (parsed as JSON when it is JSON). `help` lists a cart's commands.

`frame({op:'verify'})` works on wasmcart and jsgame hosts (pixel scan only; GL carts are scanned through the offscreen readback; `render.renderEnabled` is null).

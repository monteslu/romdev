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
- `pack({target:'wasc'})` builds a `.wasc` from a `.wasm` and its assets.

## Input

- Buttons are mapped by position, as on every libretro core: `input({op:'set', ports:[{a:true}]})` presses the east face button (`WC_BTN_B`), `b` presses south (`WC_BTN_A`). The spatial names `south`, `east`, `west` and `north` are accepted and say what they mean.
- Stick axes from `input({op:'set'})` reach the cart (`axes:{lx, ly, rx, ry, lt, rt}`; sticks -1..1, triggers 0..1). Triggers reach the cart as 0..32767. An axes-only set echoes `requestedAxes`.
- `input({op:'pointer', x, y, left?, right?, id?, active?})` is absolute mouse or touch for carts that declare `FLAG_POINTER`. `id` selects the slot: 0 is the mouse (default), 1 to 9 are touch fingers; several slots at once is a multi-finger gesture. `active:false` releases a slot, as a real host does on touchend. Test with `id:1` or higher: a cart that polls only pointer 0 works with a desktop mouse and ignores every touch on a phone.
- wasmcart's test cart shows everything a cart receives: every pad with all 21 button bits, sticks and triggers, every pointer slot, the wheel and the keyboard, a note per face button (L and R pan it to one channel), and a save checked byte for byte at every start. It ships in the wasmcart package romdev runs on, at `node_modules/wasmcart/testcart/testcart.wasc` (inside romdevtools' own `node_modules`, or the one it was installed into). Load it to check what `input` delivers, or open it in the playtest window to check a real controller; its debug fields (`pad.buttons`, `pad.lt`, `ptr.active`, `audio.tones`, `save.status`, ...) give the same values by name. In the playtest window a controller's Guide and back paddles reach a wasmcart cart as `WC_BTN_GUIDE` and `WC_BTN_PADDLE1`-`4` (on a libretro core Guide is Select).
- `input({op:'wheel', notches})` is the scroll wheel. One click of a detented wheel is `notches:1`; fractions are allowed (0.25 is a trackpad nudge); positive is up, as in SDL. `notchesX` scrolls horizontally; `dx`/`dy` are raw 1/120-notch units. The delta belongs to the next frame stepped and is cleared after it, so step a frame to observe it; calls before that step accumulate. A zero delta is refused.

## WebGPU carts

A cart that imports WebGPU (wasmcart's optional `gpu_api` 2 tier: `webgpu.h` from Dawn's emdawnwebgpu port, built with Emscripten or wasi-sdk, threads included; see wasmcart's `docs/webgpu.md`) loads with the same `loadMedia` call.

- The load result reports `gpu` (`'webgpu'`, `'gl'`, or null for 2D) and `capabilities.hasWgpuRendering`.
- Frame steps yield to the event loop between every two frames, and input ops (`press`, `sequence`, `timeline`, `navigate`) await each step. Pixels come back by an asynchronous GPU readback at the end of each step, so screenshots show the cart's real frame.
- A WebGPU cart's own async results (a compute readback, an error scope) arrive between tool calls; step again if a value it waits for has not landed.
- Frames are not bit-identical across GPUs or backends. Compare named debug state (`wasm({op:'debugState'})`), not frame hashes, across machines.
- A WebGPU-only cart on a host without WebGPU is refused at load. A cart importing both GPU APIs runs on whichever the host has; `loadMedia({..., wgpu:false})` makes the load act as a host without WebGPU, so you can compare both renderers on one server.
- On a machine with two GPUs, `gpuPower:'low-power'` puts the cart on the integrated GPU and `'high-performance'` on the discrete one (unset: the server's `WASMCART_WGPU_POWER`, else the driver default). The result's `gpuAdapter` names the GPU it got; assert on it if your work must stay off a GPU. Set at load time.
- `playtest()` works on a WebGPU cart (the window draws each read-back frame).

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

# romdev-core-runner

Play the ROM you just built: one call opens a real SDL window running any
`romdev-core-*` emulator core, with keyboard + hot-plug gamepad input,
audio at the core's native rate, and aspect-correct pixel-perfect scaling.

```js
import { runRom } from "romdev-core-runner";
import * as core from "romdev-core-fceumm"; // any romdev-core-* package

const session = await runRom("game.nes", { core });
await session.closed; // resolves when the human closes the window
```

`rom` is a file path or raw `Uint8Array` bytes. No cores are bundled; the
caller passes the core package (or a `{ jsPath, wasmPath }` pair). This is
the same SDL host the [romdev](https://github.com/monteslu/romdev) MCP
server's playtest window is built on (the server layers agent-tier extras
on top). One host implementation in the whole ecosystem.

## Options

```js
runRom(rom, {
  core,        // REQUIRED: romdev-core-* package namespace or { jsPath, wasmPath }
  platform,    // platform id; inferred from the core package when possible
  scale: 3,    // initial window size, in multiples of the framebuffer
  title,       // window title (default: ROM basename + platform)
  aspect: "tv",// "tv" (real-hardware display shape) | "fb" (raw framebuffer)
               // | "core" (core-reported ratio)
  buttonMap,   // SDL button name -> RetroPad bit, replaces the default map
  keyMap,      // keyboard key -> RetroPad bit, replaces the default map
  log,         // (msg) => void progress/warning logger (default: silent)
})
```

`buttonMap` / `keyMap` exist for platforms with custom layouts (GameTank's
two-button pad, C64 joystick + keyboard); the defaults cover the standard
console pads.

## The session object

`runRom` resolves once the window is up:

```js
const { stop, closed, host, frameCount, running } = session;
```

- `closed` resolves when the window closes (ESC, close button, or
  Select+Start on the pad). `stop()` closes it programmatically.
- `host` is the live
  [`romdev-core-host`](https://www.npmjs.com/package/romdev-core-host)
  `LibretroHost` instance, so while the human plays you can read/write
  memory, take screenshots, save states, or set cheats from the same
  process.

## Controls

Gamepads hot-plug (connect/disconnect any time). Face buttons follow
physical position: SDL bottom = RetroPad B (main action), right = A,
left = Y, top = X. Analog left stick doubles as the d-pad past a deadzone.

Keyboard fallback: arrows = d-pad, `Z`/`X`/`A`/`S` = the same four face
positions, Enter = Start, Right-Shift (or Backspace) = Select, `Q`/`W` =
L/R shoulders. ESC closes the window.

## SDL availability

`@kmamal/sdl` is an **optionalDependency**, declared once here so consuming
CLIs and SDKs never carry it themselves. When its native binary is missing,
`runRom` first re-runs SDL's own install script (self-repair), and only
then throws a structured error, never a hard module-load crash:

```js
try {
  await runRom("game.nes", { core });
} catch (e) {
  if (e.code === "SDL_UNAVAILABLE") console.error(e.fixCmd); // print, don't crash
}
```

so a headless environment (CI, a container) can import this package safely
and print its own "install SDL or use an external emulator" message.

## Building a custom frontend

The presentation layer is exported for frontends that want the maps and
math without the stock window: `SDL_BUTTON_TO_LIBRETRO_BIT`,
`KEY_TO_LIBRETRO_BIT`, `STICK_DEADZONE`, `bitToName(bit)`,
`tvAspectFor(platform, displayAspect)`, `letterbox(winW, winH, aspect)`,
`framebufferToRgba(fb)`, plus `initSdl()` (the hardened loader) and
`sdlPackageRoot()`.

## Requirements

Node >= 24, ESM only. Software-rendered cores work everywhere SDL does;
the 3D cores additionally want the `native-gles` optional dependency (see
the `romdev-core-host` README).

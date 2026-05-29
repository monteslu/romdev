# romdev

The entry point for **romdev** — a turnkey vibe-coding platform that lets a coding agent build, run, and inspect real retro homebrew ROMs (NES, SNES, Game Boy, Genesis, Atari, C64, GBA, and more) with one command.

```bash
npx romdev
```

This package is the [Model Context Protocol](https://modelcontextprotocol.io/) server and CLI. It contains all the JavaScript — the MCP tool surface, the WASM libretro host, the per-platform scaffolds, runtime/library source, and debug helpers — but **no emulator or compiler WASM itself.** Those ship in the `@romdev/*` binary packages this package depends on, and are loaded on demand the first time you build or run a given platform.

> For the full project — what romdev is, the supported-platform matrix, how the pieces fit together, and how to develop on it — see the [repository README](https://github.com/monteslu/romdev#readme).

## What's in this package

- **`bin`**
  - `romdev` → the MCP server (`src/mcp/server.js`). Streamable-HTTP transport on `http://127.0.0.1:7331/mcp` by default (`PORT` / `HOST` to override).
  - `romdev-cli` → a smoke/utility CLI, incl. `romdev-cli play <rom>` (SDL window, hot-plug controllers).
- **`src/`** — the server, MCP tools, WASM host, core/toolchain resolvers, per-platform memory interpretation, and bundled library/runtime source (cc65 libs, PVSnesLib, SGDK, libtonc/libgba, hUGEDriver, …) that scaffolded projects link against.
- **`examples/`** — per-platform starter projects and genre scaffolds.

## Dependencies

`romdev` hard-depends (exact-pinned) on the binary packages that carry the WebAssembly, so a single install gets a matched, tested set:

- Cores: `@romdev/core-{fceumm,gambatte,gpgx,vice,handy,prosystem}`
- Platforms: `@romdev/platform-{snes,gba,atari2600}`
- Toolchains: `@romdev/toolchain-{cc65,sdcc,m68k-gcc,vasm,rgbds}`

`@kmamal/sdl` is an optional dependency used only by `playtest()` / `romdev-cli play`. If it fails to install, the headless server still runs — only the live-window features degrade.

## Connect

```bash
npx romdev
# then, e.g. for Claude Code:
claude mcp add --transport http rom-dev http://127.0.0.1:7331/mcp
```

Agents: the server delivers [`AGENTS.md`](./AGENTS.md) as connection-time instructions — the workflow guide for the tool surface. Project roadmap and the full tool list live in [`PLAN.md`](./PLAN.md); the build/recipe matrix is in [`BUILDING.md`](./BUILDING.md).

## License

MIT.

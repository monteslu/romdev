# romdev

The entry point for **romdev** — vibe-code real retro games. Lets a coding agent build, run, and inspect actual homebrew ROMs (NES, SNES, Game Boy, Genesis, Atari, C64, GBA, and more) with one command.

```bash
npx romdev-mcp
```

This package is the [Model Context Protocol](https://modelcontextprotocol.io/) server and CLI. It contains all the JavaScript — the MCP tool surface, the WASM libretro host, the per-platform scaffolds, runtime/library source, and debug helpers — but **no emulator or compiler WASM itself.** Those ship in the `romdev-*` binary packages this package depends on, and are loaded on demand the first time you build or run a given platform.

> For the full project — what romdev is, the supported-platform matrix, how the pieces fit together, and how to develop on it — see the [repository README](https://github.com/monteslu/romdev#readme).

## What's in this package

- **`bin`**
  - `romdev-mcp` → the MCP server (`src/mcp/server.js`). Streamable-HTTP transport on `http://127.0.0.1:7331/mcp` by default (`PORT` / `HOST` to override).
  - `romdev-mcp-cli` → a smoke/utility CLI, incl. `romdev-mcp-cli play <rom>` (SDL window, hot-plug controllers).
- **`src/`** — the server, MCP tools, WASM host, core/toolchain resolvers, per-platform memory interpretation, and bundled library/runtime source (cc65 libs, PVSnesLib, SGDK, libtonc/libgba, hUGEDriver, …) that scaffolded projects link against.
- **`examples/`** — per-platform starter projects and genre scaffolds.

## Dependencies

`romdev-mcp` hard-depends (exact-pinned) on the binary/data packages it needs, so a single install gets a matched, tested set:

- Cores: `romdev-core-{fceumm,gambatte,gpgx,vice,handy,prosystem,geargrafx,bluemsx}`
- Platforms: `romdev-platform-{snes,gba,atari2600}`
- Toolchains: `romdev-toolchain-{cc65,sdcc,m68k-gcc,vasm,rgbds}`
- Data: `romdev_game_codes` — the bundled game-code / cheat database (a free labeled RAM/code map for thousands of known ROMs), split out so it can grow independently. Lazy-loaded one platform at a time.

`@kmamal/sdl` is used only by `playtest()` / `romdev-mcp-cli play` (the live window). It ships its native binary via its own install script, which npm skips when romdev is a transitive dep (e.g. under `npx`) — so romdev's `postinstall` fetches it, and `playtest()` also self-heals at runtime if the binary is still missing (downloading the prebuilt before the first window open). Either way, if the binary can't be fetched (offline/locked-down network), the headless server is unaffected — only the live window degrades, and the error tells you the one command to fix it.

## Connect

```bash
npx romdev-mcp
# then, e.g. for Claude Code:
claude mcp add --transport http romdev http://127.0.0.1:7331/mcp
```

It's a standard **streamable-HTTP** MCP server at `http://127.0.0.1:7331/mcp`. For opencode, Codex CLI, and other clients, see **[Connect](https://github.com/monteslu/romdev#connect)** in the repository README. An optional human observer (live tool-call view) is at `/livestream`.

Agents: the server delivers [`AGENTS.md`](./AGENTS.md) as connection-time instructions — the workflow guide for the full tool surface. Or just connect your agent and call `catalog({op:'categories'})` / `describeTool` to explore the tools live.

## License

romdev's code is **MIT**, and **the games you build are yours — including to
sell.** Full details + third-party component inventory:
[LICENSE](https://github.com/monteslu/romdev/blob/main/LICENSE) and
[NOTICE](https://github.com/monteslu/romdev/blob/main/NOTICE).

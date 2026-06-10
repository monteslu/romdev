# romdev

The entry point for **romdev** — vibe-code real retro games. Lets a coding agent build, run, and inspect actual homebrew ROMs (NES, SNES, Game Boy, Genesis, Atari, C64, GBA, and more) with one command.

```bash
npx romdevtools
```

That's it — one command starts the local romdev **tool server** (no global install, no host compiler/emulator). Point any coding agent at it three ways:

- **Plain HTTP** — `POST http://127.0.0.1:7331/tool/{name}`; browse/try every tool at `/documentation`.
- **Agent Skill** — `GET /skills/romdev/SKILL.md` (the [Agent Skills](https://agentskills.io) standard; save it to your skills dir as `skills/romdev/SKILL.md`; ~100 tokens until invoked).
- **MCP** — it's also a [Model Context Protocol](https://modelcontextprotocol.io/) server at `/mcp` for clients that want it.

This package contains all the JavaScript — the tool surface, the WASM emulator host, the per-platform example games, runtime/library source, and debug helpers — but **no emulator or compiler WASM itself.** Those ship in the `romdev-*` binary packages it depends on, loaded on demand the first time you build or run a given platform.

> For the full project — what romdev is, the supported-platform matrix, how the pieces fit together, and how to develop on it — see the [repository README](https://github.com/monteslu/romdev#readme).

## What's in this package

- **`bin`**
  - `romdevtools` → the tool server (`src/mcp/server.js`). Serves the HTTP tool routes, `/documentation`, `/skills/romdev/SKILL.md`, and an MCP endpoint on `http://127.0.0.1:7331` by default (`PORT` / `HOST` to override). `romdev-mcp` is kept as an alias of the same command.
  - `romdevtools-cli` → a smoke/utility CLI, incl. `romdevtools-cli play <rom>` (SDL window, hot-plug controllers).
- **`src/`** — the server, MCP tools, WASM host, core/toolchain resolvers, per-platform memory interpretation, and bundled library/runtime source (cc65 libs, PVSnesLib, SGDK, libtonc/libgba, hUGEDriver, …) that forked projects link against.
- **`examples/`** — per-platform example games (complete, working, forkable) and minimal references.

## Dependencies

`romdevtools` hard-depends (exact-pinned) on the binary/data packages it needs, so a single install gets a matched, tested set:

- Cores: `romdev-core-{fceumm,gambatte,gpgx,vice,handy,prosystem,geargrafx,bluemsx}`
- Platforms: `romdev-platform-{snes,gba,atari2600}`
- Toolchains: `romdev-toolchain-{cc65,sdcc,m68k-gcc,vasm,rgbds}`
- Data: `romdev_game_codes` — the bundled game-code / cheat database (a free labeled RAM/code map for thousands of known ROMs), split out so it can grow independently. Lazy-loaded one platform at a time.

`@kmamal/sdl` is used only by `playtest()` / `romdevtools-cli play` (the live window). It ships its native binary via its own install script, which npm skips when romdev is a transitive dep (e.g. under `npx`) — so romdev's `postinstall` fetches it, and `playtest()` also self-heals at runtime if the binary is still missing (downloading the prebuilt before the first window open). Either way, if the binary can't be fetched (offline/locked-down network), the headless server is unaffected — only the live window degrades, and the error tells you the one command to fix it.

## Connect

```bash
npx romdevtools
# then, e.g. for Claude Code (MCP):
claude mcp add --transport http romdev http://127.0.0.1:7331/mcp
```

It's a standard **streamable-HTTP** MCP server at `http://127.0.0.1:7331/mcp`. For opencode, Codex CLI, and other clients, see **[Connect](https://github.com/monteslu/romdev#connect)** in the repository README. An optional human observer (live tool-call view) is at `/livestream`.

Agents: the server delivers [`AGENTS.md`](./AGENTS.md) as connection-time instructions — the workflow guide for the full tool surface. Or just connect your agent and call `catalog({op:'categories'})` to explore the tools live, and `catalog({op:'status'})` for the running version + session snapshot.

## Prefer not to use MCP? Use HTTP or a Skill

Most agents support MCP, but you don't have to use it. Run the server
(`npx romdevtools`) and **skip wiring it into your agent's MCP
config** — no `claude mcp add`, no `mcp.json` entry, no MCP client at all. The
same 32 tools are reachable over plain HTTP / as an Agent Skill against the
running server:

- **Plain HTTP:** `POST http://127.0.0.1:7331/tool/{name}` with the args as a JSON
  body; the response is JSON. Browse/try every tool at **`/documentation`**
  (Swagger UI, served locally — no CDN), or get the machine spec at
  **`/openapi.json`**. **The agent picks its own session id** and sends it as the
  `x-romdev-session` header on every call — it's **required** (no header → `401`;
  the server won't silently run you in a throwaway session). Make it unique and
  task-descriptive (e.g. `nes-platformer-build`), since it's also the label shown
  in the `/livestream` observer. The emulator host is per-session, so the same id
  keeps your ROM across calls, and several agents can share one server by each
  using a different id. A call that fails returns a non-2xx (4xx) with the reason
  in the body — never a 200 that hides an error. romdev runs **locally** and tool
  path args (`path`, `outputPath`, …) are **local filesystem paths**, not uploads
  — pass absolute paths on the same machine.
- **Agent Skill:** **`GET /skills/romdev/SKILL.md`** is a portable [Agent
  Skills](https://agentskills.io) `SKILL.md` (works in Claude Code, opencode,
  OpenClaw, Hermes, …). Drop it in your agent's skills dir; it costs ~100 tokens
  until invoked (vs always-on MCP tool defs), then teaches the workflows + the
  `POST /tool/{name}` calls.

Both are generated from the same tool registry as the MCP surface, so they never
drift. **You still run the server** — `npx romdevtools` (it hosts the
emulators/toolchains in-process and serves these routes on :7331). What the
HTTP/skill path removes is the *MCP client/protocol and its always-on context
cost* — not the server. There's no separate install beyond romdev itself, and
never a host `gcc` or emulator.

## License

romdev's code is **MIT**, and **the games you build are yours — including to
sell.** Full details + third-party component inventory:
[LICENSE](https://github.com/monteslu/romdev/blob/main/LICENSE) and
[NOTICE](https://github.com/monteslu/romdev/blob/main/NOTICE).

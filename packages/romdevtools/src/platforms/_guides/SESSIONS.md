# Sessions, playtest and the livestream

How romdev keeps your emulator between calls, what happens on eviction and restarts, how several agents share one server, and how the human-facing window and livestream work. Read it with `platform({op:'doc', platform:'guide', name:'sessions'})`.

## Sessions

The emulator (loaded ROM, save-state slots, scroll position) lives per session, for the lifetime of the server process. Use one session for the whole job.

- MCP clients on the legacy protocol: call `initialize` once and reuse the `Mcp-Session-Id`.
- Do not re-initialize "to be safe" or after a few idle minutes; sessions do not time out. A new session starts with an empty emulator.
- Re-initialize only after a server restart (HTTP 404 "unknown session id"; a client that reconnects on 404 does this for you, and every tool is registered again) or if your client lost the session id header (you get an explicit error).
- Modern clients speaking the 2026-07-28 revision (no handshake, no session id, per-request `_meta`) are served statelessly on the same endpoint; `server/discover` advertises what is supported. Identity resolves in this order: a `_meta["dev.romdev/sessionHandle"]` handle; the optional `session` argument every tool accepts; otherwise your keep-alive connection, in which case every result ends with a `session: <id>` line. On a modern client, pass one stable descriptive slug (`session:"nes-platformer"`) on every call from the first `loadMedia` on. If a call says "No ROM loaded" after a connection was replaced, put that id into `session:` to get your emulator back.
- Over plain HTTP, send `x-romdev-session` on every call and reuse one `Mcp-Session-Id`; re-initializing per call mints a fresh session even with the header set.
- A different `session` value is a fully isolated second emulator (for example, deterministic stepping while a human plays in the first).

## Eviction

A loaded ROM is a live WASM core holding real memory, so the server bounds how many it keeps: a host unused for about 10 minutes is torn down, and when too many are live the largest holder's oldest idle one goes. Your session, tools and on-disk states are unaffected. You see a "No ROM loaded" error that names the exact `loadMedia({...})` call to re-run (and, if a playtest window was open, an auto-checkpoint with the last ~15 s of play). An open playtest window is never evicted. `catalog({op:'status'})` reports `serverHealth {rssMb, liveHosts, maxHosts, hostIdleMs}`; `liveHosts == maxHosts` under heavy load is normal.

## Running many sessions: say who you are

Send a stable `x-romdev-agent` header (HTTP) or `dev.romdev/agentHandle` in `_meta` (2026-07-28 clients) alongside your per-task session ids: one value for you across all your sessions. It is optional and cooperative:

- At the session and host caps, eviction targets the largest holder's oldest session, so your parallel burst evicts its own idle sessions, not another agent's. Undeclared sessions pool together as "(unattributed)".
- `catalog({op:'status'})` reports `sessionsByAgent`.
- The first response of every new session you open carries `agentSessionReminder` listing your other live sessions (key, what is loaded, idle time), which is what you need to shut them all down at the end.
- `host({op:'shutdown'})` releases a session (emulator, session record, livestream entry) immediately.

## Keeping state across restarts

- `state({op:'autoSnapshot', enabled:true, intervalSeconds:60})` arms an opt-in periodic save. Captures happen on calls that already touch the host (no timer, nothing while idle), land in a session-scoped temp directory that cannot clobber a named slot, and never fail the call. `state({op:'recoverSnapshot'})` restores the newest one after a restart.
- `catalog({op:'status'})` is the re-orientation call: what is loaded, server version, health, play state, bezel state.

## The playtest window

`playtest()` opens a native SDL window that runs the loaded ROM live for a human, with USB gamepads (hot-plugged pads are picked up). It returns immediately; every other tool keeps working against the same running host, and `build({output:'run'})` / `loadMedia` rebuilds update the window in place.

- Ops: `open` (default), `stop`, `status`, `framebuffer` (what the human sees, with `source`/`loadedMediaPath`/`frameCount`), `fps` (`show` toggles an on-screen counter), `bezel` (suspend or resume an Active Bezel). `scale`, `fpsOverlay:true` and `aspect` are open options; `aspect:"tv"` (default) is the 4:3 or native-LCD shape with nearest-neighbour scaling, `aspect:"fb"` is raw square-pixel geometry.
- Windows are per session. Opening one never disturbs another session's; `stop` closes only yours.
- No gamepad: the open response includes `keyboardControls` and a `tellUser` note (arrows = D-pad, Z = main action, Enter = Start, Esc closes); relay them to the human.
- Hotkeys: Esc or Select+Start close, F3 toggles the fps counter, B suspends or resumes a bezel, H soft-resets (same path as `host({op:'reset'})`). The gamepad works when the window is not focused; the keyboard needs focus.
- Pointer carts: on a wasmcart that declares `FLAG_POINTER`, mouse moves and clicks reach pointer slot 0 through the same letterbox as the frame, and the scroll wheel reaches the cart.
- Performance: the title bar shows live fps. `playtest({op:'status'})` returns `perf` with rolling `fps`, `tickHz` and per-stage costs (`stepMs`, `convertMs`, `presentMs`, `audioQueuedMs`).
- Co-driving: while the human presses (pad or keyboard), the window's input wins over yours and its real-time loop races your stepping. `frame`/`input` responses carry `humanCoDriveWarning` while they pressed within the last ~2 s, and `catalog({op:'status'})` / `playtest({op:'status'})` expose `humanInputActive`. For deterministic stepping while they play, use `host({op:'pause'})` (the window keeps rendering, frozen) or a second session.
- Failures are tool errors with a `reason`: `sdl-binary-missing` (the `@kmamal/sdl` prebuilt binary is missing; the server tries to self-heal, otherwise the message carries a one-line `fixCommand`; never compile it on the host), `no-display` (SDL came up on a dummy driver; run the server in a terminal inside the desktop session), `sdl-error` (read the quoted SDL error; it is the fault to report unless it names a display problem). Every other tool stays fully headless.
- For GL wasmcarts, load with `presentWindow:true` before opening the window (see the wasmcart guide).

## Showing a game on the livestream

`host({op:'play', seconds})` runs your session in real time on the server (the core's own frame rate, default 60 s, max 600) and returns at once; `/livestream` shows it moving. Set held input first with `input({op:'set'})`, or let a self-playing cart play. The run ends when its time elapses, on `host({op:'stop'})` (which reports `framesRun`), on any other tool call on that session (`catalog` status reads excepted), or when the media goes away. `catalog({op:'status'})` shows a running one as `play {framesRun, fps, secondsLeft}`. Never keep the stream alive with a scripted loop of `frame({op:'step'})` calls; an idle stream between real changes is fine.

A session averaging more than about 20 requests per second gets an extra advisory item in results (HTTP: `floodWarning`) naming the bulk form of what it is doing.

## Reporting defects

`feedback({op:'record', title, body, severity})` appends one stamped line (server version, pid, loaded platform and media, time) to a local, append-only log the human collects; nothing leaves the machine. `feedback({op:'list'})` reads it back. One report per distinct issue. A host compiler or emulator install prompt is a defect to report here.

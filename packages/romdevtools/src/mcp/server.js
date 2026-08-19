#!/usr/bin/env node
// Self-re-exec with --experimental-vm-modules if it's missing. The jsgame host kind
// (rungame) sandboxes games in a vm.SourceTextModule realm, which requires that flag.
// It's harmless for everything else, so we enable it once up front rather than making
// users remember it. Guard against a re-exec loop via a sentinel env var.
if (
  !process.execArgv.some((a) => a.includes("experimental-vm-modules")) &&
  !process.env.ROMDEV_REEXEChild
) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, ROMDEV_REEXEChild: "1" } },
  );
  // A child killed by a SIGNAL reports status === null, so `r.status ?? 0`
  // turned every native crash (a segfault inside a GL driver, an OOM kill)
  // into a clean exit 0. That cost a bezel agent hours: the server vanished
  // and the logs said it had shut down normally. The parent here is a bare
  // re-exec wrapper, so it is the only place that knows how the child died.
  //
  // Cross-platform: `r.signal` and `r.error` are plain Node fields on every
  // platform. Windows has no POSIX signals — spawnSync reports a signal there
  // only for simulated kills — so the 128+signum convention is applied only
  // where it means something and the name is reported either way.
  if (r.error) {
    console.error(`romdev: could not start the server process: ${r.error.message}`);
    process.exit(1);
  }
  if (r.signal) {
    console.error(`romdev: server process died from ${r.signal} (not a clean shutdown).`);
    const signum = { SIGSEGV: 11, SIGABRT: 6, SIGBUS: 7, SIGILL: 4, SIGFPE: 8, SIGKILL: 9, SIGTERM: 15 }[r.signal];
    process.exit(process.platform === "win32" || !signum ? 1 : 128 + signum);
  }
  process.exit(r.status ?? 0);
}

// romdev — MCP server (Streamable HTTP).
//
// Exposes the libretro harness, save state, memory inspection, screenshot,
// and platform/toolchain introspection as MCP tools over the modern
// Streamable HTTP transport. stdout is freely available for debug logs.
//
// Default endpoint: http://127.0.0.1:7331/mcp
//
// Register with Claude Code:
//   claude mcp add --transport http romdev http://127.0.0.1:7331/mcp
//
// Run:
//   node src/mcp/server.js              # blocks on the HTTP listener
//   node src/mcp/server.js --port 7332  # override port (flag)
//   node src/mcp/server.js --port=7332  # same, = form
//   PORT=7332 node src/mcp/server.js    # override port (env; flag wins)
//   node src/mcp/server.js --host 0.0.0.0
//   HOST=0.0.0.0 node src/mcp/server.js
//     (binds to all interfaces; DNS rebinding protection disabled — only
//      use this when you're explicitly fronting the server.)

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTools } from "./tools/index.js";
import { stopAllPlaytest, stopPlaytestForSession, isPlaytestRunning } from "./tools/playtest.js";
import { clearHost, reapIdleHosts, setHostProtectedPredicate } from "./state.js";
import { resolveSessionKey, SESSION_META_KEY } from "./session-key.js";
import { log } from "./log.js";
import { attachObserver } from "../observer/server.js";
import { installObserverMiddleware } from "../observer/tool-wrap.js";
import { observer } from "../observer/bus.js";
import { mountHttpToolRoutes } from "../http/routes.js";
import { mcpPreamble } from "../http/skill-doc.js";
import { resolveXauthority } from "../host/xauth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Single source of truth for the version reported to MCP clients: read it from
// package.json so serverInfo can never drift from the published package again.
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

// AGENTS.md is the CHANNEL-NEUTRAL body (workflow knowledge, footguns, per-platform
// docs) — it must not contain "how to connect / how to call" prose, because that
// differs per delivery channel. The MCP channel prepends mcpPreamble ("call the
// MCP tools…", never mentions HTTP routes); the skill channel (GET /skills/romdev/SKILL.md)
// prepends skillPreamble ("POST /tool/{name}…", never mentions MCP). Both live in
// src/http/skill-doc.js so neither leaks into the other surface.
async function loadAgentsBody() {
  try {
    const agentsPath = path.resolve(__dirname, "..", "..", "AGENTS.md");
    return await readFile(agentsPath, "utf-8");
  } catch {
    return "";
  }
}

/** MCP connection instructions = mcpPreamble + the shared AGENTS body. */
async function loadInstructions() {
  const body = await loadAgentsBody();
  return body ? `${mcpPreamble}\n\n${body}` : mcpPreamble;
}

function buildMcpServer(instructions, sessionKey) {
  const server = new McpServer(
    {
      name: "romdev",
      version: PKG_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );
  // Observer instrumentation: every server.tool() call gets its handler
  // wrapped to emit a `call` event to the /livestream bus after each
  // invocation. Must install BEFORE registerTools() so the wrapping
  // catches every registration.
  installObserverMiddleware(server, sessionKey);
  registerTools(server, z, sessionKey);
  return server;
}

// Parse `--flag value` / `--flag=value` from argv. CLI flags take precedence
// over env vars, which take precedence over the built-in defaults.
function cliArg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];        // --port 7332
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3); // --port=7332
  }
  return undefined;
}

/**
 * Cart stdout/stderr is DEBUG output, not server output. wasmcart's CartHost
 * writes every wc_log line and every cart printf straight to process.stderr
 * prefixed `[cart] `, so a driven cart emits a line or two PER FRAME. One day
 * of gate runs put 58 MB of per-frame telemetry into the server log, which
 * buried the actual server events -- including, on 2026-08-19, the fact that
 * the process had been OOM-killed: the log simply stopped mid-boot with no
 * marker, because nothing server-level had been written for hours.
 *
 * The cart lines still matter WHILE DEBUGGING a cart, so they are kept in a
 * per-process ring buffer (readable via catalog({op:'status'})) and can be
 * restored to the log wholesale with ROMDEV_LOG_CART=1. What they must not do
 * is drown the log by default.
 */
const CART_LOG_RING_MAX = 200;
/** @type {string[]} */
const cartLogRing = [];
export function recentCartLog() { return cartLogRing.slice(); }

function installCartLogFilter() {
  if (process.env.ROMDEV_LOG_CART === "1") return; // opt back in, unfiltered
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    try {
      const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8") ?? "";
      if (text.startsWith("[cart] ")) {
        for (const line of text.split("\n")) {
          if (!line) continue;
          cartLogRing.push(line);
          if (cartLogRing.length > CART_LOG_RING_MAX) cartLogRing.shift();
        }
        // Swallow: tell the caller we wrote it. A callback-style write still
        // needs its callback, or a writer awaiting drain would hang.
        const cb = rest.find((a) => typeof a === "function");
        if (cb) cb();
        return true;
      }
    } catch { /* fall through to a real write */ }
    return realWrite(chunk, ...rest);
  };
}

async function main() {
  installCartLogFilter();

  // BEFORE anything can open a GL context: a compositor restart leaves the
  // session exporting a stale XAUTHORITY, and the only symptom is EGL failing
  // with "Invalid MIT-MAGIC-COOKIE-1 key" -- which reads as a GPU problem and
  // silently costs every GL cart its GPU. Only replaces a cookie that is
  // demonstrably broken (see host/xauth.js).
  resolveXauthority({ log });

  const instructions = await loadInstructions();
  const host = cliArg("host") ?? process.env.HOST ?? "127.0.0.1";
  // Precedence: --port flag > PORT env > default 7331.
  const portRaw = cliArg("port") ?? process.env.PORT ?? 7331;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log.error(`romdev: invalid port "${portRaw}" — pass --port <1-65535> or set PORT.`);
    process.exit(1);
  }

  // Build the Express app manually so we can set a large JSON body limit.
  // (The SDK's createMcpExpressApp uses body-parser's default ~100KB,
  // which is too small for our payloads — ROMs encoded as base64 can be
  // hundreds of KB to several MB.)
  const app = express();
  // 64 MB covers any ROM up to a 48MB GBA cartridge with base64 overhead.
  app.use(express.json({ limit: "64mb" }));
  const localhostHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (localhostHosts.has(host)) {
    app.use(localhostHostValidation());
  }

  // Trace every incoming JSON-RPC call so we can watch what clients are
  // doing without having to instrument each tool handler. We log method
  // names and a tiny summary of arguments (size, not contents) so big
  // payloads don't bloat the log file.
  app.use("/mcp", (req, res, next) => {
    // Per-call trace. ALWAYS recorded into the /log ring buffer (the summary is
    // a cheap, bounded string — sizes, not payloads), and PRINTED to stdout only
    // in verbose mode (log.debug handles that split). This keeps the console
    // quiet in prod while /log stays rich enough to diagnose what an agent did.
    if (req.method === "POST" && req.body) {
      const { method, params } = req.body;
      if (method === "tools/call") {
        const argKeys = params?.arguments ? Object.keys(params.arguments) : [];
        const summary = argKeys.map((k) => {
          const v = params.arguments[k];
          if (typeof v === "string" && v.length > 80) return `${k}=<${v.length}B str>`;
          if (Buffer.isBuffer(v)) return `${k}=<${v.length}B buf>`;
          if (Array.isArray(v)) return `${k}=[${v.length}]`;
          if (v && typeof v === "object") return `${k}={${Object.keys(v).join(",")}}`;
          if (typeof v === "string") return `${k}="${v}"`;
          return `${k}=${v}`;
        }).join(" ");
        const sid = req.headers["mcp-session-id"] ?? "?";
        log.debug(`[mcp] ${String(sid).slice(0,8)} call ${params?.name}(${summary})`);
      } else if (method && method !== "notifications/initialized") {
        log.debug(`[mcp] ${String(req.headers["mcp-session-id"] ?? "?").slice(0,8)} ${method}`);
      }
    }
    next();
  });

  // Dev-only diagnostic endpoint: the last N log records as JSON, so someone
  // working ON the MCP server can see recent activity without scraping stdout
  // or having had --verbose on (the ring buffer captures debug lines either
  // way). NOT an end-user feature — undocumented, loopback-only, no stability
  // guarantee. `?limit=N` caps the count (default 100).
  app.get("/log", (req, res) => {
    const n = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(n) && n > 0 ? n : 100;
    res.json({ count: log.recent(limit).length, verbose: log.verbose, records: log.recent(limit) });
  });

  // Session → transport map. One McpServer per session.
  /** @type {Map<string, StreamableHTTPServerTransport>} */
  const transports = new Map();
  // Session id → last-activity timestamp (ms). Bumped on every request so
  // the idle reaper below can evict sessions whose client vanished without
  // a clean MCP close (restarted Codex/Claude, crashed client, abandoned
  // tab). Without this the transports map — and the /livestream session
  // list — grows forever: each reconnect mints a new session and the dead
  // one is never closed.
  /** @type {Map<string, number>} */
  const lastSeen = new Map();
  // How long a session can be idle before we close it. 30 min is generous
  // for an interactive agent between turns but reaps abandoned ones.
  const SESSION_IDLE_MS = Number(process.env.ROMDEV_SESSION_IDLE_MS ?? 30 * 60 * 1000);

  // Spin up a fresh transport + McpServer for a NEW session (only ever
  // created in response to an `initialize` request — the server mints the
  // session id).
  // `fixedId`: when set (the LAZY-INIT / reconnect path), the transport
  // adopts the client's existing session id instead of minting a new one —
  // the SDK binds whatever sessionIdGenerator returns on initialize, so we
  // just return the client's id. This is how a client survives a server
  // restart: it shows up with an id we've never seen (because WE restarted),
  // and we transparently re-create that exact session under the hood.
  async function createTransport(fixedId, requestedHandle) {
    // Identity is resolved through session-key.js, not taken from the
    // transport. It already was independent here (this randomUUID is not the
    // Mcp-Session-Id), but an explicit client handle must WIN so a caller can
    // pin its own session -- which is the only mechanism that still exists
    // under MCP 2026-07-28, where there is no protocol session at all.
    // Workstream B of
    // internal-romdev/PLAN_mcp_v2_stateless_and_host_lifetime.md.
    const { sessionKey } = resolveSessionKey({
      meta: requestedHandle ? { [SESSION_META_KEY]: requestedHandle } : undefined,
    });
    // Compute the session id ONCE. The SDK may call sessionIdGenerator more
    // than once; if it returned a fresh randomUUID() each time, the id placed
    // in the response header and the id we register under in `transports`
    // would diverge — so every subsequent call would miss the map, look
    // "unknown", get re-adopted into a brand-new host, and lose all state.
    // A stable closure over a single value keeps the header id == the map key.
    const publicId = fixedId ?? randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => publicId,
      // Respond to each POST with a single JSON body instead of opening a
      // persistent SSE stream. Without this the transport treats every request
      // as a stream; non-streaming clients let that stream end immediately,
      // the SDK fires `onclose`, and our onclose handler deletes the session
      // from `transports` — so the NEXT call arrives as an "unknown session",
      // gets lazily re-adopted (a brand-new host), and the cycle repeats. That
      // is the "every call makes a new session / state never persists" bug.
      // We don't stream server-initiated messages, so JSON responses are
      // correct here and keep the session alive across calls.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        lastSeen.set(id, Date.now());
        log.debug(`[mcp] session ${id} ${fixedId ? "re-adopted (lazy-init after restart)" : "initialized"} (${transports.size} active)`);
        try { observer.sessionConnected(sessionKey); } catch {}
      },
    });
    transport.onclose = () => {
      // Close THIS session's playtest window (if any) — one agent disconnecting
      // tears down only its own window/host; other agents' games keep running.
      try { stopPlaytestForSession(sessionKey); } catch {}
      try { clearHost(sessionKey); } catch {}
      try { observer.sessionDisconnected(sessionKey); } catch {}
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        lastSeen.delete(transport.sessionId);
        log.debug(`[mcp] session ${transport.sessionId} closed (${transports.size} active)`);
      }
    };
    const server = buildMcpServer(instructions, sessionKey);
    await server.connect(transport);
    return transport;
  }

  // Lazy-initialize a session the client THINKS exists but we don't (because
  // we restarted). Create a transport bound to the client's id and mark it
  // initialized so the SDK's per-request validation (sessionId match +
  // _initialized) passes — i.e. we adopt the client's session instead of
  // forcing a reinitialize.
  //
  // ⚠ SDK-COUPLING: the streamable-HTTP transport only binds its sessionId by
  // running a real `initialize` HTTP request through Hono — which needs
  // genuine Node req/res stream objects, not fabricable here. So we set the
  // two state fields on the inner web-standard transport directly. These are
  // plain instance fields (sessionId, _initialized) on _webStandardTransport.
  // This is the one spot that reaches into SDK internals; it's pinned by
  // package-lock and covered by a reconnect test (session-isolation.test.js).
  // If an SDK upgrade renames these, the test fails loudly and we adjust.
  async function lazyInitTransport(clientId) {
    try {
      const transport = await createTransport(clientId);
      const inner = transport._webStandardTransport;
      if (!inner || typeof inner !== "object") return null;
      inner.sessionId = clientId;
      inner._initialized = true;
      // Register in our maps (createTransport's onsessioninitialized only
      // fires on a real init, which we bypassed).
      transports.set(clientId, transport);
      return transport;
    } catch (e) {
      log.debug(`[mcp] lazy-init failed for ${clientId}: ${e?.message}`);
      return null;
    }
  }

  app.all("/mcp", async (req, res) => {
    try {
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? transports.get(sid) : undefined;
      if (transport && typeof sid === "string") lastSeen.set(sid, Date.now());

      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        // Normal first-contact OR a reconnect: client sent an initialize.
        // Mint a new session with a server-generated id.
        //
        // RECONNECT ROBUSTNESS: a reconnecting client may re-send initialize
        // while STILL carrying its dead Mcp-Session-Id header. The MCP spec
        // says initialize must not carry a session id, and the SDK transport
        // can reject (400) an initialize that does — which would block the
        // very reconnect we want to allow. So strip the stale id header
        // before handing the request to the fresh transport: an initialize
        // is always "start clean," never "resume id X". This guarantees a
        // client can always get back in, no matter what id it's clinging to.
        if (typeof sid === "string" && sid.length > 0) {
          delete req.headers["mcp-session-id"];
          log.debug(`[mcp] initialize carried stale session id ${sid} — stripped, minting fresh`);
        }
        // A client may pin its own session by sending a handle in the
        // initialize request's `_meta`. Legacy clients send none and get the
        // minted key exactly as before.
        const requestedHandle = req.body?.params?._meta?.[SESSION_META_KEY];
        transport = await createTransport(undefined, requestedHandle);
      } else if (!transport && typeof sid === "string" && sid.length > 0) {
        // The client presented a session id we don't have — almost always
        // because WE restarted (the client's session is fine from its side).
        // LAZY-INIT: transparently re-create that exact session and serve the
        // request, so the client never sees a failure and keeps its id. The
        // emulator/host state was in our RAM and is gone, so the session comes
        // back EMPTY — the first host-needing call returns the clear "reload
        // your ROM" guidance (state.js). This is safe now that the full tool
        // surface registers at init by default (no per-session loadCategory
        // state to lose — the old reason we used to reject + force reinit).
        log.debug(`[mcp] lazy-init: re-adopting unknown session ${sid} (likely post-restart)`);
        transport = await lazyInitTransport(sid);
        if (!transport) {
          // Lazy-init failed — fall back to the spec 404 so the client
          // reinitializes cleanly rather than hanging.
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found; please re-initialize." },
            id: req.body?.id ?? null,
          });
          return;
        }
        lastSeen.set(sid, Date.now());
      } else if (!transport) {
        // No session id at all on a non-initialize request — there's nothing
        // to adopt. Tell the client to start a session.
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No Mcp-Session-Id and not an initialize request. Send POST initialize to start a session." },
          id: req.body?.id ?? null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("[mcp] handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: err?.message ?? "internal error" },
          id: null,
        });
      }
    }
  });

  // Healthcheck endpoint — handy for verifying the server is up without
  // doing a full MCP handshake.
  app.get("/healthz", (req, res) => {
    // `version` lets a saved skill / HTTP client detect staleness against the
    // running server (the skill doc tells agents to compare it to its metadata).
    res.json({ ok: true, version: PKG_VERSION, sessions: transports.size });
  });

  // ── HTTP tool surface (the non-MCP way to drive romdev) ───────────────────
  // POST /tool/:name + /openapi.json + /documentation + /skills/romdev/SKILL.md, all
  // generated from the same tool registry the MCP path uses. Same Express app,
  // same localhost trust, per-agent dynamic sessions. Lets MCP-wary users (or
  // agents that prefer the Agent Skills standard) use romdev with near-zero
  // always-on context — the skill metadata is ~100 tokens until invoked.
  const agentsBody = await loadAgentsBody();
  mountHttpToolRoutes(app, { agentsBody, version: PKG_VERSION, idleMs: SESSION_IDLE_MS });

  // JSON-RPC-shaped error handler. Without this, body-parser failures
  // (e.g. PayloadTooLargeError) return HTML, which MCP clients can't parse.
  app.use((err, req, res, next) => {
    log.error("[mcp] express error:", err);
    if (res.headersSent) return next(err);
    const status = err?.status ?? err?.statusCode ?? 500;
    res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: status === 413 ? -32600 : -32603,
        message: err?.message ?? "internal error",
      },
      id: null,
    });
  });

  // Loopback resolves to BOTH 127.0.0.1 (IPv4) and ::1 (IPv6) depending on the
  // box — a client that connects to `localhost` may pick either. Binding only
  // one stack means clients hitting the other get connection-refused (e.g. a
  // Rust HTTP client that resolves localhost→::1 while we listen on 127.0.0.1).
  // So when HOST is the default loopback, listen on BOTH; otherwise honor the
  // explicit HOST as-is. `host` stays the canonical address for the banner.
  const isDefaultLoopback = !process.env.HOST || host === "127.0.0.1";
  const bindHosts = isDefaultLoopback ? ["127.0.0.1", "::1"] : [host];

  // Primary listener (carries socket.io / observer). Extra loopback listeners
  // share the same Express app so either stack reaches the same routes.
  // Banner host: when we're on the default loopback we listen on BOTH stacks
  // and `localhost` is what users actually type, so advertise that. For an
  // explicit non-loopback HOST, show exactly what was bound.
  const bannerHost = isDefaultLoopback ? "localhost" : host;
  const httpServer = app.listen(port, bindHosts[0]);
  // FAIL LOUDLY on a bad bind (commonly: port already in use). The primary
  // listener's 'error' event would otherwise be unhandled — and because
  // app.listen()'s success callback fires before the async EADDRINUSE arrives,
  // the process could print a "listening…" banner and exit 0 while NOT actually
  // bound (silent failure). So we print the banner ONLY from the 'listening'
  // event (fires after a real bind) and exit non-zero on 'error' — `npx
  // romdevtools` runs in the foreground, so the user sees exactly what happened.
  httpServer.on("error", (e) => {
    if (e && e.code === "EADDRINUSE") {
      log.error(`romdev: port ${port} is already in use — another romdev server (or some other process) is on it.`);
      log.error(`Fix: stop the other process, or run on a different port: PORT=7332 npx romdevtools  (or --port 7332).`);
    } else if (e && e.code === "EACCES") {
      log.error(`romdev: not allowed to bind port ${port} (privileged port?). Use a port >= 1024.`);
    } else {
      log.error(`romdev: failed to start HTTP server on ${bannerHost}:${port}: ${e?.message ?? e}`);
    }
    process.exit(1);
  });
  httpServer.on("listening", () => {
    // pid + version on one greppable line. A log that ends without the
    // matching "shutting down" line was KILLED (OOM, SIGKILL), not stopped --
    // which is otherwise indistinguishable from a truncated log.
    log.info(`romdev: server up pid=${process.pid} v${PKG_VERSION}`);
    log.info("");
    log.info(`romdev (v${PKG_VERSION}) listening on http://${bannerHost}:${port}/mcp`);
    log.info("");
    log.info(`prefer a skill?  save:  http://${bannerHost}:${port}/skills/romdev/SKILL.md`);
    log.info("");
    log.info(`optional observer:      http://${bannerHost}:${port}/livestream`);
    log.info("");
    log.info("connect your coding agent: https://github.com/monteslu/romdev#connect");
    // One conditional line so an agent knows the constraint BEFORE promising a
    // playtest window to a human (the op itself still errors with the full fix).
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      log.info("");
      log.info("note: no display detected (headless) — playtest({op:'open'}) is unavailable; all other tools work.");
    }
  });
  const extraServers = [];
  for (const h of bindHosts.slice(1)) {
    const s = app.listen(port, h);
    // A missing IPv6 stack shouldn't take the server down — log and move on.
    s.on("error", (e) => log.debug(`[mcp] secondary bind ${h}:${port} skipped: ${e.code || e.message}`));
    extraServers.push(s);
  }

  // Mount /livestream + socket.io on the same port. Attach socket.io to EVERY
  // loopback listener (IPv4 + IPv6), not just the primary — otherwise a browser
  // whose `localhost` resolves to the other stack 404s on /socket.io. The
  // observer module attaches itself; tool calls emit through the observer bus
  // via the middleware installed in buildMcpServer().
  attachObserver(app, httpServer, ...extraServers);

  // Graceful shutdown.
  const shutdown = async (sig) => {
    clearInterval(reaper);
    clearInterval(hostReaper);
    log.info(`\n[mcp] ${sig} received, draining ${transports.size} session(s)...`);
    // Close ALL open playtest windows (every session) FIRST — the server must
    // not leave emulator windows running that it opened. They're in-process so a
    // clean exit tears them down anyway, but closing them explicitly here avoids
    // a flash of dead windows and frees SDL before we drop the event loop.
    try { stopAllPlaytest(); } catch {}
    for (const t of transports.values()) {
      try { await t.close(); } catch {}
    }
    for (const s of extraServers) { try { s.close(); } catch {} }
    httpServer.close(() => process.exit(0));
    // Backstop: force exit after 5s if something hangs.
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Last-resort: on ANY exit path (including ones that bypass `shutdown`),
  // make sure the in-process window is torn down. exit handlers must be sync.
  process.on("exit", () => { try { stopAllPlaytest(); } catch {} });

  // Idle-session reaper. MCP transports don't time themselves out, and a
  // client that restarts/crashes/abandons its tab never sends a clean
  // close — so without this the transports map (and the /livestream
  // session list) grows unbounded, one entry per reconnect. Sweep every
  // few minutes and close anything idle past SESSION_IDLE_MS. Closing the
  // transport fires its onclose, which removes it from the map + observer
  // and frees the per-session emulator host.
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, transport] of transports) {
      const seen = lastSeen.get(id);
      if (seen === undefined) { lastSeen.set(id, now); continue; } // give it one window
      if (now - seen > SESSION_IDLE_MS) {
        log.debug(`[mcp] reaping idle session ${id} (idle ${Math.round((now - seen) / 1000)}s)`);
        try { transport.close(); } catch (e) {
          // close() failed — still evict from our tables so it can't leak.
          transports.delete(id); lastSeen.delete(id);
        }
      }
    }
  }, 60 * 1000);
  reaper.unref(); // don't keep the process alive just for the reaper

  // Host reaper — SEPARATE from the session reaper above, and the one that
  // actually bounds memory. A host is emulator state (a WASM core plus its
  // whole linear memory, tens to hundreds of MB); a transport is a socket.
  // They are evicted on different clocks because they have different costs
  // and different idleness: a gate script exits without closing its
  // transport, so its session lingers the full 30 minutes while its host
  // sits unused from the first second. Sweeping hosts on their own activity
  // is what stops a suite run from stacking 20+ live cores. (Two OOM kills,
  // 2026-08-19.) Playtest sessions are exempt: a human may be mid-game.
  setHostProtectedPredicate((key) => {
    try { return isPlaytestRunning(key); } catch { return false; }
  });
  const hostReaper = setInterval(() => {
    try {
      const evicted = reapIdleHosts();
      if (evicted.length) {
        log.debug(`[mcp] reaped ${evicted.length} idle host(s): ${evicted.join(", ")}`);
      }
    } catch (e) {
      log.debug(`[mcp] host reaper failed: ${e?.message}`);
    }
  }, 60 * 1000);
  hostReaper.unref();

  // Never let one bad tool call take down the long-running server.
  // safeTool wraps every handler, but defense in depth: log + survive
  // any uncaught throw / unhandled rejection that escaped (e.g. from
  // a setImmediate inside a WASM callback). Without this Node's
  // default is to crash the process.
  process.on("uncaughtException", (err) => {
    log.error("[mcp] uncaughtException — keeping process alive:", err);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("[mcp] unhandledRejection — keeping process alive:", reason);
  });
}

main().catch((err) => {
  log.error("romdev fatal:", err);
  process.exit(1);
});

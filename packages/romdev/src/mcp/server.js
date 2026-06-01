#!/usr/bin/env node
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
import { clearHost } from "./state.js";
import { log } from "./log.js";
import { attachObserver } from "../observer/server.js";
import { installObserverMiddleware } from "../observer/tool-wrap.js";
import { observer } from "../observer/bus.js";

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

async function loadInstructions() {
  try {
    const agentsPath = path.resolve(__dirname, "..", "..", "AGENTS.md");
    return await readFile(agentsPath, "utf-8");
  } catch {
    return [
      "romdev: homebrew retro game development for coding agents.",
      "Progressive disclosure: you see ~5 entry-tier tools by default. Call listCategories() to discover the other ~60 tools (debug, memory, assets, etc.).",
      "loadCategory({category:'<name>'}) registers a tier; loadCategory({category:'all'}) registers everything in one call.",
      "Non-game tasks (disassemble a ROM, convert assets, drive an existing emulator session) all live in deferred categories — call listCategories first.",
    ].join("\n");
  }
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

async function main() {
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
      const { method, id, params } = req.body;
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
  async function createTransport(fixedId) {
    const sessionKey = randomUUID();
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
        transport = await createTransport();
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
    res.json({ ok: true, sessions: transports.size });
  });

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
  const httpServer = app.listen(port, bindHosts[0], () => {
    log.info(`romdev listening on http://${bannerHost}:${port}/mcp`);
    log.info("");
    log.info(`optional observer:      http://${bannerHost}:${port}/livestream`);
    log.info("");
    log.info("connect your coding agent: https://github.com/monteslu/romdev#connect");
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
    log.info(`\n[mcp] ${sig} received, draining ${transports.size} session(s)...`);
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

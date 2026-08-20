// HTTP tool surface — the non-MCP way to drive romdev. Mounts four routes on the
// SAME Express app as /mcp, all generated from the one tool registry:
//
//   POST /tool/:name          run a tool over plain HTTP (body = args) → JSON
//   GET  /tool/:name/schema   that tool's JSON Schema (a validator on demand)
//   GET  /openapi.json        OpenAPI 3.1 spec for every /tool/:name route
//   GET  /documentation       Swagger UI over /openapi.json (live "try it" console)
//   GET  /skills/romdev/SKILL.md  the SKILL.md (Agent Skills open standard) — the
//                             channel doc that drives the routes, never mentions
//                             MCP. Also at /romdev/SKILL.md and /romdev-skill.md.
//
// Sessions: each agent picks its own stable id and sends it as x-romdev-session
// on EVERY call (same per-agent host isolation as MCP). The header is REQUIRED —
// no header → 401 (we don't auto-mint a throwaway session; that silently dropped
// the loaded ROM and surfaced as "No ROM loaded" later). First use of an id
// creates the session, reuse keeps the host across load→step→read, different ids
// isolate different agents. No auth beyond that — localhost trust, same as /mcp
// (the app already mounts localhostHostValidation()).

import { buildToolRegistry, runTool, toolJsonSchema } from "./tool-registry.js";
import { buildSkillDoc } from "./skill-doc.js";
import { swaggerHtml, swaggerAsset } from "./swagger.js";
import { observer } from "../observer/bus.js";
import { log } from "../mcp/log.js";
import { clearHost } from "../mcp/state.js";
import { SESSION_HEADER } from "../mcp/session-key.js";
import { onSessionEnd } from "../mcp/session-events.js";
import { AGENT_HEADER, setSessionAgent, clearSessionAgent, pickEvictionVictim, groupByAgent } from "../mcp/agent-identity.js";

// Live HTTP session count + per-agent grouping, for serverHealth. Reassigned
// by mountHttpToolRoutes so readers need no handle on the closure-owned map.
export let _liveHttpSessions = () => 0;
export let _httpSessionsByAgent = () => ({});

// Re-exported from the session-key module so there is ONE definition of how a
// session is named. That module is the seam the stateless migration moves;
// this route already works the way it prescribes (a caller-supplied handle,
// not a transport id), which is why it needs no behaviour change here.
// NOTE: this route deliberately 401s instead of minting -- see the handler.

/**
 * Mount the HTTP tool surface on an Express app.
 * @param {import('express').Express} app
 * @param {object} [opts]
 * @param {string} [opts.agentsBody]  the channel-neutral AGENTS.md body (for the skill doc)
 * @param {string} [opts.version]     package version (for OpenAPI info)
 * @param {number} [opts.idleMs]      session idle timeout (default 30m)
 */
export function mountHttpToolRoutes(app, opts = {}) {
  const version = opts.version ?? "0.0.0";
  const idleMs = opts.idleMs ?? 30 * 60 * 1000;

  // Per-session registries (handlers close over sessionKey → host isolation).
  // Mirrors the MCP transports map + idle reaper.
  /** @type {Map<string, {registry: Map<string,any>, lastSeen: number}>} */
  const sessions = new Map();
  _liveHttpSessions = () => sessions.size;
  _httpSessionsByAgent = () => {
    const out = {};
    for (const [agent, keys] of groupByAgent(sessions.keys())) out[agent] = keys.length;
    return out;
  };

  /** Forget one session: registry, livestream entry, emulator. */
  function dropSession(key, why) {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    try { clearHost(key); } catch {}
    clearSessionAgent(key);
    if (s.sticky) { try { observer.sessionDisconnected(key); } catch {} }
    log.debug(`[http] session ${key.slice(0, 8)} ended (${why}, ${sessions.size} active)`);
  }

  // host({op:'shutdown'}) now announces "this session is done" -- honor it
  // here. Before this, a suite that opened ~53 sessions and shut every one
  // down still left ~20 MB of tool registry EACH (measured: 50 registries =
  // 1 GB) plus a livestream entry, all waiting out the 30-minute idle reaper.
  // The cleanup API existed at the emulator layer and not at the session
  // layer, so well-behaved agents could not actually clean up.
  onSessionEnd((key) => dropSession(key, "shutdown"));

  // Hard ceiling for agents that never clean up at all: at the cap, the
  // oldest-idle session is evicted to make room. Same policy as the host cap
  // in state.js and for the same reason -- an eviction self-heals (the next
  // call on that key re-creates the session, and lastMedia survives in
  // state.js), while unbounded growth took the machine down. 20 MB per
  // registry makes the default a ~640 MB worst case instead of "however many
  // sessions the busiest agent ever minted".
  const MAX_HTTP_SESSIONS = Number(process.env.ROMDEV_MAX_HTTP_SESSIONS ?? 32);

  function getSession(sessionKey, { sticky = false } = {}) {
    let s = sessions.get(sessionKey);
    if (!s) {
      while (sessions.size >= MAX_HTTP_SESSIONS) {
        // Fair eviction: the oldest-idle session OF THE LARGEST HOLDER, so a
        // parallel agent at the cap evicts its own sessions rather than a
        // bystander's. Undeclared sessions pool as one anonymous holder,
        // which is exactly the pre-attribution behaviour.
        const victim = pickEvictionVictim(sessions.keys(), (k) => sessions.get(k)?.lastSeen);
        if (!victim) break;
        dropSession(victim, "evicted at session cap");
      }
      s = { registry: buildToolRegistry(sessionKey), lastSeen: Date.now(), sticky };
      sessions.set(sessionKey, s);
      log.debug(`[http] session ${sessionKey.slice(0, 8)} created (${sessions.size} active)`);
      // Surface sticky sessions in /livestream (like the MCP path does on init).
      // Ephemeral one-shot sessions are NOT registered (they'd spam connect/
      // disconnect); their individual `call` events still show in the stream.
      if (sticky) { try { observer.sessionConnected(sessionKey); } catch {} }
    } else {
      s.lastSeen = Date.now();
    }
    return s;
  }

  // Reap idle HTTP sessions (same policy as MCP).
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (now - s.lastSeen > idleMs) {
        // dropSession frees the EMULATOR too, not just the registry entry --
        // dropping the record alone orphaned its host (a live leak path in
        // the 2026-08-19 OOM, since gate suites drive this route).
        dropSession(key, "idle");
      }
    }
  }, 5 * 60 * 1000);
  reaper.unref?.();

  // A registry built once for METADATA routes (schemas/openapi/skill doc) — these
  // don't run handlers, so the session key is irrelevant; use a stable throwaway.
  const metaRegistry = buildToolRegistry("__meta__");

  // ── POST /tool/:name ──────────────────────────────────────────────────────
  app.post("/tool/:name", async (req, res) => {
    const name = req.params.name;
    // Session model: the AGENT picks its own stable, task-descriptive id and
    // sends it as x-romdev-session on EVERY call — first use creates the session,
    // reuse keeps the same host/state (load→step→read), and different ids isolate
    // different agents. NO HEADER → 401: we don't auto-mint a throwaway session
    // (that silently dropped the loaded ROM and surfaced as "No ROM loaded" two
    // calls later). Requiring the header up front turns that silent footgun into
    // a loud, fixable 401.
    const sessionKey = req.headers[SESSION_HEADER];
    // Optional agent attribution: which AGENT owns this session. Purely
    // cooperative -- declaring it buys the caller fair cap eviction (a
    // parallel agent evicts its own sessions, not a bystander's) and a
    // grouped sessionsByAgent in serverHealth/livestream.
    setSessionAgent(sessionKey, req.headers[AGENT_HEADER]);
    if (typeof sessionKey !== "string" || !sessionKey) {
      res.status(401).json({
        error: "Missing required `x-romdev-session` header. Pick ONE stable, " +
          "task-descriptive id for yourself (e.g. 'nes-platformer-build') and send " +
          "it on EVERY call — it's your per-session emulator key (the ROM you load " +
          "lives under it; the next call only sees it with the SAME id) and the " +
          "label shown in the /livestream observer. Several agents share one server " +
          "by each using a different id.",
      });
      return;
    }
    const { registry } = getSession(sessionKey, { sticky: true });
    const tool = registry.get(name);
    if (!tool) {
      res.status(404).json({
        error: `Unknown tool '${name}'. GET /openapi.json or /skills/romdev/SKILL.md for the list.`,
      });
      return;
    }
    // echo the session id back (convenience for clients that log it)
    res.setHeader(SESSION_HEADER, sessionKey);
    const out = await runTool(tool, req.body, sessionKey);
    if (out.ok) res.json(out.result);
    else res.status(400).json(out.result ?? { error: out.error });
  });

  // ── GET /tool/:name/schema ────────────────────────────────────────────────
  app.get("/tool/:name/schema", (req, res) => {
    const tool = metaRegistry.get(req.params.name);
    if (!tool) { res.status(404).json({ error: `Unknown tool '${req.params.name}'.` }); return; }
    res.json(toolJsonSchema(tool.inputSchema));
  });

  // ── GET /openapi.json ─────────────────────────────────────────────────────
  app.get("/openapi.json", (req, res) => {
    res.json(buildOpenApi(metaRegistry, version));
  });

  // ── GET /documentation (Swagger UI, served entirely from bundled assets) ──
  app.get("/documentation", (req, res) => {
    res.type("html").send(swaggerHtml({ specUrl: "/openapi.json", title: "romdev API" }));
  });
  // Serve the swagger-ui-dist CSS/JS from local node_modules — NO CDN.
  app.get("/documentation/:asset", (req, res) => {
    const buf = swaggerAsset(req.params.asset);
    if (!buf) { res.status(404).type("text/plain").send("not found"); return; }
    res.type(req.params.asset.endsWith(".css") ? "text/css" : "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  });

  // ── GET /skills/romdev/SKILL.md (primary) + aliases ───────────────────────
  // Agents store skills on disk as skills/<name>/SKILL.md (a dir named after the
  // skill, canonical file SKILL.md). We serve the same doc at several paths so
  // the URL matches wherever the agent saved it:
  //   /skills/romdev/SKILL.md  — primary: full disk mirror (~/.claude/skills/romdev/SKILL.md)
  //   /romdev/SKILL.md         — alias: the <name>/SKILL.md tail
  //   /romdev-skill.md         — alias: flat form (older refs)
  const serveSkill = (req, res) => {
    const md = buildSkillDoc({
      registry: metaRegistry,
      agentsBody: opts.agentsBody ?? "",
      version,
    });
    res.type("text/markdown").send(md);
  };
  app.get("/skills/romdev/SKILL.md", serveSkill);
  app.get("/romdev/SKILL.md", serveSkill);
  app.get("/romdev-skill.md", serveSkill); // alias

  log.debug("[http] tool surface mounted: POST /tool/:name, /openapi.json, /documentation, /skills/romdev/SKILL.md");
  return { sessions, stop: () => clearInterval(reaper) };
}

/**
 * Build an OpenAPI 3.1 document — one POST /tool/{name} path per tool, requestBody
 * schema from the same zod→JSON-Schema conversion the skill doc + MCP use.
 * @param {Map<string,any>} registry
 * @param {string} version
 */
export function buildOpenApi(registry, version) {
  const paths = {};
  for (const [name, tool] of registry) {
    const schema = toolJsonSchema(tool.inputSchema);
    const summary = (tool.description || "").split("\n")[0].slice(0, 120);
    paths[`/tool/${name}`] = {
      post: {
        operationId: name,
        summary,
        description: tool.description || "",
        requestBody: {
          required: true,
          content: { "application/json": { schema } },
        },
        responses: {
          200: { description: "Tool result (JSON).", content: { "application/json": { schema: { type: "object" } } } },
          400: { description: "Validation or tool error (the action did not succeed).", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
          401: { description: "Missing required x-romdev-session header.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
          404: { description: "Unknown tool." },
        },
        parameters: [{
          name: SESSION_HEADER, in: "header", required: true,
          schema: { type: "string" },
          description: "REQUIRED. Per-agent session id — pick one stable, UNIQUE, task-DESCRIPTIVE string (e.g. 'nes-platformer-build', 'rpg-romhack-text') and send it on EVERY call. It's the per-session emulator key (load→step→read state lives under it) AND the label shown in the /livestream observer, so a descriptive id tells a watching human which task each call belongs to. Several agents share one server safely by each using a different id. Missing → 401.",
        }],
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "romdev HTTP tool API",
      version,
      description: "Plain-HTTP surface for romdev's retro-game-dev tools — the non-MCP way to drive the same tools. Generated from the tool registry. See /skills/romdev/SKILL.md for the workflow guide.",
    },
    servers: [{ url: "/" }],
    paths,
  };
}

// HTTP tool surface — the non-MCP way to drive romdev. Mounts four routes on the
// SAME Express app as /mcp, all generated from the one tool registry:
//
//   POST /tool/:name          run a tool over plain HTTP (body = args) → JSON
//   GET  /tool/:name/schema   that tool's JSON Schema (a validator on demand)
//   GET  /openapi.json        OpenAPI 3.1 spec for every /tool/:name route
//   GET  /documentation       Swagger UI over /openapi.json (live "try it" console)
//   GET  /romdev-skill.md     the SKILL.md (Agent Skills open standard) — channel
//                             doc that drives the routes, never mentions MCP
//
// Sessions: each agent gets its own session dynamically, same isolation as MCP.
// First call with no x-romdev-session → mint one, return it in the response
// header; the agent echoes it on later calls (sticky host across load→step→read).
// A call with no header gets an ephemeral per-request session (fine for pure-file
// tools; stateful host work should keep the header). No auth — localhost trust,
// same as /mcp (the app already mounts localhostHostValidation()).

import { randomUUID } from "node:crypto";
import { buildToolRegistry, runTool, toolJsonSchema } from "./tool-registry.js";
import { skillPreamble, skillToolReference, buildSkillDoc } from "./skill-doc.js";
import { swaggerHtml } from "./swagger.js";
import { log } from "../mcp/log.js";

const SESSION_HEADER = "x-romdev-session";

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

  function getSession(sessionKey) {
    let s = sessions.get(sessionKey);
    if (!s) {
      s = { registry: buildToolRegistry(sessionKey), lastSeen: Date.now() };
      sessions.set(sessionKey, s);
      log.debug(`[http] session ${sessionKey.slice(0, 8)} created (${sessions.size} active)`);
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
        sessions.delete(key);
        log.debug(`[http] session ${key.slice(0, 8)} reaped (idle)`);
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
    // session: sticky if header present, ephemeral otherwise.
    let sessionKey = req.headers[SESSION_HEADER];
    let ephemeral = false;
    if (typeof sessionKey !== "string" || !sessionKey) {
      sessionKey = randomUUID();
      ephemeral = true;
    }
    const { registry } = getSession(sessionKey);
    const tool = registry.get(name);
    if (!tool) {
      res.status(404).json({
        error: `Unknown tool '${name}'. GET /openapi.json or /romdev-skill.md for the list.`,
      });
      return;
    }
    // echo the session id so the agent can reuse it (esp. when we minted one)
    res.setHeader(SESSION_HEADER, sessionKey);
    const out = await runTool(tool, req.body);
    if (ephemeral) {
      // drop the ephemeral session immediately (no sticky host wanted)
      sessions.delete(sessionKey);
    }
    if (out.ok) res.json(out.result);
    else res.status(400).json({ error: out.error });
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

  // ── GET /documentation (Swagger UI) ───────────────────────────────────────
  app.get("/documentation", (req, res) => {
    res.type("html").send(swaggerHtml({ specUrl: "/openapi.json", title: "romdev API" }));
  });

  // ── GET /romdev-skill.md ──────────────────────────────────────────────────
  app.get("/romdev-skill.md", (req, res) => {
    const md = buildSkillDoc({
      registry: metaRegistry,
      agentsBody: opts.agentsBody ?? "",
      version,
    });
    res.type("text/markdown").send(md);
  });

  log.debug("[http] tool surface mounted: POST /tool/:name, /openapi.json, /documentation, /romdev-skill.md");
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
          400: { description: "Validation or tool error.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
          404: { description: "Unknown tool." },
        },
        parameters: [{
          name: SESSION_HEADER, in: "header", required: false,
          schema: { type: "string" },
          description: "Per-agent session id. Omit on the first call to get one back in the response header; echo it on later calls to keep a sticky emulator session (load→step→read). Omit entirely for one-shot pure-file tools.",
        }],
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "romdev HTTP tool API",
      version,
      description: "Plain-HTTP surface for romdev's retro-game-dev tools — the non-MCP way to drive the same tools. Generated from the tool registry. See /romdev-skill.md for the workflow guide.",
    },
    servers: [{ url: "/" }],
    paths,
  };
}

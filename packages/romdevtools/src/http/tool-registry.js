// Tool registry harvester — the single source the HTTP route/skill/OpenAPI
// surfaces build from.
//
// The MCP path registers 34 tools via registerTools(server, z, sessionKey),
// where `server` is an McpServer and each handler closes over `sessionKey` for
// per-session host isolation. The HTTP surfaces (POST /tool/{name},
// /romdev-skill.md, /openapi.json, /documentation) want the EXACT same handlers,
// schemas, and clean-error behavior — just reached over plain HTTP.
//
// Rather than duplicate anything, we run the same registration against a minimal
// capture object that records { name, description, handler, inputSchema } per
// tool. We apply withClearToolErrors first (identical to the MCP path) so the
// strict/friendly schema + validation are the same. This is "one registry, many
// surfaces": the routes, the skill doc, and the OpenAPI spec are all generated
// from what registerTools() declares.

import { z } from "zod";
import { registerTools } from "../mcp/tools/index.js";
import { withClearToolErrors } from "../mcp/util.js";
import { observer, summarizeForLog, extractImages } from "../observer/bus.js";

/**
 * Build a tool registry for a given session key. Each entry's handler closes
 * over that key, so calling it drives THAT session's host (same isolation model
 * as an MCP session).
 *
 * @param {string} sessionKey  per-agent session id (randomUUID); scopes the host
 * @returns {Map<string, {name:string, description:string, handler:Function, inputSchema:any, shape:any}>}
 */
export function buildToolRegistry(sessionKey) {
  /** @type {Map<string, any>} */
  const tools = new Map();

  // Minimal capture object that looks enough like an McpServer for
  // registerTools(): it only ever calls server.tool() (and server.connect(),
  // which we no-op). withClearToolErrors patches server.tool to wrap the handler
  // and stamp the strict schema onto _registeredTools[name].inputSchema, exactly
  // as it does for the real server — so we read the SAME schema MCP validates.
  const capture = {
    _registeredTools: {},
    connect() { /* no transport for the harvest */ },
    tool(name, ...rest) {
      // server.tool(name, description?, shape?, annotations?, handler)
      let description = "";
      if (typeof rest[0] === "string") description = rest.shift();
      const shape = rest.find(
        (x) => x && typeof x === "object" && !Array.isArray(x) && !("_def" in x) &&
          Object.values(x).some((v) => v && typeof v === "object" && "_def" in v),
      ) || {};
      const handler = rest.find((x) => typeof x === "function");
      // mirror _createRegisteredTool's stored shape enough for withClearToolErrors
      const reg = { name, description, handler, inputSchema: shape, shape };
      this._registeredTools[name] = reg;
      tools.set(name, reg);
    },
  };

  // Same wrap the MCP server gets: clean errors + strict schema stamped onto
  // _registeredTools[name].inputSchema.
  withClearToolErrors(capture, z);
  registerTools(capture, z, sessionKey);

  // After registration, _registeredTools[name].inputSchema holds the strict
  // zod object (withClearToolErrors stamped it) and .handler is the wrapped
  // callback (validate → run). Reconcile into the returned map.
  for (const [name, reg] of tools) {
    const stamped = capture._registeredTools[name];
    if (stamped) {
      reg.inputSchema = stamped.inputSchema ?? reg.inputSchema;
      reg.handler = stamped.handler ?? reg.handler;
      reg.description = stamped.description ?? reg.description;
    }
  }
  return tools;
}

/**
 * Validate + run a tool over HTTP. The MCP SDK validates args against the tool's
 * schema BEFORE invoking the handler; the bare harvested handler does not, so the
 * route layer must do that parse itself (otherwise unknown/bad params slip
 * straight to the handler). We parse against the same strict zod object that
 * carries withClearToolErrors' friendly messages — so HTTP callers get the exact
 * same clean errors ("'op' must be one of…", "unknown parameter 'addr'. Did you
 * mean 'offset'?") as MCP callers.
 *
 * @param {{handler:Function, inputSchema:any, name:string}} tool
 * @param {object} args  the request body
 * @returns {Promise<{ok:true, result:any}|{ok:false, error:string}>}
 */
export async function runTool(tool, args, sessionKey) {
  const a = args ?? {};
  const startedAt = Date.now();
  // Emit the SAME `call` event the MCP path's observer middleware emits, so the
  // /livestream view updates for HTTP/skill tool calls too (the MCP path wraps
  // server.tool with installObserverMiddleware; the HTTP path runs handlers
  // directly, so we emit here — the single HTTP execution chokepoint).
  const emit = (extra) => {
    try {
      observer.push({
        type: "call",
        sessionKey: sessionKey ?? "http",
        ts: startedAt,
        tool: tool.name,
        args: summarizeForLog(a),
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    } catch { /* never let the observer kill a tool call */ }
  };

  // Parse against the strict schema if we have a built zod object.
  const schema = tool.inputSchema;
  if (schema && typeof schema === "object" && "_def" in schema && typeof schema.safeParse === "function") {
    const parsed = schema.safeParse(a);
    if (!parsed.success) {
      // surface the friendly first-issue message (withClearToolErrors / global map)
      const issue = parsed.error?.issues?.[0];
      const msg = (issue && issue.message) || "invalid arguments";
      emit({ ok: false, error: msg });
      return { ok: false, error: msg };
    }
  }
  try {
    const r = await tool.handler(a, {});
    // Unwrap the MCP content envelope to plain JSON for HTTP clients.
    if (r && r.isError) {
      const text = r.content?.[0]?.text ?? "tool error";
      emit({ ok: false, error: text });
      return { ok: false, error: text };
    }
    const images = extractImages(r);
    const text = r?.content?.[0]?.text;
    if (typeof text === "string") {
      // most tools return jsonContent(...) → text is JSON; parse it back so the
      // HTTP response is real JSON, not a JSON-string-in-a-field.
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { text }; }
      emit({ ok: true, result: summarizeForLog(parsed), ...(images.length ? { images } : {}) });
      return { ok: true, result: parsed };
    }
    // image / multi-part content: hand back the raw content array.
    const result = r?.content ? { content: r.content } : (r ?? {});
    emit({ ok: true, result: summarizeForLog(result), ...(images.length ? { images } : {}) });
    return { ok: true, result };
  } catch (e) {
    emit({ ok: false, error: e?.message ?? String(e) });
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Convert a tool's stored inputSchema (a strict zod object, or a raw shape if
 * the stamp didn't take) to a JSON Schema (zod v4 native). Used by the OpenAPI
 * spec, the skill doc param tables, and GET /tool/{name}/schema.
 *
 * @param {any} inputSchema  the stored schema (zod object) or raw shape
 * @returns {object} JSON Schema (draft 2020-12)
 */
export function toolJsonSchema(inputSchema) {
  try {
    // strict zod object → native conversion
    if (inputSchema && typeof inputSchema === "object" && "_def" in inputSchema) {
      return z.toJSONSchema(inputSchema, { io: "input" });
    }
    // raw shape fallback → wrap then convert
    return z.toJSONSchema(z.object(inputSchema ?? {}), { io: "input" });
  } catch {
    return { type: "object", properties: {}, additionalProperties: true };
  }
}

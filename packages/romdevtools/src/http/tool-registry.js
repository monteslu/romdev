// Tool registry harvester — the single source the HTTP route/skill/OpenAPI
// surfaces build from.
//
// The MCP path registers 32 tools via registerTools(server, z, sessionKey),
// where `server` is an McpServer and each handler closes over `sessionKey` for
// per-session host isolation. The HTTP surfaces (POST /tool/{name},
// /skills/romdev/SKILL.md, /openapi.json, /documentation) want the EXACT same handlers,
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
import { getHostOrNull } from "../mcp/state.js";

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
  // Which console this session's host currently has loaded — shown on every
  // livestream event so a human watching a multi-agent server sees the SYSTEM
  // (nes, genesis, …) alongside the tool, not just the session id. Best-effort.
  let platform = null;
  try { platform = getHostOrNull(sessionKey)?.status?.platform ?? null; } catch { /* none yet */ }
  const emit = (extra) => {
    try {
      observer.push({
        type: "call",
        sessionKey: sessionKey ?? "http",
        platform,
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
    // Re-resolve the platform AFTER the handler: a call like loadMedia /
    // build({output:'run'}) sets it during the call, so the post-call value
    // correctly labels this call's event + frame (the pre-call value was null).
    try { platform = getHostOrNull(sessionKey)?.status?.platform ?? platform; } catch { /* keep */ }
    // Unwrap the MCP content envelope to plain JSON for HTTP clients.
    if (r && r.isError) {
      const text = r.content?.[0]?.text ?? "tool error";
      emit({ ok: false, error: text });
      return { ok: false, error: text };
    }
    // Observer sidebands — identical to the MCP observer middleware (tool-wrap.js),
    // because the HTTP path runs handlers directly and would otherwise drop them:
    //   • _observerImages — a frame the tool wrote to DISK instead of returning
    //     inline (e.g. screenshot({path:...})); surface it to /livestream anyway.
    //   • _observerFrameProvider — a DEFERRED framebuffer thunk (frame({op:'verify'}),
    //     watch/breakpoint tools): the tool advanced/looked at the emulator but
    //     returns JSON-only to the caller. We encode the PNG ASYNC (setImmediate,
    //     after the HTTP response goes out) and push it as a `call_frame` event so
    //     the human's livestream sees the frame at zero cost to the caller.
    // Strip both from the caller-visible result before it's serialized.
    let sidebandImages = [];
    let frameProvider = null;
    if (r && typeof r === "object") {
      if (Array.isArray(r._observerImages)) { sidebandImages = r._observerImages; delete r._observerImages; }
      if (typeof r._observerFrameProvider === "function") { frameProvider = r._observerFrameProvider; delete r._observerFrameProvider; }
    }
    if (frameProvider) {
      setImmediate(() => {
        try {
          const img = frameProvider();
          // re-resolve platform: a call like loadMedia sets it DURING the call, so
          // the post-call value is the most accurate for the frame's system label.
          let framePlatform = platform;
          try { framePlatform = getHostOrNull(sessionKey)?.status?.platform ?? platform; } catch { /* keep */ }
          if (img) observer.push({ type: "call_frame", sessionKey: sessionKey ?? "http", platform: framePlatform, ts: startedAt, tool: tool.name, images: [img] });
        } catch { /* livestream is best-effort; never affects the caller */ }
      });
    }
    const inlineImages = extractImages(r);
    const images = inlineImages.length > 0 ? inlineImages : sidebandImages;
    const text = r?.content?.[0]?.text;
    if (typeof text === "string") {
      // most tools return jsonContent(...) → text is JSON; parse it back so the
      // HTTP response is real JSON, not a JSON-string-in-a-field.
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { text }; }
      // TRANSPORT-UNIFORM FAILURE MAPPING: a tool can signal failure either by
      // throwing (→ isError above) OR by RETURNING a failure-shaped result
      // ({ok:false} / {error} / {opened:false} / {applied:false} ...). On REST,
      // a 200 with a failure in the body is invisible — the caller sees success
      // and never reads the body. So we detect a failure-shaped result here and
      // map it to ok:false (→ HTTP 400) for EVERY tool, no per-tool special-
      // casing. (`notSupported`/`matched:false` are NOT failures — see below.)
      if (looksLikeFailure(parsed)) {
        const err = parsed.error ?? parsed.message ?? "tool reported failure";
        emit({ ok: false, error: err });
        return { ok: false, error: err, result: parsed };
      }
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

// A RETURNED result is a FAILURE (→ non-2xx) when it carries an explicit failure
// signal: a `false` on a verb-status flag, or a top-level `error` string. This is
// the single rule that makes every tool behave the same on the transport — a tool
// can fail by throwing or by returning one of these, and either way the caller
// gets a non-2xx it can't ignore.
//
// NOT failures (these are valid ANSWERS / STATE, stay 2xx):
//   • notSupported:true — the feature genuinely isn't on this platform/core
//   • matched:false / found:false / hit:false — a lookup whose answer is "no"
//   • looksLikeGraphic:false — a classification result
//   • loaded:false / paused:false — STATE fields (is a ROM loaded? is it paused?),
//     not "the action failed". This is why the flag list is DELIBERATELY narrow:
//     only generic verdict flags + a couple of unambiguous action verbs. Anything
//     else that wants to signal failure must do it with a top-level `error` string
//     (or throw) — both of which are unambiguous.
const FAILURE_FLAGS = ["ok", "success", "opened", "applied"];
function looksLikeFailure(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  // A top-level error string is unambiguous.
  if (typeof parsed.error === "string" && parsed.error) return true;
  // A generic verdict / unambiguous-action flag explicitly set to false.
  for (const f of FAILURE_FLAGS) {
    if (parsed[f] === false) return true;
  }
  return false;
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

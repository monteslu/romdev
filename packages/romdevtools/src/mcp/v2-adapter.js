// A `.tool()` face over the v2 (2026-07-28) McpServer.
//
// romdev registers 35 tools through the v1 shape:
//
//     server.tool(name, description, zodRawShape, handler)
//
// v2's McpServer dropped `.tool()` for `registerTool(name, config, cb)`. The
// registration bodies are ~7000 lines of tool definitions, descriptions and
// handlers that have nothing to do with the transport era, and the SDK
// migration guide is explicit that BOTH eras must be served from ONE factory
// so the two can never drift apart. Rewriting 35 call sites would fork that
// definition in practice even if it did not in principle, and every one of
// those descriptions is load-bearing (see the fresh-agent-validation rule:
// they are NOT to be trimmed or churned).
//
// So the definitions stay exactly as they are and this adapter translates the
// call. It is deliberately tiny and does nothing else: no behaviour, no
// policy, no error shaping -- those already live in safeTool /
// withClearToolErrors, which wrap the handler before it ever gets here.
//
// See internal-romdev/PLAN_mcp_v2_stateless_and_host_lifetime.md (workstream C).

import { z } from "zod";
import { SESSION_ARG } from "./session-key.js";

/**
 * Wrap a v2 McpServer so `registerTools(server, z, sessionKey)` can drive it
 * unchanged. Returns a proxy exposing `.tool()`; every other property passes
 * through to the real server.
 *
 * @param {object} v2Server an @modelcontextprotocol/server McpServer
 * @param {{sessionParam?: boolean, sessionNote?: string|null}} [opts]
 *   sessionParam: add the optional `session` handle to every shaped tool.
 *   sessionNote: a line appended to every successful result (the server
 *   passes the handle it chose for a caller that never named one).
 * @returns {object} the same server, plus a v1-style `.tool()`
 */
export function withV1ToolApi(v2Server, opts = {}) {
  const { sessionParam = false, sessionNote = null } = opts;
  // Later layers (installObserverMiddleware, withClearToolErrors) wrap
  // `.tool` by ASSIGNING over it. Without a `set` trap the assignment landed
  // on the target and the `get` trap kept returning the adapter's own
  // function, so every wrapper was silently bypassed in the modern era.
  // Honour the assignment: the newest wrapper is what `.tool` returns.
  let toolOverride = null;
  const sessionShape = sessionParam
    ? {
        [SESSION_ARG]: z.string().optional().describe(
          "Session handle (optional). Every stateful tool (loadMedia, build run, frame, memory, input, state, playtest, …) drives ONE emulator per session. Omit it and the server keys your session to your connection and reports the handle it chose as a trailing `session: <id>` line in each result; pass that id back here to pin later calls to the same emulator even if your connection changes, or pass your own stable slug to name the session up front. A DIFFERENT value is a fully isolated second emulator (e.g. deterministic stepping while a human plays in the first)."),
      }
    : null;
  return new Proxy(v2Server, {
    set(target, prop, value) {
      if (prop === "tool") { toolOverride = value; return true; }
      return Reflect.set(target, prop, value);
    },
    get(target, prop, receiver) {
      if (prop === "tool" && toolOverride) return toolOverride;
      if (prop === "tool") {
        /**
         * v1: tool(name, description, inputShape, handler)
         *     tool(name, inputShape, handler)
         *     tool(name, description, handler)
         *     tool(name, handler)
         */
        return (name, ...rest) => {
          let description;
          let inputSchema;
          let handler;

          for (const arg of rest) {
            if (typeof arg === "function") handler = arg;
            else if (typeof arg === "string") description = arg;
            else if (arg && typeof arg === "object") inputSchema = arg;
          }

          const config = {};
          if (description) config.description = description;
          // A raw zod shape is accepted by registerTool's legacy overload
          // (auto-wrapped in z.object). Passing an EMPTY shape is not the same
          // as passing none -- omit it so a no-arg tool stays no-arg.
          if (inputSchema && Object.keys(inputSchema).length > 0) {
            // The `session` handle rides on every shaped tool (session-key.js
            // resolves it before dispatch; handlers never see a difference).
            config.inputSchema = sessionShape && !(SESSION_ARG in inputSchema)
              ? { ...inputSchema, ...sessionShape }
              : inputSchema;
          }
          if (sessionNote && typeof handler === "function") {
            // Advertise the handle the server chose. Only when the caller never
            // named its session -- an explicit handle gets no reminder.
            const inner = handler;
            handler = async (...callArgs) => {
              const r = await inner(...callArgs);
              if (r && typeof r === "object" && Array.isArray(r.content) && !r.isError) {
                return { ...r, content: [...r.content, { type: "text", text: sessionNote }] };
              }
              return r;
            };
          }

          return target.registerTool(name, config, handler);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

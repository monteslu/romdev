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

/**
 * Wrap a v2 McpServer so `registerTools(server, z, sessionKey)` can drive it
 * unchanged. Returns a proxy exposing `.tool()`; every other property passes
 * through to the real server.
 *
 * @param {object} v2Server an @modelcontextprotocol/server McpServer
 * @returns {object} the same server, plus a v1-style `.tool()`
 */
export function withV1ToolApi(v2Server) {
  return new Proxy(v2Server, {
    get(target, prop, receiver) {
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
            config.inputSchema = inputSchema;
          }

          return target.registerTool(name, config, handler);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// observer/tool-wrap.js — install the observer middleware on an MCP
// server instance. Monkey-patches `server.tool(name, desc, schema, handler)`
// so every registered tool's handler is wrapped to emit a `call` event
// to the observer bus after it completes (success OR error).
//
// Idempotent per server instance — installs once, repeats are no-ops.

import { observer, extractImages, summarizeForLog } from "./bus.js";

const INSTALLED = Symbol.for("rom-dev-mcp.observer-installed");

/**
 * Install tool-call instrumentation on an MCP server.
 *
 * @param {object} server  McpServer instance
 * @param {string} sessionKey  per-session key (already minted upstream)
 */
export function installObserverMiddleware(server, sessionKey) {
  if (server[INSTALLED]) return;
  server[INSTALLED] = true;

  const originalTool = server.tool.bind(server);

  server.tool = function wrappedTool(name, ...rest) {
    // Last argument is the handler — replace it with our wrapper.
    if (rest.length === 0) return originalTool(name, ...rest);
    const handler = rest[rest.length - 1];
    if (typeof handler !== "function") return originalTool(name, ...rest);

    const wrappedHandler = async (args, extra) => {
      const startedAt = Date.now();
      let result;
      let thrown;
      try {
        result = await handler(args, extra);
      } catch (err) {
        thrown = err;
      }
      const durationMs = Date.now() - startedAt;

      // Build the event. We summarize args + result so the livestream
      // log isn't dominated by base64 / huge source strings, but keep
      // top-level property names intact.
      const argsSummary = summarizeForLog(args);
      let event;
      if (thrown) {
        event = {
          type: "call",
          sessionKey,
          ts: startedAt,
          tool: name,
          args: argsSummary,
          durationMs,
          ok: false,
          error: String(thrown?.message ?? thrown),
        };
      } else {
        // Tool errors come back as { isError: true, content: [{type:'text',...}] }
        // via safeTool. Capture those as ok:false too.
        const isError = result?.isError === true;
        // Tools that write images to disk instead of returning them inline
        // (e.g. screenshot({path:...})) attach a `_observerImages` sideband
        // so the livestream still sees the frame. Strip it before the
        // agent-visible response is serialized.
        const sidebandImages = Array.isArray(result?._observerImages)
          ? result._observerImages
          : [];
        if (sidebandImages.length > 0 && result && typeof result === "object") {
          delete result._observerImages;
        }
        // Same pattern for ANSI text (screenshotAscii). The livestream
        // HTML renders it in a side pane so the human can see the
        // (lossy) view the agent actually got.
        let sidebandAnsi = null;
        if (result && typeof result === "object" && typeof result._observerAnsi === "string") {
          sidebandAnsi = result._observerAnsi;
          delete result._observerAnsi;
        }
        const inlineImages = extractImages(result);
        const images = inlineImages.length > 0 ? inlineImages : sidebandImages;
        const resultSummary = summarizeForLog(result);
        event = {
          type: "call",
          sessionKey,
          ts: startedAt,
          tool: name,
          args: argsSummary,
          durationMs,
          ok: !isError,
          result: resultSummary,
          ...(images.length > 0 ? { images } : {}),
          ...(sidebandAnsi ? { ansi: sidebandAnsi } : {}),
          ...(isError ? { error: extractErrorText(result) } : {}),
        };
      }

      // Fire-and-forget — emit is synchronous + we don't block the
      // tool response on observer delivery.
      try { observer.push(event); } catch { /* never let observer kill the tool */ }

      if (thrown) throw thrown;
      return result;
    };

    return originalTool(name, ...rest.slice(0, -1), wrappedHandler);
  };
}

function extractErrorText(result) {
  if (!result?.content) return "(unknown error)";
  for (const c of result.content) {
    if (c?.type === "text") return c.text;
  }
  return "(unknown error)";
}

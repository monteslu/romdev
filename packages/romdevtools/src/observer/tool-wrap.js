// observer/tool-wrap.js — install the observer middleware on an MCP
// server instance. Monkey-patches `server.tool(name, desc, schema, handler)`
// so every registered tool's handler is wrapped to emit a `call` event
// to the observer bus after it completes (success OR error).
//
// Idempotent per server instance — installs once, repeats are no-ops.

import { observer, extractImages, summarizeForLog, pushObserverFrame } from "./bus.js";
import { getHostOrNull } from "../mcp/state.js";

const INSTALLED = Symbol.for("romdev.observer-installed");

// The platform/system the session's host currently has loaded (nes, genesis, …),
// or null if no ROM is loaded yet. Surfaced on every livestream event so a human
// watching a multi-agent server sees WHICH console each tool call / frame belongs
// to, not just the session id + tool name. Best-effort: never throws.
function sessionPlatform(sessionKey) {
  try { return getHostOrNull(sessionKey)?.status?.platform ?? null; } catch { return null; }
}

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
      const platform = sessionPlatform(sessionKey); // which console this call drives
      let event;
      let frameProvider = null; // deferred framebuffer thunk (encoded async below)
      let frameCaption = null;  // optional human label for the call_frame event
      if (thrown) {
        event = {
          type: "call",
          sessionKey,
          platform,
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
        // DEFERRED frame provider (breakpoint/watch tools): a thunk that renders
        // the host's current framebuffer to PNG. We do NOT call it here — that
        // would put the encode on the AGENT's critical path. We strip it from the
        // agent-visible result now and rasterize it ASYNCHRONOUSLY below, after
        // the response has gone out, so the human's livestream still sees the
        // frame at zero cost to the agent.
        if (result && typeof result === "object" && typeof result._observerFrameProvider === "function") {
          frameProvider = result._observerFrameProvider;
          delete result._observerFrameProvider;
        }
        if (result && typeof result === "object" && typeof result._observerFrameCaption === "string") {
          frameCaption = result._observerFrameCaption;
          delete result._observerFrameCaption;
        }
        const inlineImages = extractImages(result);
        const images = inlineImages.length > 0 ? inlineImages : sidebandImages;
        const resultSummary = summarizeForLog(result);
        event = {
          type: "call",
          sessionKey,
          platform,
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

      // Deferred frame: encoded + pushed AFTER the agent's response goes out,
      // throttled to one per 2s PER (session, tool) with a trailing-edge
      // emit (bus.js pushObserverFrame) — frame-step loops can't flood the
      // stream, distinct tools never throttle each other, and the last frame
      // of a burst always lands. Best-effort — never throws into the tool
      // path.
      if (frameProvider) {
        pushObserverFrame({
          sessionKey, tool: name, ts: startedAt, platform,
          resolvePlatform: () => sessionPlatform(sessionKey),
          ...(frameCaption ? { caption: frameCaption } : {}),
        }, frameProvider);
      }

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

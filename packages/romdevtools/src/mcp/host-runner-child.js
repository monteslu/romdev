// One session's host runner: the child process side of host-runners.js.
//
// It builds the same tool registry the server builds (buildToolRegistry) and
// runs each forwarded call through the same handler, so a tool's behaviour
// and result are what they were in-process. Everything a handler touches that
// is per session (the host, the playtest window, autoplay, Active Bezel,
// auto-snapshots, the cart log) lives here. What is server-wide goes back to
// the front over IPC: livestream events, "this session ended", and the
// questions a timing run asks about other sessions.
//
// Plain JS ESM + JSDoc.

// Listen first: the front may send before the heavy imports below finish.
const queue = [];
let handle = null;
process.on("message", (m) => { if (handle) handle(m); else queue.push(m); });
// The front is gone (crashed, killed): nothing can reach this session again.
process.on("disconnect", () => process.exit(0));

const { applyGpuPin } = await import("../host/gpu-pin.js");
applyGpuPin({ log: (m) => console.error(m) });
const { installCartLogFilter } = await import("./cart-log.js");
installCartLogFilter();

const send = (m) => { try { process.send?.(m); } catch { /* the front is gone */ } };

// Livestream: events go to the front's bus; frames are rasterized here (the
// host is here) at the cadence the front's watcher count asks for.
const { observer } = await import("../observer/bus.js");
let observerListeners = 0;
observer.push = (event) => send({ t: "observer", event });
observer.listenerCount = (name) => (name === "event" ? observerListeners : 0);

const { buildToolRegistry } = await import("../http/tool-registry.js");
const state = await import("./state.js");
const { noteToolCall, stopAllPlay, stopPlay, playStatus } = await import("./autoplay.js");
const playtestMod = await import("./tools/playtest.js");
const { onSessionEnd } = await import("./session-events.js");
const { rememberMinted } = await import("./session-key.js");
const { setHolderListener } = await import("./exclusive-gate.js");
const { pushObserverFrame } = await import("../observer/bus.js");
const { sessionStatusPart } = await import("./tools/index.js");

let sessionKey = null;
let registry = null;
let sessionEnded = false;
let nextReq = 1;
const replies = new Map();

/** Ask the front a question (a timing run's view of other sessions). */
function askFront(what, timeoutMs = 2000) {
  const id = nextReq++;
  return new Promise((resolve) => {
    const t = setTimeout(() => { replies.delete(id); resolve(null); }, timeoutMs);
    t.unref?.();
    replies.set(id, (v) => { clearTimeout(t); resolve(v); });
    send({ t: "request", id, what });
  });
}

function snapshot() {
  const peek = state.peekSession(sessionKey);
  const human = playtestMod.getPlaytestHumanStatus(sessionKey);
  const lm = state.getLastMedia(sessionKey);
  let gpuApi = null;
  try {
    const h = state.getHostOrNullNoTouch(sessionKey);
    const c = h?.cart;
    if (c) gpuApi = c.usesWgpu ? "webgpu" : c.usesGL ? "gl" : "2d";
    else if (h?.hwRender?.active) gpuApi = "gl";
  } catch { /* best-effort */ }
  return {
    hostLive: peek.hostLive,
    hostBLive: state.hostLifetimeStats().liveHostsSlotB > 0,
    loaded: peek.loaded,
    platform: peek.platform ?? null,
    mediaPath: peek.path ?? null,
    lastMedia: lm,
    playtestOpen: human.windowOpen,
    humanInputActive: human.humanInputActive,
    // a real-time host({op:'play'}) run is activity, as its ticks are in-process
    playing: !!playStatus(sessionKey),
    ...(gpuApi ? { gpuApi } : {}),
  };
}
let lastSnapJson = "";
function report(force = false) {
  if (!sessionKey) return;
  const snap = snapshot();
  const j = JSON.stringify(snap);
  if (!force && j === lastSnapJson) return;
  lastSnapJson = j;
  send({ t: "state", snap });
}

async function runCall(m) {
  const tool = registry.get(m.tool);
  if (!tool) return { ok: false, error: `Unknown tool '${m.tool}'` };
  try { noteToolCall(sessionKey, m.tool, m.args); } catch { /* never blocks a call */ }
  const startedAt = Date.now();
  const r = await tool.handler(m.args ?? {}, {});
  // The deferred livestream frame needs the host, which is here: queue it here.
  if (r && typeof r === "object" && typeof r._observerFrameProvider === "function") {
    const provider = r._observerFrameProvider;
    delete r._observerFrameProvider;
    const caption = typeof r._observerFrameCaption === "string" ? r._observerFrameCaption : null;
    delete r._observerFrameCaption;
    const platform = state.peekSession(sessionKey).platform ?? null;
    try {
      pushObserverFrame({
        sessionKey, tool: m.tool, ts: startedAt, platform,
        resolvePlatform: () => state.peekSession(sessionKey).platform ?? platform,
        ...(caption ? { caption } : {}),
      }, provider);
    } catch { /* best-effort */ }
  }
  return { ok: true, result: r };
}

function shutdown() {
  try { stopAllPlay(); } catch {}
  try { playtestMod.stopAllPlaytest(); } catch {}
  try { if (sessionKey) state.clearHost(sessionKey); } catch {}
  setTimeout(() => process.exit(0), 50);
}

handle = async (m) => {
  if (!m || typeof m !== "object") return;
  switch (m.t) {
    case "init": {
      sessionKey = m.sessionKey;
      observerListeners = m.observerListeners ?? 0;
      if (m.lastMedia) state.rememberLastMedia(sessionKey, m.lastMedia);
      if (m.minted) rememberMinted(sessionKey);
      // host({op:'shutdown'}) ends the session: tell the front after the
      // call's result has gone back, so the result is not lost with us.
      onSessionEnd((k) => { if (k === sessionKey) sessionEnded = true; });
      setHolderListener((active) => send({ t: "timing", active }));
      state.setServerQuery((what) => askFront(what));
      registry = buildToolRegistry(sessionKey);
      // Test hook (test/host-runners.test.js): a stand-in playtest window with
      // a human pressing buttons, for the sessions named here, so the front's
      // protection and status plumbing can be tested without a display.
      if (String(process.env.ROMDEV_TEST_FAKE_PLAYTEST ?? "").split(",").includes(sessionKey)) {
        playtestMod.__setSessionForTest(sessionKey, { running: true, windowAlive: () => true, stop() {}, humanInputActive: () => true, framesSinceHumanInput: () => 3 });
      }
      send({ t: "ready" });
      report(true);
      break;
    }
    case "call": {
      let out;
      try { out = await runCall(m); } catch (e) { out = { ok: false, error: e?.message ?? String(e) }; }
      if (out.ok) send({ t: "result", id: m.id, ok: true, result: out.result });
      else send({ t: "result", id: m.id, ok: false, error: out.error });
      report();
      if (sessionEnded) { sessionEnded = false; send({ t: "sessionEnd" }); }
      break;
    }
    case "status": {
      let part = null;
      try { part = sessionStatusPart(sessionKey); } catch (e) { part = { base: { loaded: false, error: String(e?.message ?? e) } }; }
      send({ t: "result", id: m.id, ok: true, result: part });
      break;
    }
    case "evict": {
      if (playtestMod.isPlaytestRunning(sessionKey)) break; // a human may be playing
      try { stopPlay(sessionKey, "evicted"); } catch {}
      try { state.clearHost(sessionKey); } catch {}
      report(true);
      break;
    }
    case "observerListeners": observerListeners = m.n ?? 0; break;
    case "reply": { const f = replies.get(m.id); if (f) { replies.delete(m.id); f(m.value); } break; }
    case "shutdown": shutdown(); break;
    default: break;
  }
};
for (const m of queue.splice(0)) handle(m);

// Heartbeat: the front's watchdog reads a silent child with a call in flight
// as wedged. The state report rides along when it changed (a human closing
// the window, a playtest reload).
const hb = setInterval(() => { send({ t: "hb" }); report(); }, 1000);
hb.unref?.();

// Same policy as the server: one bad call must not end the session's process.
process.on("uncaughtException", (err) => { console.error("[host-runner] uncaughtException - keeping process alive:", err); });
process.on("unhandledRejection", (reason) => { console.error("[host-runner] unhandledRejection - keeping process alive:", reason); });
// Keep the event loop alive for as long as the front holds the channel.
setInterval(() => {}, 1 << 30);

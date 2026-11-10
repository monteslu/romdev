// Host runners: every session's emulator host runs in its own child process.
//
// Why. Every session's tools used to run on the server's one Node thread. A GL
// cart's frames run synchronously, a WebGPU cart yields to the event loop
// twice a frame, and a slow cart debug command holds the thread for as long
// as it takes. So one session's long step stalled every other session and the
// MCP/HTTP front with it: an `initialize` took 40 s on a busy server, a WebGPU
// step crawled at about 1 s a frame while the GPU idled (each of its yields ran
// whatever other sessions had queued), and a native abort in one cart's audio
// thread (PulseAudio TLS keys) or a V8 heap OOM took every session down.
//
// What. The server process keeps the front: HTTP, MCP transports, session
// identity, schemas and validation, the observer bus, catalog, eviction
// policy. Each session's tool calls run in ONE child process for that session
// (src/mcp/host-runner-child.js), which builds the same tool registry and runs
// the same handlers against a host that is local to it, so no tool's code or
// result changes. The child is forked from the server's own node with its
// flags and environment (the GPU pin rides in the environment).
//
//   - A child that dies (a signal, an abort, a heap OOM) fails only that
//     session's in-flight calls, with an error that names the call and how it
//     died; the next call starts a fresh child, and the "No ROM loaded"
//     recovery hint still names the last loadMedia (lastMedia lives here).
//   - A child whose event loop stops answering while a call runs (a cart that
//     never returns from a frame) is killed after ROMDEV_RUNNER_WEDGE_MS.
//   - Host lifetime is the same policy as state.js: hosts idle past
//     ROMDEV_HOST_IDLE_MS are evicted, at most ROMDEV_MAX_HOSTS live, a
//     playtest window is never evicted. A child with no host is ended after
//     the session idle time, and at most ROMDEV_MAX_HOST_RUNNERS run at once.
//
// ROMDEV_HOST_WORKERS=0 (or --no-host-workers) runs every host in the server
// process instead, exactly as before.
//
// Plain JS ESM + JSDoc.

import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { log } from "./log.js";
import { observer } from "../observer/bus.js";
import { getLastMedia, rememberLastMedia } from "./state.js";
import { wasMinted } from "./session-key.js";
import { pickEvictionVictim } from "./agent-identity.js";
import { emitSessionEnd } from "./session-events.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "host-runner-child.js");

/** Are hosts to run in child processes? (default yes) */
export function hostWorkersEnabled(argv = process.argv, env = process.env) {
  if (argv.slice(2).includes("--no-host-workers")) return false;
  const v = String(env.ROMDEV_HOST_WORKERS ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

const HOST_IDLE_MS = Number(process.env.ROMDEV_HOST_IDLE_MS ?? 10 * 60 * 1000);
const MAX_HOSTS = Number(process.env.ROMDEV_MAX_HOSTS ?? 10);
const RUNNER_IDLE_MS = Number(process.env.ROMDEV_RUNNER_IDLE_MS ?? process.env.ROMDEV_SESSION_IDLE_MS ?? 30 * 60 * 1000);
const MAX_RUNNERS = Number(process.env.ROMDEV_MAX_HOST_RUNNERS ?? MAX_HOSTS + 6);
const WEDGE_MS = Number(process.env.ROMDEV_RUNNER_WEDGE_MS ?? 10 * 60 * 1000);
const STATUS_WAIT_MS = Number(process.env.ROMDEV_RUNNER_STATUS_WAIT_MS ?? 1500);
const TAIL_LINES = 40;

function rssMbOf(pid) {
  try {
    const m = /^VmRSS:\s*(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

function describeCall(c) {
  if (!c) return "a call";
  return c.op ? `${c.tool}({op:'${c.op}'})` : `${c.tool}`;
}

/**
 * @typedef {object} Runner
 * @property {string} key
 * @property {import("node:child_process").ChildProcess} child
 * @property {number} pid
 * @property {Promise<void>} ready
 * @property {Map<number, {resolve: Function, reject: Function, tool: string, op?: string, startedAt: number, kind: string}>} pending
 * @property {object} snap  last state the child reported
 * @property {object|null} lastStatus  last catalog session part it answered
 * @property {number} lastUsed
 * @property {number} lastHeartbeat
 * @property {number} startedAt
 * @property {boolean} retiring
 * @property {string[]} tail  last stderr/stdout lines
 * @property {{tool: string, op?: string, ms: number}|null} lastCall
 * @property {number|null} timingSince
 */

export function createHostRunnerPool() {
  /** @type {Map<string, Runner>} */
  const runners = new Map();
  /** recent unexpected deaths, newest last */
  const crashes = [];
  /** one-shot note for a session whose child died with no call in flight */
  const crashNotes = new Map();
  let nextId = 1;
  let listeners = observer.listenerCount("event");

  function send(r, msg) {
    try { r.child.send(msg); return true; } catch { return false; }
  }

  function spawn(key) {
    makeRoom(key);
    const child = fork(CHILD, [], {
      execArgv: process.execArgv,
      env: { ...process.env, ROMDEV_HOST_RUNNER: "1", ...(log.verbose ? { ROMDEV_VERBOSE: "1" } : {}) },
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let readyResolve, readyReject;
    const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    ready.catch(() => {});
    /** @type {Runner} */
    const r = {
      key, child, pid: child.pid, ready, pending: new Map(), snap: {}, lastStatus: null,
      lastUsed: Date.now(), lastHeartbeat: Date.now(), startedAt: Date.now(), retiring: false,
      tail: [], lastCall: null, timingSince: null,
    };
    runners.set(key, r);
    const tag = `[host ${String(key).slice(0, 12)} pid=${child.pid}]`;
    const onLines = (buf) => {
      for (const line of String(buf).split("\n")) {
        if (!line) continue;
        r.tail.push(line);
        if (r.tail.length > TAIL_LINES) r.tail.shift();
        try { process.stderr.write(`${tag} ${line}\n`); } catch { /* log is best-effort */ }
      }
    };
    child.stdout?.on("data", onLines);
    child.stderr?.on("data", onLines);
    child.on("message", (m) => onMessage(r, m, readyResolve));
    child.on("error", (e) => { log.error(`${tag} process error: ${e?.message ?? e}`); });
    child.on("exit", (code, signal) => onExit(r, code, signal, readyReject));
    send(r, {
      t: "init",
      sessionKey: key,
      lastMedia: getLastMedia(key),
      minted: wasMinted(key),
      observerListeners: listeners,
    });
    log.debug(`${tag} started (${runners.size} host runner(s))`);
    return r;
  }

  function onMessage(r, m, readyResolve) {
    if (!m || typeof m !== "object") return;
    r.lastHeartbeat = Date.now();
    switch (m.t) {
      case "ready": readyResolve(); break;
      case "hb": break;
      case "result": {
        const p = r.pending.get(m.id);
        if (!p) break;
        r.pending.delete(m.id);
        if (p.kind === "call") r.lastCall = { tool: p.tool, ...(p.op ? { op: p.op } : {}), ms: Date.now() - p.startedAt };
        if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error(m.error ?? "host runner error"), { fromRunner: true }));
        break;
      }
      case "state": applySnap(r, m.snap); break;
      case "observer": try { observer.push(m.event); } catch { /* best-effort */ } break;
      case "sessionEnd": try { emitSessionEnd(r.key); } catch { /* listeners are best-effort */ } break;
      case "timing": r.timingSince = m.active ? Date.now() : null; break;
      case "request": {
        let value = null;
        if (m.what === "liveHosts") value = { otherLiveHosts: otherLiveHosts(r.key), otherBusySessions: otherBusy(r.key) };
        send(r, { t: "reply", id: m.id, value });
        break;
      }
      default: break;
    }
  }

  function applySnap(r, snap) {
    if (!snap || typeof snap !== "object") return;
    const hadHost = !!r.snap?.hostLive;
    r.snap = snap;
    if (snap.lastMedia) rememberLastMedia(r.key, snap.lastMedia);
    if (!hadHost && snap.hostLive) enforceHostCap(r.key);
  }

  function onExit(r, code, signal, readyReject) {
    if (runners.get(r.key) === r) runners.delete(r.key);
    readyReject(new Error("host runner exited"));
    const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
    const pending = [...r.pending.values()];
    r.pending.clear();
    if (r.retiring) {
      for (const p of pending) p.reject(Object.assign(new Error(`this session ended (${r.retireReason ?? "shutdown"}) while ${describeCall(p)} was running`), { fromRunner: true }));
      log.debug(`[host ${String(r.key).slice(0, 12)} pid=${r.pid}] ended (${r.retireReason ?? "retired"})`);
      return;
    }
    const why = r.wedged ? `stopped answering for ${Math.round(WEDGE_MS / 1000)} s while ${describeCall(r.wedged)} ran (the cart did not return), so the server killed it` : how;
    const crash = { session: r.key, pid: r.pid, at: new Date().toISOString(), why, during: pending.map(describeCall), lastLines: r.tail.slice(-8) };
    crashes.push(crash);
    if (crashes.length > 10) crashes.shift();
    log.error(`[host ${String(r.key).slice(0, 12)} pid=${r.pid}] host process ${why}${pending.length ? ` during ${crash.during.join(", ")}` : ""}; other sessions are unaffected`);
    const lm = getLastMedia(r.key);
    const recall = lm?.path ? `loadMedia({ platform: "${lm.platform}", path: "${lm.path}" })` : "loadMedia({...})";
    const text = (call) =>
      `This session's host process (pid ${r.pid}) ${why}` +
      (call ? ` while running ${describeCall(call)}` : "") +
      ". Only this session was affected: the server and every other session keep running. " +
      `Its emulator state is gone; the next call starts a fresh host process. RECOVER by re-running ${recall}.` +
      (r.tail.length ? `\nLast output from the host process:\n  ${r.tail.slice(-8).join("\n  ")}` : "");
    for (const p of pending) p.resolve({ isError: true, content: [{ type: "text", text: text(p) }] });
    if (!pending.length) crashNotes.set(r.key, text(null));
  }

  function ensure(key) {
    const r = runners.get(key);
    if (r && !r.retiring) return r;
    return spawn(key);
  }

  function request(r, msg, kind, meta = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      r.pending.set(id, { resolve, reject, kind, startedAt: Date.now(), tool: meta.tool ?? kind, op: meta.op });
      r.ready.then(() => { if (!send(r, { ...msg, id })) { r.pending.delete(id); reject(new Error("host runner is gone")); } },
        () => { /* the exit handler settles pending requests */ });
    });
  }

  /**
   * Run one tool call in the session's host runner. Resolves to the tool's
   * MCP result (the same object the handler returned in-process).
   */
  async function call(key, tool, args) {
    const r = ensure(key);
    r.lastUsed = Date.now();
    const op = args && typeof args === "object" && typeof args.op === "string" ? args.op : undefined;
    let result;
    try {
      result = await request(r, { t: "call", tool, args }, "call", { tool, op });
    } finally {
      r.lastUsed = Date.now();
    }
    const note = crashNotes.get(key);
    if (note && result && typeof result === "object" && Array.isArray(result.content)) {
      crashNotes.delete(key);
      result.content.push({ type: "text", text: `note: ${note}` });
    }
    return result;
  }

  /**
   * The host-side part of catalog({op:'status'}) for a session, or null when
   * it has no runner. A runner busy past STATUS_WAIT_MS answers from its last
   * report, marked with what it is busy doing.
   */
  async function sessionStatus(key) {
    const r = runners.get(key);
    if (!r || r.retiring) return null;
    const busy = busyCalls(r);
    let part = null;
    let stale = false;
    try {
      part = await Promise.race([
        request(r, { t: "status" }, "status"),
        new Promise((res) => setTimeout(() => res(null), STATUS_WAIT_MS).unref?.()),
      ]);
    } catch { part = null; }
    if (part) r.lastStatus = part;
    else { part = r.lastStatus; stale = true; }
    if (!part) part = { base: { loaded: !!r.snap.loaded, ...(r.snap.platform ? { platform: r.snap.platform } : {}) }, caps: null, human: { windowOpen: !!r.snap.playtestOpen, humanInputActive: !!r.snap.humanInputActive, framesSinceHumanInput: null } };
    if (busy.length) part = { ...part, hostBusy: { calls: busy, ...(stale ? { statusFromLastReport: true } : {}) } };
    return part;
  }

  function busyCalls(r) {
    const now = Date.now();
    return [...r.pending.values()].filter((p) => p.kind === "call").map((p) => ({ call: describeCall(p), forMs: now - p.startedAt }));
  }

  function isBusy(r) {
    if (r.snap?.playing) return true;
    for (const p of r.pending.values()) if (p.kind === "call") return true;
    return false;
  }
  function otherBusy(key) { let n = 0; for (const [k, r] of runners) if (k !== key && isBusy(r)) n++; return n; }
  function hostKeys() { return [...runners.values()].filter((r) => r.snap?.hostLive && !r.retiring).map((r) => r.key); }
  function isProtected(key) { return !!runners.get(key)?.snap?.playtestOpen; }

  function otherLiveHosts(key) {
    let n = 0;
    for (const [k, r] of runners) {
      if (k === key || r.retiring) continue;
      if (r.snap?.hostLive) n++;
      if (r.snap?.hostBLive) n++;
    }
    return n;
  }

  /** Ask a runner to drop its host(s), keeping the process (and the session's other state). */
  function evict(key) {
    const r = runners.get(key);
    if (!r) return;
    send(r, { t: "evict" });
    r.snap = { ...r.snap, hostLive: false, hostBLive: false, loaded: false };
  }

  /** End a session's runner: tell it to shut down, kill it if it does not. */
  function retire(key, reason = "session ended") {
    const r = runners.get(key);
    if (!r) return;
    runners.delete(key);
    r.retiring = true;
    r.retireReason = reason;
    send(r, { t: "shutdown" });
    const t = setTimeout(() => { try { r.child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
    t.unref?.();
  }

  function enforceHostCap(incomingKey) {
    const evicted = [];
    while (hostKeys().length > MAX_HOSTS) {
      const candidates = hostKeys().filter((k) => k !== incomingKey && !isProtected(k) && !isBusy(runners.get(k)));
      const victim = pickEvictionVictim(candidates, (k) => runners.get(k)?.lastUsed ?? 0);
      if (!victim) break;
      evict(victim);
      evicted.push(victim);
    }
    if (evicted.length) log.debug(`[mcp] host cap: evicted ${evicted.join(", ")}`);
    return evicted;
  }

  /** Before starting a runner: stay under MAX_RUNNERS (idle hostless runners go first). */
  function makeRoom(incomingKey) {
    while (runners.size >= MAX_RUNNERS) {
      const all = [...runners.values()].filter((r) => r.key !== incomingKey && !isProtected(r.key) && !isBusy(r));
      if (!all.length) break;
      const hostless = all.filter((r) => !r.snap?.hostLive);
      const pool = hostless.length ? hostless : all;
      const victim = pickEvictionVictim(pool.map((r) => r.key), (k) => runners.get(k)?.lastUsed ?? 0);
      if (!victim) break;
      retire(victim, "evicted at the host runner cap");
    }
  }

  /** The periodic sweep (the server's host reaper calls it). Returns evicted host keys. */
  function reap(now = Date.now()) {
    const evicted = [];
    for (const [key, r] of [...runners]) {
      if (isProtected(key) || isBusy(r)) continue;
      const idle = now - r.lastUsed;
      if (idle > RUNNER_IDLE_MS) { retire(key, "idle"); if (r.snap?.hostLive) evicted.push(key); continue; }
      if (r.snap?.hostLive && idle > HOST_IDLE_MS) { evict(key); evicted.push(key); }
    }
    return evicted;
  }

  // A child whose event loop has stopped answering while a call runs is
  // wedged (a cart spinning inside one frame). Kill it so the session gets an
  // answer and its next call a fresh host.
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const r of runners.values()) {
      if (r.retiring || r.wedged) continue;
      if (isBusy(r) && now - r.lastHeartbeat > WEDGE_MS) {
        r.wedged = [...r.pending.values()].find((p) => p.kind === "call");
        try { r.child.kill("SIGKILL"); } catch { /* gone */ }
      }
    }
    // livestream watchers decide how often children rasterize frames for it
    const n = observer.listenerCount("event");
    if (n !== listeners) { listeners = n; for (const r of runners.values()) send(r, { t: "observerListeners", n }); }
  }, 2000);
  watchdog.unref?.();

  function shadow(key) {
    const r = runners.get(key);
    if (!r?.snap?.hostLive) return null;
    const status = { loaded: !!r.snap.loaded, platform: r.snap.platform ?? null, mediaPath: r.snap.mediaPath ?? null };
    return { status, remote: true, getStatus: () => ({ ...status }) };
  }

  return {
    call,
    sessionStatus,
    retire,
    isProtected,
    /** Pids of every runner (for GPU and memory totals). */
    pids: () => [...runners.values()].map((r) => r.pid).filter(Boolean),
    crashes: () => crashes.slice(),
    timingStatus() {
      for (const r of runners.values()) if (r.timingSince) return { session: r.key, sinceMs: Date.now() - r.timingSince, callsWaiting: 0, isolation: "process" };
      return null;
    },
    /** Per-runner rows for catalog status. */
    info() {
      const now = Date.now();
      return [...runners.values()].map((r) => ({
        session: r.key, pid: r.pid, rssMb: rssMbOf(r.pid),
        hostLive: !!r.snap?.hostLive, ...(r.snap?.platform ? { platform: r.snap.platform } : {}),
        ...(r.snap?.gpuApi ? { gpuApi: r.snap.gpuApi } : {}),
        playtestWindowOpen: !!r.snap?.playtestOpen,
        busy: busyCalls(r), idleSeconds: Math.round((now - r.lastUsed) / 1000),
        ...(r.lastCall ? { lastCall: r.lastCall } : {}),
      }));
    },
    openPlaytestWindows: () => [...runners.values()].filter((r) => r.snap?.playtestOpen).length,
    /** The view state.js serves to the front process (see setRemoteHostView). */
    view: {
      getHostOrNull: (key) => { const s = shadow(key); if (s) { const r = runners.get(key); if (r) r.lastUsed = Date.now(); } return s; },
      peekSession(key) {
        const r = runners.get(key);
        const lm = getLastMedia(key);
        return {
          hostLive: !!r?.snap?.hostLive,
          loaded: !!r?.snap?.loaded,
          platform: r?.snap?.platform ?? lm?.platform,
          path: r?.snap?.mediaPath ?? lm?.path,
          idleSeconds: r ? Math.round((Date.now() - r.lastUsed) / 1000) : null,
        };
      },
      otherLiveHosts,
      hostLifetimeStats: () => ({
        liveHosts: hostKeys().length,
        liveHostsSlotB: [...runners.values()].filter((r) => r.snap?.hostBLive).length,
        maxHosts: MAX_HOSTS,
        hostIdleMs: HOST_IDLE_MS,
        hostIsolation: "process",
        hostRunners: runners.size,
        maxHostRunners: MAX_RUNNERS,
      }),
      reapIdleHosts: reap,
      clearHost: (key) => retire(key, "session ended"),
      liveHostCount: () => hostKeys().length + [...runners.values()].filter((r) => r.snap?.hostBLive).length,
    },
    /** Shut every runner down (server shutdown). Resolves when they exit or after `ms`. */
    async shutdownAll(ms = 3000) {
      const all = [...runners.values()];
      const exits = all.map((r) => new Promise((res) => { if (r.child.exitCode != null || r.child.signalCode) res(); else r.child.once("exit", res); }));
      for (const r of all) retire(r.key, "server shutdown");
      await Promise.race([Promise.all(exits), new Promise((res) => setTimeout(res, ms))]);
    },
    /** Synchronous last resort on process exit. */
    killAll() { for (const r of runners.values()) { try { r.child.kill("SIGKILL"); } catch { /* gone */ } } },
  };
}

/**
 * Route a server's tool registrations to the runner pool: every handler a
 * tool module registers is replaced by one that runs the call in the
 * session's host runner. Install it AFTER installObserverMiddleware and BEFORE
 * registerTools (registerTools adds withClearToolErrors on top), so the
 * observer, the exclusive gate and argument validation stay in the front and
 * only the handler body moves. `catalog` stays local: it answers from the
 * front and asks the runner only for the session's own part.
 * @param {object} server  anything with a v1-style `.tool()`
 * @param {string} sessionKey
 * @param {ReturnType<typeof createHostRunnerPool>} pool
 */
export function installHostForwarding(server, sessionKey, pool) {
  const orig = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    if (name === "catalog") return orig(name, ...rest);
    const i = rest.findLastIndex((x) => typeof x === "function");
    if (i < 0) return orig(name, ...rest);
    const forwarded = rest.slice();
    forwarded[i] = async (args) => pool.call(sessionKey, name, args);
    return orig(name, ...forwarded);
  };
  return server;
}

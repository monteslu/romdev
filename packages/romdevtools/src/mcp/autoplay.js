// Headless real-time play: host({op:'play'}) runs a session's emulator at its
// own frame rate on the server, from ONE call, so the /livestream shows the
// game moving without an agent looping frame({op:'step'}) at it (one session
// once made ~13k step calls in a few hours doing exactly that).
//
// A play run ends on whichever comes first:
//   - its `seconds` elapse;
//   - host({op:'stop'}), or any other tool call on the same session (the
//     agent is driving again - its step / input / screenshot must not race a
//     real-time loop);
//   - the host goes away (unload, shutdown, eviction, a new loadMedia) or
//     errors while stepping.
// Frames are stepped in small batches against wall time, so a slow frame
// never builds a backlog: the run falls behind instead of spiralling.
import { getHostOrNull } from "./state.js";
import { tickForFrame } from "./active-bezel.js";
import { pushObserverFrame } from "../observer/bus.js";
import { attachObserverFrame } from "./tools/watch-memory.js";

export const PLAY_MAX_SECONDS = 600;
const TICK_MS = 50;           // timer granularity; frames per tick follow the clock
const MAX_FRAMES_PER_TICK = 6; // catch-up cap per tick

/** @type {Map<string, {host:any, timer:any, startedAt:number, endsAt:number, fps:number, frames:number, reason:string|null}>} */
const runs = new Map();

function fpsOf(host) {
  const f = Number(host?.status?.coreFps ?? host?.status?.fps);
  return Number.isFinite(f) && f > 1 && f < 1000 ? f : 60;
}

/**
 * Start a real-time run for a session. Replaces any run already going.
 * @returns {{seconds:number, fps:number, endsAt:number}}
 */
export function startPlay(sessionKey, host, { seconds }) {
  stopPlay(sessionKey, "replaced");
  const fps = fpsOf(host);
  const startedAt = Date.now();
  const run = { host, timer: null, startedAt, endsAt: startedAt + seconds * 1000, fps, frames: 0, reason: null };
  runs.set(sessionKey, run);
  const tick = async () => {
    run.timer = null;
    if (runs.get(sessionKey) !== run) return;
    const now = Date.now();
    if (now >= run.endsAt) return finish(sessionKey, run, "time");
    // Same host still installed and loaded? (getHostOrNull also keeps it from
    // being reaped as idle while it plays.)
    if (getHostOrNull(sessionKey) !== host || !host.status?.loaded) return finish(sessionKey, run, "host-gone");
    const due = Math.floor(((now - run.startedAt) / 1000) * run.fps) - run.frames;
    const n = Math.max(0, Math.min(MAX_FRAMES_PER_TICK, due));
    if (n > 0) {
      try {
        const ran = await host.stepFrames(n);
        if (runs.get(sessionKey) !== run) return;
        // A paused host steps nothing; count what was due so a resume doesn't
        // fast-forward through the paused stretch.
        run.frames += ran > 0 ? ran : n;
        if (ran > 0) tickForFrame(sessionKey, host);
      } catch (err) {
        return finish(sessionKey, run, `error: ${err?.message ?? err}`);
      }
      // Livestream: throttled per (session, tool) by the bus, like a step.
      const holder = attachObserverFrame({}, host, "play");
      const provider = holder?._observerFrameProvider;
      if (provider) pushObserverFrame({ sessionKey, tool: "host", caption: "play" }, provider);
    }
    if (due > MAX_FRAMES_PER_TICK) run.frames += due - MAX_FRAMES_PER_TICK; // fall behind, don't spiral
    if (runs.get(sessionKey) === run) {
      run.timer = setTimeout(tick, TICK_MS);
      if (run.timer.unref) run.timer.unref();
    }
  };
  run.timer = setTimeout(tick, 0);
  if (run.timer.unref) run.timer.unref();
  return { seconds, fps, endsAt: run.endsAt };
}

function finish(sessionKey, run, reason) {
  if (run.timer) { clearTimeout(run.timer); run.timer = null; }
  run.reason = reason;
  if (runs.get(sessionKey) === run) runs.delete(sessionKey);
  return summary(run);
}

function summary(run) {
  return {
    framesRun: run.frames,
    seconds: Math.round((Date.now() - run.startedAt) / 100) / 10,
    fps: run.fps,
    ...(run.reason ? { endedBy: run.reason } : {}),
  };
}

/** Stop a session's run, if any. Returns its summary or null. */
export function stopPlay(sessionKey, reason = "stop") {
  const run = runs.get(sessionKey);
  if (!run) return null;
  return finish(sessionKey, run, reason);
}

/** The session's run, for status. */
export function playStatus(sessionKey) {
  const run = runs.get(sessionKey);
  if (!run) return null;
  return { playing: true, framesRun: run.frames, fps: run.fps, secondsLeft: Math.max(0, Math.round((run.endsAt - Date.now()) / 1000)) };
}

/**
 * Every tool call passes through here first (both transports). Any call on a
 * playing session other than host play/stop ends the run, so an agent that
 * starts driving again never races the real-time loop.
 */
export function noteToolCall(sessionKey, tool, args) {
  if (!runs.size || !runs.has(sessionKey)) return;
  if (tool === "host" && (args?.op === "play" || args?.op === "stop")) return;
  // Status reads don't drive the machine.
  if (tool === "catalog") return;
  stopPlay(sessionKey, `call: ${tool}${args?.op ? `(${args.op})` : ""}`);
}

/** Stop every run (server shutdown, tests). */
export function stopAllPlay() {
  for (const key of [...runs.keys()]) stopPlay(key, "server");
}

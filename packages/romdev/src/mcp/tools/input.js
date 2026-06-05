import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";

// Resolve a platform-native button alias to the libretro button the host
// understands. Genesis pads have A/B/C (+ X/Y/Z on 6-button) which libretro
// maps onto a/b/y (+ x/.../z); the common confusion is Genesis `c`. SMS/GG
// pads label their two buttons 1/2 → libretro a/b. Pass-through otherwise.
// Exported so watchMemory/runUntilWrite's `pressDuring` resolves aliases the
// same way the standalone pressButton tool does.
export function resolveButtonAlias(button, platform) {
  // Only the platform-NATIVE aliases (c / 1 / 2) are remapped here; raw
  // libretro names (a/b/x/y) and spatial names (north/east/south/west) pass
  // through unchanged so pressButton stays consistent with setInput.
  //
  // genesis_plus_gx maps the Genesis face buttons A/B/C onto libretro y/b/a
  // respectively (verified empirically against the running core 2026-06-05),
  // so the Genesis-native button C is libretro 'a'. (Earlier this mapped
  // c→y, which actually pressed Genesis A — the inverted bug a feedback agent
  // hit when SGDK BUTTON_A wouldn't fire. Genesis A/B are libretro y/b, reached
  // via setInput({y/b}) or the spatial east/south/west names.)
  if (platform === "genesis" || platform === "megadrive" || platform === "md") {
    if (button === "c") return "a";   // Genesis C = libretro A
  }
  if (platform === "sms" || platform === "gg") {
    // genesis_plus_gx maps SMS/GG button 1 (TL) → libretro 'b' and button 2 (TR)
    // → libretro 'a' (verified empirically against the running gpgx core
    // 2026-06-05 — same a↔primary inversion as the Genesis A/B/C → y/b/a map).
    if (button === "1") return "b";   // button 1 (TL) = libretro B
    if (button === "2") return "a";   // button 2 (TR) = libretro A
  }
  // If a native alias wasn't resolved for this platform, fall back to a sane
  // default so the call doesn't silently press nothing. (Genesis C → libretro a;
  // for non-gpgx platforms 1→a/2→b is the libretro-standard order.)
  if (button === "c") return "a";
  if (button === "1") return "a";
  if (button === "2") return "b";
  return button;
}

function buttonShape(z) {
  return z
    .object({
      // D-pad
      up: z.boolean().optional(),
      down: z.boolean().optional(),
      left: z.boolean().optional(),
      right: z.boolean().optional(),
      // Cross-platform face buttons (spatial — preferred for portability)
      north: z.boolean().optional(),
      east: z.boolean().optional(),
      south: z.boolean().optional(),
      west: z.boolean().optional(),
      // Raw libretro names (also supported; spatial names are resolved to these per platform)
      a: z.boolean().optional(),
      b: z.boolean().optional(),
      x: z.boolean().optional(),
      y: z.boolean().optional(),
      l: z.boolean().optional(),
      r: z.boolean().optional(),
      l2: z.boolean().optional(),
      r2: z.boolean().optional(),
      l3: z.boolean().optional(),
      r3: z.boolean().optional(),
      start: z.boolean().optional(),
      select: z.boolean().optional(),
    })
    .describe(
      "Per-port controller state. Prefer the spatial face-button names (north/east/south/west) for cross-platform code — they map to the physical button in that compass position on each platform's controller (e.g. on NES east=A, on SNES east=A, on Genesis east=C). Raw libretro names (a/b/x/y/l/r/...) also work if you need direct control. Omitted buttons are released.",
    );
}

export function registerInputTools(server, z, sessionKey) {
  const port = buttonShape(z);

  server.tool(
    "setInput",
    "Set controller state for the next frames. State persists until changed (held buttons stay held). " +
    "Shape: { ports: [{ a: true, start: false, ... }, { ... }] }. Use getInputLayout({platform}) " +
    "to see which buttons exist on this platform (NES has no x/y, Genesis has no l/r, etc). " +
    "FACE-BUTTON NAMING: the raw libretro names (a/b/x/y) are NOT the platform's printed button labels — " +
    "e.g. on Genesis, genesis_plus_gx maps Genesis A/B/C onto libretro y/b/a, so setInput({a:true}) presses " +
    "Genesis C, and Genesis A (SGDK BUTTON_A) is setInput({y:true}). To avoid this trap, prefer the SPATIAL names " +
    "(north/east/south/west — resolved per platform) for one button, or use pressButton({button:'a'|'b'|'c'|...}) " +
    "which takes platform-native aliases. getInputLayout({platform}).faceButtons gives the exact spatial→libretro map. " +
    "Returns `requested` = the held-button state you asked for. NOTE: `requested` is what you SET, NOT proof the " +
    "emulated pad saw it — the game only reads the pad when ITS code polls, which may be a specific frame in a " +
    "state machine. If a press doesn't take (e.g. a title waiting on Start), re-apply setInput IMMEDIATELY before " +
    "the stepFrames/watchMemory that should consume it, and verify by reading the game's held-buttons RAM byte " +
    "(or that the expected state transition happened) — not by this echo.",
    {
      ports: z.array(port).min(1).max(2).describe(
        "Per-port input. Index 0 = port 0, index 1 = port 1. " +
        "Example: [{ a: true, right: true }] holds A+Right on port 0."
      ),
    },
    safeTool(async ({ ports }) => {
      getHost(sessionKey).setInput({ ports });
      // Echo the REQUESTED held state (the buttons set true), per port. This is
      // what was set, NOT a guarantee the emulated pad saw it — see description.
      const requested = ports.map((p) => Object.keys(p).filter((k) => p[k] === true));
      return jsonContent({ inputSet: true, requested });
    }),
  );

  server.tool(
    "pressButton",
    "Convenience: press a single named button for N frames then release. Drives a single port (default port 0). " +
    "The SIMPLEST way to press one platform-native button — prefer it over hand-mapping a libretro name in setInput. " +
    "Accepts platform-native aliases resolved from the loaded platform: Genesis `c` → libretro `a` (genesis_plus_gx maps Genesis A/B/C onto libretro y/b/a — so Genesis A is libretro `y`, B is `b`, C is `a`; NOTE libretro `a` is Genesis C, not A); SMS/GG `1`/`2` → libretro `b`/`a` (same gpgx inversion — button 1/TL is libretro `b`). " +
    "Spatial names also work and are unambiguous (east/south/west). Use getInputLayout({platform}).faceButtons for the exact map.",
    {
      button: z.enum([
        "up", "down", "left", "right",
        "north", "east", "south", "west",
        "a", "b", "x", "y",
        "l", "r", "l2", "r2", "l3", "r3",
        "start", "select",
        // platform-native aliases (resolved per loaded platform below)
        "c", "1", "2",
      ]),
      frames: z.number().int().min(1).max(600).default(2).describe("How many frames to hold the button."),
      port: z.number().int().min(0).max(1).default(0),
    },
    safeTool(async ({ button, frames, port: p }) => {
      const host = getHost(sessionKey);
      const resolved = resolveButtonAlias(button, host.status.platform);
      const pressed = { ports: [{}, {}] };
      pressed.ports[p][resolved] = true;
      host.setInput(pressed);
      host.stepFrames(frames);
      // Release.
      host.setInput({ ports: [{}, {}] });
      host.stepFrames(1);
      return jsonContent({
        button,
        ...(resolved !== button ? { resolvedTo: resolved } : {}),
        // `frames` = held frames (matches the requested arg + its documented
        // default). The press also advances ONE extra frame to register the
        // release, so the total frames stepped is `frames + 1` — reported
        // separately so the held count matches what the caller asked for.
        frames,
        releaseFrames: 1,
        framesStepped: frames + 1,
        frameCount: host.status.frameCount,
      });
    }),
  );

  server.tool(
    "inputSequence",
    "Run a scripted sequence of frame-by-frame inputs. Each entry: { input, frames }. Useful for replays and automated tests. " +
    "For MENUS, prefer `navigate` — it advances on screen-change and tells you which presses landed, instead of fixed frame waits that drift with non-deterministic attract timing. " +
    "For a long/flaky path, reach a screen once then saveState({path}) and loadState to retry deterministically.",
    {
      steps: z.array(
        z.object({
          input: z
            .object({
              ports: z.array(buttonShape(z)).min(1).max(2),
            })
            .describe("Input state to set for this step."),
          frames: z.number().int().min(1).max(10000).default(1),
        }),
      ).min(1).max(1000),
    },
    safeTool(async ({ steps }) => {
      const host = getHost(sessionKey);
      let total = 0;
      for (const step of steps) {
        host.setInput(step.input);
        host.stepFrames(step.frames);
        total += step.frames;
      }
      return jsonContent({
        stepsRun: steps.length,
        framesRun: total,
        frameCount: host.status.frameCount,
      });
    }),
  );

  server.tool(
    "navigate",
    "Drive menus FAST by advancing on SCREEN CHANGE instead of guessing frame counts. Each step presses a button " +
    "(single port 0), releases it, then steps frames UNTIL the framebuffer changes (or maxWaitFrames is hit) — and " +
    "reports per step whether the press was actually CONSUMED (did the screen react). This is the fix for the " +
    "'menus are a slow, flaky 3-call loop and presses get silently dropped' problem: one call walks a whole menu " +
    "path and tells you exactly which presses landed. " +
    "Each step: { button, holdFrames=2, maxWaitFrames=120, settleFrames=2 }. After the press it waits for the " +
    "screen to change (transition/animation), then `settleFrames` more so the next read is stable. " +
    "`consumed:false` on a step means the screen never changed — the game didn't react (wrong screen, press " +
    "dropped, or it only polls on a specific frame); re-run that step or hold longer. " +
    "Accepts the same native aliases as pressButton (Genesis c→y, SMS/GG 1/2→a/b). " +
    "TIP for flaky paths: reach a known screen once, saveState({path}), then loadState to retry the next leg " +
    "deterministically instead of re-driving the whole attract sequence.",
    {
      steps: z.array(
        z.object({
          button: z.enum([
            "up", "down", "left", "right",
            "north", "east", "south", "west",
            "a", "b", "x", "y",
            "l", "r", "l2", "r2", "l3", "r3",
            "start", "select",
            "c", "1", "2",
          ]).describe("Button to press for this step (single port 0)."),
          holdFrames: z.number().int().min(1).max(60).default(2).describe("Frames to hold the button before release (default 2)."),
          maxWaitFrames: z.number().int().min(1).max(1200).default(120).describe("After release, wait at MOST this many frames for the screen to change (default 120 ≈ 2s). If it never changes, the step reports consumed:false."),
          settleFrames: z.number().int().min(0).max(60).default(2).describe("Extra frames to step once the screen HAS changed, to let the transition/animation settle before the next step (default 2)."),
        }),
      ).min(1).max(64),
    },
    safeTool(async ({ steps }) => {
      const host = getHost(sessionKey);
      const platform = host.status.platform;
      const results = [];
      let totalFrames = 0;
      for (const step of steps) {
        const resolved = resolveButtonAlias(step.button, platform);
        const before = host.framebufferHash();
        // Press + hold.
        const pressed = { ports: [{}, {}] };
        pressed.ports[0][resolved] = true;
        host.setInput(pressed);
        host.stepFrames(step.holdFrames);
        totalFrames += step.holdFrames;
        // Release, then wait for the screen to react.
        host.setInput({ ports: [{}, {}] });
        host.stepFrames(1);
        totalFrames += 1;
        let waited = 0, consumed = false;
        for (let i = 0; i < step.maxWaitFrames; i++) {
          host.stepFrames(1);
          waited++; totalFrames++;
          if (host.framebufferHash() !== before) { consumed = true; break; }
        }
        if (consumed && step.settleFrames) {
          host.stepFrames(step.settleFrames);
          totalFrames += step.settleFrames;
        }
        results.push({
          button: step.button,
          ...(resolved !== step.button ? { resolvedTo: resolved } : {}),
          consumed,
          framesWaited: waited,
        });
      }
      const dropped = results.filter((r) => !r.consumed).length;
      return jsonContent({
        steps: results,
        framesRun: totalFrames,
        frameCount: host.status.frameCount,
        ...(dropped ? { droppedPresses: dropped, note: `${dropped} step(s) had consumed:false — the screen never changed after the press (wrong screen / press dropped / game polls input on a specific frame). Re-run those steps, increase holdFrames, or reach the screen via saveState/loadState.` } : {}),
      });
    }),
  );
}

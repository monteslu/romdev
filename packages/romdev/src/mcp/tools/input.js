import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { getInputLayoutCore } from "./input-layout.js";

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

// ── *Core functions for the `input` tool ──

/** op:'set' — set held controller state (persists until changed). */
function inputSetCore({ ports }, sessionKey) {
      getHost(sessionKey).setInput({ ports });
      const requested = ports.map((p) => Object.keys(p).filter((k) => p[k] === true));
      return { inputSet: true, requested };
}

/** op:'press' — press one named button N frames then release (port 0 default). */
function inputPressCore({ button, frames = 2, port: p = 0 }, sessionKey) {
      const host = getHost(sessionKey);
      const resolved = resolveButtonAlias(button, host.status.platform);
      const pressed = { ports: [{}, {}] };
      pressed.ports[p][resolved] = true;
      host.setInput(pressed);
      host.stepFrames(frames);
      host.setInput({ ports: [{}, {}] });
      host.stepFrames(1);
      return {
        button,
        ...(resolved !== button ? { resolvedTo: resolved } : {}),
        frames,
        releaseFrames: 1,
        framesStepped: frames + 1,
        frameCount: host.status.frameCount,
      };
}

/** op:'sequence' — scripted frame-by-frame inputs (ports shape per step). */
function inputSequenceCore({ steps }, sessionKey) {
      const host = getHost(sessionKey);
      let total = 0;
      for (const step of steps) {
        host.setInput(step.input);
        host.stepFrames(step.frames);
        total += step.frames;
      }
      return { stepsRun: steps.length, framesRun: total, frameCount: host.status.frameCount };
}

/** op:'navigate' — drive menus by advancing on SCREEN CHANGE; reports consumed per step. */
function inputNavigateCore({ steps }, sessionKey) {
      const host = getHost(sessionKey);
      const platform = host.status.platform;
      const results = [];
      let totalFrames = 0;
      for (const step of steps) {
        const resolved = resolveButtonAlias(step.button, platform);
        const before = host.framebufferHash();
        const pressed = { ports: [{}, {}] };
        pressed.ports[0][resolved] = true;
        host.setInput(pressed);
        host.stepFrames(step.holdFrames);
        totalFrames += step.holdFrames;
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
      return {
        steps: results,
        framesRun: totalFrames,
        frameCount: host.status.frameCount,
        ...(dropped ? { droppedPresses: dropped, note: `${dropped} step(s) had consumed:false — the screen never changed after the press (wrong screen / press dropped / game polls input on a specific frame). Re-run those steps, increase holdFrames, or reach the screen via state save/load.` } : {}),
      };
}

const BUTTON_ENUM = [
  "up", "down", "left", "right",
  "north", "east", "south", "west",
  "a", "b", "x", "y",
  "l", "r", "l2", "r2", "l3", "r3",
  "start", "select",
  "c", "1", "2",
];

export function registerInputTools(server, z, sessionKey) {
  const port = buttonShape(z);
  server.tool(
    "input",
    "Drive the controller — set/hold buttons, press one, run a scripted sequence, or walk a menu by screen-change. " +
    "`op`: 'set' | 'press' | 'sequence' | 'navigate' | 'layout'.\n" +
    "'set': hold controller state (persists until changed) via `ports:[{a:true,...},{...}]`.\n" +
    "'press': press one named `button` for `frames` then release (port 0 default) — the simplest single press.\n" +
    "'sequence': scripted frame-by-frame `steps:[{input:{ports}, frames}]` for replays/tests.\n" +
    "'navigate': walk a menu FAST by advancing on SCREEN CHANGE — `steps:[{button, holdFrames, maxWaitFrames, " +
    "settleFrames}]`; reports `consumed` per step (false = the screen never reacted: wrong screen / press dropped / " +
    "game polls on a specific frame). The fix for slow flaky menu loops.\n" +
    "'layout': the platform's input register format + which buttons physically exist (call BEFORE writing input " +
    "code or choosing controls).\n" +
    "FACE-BUTTON TRAP: raw libretro names (a/b/x/y) are NOT the printed labels — Genesis maps A/B/C onto libretro " +
    "y/b/a, so set({a:true}) presses Genesis C and Genesis A is {y:true}. Prefer SPATIAL names (north/east/south/" +
    "west) or press/navigate's native aliases (Genesis c→a-internally, SMS/GG 1/2→b/a). layout.faceButtons has the " +
    "exact map. NOTE on 'set': `requested` is what you SET, NOT proof the pad saw it — the game only reads input " +
    "when ITS code polls; re-apply immediately before the consuming stepFrames and verify via the held-buttons RAM " +
    "byte, not this echo.",
    {
      op: z.enum(["set", "press", "sequence", "navigate", "layout"]).describe("set/hold buttons; press one button; run a sequence; navigate a menu; or get the input layout."),
      // set
      ports: z.array(port).min(1).max(2).optional().describe("op=set: per-port input. [{a:true,right:true}] holds A+Right on port 0."),
      // press
      button: z.enum(BUTTON_ENUM).optional().describe("op=press: button to press (native aliases + spatial names accepted)."),
      frames: z.number().int().min(1).max(600).default(2).describe("op=press: frames to hold the button."),
      port: z.number().int().min(0).max(1).default(0).describe("op=press: which port (default 0)."),
      // sequence
      steps: z.array(z.any()).optional().describe("op=sequence: [{input:{ports:[...]}, frames}]. op=navigate: [{button, holdFrames?, maxWaitFrames?, settleFrames?}]. (Two distinct step shapes by op.)"),
      // layout
      platform: z.string().optional().describe("op=layout: platform id (nes, gb, snes, genesis, ...)."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "set": {
          if (!args.ports) throw new Error("input({op:'set'}): `ports` is required.");
          return jsonContent(inputSetCore(args, sessionKey));
        }
        case "press": {
          if (!args.button) throw new Error("input({op:'press'}): `button` is required.");
          return jsonContent(inputPressCore(args, sessionKey));
        }
        case "sequence": {
          if (!args.steps) throw new Error("input({op:'sequence'}): `steps` is required.");
          return jsonContent(inputSequenceCore(args, sessionKey));
        }
        case "navigate": {
          if (!args.steps) throw new Error("input({op:'navigate'}): `steps` is required.");
          // Fill per-step defaults the old navigate schema provided.
          const steps = args.steps.map((s) => ({ holdFrames: 2, maxWaitFrames: 120, settleFrames: 2, ...s }));
          return jsonContent(inputNavigateCore({ steps }, sessionKey));
        }
        case "layout": {
          if (!args.platform) throw new Error("input({op:'layout'}): `platform` is required.");
          return jsonContent(getInputLayoutCore(args));
        }
        default: throw new Error(`input: unknown op '${args.op}'`);
      }
    }),
  );
}


import { getHost } from "../state.js";
import { jsonContent, safeTool, textContent } from "../util.js";

// Resolve a platform-native button alias to the libretro button the host
// understands. Genesis pads have A/B/C (+ X/Y/Z on 6-button) which libretro
// maps onto a/b/y (+ x/.../z); the common confusion is Genesis `c`. SMS/GG
// pads label their two buttons 1/2 → libretro a/b. Pass-through otherwise.
// Exported so watchMemory/runUntilWrite's `pressDuring` resolves aliases the
// same way the standalone pressButton tool does.
export function resolveButtonAlias(button, platform) {
  if (platform === "genesis" || platform === "megadrive" || platform === "md") {
    if (button === "c") return "y";   // Genesis C = libretro Y
  }
  if (platform === "sms" || platform === "gg") {
    if (button === "1") return "a";
    if (button === "2") return "b";
  }
  // If a native alias wasn't resolved for this platform, fall back to a sane
  // default so the call doesn't silently press nothing: c→y, 1→a, 2→b.
  if (button === "c") return "y";
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
    "to see which buttons exist on this platform (NES has no x/y, Genesis has no l/r, etc).",
    {
      ports: z.array(port).min(1).max(2).describe(
        "Per-port input. Index 0 = port 0, index 1 = port 1. " +
        "Example: [{ a: true, right: true }] holds A+Right on port 0."
      ),
    },
    safeTool(async ({ ports }) => {
      getHost(sessionKey).setInput({ ports });
      return textContent("input set");
    }),
  );

  server.tool(
    "pressButton",
    "Convenience: press a single named button for N frames then release. Drives a single port (default port 0). " +
    "Accepts platform-native button aliases: Genesis `c` → libretro `y` (Genesis A/B/C map to libretro a/b/y); SMS/GG `1`/`2` → `a`/`b`. The alias is resolved from the loaded platform.",
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
    "Run a scripted sequence of frame-by-frame inputs. Each entry: { input, frames }. Useful for replays and automated tests.",
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
}

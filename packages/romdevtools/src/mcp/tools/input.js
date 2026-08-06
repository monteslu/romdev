import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { getInputLayoutCore } from "./input-layout.js";
import { humanCoDriveWarning } from "./playtest.js";
import { attachObserverFrame } from "./watch-memory.js";

// Spreadable co-drive conflict marker for every input-driving op: while a
// human is actively playing in this session's playtest window, their input
// overwrites the agent's each tick — so the agent must be TOLD its press/set
// may not take. Empty (no field) when there's no conflict.
function coDriveFields(sessionKey) {
  const warning = humanCoDriveWarning(sessionKey);
  return warning ? { humanCoDriveWarning: warning } : {};
}

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
      // Raw analog channel — additive to the digital buttons above.
      axes: z.object({
        lx: z.number().optional(), ly: z.number().optional(),
        rx: z.number().optional(), ry: z.number().optional(),
        lt: z.number().optional(), rt: z.number().optional(),
      }).optional().describe(
        "Raw analog state: sticks lx/ly/rx/ry in -1..1, triggers lt/rt in 0..1. "
        + "Additive — the digital buttons stay the game-facing mask; axes feed the "
        + "libretro ANALOG device (real stick deflection on N64) and an Active "
        + "Bezel's ab.input analog reads.",
      ),
    })
    // passthrough (not the zod default of stripping) so a TYPO'd button name
    // ({jump:true}, {aa:true}) survives into the handler and can be reported as
    // ignored — instead of being silently dropped, leaving the agent believing
    // it pressed something it didn't.
    .passthrough()
    .describe(
      "Per-port controller state, POSITIONAL: ports[N] IS port N, so holding A on port 1 is ports:[{}, {a:true}] — there is no 'port' key. Each button is its own boolean key ({a:true, b:true}), NOT a list ({buttons:['a','b']} is rejected). Prefer the spatial face-button names (north/east/south/west) for cross-platform code — they map to the physical button in that compass position on each platform's controller (e.g. on NES east=A, on SNES east=A, on Genesis east=C). Raw libretro names (a/b/x/y/l/r/...) also work if you need direct control. Omitted buttons are released. A malformed port object is REJECTED rather than partially applied: a press that silently doesn't happen would turn into a false negative about the game.",
    );
}

// Every button key portInputToMask + the spatial resolver actually honor.
// Anything else in a `ports` object is a typo and gets reported, not pressed.
const KNOWN_BUTTONS = new Set([
  "up", "down", "left", "right",
  "north", "east", "south", "west",
  "a", "b", "x", "y", "l", "r", "l2", "r2", "l3", "r3", "start", "select",
]);

// ── *Core functions for the `input` tool ──

/** op:'set' — set held controller state (persists until changed). */
function inputSetCore({ ports }, sessionKey) {
      // REJECT a malformed port object before touching the host.
      //
      // This used to only warn, and only on keys whose value was literally
      // `true` — so {port:0, buttons:['a','b']} (a plausible-looking shape, and
      // a real report) slipped past the check AND the `requested` filter, and
      // came back {inputSet:true, requested:[[]]}: accepted, nothing pressed.
      //
      // A silent no-op here is the most expensive wrong answer this tool can
      // give, because it poisons NEGATIVE results downstream: a button-gated
      // branch that "never fires" when the button was never actually held reads
      // as a finding about the game. Every other tool rejects unknown keys
      // loudly; this one has the most to lose by not doing so.
      //
      // Ports are positional (index = port number), so `port` is not a key
      // either — {port:1, a:true} means "port 0, with a stray key", never port 1.
      const problems = [];
      const AXIS_KEYS = new Set(["lx", "ly", "rx", "ry", "lt", "rt"]);
      ports.forEach((p, port) => {
        for (const k of Object.keys(p)) {
          // `axes` is the raw analog channel ({lx,ly,rx,ry,lt,rt}: sticks
          // -1..1, triggers 0..1) — additive to the digital buttons, read by
          // the ANALOG device and Active Bezel input. Validated here, applied
          // by setInput below alongside the mask.
          if (k === "axes") {
            if (typeof p[k] !== "object" || p[k] === null || Array.isArray(p[k])) {
              problems.push(`port ${port}: 'axes' must be an object like {lx:0.5, rt:1}.`);
              continue;
            }
            for (const [ak, av] of Object.entries(p[k])) {
              if (!AXIS_KEYS.has(ak)) problems.push(`port ${port}: unknown axis '${ak}' (valid: lx, ly, rx, ry, lt, rt).`);
              else if (typeof av !== "number" || !Number.isFinite(av)) problems.push(`port ${port}: axis '${ak}' must be a finite number.`);
            }
            continue;
          }
          if (!KNOWN_BUTTONS.has(k)) {
            problems.push(
              k === "port"
                ? `port ${port}: 'port' is not a button — ports are positional, so ports[N] IS port N. Pass buttons directly: ports:[{}, {a:true}] holds A on port 1.`
                : k === "buttons"
                  ? `port ${port}: 'buttons' is not a valid key — buttons are individual boolean keys, not a list. Use {a:true, b:true}, not {buttons:['a','b']}.`
                  : `port ${port}: unknown button '${k}'.`,
            );
          } else if (typeof p[k] !== "boolean") {
            problems.push(`port ${port}: button '${k}' must be true or false, got ${Array.isArray(p[k]) ? "an array" : typeof p[k]}.`);
          }
        }
      });
      if (problems.length) {
        throw new Error(
          `input({op:'set'}): ${problems.join(" ")} Valid buttons: ${[...KNOWN_BUTTONS].join(", ")}. ` +
          "Rejected rather than partially applied — a press that silently doesn't happen turns into a false negative about the game.",
        );
      }
      getHost(sessionKey).setInput({ ports });
      const requested = ports.map((p) => Object.keys(p).filter((k) => p[k] === true && KNOWN_BUTTONS.has(k)));
      return {
        inputSet: true,
        requested,
        ...coDriveFields(sessionKey),
      };
}

/** op:'press' — press one named button N frames then release (port 0 default). */
function inputPressCore({ button, frames = 2, port: p = 0 }, sessionKey) {
      const host = getHost(sessionKey);
      const resolved = resolveButtonAlias(button, host.status.platform);
      // GUARANTEE a released->pressed EDGE. If the button is already held
      // (a prior input({op:'set'}) or an overlapping schedule), the game's
      // newpress detector never fires and the press silently does nothing —
      // the "one-shot press didn't pause the game" report (0.27.0 #7).
      // One released frame first makes the edge unconditional.
      host.setInput({ ports: [{}, {}] });
      host.stepFrames(1);
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
        preReleaseFrames: 1,
        framesStepped: frames + 2,
        frameCount: host.status.frameCount,
        ...coDriveFields(sessionKey),
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
      return { stepsRun: steps.length, framesRun: total, frameCount: host.status.frameCount, ...coDriveFields(sessionKey) };
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
        ...coDriveFields(sessionKey),
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
    "Drive the controller. `op`: 'set' | 'press' | 'sequence' | 'navigate' | 'layout'.\n" +
    "'set': hold controller state (persists until changed) via `ports:[{a:true,...},{...}]`. " +
    "The held state is honored by frame({op:'step'}) AND by watch/breakpoint runs that have NO `pressDuring` " +
    "schedule (they inherit it). If a watch/breakpoint IS given `pressDuring`, that schedule OWNS the pad for " +
    "the run and this set state is ignored — so drive a watched window with `pressDuring`, not a prior `set`.\n" +
    "'press': press one named `button` for `frames` then release (port 0 default). Runs ONE released frame " +
    "first so edge-triggered handlers (START pause, menu confirm) always see a fresh newpress even if the " +
    "button was already held by a prior set.\n" +
    "'sequence': scripted frame-by-frame `steps:[{input:{ports}, frames}]` for replays/tests.\n" +
    "'navigate': walk a menu by advancing on SCREEN CHANGE — `steps:[{button, holdFrames?, maxWaitFrames?, " +
    "settleFrames?}]`; reports `consumed` per step (false = the screen never reacted: wrong screen / press dropped / " +
    "game polls on a specific frame).\n" +
    "'layout': the platform's input register format + which buttons physically exist (call BEFORE writing input " +
    "code or choosing controls).\n" +
    "FACE-BUTTON TRAP: raw libretro names (a/b/x/y) are NOT the printed labels — Genesis maps A/B/C onto libretro " +
    "y/b/a, so set({a:true}) presses Genesis C and Genesis A is {y:true}. Prefer SPATIAL names (north/east/south/" +
    "west) or press/navigate's native aliases (Genesis c→a internally, SMS/GG 1/2→b/a). layout.faceButtons has the " +
    "exact map. NOTE on 'set': `requested` is what you SET, NOT proof the pad saw it — the game only reads input " +
    "when ITS code polls; re-apply immediately before the consuming stepFrames and verify via the held-buttons RAM " +
    "byte, not this echo.",
    {
      op: z.enum(["set", "press", "sequence", "navigate", "layout", "pressKey", "typeText", "joyport", "pointer"]).describe("set/hold buttons; press one button; run a sequence; navigate a menu; get the input layout. WASMCART: pointer (absolute mouse/touch — position the cursor at an exact {x,y} and click; for carts that declare FLAG_POINTER). C64-ONLY: pressKey/typeText/joyport."),
      // pointer (wasmcart absolute cursor)
      x: z.number().int().optional().describe("op=pointer: cursor X in cart pixels."),
      y: z.number().int().optional().describe("op=pointer: cursor Y in cart pixels."),
      left: z.boolean().optional().describe("op=pointer: hold the left/primary mouse button."),
      right: z.boolean().optional().describe("op=pointer: hold the right/secondary mouse button."),
      id: z.number().int().min(0).max(9).optional().describe("op=pointer: which pointer SLOT (wasmcart's wc_pointer_t[10]). 0 = MOUSE (default). 1-9 = TOUCH FINGERS — what an Android/tablet host fills in. Use 1+ to test the commonest portability trap: a cart that polls only pointer[0] works perfectly with a desktop mouse and silently ignores every touch on a phone. Multi-finger gestures (pinch, two-finger drag) = several slots active at once."),
      active: z.boolean().optional().describe("op=pointer: false RELEASES this slot (finger lifted / cursor gone). Default true. For a touch slot, set active:false to end the contact — that is what a real host does on touchend."),
      // set
      ports: z.array(port).min(1).max(2).optional().describe("op=set: per-port input. [{a:true,right:true}] holds A+Right on port 0."),
      // press
      button: z.enum(BUTTON_ENUM).optional().describe("op=press: button to press (native aliases + spatial names accepted)."),
      frames: z.number().int().min(1).max(600).default(2).describe("op=press: frames to hold the button. op=pressKey: frames to hold the C64 key (default 4)."),
      port: z.number().int().min(0).max(1).default(0).describe("op=press: which port (default 0)."),
      // sequence
      steps: z.array(z.any()).optional().describe("op=sequence: [{input:{ports:[...]}, frames}]. op=navigate: [{button, holdFrames?, maxWaitFrames?, settleFrames?}]. (Two distinct step shapes by op.)"),
      // layout
      platform: z.string().optional().describe("op=layout: platform id (nes, gb, snes, genesis, ...)."),
      // C64 keyboard
      key: z.string().optional().describe("op=pressKey (C64): key name — f1/f3/f5/f7, return, space, run/stop, a-z, 0-9, ctrl, cbm, home, down, right, lshift, rshift."),
      text: z.string().optional().describe("op=typeText (C64): string fed into the keyboard buffer; \\r / \\n become RETURN. e.g. 'LOAD\"*\",8,1\\rRUN\\r'."),
      joyport: z.number().int().min(1).max(2).optional().describe("op=joyport (C64): set the active joystick port (1 or 2). Omit to just GET the current port. Default is 2 (most C64 games)."),
      verify: z.boolean().default(false).describe("op=pressKey (C64): also sample CIA1 $DC00/$DC01 (the keyboard/joystick scan ports the KERNAL reads) BEFORE / DURING (key held) / AFTER, plus matrix coords + active joyport. Use to tell apart 'my key never reached VICE' (before==during) from 'VICE saw it but the game ignored it' (they differ but no reaction) when a C64 game doesn't respond to a key."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "set": {
          if (!args.ports) throw new Error("input({op:'set'}): `ports` is required.");
          return attachObserverFrame(jsonContent(inputSetCore(args, sessionKey)), getHost(sessionKey), "input set");
        }
        case "pointer": {
          const host = getHost(sessionKey);
          if (typeof host?.setInput !== "function") throw new Error("input({op:'pointer'}): no host loaded.");
          if (args.x == null || args.y == null) throw new Error("input({op:'pointer'}): `x` and `y` are required.");
          /* `id` selects the pointer SLOT: 0 = mouse (default, unchanged), 1-9
           * = touch fingers. Without it romdev could only simulate a mouse, so
           * the commonest portability trap -- a cart polling only pointer[0],
           * which works on desktop and ignores every touch on Android -- was
           * untestable. `active:false` releases a finger. */
          const id = args.id == null ? 0 : args.id | 0;
          if (id < 0 || id > 9) {
            throw new Error(`input({op:'pointer'}): \`id\` must be 0-9 (0 = mouse, 1-9 = touch fingers), got ${args.id}.`);
          }
          const active = args.active === false ? false : true;
          host.setInput({ pointer: { id, x: args.x, y: args.y, left: !!args.left, right: !!args.right, active } });
          return attachObserverFrame(
            jsonContent({ pointer: { id, x: args.x, y: args.y, left: !!args.left, right: !!args.right, active } }),
            host,
            `pointer${id ? ` #${id}` : ""} ${args.x},${args.y}`,
          );
        }
        case "press": {
          if (!args.button) throw new Error("input({op:'press'}): `button` is required.");
          return attachObserverFrame(jsonContent(inputPressCore(args, sessionKey)), getHost(sessionKey), `press ${args.button}`);
        }
        case "sequence": {
          if (!args.steps) throw new Error("input({op:'sequence'}): `steps` is required.");
          return attachObserverFrame(jsonContent(inputSequenceCore(args, sessionKey)), getHost(sessionKey), "input sequence");
        }
        case "navigate": {
          if (!args.steps) throw new Error("input({op:'navigate'}): `steps` is required.");
          // Fill per-step defaults the old navigate schema provided.
          const steps = args.steps.map((s) => ({ holdFrames: 2, maxWaitFrames: 120, settleFrames: 2, ...s }));
          return attachObserverFrame(jsonContent(inputNavigateCore({ steps }, sessionKey)), getHost(sessionKey), "navigate");
        }
        case "layout": {
          if (!args.platform) throw new Error("input({op:'layout'}): `platform` is required.");
          return jsonContent(getInputLayoutCore(args));
        }
        case "pressKey": {
          if (!args.key) throw new Error("input({op:'pressKey'}): `key` is required (C64 keyboard key, e.g. 'f1', 'return', 'run/stop').");
          const host = getHost(sessionKey);
          if (args.verify) {
            const v = host.pressC64KeyVerify(args.key, args.frames ?? 4);
            return jsonContent({ pressedKey: v.key, matrix: [v.row, v.col], frames: v.frames, joyport: v.joyport, autoReleased: v.autoReleased, cia1: v.cia1, frameCount: host.status.frameCount, note: v.note });
          }
          const r = host.pressC64Key(args.key, args.frames ?? 4);
          return jsonContent({ pressedKey: r.key, matrix: [r.row, r.col], frames: r.frames, frameCount: host.status.frameCount });
        }
        case "typeText": {
          if (typeof args.text !== "string") throw new Error("input({op:'typeText'}): `text` is required (string fed into the C64 keyboard buffer).");
          const host = getHost(sessionKey);
          const rc = host.typeC64Text(args.text);
          return jsonContent({ typed: args.text, fedResult: rc, note: "Queued into the C64 keyboard buffer — step frames so the screen editor drains it." });
        }
        case "joyport": {
          const host = getHost(sessionKey);
          if (args.joyport === undefined) {
            return jsonContent({ joyport: host.getC64JoyPort(), note: "Active C64 joystick port. Most C64 games use port 2 (the default). Pass `joyport:1` or `joyport:2` to change it." });
          }
          const set = host.setC64JoyPort(args.joyport);
          return jsonContent({ joyport: set, set: true });
        }
        default: throw new Error(`input: unknown op '${args.op}'`);
      }
    }),
  );
}


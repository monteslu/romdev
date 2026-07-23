// regression — a checkpoint-based golden harness. Host-kind-agnostic: works on
// emulators AND wasmcart carts. Two ops:
//   op:'capture' — run an input script, record observations at checkpoint frames
//                  into a golden JSON on disk.
//   op:'check'   — re-run the same script, compare observations to the golden,
//                  return {passed, diffs[]}.
//
// WHY checkpoints, not full-frame replay: for large carts (a Godot game is
// hundreds of MB to GB of heap) you can't snapshot state per frame, and full
// frame-by-frame golden replay is impractical. Instead we replay the input
// script from load (deterministic on a fixed-step host) and observe only at a
// few named checkpoint frames — a framebuffer HASH (cheap change-detector),
// and/or NAMED debug-state values (wasmcart debug ABI), and/or memory regions
// (emulators). Named-state assertions are the size-independent path: "at frame
// 600, hp == 3" costs the same whether the heap is 128 KB or 2 GB.
//
// Determinism: this is only as reproducible as the host's clock. wasmcart with
// setFixedStep and emulators are frame-deterministic for a fixed input script.
// A cart that reads wall-clock/entropy won't reproduce a frame HASH — for those
// assert on named debug values that ARE deterministic, or accept hash drift
// (the golden records which observation kinds were used).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";

const GOLDEN_VERSION = 1;

/** Apply an input script entry's ports (host-kind-agnostic setInput). */
function applyInput(host, ports) {
  if (ports && ports.length) host.setInput({ ports });
  else host.setInput({ ports: [{}, {}] });
}

/**
 * Run the input script and collect observations at each checkpoint frame.
 * Replays from the CURRENT host state (caller loaded the media fresh), stepping
 * frame-by-frame so scripted inputs land on the right frames.
 * @returns {Promise<Array<{frame, label, obs}>>}
 */
async function runCheckpoints(host, { script, checkpoints }) {
  const sorted = (script ?? []).slice().sort((a, b) => a.atFrame - b.atFrame);
  const cps = checkpoints.slice().sort((a, b) => a.frame - b.frame);
  const lastFrame = cps[cps.length - 1].frame;
  const results = [];
  let scriptIdx = 0;
  let cpIdx = 0;

  for (let frame = 0; frame <= lastFrame; frame++) {
    // Apply any input-script changes scheduled at this frame BEFORE stepping.
    while (scriptIdx < sorted.length && sorted[scriptIdx].atFrame === frame) {
      applyInput(host, sorted[scriptIdx].ports);
      scriptIdx++;
    }
    if (frame > 0) await host.stepFrames(1); // frame 0 = the loaded/settled frame
    // Capture every checkpoint scheduled at this frame.
    while (cpIdx < cps.length && cps[cpIdx].frame === frame) {
      results.push({ frame, label: cps[cpIdx].label ?? `f${frame}`, obs: captureObs(host, cps[cpIdx]) });
      cpIdx++;
    }
  }
  return results;
}

/** Capture the requested observation kinds at one checkpoint. */
function captureObs(host, cp) {
  const obs = {};
  const kinds = cp.observe ?? ["frameHash"];
  if (kinds.includes("frameHash")) {
    obs.frameHash = typeof host.framebufferHash === "function" ? host.framebufferHash() : null;
  }
  if (kinds.includes("debug") && cp.debugFields?.length) {
    obs.debug = {};
    for (const name of cp.debugFields) {
      try {
        const v = host.readDebugValue(name);
        obs.debug[name] = v.value ?? v.values ?? (v.bytes ? Buffer.from(v.bytes).toString("hex") : null);
      } catch (e) { obs.debug[name] = { error: e.message }; }
    }
  }
  if (kinds.includes("memory") && cp.memory?.length) {
    obs.memory = {};
    for (const m of cp.memory) {
      try {
        const bytes = host.readMemory(m.region, m.offset, m.length);
        obs.memory[m.label ?? `${m.region}+${m.offset}`] = Buffer.from(bytes).toString("hex");
      } catch (e) { obs.memory[m.label ?? `${m.region}+${m.offset}`] = { error: e.message }; }
    }
  }
  return obs;
}

/** Deep-compare two observation objects, returning a list of human diffs. */
function diffObs(label, frame, want, got) {
  const diffs = [];
  const push = (kind, key, w, g) => diffs.push({ frame, label, kind, key, expected: w, actual: g });
  if ("frameHash" in want) {
    if (want.frameHash !== got.frameHash) push("frameHash", "frameHash", want.frameHash, got.frameHash);
  }
  for (const bag of ["debug", "memory"]) {
    if (!want[bag]) continue;
    for (const [k, w] of Object.entries(want[bag])) {
      const g = got[bag]?.[k];
      if (JSON.stringify(w) !== JSON.stringify(g)) push(bag, k, w, g);
    }
  }
  return diffs;
}

export function registerRegressionTools(server, z, sessionKey) {
  const inputShape = z.record(z.string(), z.boolean());
  const checkpointShape = z.object({
    frame: z.number().int().min(0).describe("frame number to observe at"),
    label: z.string().optional().describe("human name for this checkpoint (e.g. 'title', 'boss')"),
    observe: z.array(z.enum(["frameHash", "debug", "memory"])).optional()
      .describe("what to record: 'frameHash' (framebuffer fingerprint — cheap, but only reproducible on a deterministic cart), 'debug' (wasmcart named debug-state values — the SIZE-INDEPENDENT, deterministic path), 'memory' (emulator regions). Default ['frameHash']."),
    debugFields: z.array(z.string()).optional().describe("observe:'debug' — the debug-state field names to record (from wasm({op:'debugState'}))."),
    memory: z.array(z.object({ label: z.string().optional(), region: z.string(), offset: z.number().int().min(0), length: z.number().int().min(1).max(256) })).optional()
      .describe("observe:'memory' — emulator regions to record."),
  });
  const scriptShape = z.array(z.object({
    atFrame: z.number().int().min(0),
    ports: z.array(inputShape).max(2).optional(),
  }));

  server.tool(
    "regression",
    "Checkpoint-based golden regression harness — prove a change didn't break a game. Host-kind-agnostic (emulators AND wasmcart). " +
    "`op:'capture'` runs an `inputScript`, records observations at `checkpoints` into a golden JSON at `goldenPath`. " +
    "`op:'check'` re-runs the SAME script and compares to the golden → {passed, diffs[]}. " +
    "REPLAYS FROM THE LOADED STATE (loadMedia fresh first) — no per-frame savestate, so it scales to any cart size. " +
    "Observations per checkpoint: 'frameHash' (framebuffer fingerprint — reproducible only on a deterministic cart), " +
    "'debug' (wasmcart NAMED debug-state values — the size-independent, deterministic path: 'at frame 600, hp==3' costs " +
    "the same at 128KB or 2GB of heap), 'memory' (emulator regions). For large / non-deterministic carts, prefer 'debug' " +
    "(or 'memory' on emulators) over 'frameHash'. Load the ROM/cart, then capture once, then check after every change.",
    {
      op: z.enum(["capture", "check"]).describe("capture = record a golden; check = compare a re-run to it."),
      goldenPath: z.string().describe("path to the golden JSON (written by capture, read by check)."),
      inputScript: scriptShape.optional().describe("[{atFrame, ports:[{right:true}]}] — inputs set at each frame, held until the next. Same for capture and check (the harness stores it in the golden; check reuses the stored one if omitted)."),
      checkpoints: z.array(checkpointShape).optional().describe("frames to observe at + what to record. Required for capture; check reuses the golden's if omitted."),
    },
    safeTool(async ({ op, goldenPath, inputScript, checkpoints }) => {
      const host = getHost(sessionKey);
      if (!host?.status?.loaded) throw new Error("regression: no media loaded — call loadMedia first (fresh, so replay starts from a known state).");

      if (op === "capture") {
        if (!checkpoints?.length) throw new Error("regression({op:'capture'}): `checkpoints` is required.");
        const observations = await runCheckpoints(host, { script: inputScript, checkpoints });
        const golden = {
          goldenVersion: GOLDEN_VERSION,
          platform: host.status.platform,
          kind: host.getCapabilities?.().kind ?? "libretro",
          inputScript: inputScript ?? [],
          checkpoints,
          observations,
        };
        await mkdir(path.dirname(goldenPath), { recursive: true });
        await writeFile(goldenPath, JSON.stringify(golden, null, 2));
        return jsonContent({
          captured: true, goldenPath, checkpoints: observations.length,
          observed: observations.map((o) => ({ frame: o.frame, label: o.label, kinds: Object.keys(o.obs) })),
          note: "golden written. Run op:'check' (same loaded cart) after each change to assert nothing drifted. For non-deterministic/large carts, checkpoints observing 'debug' named state are the reliable assertions; 'frameHash' may drift if the cart isn't frame-deterministic.",
        });
      }

      // op === 'check'
      let golden;
      try { golden = JSON.parse(await readFile(goldenPath, "utf8")); }
      catch { throw new Error(`regression({op:'check'}): couldn't read golden at '${goldenPath}' — run op:'capture' first.`); }
      const script = inputScript ?? golden.inputScript;
      const cps = checkpoints ?? golden.checkpoints;
      const observations = await runCheckpoints(host, { script, checkpoints: cps });

      // Align by frame+label and diff.
      const diffs = [];
      const byKey = new Map(golden.observations.map((o) => [`${o.frame}:${o.label}`, o]));
      for (const got of observations) {
        const want = byKey.get(`${got.frame}:${got.label}`);
        if (!want) { diffs.push({ frame: got.frame, label: got.label, kind: "missing-in-golden", message: "checkpoint not in golden" }); continue; }
        diffs.push(...diffObs(got.label, got.frame, want.obs, got.obs));
      }
      return jsonContent({
        passed: diffs.length === 0,
        checkpoints: observations.length,
        diffs,
        ...(diffs.length ? { note: "REGRESSION: a checkpoint observation changed. Each diff names the frame/checkpoint, what kind (frameHash/debug/memory), and expected-vs-actual. A frameHash diff on a non-deterministic cart may be clock drift, not a real regression — prefer 'debug' named-state checkpoints for those." }
          : { note: "all checkpoints match the golden — no regression." }),
      });
    }),
  );
}

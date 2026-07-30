// recordSession — drive the emulator for N frames, capturing inputs and
// observations at intervals. Returns a structured timeline the agent
// can analyze.
//
// Typical agent uses:
//   - Study an existing game: "play it for 600 frames with random inputs,
//     capture every 30 frames, find when the enemy appears."
//   - Smoke-test a new build: "run my game with start-then-A held for 300
//     frames, screenshot every 60, prove the title screen advances."

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";

// memorySamples regions accept the same canonical set readMemory accepts (incl.
// hardware-register regions like nes_apu_regs). The region is a runtime-validated
// string rather than an inlined ~62-value schema enum — the per-sample
// host.readMemory(region,…) lookup throws on an unknown region with a clear
// message, so the schema enum was pure deferred-load weight (0.28.0 feedback #5).
export function registerRecordTools(server, z, sessionKey) {
  const inputShape = z.object({
    up: z.boolean().optional(), down: z.boolean().optional(),
    left: z.boolean().optional(), right: z.boolean().optional(),
    a: z.boolean().optional(), b: z.boolean().optional(),
    x: z.boolean().optional(), y: z.boolean().optional(),
    start: z.boolean().optional(), select: z.boolean().optional(),
    l: z.boolean().optional(), r: z.boolean().optional(),
    l2: z.boolean().optional(), r2: z.boolean().optional(),
    l3: z.boolean().optional(), r3: z.boolean().optional(),
  });

  server.tool(
    "recordSession",
    "Run the loaded ROM for N frames, sampling screenshots and/or memory every sampleEvery frames. Returns a timeline the agent can analyze. Inputs are either held for the whole session (holdInputs) or scripted as {atFrame, ports} entries each held until the next (inputScript). " +
    "Screenshots (includeScreenshots, default true): every sampled frame ALWAYS streams to the human's /livestream (over REST or MCP, no flag needed). For the AGENT's response: pass outputDir to also write frame-<n>.png per sample (timeline gets screenshotPath), or inline:true to embed screenshotBase64 per entry (opt-in — NOT default, so image bytes don't flood your context). With neither, frames still go to /livestream and the response stays compact (just the timeline). Set includeScreenshots:false to skip capture entirely (memory-only runs). " +
    "Memory (memorySamples): accepts the full readMemory region set incl. hardware registers (nes_apu_regs, etc.); hex appears per-sample in the timeline. For dense sampling (sampleEvery:1 over a long loop, e.g. APU regs across a music loop) add memoryOutputPath to stream rows to NDJSON on disk and keep the hex OUT of context — the response returns a compact summary {path, rows, regions, valueRanges} instead.",
    {
      frames: z.number().int().min(1).max(36000).default(300).describe("Total frames to run."),
      sampleEvery: z.number().int().min(1).max(600).default(30).describe("Capture a sample (screenshot and/or memory) every N frames."),
      holdInputs: z.array(inputShape).max(2).optional(),
      inputScript: z
        .array(
          z.object({
            atFrame: z.number().int().min(0),
            ports: z.array(inputShape).max(2).optional(),
            keys: z.array(z.string()).optional().describe("C64-ONLY: C64 keyboard keys held from this frame until the next entry (f1/f3/f5/f7, return, space, run/stop, a-z, 0-9, …). [] releases all held keys. Unknown keys are rejected with a clear error. Lets you script a keyboard+joystick startup timeline (e.g. {atFrame:0,keys:['f1']},{atFrame:30,ports:[{b:true}]},{atFrame:90,keys:['run/stop']}) in one call."),
          }),
        )
        .optional()
        .describe("Per-frame input changes. Each entry sets the input at `atFrame` (joystick `ports` and/or C64 `keys`) and holds it until the next entry. Either field is optional — a step may set just keys, just ports, or both."),
      memorySamples: z
        .array(
          z.object({
            label: z.string(),
            region: z.string().describe("memory region (full readMemory set incl. hardware registers; validated at runtime)"),
            offset: z.number().int().min(0),
            length: z.number().int().min(1).max(256),
          }),
        )
        .optional()
        .describe("Memory regions to sample at each capture point. Accepts the full readMemory region set (incl. nes_apu_regs and other hardware registers). Tip: sampleEvery:1 + memoryOutputPath gives a per-frame telemetry stream (e.g. APU registers over a music loop) without flooding context with hex."),
      includeScreenshots: z.boolean().default(true).describe("If false, skip PNG capture (just memory samples)."),
      outputDir: z.string().optional().describe("OPTIONAL. If set, also write per-sample PNGs (frame-<n>.png) to this dir; the timeline gets each one's `screenshotPath`. Captured frames stream to /livestream regardless; outputDir just additionally persists them to disk for the agent."),
      inline: z.boolean().default(false).describe("OPT-IN base64. If true, embed screenshotBase64 in each timeline entry. Default false — frames go to /livestream + (if outputDir) disk, but image BYTES are NOT put in your response context unless you ask. Only set this if you genuinely need the base64 inline."),
      memoryOutputPath: z.string().optional().describe("If set, write per-sample memory to this path as newline-delimited JSON (one row per sample) and OMIT the bulky per-sample `memory` from the timeline — returns a compact summary {path, rows, regions, valueRanges} instead. Use for dense sampling (sampleEvery:1 over a long loop) so ~200KB of hex never enters context."),
    },
    safeTool(async ({ frames, sampleEvery, holdInputs, inputScript, memorySamples, includeScreenshots = true, outputDir, inline = false, memoryOutputPath }) => {
      const host = getHost(sessionKey);
      // No outputDir/inline requirement anymore: captured frames ALWAYS stream to
      // the human's /livestream (observer sideband). outputDir additionally writes
      // PNGs to disk; inline additionally embeds base64 in the RESPONSE (opt-in, so
      // we never flood agent context by default). Bare call = frames go to the
      // human, nothing bulky comes back to the agent.
      if (includeScreenshots && outputDir) {
        await mkdir(outputDir, { recursive: true });
      }
      // Frames pushed to the /livestream observer this run (every captured sample).
      const observerFrames = [];
      // Sort input script by frame.
      const script = (inputScript ?? []).slice().sort((a, b) => a.atFrame - b.atFrame);
      let scriptIdx = 0;

      // Apply initial inputs.
      if (holdInputs && holdInputs.length > 0) {
        host.setInput({ ports: holdInputs });
      }

      // When streaming memory to disk we accumulate NDJSON rows and per-label
      // value ranges instead of embedding hex in every timeline entry.
      const streamMemory = !!(memoryOutputPath && memorySamples && memorySamples.length > 0);
      const memRows = [];
      /** @type {Record<string, {min:number,max:number}>} */
      const valueRanges = {};
      const noteRange = (label, byte) => {
        const r = valueRanges[label] ?? (valueRanges[label] = { min: byte, max: byte });
        if (byte < r.min) r.min = byte;
        if (byte > r.max) r.max = byte;
      };

      const timeline = [];
      let elapsed = 0;
      while (elapsed < frames) {
        // Apply any scripted inputs whose atFrame ≤ current frame.
        while (scriptIdx < script.length && script[scriptIdx].atFrame <= elapsed) {
          const entry = script[scriptIdx];
          if (entry.ports) host.setInput({ ports: entry.ports });
          // C64 keyboard keys held from this entry until the next. Pass [] to
          // release all. Only valid on a C64/VICE host (setC64HeldKeys throws
          // otherwise — surfaced as a clear error, not a silent no-op).
          if (entry.keys !== undefined) host.setC64HeldKeys(entry.keys);
          scriptIdx++;
        }
        const batch = Math.min(sampleEvery, frames - elapsed);
        host.stepFrames(batch);
        elapsed += batch;

        const sample = {
          frame: host.status.frameCount,
          elapsed,
        };
        if (includeScreenshots) {
          try {
            const shot = host.screenshot();
            sample.framebuffer = { width: shot.width, height: shot.height };
            // ALWAYS push the frame to the human's /livestream (observer sideband),
            // independent of how the AGENT wants it returned and independent of the
            // transport (REST or MCP — both consume _observerImages). The human
            // watching does not depend on the agent passing inline/outputDir.
            observerFrames.push({ kind: "image", mimeType: "image/png", base64: shot.pngBase64 });
            // The agent's RESPONSE: a path if outputDir was given, else nothing.
            // Base64 goes into the response ONLY when explicitly inline:true — we do
            // NOT dump image bytes into context by default.
            if (outputDir) {
              const framePath = path.join(outputDir, `frame-${sample.frame}.png`);
              await writeFile(framePath, Buffer.from(shot.pngBase64, "base64"));
              sample.screenshotPath = framePath;
            }
            if (inline) {
              sample.screenshotBase64 = shot.pngBase64;
            }
          } catch (e) {
            sample.screenshotError = String(e?.message ?? e);
          }
        }
        if (memorySamples && memorySamples.length > 0) {
          const row = streamMemory ? { frame: sample.frame, elapsed } : null;
          if (!streamMemory) sample.memory = {};
          for (const m of memorySamples) {
            try {
              const bytes = host.readMemory(m.region, m.offset, m.length);
              const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
              if (streamMemory) {
                row[m.label] = hex;
                // Track the value range of the FIRST byte per label — a cheap
                // "did this counter actually move?" summary without the full log.
                noteRange(m.label, bytes[0] ?? 0);
              } else {
                sample.memory[m.label] = { hex };
              }
            } catch (e) {
              if (streamMemory) row[m.label] = null;
              else sample.memory[m.label] = { error: String(e?.message ?? e) };
            }
          }
          if (streamMemory) memRows.push(row);
        }
        timeline.push(sample);
      }

      // Attach the captured frames as a /livestream observer sideband (top-level
      // sibling of `content`, NOT inside the JSON text — same pattern as frame.js,
      // so the observer middleware forwards them and they never bloat the response
      // text). The wrapper (MCP + REST both) strips _observerImages before reply.
      const withObserver = (result) => {
        if (observerFrames.length) Object.assign(result, { _observerImages: observerFrames });
        return result;
      };

      if (streamMemory) {
        await mkdir(path.dirname(memoryOutputPath), { recursive: true });
        await writeFile(memoryOutputPath, memRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        return withObserver(jsonContent({
          framesRun: elapsed,
          samples: timeline.length,
          // Timeline retains screenshot paths + framebuffer dims but NOT the
          // bulky per-sample memory hex (that's in the NDJSON file).
          timeline,
          memory: {
            path: memoryOutputPath,
            rows: memRows.length,
            format: "ndjson",
            regions: memorySamples.map((m) => ({ label: m.label, region: m.region, offset: m.offset, length: m.length })),
            valueRanges,
            note: "Per-sample memory written to disk (one JSON object per row: {frame, elapsed, <label>:hex,...}). valueRanges shows each label's first-byte min/max so you can tell at a glance which watched bytes actually changed.",
          },
        }));
      }

      return withObserver(jsonContent({
        framesRun: elapsed,
        samples: timeline.length,
        timeline,
      }));
    }),
  );
}

// recordSession — drive the emulator for N frames, capturing inputs and
// observations at intervals. Returns a structured timeline the agent
// can analyze.
//
// Typical agent uses:
//   - Study existing games: "play Adventure for 600 frames with random inputs,
//     capture every 30 frames, find when the dragon appears."
//   - Smoke-test a new build: "run my game with start-then-A held for 300
//     frames, screenshot every 60, prove the title screen advances."

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";

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
    "Run the loaded ROM for N frames, capturing inputs and observations (screenshots + optional memory dumps) at regular intervals. Returns a timeline the agent can analyze. Inputs can either be held for the whole session or vary by a scripted list of {atFrame, ports} entries. " +
    "When includeScreenshots is true: DEFAULT writes each sample's PNG to outputDir/frame-<n>.png and puts screenshotPath in the timeline; pass inline:true to get screenshotBase64 in each entry instead (you must pass one or the other). With includeScreenshots:false, no path is needed.",
    {
      frames: z.number().int().min(1).max(36000).default(300).describe("Total frames to run."),
      sampleEvery: z.number().int().min(1).max(600).default(30).describe("Capture a screenshot every N frames."),
      holdInputs: z.array(inputShape).max(2).optional(),
      inputScript: z
        .array(
          z.object({
            atFrame: z.number().int().min(0),
            ports: z.array(inputShape).max(2),
          }),
        )
        .optional()
        .describe("Per-frame input changes. Each entry sets the input at `atFrame` and holds it until the next entry."),
      memorySamples: z
        .array(
          z.object({
            label: z.string(),
            region: z.enum(["system_ram", "save_ram", "video_ram", "rtc", "nes_nametables", "nes_palette", "nes_oam", "nes_chr"]),
            offset: z.number().int().min(0),
            length: z.number().int().min(1).max(256),
          }),
        )
        .optional()
        .describe("Memory regions to sample at each capture point."),
      includeScreenshots: z.boolean().default(true).describe("If false, skip PNG capture (just memory samples)."),
      outputDir: z.string().optional().describe("Directory to write per-sample PNGs (frame-<n>.png). Required when includeScreenshots is true unless inline:true."),
      inline: z.boolean().default(false).describe("If true, embed screenshotBase64 in each timeline entry instead of writing PNGs to disk. Default false — then outputDir is required when includeScreenshots is true."),
    },
    safeTool(async ({ frames, sampleEvery, holdInputs, inputScript, memorySamples, includeScreenshots, outputDir, inline }) => {
      const host = getHost(sessionKey);
      if (includeScreenshots && !inline && !outputDir) {
        throw new Error("recordSession: includeScreenshots is true — pass outputDir (writes frame-<n>.png per sample, returns screenshotPath) or inline:true (embeds screenshotBase64 in each entry). Or set includeScreenshots:false for memory-only sampling.");
      }
      if (includeScreenshots && !inline && outputDir) {
        await mkdir(outputDir, { recursive: true });
      }
      // Sort input script by frame.
      const script = (inputScript ?? []).slice().sort((a, b) => a.atFrame - b.atFrame);
      let scriptIdx = 0;

      // Apply initial inputs.
      if (holdInputs && holdInputs.length > 0) {
        host.setInput({ ports: holdInputs });
      }

      const timeline = [];
      let elapsed = 0;
      while (elapsed < frames) {
        // Apply any scripted inputs whose atFrame ≤ current frame.
        while (scriptIdx < script.length && script[scriptIdx].atFrame <= elapsed) {
          host.setInput({ ports: script[scriptIdx].ports });
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
            if (inline) {
              sample.screenshotBase64 = shot.pngBase64;
            } else {
              const framePath = path.join(outputDir, `frame-${sample.frame}.png`);
              await writeFile(framePath, Buffer.from(shot.pngBase64, "base64"));
              sample.screenshotPath = framePath;
            }
          } catch (e) {
            sample.screenshotError = String(e?.message ?? e);
          }
        }
        if (memorySamples && memorySamples.length > 0) {
          sample.memory = {};
          for (const m of memorySamples) {
            try {
              const bytes = host.readMemory(m.region, m.offset, m.length);
              sample.memory[m.label] = {
                hex: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
              };
            } catch (e) {
              sample.memory[m.label] = { error: String(e?.message ?? e) };
            }
          }
        }
        timeline.push(sample);
      }

      return jsonContent({
        framesRun: elapsed,
        samples: timeline.length,
        timeline,
      });
    }),
  );
}

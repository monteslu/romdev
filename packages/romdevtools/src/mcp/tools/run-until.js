// `runUntil` — step frames until a predicate holds (or a max-frames cap is hit).
//
// Predicate shapes the agent can use:
//   { type: "memory", region, offset, equals|notEquals|mask }
//   { type: "memoryChanged", region, offset, length }
//   { type: "framebufferChanged" }
//   { type: "framebufferPixel", x, y, equals: [r,g,b] }
//
// Saves dozens of MCP round trips for "play until something happens" workflows.

import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { attachObserverFrame } from "./watch-memory.js";

export function registerRunUntilTools(server, z, sessionKey) {
  // Condition `region` is a runtime-validated string, not a schema enum. It was
  // an inlined 8-value list — which both bloated the schema AND silently rejected
  // valid non-NES regions (genesis_*, c64_*, *_apu_regs) that host.readMemory
  // accepts. The readMemory(region,…) call in the handler validates and throws a
  // clear message on an unknown region (full canonical set, same as `memory`).
  const regionStr = z.string().describe("memory region (full readMemory set, e.g. system_ram, nes_oam, genesis_vram, c64_color_ram; validated at runtime)");
  const memoryCondition = z.object({
    type: z.literal("memory"),
    region: regionStr,
    offset: z.number().int().min(0),
    equals: z.number().int().min(0).max(255).optional(),
    notEquals: z.number().int().min(0).max(255).optional(),
    mask: z.number().int().min(0).max(255).optional(),
  }).describe("Stop when memory[region][offset] satisfies the comparison.");

  const memoryChangedCondition = z.object({
    type: z.literal("memoryChanged"),
    region: regionStr,
    offset: z.number().int().min(0),
    length: z.number().int().min(1).max(8192).default(1),
  }).describe("Stop when memory[region][offset..offset+length] changes from its initial value.");

  const framebufferChangedCondition = z.object({
    type: z.literal("framebufferChanged"),
  }).describe("Stop when the framebuffer pixel data differs from the start-of-call snapshot.");

  const framebufferPixelCondition = z.object({
    type: z.literal("framebufferPixel"),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    equals: z.array(z.number().int().min(0).max(255)).length(3).optional(),
    notEquals: z.array(z.number().int().min(0).max(255)).length(3).optional(),
  }).describe("Stop when pixel (x, y) matches equals (or differs from notEquals); color is [r,g,b], each 0-255.");

  server.tool(
    "runUntil",
    "Step the emulator forward until a condition holds, or until maxFrames is reached. Use this instead of polling stepFrames + readMemory yourself for 'play until X happens' workflows. " +
      "condition.type is one of: 'memory' (byte at region/offset equals/notEquals a value, or mask hits when byte & mask is nonzero); 'memoryChanged' (any byte in offset..offset+length differs from start-of-call); 'framebufferChanged' (any pixel differs from start-of-call); 'framebufferPixel' (pixel x,y equals/notEquals an [r,g,b]). " +
      "checkEvery throttles condition checks (and is the step batch size), so the actual stop frame can overshoot by up to checkEvery-1. " +
      "Returns {conditionMet, framesStepped, finalValue} (finalValue is null when the condition was not met).",
    {
      condition: z.discriminatedUnion("type", [
        memoryCondition,
        memoryChangedCondition,
        framebufferChangedCondition,
        framebufferPixelCondition,
      ]),
      maxFrames: z.number().int().min(1).max(1_000_000).default(600),
      checkEvery: z.number().int().min(1).max(60).default(1).describe("Frames between condition checks (1 = every frame)."),
    },
    safeTool(async ({ condition, maxFrames, checkEvery }) => {
      const host = getHost(sessionKey);
      const initial = captureForCondition(host, condition);
      let framesStepped = 0;
      let met = false;
      let finalValue = null;

      while (framesStepped < maxFrames) {
        const batch = Math.min(checkEvery, maxFrames - framesStepped);
        host.stepFrames(batch);
        framesStepped += batch;
        const { hit, value } = evaluate(host, condition, initial);
        if (hit) {
          met = true;
          finalValue = value;
          break;
        }
      }

      // Livestream: the frame where the condition was met (or where we gave up).
      return attachObserverFrame(jsonContent({
        conditionMet: met,
        framesStepped,
        finalValue,
      }), host, met ? "runUntil: condition met" : "runUntil: gave up");
    }),
  );
}

function captureForCondition(host, condition) {
  switch (condition.type) {
    case "memoryChanged": {
      const bytes = host.readMemory(condition.region, condition.offset, condition.length);
      return { bytes: Array.from(bytes) };
    }
    case "framebufferChanged": {
      try {
        const f = host.getFramebuffer();
        return { fb: Buffer.from(f.pixels).toString("base64") };
      } catch {
        return { fb: null };
      }
    }
    default:
      return null;
  }
}

function evaluate(host, condition, initial) {
  switch (condition.type) {
    case "memory": {
      const byte = host.readMemory(condition.region, condition.offset, 1)[0];
      if (condition.equals !== undefined && byte === condition.equals) return { hit: true, value: byte };
      if (condition.notEquals !== undefined && byte !== condition.notEquals) return { hit: true, value: byte };
      if (condition.mask !== undefined && (byte & condition.mask) !== 0) return { hit: true, value: byte };
      return { hit: false, value: byte };
    }
    case "memoryChanged": {
      const cur = host.readMemory(condition.region, condition.offset, condition.length);
      const initBytes = initial.bytes;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i] !== initBytes[i]) return { hit: true, value: Array.from(cur) };
      }
      return { hit: false, value: null };
    }
    case "framebufferChanged": {
      try {
        const f = host.getFramebuffer();
        const cur = Buffer.from(f.pixels).toString("base64");
        return { hit: cur !== initial.fb, value: null };
      } catch {
        return { hit: false, value: null };
      }
    }
    case "framebufferPixel": {
      const { width, height, pitch, format, pixels } = host.getFramebuffer();
      if (condition.x >= width || condition.y >= height) {
        return { hit: false, value: null };
      }
      const rgb = readPixelRgb(pixels, condition.x, condition.y, pitch, format);
      if (condition.equals) {
        const [r, g, b] = condition.equals;
        if (rgb[0] === r && rgb[1] === g && rgb[2] === b) return { hit: true, value: rgb };
      }
      if (condition.notEquals) {
        const [r, g, b] = condition.notEquals;
        if (rgb[0] !== r || rgb[1] !== g || rgb[2] !== b) return { hit: true, value: rgb };
      }
      return { hit: false, value: rgb };
    }
    default:
      return { hit: false, value: null };
  }
}

function readPixelRgb(src, x, y, pitch, format) {
  // Format ints come from retroConstants.js: XRGB8888=1, RGB565=2, 0RGB1555=0
  if (format === 1) {
    const o = y * pitch + x * 4;
    return [src[o + 2], src[o + 1], src[o]]; // BGR(X) → RGB
  }
  if (format === 2) {
    const o = y * pitch + x * 2;
    const p = src[o] | (src[o + 1] << 8);
    const r = (p >> 11) & 0x1f;
    const g = (p >> 5) & 0x3f;
    const b = p & 0x1f;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
  }
  if (format === 0) {
    const o = y * pitch + x * 2;
    const p = src[o] | (src[o + 1] << 8);
    const r = (p >> 10) & 0x1f;
    const g = (p >> 5) & 0x1f;
    const b = p & 0x1f;
    return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)];
  }
  return [0, 0, 0];
}

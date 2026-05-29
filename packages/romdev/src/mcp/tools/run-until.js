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

export function registerRunUntilTools(server, z, sessionKey) {
  const memoryCondition = z.object({
    type: z.literal("memory"),
    region: z.enum(["system_ram", "save_ram", "video_ram", "rtc", "nes_nametables", "nes_palette", "nes_oam", "nes_chr"]),
    offset: z.number().int().min(0),
    equals: z.number().int().min(0).max(255).optional(),
    notEquals: z.number().int().min(0).max(255).optional(),
    mask: z.number().int().min(0).max(255).optional(),
  }).describe("Stop when memory[region][offset] satisfies the comparison.");

  const memoryChangedCondition = z.object({
    type: z.literal("memoryChanged"),
    region: z.enum(["system_ram", "save_ram", "video_ram", "rtc", "nes_nametables", "nes_palette", "nes_oam", "nes_chr"]),
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
  }).describe("Stop when pixel (x, y) matches a target color.");

  server.tool(
    "runUntil",
    "Step the emulator forward until a condition holds, or until maxFrames is reached. Use this instead of polling stepFrames + readMemory yourself — saves many round trips for 'play until X happens' workflows. Returns {conditionMet, framesStepped, finalValue?}.",
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

      return jsonContent({
        conditionMet: met,
        framesStepped,
        finalValue,
      });
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

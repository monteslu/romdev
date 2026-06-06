// traceVramSource (Genesis) — "which ROM offset did this VRAM graphic come from?"
//
// The trap it kills: NBA Jam-style player names are pre-rendered tile bitmaps
// DMA'd into VRAM from ROM, not font-rendered from a string. You can SEE the
// name but patching the ASCII string does nothing — the source is the bitmap in
// ROM. Genesis makes this traceable: a memory→VRAM DMA leaves its SOURCE address
// in VDP regs $15-$17 (a word address; byte addr = source<<1), which for a
// normal cart is the ROM offset the tiles were copied from.
//
// HONESTY: this is FRAME-SAMPLED. It steps frames (optionally driving input) and
// reads the DMA source registers once per frame, logging each DISTINCT
// mem→VRAM source it sees. It will MISS a second DMA that happens in the same
// frame as another (only the last frame's register state is visible per step).
// For most "drive to the screen, see what got uploaded" cases that's enough; for
// exhaustive per-DMA capture you'd need a core-level DMA log (not built).

import { getHost } from "../state.js";
import { jsonContent } from "../util.js";
import { decodeDMASource } from "../../platforms/genesis/vdp.js";
import { makePressDriver } from "./watch-memory.js";

// traceVramSource → dmaTrace({precision:'sampled'}) (router in watch-memory.js).
// Exported core; the router passes its own sessionKey.
export async function traceVramSourceCore({ frames = 120, pressDuring, romPreviewBytes = 16, minLengthBytes = 0, sessionKey }) {
      const host = getHost(sessionKey);
      const platform = host.status.platform;
      if (platform !== "genesis" && platform !== "megadrive" && platform !== "md") {
        throw new Error(`traceVramSource is Genesis-only (loaded platform: '${platform}'). VRAM-DMA source tracing uses the Genesis VDP DMA registers.`);
      }
      // ROM image for the preview (un-banked on Genesis: file offset == DMA source byte addr).
      let rom = null;
      try { rom = host.getCartRom(); } catch { /* no ROM preview if not loadable */ }

      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const driver = makePressDriver(host, presses);

      const seen = new Map(); // sourceOffset -> { firstFrame, lengthBytes }
      for (let i = 0; i < frames; i++) {
        driver.applyForFrame(i);
        host.stepFrames(1);
        const regs = host.readMemory("genesis_vdp_regs", 0, 0x20);
        const dma = decodeDMASource(regs);
        if (dma.kind !== "mem-to-vram" || dma.sourceByteAddr == null) continue;
        if (dma.lengthBytes < minLengthBytes) continue;
        if (!seen.has(dma.sourceByteAddr)) {
          seen.set(dma.sourceByteAddr, { firstFrame: i, lengthBytes: dma.lengthBytes });
        }
      }
      driver.finish();

      const sources = [...seen.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([addr, info]) => {
          const out = {
            sourceOffset: "0x" + addr.toString(16).toUpperCase().padStart(6, "0"),
            sourceOffsetDec: addr,
            firstFrame: info.firstFrame,
            lengthBytes: info.lengthBytes,
          };
          if (rom && romPreviewBytes > 0 && addr < rom.bytes.length) {
            const end = Math.min(addr + romPreviewBytes, rom.bytes.length);
            out.romPreview = Array.from(rom.bytes.subarray(addr, end), (b) => b.toString(16).padStart(2, "0")).join("");
          }
          return out;
        });

      return jsonContent({
        platform: "genesis",
        framesStepped: frames,
        ...(presses.length ? { pressesApplied: driver.applied() } : {}),
        distinctSources: sources.length,
        sources,
        note: sources.length === 0
          ? "No memory→VRAM DMA seen in this window. The graphic may have been uploaded BEFORE this window (step to just before it appears, then trace), or it's drawn via CPU writes / VRAM fill rather than DMA. Frame-sampled: a DMA sharing a frame with a later one can be hidden — narrow the window."
          : `${sources.length} distinct ROM→VRAM source(s). Each sourceOffset is the ROM byte offset the tiles were DMA'd from — edit the TILE BITMAPS there (use tiles({as:'pixels'})/encodeArt), not any ASCII string. romPreview is the first bytes at that ROM offset (verify with memory({op:'readCart'})). Frame-sampled — narrow the window if you expect more.`,
      });
}

// traceVramSource is registered as dmaTrace({precision:'sampled'}) by the
// `dmaTrace` router in watch-memory.js (which imports traceVramSourceCore).
export function registerTraceVramSourceTools() {}

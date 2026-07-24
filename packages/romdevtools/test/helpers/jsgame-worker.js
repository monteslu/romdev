// Forked child process that runs a jsgame session through JsGameHost and exposes the
// results over rawr JSON-RPC (via the fork IPC channel). Forked with
// --experimental-vm-modules (set by the spawning test via execArgv) so rungame's
// vm.SourceTextModule realm works, and as a real process so @kmamal/sdl (main-thread-only)
// is happy. All of rungame's leaky handles (SDL/audio/timers) live in THIS process; the
// test kills it when the RPC resolves, disposing them without hanging the main process.

import rawr from "rawr";
import { childTransport } from "./rawr-fork-transport.js";
import { JsGameHost } from "../../src/host/JsGameHost.js";

/**
 * Load a jsgame, exercise the full host surface, and return a plain-JSON result the
 * test can assert on (no host objects cross the RPC boundary).
 */
async function runJsgame(gamePath) {
  const host = new JsGameHost();
  const status = await host.loadMedia({ platform: "jsgame", path: gamePath });
  const caps = host.getCapabilities();

  host.setInput({ ports: [{ right: true, a: true }] });
  const stepped = await host.stepFrames(10);

  const shot = host.screenshot();
  const fb = host.getFramebuffer();
  let maxPixel = 0;
  for (let i = 0; i < fb.pixels.length; i += 397) if (fb.pixels[i] > maxPixel) maxPixel = fb.pixels[i];

  const globals = host.jsGlobals();

  // Snapshot everything into a plain object BEFORE destroy() — `status` is a live
  // reference to host.status, and destroy() flips loaded/platform, so reading them
  // after teardown would report false/null.
  const result = {
    loaded: status.loaded,
    platform: status.platform,
    fbWidth: status.fbWidth,
    fbHeight: status.fbHeight,
    displayAspect: status.displayAspect,
    caps,
    stepped,
    frameCount: host.status.frameCount,
    pngLen: shot.pngBase64 ? shot.pngBase64.length : 0,
    shotW: shot.width,
    shotH: shot.height,
    maxPixel,
    globals,
  };
  host.destroy();
  return result;
}

rawr({
  transport: childTransport(process),
  methods: { runJsgame },
});

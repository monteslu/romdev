// Dreamcast run-side: a C homebrew built via sh-elf-gcc boots on Flycast's reios HLE
// BIOS (no firmware) and renders program-controlled graphics on the REAL GPU through
// native-gles. Proves the manifest's build+run+screenshot claims end-to-end.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/LibretroHost.js";
import { glStackAvailable } from "../src/host/glOptionalDep.js";

// A minimal pixel-writing program: bring up the PowerVR2 framebuffer via the bundled
// dc.h helper and paint three solid bars + a white frame on a dark-blue field. No TA
// list, no KallistiOS — Flycast's framebuffer-emulation path presents it.
const SRC = `#include "dc.h"
void main(void) {
  dc_video_init();
  dc_clear(dc_rgb(16, 24, 64));
  dc_rect(64, 80, 160, 320, dc_rgb(220, 40, 40));
  dc_rect(240, 80, 160, 320, dc_rgb(40, 200, 60));
  dc_rect(416, 80, 160, 320, dc_rgb(50, 90, 230));
  dc_rect(0, 0, DC_W, 4, dc_rgb(255, 255, 255));
  dc_rect(0, DC_H - 4, DC_W, 4, dc_rgb(255, 255, 255));
  for (;;) { }
}`;

test("dreamcast: a C homebrew builds (sh-elf-gcc) + boots on Flycast reios + renders via native-gles",
  { timeout: 180000 }, async () => {
    // build — sh-elf-gcc → an ELF Flycast boots directly (dc.h is auto-bundled).
    const built = await buildForPlatform({ platform: "dreamcast", source: SRC });
    assert.ok(built.ok, `homebrew builds: ${built.stage} ${(built.log || "").slice(-300)}`);
    assert.ok(built.binary?.length > 0, "produced an ELF");
    assert.equal(built.binary[0], 0x7f, "ELF magic (0x7f 'E' 'L' 'F')");

    // run — only if the GL stack (native-gles + webgl-node) is installed; flycast is a
    // HW-render core and can't present without it.
    if (!(await glStackAvailable())) { console.log("GL stack unavailable; skipping run"); return; }
    const core = resolveCore("dreamcast");
    if (!core) { console.log("no dreamcast core staged; skipping run"); return; }

    const host = new LibretroHost();
    try {
      await host.loadCore(core.jsPath, core.wasmPath, { hwRender: true, platform: "dreamcast" });
      await host.loadMedia({ platform: "dreamcast", bytes: built.binary, virtualName: "/built.elf" });
      assert.ok(host.hwRender?.active, "flycast engaged GL through native-gles (hwActive)");
      for (let i = 0; i < 120; i++) host.stepFrames(1);

      // The core reports its native geometry via video_refresh; readback crops the
      // (upscale-bounded) FBO to it. Expect 640x480 and the painted test pattern.
      const fb = host.hwRender.readbackFrame(host.state.hwFrameW, host.state.hwFrameH);
      assert.ok(fb, "got a HW frame");
      assert.equal(fb.width, 640, "native DC width");
      assert.equal(fb.height, 480, "native DC height");
      const colors = new Set();
      let nonBlack = 0;
      for (let i = 0; i < fb.pixels.length; i += 4) {
        if (fb.pixels[i] | fb.pixels[i + 1] | fb.pixels[i + 2]) nonBlack++;
        colors.add((fb.pixels[i] << 16) | (fb.pixels[i + 1] << 8) | fb.pixels[i + 2]);
      }
      assert.ok(nonBlack > 20000, `the pattern rendered (not black): ${nonBlack} non-black px`);
      assert.ok(colors.size >= 4, `multiple distinct colors (bg + 3 bars + frame): ${colors.size}`);
    } finally {
      host.dispose?.();
    }
  });

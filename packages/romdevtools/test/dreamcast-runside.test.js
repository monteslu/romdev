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

test("dreamcast: cpuState (SH-4 regs) + audioDebug (AICA) read from the rebuilt flycast core",
  { timeout: 180000 }, async () => {
    const built = await buildForPlatform({ platform: "dreamcast",
      source: `#include "dc.h"\nvoid main(void){ dc_video_init(); dc_clear(dc_rgb(0,0,32)); for(;;){} }` });
    assert.ok(built.ok, `homebrew builds: ${(built.log || "").slice(-200)}`);
    if (!(await glStackAvailable())) { console.log("GL stack unavailable; skipping"); return; }
    const core = resolveCore("dreamcast");
    if (!core) return;
    const { getCPUState } = await import("../src/host/cpu-state.js");
    const { decodeAica } = await import("../src/host/dc-aica-state.js");
    const host = new LibretroHost();
    try {
      await host.loadCore(core.jsPath, core.wasmPath, { hwRender: true, platform: "dreamcast" });
      if (!host.sh4RegsSupported()) { console.log("core has no SH-4 export; skipping"); return; }
      await host.loadMedia({ platform: "dreamcast", bytes: built.binary, virtualName: "/built.elf" });
      for (let i = 0; i < 60; i++) host.stepFrames(1);

      // cpuState — SH-4 PC + SP land in the KOS-linked RAM region (0x8C00_0000+).
      const cs = getCPUState(host, "dreamcast");
      assert.ok(cs, "getCPUState returned a state");
      assert.equal(((cs.pc >>> 0) & 0xf0000000) >>> 0, 0x80000000, `PC in SH-4 space (got ${cs.pcHex})`);
      assert.ok(cs.flags && "T" in cs.flags, "SR flags decoded");
      assert.ok("r15" in cs.registers, "r15 present");

      // audioDebug — the AICA decode gives 64 channels + a master volume.
      assert.ok(host.aicaRegsSupported(), "AICA export present");
      const aica = decodeAica(host.getAicaRegs());
      assert.equal(aica.chip, "aica");
      assert.equal(aica.voices.length, 64, "64 AICA channels");
      assert.ok(typeof aica.masterVolume === "number", "master volume decoded");
    } finally {
      host.dispose?.();
    }
  });

test("dreamcast: all 5 genre examples build + render on the GPU (full 480-line frame)", { timeout: 400000 }, async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const exDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "examples", "dreamcast");
  const core = resolveCore("dreamcast");
  const haveGl = await glStackAvailable();
  for (const ex of ["shmup", "platformer", "puzzle", "racing", "sports"]) {
    const src = await readFile(path.join(exDir, ex, "main.c"), "utf8");
    const built = await buildForPlatform({ platform: "dreamcast", source: src });
    assert.ok(built.ok, `${ex} builds: ${(built.log || "").slice(-160)}`);
    if (!core || !haveGl) continue;
    const host = new LibretroHost();
    try {
      await host.loadCore(core.jsPath, core.wasmPath, { hwRender: true, platform: "dreamcast" });
      await host.loadMedia({ platform: "dreamcast", bytes: built.binary, virtualName: `/${ex}.elf` });
      for (let i = 0; i < 150; i++) host.stepFrames(1);
      const fb = host.hwRender.readbackFrame(host.state.hwFrameW, host.state.hwFrameH);
      let nonBlack = 0, top = 0; const colors = new Set();
      for (let y = 0; y < fb.height; y++) for (let x = 0; x < fb.width; x++) {
        const o = (y * fb.width + x) * 4;
        if (fb.pixels[o] | fb.pixels[o + 1] | fb.pixels[o + 2]) { nonBlack++; if (y < fb.height / 2) top++; }
        colors.add((fb.pixels[o] << 16) | (fb.pixels[o + 1] << 8) | fb.pixels[o + 2]);
      }
      assert.ok(nonBlack > 50000, `${ex} renders on the GPU: ${nonBlack} px`);
      assert.ok(top > 1000, `${ex} fills the TOP half too (interlace 480i, not 240p): top=${top}`);
      assert.ok(colors.size >= 3, `${ex} multiple colors: ${colors.size}`);
    } finally {
      host.dispose?.();
    }
  }
});

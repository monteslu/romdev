// encodeAudio({target:'xgm2'}) — the v0.6.0 music-feedback #1 (HEADLINE): there
// was no bundled VGM→XGM2 compiler (SGDK's xgm2tool is Java), so "add Genesis
// music" was impossible with bundled tooling. romdev-xgm2 (a JS port of
// xgm2tool) closes that — this test proves the FULL path end-to-end:
//   VGM → encodeAudio({target:'xgm2'}) → build a Genesis ROM that XGM2_play()s
//   the blob → run in gpgx → assert audio actually comes out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/index.js";
import { registerAudioTools } from "../src/mcp/tools/audio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_VGM = join(__dirname, "..", "src", "platforms", "genesis", "lib", "sgdk", "music", "demo.vgm");

function audioHandler(sessionKey) {
  let handler;
  registerAudioTools({ tool: (n, _d, _s, h) => { if (n === "encodeAudio") handler = h; } }, z, sessionKey);
  return handler;
}
const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

test("encodeAudio({target:'xgm2'}) compiles a VGM to a usable XGM2 C array", async () => {
  const handler = audioHandler("xgm2-music-1");
  const r = parse(await handler({ op: undefined, target: "xgm2", vgmPath: DEMO_VGM, name: "bgm_demo" }));
  assert.equal(r.platform, "genesis");
  assert.equal(r.lenDefine, "BGM_DEMO_LEN");
  assert.ok(r.xgm2Bytes > 0 && r.xgm2Bytes % 256 === 0, "256-aligned XGM2 blob");
  assert.match(r.cSource, /const unsigned char bgm_demo\[\d+\] __attribute__\(\(aligned\(256\)\)\)/);
  assert.match(r.cSource, /#define BGM_DEMO_LEN \d+/);
});

test("END-TO-END: VGM → XGM2 → Genesis ROM plays it (audio comes out of gpgx)", { timeout: 240000 }, async () => {
  // 1. Compile the VGM to an XGM2 C array.
  const handler = audioHandler("xgm2-music-2");
  const enc = parse(await handler({ target: "xgm2", vgmPath: DEMO_VGM, name: "bgm" }));
  assert.ok(enc.cSource, "encodeAudio returned C source");

  // 2. Build a Genesis ROM that inits the XGM2 driver and plays the track.
  const main = `#include <genesis.h>
#include "bgm.h"
int main(bool h) {
  VDP_init();
  XGM2_play(bgm);
  while (1) { SYS_doVBlankProcess(); }
  return 0;
}`;
  const build = await buildForPlatform({
    platform: "genesis", language: "c",
    sources: { "main.c": main },
    includes: { "bgm.h": enc.cSource },
  });
  assert.equal(build.ok, true, "genesis music build failed:\n" + (build.log || "").slice(-500));

  // 3. Run it in gpgx and confirm audio is actually produced (not silence).
  const core = resolveCore("genesis");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "genesis", bytes: build.binary });

  // The Z80 XGM2 driver needs a bunch of frames to boot + start the track.
  host.state.audioRing.length = 0;
  for (let i = 0; i < 200; i++) host.stepFrames(1);

  let peak = 0, nonzero = 0;
  for (const buf of host.state.audioRing) {
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
      if (a > 64) nonzero++;
    }
  }
  assert.ok(peak > 0, "gpgx produced total silence — the XGM2 blob didn't play (conversion or driver-init issue)");
  assert.ok(nonzero > 100, `expected sustained audio samples, got peak=${peak} nonzero=${nonzero} — likely a click, not the track`);
});

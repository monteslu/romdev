// audioDebug({op:'inspect', frames}) — the v0.6.0 music-feedback #3: a single
// inspect() is a snapshot and can't assert a *melody*. The trace mode steps N
// frames, samples the chip each frame, and returns a per-channel note-timeline
// (value transitions) you can assert a tune on headlessly.
//
// We build a tiny NES ROM that sweeps the pulse-1 period every few frames, then
// trace chip:'nes' and assert the timeline captures the changing frequency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";
import { registerPlatformTools } from "../src/mcp/tools/platform-tools.js";
import { registerAudioTools } from "../src/mcp/tools/audio.js";
import { z } from "zod";
import { _setHostForTest } from "../src/mcp/state.js";

// Register platform-tools + audio against ONE sessionKey so the live-binding
// getAudioStateCore closes over that session (registerPlatformTools assigns it),
// then capture the audioDebug handler. Returns the handler.
function audioHandler(sessionKey) {
  registerPlatformTools({ tool() {} }, z, sessionKey); // assigns getAudioStateCore for this session
  let handler;
  registerAudioTools({ tool: (n, _d, _s, h) => { if (n === "audioDebug") handler = h; } }, z, sessionKey);
  return handler;
}

// NES C: write the APU directly to play pulse-1 and step its period down each
// NMI so the decoded frequency changes over time (a crude rising "melody").
// cc65 is C89 — ALL locals declared at the top of the block (no mixed decls).
// We sweep the pulse-1 period in a tight loop; a counter steps it down every
// ~256 iterations so the decoded frequency genuinely changes across the trace.
const SRC = `#include <stdint.h>
#define APU(r) (*(volatile uint8_t*)(0x4000 + (r)))
void main(void) {
  uint16_t period;
  uint16_t t;
  APU(0x15) = 0x01;            /* enable pulse 1 */
  APU(0x00) = 0x80|0x10|0x0A;  /* duty 50%, constant vol 10 */
  period = 0x300;
  t = 0;
  for (;;) {
    APU(0x02) = period & 0xFF;
    APU(0x03) = (period >> 8) & 0x07;
    t++;
    if ((t & 0xFF) == 0) {
      if (period > 0x080) period -= 0x040; else period = 0x300;
    }
  }
}
`;

test("audioDebug trace: chip:'nes' over frames yields a changing-frequency timeline", { timeout: 120000 }, async () => {
  const build = await buildForPlatform({ platform: "nes", language: "c", source: SRC, linkerConfig: "chr-ram" });
  assert.equal(build.ok, true, "nes build failed:\n" + (build.log || "").slice(-400));

  const core = resolveCore("nes");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: build.binary });

  const SESS = "audio-trace-test";
  _setHostForTest(SESS, host);
  const handler = audioHandler(SESS);

  // Drive past boot so the loop is writing the APU.
  for (let i = 0; i < 30; i++) host.stepFrames(1);

  const res = await handler({ op: "inspect", chip: "nes", frames: 80, sampleEvery: 1 });
  const parsed = JSON.parse(res.content.find((c) => c.type === "text").text);

  assert.equal(parsed.chip, "nes");
  assert.equal(parsed.framesTraced, 80);
  assert.ok(parsed.transitions > 0, "trace captured no transitions: " + JSON.stringify(parsed).slice(0, 300));
  // pulse1 should appear as a channel with a timeline; its frequency should change.
  const pulseKey = parsed.channels.find((c) => /pulse1|pulse\[0\]/.test(c)) || parsed.channels[0];
  assert.ok(pulseKey, "no channel in the trace: " + JSON.stringify(parsed.channels));
  const tl = parsed.timeline[pulseKey];
  assert.ok(Array.isArray(tl) && tl.length >= 2, "expected multiple transitions on the swept channel");
  const freqs = tl.map((e) => e.frequency ?? e.freq ?? e.note).filter((v) => v !== undefined);
  const distinct = new Set(freqs);
  assert.ok(distinct.size >= 2, `swept channel should show >=2 distinct freq/note values, got ${JSON.stringify(freqs)}`);
});

test("audioDebug inspect WITHOUT frames is still a single-frame snapshot (no timeline)", async () => {
  const core = resolveCore("nes");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  const SRC2 = `#include <stdint.h>\nvoid main(void){ *(volatile uint8_t*)0x4015 = 1; for(;;){} }`;
  const b = await buildForPlatform({ platform: "nes", language: "c", source: SRC2, linkerConfig: "chr-ram" });
  assert.equal(b.ok, true);
  await host.loadMedia({ platform: "nes", bytes: b.binary });
  for (let i = 0; i < 10; i++) host.stepFrames(1);
  const SESS = "audio-snap-test";
  _setHostForTest(SESS, host);
  const handler = audioHandler(SESS);
  const snap = JSON.parse((await handler({ op: "inspect", chip: "nes" })).content.find((c) => c.type === "text").text);
  assert.equal(snap.timeline, undefined, "single-frame snapshot must NOT have a timeline");
  assert.equal(snap.framesTraced, undefined);
  assert.ok(snap.chip === "nes" || snap.platform === "nes");
});

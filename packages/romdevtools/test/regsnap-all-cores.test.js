// registersAtHit parity: the gpgx round froze the register file at the hit
// instant for Genesis/SMS/GG; this suite proves the SAME core machinery on the
// other rebuilt cores (fceumm, snes9x, gambatte, mGBA, handy, vice, stella2014,
// prosystem, geargrafx, bluemsx). For every platform we can deterministically
// build for, the check is the same shape:
//   1. single-step (setPCBreak step) leaves a kind-1 snapshot whose pc matches
//      the bp's lastPC — proving the snapshot capture + export plumbing.
//   2. the live PC stays frozen across EXTRA frames after the hit — proving
//      the freeze-after-hit guard (no register drift, the 2h-chase fix).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(__dirname, "..", "examples");

async function liveHost(platform, buildArgs) {
  const b = await buildForPlatform({ platform, ...buildArgs });
  assert.ok(b.ok && b.binary, `${platform} build failed: ` + (b.log || "").slice(-300));
  const host = new LibretroHost();
  const core = resolveCore(platform);
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform, bytes: b.binary });
  host.stepFrames(platform === "msx" ? 260 : 30);   // C-BIOS shows its logo ~2-3s
  return host;
}

async function exampleSource(rel) {
  return readFile(path.join(EXAMPLES, rel), "utf8");
}

/** The platform-agnostic snapshot assertions. */
function checkSnapshotAndFreeze(host, platform) {
  // 1. single-step → kind-1 snapshot whose pc matches the bp lastPC.
  host.setPCBreak(0, true, true);   // step=true: stop after exactly one instruction
  let st = null;
  for (let i = 0; i < 5; i++) {
    host.stepFrames(1);
    st = host.getPCBreak(false);
    if (st.hit) break;
  }
  assert.ok(st && st.hit, `${platform}: single-step never fired`);
  assert.ok(st.lastPC != null, `${platform}: no lastPC on the hit`);
  const snap = host.getRegSnapshot(false);
  assert.ok(snap, `${platform}: core left no register snapshot on the hit (regsnap export missing?)`);
  assert.equal(snap.kind, 1, `${platform}: snapshot kind should be 1 (pc-break/step)`);
  assert.ok(snap.named.pc, `${platform}: snapshot has no pc field`);
  const snapPC = parseInt(snap.named.pc.slice(1), 16);
  assert.equal(snapPC, st.lastPC,
    `${platform}: snapshot pc ($${snapPC.toString(16)}) must equal the hit lastPC ($${st.lastPC.toString(16)})`);

  // 2. freeze-after-hit: extra frames must NOT move the snapshot/live state.
  host.stepFrames(3);
  const snap2 = host.getRegSnapshot(false);
  assert.deepEqual(snap2.named, snap.named,
    `${platform}: snapshot must be stable while the hit is held`);
  const liveAfter = host.getPCBreak(false);
  assert.equal(liveAfter.lastPC, st.lastPC, `${platform}: lastPC must not move while frozen`);

  // cleanup: clear + disarm, CPU resumes.
  host.setPCBreak(0, false, false);
  host.getPCBreak(true);
  host.getRegSnapshot(true);
  host.stepFrames(2);
}

const CASES = [
  ["nes", async () => liveHost("nes", { source: "void main(void){for(;;);}", sourceName: "main.c", linkerConfig: "chr-ram" })],
  ["snes", async () => liveHost("snes", { language: "asm", source: await exampleSource("snes/main.asm") })],
  ["gb", async () => liveHost("gb", { source: await exampleSource("gb/main.c"), sourceName: "main.c" })],
  ["gba", async () => liveHost("gba", { source: "int main(void){volatile int x=0;for(;;)x++;}", sourceName: "main.c" })],
  ["atari2600", async () => liveHost("atari2600", { source: await exampleSource("atari2600/main.asm") })],
  ["atari7800", async () => liveHost("atari7800", { source: await exampleSource("atari7800/main.c"), sourceName: "main.c" })],
  ["lynx", async () => liveHost("lynx", { source: await exampleSource("lynx/main.c"), sourceName: "main.c" })],
  ["c64", async () => liveHost("c64", { source: await exampleSource("c64/main.c"), sourceName: "main.c" })],
  // PCE: keep one global — an empty BSS trips a crt0 ld65 range error.
  ["pce", async () => liveHost("pce", { source: "unsigned char g; void main(void){for(;;)g++;}", sourceName: "main.c" })],
  ["msx", async () => liveHost("msx", { source: "void main(void){volatile unsigned char x=0;for(;;)x++;}", sourceName: "main.c" })],
];

for (const [platform, make] of CASES) {
  test(`registersAtHit + freeze-after-hit on ${platform}`, { timeout: 240000 }, async () => {
    const host = await make();
    checkSnapshotAndFreeze(host, platform);
  });
}

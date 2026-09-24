#!/usr/bin/env node
// Prove a rebuilt libretro core emulates byte-identically to the build it
// replaces: run the SAME ROM on both builds with the same deterministic input
// script and compare, every frame, the framebuffer, the audio the core hands
// audio_batch_cb, and the named memory regions. Used whenever a core patch
// adds debug-only state (a region, a stream, a trace hook) that must not
// change emulation.
//
//   node scripts/core-identity-check.mjs --platform gba --rom game.gba \
//     --a before/mgba_libretro.js --b ../romdev-platform-gba/wasm/mgba_libretro.js \
//     --frames 3000 [--regions system_ram,gba_iwram] [--stream gba_audio_raw]
//
// --a/--b name the .js glue; the .wasm beside each is loaded. --stream reads a
// per-frame RDAS audio stream region from build B only and reports its
// per-frame counts (the new debug output), which build A does not have.
// Exits 0 when identical, 1 on the first difference (printed).

import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { readRefStream, drainAudioRing } from "../src/host/audio-verify.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith("--") ? [...acc, [v.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]]] : acc), []));
for (const k of ["platform", "rom", "a", "b"]) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
const frames = Number(args.frames ?? 1800);
const regions = (args.regions ?? "system_ram").split(",").filter(Boolean);
const resolved = resolveCore(args.platform);

async function open(js) {
  const h = new LibretroHost();
  await h.loadCore(path.resolve(js), path.resolve(js).replace(/\.js$/, ".wasm"), { hwRender: resolved?.hwRender, noderawfs: resolved?.noderawfs });
  await h.loadMedia({ platform: args.platform, path: path.resolve(args.rom) });
  drainAudioRing(h);
  return h;
}

// deterministic play: start early, then a pseudo-random pad every 8 frames
function pad(f) {
  if (f >= 120 && f < 126) return { start: true };
  if (f >= 240 && f < 246) return { a: true };
  if (f < 300) return {};
  let x = Math.imul((f >> 3) + 7, 2654435761) >>> 0;
  const names = ["right", "left", "up", "down", "a", "b", "a", "right"];
  const o = {};
  for (let k = 0; k < 2; k++) { o[names[x & 7]] = true; x >>>= 5; }
  return o;
}

const sha = (u8) => createHash("sha1").update(u8).digest("hex").slice(0, 16);
const A = await open(args.a), B = await open(args.b);
let audioA = 0, audioB = 0, streamFrames = 0, streamSamples = 0, streamCounts = new Map(), streamRate = 0;
for (let f = 0; f < frames; f++) {
  for (const h of [A, B]) { h.setInput({ ports: [pad(f)] }); h.stepFrames(1); }
  const fa = A.state.lastFrame, fb = B.state.lastFrame;
  const da = drainAudioRing(A), db = drainAudioRing(B);
  audioA += da.length; audioB += db.length;
  const diffs = [];
  if (!fa || !fb || sha(fa.pixels) !== sha(fb.pixels)) diffs.push("framebuffer");
  if (da.length !== db.length || sha(new Uint8Array(da.buffer)) !== sha(new Uint8Array(db.buffer))) diffs.push(`audio (${da.length} vs ${db.length} samples)`);
  for (const r of regions) {
    const ra = A.readMemory(r, 0, A.regionSize(r)), rb = B.readMemory(r, 0, B.regionSize(r));
    if (sha(Uint8Array.from(ra)) !== sha(Uint8Array.from(rb))) diffs.push(`region ${r}`);
  }
  if (diffs.length) { console.log(JSON.stringify({ identical: false, frame: f + 1, differs: diffs })); process.exit(1); }
  if (args.stream) {
    const s = readRefStream(B, args.stream);
    streamFrames++; streamSamples += s.samples.length / s.channels; streamRate = s.rate;
    const n = s.samples.length / s.channels;
    streamCounts.set(n, (streamCounts.get(n) ?? 0) + 1);
  }
}
const out = { identical: true, platform: args.platform, rom: path.basename(args.rom), romSha1: sha(readFileSync(args.rom)), frames, regions,
  audioSamples: audioA, outputRate: B.status.audioSampleRate };
if (args.stream) Object.assign(out, { stream: args.stream, streamRate, streamSampleFrames: streamSamples, streamCountsPerFrame: Object.fromEntries([...streamCounts].sort((x, y) => y[1] - x[1]).slice(0, 6)) });
console.log(JSON.stringify(out));
A.dispose?.(); B.dispose?.();
process.exit(0);

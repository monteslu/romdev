// The romdev core patches that expose PRE-resample audio as RDAS stream
// regions (gba_audio_raw, gb_apu_raw, gpgx_blip_deltas): each region is
// reachable by name, carries the header src/host/audio-verify.js reads, and
// is rewritten per retro_run (the count is one frame's worth, not a running
// total). Trivial in-memory ROMs are enough: the stream exists whether or not
// the program makes a sound, and the GB/GBA sample clocks run regardless.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { readRefStream, AUDIO_STREAM } from "../src/host/audio-verify.js";

function gbRom() {
  const rom = new Uint8Array(0x8000);
  rom.set([0x00, 0xC3, 0x50, 0x01], 0x100); // nop; jp $0150
  rom.set([0x18, 0xFE], 0x150);             // jr -2
  rom[0x147] = 0; rom[0x148] = 0; rom[0x149] = 0;
  let c = 0;
  for (let i = 0x134; i <= 0x14C; i++) c = (c - rom[i] - 1) & 0xFF;
  rom[0x14D] = c;
  return rom;
}
function gbaRom() {
  const rom = new Uint8Array(0x10000);
  rom.set([0xFE, 0xFF, 0xFF, 0xEA], 0); // b . (ARM)
  rom[0xB2] = 0x96;
  let c = 0;
  for (let i = 0xA0; i <= 0xBC; i++) c = (c - rom[i]) & 0xFF;
  rom[0xBD] = (c - 0x19) & 0xFF;
  return rom;
}
function mdRom() {
  const rom = new Uint8Array(0x20000);
  const be32 = (o, v) => { rom[o] = v >>> 24; rom[o + 1] = (v >>> 16) & 0xFF; rom[o + 2] = (v >>> 8) & 0xFF; rom[o + 3] = v & 0xFF; };
  be32(0, 0x00FFFE00); be32(4, 0x200);
  rom.set(new TextEncoder().encode("SEGA MEGA DRIVE "), 0x100);
  rom.set([0x60, 0xFE], 0x200); // bra.s .
  return rom;
}
function smsRom() {
  const rom = new Uint8Array(0x8000);
  rom.set([0xF3, 0x18, 0xFE], 0); // di; jr -2
  rom.set(new TextEncoder().encode("TMR SEGA"), 0x7FF0);
  rom[0x7FFF] = 0x4C;
  return rom;
}

const CASES = [
  { platform: "gba", region: "gba_audio_raw", rom: gbaRom, name: "/t.gba", channels: 2, format: "s16", rate: (r) => r === 32768 || r === 65536, perFrame: [540, 1110] },
  { platform: "gb", region: "gb_apu_raw", rom: gbRom, name: "/t.gb", channels: 2, format: "s16", rate: (r) => r === 2097152, perFrame: [35000, 35200] },
  { platform: "genesis", region: "gpgx_blip_deltas", rom: mdRom, name: "/t.md", channels: 3, format: "s32", rate: (r) => r === 0, perFrame: [0, 32768] },
  { platform: "sms", region: "gpgx_blip_deltas", rom: smsRom, name: "/t.sms", channels: 3, format: "s32", rate: (r) => r === 0, perFrame: [0, 32768] },
];

for (const c of CASES) {
  const core = resolveCore(c.platform);
  const have = core && existsSync(core.wasmPath);
  test(`${c.platform}: ${c.region} is a per-frame RDAS stream`, { skip: !have && `${c.platform} core not built`, timeout: 120000 }, async () => {
    const h = new LibretroHost();
    await h.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    await h.loadMedia({ platform: c.platform, bytes: c.rom(), virtualName: c.name });
    let region;
    try {
      region = h.regionSize(c.region);
    } catch (e) {
      assert.fail(`region ${c.region} unreadable: ${e.message} (rebuild the core with scripts/build-*.sh: the patch adds it)`);
    }
    assert.ok(region > AUDIO_STREAM.header, `${c.region} has ${region} bytes`);
    const counts = [];
    for (let f = 0; f < 4; f++) {
      h.stepFrames(1);
      const s = readRefStream(h, c.region);
      assert.equal(s.channels, c.channels);
      assert.equal(s.format, c.format);
      assert.ok(c.rate(s.rate), `rate ${s.rate}`);
      assert.equal(s.dropped, 0);
      counts.push(s.samples.length / s.channels);
    }
    for (const n of counts) assert.ok(n >= c.perFrame[0] && n <= c.perFrame[1], `per-frame count ${n} outside ${c.perFrame} (a running total would grow: ${counts})`);
    h.dispose?.();
  });
}

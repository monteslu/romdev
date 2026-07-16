// R42 — Genesis XGM2 music playback smoke test.
//
// Confirms the xgm2_demo template compiles + links against SGDK and the
// compiled .xgc music blob gets incbin'd into ROM. This is the music
// counterpart to R30 (which only covered PSG sfx).
//
// Flow:
//   - Read xgm2_demo.c + xgm2_demo_data.s + demo.xgc from the bundled
//     SGDK runtime.
//   - Pass demo.xgc as a binary sibling so the .s file's `.incbin "demo.xgc"`
//     resolves at assemble time.
//   - Build through buildGenesisC with sgdk:true.
//   - Assert ROM > 100 KB (SGDK + XGM2 driver + music + crt0 + libmd).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { buildGenesisC } from "romdev-toolchain-m68k-gcc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

test("R42 Genesis XGM2 music: xgm2_demo template builds with .xgc incbin'd into ROM", { timeout: 240000 }, async () => {
  const mainC   = await readFile(join(REPO_ROOT, "examples/genesis/templates/xgm2_demo.c"),       "utf-8");
  const dataS   = await readFile(join(REPO_ROOT, "examples/genesis/templates/xgm2_demo_data.s"),  "utf-8");
  const xgcBlob = await readFile(join(REPO_ROOT, "../romdev-toolchain-m68k-gcc/share/genesis/lib/sgdk/music/demo.xgc"));

  const r = await buildGenesisC({
    sources: {
      "main.c": mainC,
      "xgm2_demo_data.s": dataS,
    },
    binaryIncludes: {
      "demo.xgc": new Uint8Array(xgcBlob),
    },
    sgdk: true,
  });

  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-600)}`);
  assert.ok(r.binary, "no binary produced");
  // SGDK + libmd + XGM2 driver + Z80 driver blob + music = sizeable ROM.
  assert.ok(
    r.binary.length > 100_000,
    `ROM smaller than expected: ${r.binary.length} bytes (want > 100000)`,
  );

  // Sanity: Sega header at $100.
  const headerStart = Buffer.from(r.binary.subarray(0x100, 0x110)).toString("ascii");
  assert.equal(headerStart, "SEGA MEGA DRIVE ", "missing SEGA header — build wired wrong");

  // The music_xgm bytes should appear somewhere in the ROM (look for the
  // first 16 bytes of the compiled .xgc). XGC2 blobs don't carry a fixed
  // magic, but a 16-byte head match against a random ROM is < 1 in 2^60.
  const head = xgcBlob.subarray(0, 16);
  let found = false;
  for (let i = 0; i + head.length <= r.binary.length; i++) {
    let match = true;
    for (let j = 0; j < head.length; j++) {
      if (r.binary[i + j] !== head[j]) { match = false; break; }
    }
    if (match) { found = true; break; }
  }
  assert.ok(found, "compiled XGM2 blob bytes not located in final ROM — .incbin wiring broken");
});

test("R42 demo.vgm + demo.xgc are byte-stable (regen via scripts/build-genesis-demo-vgm.js + xgm2tool)", { timeout: 180000 }, async () => {
  const vgm = await readFile(join(REPO_ROOT, "../romdev-toolchain-m68k-gcc/share/genesis/lib/sgdk/music/demo.vgm"));
  const xgc = await readFile(join(REPO_ROOT, "../romdev-toolchain-m68k-gcc/share/genesis/lib/sgdk/music/demo.xgc"));
  // Sizes pinned so any silent regeneration-drift is caught.
  assert.equal(vgm.length, 691, "demo.vgm size changed — re-run scripts/build-genesis-demo-vgm.js");
  assert.ok(xgc.length > 100 && xgc.length < 4096, `demo.xgc unexpected size: ${xgc.length}`);
  // VGM ident.
  assert.equal(vgm.subarray(0, 4).toString("ascii"), "Vgm ", "demo.vgm missing 'Vgm ' magic");
});

// NES→SNES PPU shim — end-to-end RENDER gate. Builds the NES default scaffold
// (the known-good recompile vehicle, same as recompile-nes-snes-e2e), recompiles
// its reset routine to 65816 WITH the shim, feeds the shim a KNOWN set of
// converted assets (tiles + tilemap + a vivid palette), assembles with asar, and
// boots the LoROM image in snes9x — asserting the tiles, tilemap, and PALETTE
// actually land in SNES VRAM/CGRAM and the screen is enabled.
//
// This is the acceptance gate for the shim's 65816 UPLOAD routine. It guards the
// `cpx`-width footgun specifically: `rep #$10` makes X 16-bit at runtime, but
// asar sizes index immediates by the literal and would assemble a bare `cpx #32`
// (the small CGRAM count) as an 8-bit instruction — the CPU then decodes 3 bytes,
// eats the next opcode, and the routine derails (blank screen + CPU runaway). The
// fix is `cpx.w` on every loop; this test proves CGRAM (the small count) uploads.
// (Verified manually: the fix made a recompiled NES boot picture render in color
// on snes9x; before it, CGRAM stayed at the power-on ramp and the CPU ran away.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore } from "../src/mcp/tools/toolchain.js";
import { runDa65 } from "../src/toolchains/cc65/da65.js";
import { runAsar } from "../src/toolchains/asar/asar.js";
import { recompileNesToSnes, sliceFirstRoutine, emitSeam } from "../src/analysis/recompile-65816.js";
import { buildSnesAssets, emitPpuShim } from "../src/analysis/nes-ppu-shim.js";
import { resolveCore } from "../src/cores/registry.js";
import { resetHost, clearHost } from "../src/mcp/state.js";

const parse = (r) => JSON.parse(r.content[0].text);

test("shim upload routine lands tiles + tilemap + palette in SNES VRAM/CGRAM", { timeout: 300000 }, async () => {
  const key = "shim-render-e2e";
  const root = await mkdtemp(path.join(tmpdir(), "shim-render-"));
  try {
    // 1. Build the NES default scaffold and recompile its reset routine (this
    //    path is known to translate + assemble + boot — see the sibling e2e).
    const proj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: proj, template: "default", overwrite: true });
    const nesRom = path.join(root, "in.nes");
    const build = parse(await buildProjectCore({ path: proj, platform: "nes", outputPath: nesRom }));
    assert.equal(build.ok, true, `NES build failed: ${(build.logTail || "").slice(-300)}`);
    const nes = new Uint8Array(await readFile(nesRom));
    const prg = nes.subarray(0x10, 0x10 + 0x8000);
    const da = await runDa65({ bytes: prg, cpu: "6502", startAddress: 0x8000, options: ["--comments", "4"] });
    const { mainAsm } = recompileNesToSnes(sliceFirstRoutine(da.asm ?? da.output ?? ""), { withShim: true });

    // 2. Build the shim from KNOWN assets: 256 tiles where tile 1 is a solid
    //    block (color 3), a tilemap of all tile-1, and a vivid palette. This
    //    makes the VRAM/CGRAM assertions exact and independent of any ROM's art.
    const chr = new Uint8Array(4096);
    // tile 1 (bytes 16..31): both planes all-ones for every row → color 3 fill.
    for (let i = 16; i < 32; i++) chr[i] = 0xff;
    const nametable = new Uint8Array(960).fill(1); // every cell = tile 1
    const pal = new Uint8Array(32);
    const vivid = [0x0f, 0x30, 0x16, 0x2a, 0x11, 0x27, 0x1a, 0x12];
    for (let i = 0; i < 16; i++) pal[i] = vivid[i % vivid.length];
    const assets = buildSnesAssets({ chr, nametable, palette: pal });
    const shimAsm = emitPpuShim(assets);
    // Expected CGRAM: NES $0F (black) → $0000, $30 (white) → $7FFF (bytes ff 7f).
    assert.deepEqual([...assets.cgram.subarray(0, 4)], [0x00, 0x00, 0xff, 0x7f]);

    // 3. Assemble the recompiled body + shim with asar.
    const asar = await runAsar({ source: mainAsm, includes: { "nes_seam.asm": emitSeam(), "nes_ppu_shim.asm": shimAsm } });
    assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 600)}`);

    // 4. Boot the SNES image and confirm the upload landed.
    const snesCore = resolveCore("snes");
    const host = resetHost(key);
    await host.loadCore(snesCore.jsPath, snesCore.wasmPath);
    await host.loadMedia({ platform: "snes", bytes: new Uint8Array(asar.binary), virtualName: "/rom.sfc" });
    host.stepFrames(10);

    // CGRAM must hold our converted palette. The bug left it at the snes9x
    // power-on ramp (00 00 04 00 08 00 ...), so CGRAM[1] = white ($7fff) is the
    // discriminating assertion that the CGRAM loop ran without derailing.
    const cg = host.readMemory("snes_cgram", 0, 4);
    assert.deepEqual([...cg], [0x00, 0x00, 0xff, 0x7f],
      "CGRAM holds the converted palette (NOT the power-on ramp) → CGRAM loop ran");

    // VRAM: tile 1 (bytes 32..47) is the solid block → all $ff in the low planes.
    const tile1 = host.readMemory("video_ram", 32, 16);
    assert.ok([...tile1].every((b) => b === 0xff), `tile 1 uploaded as solid block: ${[...tile1]}`);
    // tilemap at VRAM word $4000 (byte $8000): every entry = tile 1 (low byte 01).
    const map = host.readMemory("video_ram", 0x8000, 8);
    assert.equal(map[0], 0x01, "tilemap entry 0 = tile 1");
    assert.equal(map[2], 0x01, "tilemap entry 1 = tile 1");

    // Screen enabled.
    const fillram = host.readMemory("snes_fillram", 0x2100, 0x40);
    assert.equal(fillram[0x00] & 0x80, 0, "INIDISP force-blank cleared (screen on)");
    assert.equal(fillram[0x00] & 0x0f, 0x0f, "INIDISP full brightness");
    assert.ok(fillram[0x2c] & 0x01, "TM has BG1 enabled on the main screen");
  } finally {
    clearHost(key);
    await rm(root, { recursive: true, force: true });
  }
});

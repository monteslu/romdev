// NES→SNES phase-2 LIVE port — tool-level e2e. Drives
// disasm({target:'recompile', withRuntime:true}) on a hand-built NROM whose NMI
// handler animates a sprite (writes the shadow OAM + OAMDMA each frame), then
// builds the emitted asm with asar and boots it in snes9x — asserting the runtime
// is wired (NMI vector → NES_RT_NMI), the game's NMI runs each vblank, and the
// sprite reaches SNES OAM and ANIMATES. This is the phase-2 acceptance gate
// through the actual tool, per the MCP-server-path convention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { runAsar } from "../src/toolchains/asar/asar.js";
import { resolveCore } from "../src/cores/registry.js";
import { resetHost, clearHost } from "../src/mcp/state.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z);
  return map[toolName];
}

/**
 * Build a 32KB-PRG NROM whose reset seeds a sprite at $0200 and spins, and whose
 * NMI bumps the sprite Y + issues OAMDMA from page $02. 6502 machine code by hand.
 */
function animatingRom() {
  const prg = new Uint8Array(0x8000);
  // RESET at $8000:
  //   sei; cld; ldx #$ff; txs
  //   lda #$50; sta $0200   (Y)
  //   lda #$01; sta $0201   (tile)
  //   lda #$00; sta $0202   (attr)
  //   lda #$40; sta $0203   (X)
  //   lda #$80; sta $2000   (enable NMI on the real NES; harmless seam write here)
  // loop: jmp loop
  const reset = [
    0x78, 0xd8, 0xa2, 0xff, 0x9a,
    0xa9, 0x50, 0x8d, 0x00, 0x02,
    0xa9, 0x01, 0x8d, 0x01, 0x02,
    0xa9, 0x00, 0x8d, 0x02, 0x02,
    0xa9, 0x40, 0x8d, 0x03, 0x02,
    0xa9, 0x80, 0x8d, 0x00, 0x20,
  ];
  const loopAddr = 0x8000 + reset.length;
  reset.push(0x4c, loopAddr & 0xff, loopAddr >> 8); // jmp loop (self)
  prg.set(reset, 0x0000);

  // NMI at $8100:
  //   inc $0200            (animate Y)
  //   lda #$02; sta $4014  (OAMDMA from page $02)
  //   rti
  const nmiAddr = 0x8100;
  const nmi = [0xee, 0x00, 0x02, 0xa9, 0x02, 0x8d, 0x14, 0x40, 0x40];
  prg.set(nmi, nmiAddr - 0x8000);

  // vectors: NMI=$8100, RESET=$8000, IRQ=$8100
  const setW = (off, v) => { prg[off] = v & 0xff; prg[off + 1] = (v >> 8) & 0xff; };
  setW(0x7ffa, nmiAddr);
  setW(0x7ffc, 0x8000);
  setW(0x7ffe, nmiAddr);

  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 2, 0]); // 32KB PRG, 0 CHR, mapper 0
  const out = new Uint8Array(16 + prg.length);
  out.set(header); out.set(prg, 16);
  return out;
}

test("recompile withRuntime: the emitted LIVE port animates a sprite on snes9x", { timeout: 300000 }, async () => {
  const key = "recompile-runtime-tool-e2e";
  const dir = await mkdtemp(path.join(os.tmpdir(), "recompile-rt-"));
  try {
    const romPath = path.join(dir, "anim.nes");
    await writeFile(romPath, animatingRom());

    const disasm = toolHandler(registerDisasmTools, "disasm");
    const r = parse(await disasm({ target: "recompile", platform: "nes", path: romPath, withRuntime: true, outputDir: dir }));

    assert.equal(r.ok, true);
    assert.equal(r.runtime.applied, true, "the phase-2 runtime was wired");
    assert.equal(r.runtime.phase, "live-sprites");
    assert.ok(r.nmi && r.nmi.nmiVector === "$8100", `read the NMI vector: ${JSON.stringify(r.nmi)}`);
    assert.ok(r.nmiEntry, "translated the NMI handler (gave it an entry label)");
    // Files written: main + runtime + shim (runtime implies shim for the BG).
    assert.ok(r.written.mainAsm && r.written.runtimeAsm && r.written.shimAsm,
      `wrote main + runtime + shim: ${JSON.stringify(r.written)}`);

    // Build the emitted asm and boot it.
    const fs = await import("node:fs/promises");
    const main = await fs.readFile(r.written.mainAsm, "utf8");
    const runtime = await fs.readFile(r.written.runtimeAsm, "utf8");
    const shim = await fs.readFile(r.written.shimAsm, "utf8");
    const asar = await runAsar({ source: main, includes: { "nes_ppu_runtime.asm": runtime, "nes_ppu_shim.asm": shim } });
    assert.equal(asar.exitCode, 0, `asar build of the live port: ${(asar.log || "").slice(0, 500)}`);

    const core = resolveCore("snes");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform: "snes", bytes: new Uint8Array(asar.binary), virtualName: "/rom.sfc" });

    host.stepFrames(12);
    const a = [...host.readMemory("snes_oam", 0, 4)];
    host.stepFrames(12);
    const b = [...host.readMemory("snes_oam", 0, 4)];

    assert.equal(a[0], 0x40, "sprite X reached SNES OAM");
    assert.equal(a[2], 0x01, "sprite tile reached SNES OAM");
    assert.ok(b[1] > a[1], `sprite Y animates via the per-vblank flush + game NMI: ${a[1]} → ${b[1]}`);
  } finally {
    clearHost(key);
    await rm(dir, { recursive: true, force: true });
  }
});

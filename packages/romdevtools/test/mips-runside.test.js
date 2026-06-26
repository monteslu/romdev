// MIPS run-side (N64 HW-render via the GL bridge, PS1 software via pcsx_rearmed
// HLE). Proves the cores boot, run, and present a real framebuffer through romdev's
// host — the run/screenshot parity. These need the optional native GL stack
// (native-gles/webgl-node) for N64 + a core in the dev-staging dir; they skip
// gracefully when either is absent (CI without the GPU module / packaged cores).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LibretroHost } from "../src/host/LibretroHost.js";
import { resolveCore } from "../src/cores/registry.js";
import { framebufferToRgba } from "../src/host/framebuffer.js";
import { glStackAvailable } from "../src/host/glOptionalDep.js";
import { getCPUState } from "../src/host/cpu-state.js";

function countNonBlack(rgba) {
  let nz = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] || rgba[i + 1] || rgba[i + 2]) nz++;
  }
  return nz;
}

test("N64: parallel_n64 HW-renders a real frame through the GL bridge", { timeout: 180000 }, async () => {
  const core = resolveCore("n64");
  if (!core) { console.log("no n64 core staged; skipping"); return; }
  if (!(await glStackAvailable())) { console.log("native GL stack not installed; skipping N64 run-side"); return; }

  // megatextures is a known-good libdragon 3D demo; fall back to others.
  let rom = null;
  for (const f of ["megatextures-1.0.z64", "paniclab.n64"]) {
    const p = path.join(process.env.HOME, "code/cliemu/homebrew_collection/n64", f);
    try { rom = new Uint8Array(await readFile(p)); break; } catch { /* next */ }
  }
  if (!rom) { console.log("no N64 fixture; skipping"); return; }

  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender });
    await host.loadMedia({ platform: "n64", bytes: rom, virtualName: "/game.z64" });
    assert.ok(host.hwRender?.active, "HW render is active for n64");
    for (let i = 0; i < 240; i++) host.stepFrames(1);
    const lf = host.state.lastFrame;
    assert.ok(lf && lf.rgba, "got a HW-render RGBA frame");
    assert.ok(lf.width >= 256 && lf.height >= 224, `real framebuffer size: ${lf.width}x${lf.height}`);
    const rgba = framebufferToRgba(lf.width, lf.height, lf.pixels, lf.pitch, lf.format);
    const nz = countNonBlack(rgba);
    assert.ok(nz > lf.width * lf.height * 0.1, `frame has real content (not black): ${nz} non-black px`);
    // alpha forced opaque (the FBO leaves alpha=0)
    assert.equal(rgba[3], 0xff, "alpha forced opaque in the decode");

    // cpuState — the R4300 register file (cheat+regsnap-enabled core build).
    if (host.mipsRegsSupported()) {
      const cpu = getCPUState(host, "n64");
      assert.ok(cpu && typeof cpu.pc === "number", "N64 cpuState decodes");
      assert.ok((cpu.registers.sp || "").startsWith("$80") || cpu.pc !== 0, "registers look like real RDRAM state");
      assert.equal(Object.keys(cpu.registers).length, 34, "32 GPRs + lo + hi");
    }
    // cheats — retro_cheat_set exported.
    if (host.cheatsSupported()) {
      host.setCheat(0, "80100000 0042", true); // GameShark-style; should not throw
    }
  } finally {
    host.dispose?.();
  }
});

test("PS1: pcsx_rearmed (HLE, no BIOS) boots + presents a frame", { timeout: 120000 }, async () => {
  const core = resolveCore("ps1");
  if (!core) { console.log("no ps1 core staged; skipping"); return; }

  // A minimal PS-EXE: header + MIPS that drives the GPU to fill the screen.
  const dir = await mkdtemp(path.join(tmpdir(), "ps1-run-"));
  try {
    const LOAD = 0x80010000;
    const code = [];
    const w = (v) => code.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    w(0x3c081f80); w(0x34090000); w(0xad091814); // lui t0,1F80; GP1 reset
    w(0x3c090300); w(0xad091814);                 // GP1(03) display enable
    w(0x3c090240); w(0x352980ff); w(0xad091810);  // GP0 fill cmd + color
    w(0xad001810);                                // xy=0
    w(0x3c090100); w(0x35290140); w(0xad091810);  // wh
    w(0x1000ffff); w(0x00000000);                 // loop
    const codeBuf = Uint8Array.from(code);
    const exe = new Uint8Array(2048 + codeBuf.length);
    exe.set(new TextEncoder().encode("PS-X EXE"), 0);
    const put = (o, v) => { exe[o] = v & 0xff; exe[o + 1] = (v >> 8) & 0xff; exe[o + 2] = (v >> 16) & 0xff; exe[o + 3] = (v >>> 24) & 0xff; };
    put(0x10, LOAD); put(0x18, LOAD); put(0x1c, (codeBuf.length + 3) & ~3); put(0x30, 0x801ffff0);
    exe.set(codeBuf, 2048);
    const p = path.join(dir, "test.exe");
    await writeFile(p, exe);

    const host = new LibretroHost();
    try {
      await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender });
      await host.loadMedia({ platform: "ps1", path: p });
      for (let i = 0; i < 180; i++) host.stepFrames(1);
      const lf = host.state.lastFrame;
      assert.ok(lf, "PS1 presented a frame");
      assert.ok(lf.width > 0 && lf.height > 0, `real framebuffer: ${lf.width}x${lf.height}`);

      // cpuState — the R3000 register file.
      if (host.mipsRegsSupported()) {
        const cpu = getCPUState(host, "ps1");
        assert.ok(cpu && typeof cpu.pc === "number", "PS1 cpuState decodes");
        assert.equal(Object.keys(cpu.registers).length, 34, "32 GPRs + lo + hi");
        // our test PS-EXE sets sp = 0x801FFFF0; the running PC should be in its code.
        assert.match(cpu.registers.sp, /^\$80/, "sp is in PS1 main RAM");
      }
      if (host.cheatsSupported()) host.setCheat(0, "80100000 0042", true);
    } finally {
      host.dispose?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

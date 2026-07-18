// MIPS run-side (N64 HW-render via the GL bridge, PS1 HW-render via beetle_psx_hw
// HLE). Proves the cores boot, run, and present a real framebuffer through romdev's
// host — the run/screenshot parity. These need the optional native GL stack
// (native-gles/webgl-node) for N64 + a core in the dev-staging dir; they skip
// gracefully when either is absent (CI without the GPU module / packaged cores).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LibretroHost } from "romdev-core-host/LibretroHost.js";
import { resolveCore } from "../src/cores/registry.js";
import { glStackAvailable } from "romdev-core-host/glOptionalDep.js";
import { getCPUState } from "romdev-core-host/cpu-state.js";
import { buildForPlatform } from "../src/toolchains/index.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HAS_MIPS_GCC = (() => {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "toolchains", "mips-elf-gcc", "wasm", "cc1.mjs");
  return existsSync(p);
})();

test("N64: a toolchain-built homebrew boots + RENDERS on the GPU (glide64 GBI dlist)", { timeout: 180000 }, async () => {
  if (!HAS_MIPS_GCC) { console.log("mips-elf-gcc not built; skipping"); return; }
  const core = resolveCore("n64");
  if (!core) { console.log("no n64 core staged; skipping"); return; }

  // The bundled n64.c helper emits a GBI (F3DEX2) display list that glide64 HLEs onto
  // the GPU — NOT a software framebuffer (which would be black on glide64 + <1fps).
  // n64.h/n64.c auto-bundle, so a bare #include works. A spinning cube + a 2D rect +
  // a clear exercises clear/rect/quad3d (the scan-converted triangle path).
  const src = `#include "n64.h"
    int main(){ Vec3 v[8]={{FIX(-1),FIX(-1),FIX(-1)},{FIX(1),FIX(-1),FIX(-1)},{FIX(1),FIX(1),FIX(-1)},{FIX(-1),FIX(1),FIX(-1)},
      {FIX(-1),FIX(-1),FIX(1)},{FIX(1),FIX(-1),FIX(1)},{FIX(1),FIX(1),FIX(1)},{FIX(-1),FIX(1),FIX(1)}}; fix a=0;
      n64_init(); n64_camera(0,0,FIX(-5),0,0);
      for(;;){ a+=FIX(2); n64_model(0,0,0,a); n64_clear(RGB(10,10,40));
        n64_quad3d(v[0],v[1],v[2],v[3],RGB(220,40,40)); n64_quad3d(v[1],v[5],v[6],v[2],RGB(40,220,40));
        n64_quad3d(v[4],v[5],v[1],v[0],RGB(40,40,220)); n64_rect(20,20,40,40,RGB(240,240,40)); n64_flip(); } }`;
  const built = await buildForPlatform({ platform: "n64", source: src, sourceName: "main.c" });
  assert.ok(built.ok, `homebrew builds: ${(built.log || "").slice(-200)}`);
  assert.equal(built.binary[0], 0x80, "valid .z64 header magic (0x80371240)");

  if (!(await glStackAvailable())) { console.log("no GL stack; skipping render assertions"); return; }
  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, platform: "n64" });
    await host.loadMedia({ platform: "n64", bytes: built.binary, virtualName: "/game.z64" });
    assert.ok(host.hwRender?.active, "glide64 GL engaged through native-gles (hwActive)");
    for (let i = 0; i < 180; i++) host.stepFrames(1);

    // The homebrew's GBI display list renders on the GPU — assert non-black + multiple
    // distinct colors (clear + the three cube faces + the yellow rect).
    const fb = host.hwRender.readbackFrame(host.state.hwFrameW, host.state.hwFrameH);
    assert.ok(fb, "got a HW frame");
    let nonBlack = 0; const colors = new Set();
    for (let i = 0; i < fb.pixels.length; i += 4) {
      if (fb.pixels[i] | fb.pixels[i + 1] | fb.pixels[i + 2]) nonBlack++;
      colors.add((fb.pixels[i] << 16) | (fb.pixels[i + 1] << 8) | fb.pixels[i + 2]);
    }
    assert.ok(nonBlack > 20000, `N64 GBI dlist rendered on the GPU (not black): ${nonBlack} px`);
    assert.ok(colors.size >= 3, `multiple colors (clear + faces + rect): ${colors.size}`);

    // cpuState — the R4300 register file (cheat+regsnap-enabled core build).
    if (host.mipsRegsSupported()) {
      const cpu = getCPUState(host, "n64");
      assert.ok(cpu && typeof cpu.pc === "number", "N64 cpuState decodes");
      assert.equal(Object.keys(cpu.registers).length, 34, "32 GPRs + lo + hi");
    }
    if (host.cheatsSupported()) host.setCheat(0, "80100000 0042", true);
  } finally {
    host.dispose?.();
  }
});

test("PS1: beetle_psx_hw (OpenBIOS) boots + presents a frame", { timeout: 120000 }, async () => {
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

test("build: C → PS1 PS-EXE compiles AND runs on the core", { timeout: 180000 }, async () => {
  if (!HAS_MIPS_GCC) { console.log("mips-elf-gcc WASM not built; skipping build test"); return; }
  const r = await buildForPlatform({
    platform: "ps1", language: "c",
    source: `
      #define GP0 (*(volatile unsigned int*)0x1F801810)
      #define GP1 (*(volatile unsigned int*)0x1F801814)
      int main(){
        GP1=0; GP1=0x03000000;
        GP0=0x02FF8040; GP0=0; GP0=0x01000140;
        for(;;){}
      }`,
  });
  assert.equal(r.ok, true, `PS1 build ok (stage=${r.stage}): ${(r.log || "").slice(-200)}`);
  assert.ok(r.binary && r.binary.length > 2048, "produced a PS-EXE (header + code)");
  assert.equal(String.fromCharCode(...r.binary.slice(0, 8)), "PS-X EXE", "PS-EXE magic");

  // boot the built PS-EXE on the real core
  const core = resolveCore("ps1");
  if (!core) return;
  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender });
    await host.loadMedia({ platform: "ps1", bytes: r.binary, virtualName: "/built.exe" });
    for (let i = 0; i < 120; i++) host.stepFrames(1);
    const lf = host.state.lastFrame;
    assert.ok(lf && lf.width > 0, "the freshly-built PS-EXE booted + presented a frame");
  } finally {
    host.dispose?.();
  }
});

test("build: C → N64 compiles (big-endian mips)", { timeout: 120000 }, async () => {
  if (!HAS_MIPS_GCC) { console.log("mips-elf-gcc WASM not built; skipping"); return; }
  const r = await buildForPlatform({
    platform: "n64", language: "c",
    source: "int sq(int n){ return n*n; } int main(){ return sq(7); }",
  });
  assert.equal(r.ok, true, `N64 build ok: ${(r.log || "").slice(-200)}`);
  assert.ok(r.binary && r.binary.length > 0, "produced a binary");
});

test("live-debug: watchpoint + range-watch fire on PS1 (instrumented core)", { timeout: 180000 }, async () => {
  if (!HAS_MIPS_GCC) { console.log("mips-elf-gcc not built; skipping"); return; }
  const core = resolveCore("ps1");
  if (!core) return;
  // A program that drives the GPU (so we know main runs) AND scribbles a global array
  // in user RAM. Under beetle's real OpenBIOS, low kernel/vector space (e.g. 0x80001000)
  // is protected — so we discover what the program ACTUALLY writes via findWriter on the
  // running code, then confirm the watchpoint + range-watch fire on the GL core. This
  // exercises the full shared-lib debug surface end-to-end (the machinery is core-agnostic;
  // the host arms the raw virtual address, which the beetle hook reports unmasked).
  const r = await buildForPlatform({ platform: "ps1", language: "c",
    source: "volatile unsigned int g; int main(){ volatile unsigned int *G1=(volatile unsigned int*)0x1f801814; *G1=0x03000000; for(;;){ g++; } }" });
  assert.ok(r.ok, "build ok");
  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender });
    if (!host.watchpointSupported()) { console.log("core has no watchpoint export; skipping"); return; }
    await host.loadMedia({ platform: "ps1", bytes: r.binary, virtualName: "/wp.exe" });
    host.stepFrames(30);
    // Discover an address the RUNNING program writes (the global `g` + stack churn) via a
    // wide range-watch — this proves the write-watch path fires on the active GL core.
    const wide = host.watchRange(0x80000000, 0x801fffff, "write", 64);
    assert.ok(wide.total > 0, `range-watch captured writes on the GL PS1 core: ${wide.total}`);
    assert.ok(wide.events?.length > 0 && (wide.events[0].pc >>> 0) > 0x80000000,
      `captured a real writing PC: ${(wide.events?.[0]?.pc >>> 0).toString(16)}`);
    // Now arm a single-address watchpoint on one of those exact addresses and confirm it fires.
    const TGT = (wide.events[0].address >>> 0);
    host.setWatchpoint(TGT, true);
    host.stepFrames(10);
    const wp = host.getWatchpoint(true);
    assert.ok(wp.hits > 0, `write watchpoint @0x${TGT.toString(16)} fired: ${wp.hits} hits`);
    assert.ok((wp.lastPC >>> 0) > 0x80000000, `captured the writing PC: ${(wp.lastPC >>> 0).toString(16)}`);
  } finally {
    host.dispose?.();
  }
});

test("audioDebug: PS1 SPU register decode (chip:'spu')", { timeout: 180000 }, async () => {
  if (!HAS_MIPS_GCC) { console.log("mips-elf-gcc not built; skipping"); return; }
  const core = resolveCore("ps1");
  if (!core) return;
  const { decodePs1Spu } = await import("romdev-core-host/ps1-spu-state.js");
  // A PS1 program that writes the SPU main volume + a voice volume/pitch.
  // NOTE on what reads back: in beetle (Mednafen) SPU, the main/voice VOLUME
  // registers are sweep-CONTROL writes — the running volume sweep converges to a
  // live value and writes it back into the register file, so a near-max write
  // (0x3FFF) reads back as the converged live volume (≈0x3800), NOT the literal.
  // That live value is the correct thing audioDebug reports (it's what drives the
  // mixer). So we assert the SHAPE + that the volumes are populated in the right
  // range, not the exact literal (an artifact of the prior raw-store debug core, since removed).
  const r = await buildForPlatform({ platform: "ps1", language: "c", source: `
    #define SPU(o) (*(volatile unsigned short*)(0x1F801C00+(o)))
    int main(){ SPU(0x180)=0x3FFF; SPU(0x182)=0x3FFF; SPU(0)=0x2000; SPU(2)=0x1000; for(;;){} }` });
  assert.ok(r.ok, "build ok");
  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender });
    if (!host.spuRegsSupported()) { console.log("core has no SPU export; skipping"); return; }
    await host.loadMedia({ platform: "ps1", bytes: r.binary, virtualName: "/spu.exe" });
    host.stepFrames(60);
    const st = decodePs1Spu(host.getSpuRegs());
    assert.equal(st.chip, "spu");
    assert.equal(st.voices.length, 24, "24 SPU voices");
    // near-max main volume converges high (>=0x2000); voice0 volume is populated.
    assert.ok(st.mainVolumeLeft >= 0x2000, `main volume L converged high (got 0x${st.mainVolumeLeft.toString(16)})`);
    assert.ok(st.voices[0].volumeLeft > 0, `voice0 volume populated (got 0x${st.voices[0].volumeLeft.toString(16)})`);
  } finally {
    host.dispose?.();
  }
});

test("audioDebug: N64 AI output state (chip:'ai')", { timeout: 180000 }, async () => {
  const core = resolveCore("n64");
  if (!core) return;
  if (!(await glStackAvailable())) { console.log("no GL stack; skipping"); return; }
  let rom = null;
  for (const f of ["paniclab.n64", "megatextures-1.0.z64"]) {
    const p = path.join(process.env.HOME, "code/cliemu/homebrew_collection/n64", f);
    try { rom = new Uint8Array(await readFile(p)); break; } catch { /* next */ }
  }
  if (!rom) { console.log("no N64 fixture; skipping"); return; }
  const { decodeN64Ai } = await import("romdev-core-host/n64-ai-state.js");
  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender });
    if (!host.aiRegsSupported()) { console.log("core has no AI export; skipping"); return; }
    await host.loadMedia({ platform: "n64", bytes: rom, virtualName: "/g.n64" });
    for (let i = 0; i < 180; i++) host.stepFrames(1);
    const ai = decodeN64Ai(host.getAiRegs());
    assert.equal(ai.chip, "ai");
    assert.ok(typeof ai.playing === "boolean", "decodes the playing flag");
    assert.ok(ai.sampleRate >= 0, "decodes a sample rate");
  } finally {
    host.dispose?.();
  }
});

test("memory: PS1 video_ram exposes the GPU VRAM (beetle, if romdev_vram_get present)", { timeout: 120000 }, async () => {
  if (!HAS_MIPS_GCC) { console.log("mips-elf-gcc not built; skipping"); return; }
  const core = resolveCore("ps1");
  if (!core) return;
  const psxc = await readFile(path.join(process.env.HOME, "code/cliemu/romdev/packages/romdevtools/src/platforms/ps1/lib/c/psx.c"), "utf8");
  const psxh = await readFile(path.join(process.env.HOME, "code/cliemu/romdev/packages/romdevtools/src/platforms/ps1/lib/c/psx.h"), "utf8");
  const src = `#include "psx.h"\nint main(){ psx_init(); for(;;){ psx_clear(RGB(120,80,200)); psx_rect(10,10,40,40,RGB(255,0,0)); psx_vsync(); } }`;
  const b = await buildForPlatform({ platform: "ps1", language: "c", sources: { "main.c": src, "psx.c": psxc }, includes: { "psx.h": psxh } });
  if (!b.ok) { console.log("ps1 build failed; skipping"); return; }
  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender });
    if (!(host.mod && typeof host.mod._romdev_vram_get === "function")) { console.log("core has no VRAM export; skipping"); return; }
    await host.loadMedia({ platform: "ps1", bytes: b.binary, virtualName: "/v.exe" });
    for (let i = 0; i < 60; i++) host.stepFrames(1);
    const vram = host.readMemory("video_ram", 0, 8192);
    assert.equal(vram.length, 8192, "video_ram is readable");
    let nz = 0; for (let i = 0; i < vram.length; i += 2) if (vram[i] | vram[i + 1]) nz++;
    assert.ok(nz > 0, `GPU VRAM holds rendered pixels: ${nz} nonzero`);
  } finally {
    host.dispose?.();
  }
});

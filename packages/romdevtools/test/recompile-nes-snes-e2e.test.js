// NES→SNES recompile — end-to-end gate. Builds the NES default scaffold,
// disassembles its reset routine (real da65 6502 output), translates it to
// 65816, and assembles the result with asar into a valid LoROM image. Then
// boots the image in snes9x and asserts the CPU progressed PAST the boot
// wait-loop — proving the recompiled 6502 logic runs in 65816 emulation mode
// and the $2002-returns-$80 seam detail lets vblank-wait loops terminate.
//
// This is the standing acceptance gate (MCP-server-side path, per convention).
// It exercises the rizin-free pieces: build → da65 → translate → asar → boot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore } from "../src/mcp/tools/toolchain.js";
import { runDa65 } from "../src/toolchains/cc65/da65.js";
import { runAsar } from "../src/toolchains/asar/asar.js";
import { recompileNesToSnes, sliceFirstRoutine } from "../src/analysis/recompile-65816.js";
import { resolveCore } from "../src/cores/registry.js";
import { resetHost, clearHost } from "../src/mcp/state.js";

const parse = (r) => JSON.parse(r.content[0].text);

test("NES reset routine recompiles to a booting SNES LoROM image", { timeout: 300000 }, async () => {
  const key = "recompile-e2e";
  const root = await mkdtemp(path.join(tmpdir(), "recompile-e2e-"));
  try {
    // 1. Build the NES default scaffold.
    const proj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: proj, template: "default", overwrite: true });
    const nesRom = path.join(root, "in.nes");
    const build = parse(await buildProjectCore({ path: proj, platform: "nes", outputPath: nesRom }));
    assert.equal(build.ok, true, `NES build failed: ${(build.logTail || "").slice(-300)}`);

    // 2. Disassemble the reset routine: PRG starts at file offset 0x10 ($8000).
    const nes = new Uint8Array(await readFile(nesRom));
    const prg = nes.subarray(0x10, 0x10 + 0x8000); // 32KB NROM PRG
    const da = await runDa65({ bytes: prg, cpu: "6502", startAddress: 0x8000, options: ["--comments", "4"] });
    const da65Full = da.asm ?? da.output ?? "";
    assert.ok(/sei/i.test(da65Full), "da65 produced 6502 asm");
    // Slice the first routine (the reset path) — a flat full-PRG disasm renders
    // the data tables after it as bogus code (M0 audit). M1 = one clean routine.
    const da65Asm = sliceFirstRoutine(da65Full);

    // 3. Translate → 65816 (orchestrator: derive entry, stub callees, wrap).
    const { mainAsm, seamAsm, residue, entry, instrCount, seamCount } = recompileNesToSnes(da65Asm);
    // The reset routine is ~44 instructions ending in `jmp L8000` (the main
    // loop); its jsr callees are stubbed in this M1 isolation slice.
    assert.ok(instrCount >= 40, `translated the reset routine: ${instrCount} instrs`);
    assert.ok(seamCount > 0, `seam accesses rewritten: ${seamCount}`);
    assert.ok(entry, `derived an entry label: ${entry}`);

    // 4. Assemble with asar.
    const asar = await runAsar({ source: mainAsm, includes: { "nes_seam.asm": seamAsm } });
    assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 600)}`);
    assert.ok(asar.binary && asar.binary.length > 0, "asar produced a LoROM image");

    // 5. Boot in snes9x and confirm the CPU escaped the boot wait-loop.
    const sfc = path.join(root, "out.sfc");
    await (await import("node:fs/promises")).writeFile(sfc, Buffer.from(asar.binary));
    const core = resolveCore("snes");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform: "snes", bytes: new Uint8Array(asar.binary), virtualName: "/rom.sfc" });
    host.stepFrames(90);

    // The boot wait-loops live at ~$8016/$801B. If the $2002 seam returned 0
    // the PC would be pinned there forever. Sample across a few steps: the PC
    // must move AND clear the wait-loop region at least once. Register id 16 is
    // the main-CPU PC for snes9x (verified: getReg(16) → numeric PC).
    const pcs = [];
    for (let i = 0; i < 5; i++) {
      let pc = null;
      try { pc = host.getReg(16); } catch { /* core may not expose it */ }
      if (pc != null) pcs.push(pc);
      host.stepFrames(15);
    }
    assert.ok(pcs.length > 0, "got CPU PC samples");
    const escapedBootLoop = pcs.some((pc) => pc < 0x8016 || pc > 0x8020);
    assert.ok(escapedBootLoop, `CPU progressed past the boot wait-loop; PCs seen: ${pcs.map((p) => "$" + p.toString(16)).join(", ")}`);

    // Residue is allowed (data tails / indirect jumps) but must be reported, not silent.
    assert.ok(Array.isArray(residue), "residue is reported");
  } finally {
    clearHost(key);
    await rm(root, { recursive: true, force: true });
  }
});

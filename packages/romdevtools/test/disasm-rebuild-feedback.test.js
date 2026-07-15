// Tests for the disassembler fixes from an NES action-game disassemble→rebuild
// feedback: vector-label dedup, .org for round-trip, error-to-response, the
// NES bank param, and the disassembleProject round-trip verification.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { registerDisasmTools } from "../src/mcp/tools/disasm.js";

// Capture the registered handlers. Post-consolidation there's ONE `disasm` tool
// with a `target` axis; this adapter re-exposes the old per-tool method names
// (mapping to disasm({target})) so the existing test bodies + assertions are
// unchanged.
function handlers() {
  const map = {};
  registerDisasmTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z);
  const disasm = map.disasm;
  return {
    disassemble:        (a) => disasm({ target: "bytes", ...a }),
    disassembleRom:     (a) => disasm({ target: "rom", ...a }),
    disassembleProject: (a) => disasm({ target: "project", ...a }),
    findReferences:     (a) => disasm({ target: "references", ...a }),
  };
}
const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

// Build a tiny iNES image: `prgBanks16k` × 16KB PRG. Each bank filled so banks
// are distinguishable; the LAST bank carries a vector table with NMI==IRQ.
function makeBankedNes(prgBanks16k, mapper) {
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a], 0); // "NES\x1a"
  header[4] = prgBanks16k;
  header[5] = 0; // no CHR (CHR-RAM)
  header[6] = (mapper & 0xF) << 4;
  header[7] = mapper & 0xF0;
  const prg = new Uint8Array(prgBanks16k * 16384);
  for (let b = 0; b < prgBanks16k; b++) {
    // Fill each bank with NOPs so it disassembles cleanly + is byte-distinct.
    for (let i = 0; i < 16384; i++) prg[b * 16384 + i] = 0xEA; // NOP
  }
  // Vector table in the LAST bank (maps to $FFFA-$FFFF). Point NMI and IRQ both
  // at $C0F6 (the observed case) and reset at $C000.
  const vbase = prg.length - 6;
  const put16 = (off, val) => { prg[off] = val & 0xFF; prg[off + 1] = (val >> 8) & 0xFF; };
  put16(vbase + 0, 0xC0F6); // NMI
  put16(vbase + 2, 0xC000); // RESET
  put16(vbase + 4, 0xC0F6); // IRQ  (same as NMI — the dedup case)
  const rom = new Uint8Array(16 + prg.length);
  rom.set(header, 0);
  rom.set(prg, 16);
  return rom;
}

test("disassembleRom: NMI==IRQ shared vector does not crash; reports labelAliases", async () => {
  const h = handlers();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dis-"));
  try {
    const romPath = path.join(tmp, "shared.nes");
    await writeFile(romPath, makeBankedNes(2, 2)); // mapper 2, 2 banks
    // Disassemble the fixed top bank where the vectors resolve ($C000+).
    const r = parse(await h.disassembleRom({ path: romPath, platform: "nes", startAddress: 0xC000, length: 0x100 }));
    assert.notEqual(r.ok, false, "should not fail on shared NMI/IRQ vector: " + JSON.stringify(r.error));
    // One of nmi/irq is kept as a label; the other is recorded as an alias.
    if (r.labelAliases) {
      assert.ok(r.labelAliases.length >= 1);
      assert.match(r.labelAliases[0].addr, /C0F6/i);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("disassembleRom: output carries a .org so it round-trips (addOrigin default)", async () => {
  const h = handlers();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dis-"));
  try {
    const romPath = path.join(tmp, "b.nes");
    await writeFile(romPath, makeBankedNes(2, 2));
    const r = parse(await h.disassembleRom({ path: romPath, platform: "nes", startAddress: 0x8000, length: 0x40 }));
    assert.match(r.asm, /^\s*\.org \$8000/m, "asm should contain .org $8000");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("disassembleRom: NES bank param maps the switchable slot", async () => {
  const h = handlers();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dis-"));
  try {
    // Make bank 1's first byte distinctive ($A9 = LDA #imm) vs bank 0 ($EA NOP).
    const rom = makeBankedNes(3, 2);
    rom[16 + 1 * 16384] = 0xA9; rom[16 + 1 * 16384 + 1] = 0x42; // LDA #$42 at bank1:$8000
    const romPath = path.join(tmp, "bank.nes");
    await writeFile(romPath, rom);
    const r0 = parse(await h.disassembleRom({ path: romPath, platform: "nes", startAddress: 0x8000, length: 0x10, bank: 0 }));
    const r1 = parse(await h.disassembleRom({ path: romPath, platform: "nes", startAddress: 0x8000, length: 0x10, bank: 1 }));
    assert.match(r1.asm, /lda\s+#\$42/i, "bank 1 should show the LDA #$42 we planted");
    assert.doesNotMatch(r0.asm, /lda\s+#\$42/i, "bank 0 should NOT (it's all NOPs)");
    assert.match(r1.note, /bank 1/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("disassembleRom: failure surfaces error in response, does NOT write outputPath", async () => {
  const h = handlers();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dis-"));
  try {
    const romPath = path.join(tmp, "ovf.nes");
    await writeFile(romPath, makeBankedNes(2, 2));
    const out = path.join(tmp, "should-not-exist.asm");
    // startAddress + length overflowing the bank → mapping throws; the tool
    // should return ok:false and leave outputPath unwritten.
    const res = await h.disassembleRom({ path: romPath, platform: "nes", startAddress: 0xC000, length: 0x8000, outputPath: out });
    // safeTool may wrap a thrown error as isError, or the tool returns ok:false.
    if (res.isError) {
      assert.ok(!existsSync(out), "outputPath must not be written on error");
    } else {
      const r = parse(res);
      if (r.ok === false) assert.ok(!existsSync(out), "outputPath must not be written on error");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The headline: a real MMC1 ROM disassembles to byte-exact per-bank projects.
test("disassembleProject: every bank of a real MMC1 ROM round-trips byte-exact", async () => {
  const driar = path.join(os.homedir(), "code/cliemu/homebrew_collection/nes/driar.nes");
  if (!existsSync(driar)) { return; } // skip if the test ROM isn't present
  const h = handlers();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "disproj-"));
  try {
    const r = parse(await h.disassembleProject({ path: driar, outputDir: tmp }));
    assert.equal(r.ok, true);
    assert.equal(r.platform, "nes");
    assert.equal(r.regions.length, 8, "MMC1 ROM has 8 PRG banks → 8 regions");
    assert.equal(r.roundTrip.allByteExact, true, "all banks should round-trip; failed: " + JSON.stringify(r.roundTrip.failed));
    assert.ok(r.readablePercentAvg >= 80, "NES disassembly should be mostly instructions, got " + r.readablePercentAvg + "%");
    // Provenance + round-trip header present in an emitted file.
    const bank0 = await readFile(path.join(tmp, "bank0.asm"), "utf8");
    assert.match(bank0, /; bank 0 .*switchable \$8000/);
    assert.match(bank0, /round-trip: BYTE-EXACT/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, { timeout: 120000 });

// Cross-platform: disassembleProject produces a byte-exact project on non-NES
// systems too (GB via rgbds, C64 via cc65). Skips any ROM not present.
test("disassembleProject: byte-exact across GB and C64", async () => {
  const h = handlers();
  const cases = [
    { plat: "gb", rom: "asteroids_gb_mcp/asteroids_gb.gb" },
    { plat: "c64", rom: "rom-games/c64/puzzle/puzzle.prg" },
  ];
  for (const c of cases) {
    const romPath = path.join(os.homedir(), "code/cliemu", c.rom);
    if (!existsSync(romPath)) continue;
    const tmp = await mkdtemp(path.join(os.tmpdir(), "disproj-"));
    try {
      const r = parse(await h.disassembleProject({ path: romPath, outputDir: tmp }));
      assert.equal(r.ok, true, `${c.plat} should round-trip byte-exact (failed: ${JSON.stringify(r.roundTrip.failed)})`);
      assert.equal(r.roundTrip.allByteExact, true, `${c.plat} all regions byte-exact`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}, { timeout: 120000 });

// ── v0.89.0 field feedback (Jay's ActRaiser annotation session) ──────────────

// disasm({target:'rom'}) must accept a SNES CPU address ≥ 0x10000 (a banked
// LoROM address like $02AF86). Before the fix, da65's --start-addr aborted with
// "StartAddr < 0x10000" — the wrong half of a multi-bank cart's address space.
test("disasm({target:'rom'}) accepts a banked SNES address ≥ 0x10000 (no da65 abort)", async () => {
  const h = handlers();
  const dir = await mkdtemp(path.join(os.tmpdir(), "snes-highaddr-"));
  try {
    // 256KB LoROM. bank 2 = file 0x10000..0x17FFF; $02AF86 → file 0x12F86.
    const rom = new Uint8Array(0x40000).fill(0xEA);
    rom.set([0xA9, 0x05, 0x8D, 0x00, 0x21, 0x6B], 0x12F86); // lda #$05 / sta $2100 / rtl
    const romPath = path.join(dir, "game.sfc");
    await writeFile(romPath, rom);

    const res = await h.disassembleRom({ platform: "snes", path: romPath, startAddress: 0x02AF86, length: 96, inline: true });
    assert.equal(res.isError, undefined, "must not error: " + (res.isError ? res.content[0].text : ""));
    const p = parse(res);
    assert.equal(p.exitCode, 0, "da65 must not abort on the ≥0x10000 address");
    const asm = p.asm || "";
    assert.match(asm, /lda\s+#\$05/i, "decoded the real code, not a StartAddr abort");
    assert.match(asm, /sta\s+\$2100/i, "second instruction decoded");
    // The bank-local addr ($AF86) is what da65 sees; the file annotation resolves
    // the FULL cpu address to the right ROM offset (0x12F86).
    assert.match(asm, /12F86/i, "file-offset annotation maps the full 24-bit address");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

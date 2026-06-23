// NES→SNES recompiler robustness — tool-level gate. Drives
// disasm({target:'recompile'}) on synthetic ROMs to prove:
//   1. it disassembles from the REAL reset vector (not blindly $8000), so a
//      reset routine placed away from the PRG base is found + recompiled;
//   2. out-of-scope ROMs (mapped carts, wrong size, non-iNES) fail with a CLEAR,
//      specific error instead of crashing asar or emitting un-assemblable asm.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { runAsar } from "../src/toolchains/asar/asar.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z);
  return map[toolName];
}

/** Build a 32KB-PRG NROM .nes with the reset routine at `resetAddr`. */
function nromRom({ resetAddr = 0x8000, code = [], mapper = 0, prgSize = 0x8000 } = {}) {
  const prg = new Uint8Array(prgSize); // $00 = brk padding
  const off = resetAddr - 0x8000;
  prg.set(code, off);
  const setW = (o, v) => { prg[o] = v & 0xff; prg[o + 1] = (v >> 8) & 0xff; };
  setW(prgSize - 6, resetAddr); // NMI
  setW(prgSize - 4, resetAddr); // RESET
  setW(prgSize - 2, resetAddr); // IRQ
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, prgSize / 0x4000, 0]);
  header[6] = (mapper & 0x0f) << 4;
  header[7] = mapper & 0xf0;
  const out = new Uint8Array(16 + prg.length);
  out.set(header); out.set(prg, 16);
  return out;
}

// A minimal but real boot routine: sei/cld, write a PPU reg, vblank-wait, spin.
const BOOT = [
  0x78,             // sei
  0xd8,             // cld
  0xa9, 0x00,       // lda #$00
  0x8d, 0x00, 0x20, // sta $2000   (seam)
  0x2c, 0x02, 0x20, // bit $2002   (seam read)
  0x10, 0xfb,       // bpl -5
  0x4c, 0x00, 0x00, // jmp (patched below to self)
];

test("recompile follows the reset vector when the routine is NOT at $8000", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recompile-rv-"));
  try {
    const resetAddr = 0x8100;
    const code = [...BOOT];
    // patch the trailing jmp to spin on itself (jmp $810C) — keeps the slice tidy
    const jmpAt = resetAddr + (code.length - 3);
    code[code.length - 2] = jmpAt & 0xff;
    code[code.length - 1] = (jmpAt >> 8) & 0xff;
    const romPath = path.join(dir, "offset.nes");
    await writeFile(romPath, nromRom({ resetAddr, code }));

    const disasm = toolHandler(registerDisasmTools, "disasm");
    const r = parse(await disasm({ target: "recompile", platform: "nes", path: romPath }));
    assert.equal(r.ok, true);
    assert.equal(r.resetVector, "$8100", "reported the real reset vector");
    // Found the actual routine (sei/cld/lda/sta/bit/bpl/jmp ≈ 7 instrs), not the
    // 6 garbage `brk`s the old $8000-start produced.
    assert.ok(r.instrCount >= 6, `recompiled the real boot routine: ${r.instrCount} instrs`);
    assert.ok(r.seamCount >= 2, `seam accesses translated: ${r.seamCount}`);
    assert.equal(r.residue.length, 0, `clean translation, no residue: ${JSON.stringify(r.residue)}`);

    // And the entry anchors to the routine's OPENING instruction — the emitted
    // main.asm must contain the reset handoff + the entry label before the body.
    assert.ok(r.mainAsm, "returned inline mainAsm (no outputDir)");
    assert.match(r.mainAsm, /jmp\s+RECOMPILE_ENTRY/, "reset handoff targets the injected entry");
    assert.match(r.mainAsm, /RECOMPILE_ENTRY:\n\s+sei/, "entry sits at the opening sei");

    // It must actually assemble.
    const asar = await runAsar({ source: r.mainAsm, includes: { "nes_seam.asm": r.seamAsm } });
    assert.equal(asar.exitCode, 0, `asar build of the offset-reset port: ${(asar.log || "").slice(0, 300)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recompile rejects out-of-scope ROMs with clear, specific errors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recompile-reject-"));
  const disasm = toolHandler(registerDisasmTools, "disasm");
  // The tool wrapper catches thrown errors and returns them as { isError, content }
  // (the MCP convention) — assert on that, not a thrown rejection.
  const expectError = async (bytes, name, re) => {
    const p = path.join(dir, name);
    await writeFile(p, bytes);
    const res = await disasm({ target: "recompile", platform: "nes", path: p });
    assert.equal(res.isError, true, `${name} should be flagged isError`);
    const msg = res.content.find((c) => c.type === "text")?.text ?? "";
    assert.match(msg, re, `${name} error message: ${msg}`);
  };
  try {
    // mapper 2 (UxROM) — bank-switched, not NROM
    await expectError(nromRom({ mapper: 2, code: [...BOOT] }), "mapper2.nes", /mapper 2 is not supported|only NROM/i);
    // a 24KB PRG (mapper 0 but odd size)
    await expectError(nromRom({ prgSize: 0x6000, code: [...BOOT] }), "odd.nes", /16KB or 32KB|only those two sizes/i);
    // not an iNES file at all
    await expectError(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "garbage.bin", /iNES|NES\\x1a|magic/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

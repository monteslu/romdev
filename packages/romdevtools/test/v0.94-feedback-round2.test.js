// v0.94.0 feedback round 2 (ActRaiser annotation agent, 2026-07-16/17):
//   A1 SNES WRAM mirror aliasing: exact watchpoints armed on $0218 missed
//      `sta f:$7E0218` — the snes9x hook canonicalizes LIVE accesses to $7E
//      form, so the host now canonicalizes the ARMED address too (write, read,
//      and range watches), and results echo armedAddress for transparency.
//   A2 disasm({target:'rom'}) outputPath creates its parent dir (no raw ENOENT).
//   B1 reassemble failures populate issues[] — ANSI stripped, the internal
//      main.s remapped to the region's real file, prepended-line shift applied.
//   B3 disasm({target:'rom'}) widths:{a,i} — explicit entry-width override.
//   B2 memory({op:'readCart', findHex}) — cart byte-pattern scan with mapped
//      CPU addresses.
//   A3.1 frame screenshot crop:{x,y,w,h}.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

import { LibretroHost } from "romdev-core-host/LibretroHost.js";
import { cropPng } from "romdev-core-host/framebuffer.js";
import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { reassembleProjectCore } from "../src/mcp/tools/toolchain.js";
import { _setHostForTest } from "../src/mcp/state.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

// ── A1: WRAM mirror canonicalization ────────────────────────────────────────

test("A1 _canonWatchAddress maps SNES low-mirror forms to the $7E form (and nothing else)", () => {
  const canon = (platform, addr) =>
    LibretroHost.prototype._canonWatchAddress.call({ status: { platform } }, addr);
  assert.equal(canon("snes", 0x0218), 0x7E0218, "bank0 low RAM → $7E form");
  assert.equal(canon("snes", 0x3F0218), 0x7E0218, "bank $3F mirror → $7E form");
  assert.equal(canon("snes", 0x810218), 0x7E0218, "bank $81 mirror → $7E form");
  assert.equal(canon("snes", 0x7E0218), 0x7E0218, "already canonical — unchanged");
  assert.equal(canon("snes", 0x7F1000), 0x7F1000, "bank $7F WRAM high — unchanged");
  assert.equal(canon("snes", 0x002100), 0x002100, "$2100 (PPU reg, not WRAM mirror) — unchanged");
  assert.equal(canon("snes", 0x408000), 0x408000, "bank $40 (no mirror) — unchanged");
  assert.equal(canon("nes", 0x0218), 0x0218, "non-SNES platforms untouched");
});

// ── A2 + B3: disasm rom outputPath mkdir + widths override ──────────────────

test("A2/B3 disasm rom: outputPath parent dir auto-created; widths:{a:16,i:16} forces entry width", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-r2-disasm-"));
  try {
    // Window starts ALREADY in 16-bit mode: lda #$1234 / ldx #$0002 / rts
    const code = [0xA9, 0x34, 0x12, 0xA2, 0x02, 0x00, 0x60];
    const rom = new Uint8Array(0x8000).fill(0xEA);
    rom.set(code, 0);
    const romPath = path.join(dir, "w.sfc");
    await writeFile(romPath, rom);
    const disasm = toolHandler(registerDisasmTools, "disasm", "r2d");

    // outputPath in a directory that does NOT exist yet — must not ENOENT.
    const outPath = path.join(dir, "not", "yet", "made", "win.asm");
    const r = parse(await disasm({
      target: "rom", path: romPath, startAddress: 0x8000, length: code.length,
      widths: { a: 16, i: 16 }, outputPath: outPath,
    }));
    assert.equal(r.ok, true);
    await access(outPath); // exists
    const asm = await readFile(outPath, "utf8");
    assert.match(asm, /#\$1234/i, "forced 16-bit entry — lda #$1234 decodes full-width");
    assert.match(asm, /#\$0002/i, "forced 16-bit index width");

    // Force the WRONG width to prove the override is honored (not re-inferred):
    const wrong = parse(await disasm({
      target: "rom", path: romPath, startAddress: 0x8000, length: code.length,
      widths: { a: 8, i: 8 }, inline: true,
    }));
    assert.doesNotMatch(wrong.asm ?? "", /#\$1234/i, "8-bit override obeyed verbatim — no silent inference");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── B1: reassemble failures → structured issues[] ───────────────────────────

test("B1 reassemble failure populates issues[] with the region's real file, ANSI-free", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-r2-reasm-"));
  try {
    const romLen = 64;
    const original = new Uint8Array(romLen).fill(0xEA);
    await writeFile(path.join(dir, "original.rom"), original);
    // Region asm with an undefined symbol — the exact failure from the field
    // report (renamed a label, missed one reference).
    const asm = `\t.setcpu "6502"\n\t.org $8000\n\tjmp L9999\n`;
    await writeFile(path.join(dir, "bank0.asm"), asm);
    await writeFile(path.join(dir, "reassemble.json"), JSON.stringify({
      platform: "nes",
      romTemplate: "original.rom",
      romLength: romLen,
      regions: [{ file: "bank0.asm", startAddress: 0x8000, byteLength: 16, fileOffset: 0 }],
    }));
    const r = parse(await reassembleProjectCore({ path: dir }));
    assert.equal(r.ok, false);
    const reg = r.regions.find((x) => !x.ok);
    assert.ok(reg, "the failed region is reported");
    assert.ok(Array.isArray(reg.issues) && reg.issues.length > 0, "issues[] is populated on a reassemble failure");
    const iss = reg.issues[0];
    assert.equal(iss.file, "bank0.asm", "the region's REAL source file, not the internal main.s");
    assert.doesNotMatch(JSON.stringify(reg), /\[/, "ANSI color codes stripped");
    assert.doesNotMatch(reg.error, /main\.s/, "error string names the region file too");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── B2: readCart findHex ────────────────────────────────────────────────────

test("B2 readCart findHex maps SNES LoROM hits to bank:addr", async () => {
  const raw = new Uint8Array(0x10000).fill(0x00);
  // pattern `20 3C 87` at file 0x0837 (bank $00:$8837) and 0x8837 (bank $01:$8837)
  raw.set([0x20, 0x3C, 0x87], 0x0837);
  raw.set([0x20, 0x3C, 0x87], 0x8837);
  const host = {
    status: { platform: "snes", loaded: true, frameCount: 0 },
    getCartRom: () => ({ bytes: raw, raw, base: 0, headerSkipped: 0, mapped: true, platform: "snes", note: "test" }),
  };
  _setHostForTest("fhx", host);
  const memory = toolHandler(registerMemoryTools, "memory", "fhx");
  const r = parse(await memory({ op: "readCart", findHex: "20 3C 87" }));
  assert.equal(r.count, 2);
  assert.equal(r.matches[0].fileOffset, "0x837");
  assert.equal(r.matches[0].cpuAddress, "$00:8837", "LoROM file offset → bank:addr done server-side");
  assert.equal(r.matches[1].cpuAddress, "$01:8837");
});

test("B2 readCart findHex on NES maps to bank + the $8000/$C000 window", async () => {
  const prgSize = 32 * 1024;
  const raw = new Uint8Array(16 + prgSize);
  raw.set([0x4E, 0x45, 0x53, 0x1A, 2, 0, 0, 0]);
  raw.set([0xAA, 0xBB, 0xCC], 16 + 0x0123);          // bank 0 → $8123
  raw.set([0xAA, 0xBB, 0xCC], 16 + 0x4000 + 0x0456); // last bank → $C456
  const host = {
    status: { platform: "nes", loaded: true, frameCount: 0 },
    getCartRom: () => ({ bytes: raw.subarray(16), raw, base: 0, headerSkipped: 16, mapped: true, platform: "nes", note: "test" }),
  };
  _setHostForTest("fhn", host);
  const memory = toolHandler(registerMemoryTools, "memory", "fhn");
  const r = parse(await memory({ op: "readCart", findHex: "AABBCC" }));
  assert.equal(r.count, 2);
  assert.equal(r.matches[0].cpuAddress, "$8123");
  assert.equal(r.matches[0].bank, 0);
  assert.equal(r.matches[1].cpuAddress, "$C456", "last PRG bank maps to the fixed $C000 window");
});

// ── A3.1: screenshot crop ───────────────────────────────────────────────────

test("A3.1 cropPng cuts the exact rect (clamped) and keeps pixels", () => {
  const src = new PNG({ width: 10, height: 8 });
  src.data.fill(0);
  const set = (x, y, r) => { const i = (y * 10 + x) * 4; src.data[i] = r; src.data[i + 3] = 255; };
  set(4, 3, 200); // marker inside the crop
  const b64 = PNG.sync.write(src).toString("base64");
  const c = cropPng(b64, { x: 3, y: 2, w: 4, h: 3 });
  assert.equal(c.width, 4);
  assert.equal(c.height, 3);
  const out = PNG.sync.read(Buffer.from(c.base64, "base64"));
  assert.equal(out.data[((1 * 4) + 1) * 4], 200, "marker at (4,3) lands at crop-local (1,1)");
  // clamped: a rect hanging off the edge shrinks, never throws
  const edge = cropPng(b64, { x: 8, y: 6, w: 10, h: 10 });
  assert.equal(edge.width, 2);
  assert.equal(edge.height, 2);
});

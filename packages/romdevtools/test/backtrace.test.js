// Call-stack reconstruction (backtrace.js) — unit + live e2e.
//
// Unit: the 6502 decoder recovers caller PCs from stack bytes (the exact
// convention from the v0.41.0 feedback: return = JSR_addr + 2; the JSR is at
// return-2; validated by the $20 opcode). Live: a PC-break inside a routine
// reached by JSR surfaces a `callStack` whose top frame is the real caller, and
// the byte at that caller PC is a JSR to the broken routine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { decode6502Backtrace, buildBacktrace } from "../src/analysis/backtrace.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";
import { mapNesAddress } from "../src/mcp/tools/disasm.js";

test("decode6502Backtrace recovers caller PCs (return = JSR+2; JSR at return-2)", () => {
  // From the feedback: $01F8/$01F9 → return $8806 → JSR at $8804;
  //                    $01F6/$01F7 → return $B2DB → JSR at $B2D9.
  const page = new Uint8Array(0x100).fill(0xff);
  page[0xf6] = 0xdb; page[0xf7] = 0xb2; // inner frame
  page[0xf8] = 0x06; page[0xf9] = 0x88; // outer frame
  const readByteAt = (a) => (a === 0xb2d9 || a === 0x8804) ? 0x20 : 0xea;
  const frames = decode6502Backtrace(0xf5, page, readByteAt, 8); // SP=$F5 → top at $F6
  assert.equal(frames.length, 2, "two confident frames, no $FF padding noise");
  assert.deepEqual(frames[0], { returnAddr: 0xb2db, callerPc: 0xb2d9, confident: true });
  assert.deepEqual(frames[1], { returnAddr: 0x8806, callerPc: 0x8804, confident: true });
});

test("decode6502Backtrace: best-effort frames when no opcode validator", () => {
  const page = new Uint8Array(0x100).fill(0x00);
  page[0xfe] = 0x34; page[0xff] = 0x82; // return $8234
  const frames = decode6502Backtrace(0xfd, page, null, 8);
  assert.ok(frames.length >= 1);
  assert.equal(frames[0].returnAddr, 0x8234);
  assert.equal(frames[0].callerPc, 0x8232);
  assert.equal(frames[0].confident, false, "unvalidated without a readByteAt");
});

test("buildBacktrace tolerates the '$'-prefixed stack-pointer register format", () => {
  // The host snapshot formats S as "$EF"; buildBacktrace must strip the prefix.
  const page = new Uint8Array(0x100).fill(0xff);
  page[0xf0] = 0x77; page[0xf1] = 0x80; // return $8077 → JSR $8075
  const readMemory = (region, off, len) => {
    assert.equal(region, "system_ram");
    return page.subarray(off - 0x100, off - 0x100 + len);
  };
  const readByteAt = (a) => (a === 0x8075 ? 0x20 : 0xea);
  const bt = buildBacktrace({ platform: "nes", regs: { s: "$EF" }, readMemory, readByteAt });
  assert.ok(bt, "built a backtrace despite the $-prefixed SP");
  assert.equal(bt.isa, "6502");
  assert.equal(bt.frames[0].callerPc, 0x8075);
});

test("buildBacktrace returns null for GBA (ARM uses the link register, not the stack)", () => {
  const bt = buildBacktrace({ platform: "gba", regs: { sp: "$03007F00" }, readMemory: () => new Uint8Array(0) });
  assert.equal(bt, null);
});

test("buildBacktrace: Z80/SM83 family decodes the 2-byte LE call stack", () => {
  // SP points at the topmost return word; CALL frames are 2-byte LE.
  const ram = new Map();
  const put16 = (a, v) => { ram.set(a & 0x1fff, v & 0xff); ram.set((a + 1) & 0x1fff, (v >> 8) & 0xff); };
  put16(0xc100, 0x8234); put16(0xc102, 0x9abc);
  const readCpuWord = (a) => { const lo = ram.get(a & 0x1fff), hi = ram.get((a + 1) & 0x1fff); return (lo == null || hi == null) ? null : (lo | (hi << 8)); };
  // SM83 (GB)
  const gb = buildBacktrace({ platform: "gb", regs: { sp: "$C100" }, readMemory: () => new Uint8Array(0), readCpuWord });
  assert.equal(gb.isa, "sm83");
  assert.deepEqual(gb.frames.map((f) => f.callerPc), [0x8234, 0x9abc]);
  // Z80 (SMS) — same frame format, different isa label
  const sms = buildBacktrace({ platform: "sms", regs: { sp: "$C100" }, readMemory: () => new Uint8Array(0), readCpuWord });
  assert.equal(sms.isa, "z80");
  assert.deepEqual(sms.frames.map((f) => f.callerPc), [0x8234, 0x9abc]);
  // without a word reader, returns null (no crash)
  assert.equal(buildBacktrace({ platform: "gb", regs: { sp: "$C100" }, readMemory: () => new Uint8Array(0) }), null);
});

test("buildBacktrace: m68k decodes the 4-byte big-endian call stack", () => {
  const ram = new Map();
  const put32 = (a, v) => { for (let i = 0; i < 4; i++) ram.set((a + i) & 0xffff, (v >> ((3 - i) * 8)) & 0xff); };
  put32(0xff8000, 0x001234); put32(0xff8004, 0x002000);
  const readCpuLongBE = (a) => { const b = [0, 1, 2, 3].map((i) => ram.get((a + i) & 0xffff)); return b.some((x) => x == null) ? null : (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0); };
  const bt = buildBacktrace({ platform: "genesis", regs: { sp: "$FF8000" }, readMemory: () => new Uint8Array(0), readCpuLongBE });
  assert.equal(bt.isa, "m68k");
  assert.deepEqual(bt.frames.map((f) => f.callerPc), [0x1234, 0x2000]);
  // an ODD return longword is rejected as not-a-real-frame
  put32(0xff8000, 0x001235);
  const odd = buildBacktrace({ platform: "genesis", regs: { sp: "$FF8000" }, readMemory: () => new Uint8Array(0), readCpuLongBE });
  assert.ok(odd.frames.every((f) => (f.callerPc & 1) === 0), "odd addresses are not confident frames");
});

test("live: a PC-break callStack names the real JSR caller on fceumm", { timeout: 120000 }, async () => {
  let romPath = null;
  for (const c of [
    process.env.HOME + "/code/cliemu/space_invaders_nes/space_invaders_nes.nes",
  ]) { try { await readFile(c); romPath = c; break; } catch { /* next */ } }
  if (!romPath) { console.log("no NES ROM fixture; skipping live backtrace"); return; }

  const rom = new Uint8Array(await readFile(romPath));
  const host = new LibretroHost();
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: rom, virtualName: "/rom.nes" });
  host.stepFrames(120);
  if (!host.pcBreakSupported()) { host.unloadMedia(); return; }

  // $99F9 is a routine reached via `jsr $99F9` in this ROM (the NMI call chain).
  const hit = host.runUntilPC(0x99f9, 300);
  assert.equal(hit.hit, true, "broke inside the target routine");
  const regs = host.getPCBreak(false).registersAtHit ?? host.getRegSnapshot(false)?.named;
  assert.ok(regs && regs.s != null, "captured registers (incl. the stack pointer)");

  const cart = host.getCartRom();
  const readByteAt = (a) => { try { const { bytes } = mapNesAddress(cart.raw, a, 1); return bytes?.[0] ?? null; } catch { return null; } };
  const bt = buildBacktrace({ platform: "nes", regs, readMemory: (r, o, l) => host.readMemory(r, o, l), readByteAt });
  assert.ok(bt && bt.frames.length, "recovered at least one call frame");
  const top = bt.frames[0];
  assert.equal(top.confident, true, "top frame validated as a real JSR");
  // The caller PC must hold `jsr $99F9` (opcode $20, LE target $99F9).
  const { bytes } = mapNesAddress(rom, top.callerPc, 3);
  assert.equal(bytes[0], 0x20, "caller PC is a JSR");
  assert.equal(bytes[1] | (bytes[2] << 8), 0x99f9, "JSR targets the broken routine");

  host.unloadMedia();
});

test("live: callStack decodes on SM83 (GB) and m68k (Genesis)", { timeout: 180000 }, async () => {
  const cases = [
    { platform: "gb", rom: process.env.HOME + "/code/cliemu/space_invaders_gb/space_invaders_gb.gb", ramMask: 0x1fff, isa: "sm83" },
    { platform: "genesis", rom: process.env.HOME + "/code/cliemu/space_invaders_genesis/space_invaders_genesis.bin", ramMask: 0xffff, isa: "m68k" },
  ];
  for (const c of cases) {
    let exists = true;
    try { await readFile(c.rom); } catch { exists = false; }
    if (!exists) { console.log(`no ${c.platform} fixture; skipping`); continue; }
    const rom = new Uint8Array(await readFile(c.rom));
    const host = new LibretroHost();
    const core = resolveCore(c.platform);
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform: c.platform, bytes: rom, virtualName: "/rom" });
    host.stepFrames(120);
    if (!host.pcBreakSupported()) { host.unloadMedia(); continue; }
    host.stepInstruction(); // get a register snapshot at a known PC
    const regs = host.getRegSnapshot(false)?.named ?? host.getPCBreak(false).registersAtHit;
    assert.ok(regs && regs.sp != null, `${c.platform}: captured the stack pointer`);

    const readRamByte = (a) => { try { const b = host.readMemory("system_ram", a & c.ramMask, 1); return b?.[0] ?? null; } catch { return null; } };
    const readCpuWord = (a) => { const lo = readRamByte(a), hi = readRamByte(a + 1); return (lo == null || hi == null) ? null : (lo | (hi << 8)); };
    const readCpuLongBE = (a) => { const b = [0, 1, 2, 3].map((i) => readRamByte(a + i)); return b.some((x) => x == null) ? null : (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0); };
    const bt = buildBacktrace({ platform: c.platform, regs, readMemory: (r, o, l) => host.readMemory(r, o, l), readCpuWord, readCpuLongBE });
    // A booted game has a call stack; assert we decoded the right ISA + got frames.
    assert.ok(bt, `${c.platform}: built a backtrace`);
    assert.equal(bt.isa, c.isa, `${c.platform} → isa ${c.isa}`);
    assert.ok(bt.frames.length >= 1, `${c.platform}: recovered at least one frame`);
    if (c.isa === "m68k") assert.ok(bt.frames.every((f) => (f.callerPc & 1) === 0), "m68k frames are even-aligned");
    host.unloadMedia();
  }
});

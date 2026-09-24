// Per-instruction register columns of the reference cores' instruction trace
// (romdev_trace_provide_regs) on genesis_plus_gx (Z80 on SMS, 68000 on
// Genesis) and snes9x: the registers each instruction STARTS from, in the
// order LibretroHost.traceRegisterNames() names them. findDiverge
// level:'instruction' compares them with a recompiled cart's ring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";

const L = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const W = (...v) => v.flatMap((x) => [(x >> 8) & 0xff, x & 0xff]);

function smsRom() {
  const rom = new Uint8Array(0x8000);
  // di ; ld sp,$DFF0 ; ld a,$42 ; ld bc,$1234 ; ld ix,$5678 ; loop: jr loop
  rom.set([0xf3, 0x31, 0xf0, 0xdf, 0x3e, 0x42, 0x01, 0x34, 0x12, 0xdd, 0x21, 0x78, 0x56, 0x18, 0xfe], 0);
  return rom;
}

function genesisRom() {
  const rom = new Uint8Array(0x10000);
  rom.set(L(0x00fffe00), 0);
  rom.set(L(0x200), 4);
  for (let v = 2; v < 64; v++) rom.set(L(0xfff0), v * 4);
  rom.set(W(0x4e73), 0xfff0);
  const text = (off, s) => { for (let i = 0; i < s.length; i++) rom[off + i] = s.charCodeAt(i); };
  text(0x100, "SEGA MEGA DRIVE ");
  text(0x1f0, "JUE");
  // move.l #$12345678,d0 ; lea $00FF1000,a3 ; loop: bra.s loop
  rom.set([...W(0x203c), ...L(0x12345678), ...W(0x47f9), ...L(0x00ff1000), ...W(0x60fe)], 0x200);
  return rom;
}

function snesRom() {
  const img = new Uint8Array(0x8000).fill(0xea);
  // sei ; clc ; xce ; rep #$30 ; lda #$1234 ; ldx #$5678 ; bra *
  img.set([0x78, 0x18, 0xfb, 0xc2, 0x30, 0xa9, 0x34, 0x12, 0xa2, 0x78, 0x56, 0x80, 0xfe], 0);
  const h = 0x7fc0;
  const title = "SYNTHETIC TEST ROM   ";
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = 0x20; img[h + 0x17] = 0x08; img[h + 0x19] = 0x01;
  let sum = 0;
  for (const b of img) sum = (sum + b) & 0xffff;
  img[h + 0x1c] = (sum ^ 0xffff) & 0xff; img[h + 0x1d] = (sum ^ 0xffff) >> 8;
  img[h + 0x1e] = sum & 0xff; img[h + 0x1f] = sum >> 8;
  for (const v of [0x7ffc, 0x7fea, 0x7fee]) { img[v] = 0x00; img[v + 1] = 0x80; }
  return img;
}

/** The power-on trace with register columns, as a list of {pc, regs}. */
async function powerOnTrace(platform, ext, bytes) {
  const core = resolveCore(platform);
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-trregs-"));
  const h = new LibretroHost();
  try {
    const romPath = path.join(dir, `t.${ext}`);
    writeFileSync(romPath, bytes);
    await h.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    await h.loadMedia({ platform, path: romPath, beforeSettle: (x) => x.setTrace({ capacity: 1 << 20, registers: true }) });
    const t = h.readTrace(0, 64);
    h.setTrace({ enabled: false });
    assert.ok(t.regs, "register columns recorded");
    assert.deepEqual(Object.keys(t.regs), h.traceRegisterNames().slice(0, Object.keys(t.regs).length));
    return Array.from(t.pc, (pc, k) => ({ pc, regs: Object.fromEntries(Object.entries(t.regs).map(([n, c]) => [n, c[k]])) }));
  } finally {
    h.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const has = (p) => { try { return !!resolveCore(p); } catch { return false; } };

test("genesis_plus_gx Z80 columns (SMS): af bc de hl ix iy sp r ...", { skip: !has("sms") && "gpgx not staged", timeout: 60000 }, async () => {
  const s = await powerOnTrace("sms", "sms", smsRom());
  assert.deepEqual(s.slice(0, 6).map((e) => e.pc), [0x0, 0x1, 0x4, 0x6, 0x9, 0xd]);
  assert.equal(s[2].regs.sp, 0xdff0, "sp before ld a (set by the previous instruction)");
  assert.equal(s[3].regs.af >> 8, 0x42);
  assert.equal(s[4].regs.bc, 0x1234);
  assert.equal(s[5].regs.ix, 0x5678);
  assert.ok(s[5].regs.r > s[1].regs.r, "R counts opcode fetches");
});

test("genesis_plus_gx 68000 columns: d0-d7 a0-a7 sr", { skip: !has("genesis") && "gpgx not staged", timeout: 60000 }, async () => {
  const s = await powerOnTrace("genesis", "md", genesisRom());
  assert.deepEqual(s.slice(0, 3).map((e) => e.pc), [0x200, 0x206, 0x20c]);
  assert.equal(s[0].regs.a7, 0xfffe00);
  assert.equal(s[0].regs.sr & 0x2700, 0x2700);
  assert.equal(s[1].regs.d0, 0x12345678);
  assert.equal(s[2].regs.a3, 0xff1000);
});

test("snes9x columns: a x y s d db p (emulation flag at bit 8)", { skip: !has("snes") && "snes9x not staged", timeout: 60000 }, async () => {
  const s = await powerOnTrace("snes", "sfc", snesRom());
  assert.deepEqual(s.slice(0, 7).map((e) => e.pc & 0xffff), [0x8000, 0x8001, 0x8002, 0x8003, 0x8005, 0x8008, 0x800b]);
  assert.equal(s[1].regs.p & 0x04, 0x04, "sei set I");
  assert.equal(s[2].regs.p & 0x101, 0x100, "clc cleared C, still in emulation mode");
  assert.equal(s[3].regs.p >> 8, 0, "native mode after xce");
  assert.equal(s[5].regs.a, 0x1234);
  assert.equal(s[6].regs.x, 0x5678);
});

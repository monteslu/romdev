// GBA recompile vs mGBA, instruction by instruction from power-on.
//
// A synthetic ROM is recompiled through the real pipeline (emitWat, the
// streaming assembler), run in node's WebAssembly with the cart's per-step
// trace ring, and compared against romdev's mGBA's free-running trace with
// register columns: pc, the clock delta, r0-r14 and cpsr of EVERY
// instruction.
//
// Skipped when the mGBA core is not staged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { emitWat, recompileSection, describe } from "../src/analysis/recompile/wat/gba/index.js";
import MGBA_DATA from "../src/analysis/recompile/wat/gba/mgba-data.json" with { type: "json" };
import { assembleWat } from "../src/analysis/recompile/wat/assemble.js";

const core = (() => { try { return resolveCore("gba"); } catch { return null; } })();
const skip = !core ? "mGBA not staged" : false;

/**
 * A GBA ROM: `b $080000C0` at the entry, `main` (ARM words) at $C0, `block`
 * (ARM words) at $100.
 * @param {number[]} main
 * @param {number[]} block
 */
function makeRom(main, block, size = 0x400) {
  const r = new Uint8Array(size);
  const dv = new DataView(r.buffer);
  dv.setUint32(0, 0xEA00002E, true);
  r.set([...Buffer.from("LOCKSTEP")], 0xA0);
  main.forEach((w, i) => dv.setUint32(0xC0 + 4 * i, w >>> 0, true));
  block.forEach((w, i) => dv.setUint32(0x100 + 4 * i, w >>> 0, true));
  return r;
}

/**
 * Run the cart and mGBA side by side for `frames` frames; the first
 * instruction that differs, or null.
 */
async function lockstep(rom, frames, press = null) {
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const lay = recompileSection(rom).json;
  const t = lay.trace;
  const dv = () => new DataView(x.memory.buffer);
  x.wc_init();
  dv().setUint32(t.enable.offset, 1, true);
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gbalock-"));
  const ref = new LibretroHost();
  try {
    const romPath = path.join(dir, "t.gba");
    writeFileSync(romPath, rom);
    await ref.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    // a clock cart: pin mGBA's clock as the verifier does, and give the cart
    // the wasmcart host's fixed-step clock (render m sees (m - 1) * stepMs)
    if (lay.clock) ref.setPinnedClock({ baseMs: lay.clock.baseMs, stepMs: lay.clock.stepMs, startRun: () => ref.status.settleFramesUsed ?? Infinity });
    const timePtr = dv().getUint32(x.wc_get_info() + 40, true);
    let renders = 0;
    const render = () => { if (lay.clock) dv().setFloat64(timePtr, renders * lay.clock.stepMs, true); renders++; x.wc_render(); };
    // mGBA registers its register filler with the game: arm the trace
    // after the load, before the settle frames
    await ref.loadMedia({ platform: "gba", path: romPath, beforeSettle: () => ref.setTrace({ capacity: 1 << 21, registers: true }) });
    const cq = [], rq = [];
    let rgot = 0, n = 0, off0 = null;
    const pull = () => {
      const d = dv();
      const cnt = d.getUint32(t.cursor.offset, true);
      assert.ok(cnt < t.entries, "the cart ring holds the frame");
      for (let i = 0; i < cnt; i++) {
        const o = t.offset + i * t.stride;
        const r = [];
        for (let k = 0; k < 15; k++) r.push(d.getUint32(o + 12 + 4 * k, true));
        cq.push({ pc: d.getUint32(o, true), clk: d.getUint32(o + 8, true), cpsr: d.getUint32(o + 76, true), r });
      }
      d.setUint32(t.cursor.offset, 0, true);
      const tr = ref.readTrace(rgot);
      assert.equal(tr.lost, 0, "the reference trace lost nothing");
      for (let k = 0; k < tr.pc.length; k++) {
        const r = [];
        for (let j = 0; j < 15; j++) r.push(tr.regs[`r${j}`][k]);
        rq.push({ pc: tr.pc[k], clk: tr.clock[k], cpsr: tr.regs.cpsr[k], r });
      }
      rgot = tr.to;
      while (cq.length && rq.length) {
        const c = cq.shift(), e = rq.shift();
        const dc = (c.clk - e.clk) | 0;
        if (off0 === null) off0 = dc;
        // mGBA's trace pc is gprs[PC]: exec + 8 in ARM, + 4 in Thumb
        const why = ((e.pc - c.pc) | 0) !== ((c.cpsr & 0x20) ? 4 : 8) ? "pc" : dc !== off0 ? "clock"
          : (c.cpsr >>> 0) !== (e.cpsr >>> 0) ? "cpsr" : c.r.findIndex((v, k) => (v >>> 0) !== (e.r[k] >>> 0)) >= 0 ? "regs" : null;
        if (why) return { at: n, why, cart: [c.pc, c.cpsr, ...c.r].map((v) => (v >>> 0).toString(16)), ref: [e.pc, e.cpsr, ...e.r].map((v) => (v >>> 0).toString(16)) };
        n++;
      }
      return null;
    };
    render();
    let bad = pull();
    const padPtr = dv().getUint32(x.wc_get_info() + 28, true);
    for (let f = 0; f < frames && !bad; f++) {
      // the same button on both: the reference's libretro input, the cart's wasmcart pad
      const p = press ? press(f) : null;
      if (press) {
        ref.setInput({ ports: [p ? { [p.name]: true } : {}] });
        dv().setUint16(padPtr, p ? p.wc : 0, true);
      }
      ref.stepFrames(1); render(); bad = pull();
    }
    // the picture: the cart's framebuffer against mGBA's, exact RGB
    const fb = lay.framebuffer, rs = ref.screenshotRgba(), d = dv();
    let px = 0;
    for (let y = 0; y < 160; y++) for (let xx = 0; xx < 240; xx++) {
      const i = (y * rs.width + xx) * 4;
      if ((d.getUint32(fb.offset + (y * fb.width + xx) * 4, true) & 0xffffff) !== ((rs.rgba[i] << 16) | (rs.rgba[i + 1] << 8) | rs.rgba[i + 2])) px++;
    }
    const iw = lay.regions.iwram.offset;
    return { bad, n, px, iwram: [d.getUint32(iw, true), d.getUint32(iw + 4, true)] };
  } finally {
    ref.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ARM code in IWRAM runs what the pipeline fetched: stores to the next two instructions are not seen", { skip, timeout: 180000 }, async () => {
  // main ($C0): copy the block to $03000000 and jump there
  const main = [
    0xE28F0038,             // add r0, pc, #0x38   (r0 = $08000100)
    0xE3A01403,             // mov r1, #0x03000000
    0xE3A0200C,             // mov r2, #12
    0xE4903004,             // ldr r3, [r0], #4
    0xE4813004,             // str r3, [r1], #4
    0xE2522001,             // subs r2, r2, #1
    0x1AFFFFFB,             // bne (ldr)
    0xE3A01403,             // mov r1, #0x03000000
    0xE12FFF11,             // bx r1
  ];
  // block (IWRAM): zero the next two instructions (in the pipeline: they
  // still run) and one three ahead (not yet fetched: it does not run)
  const block = [
    0xE28F000C,             //  0 add r0, pc, #12  (r0 -> 20)
    0xE28F100C,             //  4 add r1, pc, #12  (r1 -> 24)
    0xE3A02000,             //  8 mov r2, #0
    0xE5802000,             // 12 str r2, [r0]     (20: already fetched)
    0xE5812000,             // 16 str r2, [r1]     (24: already fetched)
    0xE3A04001,             // 20 mov r4, #1
    0xE3A05002,             // 24 mov r5, #2
    0xE5802014,             // 28 str r2, [r0, #20] (40: fetched after this)
    0xE3A06003,             // 32 mov r6, #3
    0xE3A07004,             // 36 mov r7, #4
    0xE3A08005,             // 40 mov r8, #5  -> andeq r0,r0,r0 when it runs
    0xEAFFFFFE,             // 44 b 44
  ];
  await assertLockstep(makeRom(main, block), 3);
});

async function assertLockstep(rom, frames, press = null) {
  const r = await lockstep(rom, frames, press);
  const { bad, n, px } = r;
  assert.equal(bad, null, bad ? `diverged at instruction ${bad.at} (${bad.why}): cart ${bad.cart.join(" ")} vs mGBA ${bad.ref.join(" ")}` : "");
  assert.ok(n > 1000, `compared ${n} instructions`);
  assert.equal(px, 0, `${px} pixels differ from mGBA's picture`);
  return r;
}

// ---- the cartridge GPIO port and its RTC (mGBA gpio.c)

const A = {
  mov: (rd, imm) => 0xE3A00000 | (rd << 12) | imm,
  orr: (rd, rn, imm) => 0xE3800000 | (rn << 16) | (rd << 12) | imm,
  and: (rd, rn, imm) => 0xE2000000 | (rn << 16) | (rd << 12) | imm,
  add: (rd, rn, imm) => 0xE2800000 | (rn << 16) | (rd << 12) | imm,
  subs: (rd, rn, imm) => 0xE2500000 | (rn << 16) | (rd << 12) | imm,
  strh: (rd, rn, off = 0) => 0xE1C000B0 | (rn << 16) | (rd << 12) | ((off >> 4) << 8) | (off & 15),
  ldrh: (rd, rn, off = 0) => 0xE1D000B0 | (rn << 16) | (rd << 12) | ((off >> 4) << 8) | (off & 15),
  str: (rd, rn, off = 0) => 0xE5800000 | (rn << 16) | (rd << 12) | off,
  lsl: (rd, rm, sh) => 0xE1A00000 | (rd << 12) | (sh << 7) | rm,
  lsr: (rd, rm, sh) => 0xE1A00020 | (rd << 12) | (sh << 7) | rm,
  orrLsr: (rd, rn, rm, sh) => 0xE1800020 | (rn << 16) | (rd << 12) | (sh << 7) | rm,
};

/**
 * Bit-bang the S-3511A through the GPIO port at $080000C4 in a loop. Each
 * of `cmds` is a transfer: CS low then high, the command byte LSB first
 * (and `data`, a written byte) with SIO driven, then 8 * `bytes` bits clocked in with SIO as an input,
 * the first bit ending up highest in r6:r5. The last reading transfer's
 * r5/r6 are stored to $03000000. Code at $100 (the GPIO registers overlay
 * ROM $C4-$C9).
 * @param {{cmd: number, data?: number, bytes: number}[]} cmds
 */
function rtcReader(cmds) {
  const w = [];
  const at = () => 0x100 + 4 * w.length;
  // (at() is read when b() runs: push a branch on its own)
  const b = (cond, to) => ((cond << 28) | 0x0A000000 | (((to - at() - 8) >> 2) & 0xFFFFFF)) >>> 0;
  w.push(0xE3A04302, A.add(4, 4, 0xC4));               // r4 = $080000C4
  w.push(0xE3A09403);                                  // r9 = $03000000
  w.push(A.mov(0, 1), A.strh(0, 4, 4));                // control: readable
  const loop = at();
  for (const { cmd, data, bytes } of cmds) {
    w.push(A.mov(0, 7), A.strh(0, 4, 2));              // direction: SCK, SIO, CS out
    w.push(A.mov(0, 1), A.strh(0, 4));                 // CS low
    w.push(A.mov(0, 5), A.strh(0, 4));                 // CS high
    for (const byte of [cmd, ...(data != null ? [data] : [])]) {
      w.push(A.mov(1, byte), A.mov(2, 8));
      const send = at();
      w.push(A.and(3, 1, 1), A.lsl(3, 3, 1), A.orr(0, 3, 4), A.strh(0, 4));  // SCK low, SIO = bit
      w.push(A.orr(0, 0, 1), A.strh(0, 4));            // SCK high: the RTC shifts it in
      w.push(A.lsr(1, 1, 1), A.subs(2, 2, 1));
      w.push(b(1, send));
    }
    if (!bytes) continue;
    w.push(A.mov(0, 5), A.strh(0, 4, 2));              // SIO in
    w.push(A.mov(5, 0), A.mov(6, 0), A.mov(2, 8 * bytes));
    const recv = at();
    w.push(A.mov(0, 4), A.strh(0, 4), A.mov(0, 5), A.strh(0, 4));  // SCK low (the RTC drives SIO), high
    w.push(A.ldrh(3, 4), A.and(3, 3, 2));
    w.push(A.lsl(6, 6, 1), A.orrLsr(6, 6, 5, 31), A.lsl(5, 5, 1), A.orrLsr(5, 5, 3, 1));
    w.push(A.subs(2, 2, 1));
    w.push(b(1, recv));
    w.push(A.str(5, 9), A.str(6, 9, 4));
  }
  w.push(A.add(8, 8, 1));
  w.push(b(14, loop));
  return w;
}

/** An RTC cart: a game code whose mGBA override names HW_RTC (FLASH512 + RTC). */
function rtcRom(cmds) {
  // $C0 is not a branch (mGBA's GBAIsMB would take the image for multiboot);
  // $C4 branches to the code once, before the port overwrites it
  const rom = makeRom([0xE1A00000, 0xEA00000D], rtcReader(cmds), 0x400);
  rom.set([...Buffer.from("BR4J")], 0xAC);
  return rom;
}

/** r6:r5 as rtcReader leaves them for these bytes (each LSB first). */
function rtcBits(bytes) {
  let v = 0n;
  for (const x of bytes) for (let i = 0; i < 8; i++) v = (v << 1n) | BigInt((x >> i) & 1);
  return [Number(v & 0xFFFFFFFFn), Number(v >> 32n)];
}

test("GPIO RTC: the date and time mGBA's S-3511A reads from its pinned clock, bit-banged through ROM $C4", { skip, timeout: 300000 }, async () => {
  const rom = rtcRom([{ cmd: 0xA6, bytes: 7 }]);
  assert.ok(recompileSection(rom).json.clock, "an RTC cart declares the clock the verifier pins");
  // 1700000000 is 2023-11-14 22:13:20 UTC, a Tuesday; 90 frames later the
  // cart is 1.5 s in
  const { iwram } = await assertLockstep(rom, 90);
  assert.deepEqual(iwram, rtcBits([0x23, 0x11, 0x14, 0x02, 0x22, 0x13, 0x21]));
});

test("GPIO RTC: the control register, reset, 12-hour mode and the time command", { skip, timeout: 300000 }, async () => {
  // control reads 0x40 after InitRTC (24-hour)
  assert.deepEqual((await assertLockstep(rtcRom([{ cmd: 0xC6, bytes: 1 }]), 3)).iwram, rtcBits([0x40]));
  // reset clears control, so the time command reads a 12-hour clock
  assert.deepEqual((await assertLockstep(rtcRom([{ cmd: 0x06, bytes: 0 }, { cmd: 0xE6, bytes: 3 }]), 3)).iwram, rtcBits([0x10, 0x13, 0x20]));
  // a control write (0x46 with data 0x40) sets 24-hour again
  assert.deepEqual((await assertLockstep(rtcRom([{ cmd: 0x06, bytes: 0 }, { cmd: 0x46, data: 0x40, bytes: 0 }, { cmd: 0xE6, bytes: 3 }]), 3)).iwram,
    rtcBits([0x22, 0x13, 0x20]));
});

// ---- the other GPIO devices and the SRAM-region tilt sensor

/** An ARM program at $100 with labels: items are words, or {label}, or {b: cond, to: label}. */
function armProg(items) {
  const at = new Map();
  let pc = 0x100;
  for (const it of items) { if (it.label) at.set(it.label, pc); else pc += 4; }
  const w = [];
  pc = 0x100;
  for (const it of items) {
    if (it.label) continue;
    if (it.b !== undefined) w.push(((it.b << 28) | 0x0A000000 | (((at.get(it.to) - pc - 8) >> 2) & 0xFFFFFF)) >>> 0);
    else w.push(it);
    pc += 4;
  }
  return w;
}

/** A cart whose game code names these devices in mGBA's override table. */
function deviceRom(code, items) {
  const rom = makeRom([0xE1A00000, 0xEA00000D], armProg(items), 0x400);
  rom.set([...Buffer.from(code)], 0xAC);
  return rom;
}

const GPIO_SETUP = (dir) => [0xE3A04302, A.add(4, 4, 0xC4), 0xE3A09403,   // r4 = $080000C4, r9 = $03000000
  A.mov(0, 1), A.strh(0, 4, 4), A.mov(0, dir), A.strh(0, 4, 2)];

test("GPIO gyro: the sample (gyro Z = 0 from the port's rotation source) shifted out on the clock pin, as mGBA", { skip, timeout: 300000 }, async () => {
  const rom = deviceRom("RZWE", [...GPIO_SETUP(3), { label: "loop" },
    A.mov(0, 1), A.strh(0, 4), A.mov(0, 0), A.strh(0, 4), A.mov(5, 0), A.mov(2, 16), { label: "bit" },
    A.mov(0, 2), A.strh(0, 4), A.mov(0, 0), A.strh(0, 4),
    A.ldrh(3, 4), A.and(3, 3, 4), A.lsl(5, 5, 1), A.orrLsr(5, 5, 3, 2),
    A.subs(2, 2, 1), { b: 1, to: "bit" }, A.str(5, 9), A.add(8, 8, 1), { b: 14, to: "loop" }]);
  const { iwram } = await assertLockstep(rom, 3);
  assert.equal(iwram[0] & 0xFFFF, 0x0E00);   // 0x700 read MSB first, one clock late
});

test("GPIO solar sensor: the counter against 0xFF - lux, the level stepped by R3/L3 as the libretro port does", { skip, timeout: 300000 }, async () => {
  // count clock pulses after a reset until the comparator bit (pin 3) rises
  const rom = deviceRom("U3IE", [...GPIO_SETUP(7), { label: "loop" },
    A.mov(0, 2), A.strh(0, 4), A.mov(0, 0), A.strh(0, 4), A.mov(5, 0), { label: "cnt" },
    A.mov(0, 1), A.strh(0, 4), A.mov(0, 0), A.strh(0, 4), A.add(5, 5, 1),
    A.ldrh(3, 4), 0xE3130008, { b: 0, to: "cnt" },                     // tst r3, #8 ; beq cnt
    A.str(5, 9), A.add(8, 8, 1), { b: 14, to: "loop" }]);
  // R3 held for 2 frames (one step), released, R3 twice more, then L3 once
  const seq = { 2: "r3", 3: "r3", 6: "r3", 9: "r3", 12: "l3" };
  const press = (f) => seq[f] ? { name: seq[f], wc: seq[f] === "r3" ? 1 << 13 : 1 << 12 } : null;
  const { iwram } = await assertLockstep(rom, 16, press);
  // index 2 at the end: the comparator rises on pulse 0xFF - (0x16 + 11)
  assert.equal(iwram[0], 0xFF - (0x16 + 11));
});

test("tilt sensor: 0xFFF until $55/$AA latch the port's rotation (0 -> 0x3A0), read in the SRAM region", { skip, timeout: 300000 }, async () => {
  const ldrb = (rd, rn, off) => (0xE5D00000 | (rn << 16) | (rd << 12) | off) >>> 0;
  const strb = (rd, rn, off) => (0xE5C00000 | (rn << 16) | (rd << 12) | off) >>> 0;
  const rom = deviceRom("KYGE", [0xE3A0640E, 0xE2866C80,             // r6 = $0E008000
    ldrb(1, 6, 0x200), ldrb(2, 6, 0x300), ldrb(3, 6, 0x400), ldrb(5, 6, 0x500),
    A.mov(0, 0x55), strb(0, 6, 0), A.mov(0, 0xAA), strb(0, 6, 0x100),
    ldrb(7, 6, 0x200), ldrb(10, 6, 0x300), ldrb(11, 6, 0x400), ldrb(12, 6, 0x500),
    { label: "end" }, { b: 14, to: "end" }]);
  await assertLockstep(rom, 3);
});

test("mGBA's ROM-hack rule: a header it matches with an unknown CRC32 gets the RTC, FLASH1M and vbaBugCompat's GPIO", { skip, timeout: 300000 }, async () => {
  const rule = MGBA_DATA.romHackRule;
  const m = rule.matches.find((x) => x.n === 4);
  const rom = rtcRom([{ cmd: 0xA6, bytes: 7 }]);
  rom.set(Buffer.from(m.hex, "hex"), m.offset);
  const d = describe(rom);
  assert.equal(d.saveTypeSource, "mGBA ROM-hack rule");
  assert.ok(d.rtc && d.vbaBugCompat);
  await assertLockstep(rom, 3);
});

/**
 * ldrb/ldrh/ldr from ROM addresses past the image (and into its mirrors)
 * into r1-r9: main code for makeRom. `offs` are offsets from $08000000.
 * @param {number[]} offs
 */
function romReads(offs) {
  const w = [];
  offs.forEach((o, i) => {
    const rd = i + 1;
    // r0 = $08000000 + o, built from its bytes
    w.push(0xE3A00302);                                   // mov r0, #0x08000000
    for (let sh = 0; sh < 32; sh += 8) {
      const b = (o >>> sh) & 0xFF;
      if (!b) continue;
      const rot = (32 - sh) / 2 & 0xF;                    // imm8 ror (2*rot) = b << sh
      w.push(0xE2800000 | (rot << 8) | b);                // add r0, r0, #b << sh
    }
    const kind = i % 3;
    if (kind === 0) w.push(0xE5D00000 | (rd << 12));      // ldrb rd, [r0]
    else if (kind === 1) w.push(0xE1D000B0 | (rd << 12)); // ldrh rd, [r0]
    else w.push(0xE5900000 | (rd << 12));                 // ldr rd, [r0]
  });
  w.push(0xEAFFFFFE);                                     // b .
  return w;
}

test("ROM reads past the image follow GBALoadROM: the address pattern, or 0 on a non-power-of-two (flash cart) image", { skip, timeout: 180000 }, async () => {
  const offs = [0x3C1, 0x402, 0x404, 0x801, 0x1802, 0x10004, 0x7FFFF1, 0x1FFFFF2, 0x1FFFFFC];
  await assertLockstep(makeRom(romReads(offs), [], 0x400), 2);
  await assertLockstep(makeRom(romReads(offs), [], 0x3B8), 2);
});

test("a 1 MiB image is mirrored 4 times (NES-emulator carts rely on it), and forced blank is mGBA's white", { skip, timeout: 300000 }, async () => {
  const rom = makeRom(romReads([0x100001, 0x200002, 0x3FFFFC, 0x400001, 0x400002, 0x4FFFFC]), [], 0x100000);
  // 16 distinct words, one per 64KB, so a mirrored read names the bank it came from
  for (let i = 0x400; i < 0x100000; i += 4) new DataView(rom.buffer).setUint32(i, 0x01010101 * (1 + ((i >> 16) & 0xF)), true);
  await assertLockstep(rom, 2);
});

// ---- the renderer: synthetic scenes built by a small ARM "script VM" that
// copies halfword blocks into palette/VRAM/OAM/IO, compared with mGBA's
// picture after 12 frames (the setup takes a few)

/** ARM VM at $C0, script at $400: [dst u32, count u32, count halfwords...] ; dst 1 = end. */
function sceneRom(cmds) {
  const words = [
    0xE28F4FCE,             // add r4, pc, #0x338 -> $08000400 (C0 + 8 + 0x338)
    0xE4940004,             // L: ldr r0, [r4], #4
    0xE3500001,             // cmp r0, #1
    0x0A000007,             // beq END
    0xE4941004,             // ldr r1, [r4], #4
    0xE0D420B2,             // C: ldrh r2, [r4], #2
    0xE0C020B2,             // strh r2, [r0], #2
    0xE2511001,             // subs r1, r1, #1
    0x1AFFFFFB,             // bne C
    0xE2844002,             // add r4, r4, #2
    0xE3C44003,             // bic r4, r4, #3
    0xEAFFFFF4,             // b L
    0xEAFFFFFE,             // END: b END
  ];
  const script = [];
  for (const [dst, halves] of cmds) {
    script.push(dst >>> 0, halves.length);
    const hw = [...halves];
    if (hw.length & 1) hw.push(0);
    for (let i = 0; i < hw.length; i += 2) script.push(((hw[i] & 0xFFFF) | ((hw[i + 1] & 0xFFFF) << 16)) >>> 0);
  }
  script.push(1);
  const size = Math.max(0x1000, 1 << Math.ceil(Math.log2(0x400 + script.length * 4)));
  const r = new Uint8Array(size);
  const dv = new DataView(r.buffer);
  dv.setUint32(0, 0xEA00002E, true);
  words.forEach((w, i) => dv.setUint32(0xC0 + 4 * i, w >>> 0, true));
  script.forEach((w, i) => dv.setUint32(0x400 + 4 * i, w >>> 0, true));
  return r;
}

const IO = 0x04000000, PAL = 0x05000000, VRAM = 0x06000000, OAM = 0x07000000;
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 16;

/** Common content: palettes, 4bpp BG tiles, 8bpp tiles, a text map, OBJ tiles. */
function common() {
  const R = rng(7);
  const pal = []; for (let i = 0; i < 512; i++) pal.push(R() & 0x7FFF);
  const bgTiles = []; for (let i = 0; i < 0x2000; i++) bgTiles.push(R());           // 16KB of tile data at char block 0
  const map = []; for (let i = 0; i < 0x400; i++) map.push((i & 0x3FF) | ((i & 3) << 10) | ((i & 0xF) << 12));
  const affMap = []; for (let i = 0; i < 0x200; i++) affMap.push(R());                  // 128x128 affine map (bytes)
  const objTiles = []; for (let i = 0; i < 0x4000; i++) objTiles.push(R());           // 32KB OBJ tiles
  return [[PAL, pal], [VRAM, bgTiles], [VRAM + 0x8000, map], [VRAM + 0xC000, affMap], [VRAM + 0x10000, objTiles]];
}

/** OAM: 128 entries, all hidden, then `sprites` (a0,a1,a2) from 0, and affine params. */
function oam(sprites, mats = []) {
  const o = [];
  for (let i = 0; i < 128; i++) {
    const s = sprites[i] ?? [0x0200, 0, 0];            // bit 9 on a non-affine sprite: disabled
    o.push(s[0], s[1], s[2], 0);
  }
  mats.forEach(([pa, pb, pc, pd], m) => { o[m * 16 + 3] = pa; o[m * 16 + 7] = pb; o[m * 16 + 11] = pc; o[m * 16 + 15] = pd; });
  return [OAM, o];
}

const SCENES = {
  // mode 1: BG0 text + BG2 affine (wrapping, rotated), both with mosaic;
  // sprites with OBJ mosaic (normal, h-flipped, affine double-size), an
  // affine sprite clipped at the left edge, one wrapping past line 255,
  // and a prohibited-mode one
  mode1: () => [...common(),
    oam([
      [0x1000 | 40, (1 << 14) | 20, 0x0000],             // 16x16 4bpp, mosaic
      [0x1000 | 40, (1 << 14) | 0x1000 | 60, 0x0004],     // h-flip, mosaic
      [0x2000 | 0x1000 | 0x300 | 70, (2 << 14) | (1 << 9) | 100, 0x0010], // 8bpp affine double 32x32, mosaic, matrix 1
      [0x0100 | 90, (2 << 14) | (0 << 9) | 0x1F0, 0x0020], // affine 32x32 at x=-16, matrix 0
      [0x0300 | 150, (3 << 14) | (1 << 9) | 160, 0x0030], // affine double 64x64 at y=150: wraps, clipped by mGBA's list
      [0x0C00 | 20, (1 << 14) | 200, 0x0040],             // mode 3 (prohibited)
    ], [[0x0100, 0x0000, 0x0000, 0x0100], [0x00B5, 0x0055, -0x0055 & 0xFFFF, 0x00B5]]),
    [IO + 0x4C, [0x2413]],                                 // MOSAIC: BG 4x2, OBJ 5x3
    [IO + 0x08, [0x1040]],                                 // BG0CNT: map 16, mosaic
    [IO + 0x0C, [0x6041 | (24 << 8) | (0 << 2)]],          // BG2CNT: 128x128, wrap, map 24, mosaic, prio 1
    [IO + 0x20, [0x00F0, 0x0030, -0x0030 & 0xFFFF, 0x00F0]], // BG2PA..PD
    [IO + 0x28, [0x1000, 0x0000, 0x0800, 0x0000]],         // BG2X/BG2Y
    [IO + 0x00, [0x1501 | 0x0040]],                        // mode 1, BG0 + BG2 + OBJ, 1D mapping
  ],
  // mode 3 bitmap, rotated and scaled, with mosaic
  mode3: () => {
    const R = rng(3); const bmp = []; for (let i = 0; i < 240 * 160; i++) bmp.push(R() & 0x7FFF);
    return [[VRAM, bmp], [IO + 0x4C, [0x0032]], [IO + 0x0C, [0x0040]],
      [IO + 0x20, [0x00E0, 0x0020, -0x0020 & 0xFFFF, 0x00E0]], [IO + 0x28, [0x0800, 0x0000, 0x0400, 0x0000]],
      [IO + 0x00, [0x0403]]];
  },
  // mode 4 bitmap (page 1), palette, mosaic, and a non-wrapping affine
  // BG2 edge (the run starts outside it)
  mode4: () => {
    const R = rng(4); const bmp = []; for (let i = 0; i < 120 * 160; i++) bmp.push(R());
    const pal = []; for (let i = 0; i < 256; i++) pal.push(R() & 0x7FFF);
    return [[PAL, pal], [VRAM + 0xA000, bmp], [IO + 0x4C, [0x0025]], [IO + 0x0C, [0x0040]],
      [IO + 0x20, [0x0110, 0x0000, 0x0000, 0x0100]], [IO + 0x28, [-0x0400 & 0xFFFF, 0xFFFF, 0x0000, 0x0000]],
      [IO + 0x00, [0x0414]]];
  },
  // windows: WIN0 with x1 > x2 (wraps), WIN1 with y1 > y2, the OBJ window,
  // WININ/WINOUT layer and effect enables, alpha blend of BG0 over BG1
  windows: () => [...common(),
    oam([
      [0x0800 | 30, (2 << 14) | 50, 0x0000],             // OBJ-window sprite 32x32
      [0x0800 | 100, (3 << 14) | 150, 0x0010],           // OBJ-window sprite 64x64
      [0x0400 | 60, (2 << 14) | 90, 0x0400 | 0x20],      // semi-transparent sprite
      [0x2000 | 20, (1 << 14) | 180, 0x0031],            // 8bpp, odd tile, 2D mapping
      [0x0000 | 120, (2 << 14) | 20, 0x001E],            // 32x32 4bpp from tile 30: wraps inside its 2D row
    ]),
    [IO + 0x08, [0x1000, 0x1101, 0x1202, 0x1303]],       // BG0-3CNT, maps 16-19, prio 0-3
    [IO + 0x10, [3, 5, 7, 11, 13, 17, 19, 23]],          // scroll
    [IO + 0x40, [(200 << 8) | 40, (120 << 8) | 60]],     // WIN0H x1=200 > x2=40 (wraps), WIN1H
    [IO + 0x44, [(20 << 8) | 100, (150 << 8) | 30]],     // WIN0V, WIN1V y1=150 > y2=30
    [IO + 0x48, [0x3D27]],                               // WININ
    [IO + 0x4A, [0x3E19]],                               // WINOUT (outside, OBJ window)
    [IO + 0x50, [0x0241 | 0x0010]],                      // BLDCNT: alpha, BG0+OBJ first, BG1 second
    [IO + 0x52, [0x0A07]],                               // BLDALPHA
    [IO + 0x00, [0xFF00]],                               // mode 0, all layers, WIN0/WIN1/OBJWIN, 2D mapping
  ],
  // brighten and darken with BLDY, and the backdrop as a target
  fade: () => [...common(),
    [IO + 0x08, [0x1000, 0x1101]],
    [IO + 0x40, [(120 << 8) | 0, (240 << 8) | 120]],
    [IO + 0x44, [(160 << 8) | 0, (160 << 8) | 0]],
    [IO + 0x48, [0x2323]],                               // WIN0: BG0/BG1 + effects, WIN1: same
    [IO + 0x4A, [0x0003]],
    [IO + 0x50, [0x00A1]],                               // brighten BG0 + backdrop
    [IO + 0x54, [9]],                                    // BLDY
    [IO + 0x00, [0x6300]],
  ],
  // OBJ line budget: 64x64 sprites on the same lines, more than 1210 cycles
  budget: () => {
    const s = []; for (let i = 0; i < 40; i++) s.push([0x0000 | 10, (3 << 14) | ((i * 5) & 0x1FF), (i * 16) & 0x3FF]);
    return [...common(), oam(s), [IO + 0x00, [0x1040]]];
  },
};

for (const [name, what] of [
  ["mode1", "mode 1: text and affine BG mosaic; OBJ mosaic (normal, h-flipped, affine double-size), an affine sprite clipped at the left edge, one wrapping past line 255, a prohibited-mode one"],
  ["mode3", "mode 3: a rotated, scaled bitmap with mosaic"],
  ["mode4", "mode 4: a paletted bitmap page with mosaic, runs starting outside a non-wrapping BG2"],
  ["budget", "the OBJ line budget: 40 64x64 sprites on the same lines, more than OBJ_LENGTH cycles"],
  ["windows", "windows (wrapping WIN0/WIN1, OBJ window), alpha blend, an 8bpp sprite on an odd tile and a 4bpp one wrapping inside its 32-cell row in 2D mapping"],
]) {
  test(`renderer as mGBA's: ${what}`, { skip, timeout: 180000 }, async () => {
    await assertLockstep(sceneRom(SCENES[name]()), 12);
  });
}

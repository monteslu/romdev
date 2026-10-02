// Genesis WAT backend tests on tiny synthetic ROMs (never commercial ones).
// The carts are assembled with romdev's own streaming assembler and run
// in-process: the 68000 arms, the VDP port, the Z80 bus and the RAM-code
// path are each checked by what the program leaves in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe as describeRom, emitWat, layout, recompileSection, platforms, discoverRamCode, regionCode } from "./index.js";
import { translateM68k, translateZ80, z80HandlerNames, norm, U8, I8, U16, I16, U32, I32 } from "./ctrans.js";
import { loadGpgxData } from "./gpgx-data.js";
import { z80FlagTables, z80Layout } from "./runtime.js";
import { backendFor } from "../index.js";
import { validateRecompileLayout } from "../../recompile-section.js";
import { assembleWat } from "../assemble.js";

const STATE = 0x39000;

/** 68000 words -> bytes (big-endian). */
const W = (...ws) => ws.flatMap((w) => [(w >> 8) & 0xff, w & 0xff]);
const L = (v) => W((v >>> 16) & 0xffff, v & 0xffff);

/**
 * A 64KB Genesis image: vectors (SSP $FFFE00, reset $200), a header and
 * `code` at $200. Every other exception vector points at an `rte` near the end.
 */
function synthRom(code, { region = "JUE", size = 0x10000 } = {}) {
  const rom = new Uint8Array(size);
  rom.set(L(0x00fffe00), 0);
  rom.set(L(0x200), 4);
  const rte = size - 0x10;
  for (let v = 2; v < 64; v++) rom.set(L(rte), v * 4);
  rom.set(W(0x4e73), rte);
  const text = (off, s) => { for (let i = 0; i < s.length; i++) rom[off + i] = s.charCodeAt(i); };
  text(0x100, "SEGA MEGA DRIVE ");
  text(0x150, "SYNTHETIC TEST CART");
  text(0x1f0, region.padEnd(16, " "));
  rom.set(code, 0x200);
  return rom;
}

async function cartOf(rom, opts = {}) {
  const stats = {};
  const asm = await assembleWat(emitWat(rom, { ...opts, stats }));
  assert.ok(WebAssembly.validate(asm.bytes), "module validates");
  const { instance } = await WebAssembly.instantiate(asm.bytes, {});
  const e = instance.exports;
  const dv = () => new DataView(e.memory.buffer);
  const mem = () => new Uint8Array(e.memory.buffer);
  const info = e.wc_get_info();
  e.wc_init();
  return { e, dv, mem, info, stats, frame(n = 1) { for (let i = 0; i < n; i++) e.wc_render(); } };
}

test("registry resolves genesis, md and megadrive to this backend", async () => {
  for (const p of ["genesis", "md", "megadrive"]) {
    const b = await backendFor(p);
    assert.deepEqual(b.platforms, ["genesis", "md", "megadrive"]);
    assert.equal(typeof b.emitWat, "function");
  }
  assert.deepEqual(platforms, ["genesis", "md", "megadrive"]);
});

test("gpgx-derived data carries provenance and the non-commercial note", () => {
  const d = loadGpgxData();
  assert.match(d.meta.license, /non-commercial/);
  assert.match(d.meta.provenance.commit, /^[0-9a-f]{40}$/);
  assert.ok(d.meta.provenance.files["core/m68k/m68kops.h"]);
  assert.equal(d.m68k.jumpTable.length, 0x10000);
  assert.equal(d.m68k.tables.m68ki_cycles.length, 0x10000);
  assert.equal(d.m68k.handlerName(0x4e71), "m68k_op_nop");
  assert.equal(d.m68k.tables.m68ki_cycles[0x4e71], 4 * 7);
  assert.equal(d.hvc.cycle2hc32.length, 3420);
  for (const k of ["cc_op", "cc_cb", "cc_ed", "cc_xy", "cc_xycb", "cc_ex"]) assert.equal(d.z80.cc[k].length, 256);
});

test("C integer conversion matches C", () => {
  assert.equal(norm(0x1ff, U8), 0xff);
  assert.equal(norm(0x80, I8), -128);
  assert.equal(norm(0x18000, U16), 0x8000);
  assert.equal(norm(0x8000, I16), -32768);
  assert.equal(norm(-1, U32), 0xffffffff);
  assert.equal(norm(0xffffffff, I32), -1);
  assert.equal(norm(2n ** 40n + 5n, U32), 5);
});

test("translateM68k specialises Musashi handlers per opcode and address", () => {
  const d = loadGpgxData();
  const rom = new Uint8Array(0x1000);
  rom.set(W(0x4e71, 0x7005, 0x6000, 0x0010, 0x303c, 0x1234), 0x200);
  const f16 = (p) => (rom[p & 0xfff] << 8) | rom[(p + 1) & 0xfff];
  // nop: pc advances, base cycles charged, no memory access
  assert.equal(translateM68k(d.m68k, 0x4e71, 0x200, f16).body,
    "(global.set $pc (i32.const 514)) (global.set $mc (i32.add (global.get $mc) (i32.const 28)))");
  // moveq #5,d0: the register and all four flags are constants
  const mq = translateM68k(d.m68k, 0x7005, 0x202, f16).body;
  assert.match(mq, /\(global\.set \$r0 \(i32\.const 5\)\)/);
  assert.match(mq, /\(global\.set \$fz \(i32\.const 5\)\)/);
  // bra.w: the target is folded to a constant from the extension word
  assert.match(translateM68k(d.m68k, 0x6000, 0x204, f16).body, /\(global\.set \$pc \(i32\.const 534\)\)/);
  // move.w #$1234,d0: the immediate is read from the ROM at compile time
  assert.match(translateM68k(d.m68k, 0x303c, 0x208, f16).body, /4660/);
});

test("every Z80 handler translates", () => {
  const d = loadGpgxData();
  const lay = { ...z80Layout(), tbase: 7 };
  const names = z80HandlerNames();
  assert.equal(names.length, 6 * 256);
  for (const n of names) assert.match(translateZ80(d.z80, n, lay), new RegExp(`^  \\(func \\$z_${n} `));
  // the cb prefix dispatches through the table at tbase + 1*256
  assert.match(translateZ80(d.z80, "op_cb", lay), /\(call_indirect \(type \$voidT\) \(i32\.add \(i32\.const 263\)/);
});

test("Z80 flag tables follow z80_init", () => {
  const t = z80FlagTables();
  assert.equal(t.SZ[0], 0x40);
  assert.equal(t.SZP[0], 0x44);
  assert.equal(t.SZP[1], 0x00);
  assert.equal(t.SZP[3], 0x04);
  assert.equal(t.SZHV_inc[0x80] & 0x04, 0x04);
  assert.equal(t.SZHV_dec[0x7f] & 0x04, 0x04);
});

test("regionCode follows loadrom.c (USA > JAPAN > EUROPE)", () => {
  const img = (s) => { const b = new Uint8Array(0x200); for (let i = 0; i < s.length; i++) b[0x1f0 + i] = s.charCodeAt(i); return b; };
  assert.equal(regionCode(img("JUE ")), 0x80);
  assert.equal(regionCode(img("J   ")), 0x00);
  assert.equal(regionCode(img("E   ")), 0xc0);
  assert.equal(regionCode(img("EUR ")), 0xc0);
  assert.equal(regionCode(img("4   ")), 0x80);
});

// A copy loop exactly as games write it: lea src(pc),a0 / lea $F200.w,a1 /
// moveq #n,d0 / move.l (a0)+,(a1)+ / dbf d0,*-2 / rts, then jsr $F200.w.
function ramCodeProgram({ call = true } = {}) {
  const code = [];
  const at = () => 0x200 + code.length;
  // $200: jsr copy ; then optionally jsr $F200.w ; then loop
  code.push(...W(0x4eb9), ...L(0x280)); // jsr $280
  if (call) code.push(...W(0x4eb8, 0xf200)); // jsr $F200.w
  code.push(...W(0x5281, 0x60fc)); // loop: addq.l #1,d1 ; bra.s loop
  while (at() < 0x280) code.push(0x4e, 0x71);
  // $280: lea $10(pc),a0 -> $292 ; lea $F200.w,a1 ; moveq #1,d0 ; move.l (a0)+,(a1)+ ; dbf d0,*-2 ; rts
  code.push(...W(0x41fa, 0x0010, 0x43f8, 0xf200, 0x7001, 0x22d8, 0x51c8, 0xfffc, 0x4e75));
  while (at() < 0x292) code.push(0x4e, 0x71);
  // $292: the routine copied to $FFFFF200 (8 bytes): move.w #$BEEF,d2 ; nop ; rts
  code.push(...W(0x343c, 0xbeef, 0x4e71, 0x4e75));
  return Uint8Array.from(code);
}

test("discoverRamCode finds a copy loop whose destination is called, and skips copied data", () => {
  const found = discoverRamCode(synthRom(ramCodeProgram()));
  assert.equal(found.length, 1);
  assert.deepEqual({ ...found[0], callers: undefined }, { romOffset: 0x292, ramAddress: 0xfffff200, length: 8, foundAt: 0x280, callers: undefined });
  assert.equal(discoverRamCode(synthRom(ramCodeProgram({ call: false }))).length, 0);
});

test("describe and the romdev.recompile section", () => {
  const rom = synthRom(ramCodeProgram());
  const d = describeRom(rom);
  assert.equal(d.platform, "genesis");
  assert.equal(d.referenceCore, "genesis_plus_gx");
  assert.equal(d.system, "SEGA MEGA DRIVE");
  assert.equal(d.title, "SYNTHETIC TEST CART");
  assert.equal(d.regionCode, 0x80);
  assert.equal(d.romMirrorSize, 0x10000);
  assert.equal(d.arms, 0x8000 + 4);
  assert.equal(d.ramCode[0].source, "discovered");
  const s = recompileSection(rom, "ab".repeat(20));
  assert.equal(s.name, "romdev.recompile");
  const v = validateRecompileLayout(s.json);
  assert.equal(v.platform, "genesis");
  assert.equal(v.buttons, "positional");
  assert.equal(v.regions.vram.ref, "video_ram");
  assert.equal(v.fields.pc.ref.region, "genesis_m68k");
  assert.ok(v.probe.trapped);
  assert.deepEqual(layout.vramZero, ["vram"]);
  assert.throws(() => describeRom(rom, { ramCode: [{ romOffset: 0x292, ramAddress: 0x1000, length: 8 }] }), /work RAM/);
});

test("a synthetic cart runs: 68000, work RAM, VDP CRAM, Z80 bus and Z80 program", async () => {
  const code = Uint8Array.from([
    ...W(0x203c), ...L(0x12345678), // move.l #$12345678,d0
    ...W(0x23c0), ...L(0x00ff0000), // move.l d0,$FF0000
    ...W(0x33fc, 0x8104), ...L(0x00c00004), // VDP reg 1 = $04: Mode 5, display off
    ...W(0x23fc), ...L(0xc0000000), ...L(0x00c00004), // move.l #$C0000000,$C00004 (CRAM write, addr 0)
    ...W(0x33fc, 0x0eee), ...L(0x00c00000), // move.w #$0EEE,$C00000
    ...W(0x33fc, 0x0100), ...L(0x00a11100), // Z80 bus request
    ...W(0x33fc, 0x0100), ...L(0x00a11200), // Z80 reset off
    ...W(0x41f9), ...L(0x00a00000), // lea $A00000,a0
    ...[0x3e, 0x42, 0x32, 0x00, 0x10, 0x18, 0xfe].flatMap((b) => W(0x10fc, b)), // ld a,$42 ; ld ($1000),a ; jr $
    ...W(0x33fc, 0x0000), ...L(0x00a11200), // Z80 reset on
    ...W(0x33fc, 0x0000), ...L(0x00a11100), // release the bus
    ...W(0x33fc, 0x0100), ...L(0x00a11200), // Z80 reset off: it runs from 0
    ...W(0x5281, 0x60fc), // loop: addq.l #1,d1 ; bra.s loop
  ]);
  const c = await cartOf(synthRom(code));
  assert.equal(c.stats.trapped, 0);
  assert.equal(c.stats.arms, 0x8000);
  c.frame(3);
  const dv = c.dv(), m = c.mem();
  assert.equal(dv.getUint32(STATE + 96, true), 0, "not trapped");
  assert.equal(dv.getUint32(STATE + 0, true), 0x12345678, "d0 in the state block");
  assert.ok(dv.getUint32(STATE + 4, true) > 1000, "d1 counted up in the main loop");
  assert.deepEqual([...m.subarray(0, 4)], [0x12, 0x34, 0x56, 0x78], "work RAM in 68000 byte order");
  assert.equal(dv.getUint16(layout.regions.cram.offset, true), 0x1ff, "CRAM holds gpgx's packed 9-bit colour");
  assert.equal(m[layout.regions.zram.offset + 0x1000], 0x42, "the Z80 program ran and stored to its RAM");
  assert.equal(dv.getUint32(STATE + 92, true), 3, "frame counter");
  // wasmcart ABI: input and time pointers are real addresses
  assert.notEqual(dv.getUint32(c.info + 28, true), 0);
  assert.equal(dv.getUint32(c.info + 40, true) % 8, 0);
});

test("RAM-resident code: discovered and compiled; undiscovered it runs in the interpreter; with neither it traps (control)", async () => {
  const rom = synthRom(ramCodeProgram());
  const run = async (opts) => {
    const c = await cartOf(rom, opts);
    c.frame(2);
    const dv = c.dv();
    return { trapped: dv.getUint32(STATE + 96, true), trappc: dv.getUint32(STATE + 100, true), d2: dv.getUint32(STATE + 8, true), arms: c.stats.arms };
  };
  const auto = await run({});
  assert.equal(auto.trapped, 0);
  assert.equal(auto.d2, 0xbeef, "the copied routine ran at its RAM address");
  assert.equal(auto.arms, 0x8000 + 4);
  const interp = await run({ discoverRamCode: false });
  assert.equal(interp.trapped, 0);
  assert.equal(interp.d2, 0xbeef, "the undiscovered routine ran in the interpreter");
  assert.equal(interp.arms, 0x8000);
  const off = await run({ discoverRamCode: false, ramInterpreter: false });
  assert.equal(off.trapped, 1);
  assert.equal(off.trappc, 0xfffff200, "the must-fail control traps at the RAM PC");
  const manual = await run({ discoverRamCode: false, ramCode: [{ romOffset: 0x292, ramAddress: 0xfffff200, length: 8 }] });
  assert.equal(manual.trapped, 0);
  assert.equal(manual.d2, 0xbeef);
});

test("options.traceEntries records d0-d7/a0-a7/sr per instruction; breakArm flips d0 after one", async () => {
  const code = Uint8Array.from([
    ...W(0x203c), ...L(0x12345678), // $200 move.l #$12345678,d0
    ...W(0x2200),                   // $206 move.l d0,d1
    ...W(0x5281, 0x60fc),           // $208 loop: addq.l #1,d1 ; bra.s loop
  ]);
  const rom = synthRom(code);
  const opts = { traceEntries: 1 << 16, breakArm: "$000200" };
  const sec = recompileSection(rom, "00", opts).json;
  assert.equal(recompileSection(rom, "00", {}).json.trace.stride, 16, "the default ring is unchanged");
  assert.equal(sec.trace.stride, 128);
  assert.ok(sec.warning.includes("breakArm"));
  const c = await cartOf(rom, opts);
  assert.equal(c.stats.brokenArms, 1);
  const t = sec.trace;
  c.dv().setUint32(t.enable.offset, 1, true);
  c.frame(1);
  const dv = c.dv();
  const base = dv.getUint32(t.baseField.offset, true);
  const n = dv.getUint32(t.cursor.offset, true);
  assert.ok(n > 3 && n < t.entries, `one frame fits (${n})`);
  const e = (k, f) => dv.getUint32(base + k * t.stride + f, true);
  const steps = [];
  for (let k = 0; k < n && steps.length < 3; k++) if (!(e(k, 0) >>> 31)) steps.push(k);
  assert.deepEqual(steps.map((k) => e(k, 0) & 0xffffff), [0x200, 0x206, 0x208]);
  assert.equal(e(steps[1], 16), 0x12345679, "d0 after the broken move.l has bit 0 flipped");
  assert.equal(e(steps[0], 16 + 4 * 15), 0x00fffe00, "a7 = the stack pointer before the first instruction");
  assert.equal(e(steps[0], 80) & 0x2700, 0x2700, "sr: supervisor, interrupts masked at reset");
});

test("SVP carts: gpgx's SSP1601 runs from ROM, the 68000 sees XST / PM0, DRAM and the cell arrange window", async () => {
  const code = Uint8Array.from([
    ...W(0x33fc, 0xabcd), ...L(0x00300010), // move.w #$ABCD,$300010 (DRAM)
    ...W(0x3439), ...L(0x00300010),         // move.w $300010,d2
    ...W(0x33fc, 0x5a5a), ...L(0x00300100), // move.w #$5A5A,$300100
    ...W(0x3639), ...L(0x00390004),         // move.w $390004,d3 (svp_read_cell_1: DRAM $100)
    ...W(0x3039), ...L(0x00a15000),         // loop: move.w $A15000,d0 (XST)
    ...W(0x67f8),                           //       beq.s loop
    ...W(0x3239), ...L(0x00a15004),         // move.w $A15004,d1 (PM0: bit 0 = the SSP wrote XST, cleared by the read)
    ...W(0x3a39), ...L(0x00a15004),         // move.w $A15004,d5
    ...W(0x60fe),                           // bra.s *
  ]);
  const rom = synthRom(code, { size: 0x20000 });
  rom[0x1c8] = 0x53; rom[0x1c9] = 0x56; // 'SV'
  // the SSP1601 program at its reset PC (word $400 = byte $800): ldi XST,$1234 ; bra $402
  rom.set(W(0x08b0, 0x1234, 0x4c00, 0x0402), 0x800);
  const d = describeRom(rom);
  assert.equal(d.svp, true);
  assert.equal(d.supported, true);
  const sec = recompileSection(rom, "00").json;
  assert.equal(sec.regions.svp_dram.ref, "genesis_svp_dram");
  assert.equal(sec.regions.svp_dram.length, 0x20000);
  assert.equal(sec.regions.svp_iram.ref, "genesis_svp_iram");
  assert.equal(sec.regions.svp_ssp.ref, "genesis_svp_ssp");
  assert.equal(recompileSection(synthRom(W(0x60fe)), "00").json.regions.svp_dram, undefined, "no SVP regions without the chip");
  assert.ok(recompileSection(rom, "00", { svpBreak: true }).json.warning.includes("svpBreak"));
  const c = await cartOf(rom);
  c.frame(2);
  const dv = c.dv();
  assert.equal(dv.getUint32(STATE + 96, true), 0, "not trapped");
  assert.equal(dv.getUint32(STATE + 0, true) & 0xffff, 0x1234, "XST written by the SSP1601");
  assert.equal(dv.getUint32(STATE + 4, true) & 0xffff, 1, "PM0 bit 0 set by the SSP's XST write");
  assert.equal(dv.getUint32(STATE + 20, true) & 0xffff, 0, "and cleared by the 68000's read");
  assert.equal(dv.getUint32(STATE + 8, true) & 0xffff, 0xabcd, "DRAM word read back");
  assert.equal(dv.getUint32(STATE + 12, true) & 0xffff, 0x5a5a, "the cell arrange window maps $390004 to DRAM $100");
  // DRAM holds host-order (little-endian) words, as gpgx's svp->dram does
  assert.equal(dv.getUint16(sec.regions.svp_dram.offset + 0x10, true), 0xabcd);
  // the IRAM/ROM copy svp_reset made: word $400 is the program's first opcode
  assert.equal(dv.getUint16(sec.regions.svp_iram.offset + 0x800, true), 0x08b0);
  await assert.rejects(cartOf(synthRom(W(0x60fe)), { svpBreak: true }), /svpBreak needs an SVP cart/);
});

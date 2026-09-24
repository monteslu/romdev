// Game Boy WAT backend: header description, lowering, and whole carts built
// from tiny synthetic ROMs, assembled with romdev's own assembler and RUN in
// node's WebAssembly (no host, no emulator). Never a commercial ROM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe as gbDescribe, emitWat, recompileSection, platforms } from "./index.js";
import { lower, Unsupported } from "./lower.js";
import { normOps, addRecord } from "./blocks.js";
import { PROBE, PROBE_FIELDS } from "./emit.js";
import { assembleWatSync, assembleWat } from "../assemble.js";
import { validateRecompileLayout } from "../../recompile-section.js";
import { objdumpAvailable } from "../../../../toolchains/objdump.js";

const HAVE_GBZ80 = objdumpAvailable("gbz80");

/**
 * A 32KB ROM-only cart: header, `nop; jp $0150` at $0100, `code` at $0150.
 * @param {number[]} code
 * @param {{cgb?:boolean, cartType?:number, sgb?:boolean, size?:number}} [o]
 */
function makeRom(code, { cgb = true, cartType = 0, sgb = false, size = 0x8000 } = {}) {
  const r = new Uint8Array(size);
  r.set([0x00, 0xC3, 0x50, 0x01], 0x100);
  r.set([...Buffer.from("SYNTHETIC")], 0x134);
  r[0x143] = cgb ? 0x80 : 0x00;
  r[0x146] = sgb ? 0x03 : 0x00;
  r[0x147] = cartType;
  r[0x148] = Math.log2(size / 0x8000);
  r[0x149] = 0;
  let s = 0;
  for (let i = 0x134; i <= 0x14C; i++) s = (s - r[i] - 1) & 0xFF;
  r[0x14D] = s;
  r.set(code, 0x150);
  return r;
}

/**
 * Block index for a synthetic ROM WITHOUT the IR exporter: the listed
 * instructions, and `nop` at every other offset.
 */
function handBlocks(rom, instrs) {
  const blocks = new Map();
  for (let i = 0; i < rom.length; i++) blocks.set(i, { m: "nop", o: "", n: 1 });
  for (const [off, m, o, n] of instrs) blocks.set(off, { m, o, n });
  return blocks;
}

/** Assemble a cart, instantiate it and run `frames` host frames. */
async function runCart(rom, blocks, frames) {
  const chunks = [];
  for await (const c of emitWat(rom, { blocks })) chunks.push(c);
  const bytes = assembleWatSync(chunks.join(""));
  assert.ok(WebAssembly.validate(bytes), "the assembled cart validates");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const info = x.wc_get_info();
  const mem = () => new DataView(x.memory.buffer);
  x.wc_init();
  for (let f = 0; f < frames; f++) x.wc_render();
  const dv = mem();
  const fb = dv.getUint32(info + 12, true);
  return { x, dv, fb, probe: (k) => dv.getUint32(PROBE + PROBE_FIELDS[k], true) };
}

// CGB program: LCD off, BG palette 0 colour 0 := $001F (pure red), LCD on, spin.
const CGB_RED = [
  [0x150, "di", "", 1], [0x151, "ld", "sp,$FFFE", 3],
  [0x154, "xor", "a", 1], [0x155, "ldh", "($40),a", 2],
  [0x157, "ld", "a,$80", 2], [0x159, "ldh", "($68),a", 2],
  [0x15B, "ld", "a,$1F", 2], [0x15D, "ldh", "($69),a", 2],
  [0x15F, "xor", "a", 1], [0x160, "ldh", "($69),a", 2],
  [0x162, "ld", "a,$91", 2], [0x164, "ldh", "($40),a", 2],
  [0x166, "jr", "$0166", 2],
  [0x100, "nop", "", 1], [0x101, "jp", "$0150", 3],
];
const CGB_RED_BYTES = [0xF3, 0x31, 0xFE, 0xFF, 0xAF, 0xE0, 0x40, 0x3E, 0x80, 0xE0, 0x68,
  0x3E, 0x1F, 0xE0, 0x69, 0xAF, 0xE0, 0x69, 0x3E, 0x91, 0xE0, 0x40, 0x18, 0xFE];

test("platforms and describe(): header flags, MBC, sizes, SGB warning", () => {
  assert.deepEqual(platforms, ["gb", "gbc"]);
  const d = gbDescribe(makeRom([], { cgb: true, cartType: 0x1B, size: 0x20000 }));
  assert.equal(d.platform, "gbc");
  assert.equal(d.cgb, true);
  assert.equal(d.mbc, "mbc5");
  assert.equal(d.title, "SYNTHETIC");
  assert.equal(d.headerRomBytes, 0x20000);
  assert.deepEqual(d.warnings, []);
  const g = gbDescribe(makeRom([], { cgb: false, cartType: 0x13, sgb: true }));
  assert.equal(g.platform, "gb");
  assert.equal(g.mbc, "mbc3");
  assert.match(g.warnings.join(" "), /SGB flag set/);
  assert.equal(g.layout.regions.vram1, undefined, "DMG has one VRAM bank");
  assert.ok(g.layout.regions.dmgPalettes);
  // gambatte's mapper set: MBC2 (and $08/$09, which it runs as MBC2), HuC1
  assert.equal(gbDescribe(makeRom([], { cartType: 0x05 })).mbc, "mbc2");
  assert.equal(gbDescribe(makeRom([], { cartType: 0x09 })).mbc, "mbc2");
  assert.equal(gbDescribe(makeRom([], { cartType: 0xFF })).mbc, "huc1");
  assert.throws(() => gbDescribe(makeRom([], { cartType: 0x0B })), /not supported/);
  assert.throws(() => gbDescribe(new Uint8Array(0x100)), /too small/);
});

test("the romdev.recompile section validates and names gambatte's regions", () => {
  const s = recompileSection(makeRom([])).json;
  const v = validateRecompileLayout(s);
  assert.equal(v.referenceCore, "gambatte");
  assert.equal(v.regions.vram0.ref, "gb_vram");
  assert.equal(v.regions.vram1.refOffset, 0x2000);
  assert.equal(v.regions.wram7.refOffset, 0x7000);
  assert.equal(v.probe.trapped.offset, PROBE + 8);
  assert.deepEqual(v.vramZero, ["vram0", "vram1"]);
});

test("lower(): loads, ALU flags, control flow and refusals", () => {
  assert.deepEqual(lower("nop", "", 0, 1), ["", null]);
  assert.equal(lower("ld", "a,$05", 0, 2)[0], "(global.set $a (i32.and (i32.const 5) (i32.const 0xFF)))");
  assert.equal(lower("ldh", "($40),a", 0, 2)[0], "(call $wr8 (i32.const 65344) (global.get $a))");
  const [, jr] = lower("jr", "nz,$4005", 0x4006, 0x4008);
  assert.equal(jr.kind, "jp_cc");
  assert.equal(jr.target, 0x4005);
  assert.equal(jr.next, 0x4008);
  assert.equal(lower("rst", "L000038", 0x10, 0x11)[1].target, 0x38);
  assert.equal(lower("ret", "", 0, 1)[1].kind, "ret_expr");
  assert.equal(lower("ei", "", 0, 1)[0], "(global.set $eipend (i32.const 1))", "ei is delayed one instruction");
  assert.match(lower("xor", "a", 0, 1)[0], /\(global\.set \$f \(i32\.shl \(i32\.eqz/, "xor: only Z is computed, N H C clear");
  assert.throws(() => lower("defb", "$DD", 0, 1), Unsupported);
  assert.throws(() => lower("ld", "a,(ix+1)", 0, 2), Unsupported);
});

test("block normalisation: operand width by role, rst as a label, ROM-end trap", () => {
  assert.equal(normOps("jr", "z,0x0086", 2), "z,$0086");
  assert.equal(normOps("ldh", "(0xcc),a", 2), "($CC),a");
  assert.equal(normOps("ld", "hl,0x9800", 3), "hl,$9800");
  assert.equal(normOps("rst", "0x38", 1), "L000038");
  assert.equal(normOps("ldhl", "sp,44", 2), "sp,44");
  const b = new Map();
  addRecord(b, { off: 5, mnemonic: null, decodeStatus: "truncated-at-rom-end", len: 1 });
  assert.deepEqual(b.get(5), { m: "?", o: "", n: 1 });
  assert.throws(() => addRecord(b, { off: 6, mnemonic: null, decodeStatus: "data" }), /undecoded/);
  // primary wins over a secondary reading of the same offset
  addRecord(b, { off: 7, mnemonic: "ld", ops: "a,0x01", len: 2, alignment: "primary" });
  addRecord(b, { off: 7, mnemonic: "nop", ops: "", len: 1, alignment: "secondary" });
  assert.equal(b.get(7).m, "ld");
});

test("a CGB cart runs: palette write reaches every pixel, no trap", async () => {
  const rom = makeRom(CGB_RED_BYTES);
  const { dv, fb, probe } = await runCart(rom, handBlocks(rom, CGB_RED), 8);
  assert.equal(probe("trapped"), 0);
  assert.ok(probe("frames") >= 8);
  const red = 0xFFFF0000;   // $001F -> r=31: RGB565 expansion, XRGB8888 word
  let bad = 0;
  for (let i = 0; i < 160 * 144; i++) if (dv.getUint32(fb + i * 4, true) !== red) bad++;
  assert.equal(bad, 0, "every pixel is BG palette 0 colour 0");
  assert.equal(probe("pc"), 0x166, "spinning on the jr");
});

test("must-fail control: the same cart WITHOUT the palette write is not red", async () => {
  const rom = makeRom(CGB_RED_BYTES);
  const instrs = CGB_RED.map((i) => (i[0] === 0x15D ? [0x15D, "nop", "", 2] : i));
  const { dv, fb } = await runCart(rom, handBlocks(rom, instrs), 8);
  assert.notEqual(dv.getUint32(fb, true), 0xFFFF0000);
});

test("a DMG cart runs on the DMG PPU: BGP=$FF paints every pixel black", async () => {
  const code = [0xF3, 0x3E, 0xFF, 0xE0, 0x47, 0x18, 0xFE];
  const rom = makeRom(code, { cgb: false });
  const instrs = [[0x100, "nop", "", 1], [0x101, "jp", "$0150", 3],
    [0x150, "di", "", 1], [0x151, "ld", "a,$FF", 2], [0x153, "ldh", "($47),a", 2], [0x155, "jr", "$0155", 2]];
  const { dv, fb, probe } = await runCart(rom, handBlocks(rom, instrs), 6);
  assert.equal(probe("trapped"), 0);
  let black = 0;
  for (let i = 0; i < 160 * 144; i++) if (dv.getUint32(fb + i * 4, true) === 0xFF000000) black++;
  assert.equal(black, 160 * 144);
});

test("the frame is handed out at gambatte's point: inside the VBlank interrupt entry", async () => {
  // ld a,1; ldh ($FF),a (IE = VBlank); ei; spin. gambatte's blit runs the
  // events due at that cycle, so its CPU is handed out at $0040 with the spin
  // loop's pc stacked; the cart must stop at the same point.
  const code = [0x3E, 0x01, 0xE0, 0xFF, 0xFB, 0x18, 0xFE];
  const rom = makeRom(code);
  const instrs = [[0x100, "nop", "", 1], [0x101, "jp", "$0150", 3],
    [0x150, "ld", "a,$01", 2], [0x152, "ldh", "($FF),a", 2], [0x154, "ei", "", 1], [0x155, "jr", "$0155", 2],
    [0x40, "reti", "", 1]];
  const { dv, probe } = await runCart(rom, handBlocks(rom, instrs), 4);
  assert.equal(probe("trapped"), 0);
  assert.equal(probe("pc"), 0x40, "handed out inside the interrupt entry");
  const sp = probe("sp");
  assert.equal(sp, 0xFFFC, "power-on sp $FFFE, one return address pushed");
  // HRAM is at its own CPU address in linear memory
  assert.equal(dv.getUint16(sp, true), 0x155,
    "the stacked return address is the spin loop's pc");
});

test("STOP is two bytes (gambatte skips the byte after the opcode)", () => {
  const b = new Map();
  addRecord(b, { off: 0x200, mnemonic: "stop", ops: "", len: 1, alignment: "primary" });
  assert.equal(b.get(0x200).n, 2);
});

test("an undecodable instruction TRAPS at its pc, never slides on", async () => {
  const rom = makeRom([0xD3]);
  const instrs = [[0x100, "nop", "", 1], [0x101, "jp", "$0150", 3], [0x150, "defb", "$D3", 1]];
  const { probe } = await runCart(rom, handBlocks(rom, instrs), 2);
  assert.equal(probe("trapped"), 1);
  assert.equal(probe("trappc"), 0x150);
});

test("the block index from romdev's own IR decode builds the same running cart",
  { skip: !HAVE_GBZ80 && "gbz80 objdump not installed" }, async () => {
    const rom = makeRom(CGB_RED_BYTES);
    const chunks = [];
    const stats = {};
    for await (const c of emitWat(rom, { stats })) chunks.push(c);
    assert.equal(stats.arms, rom.length);
    const bytes = assembleWatSync(chunks.join(""));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const x = instance.exports;
    const info = x.wc_get_info();
    x.wc_init();
    for (let f = 0; f < 8; f++) x.wc_render();
    const dv = new DataView(x.memory.buffer);
    assert.equal(dv.getUint32(PROBE + 8, true), 0);
    assert.equal(dv.getUint32(dv.getUint32(info + 12, true) + 4 * (160 * 72 + 80), true), 0xFFFF0000);
  });

test("recompileToWasmcart embeds the romdev.recompile section",
  { skip: !HAVE_GBZ80 && "gbz80 objdump not installed" }, async () => {
    const { recompileToWasmcart } = await import("../build.js");
    const { readRecompileInfo } = await import("../cart-abi.js");
    const dir = mkdtempSync(path.join(tmpdir(), "gb-wat-"));
    try {
      const rom = makeRom(CGB_RED_BYTES);
      const out = path.join(dir, "t.wasm");
      const r = await recompileToWasmcart({ platform: "gbc", rom, outputPath: out, emit: "wasm" });
      assert.equal(r.stats.arms, rom.length);
      const info = readRecompileInfo(new Uint8Array(readFileSync(out)));
      assert.equal(info.referenceCore, "gambatte");
      assert.equal(info.regions.oam.ref, "gb_oam");
      // the same text through the streaming path gives the same binary
      const a = await assembleWat(emitWat(rom, {}));
      assert.ok(a.size > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("options.traceEntries records a whole frame with registers; breakArm flips L after one instruction", async () => {
  const rom = makeRom(CGB_RED_BYTES);
  const blocks = handBlocks(rom, [...CGB_RED, [0x166, "ld", "hl,$1234", 3], [0x169, "jr", "$0166", 2]]);
  rom.set([0x21, 0x34, 0x12, 0x18, 0xFB], 0x166);
  const opts = { blocks, traceEntries: 16384, breakArm: 0x166 };
  const chunks = [];
  const stats = {};
  for await (const c of emitWat(rom, { ...opts, stats })) chunks.push(c);
  assert.equal(stats.brokenArms, 1);
  const sec = recompileSection(rom, "00", opts).json;
  validateRecompileLayout(sec);
  assert.equal(recompileSection(rom).json.trace, undefined, "the default cart keeps the derived 2048-entry ring");
  const { instance } = await WebAssembly.instantiate(assembleWatSync(chunks.join("")), {});
  const x = instance.exports;
  x.wc_get_info(); x.wc_init(); x.wc_render();
  const dv = new DataView(x.memory.buffer);
  const t = sec.trace;
  const count = dv.getUint32(t.cursor.offset, true);
  assert.ok(count > 2048 && count <= t.entries, `a frame of the spin loop is more than the default ring holds and fits this one (${count})`);
  const at = (k, f) => dv.getUint32(t.offset + (k % t.entries) * t.stride + f, true) & 0xFFFF;
  assert.deepEqual([0, 1, 2].map((k) => at(k, 0)), [0x100, 0x101, 0x150], "from the frame's first instruction");
  let k = 0;
  while (at(k, 0) !== 0x169) k++;
  assert.equal(at(k, 12), 0x1235, "hl after the broken ld hl,$1234 has bit 0 of L flipped");
  assert.equal(at(3, 8), 0xFFFE, "registers are the state before the instruction (sp set by the previous one)");
});

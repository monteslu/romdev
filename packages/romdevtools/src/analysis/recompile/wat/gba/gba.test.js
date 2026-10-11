// GBA WAT backend tests on tiny synthetic ROMs (never commercial ones).
//
// The execution tests assemble the module with romdev's own streaming
// assembler, instantiate it and run frames: the static-arm build and the
// interpreter build (the oracle) must reach the same machine state, and the
// must-fail control (breakThumb) must change it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe as describeRom, emitWat, recompileSection, platforms, computeLayout, WARMUP_FRAMES } from "./index.js";
import { ARM_TABLE, THUMB_TABLE, MGBA_DATA } from "./cpu.js";
import { backendFor } from "../index.js";
import { validateRecompileLayout } from "../../recompile-section.js";
import { assembleWat } from "../assemble.js";

const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = v >>> 24; };
const put16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };

/**
 * A 64KB cart: the header's branch goes to ARM code at $080000C0 that runs a
 * BIOS Div SWI, stores the quotient/remainder to IWRAM, then BX-es to a Thumb
 * loop at $08000100 that copies KEYINPUT to IWRAM and counts.
 */
function synthRom({ code = "ZZZE", extra = null } = {}) {
  const rom = new Uint8Array(0x10000);
  put32(rom, 0, 0xEA00002E); // b $080000C0
  rom.set(Buffer.from("SYNTHTEST   ", "latin1"), 0xA0);
  rom.set(Buffer.from(code + "01", "latin1"), 0xAC);
  rom[0xB2] = 0x96;
  [
    0xE3A00064, // mov r0, #100
    0xE3A01007, // mov r1, #7
    0xEF060000, // swi 6 (Div)
    0xE3A06403, // mov r6, #0x03000000
    0xE5860014, // str r0, [r6, #20]
    0xE5861018, // str r1, [r6, #24]
    0xE3A00403, // mov r0, #0x03000000
    0xE3A05301, // mov r5, #0x04000000
    0xE2855E13, // add r5, r5, #0x130   (KEYINPUT)
    0xE3A01302, // mov r1, #0x08000000
    0xE3811C01, // orr r1, r1, #0x100
    0xE3811001, // orr r1, r1, #1
    0xE12FFF11, // bx r1                (Thumb at $08000100)
  ].forEach((w, i) => put32(rom, 0xC0 + 4 * i, w));
  [
    0x882A, // ldrh r2, [r5, #0]
    0x8102, // strh r2, [r0, #8]
    0x3301, // add r3, #1
    0x60C3, // str r3, [r0, #12]
    0x009C, // lsl r4, r3, #2
    0x6104, // str r4, [r0, #16]
    0xE7F8, // b $08000100
  ].forEach((h, i) => put16(rom, 0x100 + 2 * i, h));
  if (extra) extra(rom);
  return rom;
}

async function run(rom, opts, frames = 3, pad = 0) {
  const d = describeRom(rom, opts);
  const { bytes } = await assembleWat(emitWat(rom, opts));
  assert.ok(WebAssembly.validate(bytes), "module validates");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const abi = e.wc_get_info();
  const info = new DataView(e.memory.buffer, abi, 64);
  const inputPtr = info.getUint32(28, true);
  e.wc_init();
  for (let i = 0; i < frames; i++) {
    new DataView(e.memory.buffer).setUint16(inputPtr, pad, true);
    e.wc_render();
  }
  const mem = new Uint8Array(e.memory.buffer);
  const L = d.memory;
  const dv = new DataView(e.memory.buffer);
  const probe = {};
  for (const [k, f] of Object.entries(d.layout.probe)) probe[k] = dv.getUint32(f.offset, true);
  return {
    d, info: { version: info.getUint32(0, true), w: info.getUint32(4, true), h: info.getUint32(8, true), fb: info.getUint32(12, true), inputPtr, timePtr: info.getUint32(40, true) },
    iwram: mem.slice(L.IWRAM, L.IWRAM + 0x8000),
    ewram: mem.slice(L.EWRAM, L.EWRAM + 0x40000),
    regs: mem.slice(L.REGS, L.REGS + 64),
    u32: (o) => dv.getUint32(L.IWRAM + o, true),
    u16: (o) => dv.getUint16(L.IWRAM + o, true),
    probe,
  };
}

async function textOf(rom, opts) {
  let s = "";
  let chunks = 0, biggest = 0;
  for await (const c of emitWat(rom, opts)) { s += c; chunks++; biggest = Math.max(biggest, c.length); }
  return { s, chunks, biggest };
}

test("registry resolves gba to this backend", async () => {
  const b = await backendFor("gba");
  assert.deepEqual(b.platforms, ["gba"]);
  assert.deepEqual(platforms, ["gba"]);
  assert.equal(typeof b.emitWat, "function");
  assert.equal(typeof b.recompileSection, "function");
});

test("mgba-data.json carries the decoder tables, HLE BIOS and provenance", () => {
  assert.equal(ARM_TABLE.length, 4096);
  assert.equal(THUMB_TABLE.length, 1024);
  assert.equal(Buffer.from(MGBA_DATA.hleBios, "base64").length, 0x4000);
  assert.equal(Buffer.from(MGBA_DATA.sintab, "base64").length, 2048);
  assert.equal(MGBA_DATA.exp2fTab.length, 32);
  assert.equal(MGBA_DATA.conditionLut.length, 16);
  assert.equal(MGBA_DATA.vstallLut.length, 32);
  assert.match(MGBA_DATA.provenance.mgbaCommit, /^[0-9a-f]{40}$/);
  assert.match(MGBA_DATA.provenance.mgbaLicense, /MPL-2\.0/);
  assert.ok(Object.keys(MGBA_DATA.provenance.mgbaFilesSha256).length >= 8);
  // mGBA's reset vector is a branch
  assert.equal(Buffer.from(MGBA_DATA.hleBios, "base64").readUInt32LE(0) >>> 24, 0xEA);
});

test("describe reads the header, the save library string and mGBA's overrides", () => {
  const rom = synthRom({ extra: (r) => r.set(Buffer.from("FLASH1M_V103", "latin1"), 0x8000) });
  const d = describeRom(rom);
  assert.equal(d.platform, "gba");
  assert.equal(d.supported, true);
  assert.equal(d.title, "SYNTHTEST");
  assert.equal(d.gameCode, "ZZZE");
  assert.equal(d.maker, "01");
  assert.equal(d.saveType, "autodetect");
  assert.match(d.saveLibrary, /FLASH1M_V/);
  assert.equal(d.romSha1, createHash("sha1").update(rom).digest("hex"));
  assert.equal(d.warmupFrames, WARMUP_FRAMES);
  // an entry in mGBA's override table: flash 64K and a known idle loop
  const ov = describeRom(synthRom({ code: "AWRE" }));
  assert.equal(ov.saveType, "flash512");
  assert.equal(ov.idleLoop, 0x08038810);
  // game codes starting with 'F' save to EEPROM
  assert.equal(describeRom(synthRom({ code: "FSME" })).saveType, "eeprom");
  // too small to be a cart
  assert.equal(describeRom(new Uint8Array(64)).supported, false);
});

test("layout places the ROM last and the tables before it", () => {
  const L = computeLayout(0x10000, true, 5000);
  for (const k of ["BIOS", "REGS", "PROBE", "CKPT", "TRACE", "ABI", "ATAB", "BTAB", "AHASH"]) assert.ok(L[k] < L.ROM, k);
  assert.equal(L.ROM % 0x1000, 0);
  // the machine ends at ROM + twice the image (the earlier emitter's layout); audio.js's
  // block (resampler tables, buffers, state) follows it, page aligned
  assert.equal(L.AUD, Math.ceil((L.ROM + 2 * 0x10000) / 0x1000) * 0x1000);
  assert.ok(L.END > L.AUD);
  assert.ok(L.AHASH_BITS >= 14); // 2 * 5000 slots at least
  assert.equal(computeLayout(0x10000, false).ATAB, undefined);
});

test("the romdev.recompile section validates and maps every compared region", () => {
  const rom = synthRom();
  const { name, json } = recompileSection(rom, createHash("sha1").update(rom).digest("hex"));
  assert.equal(name, "romdev.recompile");
  const v = validateRecompileLayout(json);
  assert.equal(v.platform, "gba");
  assert.equal(v.reference, "gba");
  assert.equal(v.warmupFrames, 4);
  assert.equal(v.buttons, "positional");
  assert.deepEqual(Object.keys(v.regions).sort(), ["ewram", "io", "iwram", "oam", "pal", "vram"]);
  assert.equal(v.regions.ewram.ref, "system_ram");
  assert.equal(v.regions.iwram.ref, "gba_iwram");
  assert.equal(v.fields.r15.ref.region, "gba_cpu_regs");
  assert.equal(v.fields.cpsr.ref.offset, 64);
  assert.ok(v.probe.trapped && v.probe.interpreted);
  assert.ok(v.gba.checkpoint && v.gba.trace);
  assert.throws(() => recompileSection(rom, "0".repeat(40)), /sha1/);
  assert.equal(recompileSection(rom, null, { buttons: "byName" }).json.buttons, "byName");
});

test("emitWat streams: many chunks, none huge, one module", async () => {
  const { s, chunks, biggest } = await textOf(synthRom(), { interp: true });
  assert.ok(s.startsWith("(module\n  (memory (export \"memory\") "));
  assert.ok(s.endsWith("\n)\n"));
  assert.ok(chunks > 10);
  assert.ok(biggest < 32 << 20, "no chunk is tens of MB");
  assert.equal((s.match(/\(func \$interp_arm /g) || []).length, 1);
});

test("buttons: positional and byName differ only in how the pad's A/B bits are read", async () => {
  const rom = synthRom();
  const a = (await textOf(rom, { interp: true })).s;
  const b = (await textOf(rom, { interp: true, buttons: "byName" })).s;
  assert.notEqual(a, b);
  const byName = "(i32.and (local.get $b) (i32.const 3))";
  const pos = "(i32.or (i32.and (i32.shr_u (local.get $b) (i32.const 1)) (i32.const 1)) (i32.and (i32.shl (local.get $b) (i32.const 1)) (i32.const 2)))";
  assert.equal(b.split(byName).length, 2);
  assert.equal(a.replace(pos, byName), b);
});

test("static arms and the interpreter reach the same state; 0 interpreted steps", async () => {
  const rom = synthRom();
  const st = await run(rom, {});
  const it = await run(rom, { interp: true });
  // the program ran: Div(100, 7), KEYINPUT copied, the Thumb loop counted
  assert.equal(st.u32(20), 14);
  assert.equal(st.u32(24), 2);
  assert.equal(st.u16(8), 0x3FF);
  assert.ok(st.u32(12) > 1000);
  assert.equal(st.u32(16), (st.u32(12) * 4) >>> 0);
  assert.equal(st.probe.trapped, 0);
  assert.equal(st.probe.frameCounter, WARMUP_FRAMES + 3);
  assert.equal(st.probe.interpreted, 0);
  assert.equal(st.probe.compiled, st.probe.steps);
  assert.equal(it.probe.compiled, 0);
  // (the interpreter build counts only its ARM steps as interpreted)
  assert.ok(it.probe.interpreted > 0);
  // the oracle agrees to the byte
  assert.equal(st.probe.steps, it.probe.steps);
  assert.deepEqual(st.iwram, it.iwram);
  assert.deepEqual(st.ewram, it.ewram);
  assert.deepEqual(st.regs, it.regs);
  // wasmcart ABI: input and clock pointers are real, the clock 8-aligned
  assert.equal(st.info.w, 240);
  assert.equal(st.info.h, 160);
  assert.ok(st.info.inputPtr > 0);
  assert.ok(st.info.timePtr > 0 && st.info.timePtr % 8 === 0);
});

test("must-fail control: breakThumb turns one Thumb opcode into a no-op and the state diverges", async () => {
  const rom = synthRom();
  const good = await run(rom, {}, 2);
  const bad = await run(rom, { breakThumb: "3301" }, 2);
  assert.ok(good.u32(12) > 14);
  assert.equal(bad.u32(12), 14, "add r3, #1 compiled as a no-op: r3 keeps Div's |quotient|");
  assert.notDeepEqual(good.iwram, bad.iwram);
});

test("pad: the east face button is the GBA's A (positional); byName reads bit 0", async () => {
  const rom = synthRom();
  const east = (await run(rom, {}, 1, 0x2)).u16(8);
  const south = (await run(rom, {}, 1, 0x1)).u16(8);
  assert.equal(east, 0x3FE, "WC_BTN_B (east) -> KEYINPUT A");
  assert.equal(south, 0x3FD, "WC_BTN_A (south) -> KEYINPUT B");
  assert.equal((await run(rom, { buttons: "byName" }, 1, 0x1)).u16(8), 0x3FE);
  // start (WC bit 6) -> KEYINPUT bit 3
  assert.equal((await run(rom, {}, 1, 0x40)).u16(8), 0x3F7);
});

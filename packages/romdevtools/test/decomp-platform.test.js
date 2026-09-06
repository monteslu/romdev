// decomp-platform.test.js — the per-platform profile behind the decomp path,
// the compile-invocation classifier, endian word reads, and absolute-address
// decompilation of a synthetic PS-EXE (little-endian MIPS at its t_addr).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES, profileFor, readWord, readRomHeader, classifyInvocation, binutilsPrefixFromAssembler } from "../src/decomp/platform.js";

test("profiles: n64 is big-endian/vr4300 and verified; psx is little-endian/r3000 and NOT verified", () => {
  assert.equal(profileFor("n64").endian, "big"); assert.ok(profileFor("n64").asFlags.includes("-EB")); assert.equal(profileFor("n64").verified, true);
  const psx = profileFor("psx");
  assert.equal(psx.endian, "little"); assert.ok(psx.asFlags.includes("-EL")); assert.ok(psx.asFlags.includes("-march=r3000")); assert.equal(psx.verified, false);
  assert.equal(profileFor("ps1"), psx, "romdev platform id maps to the splat profile");
  assert.equal(psx.m2cTargetByCompiler.gcc, "mips-gcc-c"); assert.equal(PROFILES.ps2.m2cTargetByCompiler.gcc, "mipsee-gcc-c");
  assert.throws(() => profileFor("gba"), /no decomp platform profile/);
});

test("readWord honours the profile's byte order", () => {
  const buf = Buffer.from([0x27, 0xbd, 0xff, 0xe8]);
  assert.equal(readWord(profileFor("n64"), buf, 0), 0x27bdffe8);
  assert.equal(readWord(profileFor("psx"), buf, 0), 0xe8ffbd27);
});

test("classifyInvocation: asm-processor+IDO form and plain gcc form", () => {
  const ido = classifyInvocation([".venv/bin/python3", "tools/asm-processor/build.py", "--input-enc=utf-8", "tools/ido-static-recomp/build/5.3/out/cc", "--", "mips-linux-gnu-as", "-march=vr4300", "-32", "--", "-c", "-O2", "-o", "build/src/a.o", "src/a.c"]);
  assert.equal(ido.kind, "ido"); assert.equal(ido.compiler, "tools/ido-static-recomp/build/5.3/out/cc"); assert.equal(ido.assembler, "mips-linux-gnu-as"); assert.equal(ido.ccArgv[0], ido.compiler); assert.ok(ido.ccArgv.includes("src/a.c"));
  const gcc = classifyInvocation(["mipsel-linux-gnu-gcc", "-c", "-O2", "-G0", "-EL", "-o", "build/src/main.o", "src/main.c"]);
  assert.equal(gcc.kind, "gcc"); assert.equal(gcc.assembler, null); assert.deepEqual(gcc.ccArgv.slice(0, 2), ["mipsel-linux-gnu-gcc", "-c"]);
  assert.equal(binutilsPrefixFromAssembler("/x/.toolchains/mips/usr/bin/mipsel-linux-gnu-as"), "mipsel-linux-gnu-");
  assert.equal(classifyInvocation([]).kind, "unknown");
});

test("readRomHeader: N64 header fields; PS-EXE t_addr/pc0; unknown falls back to endianness", () => {
  const n64 = Buffer.alloc(0x40); n64.writeUInt32BE(0x80371240, 0); n64.writeUInt32BE(0x80046800, 8); n64.write("WAVE RACE 64", 0x20, "latin1"); n64.write("NWR", 0x3b, "latin1"); n64[0x3e] = 0x45; n64[0x3f] = 1;
  const h = readRomHeader(profileFor("n64"), n64);
  assert.equal(h.header.entry, "0x80046800"); assert.equal(h.header.cartId, "NWR"); assert.equal(h.header.region, "E");
  const exe = Buffer.alloc(0x800); exe.write("PS-X EXE", 0, "latin1"); exe.writeUInt32LE(0x80010000, 0x10); exe.writeUInt32LE(0x80010000, 0x18); exe.writeUInt32LE(0x800, 0x1c);
  const p = readRomHeader(profileFor("psx"), exe);
  assert.equal(p.byteOrder, "PS-EXE (little-endian)"); assert.equal(p.header.tAddr, "0x80010000"); assert.equal(p.header.tSize, 0x800);
  assert.equal(readRomHeader(profileFor("psp"), Buffer.alloc(16)).header, null);
});

test("PS1 decompile loads the PS-EXE at its t_addr: absolute analysis, provenance says so", async () => {
  // Synthetic PS-EXE: header + a tiny LE MIPS function at 0x80010000:
  //   jal 0x80010020 ; nop ; jr ra ; nop ; (pad) ; @+0x20: addiu v0,zero,7 ; jr ra ; nop
  const { analyzeDecompile } = await import("../src/analysis/analyze.js");
  const dir = await mkdtemp(join(tmpdir(), "romdev-psx-"));
  const exe = Buffer.alloc(0x800 + 0x40);
  exe.write("PS-X EXE", 0, "latin1"); exe.writeUInt32LE(0x80010000, 0x10); exe.writeUInt32LE(0x80010000, 0x18); exe.writeUInt32LE(0x40, 0x1c);
  const w = (off, word) => exe.writeUInt32LE(word >>> 0, 0x800 + off);
  w(0x00, 0x0c000000 | ((0x80010020 >>> 2) & 0x03ffffff)); // jal 0x80010020
  w(0x04, 0); w(0x08, 0x03e00008); w(0x0c, 0);
  w(0x20, 0x24020007); w(0x24, 0x03e00008); w(0x28, 0);
  const file = join(dir, "game.exe");
  await writeFile(file, exe);
  const r = await analyzeDecompile(file, 0x80010000, "ps1");
  assert.equal(r.provenance.method, "ps-exe-header");
  assert.equal(r.provenance.loadedAt, "0x80010000");
  assert.match(r.provenance.analysisAddressSpace, /absolute/);
  // The callee is named by its REAL address by Ghidra itself (no rebasing pass on PS1).
  assert.match(r.code, /80010020/i);
});

// The decomp domain's WASM compile path on small synthetic translation units:
// IDO (romdev-toolchain-ido) with cc driving its passes as sibling modules,
// the JS asm-processor, the mips-linux-gnu binutils, the cc1 preprocessor,
// the Makefile reader, the recipe runner and the host-program ports.
//
// Real-project byte identity (every TU of a checkout, and the full ROM) is
// verified against the project's own build; these tests pin the mechanisms.
process.env.ROM_DEV_WASM_POOL_SIZE ??= "3";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, "..", "build", "test-tmp", `decomp-wasm-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

const { idoCompile, binutils, toolName } = await import("../src/decomp/toolchain.js");
const { asmProcessorBuild, pyFloatRepr, pyPath, parseBuildArgs, Encoding } = await import("../src/decomp/asm-processor.js");
const { Makefile } = await import("../src/decomp/makefile.js");
const { parseShell, runRecipeLine, classifyCommand } = await import("../src/decomp/recipe.js");
const { loadMakefile, buildGoal } = await import("../src/decomp/build.js");
const { preprocess, includeClosure } = await import("../src/decomp/cpp.js");
const { unifiedDiff, n64Checksum, iconv, setO32AbiBit } = await import("../src/decomp/host-ports.js");
const { eucJpEncode } = await import("../src/decomp/euc-jp.js");
const { shutdown } = await import("../src/toolchains/_worker/pool.js");

after(async () => { await shutdown(); if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true }); });

const IDO_FLAGS = ["-c", "-G", "0", "-non_shared", "-Xcpluscomm", "-mips2", "-32", "-EB", "-O2"];

function dir(name) { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; }

/** Minimal ELF32 BE reader: section headers + symbols. */
function readElf(buf) {
  assert.equal(buf.readUInt32BE(0), 0x7f454c46, "ELF magic");
  const shoff = buf.readUInt32BE(32), shnum = buf.readUInt16BE(48), shstrndx = buf.readUInt16BE(50);
  const secs = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * 40;
    secs.push({ name: buf.readUInt32BE(o), type: buf.readUInt32BE(o + 4), offset: buf.readUInt32BE(o + 16), size: buf.readUInt32BE(o + 20), link: buf.readUInt32BE(o + 24) });
  }
  const str = (sec, off) => { const s = secs[sec]; const e = buf.indexOf(0, s.offset + off); return buf.subarray(s.offset + off, e).toString("latin1"); };
  for (const s of secs) s.nameStr = str(shstrndx, s.name);
  const symtab = secs.find((s) => s.type === 2);
  const syms = [];
  for (let o = symtab.offset; o < symtab.offset + symtab.size; o += 16) {
    syms.push({ name: str(symtab.link, buf.readUInt32BE(o)), value: buf.readUInt32BE(o + 4), size: buf.readUInt32BE(o + 8), info: buf[o + 12], shndx: buf.readUInt16BE(o + 14) });
  }
  return { secs, syms, e_flags: buf.readUInt32BE(36), section: (n) => { const s = secs.find((x) => x.nameStr === n); return s ? buf.subarray(s.offset, s.offset + s.size) : null; } };
}

test("IDO 5.3 and 7.1 compile a TU as WASM, deterministically", async () => {
  const d = dir("ido");
  fs.writeFileSync(path.join(d, "t.c"), "int g;\nint scale(int a) { return a * 3 + g; }\nfloat half(float x) { return x * 0.5f; }\n");
  for (const version of ["5.3", "7.1"]) {
    const outs = [];
    for (let i = 0; i < 2; i++) {
      const o = `t-${version}-${i}.o`;
      const r = await idoCompile({ version, argv: [`tools/ido/${version}/cc`, ...IDO_FLAGS, "-o", o, "t.c"], cwd: d, tmpRoot: dir("ido-tmp") });
      assert.equal(r.exitCode, 0, r.log);
      outs.push(fs.readFileSync(path.join(d, o)));
    }
    assert.deepEqual(outs[0], outs[1], `IDO ${version}: two compiles of the same TU differ`);
    const elf = readElf(outs[0]);
    assert.ok(elf.syms.some((s) => s.name === "scale" && (s.info & 0xf) === 2), `IDO ${version}: no function symbol 'scale'`);
    assert.ok(elf.section(".text").length >= 8);
  }
});

test("IDO's cc runs its passes (cfe, uopt, ugen, as1) as sibling modules", async () => {
  const d = dir("passes");
  fs.writeFileSync(path.join(d, "t.c"), "int f(int x) { return x + 1; }\n");
  const r = await idoCompile({ version: "5.3", argv: ["cc", ...IDO_FLAGS, "-o", "t.o", "t.c"], cwd: d, tmpRoot: dir("passes-tmp"), trace: true });
  assert.equal(r.exitCode, 0, r.log);
  assert.deepEqual(r.trace.map((a) => path.basename(a[0])), ["cc", "cfe", "uopt", "ugen", "as1"]);
});

test("an IDO error is reported with its exit status (no host fallback)", async () => {
  const d = dir("ido-err");
  fs.writeFileSync(path.join(d, "bad.c"), "int f(void) { return undefined_symbol_q; }\n");
  const r = await idoCompile({ version: "5.3", argv: ["cc", ...IDO_FLAGS, "-o", "bad.o", "bad.c"], cwd: d, tmpRoot: dir("ido-err-tmp") });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.log, /undefined_symbol_q/);
  assert.equal(fs.existsSync(path.join(d, "bad.o")), false);
});

test("mips-linux-gnu as writes traditional-MIPS objects (no section names in .strtab)", async () => {
  const d = dir("as");
  fs.writeFileSync(path.join(d, "a.s"), ".set noreorder\n.text\n.globl fn\nfn:\n  addiu $v0, $a0, 1\n  jr $ra\n  nop\n");
  const r = await binutils("as", ["-march=vr4300", "-32", "-G0", "a.s", "-o", "a.o"], { cwd: d });
  assert.equal(r.exitCode, 0, r.log);
  const elf = readElf(fs.readFileSync(path.join(d, "a.o")));
  const strtab = elf.secs.find((s) => s.nameStr === ".strtab");
  const text = fs.readFileSync(path.join(d, "a.o")).subarray(strtab.offset, strtab.offset + strtab.size).toString("latin1");
  assert.ok(text.includes("fn"));
  assert.ok(!text.includes(".text"), "IRIX-compatible vector: section symbols named in .strtab");
  assert.deepEqual([...elf.section(".text").subarray(0, 12)], [0x24, 0x82, 0x00, 0x01, 0x03, 0xe0, 0x00, 0x08, 0, 0, 0, 0]);
});

test("asm-processor (JS) splices GLOBAL_ASM into the IDO object", async () => {
  const d = dir("asmproc");
  fs.mkdirSync(path.join(d, "asm"), { recursive: true });
  fs.writeFileSync(path.join(d, "asm", "asm_fn.s"), [
    "glabel asm_fn",
    "/* 0 */ lui $at, %hi(D_lit)",
    "/* 4 */ lwc1 $f0, %lo(D_lit)($at)",
    "/* 8 */ jr $ra",
    "/* C */ nop",
    "",
    ".section .late_rodata",
    "glabel D_lit",
    ".word 0x3F800000",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(d, "t.c"), [
    "static int counter;",
    "int c_fn(int a) { counter += a; return counter; }",
    '#pragma GLOBAL_ASM("asm/asm_fn.s")',
    "float other(float x) { return x * 2.0f; }",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(d, "prelude.inc"), ".set noat\n.set noreorder\n.set gp=64\n.macro glabel label\n    .global \\label\n    .type \\label, @function\n    \\label:\n.endm\n");
  const obj = "build/t.o";
  fs.mkdirSync(path.join(d, "build"), { recursive: true });
  const args = ["--convert-statics=global-with-filename", "tools/ido/5.3/cc", "--", "mips-linux-gnu-as", "-march=vr4300", "-32", "-G0", "--", ...IDO_FLAGS, "-o", obj, "t.c"];
  const tmp = dir("asmproc-tmp");
  const r = await asmProcessorBuild({
    args, cwd: d, preludePath: path.join(d, "prelude.inc"), tmpDir: tmp,
    compile: async (argv) => { const x = await idoCompile({ version: "5.3", argv, cwd: d, tmpRoot: tmp }); return { code: x.exitCode, log: x.log }; },
    assemble: async (asArgv, s, o) => { const x = await binutils("as", [...asArgv.slice(1), s, "-o", o], { cwd: d }); return { code: x.exitCode, log: x.log }; },
  });
  assert.equal(r.code, 0, r.log);
  assert.equal(r.functions, 1);
  const elf = readElf(fs.readFileSync(path.join(d, obj)));
  const asmFn = elf.syms.find((s) => s.name === "asm_fn");
  assert.ok(asmFn && (asmFn.info & 0xf) === 2 && asmFn.size === 16, "asm_fn spliced as a sized function");
  assert.ok(!elf.syms.some((s) => s.name.startsWith("_asmpp_")), "temporary names removed");
  const text = elf.section(".text");
  assert.equal(text.readUInt32BE(asmFn.value + 8), 0x03e00008, "jr $ra from the assembled asm");
  const rodata = elf.section(".rodata");
  assert.ok(rodata.includes(Buffer.from([0x3f, 0x80, 0, 0])), "late rodata moved into .rodata");
  assert.ok(elf.syms.some((s) => s.name === "c_fn"));
  assert.deepEqual(r.deps, ["asm/asm_fn.s"]);
});

test("asm-processor helpers keep Python's formatting", () => {
  assert.equal(pyFloatRepr(-4.214684851089404e+19), "-4.214684851089404e+19");
  assert.equal(pyFloatRepr(9.5367431640625e-07), "9.5367431640625e-07");
  assert.equal(pyFloatRepr(1e16), "1e+16");
  assert.equal(pyFloatRepr(123456789012345.6), "123456789012345.6");
  assert.equal(pyFloatRepr(0.0001), "0.0001");
  assert.equal(pyFloatRepr(0.00001), "1e-05");
  assert.equal(pyFloatRepr(1.5), "1.5");
  assert.equal(pyFloatRepr(2), "2.0");
  assert.equal(pyPath("./build//src/./x.o"), "build/src/x.o");
  const p = parseBuildArgs(["--input-enc=utf-8", "cc", "--", "as", "-32", "--", "-c", "-o", "out.o", "in.c"]);
  assert.deepEqual([p.compiler, p.assemblerArgs, p.compileArgs, p.outFile, p.inFile], [["cc"], ["as", "-32"], ["-c"], "out.o", "in.c"]);
  assert.deepEqual([...new Encoding("euc-jp").encode("a\uff5e")], [0x61, 0xa1, 0xc1]);
});

test("EUC-JP encoding matches the JIS X 0208 codec", () => {
  assert.deepEqual([...eucJpEncode("\u3042\u30a2\u301c\uff71")], [0xa4, 0xa2, 0xa5, 0xa2, 0xa1, 0xc1, 0x8e, 0xb1]);
  assert.throws(() => eucJpEncode("\u{1F600}"));
  assert.deepEqual([...iconv(Buffer.from("x\u3042", "utf8"), "UTF-8", "EUC-JP")], [0x78, 0xa4, 0xa2]);
});

test("Makefile reader: flavours, conditionals, functions, pattern and target-specific variables", () => {
  const d = dir("make");
  fs.mkdirSync(path.join(d, "src", "sub"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "a.c"), "");
  fs.writeFileSync(path.join(d, "src", "sub", "b.c"), "");
  fs.writeFileSync(path.join(d, "opts.mk"), "EXTRA := -DEXTRA\n");
  fs.writeFileSync(path.join(d, "Makefile"), [
    "MAKEFLAGS += --no-builtin-rules",
    "-include missing.mk",
    "include opts.mk",
    "find-command = $(shell which $(1) 2>/dev/null)",
    "ifneq ($(call find-command,mips-linux-gnu-ld),)",
    "  PREFIX := mips-linux-gnu-",
    "else",
    "  $(error no binutils)",
    "endif",
    "OPT ?= -O2",
    "CFLAGS = $(OPT) $(EXTRA)",
    "CFLAGS += -G 0",
    "SRC_DIRS := $(shell find src -type d)",
    "C_FILES := $(foreach dir,$(SRC_DIRS),$(wildcard $(dir)/*.c))",
    "O_FILES := $(C_FILES:%.c=build/%.o)",
    "define banner",
    "  @printf \"$(1)\\n\"",
    "endef",
    "build/src/sub/%.o: OPT := -O1",
    "build/src/a.o: CFLAGS += -DONLY_A",
    "all: $(O_FILES)",
    "build/special.o: src/a.c",
    "\tcc -I $(dir $*) -o $@ $<",
    "build/%.o: %.c",
    "\t$(call banner,cc $<)",
    "\tcc $(CFLAGS) -I $(dir $*) -o $@ $<",
    "ifeq ($(OPT),-O2)",
    "\t$(PREFIX)objcopy --remove-section .mdebug $@",
    "endif",
    "",
  ].join("\n"));
  const mk = new Makefile({ root: d, overrides: { VERBOSE: "1" } });
  mk.readFile(path.join(d, "Makefile"), false);
  assert.deepEqual(mk.value("O_FILES").split(" ").sort(), ["build/src/a.o", "build/src/sub/b.o"]);
  const a = mk.recipeFor("build/src/a.o");
  assert.deepEqual(a.lines.map((l) => l.command), ["printf \"cc src/a.c\\n\"", "cc -O2 -DEXTRA -G 0 -DONLY_A -I src/ -o build/src/a.o src/a.c", "mips-linux-gnu-objcopy --remove-section .mdebug build/src/a.o"]);
  const b = mk.recipeFor("build/src/sub/b.o");
  assert.equal(b.lines[1].command, "cc -O1 -DEXTRA -G 0 -I src/sub/ -o build/src/sub/b.o src/sub/b.c");
  assert.equal(b.lines.length, 3, "the recipe conditional is evaluated when the makefile is read");
  assert.equal(mk.recipeFor("build/special.o").lines[0].command, "cc -I  -o build/special.o src/a.c", "$* is empty in an explicit rule once -r cleared the suffix list");
  const cl = new Makefile({ root: d, overrides: { OPT: "-O3" } });
  cl.readFile(path.join(d, "Makefile"), false);
  assert.match(cl.recipeFor("build/src/a.o").lines[1].command, /^cc -O3 /, "command-line variables win");
});

test("recipe shell parsing and dispatch never name a host program", () => {
  const l = parseShell("cpp -P -I inc x.s | iconv --from-code=UTF-8 --to-code=EUC-JP | mips-linux-gnu-as -32 -o out.o && echo done > /dev/null; false || true");
  assert.equal(l.length, 4);
  assert.deepEqual(l[0].pipeline.map((c) => c.argv[0]), ["cpp", "iconv", "mips-linux-gnu-as"]);
  assert.equal(l[1].op, "&&");
  assert.deepEqual(l[1].pipeline[0].redirects, [{ fd: 1, op: ">", target: "/dev/null" }]);
  assert.equal(classifyCommand(["tools/ido-static-recomp/build/5.3/out/cc"]).kind, "ido");
  assert.equal(classifyCommand([".venv/bin/python3", "tools/asm-processor/build.py"]).kind, "asm-processor");
  assert.equal(classifyCommand(["python3", "tools/other.py"]).kind, "unsupported");
  assert.equal(classifyCommand(["gcc", "-fsyntax-only", "x.c"]).kind, "syntax-check");
  assert.equal(classifyCommand(["make"]).kind, "unsupported");
  assert.deepEqual(toolName("mips64-elf-objdump"), { kind: "binutils", tool: "objdump", prefix: "mips64-elf-" });
});

test("cpp | iconv | as recipe line runs through cc1, JS iconv and WASM as", async () => {
  const d = dir("pipe");
  fs.mkdirSync(path.join(d, "inc"), { recursive: true });
  fs.writeFileSync(path.join(d, "inc", "macro.inc"), "#define VALUE 0x1234\n");
  fs.writeFileSync(path.join(d, "x.s"), '#include "macro.inc"\n.text\n.word VALUE\n.asciz "\u3042"\n');
  const r = await runRecipeLine("cpp -P -I inc x.s | iconv --from-code=UTF-8 --to-code=EUC-JP | mips-linux-gnu-as -march=vr4300 -32 -G0 -o x.o", { cwd: d, tmpRoot: dir("pipe-tmp") });
  assert.equal(r.code, 0, r.log);
  const text = readElf(fs.readFileSync(path.join(d, "x.o"))).section(".text");
  assert.deepEqual([...text.subarray(0, 7)], [0, 0, 0x12, 0x34, 0xa4, 0xa2, 0]);
});

test("the WASM preprocessor mounts exactly the reachable headers", async () => {
  const d = dir("cpp");
  fs.mkdirSync(path.join(d, "include"), { recursive: true });
  fs.writeFileSync(path.join(d, "include", "a.h"), "#include \"b.h\"\n#define A 1\n");
  fs.writeFileSync(path.join(d, "include", "b.h"), "typedef int b_t;\n#ifdef NEVER\n#include <never.h>\n#endif\n");
  fs.writeFileSync(path.join(d, "include", "unused.h"), "#error unused\n");
  fs.writeFileSync(path.join(d, "t.c"), "#include \"a.h\"\nb_t v = A;\n");
  const c = includeClosure(d, ["t.c"], { includes: ["include"] });
  assert.deepEqual(c.files.map((f) => path.relative(d, f)).sort(), ["include/a.h", "include/b.h", "t.c"]);
  assert.deepEqual(c.missing, ["never.h"]);
  const r = await preprocess({ cwd: d, args: ["-E", "-P", "-nostdinc", "-I", "include", "t.c"] });
  assert.equal(r.exitCode, 0, r.log);
  assert.match(r.output.toString(), /typedef int b_t;\s*b_t v = 1;/);
  const deps = await preprocess({ cwd: d, args: ["-MM", "-MG", "-nostdinc", "-I", "include", "t.c"] });
  assert.match(deps.deps, /t\.o: t\.c include\/a\.h include\/b\.h/);
  // A computed include is resolved by cc1 itself: the search path's headers are mounted.
  fs.writeFileSync(path.join(d, "c.c"), "#define HDR \"unused2.h\"\n#include HDR\nint c = U2;\n");
  fs.writeFileSync(path.join(d, "include", "unused2.h"), "#define U2 7\n");
  const comp = await preprocess({ cwd: d, args: ["-E", "-P", "-nostdinc", "-I", "include", "c.c"] });
  assert.equal(comp.exitCode, 0, comp.log);
  assert.match(comp.output.toString(), /int c = 7;/);
});

test("build.js builds a synthetic project from its Makefile entirely as WASM", async () => {
  const d = dir("proj");
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "main.c"), "extern int helper(int);\nint entry(void) { return helper(41); }\n");
  fs.writeFileSync(path.join(d, "src", "helper.c"), "int helper(int x) { return x + 1; }\n");
  fs.writeFileSync(path.join(d, "link.ld"), "SECTIONS { . = 0x80000400; .text : { build/src/main.o(.text) build/src/helper.o(.text) } /DISCARD/ : { *(*) } }\n");
  fs.writeFileSync(path.join(d, "Makefile"), [
    "CC := ido/5.3/cc",
    "O_FILES := build/src/main.o build/src/helper.o",
    "$(shell mkdir -p build/src)",
    "all: build/out.bin",
    "build/out.bin: build/out.elf",
    "\tmips-linux-gnu-objcopy -O binary $< $@",
    "build/out.elf: $(O_FILES) link.ld",
    "\tmips-linux-gnu-ld -T link.ld -o $@",
    "build/%.o: %.c",
    "\t@gcc -fsyntax-only -m32 $<",
    `\t$(CC) ${IDO_FLAGS.join(" ")} -o $@ $<`,
    "\tmips-linux-gnu-objcopy --remove-section .mdebug $@",
    "",
  ].join("\n"));
  const mk = await loadMakefile(d);
  const r = await buildGoal(mk, "all", { always: true, jobs: 2, tmpRoot: dir("proj-tmp") });
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.deepEqual(r.keptPrebuilt, []);
  const bin = fs.readFileSync(path.join(d, "build", "out.bin"));
  assert.ok(bin.length >= 16);
  // entry's jal targets helper's linked address (0x80000400 + main's size).
  const jal = [...Array(bin.length / 4).keys()].map((i) => bin.readUInt32BE(i * 4)).find((w) => w >>> 26 === 3);
  assert.ok(jal, "a jal in the linked text");
  const target = (0x80000000 | ((jal & 0x03ffffff) << 2)) >>> 0;
  assert.ok(target > 0x80000400 && target < 0x80000400 + bin.length, "jal resolved inside the image");
  // A recipe with no WASM equivalent is refused, not delegated.
  fs.appendFileSync(path.join(d, "Makefile"), "gen.bin:\n\tpython3 tools/gen.py $@\n");
  const r2 = await buildGoal(await loadMakefile(d), "gen.bin", { tmpRoot: dir("proj-tmp2") });
  assert.equal(r2.ok, false);
  assert.match(r2.failed.message, /no romdev port/);
});

test("host-program ports: diff -u, n64crc, set_o32abi_bit", () => {
  assert.equal(unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { labelA: "a/x.c", labelB: "b/x.c" }), "--- a/x.c\n+++ b/x.c\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  assert.equal(unifiedDiff("same\n", "same\n"), "");
  assert.equal(unifiedDiff("x", "y"), "--- a\n+++ b\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n");
  const rom = Buffer.alloc(0x101000);
  for (let i = 0x1000; i < rom.length; i += 4) rom.writeUInt32BE((i * 2654435761) >>> 0, i);
  const [c1, c2] = n64Checksum(rom);
  assert.ok(Number.isInteger(c1) && Number.isInteger(c2));
  rom.writeUInt32BE(0xdeadbeef, 0x10);
  assert.deepEqual(n64Checksum(rom), [c1, c2], "the header CRC words are outside the checksummed range");
  const d = dir("elf");
  const f = path.join(d, "e.o");
  const elf = Buffer.alloc(52); elf.writeUInt32BE(0x7f454c46, 0); elf.writeUInt32BE(0x20000101, 36);
  fs.writeFileSync(f, elf);
  setO32AbiBit(f);
  assert.equal(fs.readFileSync(f).readUInt32BE(36), 0x20001101);
});

test("armips (WASM) assembles RSP source in place, as a project's rsp rule does", async () => {
  const { armips } = await import("../src/decomp/toolchain.js");
  const d = dir("armips");
  fs.writeFileSync(path.join(d, "t.asm"), '.rsp\n.create "t.bin", 0x04001080\n  addi r1, r0, 0x10\n  j 0x04001080\n  nop\n.close\n');
  const r = await armips(["t.asm"], { cwd: d });
  assert.equal(r.exitCode, 0, r.log);
  const bin = fs.readFileSync(path.join(d, "t.bin"));
  assert.deepEqual([...bin.subarray(0, 4)], [0x20, 0x01, 0x00, 0x10]);
  assert.equal(bin.readUInt32BE(4), 0x09000420, "j target field = 0x04001080 >> 2");
});

test("asset container port encodes ia8/rgba16/rgba32 PNG sheets and raw ranges exactly", async () => {
  const { buildAssetContainer, encodeTexture } = await import("../src/decomp/host-ports.js");
  const { PNG } = await import("pngjs");
  const d = dir("assets");
  const png = (name, w, h, px) => { const p = new PNG({ width: w, height: h }); px.forEach((v, i) => { p.data[i] = v; }); fs.writeFileSync(path.join(d, name), PNG.sync.write(p)); };
  png("ia.png", 2, 1, [0x11, 0x11, 0x11, 0xff, 0xff, 0xff, 0xff, 0x22]);
  png("c16.png", 1, 1, [0xff, 0x08, 0x00, 0xff]);
  png("c32.png", 1, 1, [1, 2, 3, 4]);
  fs.writeFileSync(path.join(d, "raw.bin"), Buffer.from([9, 9, 9]));
  fs.writeFileSync(path.join(d, "layout.json"), JSON.stringify({ size: 11, segments: [
    { offset: 0, size: 3, file: "raw.bin", format: "raw" },
    { offset: 3, size: 2, file: "ia.png", format: "ia8", width: 2, height: 1 },
    { offset: 5, size: 2, file: "c16.png", format: "rgba16", width: 1, height: 1 },
    { offset: 7, size: 4, file: "c32.png", format: "rgba32", width: 1, height: 1 },
  ] }));
  const out = await buildAssetContainer(path.join(d, "layout.json"));
  assert.deepEqual([...out], [9, 9, 9, 0x1f, 0xf2, 0xf8, 0x41, 1, 2, 3, 4]);
  png("bad.png", 1, 1, [0x12, 0x12, 0x12, 0xff]);
  await assert.rejects(encodeTexture(path.join(d, "bad.png"), "ia8"), /multiples of 17/);
});

test("runArgv threads ido overrides (cwd, env) into the IDO compile", async () => {
  const { runArgv } = await import("../src/decomp/recipe.js");
  const d = dir("idocwd"), other = dir("idocwd-other");
  fs.writeFileSync(path.join(d, "t.c"), "int f(int x) { return x; }\n");
  const r = await runArgv(["tools/ido/5.3/cc", ...IDO_FLAGS, "-o", path.join(d, "t.o"), path.join(d, "t.c")], { cwd: d, tmpRoot: dir("idocwd-tmp"), ido: { cwd: other } });
  assert.equal(r.code, 0, r.log);
  assert.equal(r.kind, "ido");
  assert.ok(fs.existsSync(path.join(d, "t.o")));
});

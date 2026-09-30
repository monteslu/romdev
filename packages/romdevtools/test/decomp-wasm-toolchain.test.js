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
  assert.equal(classifyCommand([".venv/bin/python3", "tools/asm-processor/build.py"]).kind, "asm-processor"); // no-python-guard: classifier fixture - recognising a project's build.py step, never launching it
  assert.equal(classifyCommand(["python3", "tools/other.py"]).kind, "unsupported"); // no-python-guard: classifier fixture - an unported project script must classify as unsupported
  assert.equal(classifyCommand(["gcc", "-fsyntax-only", "x.c"]).kind, "syntax-check");
  assert.equal(classifyCommand(["make"]).kind, "make", "a recursive make is read by romdev, never run");
  assert.equal(classifyCommand(["bash", "tools/x.sh"]).kind, "unsupported");
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

test("KMC gcc 2.7.2 (WASM) runs a project's cpp | iconv | gcc -x c - pipeline", async () => {
  const d = dir("kmc");
  fs.mkdirSync(path.join(d, "tools/gcc_kmc/linux/2.7.2"), { recursive: true });
  fs.writeFileSync(path.join(d, "t.c"), 'const char msg[] = "\u3042";\nunsigned int u(float f) { return f; }\nint add3(int a) { return a + 3; }\n');
  const cc = "COMPILER_PATH=tools/gcc_kmc/linux/2.7.2 tools/gcc_kmc/linux/2.7.2/gcc";
  const flags = "-mabi=32 -mgp32 -mfp32 -nostdinc -fno-PIC -mno-abicalls -G 0 -mips3 -EB -O2 -w";
  const line = `${cc} ${flags} -E t.c | iconv --from-code=UTF-8 --to-code=Shift-JIS | ${cc} -x c ${flags} -c -o t.o -`;
  const r = await runRecipeLine(line, { cwd: d, tmpRoot: dir("kmc-tmp") });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.steps.map((s) => s.kind), ["decomp-gcc", "iconv", "decomp-gcc"]);
  const elf = readElf(fs.readFileSync(path.join(d, "t.o")));
  assert.ok(elf.syms.some((s) => s.name === "add3" && (s.info & 0xf) === 2));
  assert.ok(elf.syms.some((s) => s.name === "gcc2_compiled."), "gcc 2.x marker symbol");
  const data = Buffer.concat([elf.section(".data") ?? Buffer.alloc(0), elf.section(".rodata") ?? Buffer.alloc(0)]);
  assert.ok(data.includes(Buffer.from([0x82, 0xa0])), "the string was converted to Shift-JIS before compiling");
  // float -> unsigned needs 2^31 as a float constant: a host-endianness bug in
  // the build once turned it into a denormal loaded from .rodata.
  assert.ok(elf.section(".text").includes(Buffer.from([0x3c, 0x01, 0x4f, 0x00])), "lui at,0x4f00 (2^31 as a float) in u()");
  const bad = await runRecipeLine(`${cc} ${flags} -E missing.c | ${cc} -x c ${flags} -c -o m.o -`, { cwd: d, tmpRoot: dir("kmc-tmp2") });
  assert.notEqual(bad.code, 0, "pipefail: a failed first stage fails the step");
});

test("glibc iconv tables: Shift-JIS and EUC-JP reproduce glibc's choices", async () => {
  const { iconvEncode } = await import("../src/decomp/iconv-tables.js");
  // (U+005C and U+007E stay ASCII; U+00A5/U+203E fold onto them; U+FF5E has no SHIFT_JIS mapping in glibc.)
  assert.deepEqual([...iconvEncode("\\~\u00a5\u203e\u301c\u2212\u00a2", "Shift-JIS")], [0x5c, 0x7e, 0x5c, 0x7e, 0x81, 0x60, 0x81, 0x7c, 0x81, 0x91]);
  assert.deepEqual([...iconvEncode("\uffe0\u2460".slice(0, 1), "SHIFT_JIS")], [0x81, 0x91]);
  assert.throws(() => iconvEncode("\uff5e", "Shift-JIS"), /cannot convert/);
  assert.throws(() => iconvEncode("\u2460", "Shift-JIS"), /cannot convert/, "NEC row 13 is not in glibc SHIFT_JIS");
  assert.deepEqual([...iconvEncode("\u3042\uff71\u4e28\u0085", "EUC-JP")], [0xa4, 0xa2, 0x8e, 0xb1, 0x8f, 0xb0, 0xa9, 0x85]);
  assert.throws(() => iconvEncode("\uffe0", "EUC-JP"), /cannot convert/);
});

test("glibc iconv tables: EUC-CN is GB 2312 with glibc's two GB2312.TXT readings", async () => {
  const { iconvEncode, iconvTable } = await import("../src/decomp/iconv-tables.js");
  assert.equal(iconvTable("EUC-CN").size, 7445);
  assert.deepEqual([...iconvEncode("a\u4e2d\u6587\u3000", "EUC-CN")], [0x61, 0xd6, 0xd0, 0xce, 0xc4, 0xa1, 0xa1]);
  assert.deepEqual([...iconvEncode("\u30fb\u2015\u9f44", "GB2312")], [0xa1, 0xa4, 0xa1, 0xaa, 0xf7, 0xfe]);
  assert.throws(() => iconvEncode("\u00b7", "EUC-CN"), /cannot convert/, "GBK's reading of 0xA1A4 is not glibc's");
  assert.throws(() => iconvEncode("\u2170", "EUC-CN"), /cannot convert/, "GBK row 0xA2 additions are not GB 2312");
  assert.throws(() => iconvEncode("\u0085", "EUC-CN"), /cannot convert/, "EUC-CN has no C1 bytes");
  assert.deepEqual([...iconv(Buffer.from("\u6c49", "utf8"), "UTF-8", "EUC-CN")], [0xba, 0xba]);
});

test("Makefile reader: shortest-stem pattern rule wins; recursive $(MAKE) -C runs as a sub-build", async () => {
  const d = dir("submake");
  fs.mkdirSync(path.join(d, "lib"), { recursive: true });
  fs.writeFileSync(path.join(d, "Makefile"), [
    "build/%.o: %.c", "\techo general > $@",
    "build/lib/%.o: lib/%.c", "\t$(MAKE) -C lib OUT=../$@ ../$@", "",
  ].join("\n"));
  fs.writeFileSync(path.join(d, "lib", "Makefile"), ["../build/lib/%.o: %.c", "\tmkdir -p ../build/lib", "\techo sub $(OUT) > $@", ""].join("\n"));
  fs.writeFileSync(path.join(d, "lib", "x.c"), "");
  fs.mkdirSync(path.join(d, "build", "lib"), { recursive: true });
  const mk = await loadMakefile(d);
  const r = mk.recipeFor("build/lib/x.o");
  assert.equal(r.lines[0].command, "make -C lib OUT=../build/lib/x.o ../build/lib/x.o", "the lib/ rule (shorter stem) is chosen over the earlier general rule");
  const b = await buildGoal(mk, "build/lib/x.o", { always: true, tmpRoot: dir("submake-tmp") });
  assert.equal(b.ok, true, JSON.stringify(b.failed));
  assert.equal(fs.readFileSync(path.join(d, "build", "lib", "x.o"), "utf8"), "sub ../build/lib/x.o\n");
});

test("Makefile reader: static pattern rules, and an -included makefile with a rule is remade and re-read", async () => {
  const d = dir("remake");
  fs.writeFileSync(path.join(d, "Makefile"), [
    "OBJS :=", "-include deps.mk",
    "all: $(OBJS)", "",
    "deps.mk: list.txt", "\tprintf 'OBJS := a.o b.o\\n' > $@", "",
    "$(OBJS): %.o: %.src", "\techo $* > $@", "",
    "$(filter c.o,$(OBJS)): %.o: %.src", "\techo never > $@", "",
  ].join("\n"));
  for (const f of ["list.txt", "a.src", "b.src"]) fs.writeFileSync(path.join(d, f), "");
  const mk = await loadMakefile(d);
  assert.deepEqual(mk.includes, ["deps.mk"]);
  const b = await buildGoal(mk, "all", { tmpRoot: dir("remake-tmp") });
  assert.equal(b.ok, true, JSON.stringify(b.failed));
  assert.equal(fs.readFileSync(path.join(d, "a.o"), "utf8"), "a\n", "$* is the static pattern's stem");
  assert.equal(fs.readFileSync(path.join(d, "b.o"), "utf8"), "b\n");
});

test("mips-linux-gnu-gcc 14.2 (WASM driver, cc1 and as as sibling modules) compiles a data TU", async () => {
  const d = dir("modern-gcc");
  fs.writeFileSync(path.join(d, "t.c"), "int tbl[3] = {1, 2, 3};\nconst char msg[] = \"hi\";\nint f(int x) { return x * 3; }\n");
  const flags = "-G 0 -nostdinc -march=vr4300 -mfix4300 -mabi=32 -mno-abicalls -fno-PIC -O2";
  assert.equal(classifyCommand(["mips-linux-gnu-gcc", "-c", "t.c"]).kind, "decomp-gcc");
  const r = await runRecipeLine(`mips-linux-gnu-gcc ${flags} -c t.c -o t.o`, { cwd: d, tmpRoot: dir("modern-gcc-tmp") });
  assert.equal(r.code, 0, r.log);
  const o = fs.readFileSync(path.join(d, "t.o"));
  const e = readElf(o);
  assert.deepEqual([...e.section(".data").subarray(0, 12)], [0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3]);
  assert.match(e.section(".comment").toString("latin1"), /GCC: \(GNU\) 14\.2\.0/);
  assert.equal(e.section(".text").readUInt32BE(0), 0x00041040, "f: sll v0,a0,1 (x*3 as shift+add)");
  // Target macros are mips-linux-gnu's own.
  const m = await runRecipeLine("mips-linux-gnu-gcc -E -dM -nostdinc -x c t.c", { cwd: d, tmpRoot: dir("modern-gcc-tmp") });
  assert.match(m.log, /#define __linux__ 1/);
  assert.match(m.log, /#define _MIPS_SIM _ABIO32/);
});

test("decomp build tools as WASM: pigment64, crunch64 gzip, vanilla raw deflate", async () => {
  const zlib = await import("node:zlib");
  const { decompTool } = await import("../src/decomp/toolchain.js");
  const d = dir("rust-tools");
  const { PNG } = await import("pngjs");
  const png = new PNG({ width: 2, height: 1 });
  png.data = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0]);
  fs.writeFileSync(path.join(d, "t.png"), PNG.sync.write(png));
  let r = await decompTool("pigment64", ["to-bin", "--format", "rgba16", "-o", "t.bin", "t.png"], { cwd: d });
  assert.equal(r.exitCode, 0, r.log);
  assert.deepEqual([...fs.readFileSync(path.join(d, "t.bin"))], [0xf8, 0x01, 0x00, 0x3e], "red opaque, blue transparent");
  const input = Buffer.from("romdev ".repeat(500));
  fs.writeFileSync(path.join(d, "in.bin"), input);
  r = await decompTool("crunch64", ["compress", "gzip", "in.bin", "out.gz", "--level", "9", "--small-mem"], { cwd: d });
  assert.equal(r.exitCode, 0, r.log);
  assert.deepEqual(zlib.inflateRawSync(fs.readFileSync(path.join(d, "out.gz"))), input, "crunch64's gzip is a raw deflate stream");
  r = await decompTool("raw-deflate", ["6", "in.bin", "out.raw"], { cwd: d });
  assert.equal(r.exitCode, 0, r.log);
  assert.deepEqual(zlib.inflateRawSync(fs.readFileSync(path.join(d, "out.raw"))), input);
});

test("project build scripts: JS ports by content hash, and `uv run python` resolves to them", async () => {
  const { incFromBin, msgReencode } = await import("../src/decomp/host-ports.js");
  assert.equal(incFromBin(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 0xab])), "    /* 0x000000 */ 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,\n    /* 0x000008 */ 0xAB,");
  const i = '# 1 "m.msg"\nconst char a[] = "A\u3042";\n# 2 "m.msg" "x"\nb = "\u4e2d";\n';
  assert.equal(msgReencode(i, "Shift-JIS"), '# 1 "m.msg"\nconst char a[] = "A\\x82""\\xA0""";\n# 2 "m.msg" "x"\nb = "\\x92""\\x86""";\n');
  assert.equal(msgReencode('#\nx = "\u4e2d";', "EUC-CN"), '#\nx = "\\xD6""\\xD0""";');
  const d = dir("ported");
  fs.writeFileSync(path.join(d, "inc_from_bin.py"), "print('not the ported script')\n");
  assert.equal(classifyCommand(["uv", "run", "python", "inc_from_bin.py", "a", "b"], d).kind, "unsupported", "different bytes = different program");
  assert.equal(classifyCommand(["uv", "run", "--no-sync", "md5sum", "x"], d).kind, "sha1sum");
});

test("EGCS 1.1.2 (WASM driver, cccp, cc1, binutils 2.9.5 as) compiles a TU through the expanders", async () => {
  const d = dir("egcs");
  fs.writeFileSync(path.join(d, "t.c"), "int g;\nint f(int x) { return x * 3 + g; }\n");
  const cc = "tools/gcc_egcs/linux/1.1.2-4/gcc";
  assert.equal(classifyCommand([cc, "-c", "t.c"]).family, "egcs-1.1.2");
  const r = await runRecipeLine(`${cc} -G 0 -mips3 -mabi=32 -mgp32 -mfp32 -O2 -g -c -o t.o t.c`, { cwd: d, tmpRoot: dir("egcs-tmp") });
  assert.equal(r.code, 0, r.log);
  const e = readElf(fs.readFileSync(path.join(d, "t.o")));
  const text = e.section(".text");
  // lui/lw of g, then x*3 as sll+addu: the expanders got both operands
  // (a variadic call through insn_gen_function once dropped the second).
  const words = [];
  for (let i = 0; i < text.length; i += 4) words.push(text.readUInt32BE(i));
  assert.ok(words.includes(0x00041840) || words.includes(0x00041040), words.map((w) => w.toString(16)).join(" "));
  assert.ok(e.section(".mdebug"), "-g writes ECOFF .mdebug through as 2.9.5");
});

test("maspsx port: nops, $at expansion, gp-relative loads and div expansion as maspsx writes them", async () => {
  const { MaspsxProcessor, maspsxMain } = await import("../src/decomp/maspsx.js");
  const clean = (lines) => lines.map((l) => l.split("#")[0].trim()).filter((l) => l.length);
  // maspsx tests/test_at.py
  assert.deepEqual(clean(new MaspsxProcessor(["lh\t$2,32767($2)", "lh\t$2,32767($2)"]).processLines()), ["lh\t$2,32767($2)", "nop", "lh\t$2,32767($2)"]);
  assert.deepEqual(clean(new MaspsxProcessor(["lh\t$2,32767($2)", "lh\t$2,32768($2)"], { nopAtExpansion: true }).processLines()),
    ["lh\t$2,32767($2)", "nop", ".set\tnoat", "lui\t$at,%hi(32768)", "addu\t$at,$2,$at", "lh\t$2,%lo(32768)($at)", ".set\tat"]);
  // small data: -G8 turns a load of an .sdata symbol gp-relative, and appends .sbss for small .comm
  const g = clean(new MaspsxProcessor([".sdata", "x:", ".word\t1", ".text", "lw\t$2,x", "addu\t$3,$4,$5", ".comm\ty,4"], { sdataLimit: 8 }).processLines());
  assert.ok(g.includes("lw\t$2,%gp_rel(x)($gp)"), g.join("|"));
  assert.deepEqual(g.slice(-4), [".section .sbss", ".align 2", "y:", ".space 4"]);
  // command line: --expand-div with the aspsx version gate, output framed like maspsx.py
  const r = maspsxMain(["--expand-div", "--aspsx-version=2.34"], { stdin: Buffer.from("\tdiv\t$2,$4,$5\n\taddu\t$3,$2,$4\n") });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith("\n# EXPAND_DIV START\n.set\tnoat\ndiv\t$zero,$4,$5\nbnez\t$5,.L_NOT_DIV_BY_ZERO_0\n"), r.stdout);
  assert.ok(r.stdout.endsWith("\n"));
  const bad = maspsxMain([], { stdin: Buffer.from("\tlw\t$2,(\n") });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /MASPSX: An exception occurred: Unable to parse load\/store instruction/);
});

test("PS1 gcc 2.6.3-psx cc1 (WASM) compiles little-endian R3000 code through a cc1-psx-26 recipe step", async () => {
  const d = dir("psx");
  fs.mkdirSync(path.join(d, "bin"), { recursive: true });
  fs.writeFileSync(path.join(d, "t.c"), "unsigned char lo(unsigned int *p) { return *(unsigned char *)p; }\n");
  assert.equal(classifyCommand(["bin/cc1-psx-26"]).family, "psx-gcc-2.6.3");
  const r = await runRecipeLine("bin/cc1-psx-26 -G0 -O2 -quiet -mcpu=3000 -msoft-float -mgas t.c -o t.s", { cwd: d, tmpRoot: dir("psx-tmp") });
  assert.equal(r.code, 0, r.log);
  const s = fs.readFileSync(path.join(d, "t.s"), "utf8");
  assert.match(s, /lbu\s+\$2,0\(\$4\)/, "the low byte of a little-endian word is at offset 0");
  assert.match(s, /Sony Playstation/);
});

test("PS1 gcc 2.6.3-psx driver (WASM) runs cpp, cc1 and the mipsel as step like the cc1 path", async () => {
  const d = dir("psx-driver");
  const tmpRoot = dir("psx-driver-tmp");
  fs.writeFileSync(path.join(d, "t.c"), [
    "struct S { int a; short b; unsigned char c[4]; };",
    "extern int g;",
    "static int tab[4] = { 1, 2, 3, 4 };",
    "int f(struct S *s, int n) { int i, acc = 0; for (i = 0; i < n; i++) acc += s->c[i & 3] * tab[i & 3] + g / (n + 1); if (s->b > 7) acc ^= s->a; return acc; }",
    "unsigned char lo(unsigned int *p) { return *(unsigned char *)p; }", ""].join("\n"));
  const gcc = "bin/gcc-2.6.3-psx/gcc";
  assert.equal(classifyCommand([gcc, "-c", "t.c"]).family, "psx-gcc-2.6.3");
  const FL = "-G0 -O2 -w -funsigned-char -fpeephole -ffunction-cse -fpcc-struct-return -fcommon -msoft-float -fgnu-linker -mgas";
  const run = async (line) => { const r = await runRecipeLine(line, { cwd: d, tmpRoot }); assert.equal(r.code, 0, `${line}\n${r.log}`); return r; };
  // .s: the driver (cpp -> cc1) and cc1 on the driver's own preprocessed output.
  await run(`${gcc} -S ${FL} t.c -o drv.s`);
  await run(`${gcc} -E ${FL} t.c -o t.i`);
  await run(`bin/cc1-psx-26 ${FL} -quiet t.i -o cc1.s`);
  const drvS = fs.readFileSync(path.join(d, "drv.s"), "utf8"), cc1S = fs.readFileSync(path.join(d, "cc1.s"), "utf8");
  // cc1 echoes its own argv as " # ..." comments; everything else is identical.
  const code = (s) => s.split("\n").filter((l) => !l.startsWith(" #")).join("\n");
  assert.ok(code(drvS).length > 500 && /lbu\s+\$2,0\(\$4\)/.test(drvS), drvS);
  assert.equal(code(drvS), code(cc1S));
  // .o: the driver's as step (romdev's mips-linux-gnu-as, -EL from the specs)
  // against cc1 -> mipsel-linux-gnu-as with the same assembler flags.
  await run(`${gcc} -c ${FL} -Wa,-march=r3000,-mtune=r3000,-no-pad-sections t.c -o drv.o`);
  await run("mipsel-linux-gnu-as -G0 -O2 -march=r3000 -mtune=r3000 -no-pad-sections -o cc1.o cc1.s");
  const o = fs.readFileSync(path.join(d, "drv.o"));
  assert.equal(o[5], 1, "ELFDATA2LSB: little-endian object");
  assert.ok(o.equals(fs.readFileSync(path.join(d, "cc1.o"))), "driver .o == cc1 + as .o");
  // The driver's error texts come from its sys_errlist (built from strerror).
  const miss = await runRecipeLine(`${gcc} -S nosuch.c`, { cwd: d, tmpRoot });
  assert.equal(miss.code, 1);
  assert.match(miss.log, /gcc: nosuch\.c: No such file or directory/);
});

test("mips-linux-gnu-cpp (WASM) pre-includes stdc-predef.h like Debian's cross cpp, and skips it where gcc does", async () => {
  const d = dir("predef");
  fs.writeFileSync(path.join(d, "empty.c"), "");
  const { decompGcc } = await import("../src/decomp/toolchain.js");
  const macros = async (args) => {
    const r = await decompGcc({ family: "mips-linux-gnu-14.2", argv: ["mips-linux-gnu-cpp", "-dM", ...args, "empty.c"], cwd: d, tmpRoot: dir("predef-tmp") });
    assert.equal(r.exitCode, 0, r.stderr);
    return new Set(r.stdout.toString("utf8").split("\n").filter(Boolean));
  };
  const plain = await macros([]);
  assert.ok(plain.size > 300);
  for (const m of ["#define _STDC_PREDEF_H 1", "#define __STDC_IEC_559__ 1", "#define __STDC_ISO_10646__ 201706L",
    "#define _TIME_BITS 64", "#define _FILE_OFFSET_BITS 64"]) assert.ok(plain.has(m), m);
  assert.ok(!plain.has("#define __mips_no_madd4 1"), "Debian configures madd4 only for mipsel");
  // TARGET_C_PREINCLUDE is skipped under -nostdinc and -ffreestanding (and for preprocessed input).
  for (const flag of ["-nostdinc", "-ffreestanding"]) {
    const m = await macros([flag]);
    assert.ok(!m.has("#define _STDC_PREDEF_H 1"), flag);
    assert.ok(m.has("#define __mips__ 1"), flag);
  }
  // -undef drops the target macros, not the pre-include.
  assert.ok((await macros(["-undef"])).has("#define _STDC_PREDEF_H 1"));
  // Debian's own cross cpp as the oracle, when one is at hand.
  const oracle = process.env.ROMDEV_TEST_DEBIAN_MIPS_CPP;
  if (oracle) {
    const { execFileSync } = await import("node:child_process");
    for (const args of [[], ["-nostdinc"], ["-ffreestanding"], ["-undef"], ["-EL"], ["-march=vr4300", "-mabi=32", "-mno-abicalls", "-fno-pic", "-G0"], ["-D_TIME_BITS=32"], ["-std=c89"], ["-x", "assembler-with-cpp"]]) {
      const want = new Set(execFileSync(oracle, ["-dM", ...args, "empty.c"], { cwd: d, encoding: "utf8" }).split("\n").filter(Boolean));
      assert.deepEqual([...(await macros(args))].sort(), [...want].sort(), args.join(" "));
    }
  }
});

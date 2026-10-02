// import.mjs (upstream import.py) end to end on a scratch project: the
// Makefile is read in JS, cpp / IDO / the assembler run as romdev's WASM, and
// the imported directory then permutes to score 0 through permuter.mjs's
// in-process compile of the generated compile.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importMain, resolveToolchainUrl, fixup_build_command, finalize_compile_command, prune_asm, shq, fnmatch } from "../src/import.js";
import { workDir, removeDir } from "./helpers/work.js";
import { IDO } from "./helpers/payloads.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolchain = resolveToolchainUrl();

test("fixup_build_command drops deps flags, the output and the source, and unwraps asm-processor", () => {
  // A recorded build line that wraps the compiler in asm-processor (data read
  // from a fixture: the command is parsed, never run).
  const recorded = readFileSync(path.join(here, "fixtures", "asm-processor-build-line.txt"), "utf8").trim().split(/\s+/);
  const [cmd, asm] = fixup_build_command(recorded, "src/a.c");
  assert.deepEqual(cmd, ["tools/cc", "-c", "-O2"]);
  assert.deepEqual(asm, ["mips-linux-gnu-as", "-march=vr4300"]);
  assert.equal(finalize_compile_command(["cc", "-c", "|", "iconv"]), 'cc -c "$INPUT" | iconv -o "$OUTPUT"');
  assert.equal(shq("a b"), "'a b'");
  assert.ok(fnmatch("tools/ido/5.3/cc", "tools/*/5.3/cc"));
});

test("prune_asm moves .late_rodata to a trailing .rodata section", () => {
  const [name, asm] = prune_asm("glabel f\n jr $ra\n.late_rodata\n.word 1\n.text\n nop\n");
  assert.equal(name, "f");
  assert.equal(asm, "glabel f\n jr $ra\n.text\n nop\n\n.section .rodata\n.word 1\n");
});

test("import a function from a Make project and permute it to a match", { skip: (!toolchain && "romdev's toolchain adapter (romdevtools) is not available") || IDO }, async () => {
  const root = workDir("import");
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "asm"));
    mkdirSync(path.join(root, "tools"));
    writeFileSync(path.join(root, "Makefile"), "CC := tools/ido/5.3/cc\nCFLAGS := -c -G 0 -non_shared -O2 -mips2 -32\n"
      + "build/%.o: %.c\n\t$(CC) $(CFLAGS) -o $@ $<\n");
    writeFileSync(path.join(root, "tools", "permuter_settings.toml"), "compiler_type = \"ido\"\n\n[preserve_macros]\n\"INC.*\" = \"int\"\n");
    writeFileSync(path.join(root, "src", "a.c"), "#define INC(x) ((x) + 1)\nint other(int b) { return b; }\nint f(int a) {\n    return INC(a);\n}\n");
    writeFileSync(path.join(root, "asm", "f.s"), "glabel f\n/* 0 */ jr $ra\n/* 4 */ addiu $v0, $a0, 1\n");
    const lines = [];
    const dir = await importMain([path.join(root, "src", "a.c"), path.join(root, "asm", "f.s")], { cwd: root, log: (s) => lines.push(s) });
    const log = lines.join("\n");
    assert.match(log, /Preserving macros: INC\./);
    for (const f of ["base.c", "compile.sh", "settings.toml", "target.s", "target.o", "base.o"]) assert.ok(existsSync(path.join(dir, f)), `${f} missing\n${log}`);
    const base = readFileSync(path.join(dir, "base.c"), "utf8");
    assert.match(base, /#pragma _permuter define INC\(x\)/);
    assert.match(base, /return INC\(a\);/);
    assert.match(readFileSync(path.join(dir, "settings.toml"), "utf8"), /^func_name = "f"\ncompiler_type = "ido"\n/);
    const out = execFileSync(process.execPath, [path.join(here, "..", "bin", "permuter.mjs"), dir, "--stop-on-zero", "--quiet"], { encoding: "utf8", timeout: 120_000 });
    assert.match(out, /\[f\] base score = 0/);
  } finally {
    removeDir(root);
  }
});

// The compiler upstream's tests use (test/compile.sh):
//   mips-linux-gnu-gcc -O2 -fno-PIC -fno-common -ffreestanding -mno-shared -mno-abicalls -G 0 -c
// run as romdev's WASM mips gcc (cc1 + as) instead of a host gcc.
import { readFileSync, writeFileSync } from "node:fs";
import { runWasmTool } from "../../src/wasm-tool.js";

let toolchain = null;
async function tc() {
  if (!toolchain) ({ toolchain } = await import("romdev-toolchain-mips-gcc"));
  return toolchain;
}

/** compileFn for Compiler/run(): cPath -> oPath, true on success. */
export async function wasmGccCompile(cPath, oPath) {
  const t = await tc();
  const src = readFileSync(cPath);
  const cc1 = await runWasmTool(t.cc1.gluePath,
    ["-meb", "-mabi=32", "-quiet", "-O2", "-fno-PIC", "-fno-common", "-ffreestanding", "-mno-abicalls", "-G0", "/work/in.c", "-o", "/work/in.s"],
    { "/work/in.c": src }, ["/work/in.s"]);
  if (cc1.exitCode !== 0 || !cc1.outputs["/work/in.s"]) return false;
  const as = await runWasmTool(t["mips-elf-as"].gluePath, ["-EB", "-mabi=32", "-G0", "/work/in.s", "-o", "/work/in.o"],
    { "/work/in.s": cc1.outputs["/work/in.s"] }, ["/work/in.o"]);
  if (as.exitCode !== 0 || !as.outputs["/work/in.o"]) return false;
  writeFileSync(oPath, as.outputs["/work/in.o"]);
  return true;
}

#!/usr/bin/env node
// romdev-permuter import: decomp-permuter's import.py, run in node.
//   import.mjs <c_file> <asm_file|func_name> [make flags] [--keep]
//     [--preserve-macros REGEX] [--no-prune] [--decompme] [--settings FILE]
// Creates nonmatchings/<func>/ in the current directory. The build, cpp and
// assembler steps run through romdev's toolchain adapter (see src/import.js).
import { importMain, ImportExit } from "../src/import.js";

try {
  await importMain(process.argv.slice(2));
  process.exit(0);
} catch (e) {
  if (e instanceof ImportExit) {
    if (e.message) process.stderr.write(e.message + "\n");
    process.exit(e.code);
  }
  throw e;
}

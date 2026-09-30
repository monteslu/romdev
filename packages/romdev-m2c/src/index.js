// romdev-m2c - m2c ported to JS ESM (GPL-3.0; see NOTICE).
//
//   import { decompile } from "romdev-m2c";
//   const { code, stdout, stderr } = await decompile(["--target", "mips-ido-c", "--context", ctx, "func.s"]);
//
// `decompile` takes the same flags as `m2c.py` and returns what it would have
// printed. Asm inputs may also be passed inline as { name, text } objects.
export { decompile, parse_flags, run, ArgumentError } from "./main.js";
export const UPSTREAM = { repo: "https://github.com/matt-kempster/m2c", commit: "1d1c4454a445326541305f83f2b0cb680a9ecb2d" };

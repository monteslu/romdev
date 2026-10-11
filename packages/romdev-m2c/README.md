# romdev-m2c

A plain JavaScript (ESM) port of [m2c](https://github.com/matt-kempster/m2c),
the MIPS/PowerPC/ARM/SuperH to C decompiler used by matching-decompilation
projects. It takes the same flags as upstream's command line and prints the
same C. No Python is needed.

It is part of [romdev](https://github.com/monteslu/romdev) and is kept in its
own package so that m2c's GPL terms stay separate from romdev's MIT code, which
only calls it.

## Upstream and license

- Upstream: m2c, https://github.com/matt-kempster/m2c
- Ported from commit `1d1c4454a445326541305f83f2b0cb680a9ecb2d`
- License: GPL-3.0-only (a derivative of m2c). See `LICENSE` and `NOTICE`.
- `src/*.js` translate `m2c/*.py` module by module; `m2c_macros.h` is copied
  unchanged. The CodeWarrior demangler is based on arookas' demangler.cs
  (BSD-3-Clause, notice kept in the source file).
- The C parser is the separate
  [`romdev-pycparser`](https://www.npmjs.com/package/romdev-pycparser) package.
  `--visualize` SVG output uses the
  [`@viz-js/viz`](https://www.npmjs.com/package/@viz-js/viz) dependency
  (Graphviz compiled to WebAssembly, EPL-1.0), which runs as a separate program
  on the dot text m2c produces.

The end-to-end tests run upstream's `tests/end_to_end` corpus through the port
and compare each result byte for byte with upstream's expected output.

## How romdev uses it

romdevtools' `decomp` tool calls it to produce a first C candidate for a
function: `decomp({op:'generate', ...})` runs m2c on the function's assembly
with the translation unit's type context, and `decomp({op:'compare'})` then
compiles that candidate with the project's original compiler.

## Command line

```sh
npx romdev-m2c --target mips-ido-c --context ctx.c func.s
```

The bin is `romdev-m2c`. It accepts upstream m2c's flags, writes the same
stdout and stderr, and exits with the same code.

## API

```js
import { decompile, decompileInWorker, UPSTREAM } from "romdev-m2c";

const { code, stdout, stderr } = await decompile([
  "--target", "mips-ido-c", "--context", "ctx.c", "func.s",
]);
```

- `decompile(flags)`: runs m2c in process with upstream's CLI flags and
  resolves to `{ code, stdout, stderr }`. Assembly inputs may also be passed
  inline as `{ name, text }` objects.
- `decompileInWorker(flags, { timeoutMs })`: the same in a worker thread;
  resolves to `{ code, stdout, stderr, timedOut }` and terminates the worker
  on timeout.
- `parse_flags`, `run`, `ArgumentError`: lower-level entry points.
- `UPSTREAM`: `{ repo, commit }` of the ported m2c.

Exports: `.` and `./m2c_macros.h` (the header m2c's output expects).

## Requirements

Node >= 24, ESM only. No Python, no native code.

## Versions

romdev-m2c 0.1.0 ports m2c at commit `1d1c4454`.

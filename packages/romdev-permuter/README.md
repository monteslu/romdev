# romdev-permuter

A plain JavaScript (ESM) port of
[decomp-permuter](https://github.com/simonlindholm/decomp-permuter), the tool
matching-decompilation projects use to search for a C variant that compiles to
the original bytes. It keeps upstream's PERM macros, randomization passes,
objdump-diff scorer and `compile.sh` contract, evaluates candidates in Node
worker threads, and disassembles through WebAssembly binutils. No Python is
needed.

It is part of [romdev](https://github.com/monteslu/romdev).

## Upstream and license

- Upstream: decomp-permuter, https://github.com/simonlindholm/decomp-permuter
- Ported from commit `41bd0bfc32aa5ea78de4cf28be603163256c2a4c`
- License: MIT (matches upstream). See `LICENSE` and `NOTICE`.
- `default_weights.toml` and the permuter@home systray icons are copied
  unchanged from upstream.
- `src/pyrandom.js` and `src/difflib.js` reimplement the documented algorithms
  of CPython's `random` and `difflib` so seeds and scores replay upstream's (no
  CPython code is included). `src/pow.js` ports ARM optimized-routines' `pow()`
  (MIT); `src/levenshtein.js` ports rapidfuzz's reference Levenshtein (MIT).
- permuter@home crypto uses the
  [`libsodium-wrappers`](https://www.npmjs.com/package/libsodium-wrappers)
  dependency (ISC). The Go systray helper is not included.

## How romdev uses it

romdevtools' `decomp` tool runs it for `decomp({op:'search', ...})`: a bounded
permuter job on one function, which can be cancelled, resumed and queried for
its best candidate. romdev supplies an in-process compile function that runs
the project's original compiler as WebAssembly, so no host compiler, shell or
Docker image is involved. Where upstream's permuter@home controller names a
Docker image, this port names a romdev toolchain profile (`romdev:ido5.3`,
`romdev:ido7.1` or `romdev:<name>=<program>,...`).

Disassembly uses `mips-linux-gnu-objdump` from the
[`romdev-toolchain-mips-gcc`](https://www.npmjs.com/package/romdev-toolchain-mips-gcc)
dependency. Other architectures need a WASM objdump registered with
`setObjdumpGlue(arch, gluePath)`.

## Command line

| bin | upstream equivalent |
|---|---|
| `romdev-permuter` | `permuter.py`: run the permuter on one or more directories |
| `romdev-permuter-import` | `import.py`: create `nonmatchings/<func>/` from a C file and a function's assembly |
| `romdev-permuter-remote` | `pah.py`: the permuter@home client (`ping`, `setup`, `vouch`, `run-server`) |
| `romdev-permuter-remote-controller` | the permuter@home control server (`run`, `setup`) |

```sh
npx romdev-permuter nonmatchings/func_80001234 -j 4 --stop-on-zero
```

Run from the command line, a permuter directory's `compile.sh` is run with
`bash`, as upstream does. `romdev-permuter-import` needs a toolchain adapter for
the project's build, `cpp` and assembler steps: romdevtools' own when it is
installed beside this package, or a module named by `ROMDEV_PERMUTER_TOOLCHAIN`.

## API

```js
import { run, makeOptions, UPSTREAM } from "romdev-permuter";
```

The index exports the CLI entry (`run`, `makeOptions`), the building blocks
(`Permuter`, `Candidate`, `Compiler`, `Scorer`, `Randomizer`,
`RANDOMIZATION_PASSES`, `perm_parse`, `perm_evaluate_one`), the objdump layer
(`objdump`, `simplify_objdump`, `get_arch`, `setObjdumpGlue`), the import entry
(`importMain`, `resolveToolchain`), and `UPSTREAM` (`{ repo, commit }`).
Exports: `.` only.

## Requirements

Node >= 24, ESM only. No Python, no native code. Depends on
`romdev-pycparser`, `romdev-toolchain-mips-gcc` and `libsodium-wrappers`.

## Versions

romdev-permuter 0.1.0 ports decomp-permuter at commit `41bd0bfc`.

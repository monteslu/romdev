# romdev-rabbitizer

[rabbitizer](https://github.com/Decompollaborate/rabbitizer), the MIPS
instruction decoder, built from its C library to WebAssembly, with a
synchronous JavaScript binding that mirrors the API of rabbitizer's Python
module: the same class, method, property and enum names, the same argument
order and return values, and the same errors (Python exception names are kept
as the JS error `name`). No Python is needed.

It ships three rabbitizer releases side by side, because each spimdisasm
release expects a specific one. It is part of
[romdev](https://github.com/monteslu/romdev).

## Upstream and license

- Upstream: rabbitizer (Decompollaborate), https://github.com/Decompollaborate/rabbitizer
- Built from these commits:

  | rabbitizer | commit |
  |---|---|
  | 1.16.2 | `724a49a5b4dbfb99f1a9e6992e63964fd29c90c8` |
  | 1.14.3 | `d5804fa488474830a47fbf9f3693048ec1e45589` |
  | 1.13.0 | `1df4709dcc927d9d9cc5859a6e7eb98e864f8468` |

- License: MIT (rabbitizer and the romdev binding). See `LICENSE` and `NOTICE`.
- `wasm/rabbitizer-<version>.wasm` is built by
  `packages/romdevtools/scripts/build-rabbitizer.sh` in the romdev repo from the
  library's C sources plus `csrc/rabbitizer_wasm.c` (the binding's C side,
  shipped in this package).

## How romdev uses it

It is the instruction decoder under
[`romdev-spimdisasm`](https://www.npmjs.com/package/romdev-spimdisasm), which
[`romdev-splat`](https://www.npmjs.com/package/romdev-splat) uses to split and
disassemble N64 and PS1 decomp projects for romdevtools' `decomp` tool
(`decomp({op:'setup'})`, `decomp({op:'import'})`). spimdisasm 1.42.4 pairs with
rabbitizer 1.16.2, 1.39.3 with 1.14.3, and 1.35.0 with 1.13.0.

## API

```js
import * as rab from "romdev-rabbitizer/1.16.2";

const instr = new rab.Instruction(0x27BDFFE8);
instr.disassemble(); // "addiu       $sp, $sp, -0x18"
```

Or pick a version at run time:

```js
import { loadRabbitizerSync, VERSIONS } from "romdev-rabbitizer";

const rab = loadRabbitizerSync("1.14.3"); // one shared namespace per version
```

Exports: `.` (`loadRabbitizerSync`, async `loadRabbitizer`, `VERSIONS`,
`DEFAULT_VERSION`, the error classes) and `./1.16.2`, `./1.14.3`, `./1.13.0`
(each version's module namespace, loaded at import: `Instruction`, `config`,
`Utils`, `RegistersTracker`, the enums and the rest of the Python module's
names). Everything is synchronous. Like the Python module, `config` is global
per version.

## Requirements

Node >= 24, ESM only. No dependencies, no Python, no native code.

## Versions

romdev-rabbitizer 0.1.0 ships rabbitizer 1.16.2, 1.14.3 and 1.13.0.

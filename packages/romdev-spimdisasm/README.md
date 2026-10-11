# romdev-spimdisasm

A plain JavaScript (ESM) port of
[spimdisasm](https://github.com/Decompollaborate/spimdisasm), the MIPS
disassembler splat uses to turn N64 and PS1 binaries into assembly and data
files. It reproduces the output of three spimdisasm releases byte for byte,
selected at run time. No Python is needed.

It is part of [romdev](https://github.com/monteslu/romdev).

## Upstream and license

- Upstream: spimdisasm (Decompollaborate), https://github.com/Decompollaborate/spimdisasm
- Reproduced releases:

  | spimdisasm | commit | rabbitizer used |
  |---|---|---|
  | 1.42.4 (base) | `4b5d4c68eeb9f9eae14b3bb713971433ae2c3c43` | 1.16.2 |
  | 1.39.3 | `c4737d9266fe626c130823b3c21c60f1209f39fa` | 1.14.3 |
  | 1.35.0 | `cc2104b561c6b4468441862de7dec7140fad052f` | 1.13.0 |

- License: MIT (spimdisasm and the port). The Japanese codec tables, float
  formatting and set iteration order follow CPython (PSF-2.0, Copyright (c)
  2001 Python Software Foundation). See `LICENSE` and `NOTICE`.
- `src/common/`, `src/mips/` and `src/elf32/` translate the Python package
  module by module. The command-line frontends (`disasmdis`, `rspDisasm`,
  `elfObjDisasm`, `singleFileDisasm`) are not ported.

## How romdev uses it

[`romdev-splat`](https://www.npmjs.com/package/romdev-splat) loads it as its
disassembler backend. romdevtools' `decomp` tool runs splat when it sets up or
imports an N64 or PS1 decomp project (`decomp({op:'setup'})`,
`decomp({op:'import'})`), with the spimdisasm version the project pins.

## API

```js
import * as spimdisasm from "romdev-spimdisasm";

spimdisasm.configureVersion("1.39.3"); // before building any Context or section
const { common, mips, elf32 } = spimdisasm;
```

The module mirrors the Python package layout: the `common`, `mips` and `elf32`
namespaces keep upstream's class, function and attribute names.
`configureVersion(v)` (alias `setVersion`) selects the release to reproduce and
activates the paired rabbitizer; `getVersion()`, `__version__`,
`SUPPORTED_VERSIONS`, `DEFAULT_VERSION` and `RABBITIZER_VERSION_FOR` describe
the selection. `setRabbitizer` lets a caller supply its own rabbitizer
namespace. Exports: `.` only.

## Requirements

Node >= 24, ESM only. Depends on
[`romdev-rabbitizer`](https://www.npmjs.com/package/romdev-rabbitizer). No
Python, no native code.

## Versions

romdev-spimdisasm 0.1.0 reproduces spimdisasm 1.42.4, 1.39.3 and 1.35.0.

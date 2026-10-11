# romdev-splat

A plain JavaScript (ESM) port of [splat](https://github.com/ethteck/splat), the
binary splitting tool N64 and PS1 decompilation projects use to cut a ROM or
executable into assembly, data, asset and linker-script files from a YAML
config. For the same inputs its output (assembly, linker scripts, dependency
files, undefined-symbol files, binary and image assets, C stubs, symbol dumps)
is byte-identical to Python splat's. No Python is needed.

It is part of [romdev](https://github.com/monteslu/romdev).

## Upstream and license

- Upstream: splat (Ethan Roseman and contributors), https://github.com/ethteck/splat
- Ported from splat64 0.37.1 (tag `v0.37.1`), with the behaviour of splat64
  0.34.1 reproduced behind a version option.
- Also translated: [n64img](https://github.com/decompals/n64img) 0.3.3 (MIT)
  and the writer paths of [pypng](https://gitlab.com/drj11/pypng)
  0.20220715.0 (MIT). `src/wasm/zlib-stream.wasm` is zlib 1.3.1 (zlib license)
  with a small stream API.
- `src/ext/` holds JS translations of splat extension segtypes that specific
  decomp projects ship, each identified by the sha256 of its Python source.
- License: MIT. See `LICENSE` and `NOTICE`.

## How romdev uses it

romdevtools' `decomp` tool runs it when a project's own setup recipe calls
`splat split` (`decomp({op:'setup'})`, `decomp({op:'import'})`). The splat and
spimdisasm versions are read from what the project pins (`uv.lock`,
requirements files or a vendored copy).

## Command line

```sh
npx romdev-splat split config/game.yaml --modes all
```

The bin is `romdev-splat`. It mirrors `splat split`: `CONFIG...`, `--modes`,
`--verbose`, `--use-cache`, `--skip-version-check`, `--stdout-only`,
`--disassemble-all`, `--make-full-disasm-for-code`, plus
`--splat-version V|auto`, `--spimdisasm-version V|auto`, `--cwd DIR` and
`--base-path DIR`. Only the `split` command is ported.

## API

```js
import { split } from "romdev-splat";

const r = await split(["config/game.yaml"], { cwd: "/path/to/project" });
// { exitCode, stdout, stderr, error, splatVersion, spimdisasmVersion, extensions }
```

`split(configPaths, options)` never reads or changes `process.cwd()`: relative
paths resolve against `options.cwd`. Options include `modes`, `splatVersion`
(`'0.37.1'` default, `'0.34.1'` or `'auto'`), `spimdisasmVersion`, `basePath`,
`backend` (a `{ spimdisasm, rabbitizer }` pair to use instead of the
dependencies) and `onOutput`. Calls are queued, so concurrent splits run one at
a time. Also exported: `detectProjectVersions`, `SUPPORTED_SPLAT_VERSIONS`,
`DEFAULT_SPLAT_VERSION`, `PORTED_EXTENSIONS`, `SplatError`. Exports: `.` only.

## Requirements

Node >= 24, ESM only. Depends on
[`romdev-spimdisasm`](https://www.npmjs.com/package/romdev-spimdisasm),
[`romdev-rabbitizer`](https://www.npmjs.com/package/romdev-rabbitizer) and
`yaml`. No Python, no native code.

## Versions

romdev-splat 0.1.0 ports splat64 0.37.1 (and reproduces 0.34.1).

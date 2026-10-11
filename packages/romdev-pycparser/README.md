# romdev-pycparser

A plain JavaScript (ESM) port of [pycparser](https://github.com/eliben/pycparser)
as vendored by m2c (`m2c_pycparser`) and decomp-permuter (`perm_pycparser`):
pycparser 2.23 with GCC extensions (attributes, `asm`, `typeof` and more). It
has the C99 lexer, an LALR parser driven by upstream's own parse tables, the AST
and the C generator, and round-trips C the way upstream does. No Python is
needed.

It is part of [romdev](https://github.com/monteslu/romdev).

## Upstream and license

- Upstream: pycparser 2.23 (Eli Bendersky), https://github.com/eliben/pycparser,
  as patched in m2c commit `1d1c4454a445326541305f83f2b0cb680a9ecb2d` and
  decomp-permuter commit `41bd0bfc32aa5ea78de4cf28be603163256c2a4c` (the two
  vendored copies are the same files under two package names).
- The lexer and parse loop follow PLY 3.10 (David M. Beazley).
- License: BSD-3-Clause (pycparser and PLY). Full texts in `LICENSE`; details in
  `NOTICE`.
- `src/tables/*.json` are converted from upstream's `lextab.py`, `yacctab.py`
  and `c_ast.py` by a JS script that reads them as Python literals.

## How romdev uses it

It is the C parser and printer under
[`romdev-m2c`](https://www.npmjs.com/package/romdev-m2c) (m2c reads type
context with it) and
[`romdev-permuter`](https://www.npmjs.com/package/romdev-permuter) (the permuter
parses, mutates and prints candidate C with it). Both are driven by romdevtools'
`decomp` tool (`decomp({op:'generate'})` and `decomp({op:'search'})`).

## API

```js
import { CParser, CGenerator, c_ast } from "romdev-pycparser";

const ast = new CParser().parse("int add(int a, int b) { return a + b; }", "<source>");
const text = new CGenerator().visit(ast);
```

Exports from `.`: `CParser`, `CLexer`, `CGenerator`, the `c_ast` namespace
(`Node`, `NodeVisitor`, every node class), `parse_file`, the AST transforms
(`fix_switch_cases`, `fix_atomic_specifiers`) and the error classes
(`ParseError`, `LexError`). `parse_file` never runs a host `cpp`: pass
already-preprocessed C, or a `preprocess` function.

## Requirements

Node >= 24, ESM only. No dependencies, no Python, no native code.

## Versions

romdev-pycparser 0.1.0 ports pycparser 2.23 as vendored by m2c and
decomp-permuter at the commits above.

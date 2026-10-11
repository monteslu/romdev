# Campaign-local toolchain patches

The workbench ships a **hash-pinned** `uopt` instrumentation profile
(`decomp-workbench instrument-uopt`), and this directory is not it. What lives
here are the campaign-local `uopt.c` patches whose *output grammar* the
workbench already reads -- the records `trace-cascade --grammar` marks
CAMPAIGN-LOCAL -- kept as diffs so that the reader side never again outlives the
producer side.

That has happened. An earlier campaign lost the original CDX patch: the
instrumented `uopt` binary survived, the source that made it did not, and two
later campaigns paid for the recovery. These files are the receipt, not the
compiler.

| Patch | Adds | Record grammar |
|---|---|---|
| [`uopt-5.3-cdx-symtab.patch`](uopt-5.3-cdx-symtab.patch) | `CDX_SYMTAB=1` -- one dump of `uopt`'s per-procedure itable | `symtabcount`, `symtab` |

`savedetail` and `saveocc` -- the colourability-gate arithmetic
(`docs/p1-decision-arithmetic.md`) -- are **not** here: they are already carried
by the CDX-bearing `ido53-globalcolor-recomp` `uopt.c` this patch stacks on, so
a diff of them against that base would be empty. Verify with
`grep -c savedetail build/5.3/uopt.c` before assuming a tree has them.

## The base this patch applies to

```
file    ido53-globalcolor-recomp/build/5.3/uopt.c   (a CDX-carrying source)
size    4062069 bytes
sha256  e465eb4b76ac001d1c94ff8bf74c378217b6ed2e674a6b73c6722edc01baf5ca
```

Applying `uopt-5.3-cdx-symtab.patch` with `patch -p1` from the recomp tree root
produces exactly:

```
sha256  64b393cdec6f43996e3bc4e53d2862e1ba7cff21cfc21217d7718b426d97b801
```

A different base sha256 is not a reason to force the patch: it is a different
static-recompiler revision, and every emulated address in the hunk
(`0x1001cb38`, `0x1001cc30`) is tied to the input executable. Re-derive them
from `f_printitab` rather than hoping.

## Rebuild recipe

```sh
R=/path/to/ido53-globalcolor-recomp
patch -p1 -d "$R" < uopt-5.3-cdx-symtab.patch

gcc -std=c11 -O2 -fno-strict-aliasing -I"$R" -c "$R/build/5.3/uopt.c" -o uopt_symdump.o
gcc -std=c11 -O2 -fno-strict-aliasing -I"$R" -o uopt-symdump \
    uopt_symdump.o "$R/build/5.3/libc_impl.o" "$R/build/5.3/version_info.o" -lm
```

Then drop `uopt-symdump` in place of `uopt` in a copy of the toolchain
directory -- a copy, so the original stays a control -- and compile:

```sh
CDX_SYMTAB=1 CDX_PROC=0 CC=/path/to/toolchain-copy/cc ./build.sh source.c out.o 2>dump.log
```

`CDX_SYMTAB` is independent of `CDX_LOG` and honours `CDX_PROC` and `CDX_OUT`.

### The gate this owes you

Instrumentation is evidence only after it is shown to be inert. The campaign
that produced this patch recorded four checks, and a rebuild owes the same
four:

1. the stock toolchain reproduces the archived object;
2. the rebuilt-but-unpatched `uopt` reproduces it too (the recompile itself is
   codegen-transparent);
3. the patched `uopt` with the environment **unset** reproduces it, and its
   stderr is `cmp`-identical to the stock run;
4. the patched `uopt` with `CDX_SYMTAB=1` reproduces it as well -- the dump is
   inert *enabled*, not merely inert when off.

`decomp-workbench fidelity` is the command for recording steps 3 and 4.

## Record grammar

```
[CDX] symtabcount proc=%d n=%u base=0x%08x
[CDX] symtab proc=%d idx=%u kind=%d name=%s dtype=%d selfidx=%d bit=%d ver=%d
      off=%d tag=%d class=%d b23=%d b24=%d vreg=%d op=%d l=%d r=%d
      raw08=.. raw12=.. raw16=.. raw20=.. raw24=.. raw28=.. raw32=.. raw36=..
      rec=0x%08x
```

An entry whose record pointer is not an emulated pointer prints
`[CDX] symtab proc=%d idx=%u rec=0x%08x nil` and nothing else.

`decomp-workbench trace-frame` reads these records; see
[the frame ladder](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/cdx-cascade.md#the-frame-ladder).

### What the fields mean

The itable is `uopt`'s **per-procedure expression and variable table**
(`uoptitab.p`), and CDX's `sym=` field everywhere else in the grammar is an
index into it. It is a hash table of expressions in **first-occurrence order**:
a repeated expression reuses its index and bumps `ver`, so an index is stamped
where that expression first appears in the ucode stream. That is what makes an
index a birth-site witness -- and what makes it renumber under any edit.

| Field | Source | Meaning |
|---|---|---|
| `kind`/`name` | `rec+0` | 0 empty, 1 islda, 2 isconst, 3 isvar, 4 isop, 5 isilda, 6 issvar, 7 dumped, 8 isrconst |
| `dtype` | `rec+1` | 6 integer, 0 pointer, 12 float/double (the one dtype the save arithmetic reads) |
| `selfidx` | `rec+2` | the index other records call `sym=` |
| `bit` | `rec+4` | hash key; for auto variables a pure function of the offset |
| `ver` | `rec+6` | occurrence version |
| `off` | `rec+16` | **isvar only**: frame offset, measured from the TOP of the frame |
| `tag` | `rec+20` | memory-alias tag (16 on every auto -- it is not a size) |
| `class` | `rec+22` | 1 = M auto/memory, 2 = P parameter, 3 = R register/vreg pseudo |
| `b24` | `rec+24` | **isvar only**: access size in bytes |
| `vreg` | `rec+25` | virtual-register flag |
| `op` | `rec+16` | **isop only**: the uopt opcode |
| `l`, `r` | `rec+20/24` | **isop only**: the operand records, printed as their indices |

`home(sp) = off + framesize`. Two consecutive indices may share one record --
the `"""` continuation rows of `printitab`.

The **input ucode carries no names**. `cfe -j` on a composed translation unit
holds three human strings -- the file name, the function name, and a format
literal -- and every local, parameter and temp is a bare (class, offset) pair.
So `name=` here is the itable *kind*, not a linker-style symbol name, and no
patch to this pass can make it one. `-g` would, and `-g` changes codegen.

### uopt opcode map

Built by joining a `CDX_SYMTAB` dump against a stock `-Wo,-zdbug:2` listing:

```
 1 uadd    4 uand   10 ucg1   11 ucg1b   24 ucvt   25 ucvtl   35 uequ
40 ugeq   54 uilod  63 uistr  65 uixa    78 ules   91 umpy    95 uneq
116 ushr  123 ustr  125 usub
```

## The instrument you may not need

Stock IDO 5.3 `uopt` already writes `./uoptlist` under `-Wo,-zdbug:<1|2>`
(`uoptdbg.p`): flow graph, unroll trace, and the whole itable in `printitab`
form. No patched compiler is involved. Reach for the patch when you want the
dump joined to CDX web records in one log; reach for `-zdbug` when you only
want to read the table.

Two cautions, both recorded rather than remembered:

- A **statically recompiled** `uopt` aborts under `-zdbug:*` at the closing
  `* * n.nn SECONDS IN ...` timing line (`wrapper_ecvt` unimplemented,
  `libc_impl.c`). The listing is complete before the abort, but no `.o` is
  produced -- so it is a listing tool there, not a build.
- The same family of built-in traces exists in `as1`. See
  [compiler instrumentation](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/compiler-instrumentation.md) on
  `cc -Wa,-R`, which needs no patched assembler at all.

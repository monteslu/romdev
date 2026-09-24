#!/usr/bin/env python3
"""Generate the gpgx-derived data the Genesis WAT backend specialises from.

    python3 scripts/recompile-gen/genesis_gpgx.py <gpgx-src-dir> [out.json.gz]

<gpgx-src-dir> is the PATCHED genesis_plus_gx tree romdev builds its core from
(scripts/build-genesis-plus-gx.sh leaves it at build/gpgx/src). The default
output is src/analysis/recompile/wat/genesis/gpgx-derived.json.gz.

This runs ONCE, at development time, when the gpgx pin or its romdev patch
changes. A recompile never needs C source, cpp or Python: the JS backend
(src/analysis/recompile/wat/genesis/ctrans.js) partially evaluates the ASTs
committed here.

What it does, exactly as sms-wat's m68k_tr.py / z80_tr.py did at build time:

  1. run `cpp` over Musashi (m68kcpu.h + m68kops.h) and over z80.c with the
     defines gpgx's own libretro build uses;
  2. cut every function definition out of the preprocessed text with the
     same regexes, rewrite the same type spellings, and parse each with
     pycparser;
  3. keep the functions reachable from the 68000 opcode handlers (via the
     instruction jump table) and from the Z80 op/cb/dd/ed/fd/xycb handlers;
  4. serialise their ASTs as compact arrays, plus the tables the handlers
     index (m68ki_cycles, shift tables, the jump table, Z80 cc_* tables) and
     the VDP's cycle2hc32/40 tables from hvc.h.

Requires: python3, pycparser (3.x), cpp.
"""
import gzip, hashlib, json, os, re, subprocess, sys
from pycparser import c_parser, c_ast

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(os.path.dirname(HERE))
DEFAULT_OUT = os.path.join(PKG, 'src/analysis/recompile/wat/genesis/gpgx-derived.json.gz')
GENERATOR_VERSION = 1

CPP_DEFINES = ['-DLSB_FIRST', '-DALIGN_LONG', '-DUSE_16BPP_RENDERING', '-D__LIBRETRO__']


def includes(g):
    return [f'{g}/core/m68k', f'{g}/core', g, f'{g}/core/debug', f'{g}/core/sound',
            f'{g}/core/cart_hw', f'{g}/core/input_hw', f'{g}/core/cd_hw',
            f'{g}/core/cart_hw/svp', f'{g}/core/z80', f'{g}/core/ntsc', f'{g}/libretro',
            f'{g}/libretro/libretro-common/include']


def cpp(g, src, out_dir):
    out = os.path.join(out_dir, os.path.basename(src) + '.i')
    subprocess.run(['cpp', '-P'] + CPP_DEFINES + [f'-I{i}' for i in includes(g)] + [src, '-o', out],
                   check=True)
    txt = open(out).read()
    os.remove(out)
    return txt


def cpp_z80(g, out_dir):
    # z80_tr.py's include order starts at core/z80
    inc = [f'{g}/core/z80', f'{g}/core/m68k', f'{g}/core', g, f'{g}/core/debug',
           f'{g}/core/sound', f'{g}/core/cart_hw', f'{g}/core/input_hw', f'{g}/core/cd_hw',
           f'{g}/core/cart_hw/svp', f'{g}/core/ntsc', f'{g}/libretro',
           f'{g}/libretro/libretro-common/include']
    out = os.path.join(out_dir, 'z80.c.i')
    subprocess.run(['cpp', '-P'] + CPP_DEFINES + [f'-I{i}' for i in inc] +
                   [f'{g}/core/z80/z80.c', '-o', out], check=True)
    txt = open(out).read()
    os.remove(out)
    return txt


# ---------------------------------------------------------------------------
# AST serialisation: every node is [kind, field...] in the field order listed
# in the output's `schema` (pycparser attr_names, then child slots).
# ---------------------------------------------------------------------------
SCHEMA = {}


def ser(node):
    if node is None:
        return None
    if isinstance(node, list):
        return [ser(x) for x in node]
    if isinstance(node, (str, int)):
        return node
    kind = type(node).__name__
    if kind not in SCHEMA:
        attrs = [a for a in node.attr_names if a != 'coord']
        kids = [s for s in node.__slots__ if s not in ('coord', '__weakref__') and s not in attrs]
        SCHEMA[kind] = attrs + kids
    out = [kind]
    for f in SCHEMA[kind]:
        v = getattr(node, f)
        if isinstance(v, list):
            out.append([ser(x) for x in v])
        elif isinstance(v, c_ast.Node):
            out.append(ser(v))
        else:
            out.append(v)
    return out


def calls_in(node, acc):
    if isinstance(node, c_ast.FuncCall) and isinstance(node.name, c_ast.ID):
        acc.add(node.name.name)
    if isinstance(node, c_ast.ID):
        acc.add(node.name)
    for _, ch in node.children():
        calls_in(ch, acc)
    return acc


# ---------------------------------------------------------------------------
# 68000 (Musashi)
# ---------------------------------------------------------------------------
def m68k(g, tmp):
    drv = os.path.join(tmp, 'drv.c')
    open(drv, 'w').write('#define m68ki_cpu m68k\n#define MUL (7)\n#include "shared.h"\n'
                         '#include "m68kconf.h"\n#include "m68kcpu.h"\n#include "m68kops.h"\n')
    src = cpp(g, drv, tmp)
    os.remove(drv)
    src = re.sub(r'\*\(unsigned short \*\)\(m68k\.memory_map\[\(\((\w+(?:\+2)?)\)>>16\)&0xff\]\.base \+ \(\(\1\) & 0xffff\)\)',
                 r'__raw16(\1)', src)
    src = re.sub(r'\(m68k\.memory_map\[\(\((\w+)\)>>16\)&0xff\]\.base\)\[\(\(\1\) & 0xffff\)\^1\]',
                 r'__raw8(\1)', src)
    funcs = {}
    for m in re.finditer(r'^(?:static |)(?:inline |)(?:void|unsigned int|int|unsigned char)\s+(\w+)\s*\(([^)]*)\)\s*\n?\{', src, re.M):
        i = m.end()
        d = 1
        while d:
            c = src[i]
            d += (c == '{') - (c == '}')
            i += 1
        funcs[m.group(1)] = src[m.start():i]
    for m in re.finditer(r'^inline (?:unsigned int|void) (\w+)\(([^)]*)\) \{.*\}$', src, re.M):
        funcs.setdefault(m.group(1), m.group(0))
    tables = {}
    for m in re.finditer(r'^static (?:const )?unsigned (?:char|short|int) (\w+)\[(?:\d+|0x[0-9a-fA-F]+)?\]\s*=\s*\{(.*?)\};',
                         src, re.M | re.S):
        body = re.sub(r'/\*.*?\*/', '', m.group(2), flags=re.S)
        tables[m.group(1)] = [eval(x.strip().replace('(7)', '7')) for x in body.split(',') if x.strip()]
    txt = open(f'{g}/core/m68k/m68ki_cycles.h').read()
    body = txt[txt.index('{') + 1:txt.rindex('}')]
    cycles = [eval(x) for x in re.findall(r'(\d+\*7)', body)]
    assert len(cycles) == 0x10000
    tables['m68ki_cycles'] = cycles
    jt = re.findall(r'm68k_op_\w+', open(f'{g}/core/m68k/m68ki_instruction_jump_table.h').read())
    assert len(jt) == 0x10000

    parser = c_parser.CParser()
    asts, errors = {}, {}

    def parse(name):
        if name in asts or name in errors:
            return
        if name not in funcs:
            return
        t = funcs[name].replace('__inline__', 'inline')
        t = re.sub(r'(?<!un)signed short', 'short', t)
        t = re.sub(r'(?<!un)signed char', 'char_s', t)
        t = re.sub(r'(?<!un)signed int', 'int', t)
        try:
            asts[name] = parser.parse('typedef int char_s; typedef int cpu_memory_map;\n' + t).ext[-1]
        except Exception as e:
            errors[name] = str(e)

    handlers = sorted(set(jt))
    todo = list(handlers)
    seen = set()
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        parse(n)
        if n in asts:
            for c in calls_in(asts[n], set()):
                if c in funcs and c not in seen:
                    todo.append(c)
    used_ids = set()
    for fd in asts.values():
        calls_in(fd, used_ids)
    hidx = {n: k for k, n in enumerate(handlers)}
    return {
        'handlers': handlers,
        'jumpTable': [hidx[n] for n in jt],
        'functions': {n: ser(asts[n]) for n in sorted(asts)},
        'parseErrors': errors,
        'tables': {n: v for n, v in sorted(tables.items()) if n in used_ids or n in (
            'm68ki_cycles', 'm68ki_shift_8_table', 'm68ki_shift_16_table', 'm68ki_shift_32_table')},
        'tableNames': sorted(tables),
    }


# ---------------------------------------------------------------------------
# Z80 (MAME z80.c as carried by gpgx)
# ---------------------------------------------------------------------------
def z80(g, tmp):
    src = cpp_z80(g, tmp)
    funcs = {}
    for m in re.finditer(r'^(?:static |)(?:inline |)(?:void|UINT8|UINT16|UINT32|unsigned int|int|unsigned char)\s+(\w+)\s*\(([^)]*)\)\s*\n?\{', src, re.M):
        i = m.end()
        d = 1
        while d:
            c = src[i]
            d += (c == '{') - (c == '}')
            i += 1
        funcs[m.group(1)] = src[m.start():i]
    cc = {}
    for m in re.finditer(r'^static const UINT16 (cc_\w+)\[0x100\] =\s*\{(.*?)\};', src, re.M | re.S):
        cc[m.group(1)] = [eval(x.strip()) for x in m.group(2).split(',') if x.strip()]
    for k in ('cc_op', 'cc_cb', 'cc_ed', 'cc_xy', 'cc_xycb', 'cc_ex'):
        assert len(cc[k]) == 256, k
    prelude = ('typedef unsigned char UINT8; typedef unsigned short UINT16; typedef unsigned int UINT32;'
               'typedef signed char INT8; typedef short INT16; typedef int INT32; typedef int PAIR;'
               'typedef int char_s;\n')
    parser = c_parser.CParser()
    asts, errors = {}, {}

    def parse(name):
        if name in asts or name in errors or name not in funcs:
            return
        t = re.sub(r'(?<!un)signed char', 'char_s', funcs[name])
        try:
            asts[name] = parser.parse(prelude + t).ext[-1]
        except Exception as e:
            errors[name] = str(e)

    handlers = [f'op_{i:02x}' for i in range(256)]
    for p in ('cb', 'dd', 'ed', 'fd', 'xycb'):
        handlers += [f'{p}_{i:02x}' for i in range(256)]
    todo = list(handlers)
    seen = set()
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        parse(n)
        if n in asts:
            for c in calls_in(asts[n], set()):
                if c in funcs and c not in seen:
                    todo.append(c)
    return {
        'handlers': handlers,
        'functions': {n: ser(asts[n]) for n in sorted(asts)},
        'parseErrors': errors,
        'cc': cc,
    }


def c_table(path, name, n):
    txt = open(path).read()
    i = txt.index(name)
    body = txt[txt.index('{', i) + 1:txt.index('}', i)]
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    vals = [int(x.strip(), 0) for x in body.split(',') if x.strip()]
    assert len(vals) == n, (name, len(vals))
    return vals


def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


LICENSE_NOTE = (
    'Derived from Genesis Plus GX (Musashi 68000 core, MAME z80.c, hvc.h) by '
    'scripts/recompile-gen/genesis_gpgx.py. Genesis Plus GX is NON-COMMERCIAL: '
    'redistributions may not be sold nor used in a commercial product or activity. '
    'Musashi and z80.c carry their own non-commercial notices (z80.c: Portable Z80 '
    'emulator V3.9, Copyright Juergen Buchmueller). A wasmcart built from this data '
    'contains code transpiled from these sources and inherits these terms. The full '
    'license texts are in the upstream tree pinned in scripts/versions.json.')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    g = os.path.abspath(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    tmp = os.path.join(PKG, 'build', 'recompile-gen')
    os.makedirs(tmp, exist_ok=True)
    versions = json.load(open(os.path.join(PKG, 'scripts/versions.json')))
    pin = next(v for k, v in _walk(versions) if k == 'genesis_plus_gx')
    patch = os.path.join(PKG, pin['patch'])
    files = ['core/m68k/m68kops.h', 'core/m68k/m68kcpu.h', 'core/m68k/m68k.h', 'core/m68k/m68kconf.h',
             'core/m68k/m68ki_cycles.h', 'core/m68k/m68ki_instruction_jump_table.h',
             'core/z80/z80.c', 'core/z80/z80.h', 'core/hvc.h', 'core/shared.h', 'romdev_debug.h']
    data = {
        'format': 'romdev-gpgx-derived',
        'generatorVersion': GENERATOR_VERSION,
        'generator': 'scripts/recompile-gen/genesis_gpgx.py',
        'license': 'non-commercial (Genesis Plus GX license)',
        'licenseNote': LICENSE_NOTE,
        'provenance': {
            'upstream': pin['url'], 'commit': pin['commit'],
            'patch': pin['patch'], 'patchSha256': sha(patch),
            'cppDefines': CPP_DEFINES,
            'files': {f: sha(os.path.join(g, f)) for f in files if os.path.exists(os.path.join(g, f))},
        },
        'm68k': m68k(g, tmp),
        'z80': z80(g, tmp),
        'hvc': {'cycle2hc32': c_table(f'{g}/core/hvc.h', 'cycle2hc32[3420]', 3420),
                'cycle2hc40': c_table(f'{g}/core/hvc.h', 'cycle2hc40[3420]', 3420)},
    }
    data['schema'] = SCHEMA
    raw = json.dumps(data, separators=(',', ':')).encode()
    with open(out, 'wb') as f:
        f.write(gzip.compress(raw, 9, mtime=0))
    m, z = data['m68k'], data['z80']
    print(f'  gpgx-derived: m68k {len(m["handlers"])} handlers, {len(m["functions"])} functions '
          f'({len(m["parseErrors"])} unparsable), z80 {len(z["functions"])} functions '
          f'({len(z["parseErrors"])} unparsable); {len(raw)} bytes json -> {os.path.getsize(out)} gz -> {out}')


def _walk(d):
    if isinstance(d, dict):
        for k, v in d.items():
            yield k, v
            yield from _walk(v)


if __name__ == '__main__':
    main()

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { split } from '../src/index.js';
import { makeFakeBackend } from './helpers/fake-backend.mjs';
import { makeProject, makeRom } from './helpers/synthetic.mjs';
import { compressobj, crc32 } from '../src/zlib.js';

const MODES = ['ld', 'bin', 'databin', 'img', 'rgba16', 'ci4', 'palette'];

async function run(extra = '') {
  const dir = makeProject(extra);
  const r = await split(['splat.yaml'], { cwd: dir, backend: makeFakeBackend(), modes: MODES });
  return { dir, r, read: (p) => fs.readFileSync(path.join(dir, p)) };
}

const EXPECTED_LD = `SECTIONS
{
    __romPos = 0;
    header_ROM_START = __romPos;
    header_VRAM = ADDR(.header);
    .header : AT(header_ROM_START) SUBALIGN(16)
    {
        FILL(0x00000000);
        header_DATA_START = .;
        build/asm/header.o(.data*);
        header_DATA_END = .;
        header_DATA_SIZE = ABSOLUTE(header_DATA_END - header_DATA_START);
    }
    __romPos += SIZEOF(.header);
    header_ROM_END = __romPos;
    header_VRAM_END = .;

    boot_ROM_START = __romPos;
    boot_VRAM = ADDR(.boot);
    .boot : AT(boot_ROM_START) SUBALIGN(16)
    {
        FILL(0x00000000);
        boot_DATA_START = .;
        build/assets/boot.o(.data*);
        boot_DATA_END = .;
        boot_DATA_SIZE = ABSOLUTE(boot_DATA_END - boot_DATA_START);
    }
    __romPos += SIZEOF(.boot);
    boot_ROM_END = __romPos;
    boot_VRAM_END = .;

    main_ROM_START = __romPos;
    main_VRAM = ADDR(.main);
    .main 0x80001000 : AT(main_ROM_START) SUBALIGN(16)
    {
        FILL(0x00000000);
        main_DATA_START = .;
        build/asm/data/blob.o(.data*);
        build/assets/tex.rgba16.o(.data*);
        build/assets/sprite.ci4.o(.data*);
        build/assets/sprite.o(.data*);
        . = ALIGN(., 16);
        main_DATA_END = .;
        main_DATA_SIZE = ABSOLUTE(main_DATA_END - main_DATA_START);
    }
    main_bss_VRAM = ADDR(.main_bss);
    .main_bss (NOLOAD) : SUBALIGN(16)
    {
        FILL(0x00000000);
        main_BSS_START = .;
        build/asm/data/heap.bss.o(.bss*);
        . = ALIGN(., 16);
        main_BSS_END = .;
        main_BSS_SIZE = ABSOLUTE(main_BSS_END - main_BSS_START);
    }
    __romPos += SIZEOF(.main);
    __romPos = ALIGN(__romPos, 16);
    . = ALIGN(., 16);
    main_ROM_END = __romPos;
    main_VRAM_END = .;

    .pdr 0 :
    {
        *(.pdr);
    }

    /DISCARD/ :
    {
        *(.reginfo);
        *(*);
    }
}
`;

test('linker script, dependency file and databin asm', async () => {
  const { dir, r, read } = await run();
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(read('out/testrom.ld').toString(), EXPECTED_LD);
    assert.equal(read('out/testrom.d').toString(), [
      'build/testrom.elf: \\', '    build/asm/header.o \\', '    build/assets/boot.o \\', '    build/asm/data/blob.o \\',
      '    build/assets/tex.rgba16.o \\', '    build/assets/sprite.ci4.o \\', '    build/assets/sprite.o \\',
      '    build/asm/data/heap.bss.o', 'build/asm/header.o:', 'build/assets/boot.o:', 'build/asm/data/blob.o:',
      'build/assets/tex.rgba16.o:', 'build/assets/sprite.ci4.o:', 'build/assets/sprite.o:', 'build/asm/data/heap.bss.o:', '',
    ].join('\n'));
    // blob_start from symbols.txt names the databin; its size matches, so nonmatching carries it
    assert.equal(read('asm/data/blob.s').toString(), '.include "macro.inc"\n\n.section .data, "wa"\n\n'
      + 'nonmatching blob_start, 0x100\n\ndlabel blob_start\n.incbin "assets/blob.databin.bin"\nenddlabel blob_start\n');
    const rom = makeRom();
    assert.ok(read('assets/boot.bin').equals(rom.subarray(0x40, 0x1000)));
    assert.ok(read('assets/blob.databin.bin').equals(rom.subarray(0x1000, 0x1100)));
    assert.equal(read('out/undefined_syms_auto.txt').length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy linker script generation and wildcard-off paths', async () => {
  const { dir, r, read } = await run('  ld_legacy_generation: True\n');
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    const ld = read('out/testrom.ld').toString();
    // legacy mode opens the NOLOAD block with the section symbols of the data run already closed
    assert.match(ld, /main_DATA_SIZE = ABSOLUTE\(main_DATA_END - main_DATA_START\);\n    \}\n    main_bss_VRAM = ADDR\(\.main_bss\);/);
    assert.match(ld, /\.main_bss \(NOLOAD\) : SUBALIGN\(16\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function chunks(png) {
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const out = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const tag = png.subarray(o + 4, o + 8).toString('latin1');
    const data = png.subarray(o + 8, o + 8 + len);
    assert.equal(png.readUInt32BE(o + 8 + len), crc32(Buffer.concat([Buffer.from(tag, 'latin1'), data])));
    out.push([tag, data]);
    o += 12 + len;
  }
  return out;
}

test('image segments: PNG bytes built by hand from the ROM data', async () => {
  const { dir, r, read } = await run();
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    const rom = makeRom();
    const ceil = (v) => Math.ceil(0xFF * (v / 31));

    // rgba16 -> 8-bit RGBA, colour type 6
    const rows = [];
    for (let y = 0; y < 4; y++) {
      const row = [0];
      for (let x = 0; x < 4; x++) {
        const s = rom.readUInt16BE(0x1100 + (y * 4 + x) * 2);
        const c = (v) => (v << 3) | (v >> 2);
        row.push(c((s >> 11) & 31), c((s >> 6) & 31), c((s >> 1) & 31), 255 * (s & 1));
      }
      rows.push(...row);
    }
    const raw = Buffer.from(rows);
    const z = compressobj();
    const idat = Buffer.concat([z.compress(raw), z.flush()]);
    const ihdr = Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0]);
    const build = (list) => {
      const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
      for (const [tag, data] of list) {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tag), data])));
        parts.push(len, Buffer.from(tag), data, crc);
      }
      return Buffer.concat(parts);
    };
    const expectedRgba = build([['IHDR', ihdr], ['IDAT', idat], ['IEND', Buffer.alloc(0)]]);
    const gotRgba = read('assets/tex.rgba16.png');
    assert.ok(gotRgba.equals(expectedRgba));
    // and the stream is a valid zlib stream of exactly those scanlines
    assert.ok(zlib.inflateSync(chunks(gotRgba)[1][1]).equals(raw));

    // ci4 with a 16-entry palette: PLTE + tRNS, colour type 3, one index byte per pixel
    const plte = []; const trns = [];
    for (let c = 0; c < 16; c++) {
      const s = rom.readUInt16BE(0x1128 + c * 2);
      plte.push(ceil((s >> 11) & 31), ceil((s >> 6) & 31), ceil((s >> 1) & 31));
      trns.push((s & 1) * 255);
    }
    const ciRaw = [];
    for (let y = 0; y < 4; y++) {
      ciRaw.push(0);
      for (let b = 0; b < 2; b++) { const v = rom[0x1120 + y * 2 + b]; ciRaw.push(v >> 4, v & 15); }
    }
    const z2 = compressobj();
    const idat2 = Buffer.concat([z2.compress(Buffer.from(ciRaw)), z2.flush()]);
    const expectedCi = build([['IHDR', Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 3, 0, 0, 0])],
      ['PLTE', Buffer.from(plte)], ['tRNS', Buffer.from(trns)], ['IDAT', idat2], ['IEND', Buffer.alloc(0)]]);
    assert.ok(read('assets/sprite.ci4.png').equals(expectedCi));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vanilla zlib stream: level 6 default, known bytes', () => {
  // Regression bytes of vanilla zlib 1.3.1 (the same module wrote 1000+ PNGs
  // byte-identical to CPython zlib output); also a valid zlib stream.
  const z = compressobj();
  const out = Buffer.concat([z.compress(Buffer.from('hello hello hello')), z.flush()]);
  assert.equal(out.toString('hex'), '789ccb48cdc9c957c84090003a2e067d');
  assert.equal(zlib.inflateSync(out).toString(), 'hello hello hello');
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('symbol file parsing: attributes, whitespace, comments', async () => {
  const { dir, r } = await run();
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    const { symbols: syms } = await import('../src/util/symbols.js').then((m) => ({ symbols: m.state.all_symbols }));
    const byName = new Map(syms.map((s) => [s.name, s]));
    const blob = byName.get('blob_start');
    assert.equal(blob.vram_start, 0x80001000);
    assert.equal(blob.type, 'u8');
    assert.equal(blob.given_size, 0x100);
    assert.equal(blob.rom, 0x1000);
    assert.equal(blob.user_declared, true);
    assert.equal(blob.defined, true); // the databin defines it
    assert.equal(blob.segment.name, 'main');
    const f = byName.get('func_80001200');
    assert.equal(f.type, 'func');
    assert.equal(f.defined, true);
    assert.equal(byName.get('tex_rgba').size, 0x20);
    assert.equal(byName.get('hwreg').segment, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad symbol lines and unknown options are reported as errors', async () => {
  const dir = makeProject('  not_an_option: 1\n');
  try {
    const r = await split(['splat.yaml'], { cwd: dir, backend: makeFakeBackend(), modes: MODES });
    assert.notEqual(r.exitCode, 0);
    assert.match(String(r.error), /Unrecognized YAML option\(s\): not_an_option/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const dir2 = makeProject();
  try {
    fs.appendFileSync(path.join(dir2, 'symbols.txt'), 'broken = 0x80001300; // defined:maybe\n');
    const r = await split(['splat.yaml'], { cwd: dir2, backend: makeFakeBackend(), modes: MODES });
    assert.equal(r.exitCode, 2);
    assert.match(r.stdout + r.stderr, /Invalid Boolean value 'maybe' for attribute 'defined'/);
  } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
});

test('splat 0.34.1 behaviour: newer options are unknown, textbin/databin asm has no nonmatching label', async () => {
  const dir = makeProject();
  try {
    const r = await split(['splat.yaml'], { cwd: dir, backend: makeFakeBackend(), modes: MODES, splatVersion: '0.34.1' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'asm/data/blob.s'), 'utf8'),
      '.include "macro.inc"\n\n.section .data, "wa"\n\nglabel blob_start\n.incbin "assets/blob.databin.bin"\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const dir2 = makeProject('  ld_gp_expression: foo\n');
  try {
    const r = await split(['splat.yaml'], { cwd: dir2, backend: makeFakeBackend(), modes: MODES, splatVersion: '0.34.1' });
    assert.match(String(r.error), /Unrecognized YAML option\(s\): ld_gp_expression/);
  } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
});

// A small synthetic N64 project (no real ROM data) for the ROM-less tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function makeRom() {
  const rom = Buffer.alloc(0x1200);
  rom.write('\x80\x37\x12\x40', 0, 'latin1');
  rom.write('SYNTHETIC TEST ROM  ', 0x20, 'latin1');
  rom.write('NSXE', 0x3B, 'latin1');
  for (let i = 0x40; i < 0x1000; i++) rom[i] = (i * 7) & 0xFF;
  for (let i = 0x1000; i < 0x1100; i++) rom[i] = i & 0xFF;
  // rgba16 4x4 at 0x1100: a gradient, alternate alpha
  for (let p = 0; p < 16; p++) rom.writeUInt16BE(((p * 2) << 11) | ((31 - p) << 6) | (p << 1) | (p & 1), 0x1100 + p * 2);
  // ci4 4x4 at 0x1120: indices 0..15
  for (let p = 0; p < 8; p++) rom[0x1120 + p] = ((p * 2) << 4) | (p * 2 + 1);
  // palette at 0x1128: 16 colours
  for (let c = 0; c < 16; c++) rom.writeUInt16BE((c << 11) | (c << 6) | ((15 - c) << 1) | (c > 0 ? 1 : 0), 0x1128 + c * 2);
  return rom;
}

export const SYMBOLS = `// symbols
blob_start = 0x80001000; // type:u8 size:0x100 rom:0x1000
tex_rgba = 0x80001100; // size:0x20
  func_80001200 = 0x80001200; // type:func defined:True
hwreg = 0xA4000000;
`;

export function makeYaml(sha1, extra = '') {
  return `name: Synthetic
sha1: ${sha1}
options:
  basename: testrom
  target_path: rom.z64
  elf_path: build/testrom.elf
  base_path: .
  platform: n64
  compiler: GCC
  ld_script_path: out/testrom.ld
  ld_dependencies: True
  undefined_funcs_auto_path: out/undefined_funcs_auto.txt
  undefined_syms_auto_path: out/undefined_syms_auto.txt
  symbol_addrs_path: symbols.txt
  asset_path: assets
  asm_path: asm
  image_type_in_extension: True
  ld_wildcard_sections: True
  ld_sections_allowlist: [.pdr]
  ld_sections_denylist: [.reginfo]
  o_as_suffix: True
${extra}segments:
  - name: header
    type: header
    start: 0x0
  - [0x40, bin, boot]
  - name: main
    type: code
    start: 0x1000
    vram: 0x80001000
    bss_size: 0x100
    subsegments:
      - [0x1000, databin, blob]
      - [0x1100, rgba16, tex, 4, 4]
      - [0x1120, ci4, sprite, 4, 4]
      - [0x1128, palette, sprite]
      - { start: 0x1148, type: bss, vram: 0x80001148, name: heap }
  - [0x1200]
`;
}

export function makeProject(extra = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'romdev-splat-test-'));
  const rom = makeRom();
  fs.writeFileSync(path.join(dir, 'rom.z64'), rom);
  fs.writeFileSync(path.join(dir, 'symbols.txt'), SYMBOLS);
  const sha1 = crypto.createHash('sha1').update(rom).digest('hex');
  fs.writeFileSync(path.join(dir, 'splat.yaml'), makeYaml(sha1, extra));
  return dir;
}

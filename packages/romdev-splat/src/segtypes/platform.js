// splat.segtypes.n64.* and splat.segtypes.psx.*
import { atLeast, mkdirp, writeText } from '../runtime.js';
import * as log from '../util/log.js';
import { opts } from '../util/options.js';
import { P, parent, name as pathName } from '../util/pypath.js';
import { hex, isDict, pyInt, rjust, ljust, truthy } from '../util/pyfmt.js';
import { Segment } from './segment.js';
import { registry } from './registry.js';
import { CommonSegHeader, CommonSegHasm, CommonSegCodeSubsegment } from './common.js';
import * as n64img from '../n64img/image.js';
import { rabbitizer } from '../disassembler/spim.js';
import { decodeText } from '../util/codecs.js';

const has = (o, k) => isDict(o) && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d = null) => (has(o, k) ? o[k] : d);

// ---------------------------------------------------------------- headers

export class N64SegHeader extends CommonSegHeader {
  parse_header(romBytes) {
    const encoding = opts.header_encoding;
    const L = [];
    const w = (a, b, c) => L.push(this.get_line('word', romBytes.subarray(a, b), c));
    L.push('.section .data\n');
    w(0x00, 0x04, 'PI BSB Domain 1 register');
    w(0x04, 0x08, 'Clockrate setting');
    w(0x08, 0x0C, 'Entrypoint address');
    w(0x0C, 0x10, 'Revision');
    w(0x10, 0x14, 'Checksum 1');
    w(0x14, 0x18, 'Checksum 2');
    w(0x18, 0x1C, 'Unknown 1');
    w(0x1C, 0x20, 'Unknown 2');
    if (encoding !== 'word') {
      const text = decodeText(romBytes.subarray(0x20, 0x34), encoding).replace(/^\s+|\s+$/g, '');
      L.push('.ascii "' + ljust(text, 20) + '" /* Internal name */');
    } else {
      for (let i = 0x20; i < 0x34; i += 4) w(i, i + 4, 'Internal name');
    }
    w(0x34, 0x38, 'Unknown 3');
    w(0x38, 0x3C, 'Cartridge');
    L.push(this.get_line('ascii', romBytes.subarray(0x3C, 0x3E), 'Cartridge ID'));
    L.push(this.get_line('ascii', romBytes.subarray(0x3E, 0x3F), 'Country code'));
    L.push(this.get_line('byte', romBytes.subarray(0x3F, 0x40), 'Version'));
    L.push('');
    return L;
  }
}

export class PsxSegHeader extends CommonSegHeader {
  parse_header(romBytes) {
    const L = [];
    const rev = (a, b) => Uint8Array.from(romBytes.subarray(a, b)).reverse();
    L.push('.section .data\n');
    L.push(this.get_line('ascii', romBytes.subarray(0x00, 0x08), 'Magic number'));
    L.push(this.get_line('word', rev(0x08, 0x0C), '.text vram address'));
    L.push(this.get_line('word', rev(0x0C, 0x10), '.data vram address'));
    L.push(this.get_line('word', rev(0x10, 0x14), 'Initial PC'));
    L.push(this.get_line('word', rev(0x14, 0x18), 'Initial $gp/r28'));
    L.push(this.get_line('word', rev(0x18, 0x1C), '.text start'));
    L.push(this.get_line('word', rev(0x1C, 0x20), '.text size'));
    L.push(this.get_line('word', rev(0x20, 0x24), '.data start'));
    L.push(this.get_line('word', rev(0x24, 0x28), '.data size'));
    L.push(this.get_line('word', rev(0x28, 0x2C), '.bss start'));
    L.push(this.get_line('word', rev(0x2C, 0x30), '.bss size'));
    L.push(this.get_line('word', rev(0x30, 0x34), 'Initial $sp/r29 & $fp/r30 base'));
    L.push(this.get_line('word', rev(0x34, 0x38), 'Initial $sp/r29 & $fp/r30 offset'));
    for (const a of [0x38, 0x3C, 0x40, 0x44, 0x48]) L.push(this.get_line('word', romBytes.subarray(a, a + 4), 'Reserved'));
    L.push(this.get_line('ascii', romBytes.subarray(0x4C, this.rom_end), 'Sony Inc'));
    L.push('');
    return L;
  }
}

// ---------------------------------------------------------------- ipl3 / rsp

export class N64SegIpl3 extends CommonSegHasm {
  constructor(...a) { super(...a); this.special_vram_segment = true; }
}

export class N64SegRsp extends CommonSegHasm {
  constructor(...a) { super(...a); this.instr_category = rabbitizer().InstrCategory.RSP; }
}

// ---------------------------------------------------------------- images

export class N64SegImg extends Segment {
  static parse_dimensions(yaml) {
    if (isDict(yaml)) {
      if (!has(yaml, 'width')) throw new Error("KeyError: 'width'");
      if (!has(yaml, 'height')) throw new Error("KeyError: 'height'");
      return [yaml.width, yaml.height];
    }
    if (yaml.length < 5) log.error(`Error: ${JSON.stringify(yaml)} is missing width and height parameters`);
    return [yaml[3], yaml[4]];
  }

  /** Subclasses pass the n64img class via the static IMG_CLS. */
  constructor(romStart, romEnd, type, name, vramStart, args, yaml) {
    super(romStart, romEnd, type, name, vramStart, args, yaml);
    if (romStart === null) log.error(`Error: ${type} segment ${name} rom start could not be determined`);
    const ImgCls = this.constructor.IMG_CLS;
    this.n64img = new ImgCls(new Uint8Array(0), 0, 0);
    if (isDict(yaml)) {
      this.n64img.flip_h = truthy(get(yaml, 'flip_x', false));
      this.n64img.flip_v = truthy(get(yaml, 'flip_y', false));
    }
    [this.width, this.height] = N64SegImg.parse_dimensions(yaml);
    this.n64img.width = this.width;
    this.n64img.height = this.height;
    this.image_type_in_extension = opts.image_type_in_extension;
  }

  check_len() {
    const expected = this.n64img.size();
    const actual = this.rom_end - this.rom_start;
    if (actual > expected) {
      log.error(`Error: ${this.name} should end at 0x${hex(this.rom_start + expected)}, but it ends at 0x${hex(this.rom_end)}\n(hint: add a 'bin' segment after it)`);
    } else if (atLeast('0.35.0') && actual < expected) {
      log.error(`Error: ${this.name} should end at 0x${hex(this.rom_start + expected)}, but it ends at 0x${hex(this.rom_end)}`);
    }
  }

  out_path() {
    const typeExt = this.image_type_in_extension ? `.${this.type}` : '';
    return P(opts.asset_path, this.dir, `${this.name}${typeExt}.png`);
  }

  should_split() { return opts.is_mode_active('img'); }

  split(romBytes) {
    this.check_len();
    const path = this.out_path();
    mkdirp(parent(path));
    if (this.n64img.data.length === 0) this.n64img.data = romBytes.subarray(this.rom_start, this.rom_end);
    this.n64img.write(path);
    this.log(`Wrote ${this.name} to ${path}`);
  }

  static estimate_size(yaml) {
    const [width, height] = N64SegImg.parse_dimensions(yaml);
    const typ = Segment.parse_segment_type(yaml);
    if (typ === 'ci4' || typ === 'i4' || typ === 'ia4') return Math.floor((width * height) / 2);
    if (typ === 'ia16' || typ === 'rgba16') return width * height * 2;
    if (typ === 'rgba32') return width * height * 4;
    return width * height;
  }
}

export class N64SegCi extends N64SegImg {
  parse_palette_names(yaml, args) {
    let ret = [this.name];
    if (isDict(yaml)) {
      if (has(yaml, 'palettes')) ret = yaml.palettes;
    } else if (args.length > 2) {
      ret = args[2];
    }
    if (typeof ret === 'string') ret = [ret];
    return ret;
  }

  constructor(...a) {
    super(...a);
    this.palettes = [];
    this.palette_names = this.parse_palette_names(this.yaml, this.args);
  }

  scan(romBytes) { this.n64img.data = romBytes.subarray(this.rom_start, this.rom_end); }

  out_path_pal(palName) {
    const typeExt = opts.image_type_in_extension ? `.${this.type}` : '';
    let outName;
    if (this.palettes.length === 1) outName = this.name;
    else if (palName.startsWith(this.name)) outName = palName;
    else outName = `${this.name}_${palName}`;
    return P(opts.asset_path, this.dir, `${outName}${typeExt}.png`);
  }

  split(romBytes) {
    if (atLeast('0.35.0')) this.check_len();
    if (this.palettes.length === 0) {
      log.error(`no palettes have been mapped to ci segment \`${this.name}\`\n(hint: add a palette segment with the same name or use the \`palettes:\` field of this segment to specify palettes by name')`);
    }
    this.n64img.data = romBytes.subarray(this.rom_start, this.rom_end);
    for (const palette of this.palettes) {
      const path = this.out_path_pal(palette.name);
      mkdirp(parent(path));
      this.n64img.palette = palette.parse_palette(romBytes);
      this.n64img.write(path);
      this.log(`Wrote ${pathName(path)} to ${path}`);
    }
  }
}

const imgClass = (Base, Img, extra = {}) => {
  const C = class extends Base {};
  C.IMG_CLS = Img;
  Object.assign(C, extra);
  return C;
};

export const N64SegCi4 = imgClass(N64SegCi, n64img.CI4);
export const N64SegCi8 = imgClass(N64SegCi, n64img.CI8);
export const N64SegI1 = imgClass(N64SegImg, n64img.I1);
export const N64SegI4 = imgClass(N64SegImg, n64img.I4);
export const N64SegI8 = imgClass(N64SegImg, n64img.I8);
export const N64SegIa4 = imgClass(N64SegImg, n64img.IA4);
export const N64SegIa8 = imgClass(N64SegImg, n64img.IA8);
export const N64SegIa16 = imgClass(N64SegImg, n64img.IA16);
export const N64SegRgba16 = imgClass(N64SegImg, n64img.RGBA16);
export const N64SegRgba32 = imgClass(N64SegImg, n64img.RGBA32);

// RRRRRGGG GGBBBBBA
export function unpackColor(data) {
  const s = opts.endianness === 'big' ? (data[0] << 8) | data[1] : data[0] | (data[1] << 8);
  const r = (s >> 11) & 0x1F; const g = (s >> 6) & 0x1F; const b = (s >> 1) & 0x1F;
  const a = (s & 1) * 0xFF;
  return [ceil255(r), ceil255(g), ceil255(b), a];
}

/** math.ceil(0xFF * (v / 31)) with Python float semantics. */
export function ceil255(v) { return Math.ceil(0xFF * (v / 31)); }

const VALID_SIZES = [0x20, 0x40, 0x80, 0x100, 0x200];

export class N64SegPalette extends Segment {
  static require_unique_name = false;

  constructor(...a) {
    super(...a);
    const modern = atLeast('0.35.0');
    let size;
    if (this.extract) {
      if (this.rom_end === null) log.error(`segment ${this.name} needs to know where it ends; add a position marker [0xDEADBEEF] after it`);
      if (modern && has(this.yaml, 'size')) {
        const yamlSize = this.yaml.size;
        if (Number.isInteger(this.rom_start) && Number.isInteger(this.rom_end)) {
          const romLen = this.rom_end - this.rom_start;
          if (romLen < yamlSize) {
            log.error(`Error: ${this.name} has a \`size\` value of 0x${hex(yamlSize)}, but this is smaller than the actual rom size of the palette (0x${hex(romLen)}, start: 0x${hex(this.rom_start)}, end: 0x${hex(this.rom_end)})`);
          } else if (romLen > yamlSize) {
            log.error(`Warning: ${this.name} has a \`size\` value of 0x${hex(yamlSize)}, but this is larger than the end of the palette (0x${hex(romLen)}, start: 0x${hex(this.rom_start)}, end: 0x${hex(this.rom_end)})\n(hint add a 'bin' segment after this palette with address 0x${hex(this.rom_end)})`);
          }
        }
        size = yamlSize;
      } else if (!has(this.yaml, 'size')) {
        const actualLen = this.rom_end - this.rom_start;
        const hint = "(hint: add a 'bin' segment after it or specify the size in the segment)";
        if (actualLen > VALID_SIZES[VALID_SIZES.length - 1]) {
          log.error(`Error: ${this.name} (0x${hex(actualLen)} bytes) is too long, max 0x${hex(VALID_SIZES[VALID_SIZES.length - 1])})\n${hint}`);
        }
        if (!VALID_SIZES.includes(actualLen)) {
          log.error(`Error: ${this.name} (0x${hex(actualLen)} bytes) is not a valid palette size (${VALID_SIZES.map((s) => '0x' + s.toString(16)).join(', ')})\n${hint}`);
        }
        size = actualLen;
      }
    } else {
      size = 0;
    }
    this.palette_size = size;
    this.global_id = isDict(this.yaml) ? get(this.yaml, 'global_id', null) : null;
  }

  get_cname() { return super.get_cname() + '_pal'; }

  static parse_palette_bytes(data) {
    const palette = [];
    for (let i = 0; i < data.length; i += 2) {
      // zip_longest(fillvalue=None): an odd trailing byte pairs with None
      if (i + 1 >= data.length) throw new TypeError("unsupported operand type(s) for <<: 'NoneType' and 'int'");
      palette.push(unpackColor([data[i], data[i + 1]]));
    }
    return palette;
  }

  parse_palette(romBytes) {
    const data = atLeast('0.35.0')
      ? romBytes.subarray(this.rom_start, this.rom_start + this.palette_size)
      : romBytes.subarray(this.rom_start, this.rom_end);
    return N64SegPalette.parse_palette_bytes(data);
  }

  should_split() { return this.extract && opts.is_mode_active('img'); }
  out_path() { return P(opts.asset_path, this.dir, `${this.name}.png`); }

  get_linker_entries() {
    return [new registry.LinkerEntry(this, [P(opts.asset_path, this.dir, `${this.name}.png`)],
      P(opts.asset_path, this.dir, `${this.name}.pal`), this.get_linker_section_order(),
      this.get_linker_section_linksection(), this.is_noload())];
  }

  static estimate_size(yaml) {
    if (isDict(yaml) && has(yaml, 'size')) return pyInt(yaml.size);
    return 0x20;
  }
}

// ---------------------------------------------------------------- vtx

export class N64SegVtx extends CommonSegCodeSubsegment {
  constructor(...a) {
    super(...a);
    this.file_text = null;
    this.data_only = isDict(this.yaml) ? get(this.yaml, 'data_only', false) : false;
  }

  format_sym_name(sym) { return sym.name; }
  get_linker_section() { return '.data'; }
  out_path() { return P(opts.asset_path, this.dir, `${this.name}.vtx.inc.c`); }
  scan(romBytes) { this.file_text = this.disassemble_data(romBytes); }

  disassemble_data(romBytes) {
    const data = romBytes.subarray(this.rom_start, this.rom_end);
    if (data.length % 16 !== 0) log.error(`Error: Vtx segment ${this.name} length (${data.length}) is not a multiple of 16!`);
    const lines = [];
    if (!truthy(this.data_only)) { lines.push(opts.generated_c_preamble); lines.push(''); }
    const count = Math.floor(data.length / 16);
    const sym = this.create_symbol(this.vram_start, true, { type: 'data', define: true });
    if (!truthy(this.data_only)) lines.push(`Vtx ${this.format_sym_name(sym)}[${count}] = {`);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let o = 0; o + 16 <= data.length; o += 16) {
      const x = dv.getInt16(o); const y = dv.getInt16(o + 2); const z = dv.getInt16(o + 4);
      const flg = dv.getUint16(o + 6);
      const t = dv.getInt16(o + 8); const c = dv.getInt16(o + 10);
      const r = data[o + 12]; const g = data[o + 13]; const b = data[o + 14]; const a = data[o + 15];
      lines.push(`    {{{ ${rjust(x, 5)}, ${rjust(y, 5)}, ${rjust(z, 5)} }, ${flg}, { ${rjust(t, 5)}, ${rjust(c, 5)} }, { ${rjust(r, 3)}, ${rjust(g, 3)}, ${rjust(b, 3)}, ${rjust(a, 3)} }}},`);
      if (flg !== 0) this.warn(`Non-zero flag found in vertex data ${this.name}!`);
    }
    if (!truthy(this.data_only)) lines.push('};');
    lines.push('');
    return lines.join('\n');
  }

  split() {
    if (this.file_text && this.out_path()) {
      mkdirp(parent(this.out_path()));
      writeText(this.out_path(), this.file_text, '\n');
    }
  }

  should_scan() { return opts.is_mode_active('vtx'); }
  should_split() { return this.extract && opts.is_mode_active('vtx'); }

  static estimate_size(yaml) {
    if (isDict(yaml) && has(yaml, 'length')) return yaml.length * 0x10;
    return null;
  }
}

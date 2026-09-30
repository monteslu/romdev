// Ports of the splat extension segtypes (extensions_path/*.py) shipped by the
// projects romdev targets. Python splat imports `<extensions_path>/<type>.py`
// and takes the class `<PLATFORM>Seg<Type>`; romdev cannot run Python, so each
// known file is identified by its sha256 and mapped to a JS port here. A file
// with any other content is reported as unsupported, never guessed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { abs } from '../runtime.js';
import { P } from '../util/pypath.js';
import { mkdirp, writeBytes } from '../runtime.js';
import { opts } from '../util/options.js';
import { parent } from '../util/pypath.js';
import { Segment } from '../segtypes/segment.js';
import { CommonSegHasm, CommonSegData } from '../segtypes/common.js';
import { N64SegCi4, N64SegI4, N64SegRgba16, N64SegPalette, N64SegImg, ceil255 } from '../segtypes/platform.js';
import * as n64img from '../n64img/image.js';
import { SplatError, isFile } from '../runtime.js';

// ---------------------------------------------------------------- an N64 decomp project: hcode.py / hdata.py

/** "Authored assembly code in src; preserve source during ROM extraction." */
class N64SegHcode extends CommonSegHasm {
  asm_out_path() { return P(opts.src_path, this.dir, `${this.name}.s`); }
  split() {
    if (!isFile(this.asm_out_path())) {
      throw new SplatError(`FileNotFoundError: Missing authored code source: ${this.asm_out_path()}`, 1);
    }
  }
}

/** "Authored assembly data: analyze/link as data, never regenerate its source." */
class N64SegHdata extends CommonSegData {
  asm_out_path() { return P(opts.src_path, this.dir, `${this.name}.s`); }
  split() {
    if (!isFile(this.asm_out_path())) {
      throw new SplatError(`FileNotFoundError: Missing authored data source: ${this.asm_out_path()}`, 1);
    }
  }
}

// ---------------------------------------------------------------- PS1 decomp project: tools/splat_ext

class PSXSegCi4 extends N64SegCi4 {
  constructor(...a) { super(...a); this.n64img.little_endian = true; }
}

class PSXSegI4 extends N64SegI4 {
  constructor(...a) { super(...a); this.n64img.little_endian = true; }
}

class PSXSegRgba16 extends N64SegRgba16 {}

// ABBBBBGG GGGRRRRR
function psxUnpackColor(a, b) {
  const s = a | (b << 8);
  const r = s & 0x1F; const g = (s >> 5) & 0x1F; const bl = (s >> 10) & 0x1F;
  const al = (s >> 15) * 0xFF;
  return [ceil255(r), ceil255(g), ceil255(bl), al];
}

class PSXSegPalette extends N64SegPalette {
  parse_palette(romBytes) {
    const data = romBytes.subarray(this.rom_start, this.rom_end);
    const palette = [];
    for (let i = 0; i < data.length; i += 2) {
      if (i + 1 >= data.length) throw new TypeError("unsupported operand type(s) for <<: 'NoneType' and 'int'");
      palette.push(psxUnpackColor(data[i], data[i + 1]));
    }
    return palette;
  }
}

function greyPalette() {
  const out = [];
  for (let i = 0; i < 16; i++) out.push([i * 0x11, i * 0x11, i * 0x11, 255]);
  return out;
}

class PSXSegGrey4 extends N64SegImg {
  split(romBytes) {
    const path = this.out_path();
    mkdirp(parent(path));
    this.n64img.palette = greyPalette();
    this.n64img.data = romBytes.subarray(this.rom_start, this.rom_end);
    this.n64img.little_endian = true;
    this.n64img.write(path);
    this.log(`Wrote ${this.name} to ${path}`);
  }
}
PSXSegGrey4.IMG_CLS = n64img.CI4;

class PSXSegRaw extends Segment {
  out_path() { return P(opts.asset_path, this.dir, this.name); }
  src_path() { return P(opts.asset_path, this.dir, `${this.name}.bin`); }
  split(romBytes) {
    const path = this.src_path();
    mkdirp(parent(path));
    writeBytes(path, romBytes.subarray(this.rom_start, this.rom_end));
  }
}

// sha256 of the .py file -> { className: class }
export const PORTED_EXTENSIONS = {
  // an N64 project's authored-source segtypes
  '86257f3454baab37422c65128811ee6e638d6544923126f495c963b87587e46a': { file: 'hcode.py', classes: { N64SegHcode } },
  'cc51424f8f64dfa403f08f227e3d7823e06443c2e1a052214627da50ef07d702': { file: 'hdata.py', classes: { N64SegHdata } },
  // PS1 project tools/splat_ext
  '5d4efa9e428e51f674e4cbb2094358902cc95e3230166c812074153fd3ef1ade': { file: 'ci4.py', classes: { PSXSegCi4 } },
  '5c17771ba298a89ecb2221fa2a2dd72a19f85fdaab7a9febd90814929e5454b6': { file: 'i4.py', classes: { PSXSegI4 } },
  '822f24eab1a4145bce9967031299a343dd208f29cb509cb00b8609765ee9fb65': { file: 'rgba16.py', classes: { PSXSegRgba16 } },
  '065d07f8650b7051c7ad7c94c7cdd95371aed06755e38e9eb72e1049290fe0fc': { file: 'palette.py', classes: { PSXSegPalette } },
  '8cfb7861b6150d1558fd2b0b9c2edaf065a6eaa9f66198ce60a88a7967f32d23': { file: 'grey4.py', classes: { PSXSegGrey4 } },
  '52c275dea2e3431070f16e92305a873e63442de08c8fe9e66baa7faaab087a68': { file: 'raw.py', classes: { PSXSegRaw } },
};

/** Report of every extension file the run looked at: [{ path, sha256, ported }]. */
export const extensionReport = [];

export function loadExtension(extPath, segType, platform) {
  const file = P(extPath, `${segType}.py`);
  let bytes;
  try {
    bytes = fs.readFileSync(abs(file));
  } catch {
    return null; // Python: the import fails and get_extension_segment_class returns None
  }
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const port = PORTED_EXTENSIONS[sha];
  extensionReport.push({ path: file, sha256: sha, ported: !!port });
  if (!port) {
    throw new SplatError(`romdev-splat: extension ${file} (sha256 ${sha}) has no JS port; this splat extension is unsupported`, 2);
  }
  const clsName = `${platform.toUpperCase()}Seg${segType[0].toUpperCase()}${segType.slice(1)}`;
  const cls = port.classes[clsName];
  if (!cls) throw new SplatError(`AttributeError: module '${file}' has no attribute '${clsName}'`, 1);
  return cls;
}

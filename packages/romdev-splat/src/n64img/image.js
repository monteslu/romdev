// Port of n64img 0.3.3 (n64img/image.py + iter.py, MIT, ethteck).
import { writeBytes } from '../runtime.js';
import { Writer } from './png.js';

function* iterImageIndexes(width, height, bytesPerPixel = 1, flipH = false, flipV = false) {
  const w = Math.trunc(width * bytesPerPixel);
  const h = Math.trunc(height * 1);
  const step = Math.ceil(bytesPerPixel);
  const xs = [];
  if (flipH) for (let x = w - step; x > -1; x -= step) xs.push(x);
  else for (let x = 0; x < w; x += step) xs.push(x);
  const ys = [];
  if (flipV) for (let y = h - 1; y > -1; y--) ys.push(y);
  else for (let y = 0; y < h; y++) ys.push(y);
  for (const y of ys) for (const x of xs) yield [x, y, y * w + x];
}

function at(data, i) {
  if (i < 0 || i >= data.length) throw new RangeError('IndexError: index out of range');
  return data[i];
}

export class Image {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.depth = 1;
    this.greyscale = false;
    this.alpha = false;
    this.flip_h = false;
    this.flip_v = false;
    this.little_endian = false;
    this.palette = null;
  }

  get_writer() {
    return new Writer(this.width, this.height, { greyscale: this.greyscale, alpha: this.alpha, palette: this.palette });
  }

  parse() {
    if (!this.flip_h && !this.flip_v) return this.data;
    const img = [];
    for (const [, , i] of iterImageIndexes(this.width, this.height, this.depth, this.flip_h, this.flip_v)) img.push(at(this.data, i));
    return Uint8Array.from(img);
  }

  write(outpath) {
    const pixels = this.parse();
    writeBytes(outpath, this.get_writer().writeArray(pixels));
  }

  size() { return Math.ceil(this.width * this.height * this.depth); }
}

export class CI4 extends Image {
  constructor(d, w, h) { super(d, w, h); this.depth = 0.5; }
  parse() {
    const img = [];
    for (const [, , i] of iterImageIndexes(this.width, this.height, this.depth, this.flip_h, this.flip_v)) {
      const b = at(this.data, i);
      if (this.little_endian) img.push(b & 0xF, b >> 4);
      else img.push(b >> 4, b & 0xF);
    }
    return Uint8Array.from(img);
  }
}

export class CI8 extends Image {}

export class I1 extends Image {
  constructor(d, w, h) { super(d, w, h); this.depth = 0.125; this.greyscale = true; }
  parse() {
    if (this.flip_h) throw new Error('I1 images cannot be flipped horizontally.');
    if (this.flip_v) throw new Error('I1 images cannot be flipped vertically.');
    const img = [];
    for (const b of this.data) for (let j = 8; j > 0; j--) img.push(((b >> (j - 1)) & 1) * 0xFF);
    return Uint8Array.from(img);
  }
}

export class I4 extends Image {
  constructor(d, w, h) { super(d, w, h); this.depth = 0.5; this.greyscale = true; }
  parse() {
    const img = [];
    for (const [, , i] of iterImageIndexes(this.width, this.height, this.depth, this.flip_h, this.flip_v)) {
      const b = at(this.data, i);
      let i1; let i2;
      if (this.little_endian) { i1 = b & 0xF; i2 = (b >> 4) & 0xF; } else { i1 = (b >> 4) & 0xF; i2 = b & 0xF; }
      img.push((i1 << 4) | i1, (i2 << 4) | i2);
    }
    return Uint8Array.from(img);
  }
}

export class I8 extends Image {
  constructor(d, w, h) { super(d, w, h); this.greyscale = true; }
}

export class IA4 extends Image {
  constructor(d, w, h) { super(d, w, h); this.depth = 0.5; this.greyscale = true; this.alpha = true; }
  parse() {
    const img = [];
    for (const [, , i] of iterImageIndexes(this.width, this.height, this.depth, this.flip_h, this.flip_v)) {
      const b = at(this.data, i);
      let h; let l;
      if (this.little_endian) { h = b & 0xF; l = (b >> 4) & 0xF; } else { h = (b >> 4) & 0xF; l = b & 0xF; }
      let i1 = h & 0xE; i1 = (i1 << 4) | (i1 << 1) | (i1 >> 2);
      const a1 = (h & 1) * 0xFF;
      let i2 = l & 0xE; i2 = (i2 << 4) | (i2 << 1) | (i2 >> 2);
      const a2 = (l & 1) * 0xFF;
      img.push(i1 & 0xFF, a1, i2 & 0xFF, a2);
    }
    return Uint8Array.from(img);
  }
}

export class IA8 extends Image {
  constructor(d, w, h) { super(d, w, h); this.greyscale = true; this.alpha = true; }
  parse() {
    const img = [];
    for (const [, , idx] of iterImageIndexes(this.width, this.height, 1, this.flip_h, this.flip_v)) {
      const b = at(this.data, idx);
      let i = (b >> 4) & 0xF; let a = b & 0xF;
      i = (i << 4) | i; a = (a << 4) | a;
      img.push(i, a);
    }
    return Uint8Array.from(img);
  }
}

export class IA16 extends Image {
  constructor(d, w, h) { super(d, w, h); this.depth = 2; this.greyscale = true; this.alpha = true; }
  parse() {
    if (!this.flip_h && !this.flip_v) return this.data;
    const img = [];
    for (const [, , i] of iterImageIndexes(this.width, this.height, this.depth, this.flip_h, this.flip_v)) {
      img.push(at(this.data, i), at(this.data, i + 1));
    }
    return Uint8Array.from(img);
  }
}

export class RGBA16 extends Image {
  constructor(d, w, h) { super(d, w, h); this.depth = 2; this.greyscale = false; this.alpha = true; }
  parse() {
    const img = [];
    for (const [, , i] of iterImageIndexes(this.width, this.height, this.depth, this.flip_h, this.flip_v)) {
      // int.from_bytes(data[i:i+2], "big"): a short slice at the end reads fewer bytes
      const hi = this.data[i]; const lo = this.data[i + 1];
      let s;
      if (hi === undefined) s = 0;
      else if (lo === undefined) s = hi;
      else s = (hi << 8) | lo;
      let r = (s >> 11) & 0x1F; let g = (s >> 6) & 0x1F; let b = (s >> 1) & 0x1F;
      r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2);
      img.push(r, g, b, 255 * (s & 1));
    }
    return Uint8Array.from(img);
  }
}

export class RGBA32 extends Image {
  constructor(d, w, h) { super(d, w, h); this.depth = 4; this.greyscale = false; this.alpha = true; }
  parse() {
    if (!this.flip_h && !this.flip_v) return this.data;
    const img = [];
    for (const [, , i] of iterImageIndexes(this.width, this.height, this.depth, this.flip_h, this.flip_v)) {
      img.push(at(this.data, i), at(this.data, i + 1), at(this.data, i + 2), at(this.data, i + 3));
    }
    return Uint8Array.from(img);
  }
}

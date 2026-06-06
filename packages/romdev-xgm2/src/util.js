// Port of sgdk.xgm2tool.tool.Util — byte get/set, align, string parsing.
// All multi-byte values are LITTLE-ENDIAN (XGM2/VGM convention).
//
// Java `byte` is signed; we operate on Uint8Array (0..255) and mask with & 0xFF
// to mirror Java's `& 0xFF` idiom. Ints are 32-bit; we keep them as JS numbers
// and apply >>> 0 / | 0 only where the Java code relies on 32-bit wraparound.

/** Round `value` up to the next multiple of `align`. */
export function align(value, alignTo) {
  return Math.floor((value + (alignTo - 1)) / alignTo) * alignTo;
}

/** Return a new Uint8Array = `data` padded with `fill` up to a multiple of `alignTo`. */
export function alignBytes(data, alignTo, fill) {
  const padded = align(data.length, alignTo);
  if (padded === data.length) return data.slice();
  const out = new Uint8Array(padded);
  out.set(data, 0);
  if (fill) out.fill(fill & 0xff, data.length);
  return out;
}

export function getInt8(data, offset) {
  return data[offset] & 0xff;
}

export function getInt16(data, offset) {
  return (data[offset] & 0xff) | ((data[offset + 1] & 0xff) << 8);
}

export function getInt24(data, offset) {
  return (
    (data[offset] & 0xff) |
    ((data[offset + 1] & 0xff) << 8) |
    ((data[offset + 2] & 0xff) << 16)
  );
}

export function getInt32(data, offset) {
  // >>> 0 keeps it unsigned (Java returns int, but VGM offsets/sizes are non-negative).
  return (
    ((data[offset] & 0xff) |
      ((data[offset + 1] & 0xff) << 8) |
      ((data[offset + 2] & 0xff) << 16) |
      ((data[offset + 3] & 0xff) << 24)) >>> 0
  );
}

export function setInt8(arr, offset, value) {
  arr[offset] = value & 0xff;
}

export function setInt16(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
}

export function setInt24(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
}

export function setInt32(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
  arr[offset + 3] = (value >> 24) & 0xff;
}

export function getASCIIStringSize(data, offset) {
  let n = 0;
  while (getInt8(data, offset + n) !== 0) n++;
  return n;
}

export function getASCIIString(data, offset, length) {
  if (length == null) length = getASCIIStringSize(data, offset);
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(data[offset + i] & 0xff);
  return s;
}

export function getWideStringSize(data, offset) {
  let n = 0;
  while (getInt16(data, offset + n * 2) !== 0) n++;
  return n;
}

export function getWideString(data, offset, length) {
  if (length == null) length = getWideStringSize(data, offset);
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(getInt16(data, offset + i * 2));
  return s;
}

/** UTF-16LE bytes for a string (GD3/XD3 tags). */
export function getBytesUtf16(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) setInt16(out, i * 2, text.charCodeAt(i) & 0xffff);
  return out;
}

/** ASCII bytes for a string. */
export function getBytesAscii(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function arrayEquals(a, b, size) {
  for (let i = 0; i < size; i++) if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  return true;
}

/** Heuristic from Util.isDiffRate — >10% apart counts as a different rate. */
export function isDiffRate(rate1, rate2) {
  if (rate1 === rate2) return false;
  const r1 = Math.max(100, rate1);
  const r2 = Math.max(100, rate2);
  const f = r1 / r2;
  return Math.abs(100 - f * 100) > 10;
}

/**
 * Linear-interpolation resampler for 8-bit SIGNED PCM (Java Util.resample_old,
 * the JVM-free path — we use this so there's no javax.sound dependency). Input
 * and output are signed bytes stored in a Uint8Array (two's complement). `align`
 * pads the output to a multiple of `align` with 0x80 (silence in this codec's
 * signed domain is 0, but the Java pad uses 0x80 — kept identical).
 */
export function resamplePcm8(data, offset, len, inputRate, outputRate, alignTo) {
  const out = [];
  const step = inputRate / outputRate;
  const s8 = (b) => ((b & 0xff) << 24) >> 24; // to signed 8-bit
  let value = 0;
  let lastSample = 0;
  let off = 0;
  for (let dOff = 0; dOff <= len - step; dOff += step) {
    let sample = 0;
    if (step >= 1) {
      if (value < 0) sample += lastSample * -value;
      value += step;
      while (value > 0) {
        lastSample = s8(data[off + offset]);
        off++;
        if (value >= 1) sample += lastSample;
        else sample += lastSample * value;
        value -= 1;
      }
      sample /= step;
    } else if (Math.floor(dOff) === dOff) {
      sample = s8(data[Math.floor(dOff) + offset]);
    } else {
      const s0 = s8(data[Math.floor(dOff) + offset]);
      const s1 = s8(data[Math.ceil(dOff) + offset]);
      sample += s0 * (Math.ceil(dOff) - dOff);
      sample += s1 * (dOff - Math.floor(dOff));
    }
    out.push(Math.round(sample) & 0xff);
  }
  let result = Uint8Array.from(out);
  if (alignTo > 1) {
    const mask = alignTo - 1;
    const pad = alignTo - (result.length & mask);
    if (pad !== alignTo) {
      const padded = new Uint8Array(result.length + pad);
      padded.set(result, 0);
      padded.fill(0x80, result.length);
      result = padded;
    }
  }
  return result;
}

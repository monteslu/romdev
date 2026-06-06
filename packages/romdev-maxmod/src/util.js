/**
 * util.js — shared low-level helpers for the pure-JS mmutil (Maxmod soundbank) port.
 *
 * Ported faithfully from devkitPro mmutil:
 *   - files.c  → ByteWriter (write8/16/24/32, align16/align32, patch, tell)
 *               + ByteReader (read8/16/24/32 LE, plus BE variants for MOD/IT 0x.. fields)
 *   - simple.c → readbits, get_ext, calc_samplooplen, calc_samplen, calc_samplen_ex2,
 *                clamp_s8, clamp_u8, sample_dsformat, sample_dsreptype
 *   - deftypes.h → BYTESMASHER and the C type model (all writes are LITTLE-ENDIAN).
 *
 * IMPORTANT semantics carried over from the C:
 *   - Everything operates on bytes; the C used a FILE* with a moving cursor. We model
 *     that with a growable Uint8Array-backed cursor so back-patching (size/offset
 *     fixups) works exactly like fseek+fwrite in mmutil.
 *   - align32() pads the WRITE CURSOR (file-absolute, from offset 0) to a 4-byte
 *     boundary using BYTESMASHER (0xBA) — NOT zero. (files.c align32.)
 *   - All multi-byte writes are little-endian (files.c write16/write24/write32).
 *
 * The in-memory module model (see makeModule / makeSample / etc. below) is the SAME
 * shape regardless of source format (mod/xm/it/s3m) so a single mas-emitter can
 * consume any of them. Field names mirror mas.h structs 1:1.
 *
 * Plain JS ESM + JSDoc. No TypeScript. No Node fs — Uint8Array in / Uint8Array out.
 */

// ---------------------------------------------------------------------------
// Constants (defs.h / deftypes.h / mas.h / systems.h)
// ---------------------------------------------------------------------------

/** defs.h: BYTESMASHER — the filler/placeholder byte mmutil writes (0xBA). */
export const BYTESMASHER = 0xba;

/** defs.h: MAX_CHANNELS. */
export const MAX_CHANNELS = 32;

/** systems.h: target system ids. We only emit GBA. */
export const SYSTEM_GBA = 0;
export const SYSTEM_NDS = 1;

/** mas.h: MAS record types. */
export const MAS_TYPE_SONG = 0;
export const MAS_TYPE_SAMPLE_GBA = 1;
export const MAS_TYPE_SAMPLE_NDS = 2;

/** mas.h: sample format flags. */
export const SAMPF_16BIT = 0x001;
export const SAMPF_SIGNED = 0x002;
export const SAMPF_COMP = 0x004;

/** mas.h: combined sample-format constants. SAMP_FORMAT_U8 == 0 (no flags). */
export const SAMP_FORMAT_U8 = 0;
export const SAMP_FORMAT_U16 = SAMPF_16BIT;
export const SAMP_FORMAT_S8 = SAMPF_SIGNED;
export const SAMP_FORMAT_S16 = SAMPF_16BIT | SAMPF_SIGNED;
export const SAMP_FORMAT_ADPCM = SAMPF_COMP;

/** simple.h: input file type ids (from get_ext). */
export const INPUT_TYPE_MOD = 0;
export const INPUT_TYPE_S3M = 1;
export const INPUT_TYPE_XM = 2;
export const INPUT_TYPE_IT = 3;
export const INPUT_TYPE_WAV = 4;
export const INPUT_TYPE_TXT = 5;
export const INPUT_TYPE_UNK = 6;
export const INPUT_TYPE_H = 7;
export const INPUT_TYPE_MSL = 8;

/** defs.h: CLAMP(x,a,b). Returns x clamped into [a,b]. */
export function CLAMP(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

// ---------------------------------------------------------------------------
// ByteWriter — faithful port of files.c write side (write8/16/24/32, align*, seek).
//
// The C kept a single global `fout` FILE* with an implicit cursor; fseek_write
// repositioned it for back-patching. We replicate that with an explicit cursor
// (`pos`) into a growable buffer. Writes past the end grow the buffer; seeking
// backwards + writing overwrites in place (exactly like r+b fseek/fwrite).
//
// `length` (file_tell_write at EOF) is the high-water mark, NOT the cursor — see
// note on tell() below.
// ---------------------------------------------------------------------------

export class ByteWriter {
  /** @param {number} [initialCapacity] */
  constructor(initialCapacity = 1024) {
    /** @type {Uint8Array} backing store; may be larger than `len`. */
    this.buf = new Uint8Array(initialCapacity);
    /** @type {number} current write cursor (mmutil's ftell(fout)). */
    this.pos = 0;
    /** @type {number} logical length / high-water mark (EOF). */
    this.len = 0;
  }

  /**
   * Ensure the backing buffer can hold at least `n` bytes total.
   * @param {number} n
   * @private
   */
  _ensure(n) {
    if (n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** files.c write8: write one byte at the cursor, advance, bump file_byte_count. */
  write8(v) {
    this._ensure(this.pos + 1);
    this.buf[this.pos++] = v & 0xff;
    if (this.pos > this.len) this.len = this.pos;
    return this;
  }

  /** files.c write16: little-endian. write8(v&0xFF); write8(v>>8). */
  write16(v) {
    this.write8(v & 0xff);
    this.write8((v >>> 8) & 0xff);
    return this;
  }

  /** files.c write24: little-endian 3 bytes. */
  write24(v) {
    this.write8(v & 0xff);
    this.write8((v >>> 8) & 0xff);
    this.write8((v >>> 16) & 0xff);
    return this;
  }

  /**
   * files.c write32: little-endian.
   *   write16(v & 0xFFFF); write16(v >> 16);
   * Use >>> so values >= 0x80000000 (e.g. 0xFFFFFFFF loop = no-loop, 0xAAAAAAAA
   * placeholder) round-trip correctly.
   */
  write32(v) {
    this.write16(v & 0xffff);
    this.write16((v >>> 16) & 0xffff);
    return this;
  }

  /**
   * Append a block of raw bytes (used by MSL_Export to copy sample/module blobs).
   * @param {Uint8Array|number[]} bytes
   */
  writeBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) this.write8(bytes[i]);
    return this;
  }

  /**
   * Write an ASCII string as raw bytes (no terminator). Used for the '*maxmod*'
   * magic etc. Non-ASCII chars are truncated to their low byte.
   * @param {string} s
   */
  writeString(s) {
    for (let i = 0; i < s.length; i++) this.write8(s.charCodeAt(i) & 0xff);
    return this;
  }

  /**
   * files.c align16: if cursor is odd, write one BYTESMASHER.
   * NOTE: alignment is file-absolute (cursor relative to offset 0).
   */
  align16() {
    if (this.pos & 1) this.write8(BYTESMASHER);
    return this;
  }

  /**
   * files.c align32: pad the cursor up to the next 4-byte boundary with
   * BYTESMASHER bytes. The C does three guarded write8(BYTESMASHER) calls; this
   * loop is equivalent and pads 0..3 bytes.
   *   if(ftell&3) write8(BA); if(ftell&3) write8(BA); if(ftell&3) write8(BA);
   */
  align32() {
    while (this.pos & 3) this.write8(BYTESMASHER);
    return this;
  }

  /**
   * mmutil file_tell_write(): the C returns ftell(fout) — the CURSOR position.
   * In mmutil every parapointer/offset is captured immediately after the
   * relevant data is appended (cursor == EOF at that moment), so cursor and
   * high-water mark coincide at capture time. Returns the current cursor.
   */
  tell() {
    return this.pos;
  }

  /** Current logical length (EOF / high-water mark). */
  size() {
    return this.len;
  }

  /**
   * mmutil file_seek_write(offset, SEEK_SET): reposition the cursor for
   * back-patching. Subsequent write*() overwrite in place.
   * @param {number} offset absolute offset from file start
   */
  seek(offset) {
    this.pos = offset;
    return this;
  }

  /**
   * Patch a little-endian u32 at an absolute offset WITHOUT disturbing the
   * current cursor. This is the common mmutil pattern (back-patch a size/offset
   * placeholder, then carry on appending). Equivalent to: save cursor, seek,
   * write32, restore cursor.
   * @param {number} offset
   * @param {number} value
   */
  patch32(offset, value) {
    const save = this.pos;
    this.pos = offset;
    this.write32(value);
    this.pos = save;
    return this;
  }

  /** Patch a little-endian u16 at an absolute offset (cursor preserved). */
  patch16(offset, value) {
    const save = this.pos;
    this.pos = offset;
    this.write16(value);
    this.pos = save;
    return this;
  }

  /** Patch a single byte at an absolute offset (cursor preserved). */
  patch8(offset, value) {
    const save = this.pos;
    this.pos = offset;
    this.write8(value);
    this.pos = save;
    return this;
  }

  /** Return the finished file as a tightly-sized Uint8Array (copy of [0, len)). */
  toUint8Array() {
    return this.buf.slice(0, this.len);
  }
}

// ---------------------------------------------------------------------------
// ByteReader — faithful port of files.c read side, for parsing input modules.
//
// files.c read8/16/24/32 are all LITTLE-ENDIAN. MOD and several IT/S3M fields
// are big-endian (or use BE word order); the original mmutil loaders assemble
// those by hand from read8()s. We provide explicit *BE variants so the parsers
// read straight without bespoke shifting, while the LE versions match files.c
// byte-for-byte.
// ---------------------------------------------------------------------------

export class ByteReader {
  /** @param {Uint8Array} data */
  constructor(data) {
    /** @type {Uint8Array} */
    this.buf = data;
    /** @type {number} read cursor (mmutil's ftell(fin)). */
    this.pos = 0;
  }

  /**
   * files.c read8: one byte. Reading past EOF returns 0 (fread leaves the
   * destination uninitialised in C, but mmutil never relies on that; we return 0
   * deterministically).
   */
  read8() {
    if (this.pos >= this.buf.length) {
      this.pos++;
      return 0;
    }
    return this.buf[this.pos++];
  }

  /** files.c read16: little-endian. a = read8(); a |= read8()<<8. */
  read16() {
    const a = this.read8();
    return (a | (this.read8() << 8)) & 0xffff;
  }

  /** files.c read24: little-endian 3 bytes. */
  read24() {
    const a = this.read8();
    const b = this.read8();
    const c = this.read8();
    return (a | (b << 8) | (c << 16)) >>> 0;
  }

  /** files.c read32: little-endian. read16() | read16()<<16. Unsigned. */
  read32() {
    const lo = this.read16();
    const hi = this.read16();
    return ((lo | (hi << 16)) >>> 0);
  }

  /** Signed 8-bit read (s8): interpret the byte as two's complement. */
  read8s() {
    const v = this.read8();
    return v < 0x80 ? v : v - 0x100;
  }

  /** Signed 16-bit LE read (s16). */
  read16s() {
    const v = this.read16();
    return v < 0x8000 ? v : v - 0x10000;
  }

  /** Big-endian u16 — for MOD sample-length/period fields, IT/S3M BE words. */
  read16be() {
    const hi = this.read8();
    const lo = this.read8();
    return ((hi << 8) | lo) & 0xffff;
  }

  /** Big-endian u24. */
  read24be() {
    const a = this.read8();
    const b = this.read8();
    const c = this.read8();
    return ((a << 16) | (b << 8) | c) >>> 0;
  }

  /** Big-endian u32. */
  read32be() {
    const a = this.read8();
    const b = this.read8();
    const c = this.read8();
    const d = this.read8();
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  /**
   * Read a fixed-length field of raw bytes, advancing the cursor. Returns a
   * COPY (subarray would alias the source buffer).
   * @param {number} n
   * @returns {Uint8Array}
   */
  readBytes(n) {
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /**
   * Read a fixed-width, zero-padded / space-padded ASCII field (MOD/XM/IT/S3M
   * sample & instrument names, magic tags). Stops the returned string at the
   * first NUL but always advances the cursor by exactly `n` bytes — matching how
   * mmutil reads name[] fields into fixed char arrays. Trailing whitespace is
   * trimmed (XM names are space-padded, IT/S3M are NUL-padded).
   * @param {number} n field width in bytes
   * @returns {string}
   */
  readFixedString(n) {
    const bytes = this.readBytes(n);
    let end = bytes.length;
    // stop at first NUL (C string semantics inside the fixed field)
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        end = i;
        break;
      }
    }
    let s = '';
    for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s.replace(/[ \t]+$/, '');
  }

  /**
   * Read a fixed-width ASCII tag/magic WITHOUT trimming or NUL-stopping — exact
   * bytes as chars. Use for 4-char signatures ('IMPM', 'SCRM', 'M.K.', etc.).
   * @param {number} n
   * @returns {string}
   */
  readTag(n) {
    const bytes = this.readBytes(n);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /** mmutil skip8(count): advance the read cursor by `count` bytes (SEEK_CUR). */
  skip8(count) {
    this.pos += count;
    return this;
  }

  /** mmutil file_seek_read(offset, SEEK_SET). */
  seek(offset) {
    this.pos = offset;
    return this;
  }

  /** mmutil file_tell_read(). */
  tell() {
    return this.pos;
  }

  /** mmutil file_tell_size(): total length of the input. */
  fileSize() {
    return this.buf.length;
  }

  /** True if the cursor is at or past EOF. */
  eof() {
    return this.pos >= this.buf.length;
  }
}

// ---------------------------------------------------------------------------
// simple.c — bit reader + extension classifier + sample length/format helpers.
// ---------------------------------------------------------------------------

/**
 * simple.c readbits(): little-endian bit extraction from a byte buffer.
 *   result |= ((buffer[(pos+i)>>3] >> ((pos+i)&7)) & 1) << i;
 * Used by the IT compressed-sample decoder.
 * @param {Uint8Array} buffer
 * @param {number} pos starting bit position
 * @param {number} size number of bits to read (<=32)
 * @returns {number} unsigned result
 */
export function readbits(buffer, pos, size) {
  let result = 0;
  for (let i = 0; i < size; i++) {
    const bytePos = (pos + i) >> 3;
    const bitPos = (pos + i) & 7;
    result |= ((buffer[bytePos] >> bitPos) & 1) << i;
  }
  return result >>> 0;
}

/**
 * simple.c get_ext(): classify a filename by its (lowercased) extension.
 * The C packed up to the last 4 chars into a 32-bit int and switch'd on multichar
 * constants ('mod','s3m',...). We just lowercase the actual extension string,
 * which is behaviourally identical for the real extensions.
 * @param {string} filename
 * @returns {number} one of INPUT_TYPE_*
 */
export function get_ext(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return INPUT_TYPE_UNK;
  const ext = filename.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'mod':
      return INPUT_TYPE_MOD;
    case 's3m':
      return INPUT_TYPE_S3M;
    case 'txt':
      return INPUT_TYPE_TXT;
    case 'wav':
      return INPUT_TYPE_WAV;
    case 'msl':
      return INPUT_TYPE_MSL;
    case 'xm':
      return INPUT_TYPE_XM;
    case 'it':
      return INPUT_TYPE_IT;
    case 'h':
      return INPUT_TYPE_H;
    default:
      return INPUT_TYPE_UNK;
  }
}

/**
 * simple.c calc_samplen_ex2(): loop_type==0 → sample_length, else loop_end.
 * @param {{loop_type:number, sample_length:number, loop_end:number}} s
 */
export function calc_samplen_ex2(s) {
  if (s.loop_type === 0) return s.sample_length >>> 0;
  return s.loop_end >>> 0;
}

/**
 * simple.c calc_samplooplen(): loop length in samples.
 *   type 1 → loop_end-loop_start
 *   type 2 → (loop_end-loop_start)*2   (bidi/ping-pong unrolled)
 *   else   → 0xFFFFFFFF                (no loop)
 * @param {{loop_type:number, loop_start:number, loop_end:number}} s
 */
export function calc_samplooplen(s) {
  if (s.loop_type === 1) return (s.loop_end - s.loop_start) >>> 0;
  if (s.loop_type === 2) return ((s.loop_end - s.loop_start) * 2) >>> 0;
  return 0xffffffff;
}

/**
 * simple.c calc_samplen(): total playback length including unrolled bidi loop.
 *   type 1 → loop_end
 *   type 2 → (loop_end-loop_start)+loop_end
 *   else   → sample_length
 * @param {{loop_type:number, loop_start:number, loop_end:number, sample_length:number}} s
 */
export function calc_samplen(s) {
  if (s.loop_type === 1) return s.loop_end >>> 0;
  if (s.loop_type === 2) return ((s.loop_end - s.loop_start) + s.loop_end) >>> 0;
  return s.sample_length >>> 0;
}

/**
 * simple.c sample_dsformat(): NDS sample format nibble. Included for parity but
 * GBA always uses U8 (handled in Write_SampleData). Faithful to the C, including
 * the "3 // error" fallthrough for the unsigned-16-bit case.
 * @param {{format:number}} samp
 */
export function sample_dsformat(samp) {
  if (samp.format & SAMPF_COMP) return 2;
  if (samp.format & SAMPF_SIGNED) {
    return samp.format & SAMPF_16BIT ? 1 : 0;
  }
  // unsigned: U8 → 3; U16 → 3 (marked "error" in the C)
  return 3;
}

/**
 * simple.c sample_dsreptype(): 1 if looped, else 2.
 * @param {{loop_type:number}} samp
 */
export function sample_dsreptype(samp) {
  return samp.loop_type ? 1 : 2;
}

/** simple.c clamp_s8(): clamp into [-128,127]. */
export function clamp_s8(value) {
  if (value < -128) value = -128;
  if (value > 127) value = 127;
  return value;
}

/** simple.c clamp_u8(): clamp into [0,255]. */
export function clamp_u8(value) {
  if (value < 0) value = 0;
  if (value > 255) value = 255;
  return value;
}

// ---------------------------------------------------------------------------
// Shared in-memory module model (mas.h structs → plain JS objects).
//
// These factory functions define the COMMON shape every loader (mod/xm/it/s3m)
// must produce and the single mas-emitter consumes. Field names mirror mas.h
// exactly so the emitter can read them 1:1. Defaults match a zero-initialised C
// struct (calloc), except where mmutil's loaders always overwrite the field.
// ---------------------------------------------------------------------------

/**
 * mas.h tInstrument_Envelope.
 * @returns {{loop_start:number, loop_end:number, sus_start:number, sus_end:number,
 *   node_count:number, node_x:number[], node_y:number[], env_filter:boolean,
 *   env_valid:boolean, env_enabled:boolean}}
 */
export function makeEnvelope() {
  return {
    loop_start: 0,
    loop_end: 0,
    sus_start: 0,
    sus_end: 0,
    node_count: 0,
    node_x: new Array(25).fill(0),
    node_y: new Array(25).fill(0),
    env_filter: false,
    env_valid: false,
    env_enabled: false,
  };
}

/**
 * mas.h tInstrument. notemap[y] u16 = (sample_index << 8) | note.
 * @returns {object}
 */
export function makeInstrument() {
  return {
    parapointer: 0,
    global_volume: 0,
    setpan: 0,
    fadeout: 0,
    random_volume: 0,
    nna: 0,
    dct: 0,
    dca: 0,
    env_flags: 0,
    notemap: new Array(120).fill(0),
    name: '',
    envelope_volume: makeEnvelope(),
    envelope_pan: makeEnvelope(),
    envelope_pitch: makeEnvelope(),
  };
}

/**
 * mas.h tSample. `data` is the PCM payload (Uint8Array). For GBA it must hold
 * UNSIGNED 8-bit samples by the time Write_SampleData runs (signed→unsigned is
 * byte ^ 0x80, done upstream in the loader / FixSample).
 * @returns {object}
 */
export function makeSample() {
  return {
    parapointer: 0,
    global_volume: 0,
    default_volume: 0,
    default_panning: 0,
    sample_length: 0,
    loop_start: 0,
    loop_end: 0,
    loop_type: 0,
    frequency: 0,
    /** @type {Uint8Array|null} */
    data: null,
    vibtype: 0,
    vibdepth: 0,
    vibspeed: 0,
    vibrate: 0,
    msl_index: 0xffff, // 0xFFFF = not yet pooled into a soundbank
    rsamp_index: 0,
    format: 0,
    datapointer: 0,
    it_compression: 0,
    name: '',
    filename: '', // filename[0]=='#' marks an SFX sample
  };
}

/**
 * mas.h tPatternEntry. Empty-cell sentinel: note==250, inst==0, vol==emptyvol,
 * fx==0, param==0. Note values 251..255 are note-off/cut/etc. and DO get emitted.
 * @returns {{note:number, inst:number, vol:number, fx:number, param:number}}
 */
export function makePatternEntry() {
  return { note: 250, inst: 0, vol: 0, fx: 0, param: 0 };
}

/**
 * mas.h tPattern. data is a flat row-major array of MAX_CHANNELS*nrows entries
 * (index = row*MAX_CHANNELS + col). cmarks[row] marks run-length reset rows.
 * @param {number} nrows
 * @returns {object}
 */
export function makePattern(nrows = 64) {
  const data = new Array(MAX_CHANNELS * nrows);
  for (let i = 0; i < data.length; i++) data[i] = makePatternEntry();
  return {
    parapointer: 0,
    nrows,
    clength: 0,
    data,
    cmarks: new Array(256).fill(false),
  };
}

/**
 * mas.h tMAS_Module. The unified module model. Arrays of instruments/samples/
 * patterns (the C used pointers + counts; we use JS arrays + the *_count fields,
 * keeping both so the emitter reads counts exactly as mas.c does).
 * @returns {object}
 */
export function makeModule() {
  return {
    title: '',
    order_count: 0,
    inst_count: 0,
    samp_count: 0,
    patt_count: 0,
    restart_pos: 0,
    stereo: false,
    inst_mode: false,
    freq_mode: 0,
    old_effects: false,
    link_gxx: false,
    xm_mode: false,
    old_mode: false,
    global_volume: 0,
    initial_speed: 0,
    initial_tempo: 0,
    channel_volume: new Array(MAX_CHANNELS).fill(0),
    channel_panning: new Array(MAX_CHANNELS).fill(0),
    orders: new Array(256).fill(0),
    /** @type {object[]} */
    instruments: [],
    /** @type {object[]} */
    samples: [],
    /** @type {object[]} */
    patterns: [],
  };
}

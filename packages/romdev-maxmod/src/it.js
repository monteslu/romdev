/****************************************************************************
 * romdev-maxmod — it.js
 *
 * Faithful pure-JS ESM port of mmutil's it.c (Impulse Tracker .IT loader).
 *
 * Parses an Impulse Tracker module into the shared in-memory module model
 * consumed by the MAS emitter. The model shape MUST match mod.js / xm.js /
 * s3m.js so a single mas-emitter can serialize any of them. This shape
 * mirrors the C structs in mas.h (MAS_Module / Instrument /
 * Instrument_Envelope / Sample / Pattern / PatternEntry).
 *
 * Source of truth: mmutil/source/it.c  (Mukunda Johnson, maxmod).
 * Endianness throughout: LITTLE-ENDIAN (matches read8/read16/read32).
 *
 * No TypeScript. Operates on Uint8Array. Field order, endianness and edge
 * cases match the C exactly; subtle points are quoted from the C inline.
 ****************************************************************************/

// ---- constants (defs.h / mas.h / it.c) ----------------------------------

const MAX_CHANNELS = 32; // defs.h

const SAMPF_16BIT = 0x001; // mas.h
const SAMPF_SIGNED = 0x002; // mas.h
const SAMPF_COMP = 0x004; // mas.h

// errors.h — exact values (internal only; never serialized)
const ERR_NONE = 0x00;
const ERR_INVALID_MODULE = 0x01;
const ERR_MANYCHANNELS = 0x05;
const ERR_UNKNOWNSAMPLE = 0x06;

/**
 * @typedef {Object} InstrumentEnvelope
 * @property {number} loop_start
 * @property {number} loop_end
 * @property {number} sus_start
 * @property {number} sus_end
 * @property {number} node_count
 * @property {Uint16Array} node_x  length 25 (u16 each)
 * @property {Uint8Array}  node_y  length 25 (u8 each)
 * @property {boolean} env_filter
 * @property {boolean} env_valid
 * @property {boolean} env_enabled
 */

/**
 * @typedef {Object} Instrument
 * @property {number} parapointer  (filled in by the emitter)
 * @property {number} global_volume
 * @property {number} setpan
 * @property {number} fadeout       (u16)
 * @property {number} random_volume
 * @property {number} nna
 * @property {number} dct
 * @property {number} dca
 * @property {number} env_flags
 * @property {Uint16Array} notemap  length 120; entry = (sample_index<<8)|note
 * @property {string} name
 * @property {InstrumentEnvelope} envelope_volume
 * @property {InstrumentEnvelope} envelope_pan
 * @property {InstrumentEnvelope} envelope_pitch
 */

/**
 * @typedef {Object} Sample
 * @property {number} parapointer
 * @property {number} global_volume
 * @property {number} default_volume
 * @property {number} default_panning
 * @property {number} sample_length
 * @property {number} loop_start
 * @property {number} loop_end
 * @property {number} loop_type      0=none,1=forward,2=bidi
 * @property {number} frequency      c5spd
 * @property {(Uint8Array|Uint16Array|null)} data  decoded PCM (unsigned, centered)
 * @property {number} vibtype
 * @property {number} vibdepth
 * @property {number} vibspeed
 * @property {number} vibrate
 * @property {number} msl_index      0xFFFF until assigned by the soundbank
 * @property {number} rsamp_index
 * @property {number} format         SAMPF_* flags
 * @property {number} datapointer    file offset of sample data
 * @property {number} it_compression 1 if IT214 compressed
 * @property {string} name
 * @property {string} filename       12-char DOS name (filename[0]=='#' => sfx)
 */

/**
 * @typedef {Object} PatternEntry
 * @property {number} note   250 = "no note" sentinel; 251..255 special
 * @property {number} inst
 * @property {number} vol    255 = "no vol" (IT) sentinel
 * @property {number} fx
 * @property {number} param
 */

/**
 * @typedef {Object} Pattern
 * @property {number} parapointer
 * @property {number} nrows
 * @property {number} clength
 * @property {PatternEntry[]} data   length MAX_CHANNELS*nrows (row-major: row*32+col)
 * @property {boolean[]} cmarks      length nrows (compression marks; set by emitter)
 */

/**
 * @typedef {Object} ModuleModel  (mirrors MAS_Module)
 * @property {string} title
 * @property {number} order_count
 * @property {number} inst_count
 * @property {number} samp_count
 * @property {number} patt_count
 * @property {number} restart_pos
 * @property {boolean} stereo
 * @property {boolean} inst_mode
 * @property {number}  freq_mode
 * @property {boolean} old_effects
 * @property {boolean} link_gxx
 * @property {boolean} xm_mode
 * @property {boolean} old_mode
 * @property {number} global_volume
 * @property {number} initial_speed
 * @property {number} initial_tempo
 * @property {Uint8Array} channel_volume   length MAX_CHANNELS
 * @property {Uint8Array} channel_panning  length MAX_CHANNELS
 * @property {Uint8Array} orders           length 256
 * @property {Instrument[]} instruments
 * @property {Sample[]} samples
 * @property {Pattern[]} patterns
 */

/**
 * Sequential little-endian reader matching files.c read8/read16/read32/skip8
 * plus file_seek_read (SEEK_SET only is used by it.c). EOF reads return 0,
 * matching fread-into-zeroed-buffer behaviour closely enough for valid files.
 */
class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  /** @returns {number} u8 */
  read8() {
    const p = this.pos++;
    return p < this.b.length ? this.b[p] : 0;
  }
  /** @returns {number} u16 LE */
  read16() {
    const lo = this.read8();
    const hi = this.read8();
    return (lo | (hi << 8)) & 0xffff;
  }
  /** @returns {number} u32 LE (returned as unsigned via >>>0) */
  read32() {
    const b0 = this.read8();
    const b1 = this.read8();
    const b2 = this.read8();
    const b3 = this.read8();
    return ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0);
  }
  /** @param {number} count */
  skip8(count) {
    this.pos += count;
  }
  /** file_seek_read(offset, SEEK_SET) */
  seek(offset) {
    this.pos = offset;
  }
}

/**
 * readbits — LSB-first bit reader over a byte buffer (simple.c).
 *   result |= ( (buffer[byte_pos] >> bit_pos) & 1 ) << i;
 * @param {Uint8Array} buffer
 * @param {number} pos  bit position
 * @param {number} size number of bits
 * @returns {number} unsigned
 */
function readbits(buffer, pos, size) {
  let result = 0;
  for (let i = 0; i < size; i++) {
    const bytePos = (pos + i) >> 3;
    const bitPos = (pos + i) & 7;
    const byte = bytePos < buffer.length ? buffer[bytePos] : 0;
    result |= ((byte >> bitPos) & 1) << i;
  }
  return result >>> 0;
}

/**
 * Read a fixed-length C char array, advancing the cursor by exactly `len`
 * bytes, and return it as a string terminated at the FIRST NUL byte (matching
 * C `char[]` + `%s` / strcmp semantics: bytes after the first NUL are dead).
 * Always consumes the full field so subsequent reads stay aligned.
 */
function readString(reader, len) {
  let s = '';
  let terminated = false;
  for (let i = 0; i < len; i++) {
    const c = reader.read8();
    if (c === 0) terminated = true; // C string ends here
    if (!terminated && c !== 0) s += String.fromCharCode(c);
  }
  return s;
}

/** allocate an empty envelope (matches memset(env,0,...) + array fields). */
function newEnvelope() {
  return {
    loop_start: 0,
    loop_end: 0,
    sus_start: 0,
    sus_end: 0,
    node_count: 0,
    node_x: new Uint16Array(25),
    node_y: new Uint8Array(25),
    env_filter: false,
    env_valid: false,
    env_enabled: false,
  };
}

/** allocate an empty instrument (matches memset(inst,0,...)). */
function newInstrument() {
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
    notemap: new Uint16Array(120),
    name: '',
    envelope_volume: newEnvelope(),
    envelope_pan: newEnvelope(),
    envelope_pitch: newEnvelope(),
  };
}

/** allocate an empty sample (matches memset(samp,0,...); msl_index=0xFFFF). */
function newSample() {
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
    data: null,
    vibtype: 0,
    vibdepth: 0,
    vibspeed: 0,
    vibrate: 0,
    msl_index: 0xffff,
    rsamp_index: 0,
    format: 0,
    datapointer: 0,
    it_compression: 0,
    name: '',
    filename: '',
  };
}

/** allocate an empty pattern entry. */
function newPatternEntry() {
  return { note: 0, inst: 0, vol: 0, fx: 0, param: 0 };
}

// =========================================================================
//  Load_IT_Envelope (it.c)
// =========================================================================

/**
 * Load_IT_Envelope — reads one envelope block (82 bytes total).
 * @param {Reader} r
 * @param {InstrumentEnvelope} env  (already zeroed)
 * @param {boolean} unsign  add +32 to each node_y unless filter-mode flips it off
 * @returns {boolean} env_enabled
 */
function Load_IT_Envelope(r, env, unsign) {
  let env_loop = false;
  let env_sus = false;
  let env_enabled = false;
  let env_filter = false;

  // env already memset to 0 by caller (newEnvelope)
  const a = r.read8();

  if (a & 1) env_enabled = true;
  if (!(a & 2)) {
    env.loop_start = 255;
    env.loop_end = 255;
  } else {
    env_loop = true;
  }
  if (!(a & 4)) {
    env.sus_start = 255;
    env.sus_end = 255;
  } else {
    env_sus = true;
  }

  if (a & 128) {
    unsign = false;
    env_filter = true;
    env.env_filter = env_filter;
  }

  const node_count = r.read8();
  if (node_count !== 0) env.env_valid = true;

  env.node_count = node_count;
  if (env_loop) {
    env.loop_start = r.read8();
    env.loop_end = r.read8();
  } else {
    r.skip8(2);
  }
  if (env_sus) {
    env.sus_start = r.read8();
    env.sus_end = r.read8();
  } else {
    r.skip8(2);
  }
  for (let x = 0; x < 25; x++) {
    // node_y is u8: the +32 can push to 0..287 in C (u8 wraps); store wrapped.
    let ny = r.read8();
    if (unsign) ny += 32;
    env.node_y[x] = ny & 0xff;
    env.node_x[x] = r.read16();
  }
  r.read8(); // unused byte
  env.env_enabled = env_enabled;
  return env_enabled;
}

// =========================================================================
//  Load_IT_Instrument (it.c)  — IT2.xx instrument (547 bytes)
// =========================================================================

/**
 * @param {Reader} r
 * @param {Instrument} inst (already zeroed)
 */
function Load_IT_Instrument(r, inst) {
  // inst already memset (newInstrument)
  r.skip8(17);
  inst.nna = r.read8();
  inst.dct = r.read8();
  inst.dca = r.read8();
  let a = r.read16();
  if (a > 255) a = 255;
  inst.fadeout = a & 0xff; // (u8)a
  r.skip8(2);
  inst.global_volume = r.read8();
  a = r.read8();
  // a = (a&128) | ((a&127)*2 > 127 ? 127 : (a&127)*2);
  a = (a & 128) | (((a & 127) * 2 > 127) ? 127 : (a & 127) * 2);
  inst.setpan = (a ^ 128) & 0xff;
  inst.random_volume = r.read8();
  r.skip8(5);
  inst.name = readString(r, 26);
  r.skip8(6);

  for (let x = 0; x < 120; x++) inst.notemap[x] = r.read16();

  inst.env_flags = 0;

  Load_IT_Envelope(r, inst.envelope_volume, false);
  inst.env_flags |= inst.envelope_volume.env_valid ? 1 : 0;
  inst.env_flags |= inst.envelope_volume.env_enabled ? 8 : 0;

  Load_IT_Envelope(r, inst.envelope_pan, true);
  inst.env_flags |= inst.envelope_pan.env_enabled ? 2 : 0;

  Load_IT_Envelope(r, inst.envelope_pitch, true);
  inst.env_flags |= inst.envelope_pitch.env_enabled ? 4 : 0;

  r.skip8(7);
  return ERR_NONE;
}

/**
 * Create_IT_Instrument — synthesize an instrument template that maps every
 * note to a single sample (used in sample-mode IT files).
 * @param {Instrument} inst (already zeroed)
 * @param {number} sample  1-based sample number
 */
function Create_IT_Instrument(inst, sample) {
  inst.global_volume = 128;
  for (let x = 0; x < 120; x++) inst.notemap[x] = (x + sample * 256) & 0xffff;
}

// =========================================================================
//  Load_IT_Sample (it.c)  — sample header
// =========================================================================

/**
 * @param {Reader} r
 * @param {Sample} samp (already zeroed, msl_index=0xFFFF)
 * @returns {number} ERR_*
 */
function Load_IT_Sample(r, samp) {
  let samp_unsigned = false;

  // 'SPMI' little-endian magic = bytes 'I','M','P','S'
  if (r.read32() !== fourcc('I', 'M', 'P', 'S')) return ERR_UNKNOWNSAMPLE;

  samp.filename = readString(r, 12); // 12-char dos filename
  if (r.read8() !== 0) return ERR_UNKNOWNSAMPLE;
  samp.global_volume = r.read8();
  const a = r.read8();
  samp.it_compression = a & 8 ? 1 : 0;
  const bit16 = (a & 2) !== 0;
  const hasloop = (a & 16) !== 0;
  const pingpong = (a & 64) !== 0;
  samp.default_volume = r.read8();
  samp.name = readString(r, 26);
  const cvt = r.read8(); // 'a' in C: convert flags
  samp.default_panning = r.read8();
  // default_panning = (((dp&127)==64) ? 127 : (dp<<1)) | (dp&128);
  samp.default_panning =
    ((((samp.default_panning & 127) === 64)
      ? 127
      : (samp.default_panning << 1)) | (samp.default_panning & 128)) & 0xff;
  if (!(cvt & 1)) samp_unsigned = true;

  const samp_length = r.read32();
  const loop_start = r.read32();
  const loop_end = r.read32();
  const c5spd = r.read32();

  samp.frequency = c5spd;
  samp.sample_length = samp_length;
  samp.loop_start = loop_start;
  samp.loop_end = loop_end;

  r.skip8(8); // susloop start/end
  const data_address = r.read32();
  samp.vibspeed = r.read8();
  samp.vibdepth = r.read8();
  samp.vibrate = r.read8();
  samp.vibtype = r.read8();
  samp.datapointer = data_address;

  if (hasloop) {
    samp.loop_type = pingpong ? 2 : 1;
    samp.loop_start = loop_start;
    samp.loop_end = loop_end;
  } else {
    samp.loop_type = 0;
  }
  samp.format =
    (bit16 ? SAMPF_16BIT : 0) | (samp_unsigned ? 0 : SAMPF_SIGNED);
  if (samp.sample_length === 0) samp.loop_type = 0;
  return ERR_NONE;
}

// =========================================================================
//  Load_IT_SampleData (it.c)  — decode PCM into samp.data (unsigned/centered)
// =========================================================================

/**
 * @param {Reader} r
 * @param {Sample} samp
 * @param {number} cmwt  "compatible with" tracker version word (for it215)
 */
function Load_IT_SampleData(r, samp, cmwt) {
  if (samp.sample_length === 0) return ERR_NONE;

  if (samp.format & SAMPF_16BIT) {
    samp.data = new Uint16Array(samp.sample_length);
  } else {
    samp.data = new Uint8Array(samp.sample_length);
  }

  if (!samp.it_compression) {
    for (let x = 0; x < samp.sample_length; x++) {
      if (samp.format & SAMPF_16BIT) {
        let a;
        if (!(samp.format & SAMPF_SIGNED)) {
          a = r.read16(); // unsigned short
        } else {
          a = (r.read16() << 16) >> 16; // (signed short)
          a += 32768;
        }
        samp.data[x] = a & 0xffff;
      } else {
        let a;
        if (!(samp.format & SAMPF_SIGNED)) {
          a = r.read8(); // unsigned char
        } else {
          a = (r.read8() << 24) >> 24; // (signed char)
          a += 128;
        }
        samp.data[x] = a & 0xff;
      }
    }
  } else {
    Load_IT_Sample_CMP(
      r,
      samp.data,
      samp.sample_length,
      cmwt,
      (samp.format & SAMPF_16BIT) !== 0
    );
  }
  // FixSample(samp) is performed by the (separately ported) samplefix module
  // at the caller. it.c calls it here; we expose the hook in parseIt().
  return ERR_NONE;
}

// =========================================================================
//  IT214 sample decompressor (it.c)
//  Based on Chibitracker / xmp / openCP. Be exact here.
// =========================================================================

/**
 * Load_IT_CompressedSampleBlock — read a 16-bit length-prefixed block.
 * Allocates size+4 with 4 trailing zero bytes (so readbits past end => 0).
 * @param {Reader} r
 * @returns {Uint8Array}
 */
function Load_IT_CompressedSampleBlock(r) {
  const size = r.read16();
  const buffer = new Uint8Array(size + 4); // last 4 bytes already 0
  for (let x = 0; x < size; x++) buffer[x] = r.read8();
  return buffer;
}

/**
 * Load_IT_Sample_CMP — decompress IT214 audio into p_dest_buffer.
 * @param {Reader} r
 * @param {(Uint8Array|Uint16Array)} p_dest_buffer
 * @param {number} samp_len  total samples to produce
 * @param {number} cmwt
 * @param {boolean} bit16
 * @returns {number} ERR_*
 */
function Load_IT_Sample_CMP(r, p_dest_buffer, samp_len, cmwt, bit16) {
  // integrator buffers — C uses s16 d1,d2 (16-bit) and s8 d18,d28 (8-bit).
  let d1 = 0;
  let d2 = 0; // s16
  let d18 = 0;
  let d28 = 0; // s8

  const nbits = bit16 ? 16 : 8;
  const dsize = bit16 ? 4 : 3;

  // for (i=0;i<samp_len;i++) p_dest_buffer[i]=128;
  // NOTE: in C p_dest_buffer is u8* even for 16-bit, so this fills the FIRST
  // samp_len BYTES with 128, not samp_len 16-bit elements. For 16-bit it only
  // touches the low half. Since the decompressor overwrites every produced
  // element via the dest write pointers below, this prefill is cosmetic; we
  // replicate the visible effect on the typed view.
  if (bit16) {
    // fill first samp_len bytes (= first samp_len/2 u16 low/high) with 128.
    // Decompressor overwrites all produced elements, so just zero/128-init.
    for (let i = 0; i < samp_len; i++) p_dest_buffer[i] = 128 | (128 << 8);
  } else {
    for (let i = 0; i < samp_len; i++) p_dest_buffer[i] = 128;
  }

  const it215 = cmwt === 0x215;

  let writePos = 0; // index into p_dest_buffer (dest8_write / dest16_write)
  let remaining = samp_len;

  // now unpack data till the dest buffer is full
  while (remaining > 0) {
    // read a new block of compressed data and reset variables
    const c_buffer = Load_IT_CompressedSampleBlock(r);
    let bit_readpos = 0;
    let block_length;
    if (bit16) {
      block_length = remaining < 0x4000 ? remaining : 0x4000;
    } else {
      block_length = remaining < 0x8000 ? remaining : 0x8000;
    }
    let block_position = 0;
    let bit_width = nbits + 1; // start with width of 9 bits (or 17)
    d1 = 0;
    d2 = 0;
    d18 = 0;
    d28 = 0; // reset integrator buffers

    // now uncompress the data block
    while (block_position < block_length) {
      let aux_value = readbits(c_buffer, bit_readpos, bit_width); // read bits
      bit_readpos += bit_width;

      if (bit_width < 7) {
        // method 1 (1-6 bits)
        if (bit16) {
          // if ( (signed)aux_value == (1 << (bit_width - 1)) )
          if ((aux_value | 0) === (1 << (bit_width - 1))) {
            // check for "100..."
            aux_value = readbits(c_buffer, bit_readpos, dsize) + 1;
            bit_readpos += dsize;
            bit_width =
              aux_value < bit_width ? aux_value : aux_value + 1; // and expand
            continue; // ... next value
          }
        } else {
          // if ( aux_value == ((u32)1 << ((u32)bit_width - 1)) )
          if (aux_value === ((1 << (bit_width - 1)) >>> 0)) {
            aux_value = readbits(c_buffer, bit_readpos, dsize) + 1;
            bit_readpos += dsize;
            bit_width =
              aux_value < bit_width ? aux_value : aux_value + 1;
            continue;
          }
        }
      } else if (bit_width < nbits + 1) {
        // method 2 (7-8 bits, or 15-16 for 16-bit)
        if (bit16) {
          // border = (0xFFFF >> ((nbits+1) - bit_width)) - (nbits/2);
          const border =
            (0xffff >>> ((nbits + 1) - bit_width)) - (nbits >> 1);
          // if ( (int)aux_value > (int)border && (int)aux_value <= (border+nbits) )
          if (
            (aux_value | 0) > (border | 0) &&
            (aux_value | 0) <= ((border + nbits) | 0)
          ) {
            aux_value -= border; // convert width to 1-8
            bit_width =
              aux_value < bit_width ? aux_value : aux_value + 1;
            continue;
          }
        } else {
          // border = (0xFF >> ((nbits+1) - bit_width)) - (nbits/2);
          const border =
            (0xff >>> ((nbits + 1) - bit_width)) - (nbits >> 1);
          if (aux_value > border && aux_value <= border + nbits) {
            aux_value -= border;
            bit_width =
              aux_value < bit_width ? aux_value : aux_value + 1;
            continue;
          }
        }
      } else if (bit_width === nbits + 1) {
        // method 3 (9 bits, or 17 for 16-bit)
        if (aux_value & (1 << nbits)) {
          // bit 8 (or 16) set?
          bit_width = (aux_value + 1) & 0xff; // new width...
          continue; // ... and next value
        }
      } else {
        // illegal width, abort
        return ERR_UNKNOWNSAMPLE;
      }

      // now expand value to signed byte/word
      let v8 = 0;
      let v16 = 0;
      if (bit_width < nbits) {
        const tmp_shift = nbits - bit_width;
        if (bit16) {
          // v16=(aux_value << tmp_shift); v16>>=tmp_shift;  (arithmetic, s16)
          v16 = (aux_value << tmp_shift) & 0xffff;
          v16 = (v16 << 16) >> 16; // to signed 16
          v16 = v16 >> tmp_shift; // arithmetic right shift
        } else {
          // v8=(aux_value << tmp_shift); v8>>=tmp_shift;  (arithmetic, s8)
          v8 = (aux_value << tmp_shift) & 0xff;
          v8 = (v8 << 24) >> 24; // to signed 8
          v8 = v8 >> tmp_shift; // arithmetic right shift
        }
      } else {
        if (bit16) {
          v16 = (aux_value << 16) >> 16; // (s16)aux_value
        } else {
          v8 = (aux_value << 24) >> 24; // (s8)aux_value
        }
      }

      if (bit16) {
        // integrate upon the sample values
        d1 = (d1 + v16) & 0xffff;
        d1 = (d1 << 16) >> 16; // keep s16
        d2 = (d2 + d1) & 0xffff;
        d2 = (d2 << 16) >> 16; // keep s16
        // *(dest16_write++) = (it215 ? d2+32768 : d1+32768);
        p_dest_buffer[writePos++] =
          ((it215 ? d2 + 32768 : d1 + 32768) & 0xffff);
      } else {
        // integrate upon the sample values (s8 wraparound)
        d18 = (d18 + v8) & 0xff;
        d18 = (d18 << 24) >> 24; // keep s8
        d28 = (d28 + d18) & 0xff;
        d28 = (d28 << 24) >> 24; // keep s8
        // *(dest8_write)++ = (it215 ? (int)d28+128 : (int)d18+128);
        p_dest_buffer[writePos++] =
          ((it215 ? d28 + 128 : d18 + 128) & 0xff);
      }
      block_position++;
    }

    // now subtract block length from total length and go on
    remaining -= block_length;
  }
  return ERR_NONE;
}

// =========================================================================
//  Patterns (it.c)
// =========================================================================

/**
 * Empty_IT_Pattern — 64-row blank pattern (note=250, vol=255 sentinels).
 * @param {Pattern} patt
 */
function Empty_IT_Pattern(patt) {
  patt.parapointer = 0;
  patt.clength = 0;
  patt.nrows = 64;
  patt.data = new Array(patt.nrows * MAX_CHANNELS);
  for (let x = 0; x < patt.nrows * MAX_CHANNELS; x++) {
    const e = newPatternEntry();
    e.note = 250; // special clears for vol&note
    e.vol = 255;
    patt.data[x] = e;
  }
  patt.cmarks = new Array(patt.nrows).fill(false);
  return ERR_NONE;
}

/**
 * Load_IT_Pattern — decompress an IT pattern into PatternEntry[].
 * @param {Reader} r
 * @param {Pattern} patt
 * @returns {number} ERR_*
 */
function Load_IT_Pattern(r, patt) {
  const old_maskvar = new Uint8Array(MAX_CHANNELS);
  const old_note = new Uint8Array(MAX_CHANNELS);
  const old_inst = new Uint8Array(MAX_CHANNELS);
  const old_vol = new Uint8Array(MAX_CHANNELS);
  const old_fx = new Uint8Array(MAX_CHANNELS);
  const old_param = new Uint8Array(MAX_CHANNELS);

  const clength = r.read16();
  patt.nrows = r.read16();
  r.skip8(4);

  patt.clength = clength;

  patt.data = new Array(patt.nrows * MAX_CHANNELS);
  for (let x = 0; x < patt.nrows * MAX_CHANNELS; x++) {
    const e = newPatternEntry();
    e.note = 250; // special clears for vol&note
    e.vol = 255;
    patt.data[x] = e;
  }
  patt.cmarks = new Array(patt.nrows).fill(false);

  // DECOMPRESS IT PATTERN
  for (let x = 0; x < patt.nrows; x++) {
    // emulate the GetNextChannelMarker goto loop
    for (;;) {
      const chanvar = r.read8(); // Read byte into channelvariable.
      if (chanvar === 0) break; // end of row

      const chan = (chanvar - 1) & 63; // Channel = (channelvariable-1) & 63
      if (chan >= MAX_CHANNELS) return ERR_MANYCHANNELS;

      if (chanvar & 128) old_maskvar[chan] = r.read8(); // read mask byte

      const maskvar = old_maskvar[chan];
      const base = x * MAX_CHANNELS + chan;

      if (maskvar & 1) {
        // read note (byte value)
        old_note[chan] = r.read8();
        patt.data[base].note = old_note[chan];
      }
      if (maskvar & 2) {
        // read instrument (byte value)
        old_inst[chan] = r.read8();
        patt.data[base].inst = old_inst[chan];
      }
      if (maskvar & 4) {
        // read volume/panning (byte value)
        old_vol[chan] = r.read8();
        patt.data[base].vol = old_vol[chan];
      }
      if (maskvar & 8) {
        // read command + commandvalue
        old_fx[chan] = r.read8();
        patt.data[base].fx = old_fx[chan];
        old_param[chan] = r.read8();
        patt.data[base].param = old_param[chan];
      }
      if (maskvar & 16) patt.data[base].note = old_note[chan]; // note=lastnote
      if (maskvar & 32) patt.data[base].inst = old_inst[chan]; // inst=lastinst
      if (maskvar & 64) patt.data[base].vol = old_vol[chan]; // vol=lastvol
      if (maskvar & 128) {
        patt.data[base].fx = old_fx[chan]; // command = lastcommand
        patt.data[base].param = old_param[chan]; // commandvalue = lastcmdvalue
      }
      // goto GetNextChannelMarker;
    }
  }
  return ERR_NONE;
}

// =========================================================================
//  Load_IT (it.c)  — top-level
// =========================================================================

/**
 * @param {Uint8Array} bytes
 * @param {{fixSample?: (samp: Sample)=>void}} [opts]
 *   fixSample: the (separately ported) samplefix hook. it.c calls FixSample()
 *   inside Load_IT_SampleData right after decoding each sample. We invoke it
 *   here at the same point if provided, so the model matches post-FixSample
 *   state used by the emitter. If omitted, samples are left raw (pre-FixSample).
 * @returns {ModuleModel}
 */
export function parseIt(bytes, opts = {}) {
  const r = new Reader(bytes);
  const fixSample = typeof opts.fixSample === 'function' ? opts.fixSample : null;

  /** @type {ModuleModel} */
  const itm = {
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
    channel_volume: new Uint8Array(MAX_CHANNELS),
    channel_panning: new Uint8Array(MAX_CHANNELS),
    orders: new Uint8Array(256),
    instruments: [],
    samples: [],
    patterns: [],
  };

  // 'IMPM' little-endian magic = read32() == 'MPMI'  (C char-literal byte order)
  if (r.read32() !== fourcc('I', 'M', 'P', 'M')) {
    const e = new Error('ERR_INVALID_MODULE: not an Impulse Tracker module');
    e.code = ERR_INVALID_MODULE;
    throw e;
  }

  itm.title = readString(r, 28);
  itm.order_count = r.read16() & 0xffff;
  itm.inst_count = r.read16() & 0xff; // (u8)read16()
  itm.samp_count = r.read16() & 0xff;
  itm.patt_count = r.read16() & 0xff;
  /* cwt  = */ r.read16();
  const cmwt = r.read16(); // upward compatible ("compatible with" version)
  const w = r.read16(); // flags
  itm.stereo = (w & 1) !== 0;
  const instr_mode = (w & 4) !== 0;
  itm.inst_mode = instr_mode;
  itm.freq_mode = w & 8; // NB: C stores the raw masked bit (0 or 8)
  itm.old_effects = (w & 16) !== 0;
  itm.link_gxx = (w & 32) !== 0;
  r.skip8(2); // special
  itm.global_volume = r.read8();
  r.skip8(1); // mix volume
  itm.initial_speed = r.read8();
  itm.initial_tempo = r.read8();

  r.skip8(12); // SEP, PWD, MSGLENGTH, MESSAGE OFFSET, [RESERVED]

  // channel panning: 64 bytes; first MAX_CHANNELS mapped 0->64 to 0->255
  for (let x = 0; x < 64; x++) {
    const b = r.read8();
    if (x < MAX_CHANNELS) itm.channel_panning[x] = b * 4 > 255 ? 255 : b * 4;
  }
  // channel volume: 64 bytes; first MAX_CHANNELS stored verbatim
  for (let x = 0; x < 64; x++) {
    const b = r.read8();
    if (x < MAX_CHANNELS) itm.channel_volume[x] = b;
  }

  for (let x = 0; x < itm.order_count; x++) itm.orders[x] = r.read8();

  const parap_inst = new Uint32Array(itm.inst_count);
  const parap_samp = new Uint32Array(itm.samp_count);
  const parap_patt = new Uint32Array(itm.patt_count);

  for (let x = 0; x < itm.inst_count; x++) parap_inst[x] = r.read32();
  for (let x = 0; x < itm.samp_count; x++) parap_samp[x] = r.read32();
  for (let x = 0; x < itm.patt_count; x++) parap_patt[x] = r.read32();

  itm.samples = new Array(itm.samp_count);
  itm.patterns = new Array(itm.patt_count);

  if (instr_mode) {
    itm.instruments = new Array(itm.inst_count);
    for (let x = 0; x < itm.inst_count; x++) {
      r.seek(parap_inst[x]);
      const inst = newInstrument();
      Load_IT_Instrument(r, inst);
      itm.instruments[x] = inst;
    }
  }

  // read samples
  for (let x = 0; x < itm.samp_count; x++) {
    r.seek(parap_samp[x]);
    const samp = newSample();
    Load_IT_Sample(r, samp);
    itm.samples[x] = samp;
  }

  if (!instr_mode) {
    // Adding Instrument Templates: one instrument per sample.
    itm.inst_count = itm.samp_count;
    itm.instruments = new Array(itm.inst_count);
    for (let x = 0; x < itm.samp_count; x++) {
      const inst = newInstrument();
      Create_IT_Instrument(inst, x + 1);
      itm.instruments[x] = inst;
    }
  }

  // read patterns
  for (let x = 0; x < itm.patt_count; x++) {
    const patt = {
      parapointer: 0,
      nrows: 0,
      clength: 0,
      data: [],
      cmarks: [],
    };
    if (parap_patt[x] !== 0) {
      r.seek(parap_patt[x]);
      Load_IT_Pattern(r, patt);
    } else {
      // C does file_seek_read(0,SEEK_SET) then Empty_IT_Pattern (no read).
      Empty_IT_Pattern(patt);
    }
    itm.patterns[x] = patt;
  }

  // read sample data
  for (let x = 0; x < itm.samp_count; x++) {
    r.seek(itm.samples[x].datapointer);
    Load_IT_SampleData(r, itm.samples[x], cmwt);
    // FixSample(samp) is called here in it.c (inside Load_IT_SampleData).
    if (fixSample) fixSample(itm.samples[x]);
  }

  return itm;
}

/**
 * fourcc — pack 4 ASCII chars into the u32 that read32() (little-endian)
 * produces for a 4-byte tag laid out as c0,c1,c2,c3 in the file.
 *
 * In the C, the magic compares against a multi-char constant like 'MPMI'.
 * On the little-endian build targets, 'MPMI' == ('I'<<24)|('M'<<16)|('P'<<8)|'M'
 * which equals read32() of the bytes 'I','M','P','M' (file order I M P M).
 * So fourcc(byte0,byte1,byte2,byte3) returns the read32() value for those
 * file bytes in order.
 * @param {string} c0 @param {string} c1 @param {string} c2 @param {string} c3
 * @returns {number}
 */
function fourcc(c0, c1, c2, c3) {
  return (
    (c0.charCodeAt(0) |
      (c1.charCodeAt(0) << 8) |
      (c2.charCodeAt(0) << 16) |
      (c3.charCodeAt(0) << 24)) >>>
    0
  );
}

export default parseIt;

export {
  MAX_CHANNELS,
  SAMPF_16BIT,
  SAMPF_SIGNED,
  SAMPF_COMP,
  readbits,
  Load_IT_Sample_CMP,
};

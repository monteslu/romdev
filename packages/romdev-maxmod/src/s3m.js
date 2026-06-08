/****************************************************************************
 * romdev-maxmod — s3m.js
 *
 * Faithful pure-JS ESM port of mmutil's s3m.c (Load_S3M / Load_S3M_Sample /
 * Load_S3M_Pattern / Load_S3M_SampleData).
 *
 * Parses a ScreamTracker 3 .S3M into the shared in-memory module model that
 * every parser (mod/xm/it/s3m) produces and that the single mas-emitter
 * consumes. Field names mirror the C structs in mas.h exactly (snake_case),
 * so the emitter is parser-agnostic.
 *
 * Original C: Copyright (c) 2008, Mukunda Johnson (mukunda@maxmod.org) — see
 * mmutil license. This is a line-for-line behavioural port.
 *
 * Endianness: little-endian throughout (matches files.c read16/read32, which
 * compose bytes low-first).
 ****************************************************************************/

// ---------------------------------------------------------------------------
// Constants (defs.h / mas.h / errors.h)
// ---------------------------------------------------------------------------

/** MAX_CHANNELS (defs.h) */
const MAX_CHANNELS = 32;

/** Sample format flags (mas.h) */
const SAMPF_16BIT = 0x001;
// const SAMPF_SIGNED = 0x002; // unused by the S3M loader
// const SAMPF_COMP = 0x004;   // unused by the S3M loader
const SAMP_FORMAT_U8 = 0;            // (0)
const SAMP_FORMAT_U16 = SAMPF_16BIT; // (SAMPF_16BIT)

// errors.h — only the codes referenced by s3m.c. We throw with these names.
const ERR_INVALID_MODULE = 'ERR_INVALID_MODULE';
const ERR_UNKNOWNSAMPLE = 'ERR_UNKNOWNSAMPLE';

/**
 * PANNING_SEP — main.c initialises this to 128 and only overrides it via the
 * `-p<n>` CLI flag. With no CLI flag the default is 128, so we hard-code 128
 * here (the value the soundbank path always uses).
 *   main.c: PANNING_SEP = 128;
 */
const PANNING_SEP = 128;

/**
 * S3M_NOTE(a) = (((a&15)+(a>>4)*12)+12)   (s3m.c #define)
 * Converts a raw S3M packed note byte (octave<<4 | semitone) into the
 * loader's internal 0-based+12 note numbering.
 * @param {number} a raw note byte
 * @returns {number}
 */
function S3M_NOTE(a) {
  return (((a & 15) + (a >> 4) * 12) + 12) & 0xff;
}

/**
 * clamp_u8(value) (simple.c): clamp to [0,255].
 * @param {number} value
 * @returns {number}
 */
function clamp_u8(value) {
  if (value < 0) value = 0;
  if (value > 255) value = 255;
  return value;
}

// ---------------------------------------------------------------------------
// Byte reader — mirrors files.c (fin + read8/read16/read24/read32/skip8/seek).
// Reads past EOF yield 0 (fread leaves the byte unwritten in C; we choose a
// deterministic 0 — well-formed S3Ms never read past EOF on the hot path).
// ---------------------------------------------------------------------------

class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    /** @type {Uint8Array} */
    this.bytes = bytes;
    /** @type {number} current read cursor (== ftell(fin)) */
    this.pos = 0;
  }

  /** read8(): one byte. @returns {number} 0..255 */
  read8() {
    if (this.pos >= this.bytes.length) {
      this.pos++;
      return 0;
    }
    return this.bytes[this.pos++];
  }

  /**
   * read16(): a = read8(); a |= read8()<<8;  (LE)
   * @returns {number}
   */
  read16() {
    let a = this.read8();
    a |= this.read8() << 8;
    return a & 0xffff;
  }

  /**
   * read32(): a = read16(); a |= read16()<<16;  (LE)
   * Returned unsigned (>>>0).
   * @returns {number}
   */
  read32() {
    let a = this.read16();
    a |= this.read16() << 16;
    return a >>> 0;
  }

  /** skip8(count): fseek(fin, count, SEEK_CUR). @param {number} count */
  skip8(count) {
    this.pos += count;
  }

  /**
   * file_seek_read(offset, SEEK_SET): absolute seek.
   * @param {number} offset
   */
  seekSet(offset) {
    this.pos = offset;
  }
}

// ---------------------------------------------------------------------------
// Model factories — keep the same object shape the other parsers emit so a
// single mas-emitter consumes any of them. Mirrors the C structs (mas.h);
// every numeric field is pre-zeroed exactly like memset(...,0,sizeof(...)).
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Instrument_Envelope mirrors mas.h tInstrument_Envelope
 * @property {number} loop_start
 * @property {number} loop_end
 * @property {number} sus_start
 * @property {number} sus_end
 * @property {number} node_count
 * @property {number[]} node_x length 25
 * @property {number[]} node_y length 25
 * @property {boolean} env_filter
 * @property {boolean} env_valid
 * @property {boolean} env_enabled
 */

/** @returns {Instrument_Envelope} */
function newEnvelope() {
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
 * @typedef {Object} Instrument mirrors mas.h tInstrument
 * @property {number} parapointer
 * @property {number} global_volume
 * @property {number} setpan
 * @property {number} fadeout
 * @property {number} random_volume
 * @property {number} nna
 * @property {number} dct
 * @property {number} dca
 * @property {number} env_flags
 * @property {number[]} notemap length 120, each u16 = (sample_index<<8)|note
 * @property {string} name
 * @property {Instrument_Envelope} envelope_volume
 * @property {Instrument_Envelope} envelope_pan
 * @property {Instrument_Envelope} envelope_pitch
 */

/** @returns {Instrument} */
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
    notemap: new Array(120).fill(0),
    name: '',
    envelope_volume: newEnvelope(),
    envelope_pan: newEnvelope(),
    envelope_pitch: newEnvelope(),
  };
}

/**
 * @typedef {Object} Sample mirrors mas.h tSample
 * @property {number} parapointer
 * @property {number} global_volume
 * @property {number} default_volume
 * @property {number} default_panning
 * @property {number} sample_length in sample frames
 * @property {number} loop_start
 * @property {number} loop_end
 * @property {number} loop_type 0=none, 1=forward (BIDI never appears in S3M)
 * @property {number} frequency middle-C frequency in Hz
 * @property {Uint8Array|Uint16Array|null} data raw PCM (unsigned)
 * @property {number} vibtype
 * @property {number} vibdepth
 * @property {number} vibspeed
 * @property {number} vibrate
 * @property {number} msl_index 0xFFFF until assigned in the soundbank pass
 * @property {number} rsamp_index
 * @property {number} format SAMP_FORMAT_* bitfield
 * @property {number} datapointer absolute byte offset of PCM in the file
 * @property {number} it_compression
 * @property {string} name 28-char S3M sample name
 * @property {number[]} filename 12 bytes (DOS filename)
 */

/** @returns {Sample} */
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
    msl_index: 0,
    rsamp_index: 0,
    format: 0,
    datapointer: 0,
    it_compression: 0,
    name: '',
    // filename[12] — kept as a byte array; FixSample's name-flag logic uses
    // filename[0]=='#' downstream (sfx flag in msl.c).
    filename: new Array(12).fill(0),
  };
}

/**
 * @typedef {Object} PatternEntry mirrors mas.h tPatternEntry (all u8)
 * @property {number} note
 * @property {number} inst
 * @property {number} vol
 * @property {number} fx
 * @property {number} param
 */

/**
 * @typedef {Object} Pattern mirrors mas.h tPattern
 * @property {number} parapointer
 * @property {number} nrows
 * @property {number} clength packed length read from file
 * @property {PatternEntry[]} data length MAX_CHANNELS*256, indexed row*32+col
 * @property {boolean[]} cmarks length 256
 */

/** @returns {PatternEntry} */
function newPatternEntry() {
  return { note: 0, inst: 0, vol: 0, fx: 0, param: 0 };
}

/**
 * @typedef {Object} MAS_Module mirrors mas.h tMAS_Module
 * @property {string} title
 * @property {number} order_count
 * @property {number} inst_count
 * @property {number} samp_count
 * @property {number} patt_count
 * @property {number} restart_pos
 * @property {boolean} stereo
 * @property {boolean} inst_mode
 * @property {number} freq_mode
 * @property {boolean} old_effects
 * @property {boolean} link_gxx
 * @property {boolean} xm_mode
 * @property {boolean} old_mode
 * @property {number} global_volume
 * @property {number} initial_speed
 * @property {number} initial_tempo
 * @property {number[]} channel_volume length MAX_CHANNELS
 * @property {number[]} channel_panning length MAX_CHANNELS
 * @property {number[]} orders length 256
 * @property {Instrument[]} instruments
 * @property {Sample[]} samples
 * @property {Pattern[]} patterns
 */

/** @returns {MAS_Module} memset(mod,0,sizeof) equivalent */
function newModule() {
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
    instruments: [],
    samples: [],
    patterns: [],
  };
}

// ---------------------------------------------------------------------------
// Load_S3M_Sample (s3m.c) — reads ONE sample header at the current cursor.
// Returns ERR_* string on failure (caller raises), else null on success.
// ---------------------------------------------------------------------------

/**
 * @param {Reader} r
 * @param {Sample} samp pre-newSample()'d (== memset 0)
 * @returns {string|null} error code or null
 */
function Load_S3M_Sample(r, samp) {
  // memset( samp, 0, sizeof(Sample) ) already done by newSample().
  samp.msl_index = 0xffff;

  if (r.read8() === 1) {
    // type, 1 = sample
    for (let x = 0; x < 12; x++) samp.filename[x] = r.read8();

    // datapointer = (read8()*65536 + read16()) * 16;  //read24();
    // NOTE: the high byte is read FIRST (read8 << 16-ish), then the low 16
    // bits via read16 (LE). The *16 converts the 24-bit "parapointer" value
    // (in paragraphs) to a byte offset. This is NOT a plain read24().
    samp.datapointer = (r.read8() * 65536 + r.read16()) * 16;

    samp.sample_length = r.read32();
    samp.loop_start = r.read32();
    samp.loop_end = r.read32();
    samp.default_volume = r.read8();
    samp.global_volume = 64;
    r.read8(); // reserved
    if (r.read8() !== 0) return ERR_UNKNOWNSAMPLE; // packing, 0 = unpacked

    const flags = r.read8();
    samp.loop_type = flags & 1 ? 1 : 0;
    if (flags & 2) return ERR_UNKNOWNSAMPLE; // stereo unsupported
    // samp->bit16 = flags&4
    samp.format = flags & 4 ? SAMP_FORMAT_U16 : SAMP_FORMAT_U8;

    samp.frequency = r.read32();
    r.read32(); // reserved
    r.skip8(8); // internal variables

    let name = '';
    for (let x = 0; x < 28; x++) {
      const c = r.read8();
      if (c !== 0) name += String.fromCharCode(c);
    }
    samp.name = name;

    // if( read32() != 'SRCS' ) — file bytes are 'S','C','R','S'; read32 LE
    // yields 0x53524353, and gcc's 'SRCS' multichar constant == 0x53524353.
    if (r.read32() !== 0x53524353) return ERR_UNKNOWNSAMPLE;
  }
  // else: empty sample slot — leave samp zeroed (no SCRS check, no data).

  return null;
}

// ---------------------------------------------------------------------------
// Load_S3M_Pattern (s3m.c) — unpacks one 64-row pattern at the current cursor.
// ---------------------------------------------------------------------------

/**
 * @param {Reader} r
 * @returns {Pattern}
 */
function Load_S3M_Pattern(r) {
  const clength = r.read16();

  // memset( patt, 0, sizeof(Pattern) )
  /** @type {Pattern} */
  const patt = {
    parapointer: 0,
    nrows: 64,
    clength,
    data: new Array(64 * MAX_CHANNELS),
    cmarks: new Array(256).fill(false),
  };
  for (let i = 0; i < patt.data.length; i++) patt.data[i] = newPatternEntry();

  // for( row = 0; row < 64*MAX_CHANNELS; row++ ) { note=250; vol=255; }
  for (let row = 0; row < 64 * MAX_CHANNELS; row++) {
    patt.data[row].note = 250;
    patt.data[row].vol = 255;
  }

  for (let row = 0; row < 64; row++) {
    let what;
    // while( (what = read8()) != 0 )   // 0 = end of row
    while ((what = r.read8()) !== 0) {
      const col = what & 31; // &31 = channel
      const z = row * MAX_CHANNELS + col;
      const e = patt.data[z];

      if (what & 32) {
        // &32 = follows; BYTE:note, BYTE:instrument
        let note = r.read8();
        if (note === 255) {
          note = 250;
        } else if (note === 254) {
          note = 254;
        } else {
          note = S3M_NOTE(note);
        }
        e.note = note;
        e.inst = r.read8();
      }

      if (what & 64) {
        // &64 = follows; BYTE:volume
        e.vol = r.read8();
      }

      if (what & 128) {
        // &128 = follows; BYTE:command, BYTE:info
        e.fx = r.read8();
        e.param = r.read8();
        if (e.fx === 3) {
          // convert pattern break (Dxx) to decimal: hi*10 + lo
          e.param = (e.param & 0xf) + ((e.param / 16) | 0) * 10;
        }
        if (e.fx === 'X'.charCodeAt(0) - 64) {
          // 'X'-64 = 24 (Xxx set panning): multiply volume scale by 2
          e.param = (e.param * 2) & 0xff;
        }
        if (e.fx === 'V'.charCodeAt(0) - 64) {
          // 'V'-64 = 22 (Vxx global volume): multiply volume scale by 2
          e.param = (e.param * 2) & 0xff;
        }
      }

      // if( patt->data[z].fx == 255 ) { fx = 0; param = 0; }
      // NOTE: this check is OUTSIDE the `what & 128` block in the C, so it
      // also fires for cells whose fx was never assigned this iteration —
      // but those keep fx==0 (memset), so it's effectively a no-op there.
      if (e.fx === 255) {
        e.fx = 0;
        e.param = 0;
      }
    }
  }

  return patt;
}

// ---------------------------------------------------------------------------
// Load_S3M_SampleData (s3m.c) — reads raw PCM for one sample at the current
// cursor. ffi (file format info) selects signed (1) vs unsigned (2) source.
// Converts to UNSIGNED storage, then defers final fixup to FixSample (the
// samplefix.js port, applied by the caller / soundbank pass — NOT here, to
// match the C where FixSample is the last call).
// ---------------------------------------------------------------------------

/**
 * @param {Reader} r
 * @param {Sample} samp
 * @param {number} ffi 1 = signed source, 2 = unsigned source
 * @param {(samp: Sample) => void} [fixSample] optional FixSample hook
 * @returns {string|null} error or null
 */
function Load_S3M_SampleData(r, samp, ffi, fixSample) {
  if (samp.sample_length === 0) return null; // ERR_NONE

  const bit16 = (samp.format & SAMPF_16BIT) !== 0;
  const out = bit16
    ? new Uint16Array(samp.sample_length)
    : new Uint8Array(samp.sample_length);

  if (ffi === 1) {
    // signed samples [VERY OLD] — bias into unsigned
    for (let x = 0; x < samp.sample_length; x++) {
      if (bit16) {
        let a = r.read16();
        a += 32768; // (u16) wraps
        out[x] = a & 0xffff;
      } else {
        let a = r.read8();
        a += 128; // (u8) wraps
        out[x] = a & 0xff;
      }
    }
  } else if (ffi === 2) {
    // unsigned samples — stored verbatim
    for (let x = 0; x < samp.sample_length; x++) {
      out[x] = bit16 ? r.read16() : r.read8();
    }
  } else {
    return ERR_UNKNOWNSAMPLE;
  }

  samp.data = out;

  // FixSample( samp ) — clamps loops + GBA/NDS-specific fixups. Lives in
  // samplefix.js. We invoke it via the hook when provided so behaviour
  // matches the C (FixSample is the final step of Load_S3M_SampleData).
  if (fixSample) fixSample(samp);

  return null;
}

// ---------------------------------------------------------------------------
// Load_S3M (s3m.c) — top-level. Parses the whole .S3M into a MAS_Module.
// ---------------------------------------------------------------------------

/**
 * @param {Reader} r
 * @param {(samp: Sample) => void} [fixSample] optional FixSample hook
 * @returns {MAS_Module}
 */
function Load_S3M(r, fixSample) {
  const mod = newModule();

  // read song name (28 bytes)
  let title = '';
  for (let x = 0; x < 28; x++) {
    const c = r.read8();
    if (c !== 0) title += String.fromCharCode(c);
  }
  mod.title = title;

  // if( read8() != 0x1A );   // <-- C has a stray ';' so this is a NO-OP;
  //                          // the byte is consumed but never validated.
  r.read8();

  if (r.read8() !== 16) return raise(ERR_INVALID_MODULE); // type, must be 16

  r.skip8(2); // reserved space
  mod.order_count = r.read16() & 0xff; // (u8)read16()
  mod.inst_count = r.read16() & 0xff; // (u8)read16()
  mod.samp_count = mod.inst_count; // S3M: one sample per instrument
  mod.patt_count = r.read16() & 0xff; // (u8)read16()

  for (let x = 0; x < 32; x++) mod.channel_volume[x] = 64;

  mod.freq_mode = 0; // amiga frequencies
  mod.old_effects = true; // old effects (maybe not?)
  mod.link_gxx = false; // dont link gxx memory
  mod.restart_pos = 0; // restart from beginning
  mod.old_mode = true;

  const s3m_flags = r.read16(); // eslint-disable-line no-unused-vars
  const cwt = r.read16(); // eslint-disable-line no-unused-vars
  const ffi = r.read16(); // file format info: 1=signed, 2=unsigned PCM

  // if( read32() != 'MRCS' )  — file bytes 'S','C','R','M'; read32 LE yields
  // 0x4D524353, and gcc's 'MRCS' multichar == 0x4D524353.
  if (r.read32() !== 0x4d524353) return raise(ERR_INVALID_MODULE);

  mod.global_volume = (r.read8() * 2) & 0xff;
  mod.initial_speed = r.read8();
  mod.initial_tempo = r.read8();
  const stereo = (r.read8() >> 7) & 1; // master volume top bit = stereo
  r.read8(); // ultra click removal
  const dp = r.read8(); // default pan positions flag (252 = present)
  r.skip8(8 + 2); // reserved space + special pointer

  /** @type {boolean[]} */
  const chan_enabled = new Array(32).fill(false);
  for (let x = 0; x < 32; x++) {
    const chn = r.read8();
    chan_enabled[x] = (chn >> 7) !== 0;
    if (stereo) {
      if ((chn & 127) < 8) {
        // left channel
        mod.channel_panning[x] = clamp_u8(128 - ((PANNING_SEP / 2) | 0));
      } else {
        // right channel
        mod.channel_panning[x] = clamp_u8(128 + ((PANNING_SEP / 2) | 0));
      }
    } else {
      mod.channel_panning[x] = 128;
    }
  }

  for (let x = 0; x < mod.order_count; x++) {
    mod.orders[x] = r.read8();
  }

  // parapointers (in paragraphs; *16 to get byte offsets)
  /** @type {number[]} */
  const parap_inst = new Array(mod.inst_count);
  /** @type {number[]} */
  const parap_patt = new Array(mod.patt_count);
  for (let x = 0; x < mod.inst_count; x++) parap_inst[x] = r.read16();
  for (let x = 0; x < mod.patt_count; x++) parap_patt[x] = r.read16();

  if (dp === 252) {
    // explicit default-pan table follows
    for (let x = 0; x < 32; x++) {
      const a = r.read8();
      if (a & 32) {
        // (a&15)*16, clamped to 255
        mod.channel_panning[x] = (a & 15) * 16 > 255 ? 255 : (a & 15) * 16;
      } else {
        // C body is entirely commented out — keep previously-set panning.
      }
    }
  } else {
    for (let x = 0; x < 32; x++) {
      if (stereo) {
        mod.channel_panning[x] =
          x & 1
            ? clamp_u8(128 - ((PANNING_SEP / 2) | 0))
            : clamp_u8(128 + ((PANNING_SEP / 2) | 0));
      } else {
        mod.channel_panning[x] = 128;
      }
    }
  }

  // allocate model arrays
  mod.instruments = new Array(mod.inst_count);
  mod.samples = new Array(mod.samp_count);
  mod.patterns = new Array(mod.patt_count);

  // load instruments (each S3M sample becomes one single-sample instrument)
  for (let x = 0; x < mod.inst_count; x++) {
    const inst = newInstrument(); // memset 0
    inst.global_volume = 128;
    // make notemap: notemap[y] = y | ((x+1) << 8)
    for (let y = 0; y < 120; y++) inst.notemap[y] = (y | ((x + 1) << 8)) & 0xffff;
    mod.instruments[x] = inst;

    // load sample header at parap_inst[x]*16
    const samp = newSample();
    r.seekSet(parap_inst[x] * 16);
    const err = Load_S3M_Sample(r, samp);
    if (err) return raise(ERR_UNKNOWNSAMPLE);
    mod.samples[x] = samp;
  }

  // load patterns
  for (let x = 0; x < mod.patt_count; x++) {
    r.seekSet(parap_patt[x] * 16);
    mod.patterns[x] = Load_S3M_Pattern(r);
  }

  // load sample data
  for (let x = 0; x < mod.samp_count; x++) {
    r.seekSet(mod.samples[x].datapointer);
    Load_S3M_SampleData(r, mod.samples[x], ffi & 0xff, fixSample);
  }

  return mod;
}

/**
 * @param {string} code
 * @returns {never}
 */
function raise(code) {
  throw new Error(code);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a ScreamTracker 3 .S3M into the shared module model.
 *
 * @param {Uint8Array} bytes raw .S3M file bytes
 * @param {Object} [options]
 * @param {(samp: Sample) => void} [options.fixSample] FixSample hook applied
 *   to each sample after its PCM is read (defaults to no-op; the soundbank
 *   pass supplies the real samplefix.js implementation). Passing it here
 *   matches the C, where FixSample is the final step of sample loading.
 * @returns {MAS_Module} module model consumable by the shared mas-emitter
 */
export function parseS3m(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('parseS3m expects a Uint8Array');
  }
  const r = new Reader(bytes);
  return Load_S3M(r, options.fixSample);
}

export default parseS3m;

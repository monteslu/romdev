/****************************************************************************
 * romdev-maxmod — mod.js
 *
 * Faithful pure-JS ESM port of devkitPro mmutil's mod.c
 * (Copyright (c) 2008, Mukunda Johnson — ISC license).
 *
 * Parses a ProTracker / FastTracker .MOD into the in-memory module model
 * that the MAS emitter (mas.js, ported from mas.c) consumes. The model
 * shape is shared across mod/xm/it/s3m so a single emitter can serialize
 * any of them.
 *
 * Operates on a Uint8Array. Little-endian throughout (matches mmutil's
 * read8/read16/read32 byte stream helpers in files.c).
 *
 * NOTE on scope: mod.c's Load_MOD_SampleData() calls FixSample() after
 * loading PCM. FixSample lives in samplefix.c (a separate translation
 * unit) — loop trimming, BIDI unroll, GBA min-loop padding, 8-bit
 * conversion. That is ported separately (samplefix.js) and applied by the
 * pipeline, NOT here. What THIS file replicates from mod.c is exactly what
 * mod.c itself does inline: the +128 unsign of the raw signed-8-bit PCM
 * (Load_MOD_SampleData), and all header/pattern parsing.
 ****************************************************************************/

/**
 * @typedef {Object} InstrumentEnvelope
 * @property {number} loop_start
 * @property {number} loop_end
 * @property {number} sus_start
 * @property {number} sus_end
 * @property {number} node_count
 * @property {number[]} node_x  length 25
 * @property {number[]} node_y  length 25
 * @property {boolean} env_filter
 * @property {boolean} env_valid
 * @property {boolean} env_enabled
 */

/**
 * @typedef {Object} Instrument
 * @property {number} global_volume
 * @property {number} setpan
 * @property {number} fadeout
 * @property {number} random_volume
 * @property {number} nna
 * @property {number} dct
 * @property {number} dca
 * @property {number} env_flags
 * @property {number[]} notemap  length 120, each entry = note | ((sample)<<8)
 * @property {string}  name
 * @property {InstrumentEnvelope} envelope_volume
 * @property {InstrumentEnvelope} envelope_pan
 * @property {InstrumentEnvelope} envelope_pitch
 */

/**
 * @typedef {Object} Sample
 * @property {number} global_volume
 * @property {number} default_volume
 * @property {number} default_panning
 * @property {number} sample_length   in sample-frames (bytes for U8)
 * @property {number} loop_start
 * @property {number} loop_end
 * @property {number} loop_type       0=none, 1=forward, 2=bidi
 * @property {number} frequency       middle-C frequency in Hz
 * @property {Uint8Array|null} data   PCM, unsigned-8-bit after +128 unsign
 * @property {number} vibtype
 * @property {number} vibdepth
 * @property {number} vibspeed
 * @property {number} vibrate
 * @property {number} msl_index       0xFFFF until assigned by the soundbank
 * @property {number} rsamp_index
 * @property {number} format
 * @property {number} it_compression
 * @property {string} name
 * @property {string} filename
 */

/**
 * @typedef {Object} PatternEntry
 * @property {number} note   250 = no note; 251..255 special (off/cut); else value
 * @property {number} inst
 * @property {number} vol
 * @property {number} fx
 * @property {number} param
 */

/**
 * @typedef {Object} Pattern
 * @property {number} nrows
 * @property {PatternEntry[]} data  length MAX_CHANNELS*nrows (row*32 + col)
 */

/**
 * @typedef {Object} MASModule
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
 * @property {number[]} channel_volume   length MAX_CHANNELS
 * @property {number[]} channel_panning  length MAX_CHANNELS
 * @property {number[]} orders           length 256
 * @property {Instrument[]} instruments
 * @property {Sample[]} samples
 * @property {Pattern[]} patterns
 */

// ---- constants (defs.h / deftypes.h / errors.h) -------------------------

const MAX_CHANNELS = 32; // defs.h
// PANNING_SEP defaults to 128 (main.c: PANNING_SEP = 128;). The -p option
// can override it, but the default soundbank path uses 128.
const PANNING_SEP = 128;

// 'cho' macro = 64 (xm.c). Used by CONV_XM_EFFECT to map ASCII effect
// letters to internal effect numbers: e.g. 'F'-cho = 70-64 = 6.
const cho = 64;

// errors.h codes (only the ones mod.c can raise). Carried so the pipeline
// can distinguish failure modes; we throw ModError with these.
export const ERR_NONE = 0;
export const ERR_INVALID_MODULE = 'ERR_INVALID_MODULE';
export const ERR_MANYCHANNELS = 'ERR_MANYCHANNELS';

/** Error thrown by parseMod, carrying an mmutil-style error code. */
export class ModError extends Error {
  /** @param {string} code @param {string} [msg] */
  constructor(code, msg) {
    super(msg || code);
    this.name = 'ModError';
    this.code = code;
  }
}

// ---- little helpers -----------------------------------------------------

/** clamp_u8 (simple.c) */
function clamp_u8(value) {
  if (value < 0) value = 0;
  if (value > 255) value = 255;
  return value;
}

/**
 * Byte-stream reader mirroring mmutil's files.c read8/read16/read32 over the
 * current file (little-endian).
 */
class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  /** read8(): one unsigned byte; reading past EOF yields 0 (files.c returns 0 on EOF). */
  read8() {
    if (this.pos >= this.b.length) {
      this.pos++;
      return 0;
    }
    return this.b[this.pos++];
  }
  /** read32(): four bytes little-endian. */
  read32() {
    const a = this.read8();
    const b = this.read8();
    const c = this.read8();
    const d = this.read8();
    // unsigned 32-bit (>>> 0)
    return ((a | (b << 8) | (c << 16) | (d << 24)) >>> 0);
  }
  /** file_tell_read() */
  tell() {
    return this.pos;
  }
  /** file_seek_read(off, SEEK_SET) */
  seek(off) {
    this.pos = off;
  }
}

// ---- CONV_XM_EFFECT (xm.c) ---------------------------------------------
// MOD effects are remapped to the internal (IT/MAS) effect set via the same
// table XM uses. mod.c calls CONV_XM_EFFECT on every cell, so it is part of
// the MOD parse contract. Faithful 1:1 port of xm.c's switch.

/**
 * @param {number} fxIn    effect number (0..0xF for MOD)
 * @param {number} paramIn effect parameter byte
 * @returns {[number, number]} [fx, param] in internal representation
 */
export function convXmEffect(fxIn, paramIn) {
  let wfx = fxIn;
  let wpm = paramIn;

  switch (wfx) {
    case 0: // 0xy arpeggio
      if (wpm !== 0) wfx = 'J'.charCodeAt(0) - cho;
      else {
        wfx = 0;
        wpm = 0;
      }
      break;

    case 1: // 1xx porta up
      wfx = 'F'.charCodeAt(0) - cho;
      if (wpm >= 0xe0) wpm = 0xdf;
      break;

    case 2: // 2xx porta down
      wfx = 'E'.charCodeAt(0) - cho;
      if (wpm >= 0xe0) wpm = 0xdf;
      break;

    case 3: // 3xx porta to note
      wfx = 'G'.charCodeAt(0) - cho;
      break;

    case 4: // 4xy vibrato
      wfx = 'H'.charCodeAt(0) - cho;
      break;

    case 5: // 5xy volslide+glissando
      wfx = 'L'.charCodeAt(0) - cho;
      break;

    case 6: // 6xy volslide+vibrato
      wfx = 'K'.charCodeAt(0) - cho;
      break;

    case 7: // 7xy tremolo
      wfx = 'R'.charCodeAt(0) - cho;
      break;

    case 8: // 8xx set panning
      wfx = 'X'.charCodeAt(0) - cho;
      break;

    case 9: // 9xx set offset
      wfx = 'O'.charCodeAt(0) - cho;
      break;

    case 0xa: // Axy volume slide
      wfx = 'D'.charCodeAt(0) - cho;
      break;

    case 0xb: // Bxx position jump
      wfx = 'B'.charCodeAt(0) - cho;
      break;

    case 0xc: // Cxx set volume
      wfx = 27; // compatibility effect
      break;

    case 0xd: // Dxx pattern break
      wfx = 'C'.charCodeAt(0) - cho;
      // pattern-break param is BCD in MOD: high*10 + low
      wpm = (wpm & 0xf) + (wpm >> 4) * 10;
      break;

    case 0xe: // Exy extended
      switch (wpm >> 4) {
        case 1: // fine porta up
          wfx = 'F'.charCodeAt(0) - cho;
          wpm = 0xf0 | (wpm & 0xf);
          break;
        case 2: // fine porta down
          wfx = 'E'.charCodeAt(0) - cho;
          wpm = 0xf0 | (wpm & 0xf);
          break;
        case 3: // glissando control
        case 5: // set finetune  -- UNSUPPORTED
          wfx = 0;
          wpm = 0;
          break;
        case 4: // vibrato control
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0x30 | (wpm & 0xf);
          break;
        case 6: // pattern loop
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0xb0 | (wpm & 0xf);
          break;
        case 7: // tremolo control
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0x40 | (wpm & 0xf);
          break;
        case 8: // set panning
          wfx = 'X'.charCodeAt(0) - cho;
          wpm = (wpm & 0xf) * 16;
          break;
        case 9: // old retrig
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0x20 | (wpm & 0xf);
          break;
        case 10: // fine volslide up
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0x00 | (wpm & 0xf);
          break;
        case 11: // fine volslide down
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0x10 | (wpm & 0xf);
          break;
        case 12: // note cut
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0xc0 | (wpm & 0xf);
          break;
        case 13: // note delay
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0xd0 | (wpm & 0xf);
          break;
        case 14: // pattern delay
          wfx = 'S'.charCodeAt(0) - cho;
          wpm = 0xe0 | (wpm & 0xf);
          break;
        case 15: // event
          wfx = 'S'.charCodeAt(0) - cho;
          // wpm = wpm; (unchanged)
          break;
        case 0: // set filter -- UNSUPPORTED
          wfx = 0;
          wpm = 0;
          break;
      }
      break;

    case 0xf: // Fxx set speed
      if (wpm >= 32) wfx = 'T'.charCodeAt(0) - cho;
      else wfx = 'A'.charCodeAt(0) - cho;
      break;

    case 16: // Gxx set global volume
      wfx = 'V'.charCodeAt(0) - cho;
      break;

    case 17: // Hxx global volume slide
      wfx = 'W'.charCodeAt(0) - cho;
      break;

    case 18: // Ixx unused
    case 19: // Jxx unused
    case 22: // Mxx unused
    case 23: // Nxx unused
    case 24: // Oxx unused
    case 26: // Qxx unused
    case 28: // Sxx unused
    case 30: // Uxx unused
    case 31: // Vxx unused
    case 32: // Wxx unused
    case 34: // Yxx unused
    case 35: // Zxx unused
      wfx = 0;
      wpm = 0;
      break;

    case 20: // Kxx key off
      wfx = 28;
      break;

    case 21: // Lxx set envelope position
      wfx = 29;
      break;

    case 25: // Pxx panning slide
      wfx = 'P'.charCodeAt(0) - cho;
      break;

    case 27: // Rxx retrigger note
      wfx = 'Q'.charCodeAt(0) - cho;
      break;

    case 29: // Txx tremor
      wfx = 30;
      break;

    case 33: // Xxx extra fine slide
      if ((wpm >> 4) === 1) {
        wfx = 'F'.charCodeAt(0) - cho;
        wpm = 0xe0 | (wpm & 0xf);
      } else if ((wpm >> 4) === 2) {
        wfx = 'E'.charCodeAt(0) - cho;
        wpm = 0xe0 | (wpm & 0xf);
      } else {
        wfx = 0;
        wpm = 0;
      }
      break;
  }

  // mod.c stores these into u8 fields, so truncate to a byte.
  return [wfx & 0xff, wpm & 0xff];
}

// ---- model constructors -------------------------------------------------

/** @returns {InstrumentEnvelope} */
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
 * Create_MOD_Instrument (mod.c). memset 0, global_volume=128, notemap[y] =
 * y | ((sample+1)<<8) for y in 0..120.
 * @param {number} sample 0-based sample slot index
 * @returns {Instrument}
 */
function createModInstrument(sample) {
  const notemap = new Array(120);
  for (let x = 0; x < 120; x++) {
    // inst->notemap[x] = x | ((sample+1)<<8);
    notemap[x] = x | (((sample + 1) & 0xff) << 8);
  }
  return {
    global_volume: 128,
    setpan: 0,
    fadeout: 0,
    random_volume: 0,
    nna: 0,
    dct: 0,
    dca: 0,
    env_flags: 0,
    notemap,
    name: '',
    envelope_volume: newEnvelope(),
    envelope_pan: newEnvelope(),
    envelope_pitch: newEnvelope(),
  };
}

/** @returns {Sample} */
function newSample() {
  return {
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
    it_compression: 0,
    name: '',
    filename: '',
  };
}

// ---- sample header parse (Load_MOD_Sample) ------------------------------

/**
 * Load_MOD_Sample (mod.c). Reads the 30-byte sample header.
 * @param {Reader} r
 * @returns {Sample}
 */
function loadModSample(r) {
  const samp = newSample();
  samp.msl_index = 0xffff;

  // 22-byte sample name.
  let nameBytes = [];
  for (let x = 0; x < 22; x++) nameBytes.push(r.read8());
  samp.name = bytesToCString(nameBytes);

  // filename = first 12 bytes of name (mod.c copies 12 raw bytes).
  samp.filename = bytesToCString(nameBytes.slice(0, 12));

  // sample_length = word * 2 (big-endian word: hi*256 + lo).
  samp.sample_length = (r.read8() * 256 + r.read8()) * 2;

  // finetune: signed nibble, 8..15 wrap to negative.
  let finetune = r.read8();
  if (finetune >= 8) finetune -= 16;

  samp.default_volume = r.read8();
  samp.loop_start = (r.read8() * 256 + r.read8()) * 2;
  samp.loop_end = samp.loop_start + (r.read8() * 256 + r.read8()) * 2;

  // frequency = 8363 * 2^(finetune/192). mod.c casts to int (truncation).
  // "IS THIS WRONG?? :" — yes, mmutil keeps it as-is; we replicate exactly.
  samp.frequency = Math.trunc(8363.0 * Math.pow(2.0, finetune * (1.0 / 192.0)));

  samp.global_volume = 64; // max global volume

  // loop length <= 2 disables the loop.
  if (samp.loop_end - samp.loop_start <= 2) {
    samp.loop_type = 0;
    samp.loop_start = 0;
    samp.loop_end = 0;
  } else {
    samp.loop_type = 1;
  }

  return samp;
}

/**
 * Load_MOD_SampleData (mod.c). Reads sample_length bytes of signed-8-bit PCM
 * and unsigns them (+128), then runs FixSample (samplefix.js) — mod.c calls
 * FixSample(samp) unconditionally at the end of Load_MOD_SampleData (line 86),
 * even for zero-length samples (it clamps the loop bounds).
 * @param {Reader} r
 * @param {Sample} samp
 * @param {((samp:Sample)=>void)|null} [fixSample] optional FixSample hook
 */
function loadModSampleData(r, samp, fixSample) {
  if (samp.sample_length > 0) {
    const data = new Uint8Array(samp.sample_length);
    for (let t = 0; t < samp.sample_length; t++) {
      // ((u8*)samp->data)[t] = read8() + 128;  // unsign data
      data[t] = (r.read8() + 128) & 0xff;
    }
    samp.data = data;
  }
  // FixSample( samp ) — mod.c, unconditional. See parseMod options.fixSample.
  if (fixSample) fixSample(samp);
}

// ---- pattern parse (Load_MOD_Pattern) -----------------------------------

/** @returns {PatternEntry} */
function newPatternEntry() {
  return { note: 0, inst: 0, vol: 0, fx: 0, param: 0 };
}

/**
 * Load_MOD_Pattern (mod.c). 64 rows, nchannels columns of 4 bytes each.
 * Slots beyond nchannels (up to MAX_CHANNELS) keep note=250 (no-note).
 * @param {Reader} r
 * @param {number} nchannels
 * @param {{value:number}} instCountRef  mutated in place (u8* inst_count)
 * @returns {Pattern}
 */
function loadModPattern(r, nchannels, instCountRef) {
  // memset(patt,0); nrows=64; then every data[].note set to 250.
  const data = new Array(64 * MAX_CHANNELS);
  for (let i = 0; i < data.length; i++) {
    const e = newPatternEntry();
    e.note = 250; // "no note" sentinel
    data[i] = e;
  }

  for (let row = 0; row < 64; row++) {
    for (let col = 0; col < nchannels; col++) {
      const data1 = r.read8();
      const data2 = r.read8();
      const data3 = r.read8();
      const data4 = r.read8();
      // Layout: aaaaBBBB CCCCCCCC DDDDeeee FFFFFFFF
      //   BBBBCCCCCCCC = period, aaaaDDDD = sample, eeee = effect, FFFF.. = param
      const period = (data1 & 0xf) * 256 + data2;
      let inst = (data1 & 0xf0) + (data3 >> 4);
      let effect = data3 & 0xf;
      let param = data4;

      // fix parameter for certain MOD effects (5xy glis+slide, 6xy vib+slide):
      // if X nibble set, clear Y.
      switch (effect) {
        case 5:
        case 6:
          if (param & 0xf0) param &= 0xf0;
          break;
      }

      const p = data[row * MAX_CHANNELS + col];
      p.inst = inst & 0xff;
      // CONV_XM_EFFECT(&effect, &param)
      [effect, param] = convXmEffect(effect, param);
      p.fx = effect;
      p.param = param;

      if (period !== 0) {
        // 0 = no note; else amiga period -> note value.
        // p->note = round(12*log(856/period)/log2) + 37 + 11;
        p.note =
          Math.round((12.0 * Math.log(856.0 / period)) / Math.log(2)) + 37 + 11;
        p.note &= 0xff; // stored in a u8 field
      }

      // inst_count tracking, capped at 31.
      if (instCountRef.value < inst + 1) {
        instCountRef.value = inst + 1;
        if (instCountRef.value > 31) instCountRef.value = 31;
      }
    }
  }

  // The C Pattern struct (mas.h) is calloc'd: parapointer, clength, and the
  // cmarks[256] run-length-reset flags all start zero/false. The MAS serializer
  // (mas.js Mark_Patterns / Write_Pattern) reads cmarks[], so include the full
  // shape — matching util.js makePattern() and the other loaders (xm/s3m/it).
  return {
    parapointer: 0,
    nrows: 64,
    clength: 0,
    data,
    cmarks: new Array(256).fill(false),
  };
}

// ---- string helpers -----------------------------------------------------

/**
 * Convert a byte array (C char[] read raw) to a JS string, stopping at the
 * first NUL — mirrors how mmutil treats these as C strings for printf and
 * for filename[0]=='#' SFX detection downstream.
 * @param {number[]} bytes
 * @returns {string}
 */
function bytesToCString(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

// ---- main entry (Load_MOD) ----------------------------------------------

/**
 * Parse a ProTracker / FastTracker .MOD into the shared module model.
 * Faithful port of Load_MOD (mod.c).
 *
 * @param {Uint8Array} bytes raw .mod file contents
 * @param {Object} [options]
 * @param {(samp:Sample)=>void} [options.fixSample] optional FixSample hook
 *   (faithful to mod.c which calls FixSample(samp) per sample). Omit to keep
 *   raw (pre-FixSample) PCM.
 * @returns {MASModule}
 * @throws {ModError} ERR_INVALID_MODULE or ERR_MANYCHANNELS
 */
export function parseMod(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('parseMod expects a Uint8Array');
  }
  const fixSample = typeof options.fixSample === 'function' ? options.fixSample : null;
  const r = new Reader(bytes);

  const file_start = r.tell(); // 0

  // Seek to offset 0x438 (1080) and read the 4-byte signature.
  r.seek(0x438);
  const sig = r.read32();
  const s0 = sig & 0xff;
  const s1 = (sig >> 8) & 0xff;
  const s2 = (sig >> 16) & 0xff;
  const s3 = (sig >> 24) & 0xff;
  const sigStr = bytesToCString([s0, s1, s2, s3]);

  // mmutil compares `sig` (read little-endian) against multichar constants.
  // A multichar constant like 'M.K.' on the host compiler equals
  // ('M'<<24)|('.'<<16)|('K'<<8)|'.', and '.K.M' equals
  // ('.'<<24)|('K'<<16)|('.'<<8)|'M'. For "M.K." on disk (bytes M . K .),
  // read32 little-endian = ('.'<<24)|('K'<<16)|('.'<<8)|'M' = '.K.M', which
  // is why mod.c's case is '.K.M'. We compare the raw byte sequence (s0..s3)
  // directly, which is byte-order-robust and matches the on-disk ASCII.
  let mod_channels;
  const tag = sigStr; // s0..s3 as ASCII (the literal file bytes)

  // helper to compare against an on-disk ASCII tag.
  const is = (str) =>
    s0 === str.charCodeAt(0) &&
    s1 === str.charCodeAt(1) &&
    s2 === str.charCodeAt(2) &&
    s3 === str.charCodeAt(3);

  // The C switch keys off multichar constants ('1CHN'..'9CHN', '.K.M').
  // Each corresponds, byte-for-byte, to an on-disk ASCII tag: '1CHN'==(file
  // bytes "1CHN"), and case '.K.M' == on-disk "M.K." (the classic 4-channel
  // ProTracker tag). We match on-disk ASCII directly.
  if (is('1CHN')) mod_channels = 1;
  else if (is('2CHN')) mod_channels = 2;
  else if (is('3CHN')) mod_channels = 3;
  else if (is('M.K.') || is('4CHN')) mod_channels = 4;
  else if (is('5CHN')) mod_channels = 5;
  else if (is('6CHN')) mod_channels = 6;
  else if (is('7CHN')) mod_channels = 7;
  else if (is('8CHN')) mod_channels = 8;
  else if (is('9CHN')) mod_channels = 9;
  else {
    // Rare **CH tunes where ** = 10..32 channels. mod.c: if (sig>>16 == 'HC').
    // 'HC' as a 2-char constant = ('H'<<8)|'C'. sig>>16 takes the top two
    // bytes of the little-endian read = (s3<<8)|s2. So this matches a file
    // whose bytes 2,3 are 'C','H' (i.e. on-disk "..CH"). Replicate via raw
    // bytes: s2=='C', s3=='H'.
    if (s2 === 'C'.charCodeAt(0) && s3 === 'H'.charCodeAt(0)) {
      // chn_number = ASCII bytes 0,1 (e.g. "10".."32").
      const chnStr = bytesToCString([s0, s1]);
      mod_channels = parseInt(chnStr, 10) || 0; // atoi() semantics
      if (mod_channels > MAX_CHANNELS) {
        throw new ModError(ERR_MANYCHANNELS, `too many channels (${mod_channels})`);
      }
    } else {
      throw new ModError(ERR_INVALID_MODULE, `invalid module signature "${tag}"`);
    }
  }

  // Seek back to start.
  r.seek(file_start);

  /** @type {MASModule} */
  const mod = {
    title: '',
    order_count: 0,
    inst_count: 0,
    samp_count: 0,
    patt_count: 0,
    restart_pos: 0,
    stereo: true,
    inst_mode: false,
    freq_mode: 0,
    old_effects: true,
    link_gxx: false,
    xm_mode: true,
    old_mode: true,
    global_volume: 64,
    initial_speed: 6,
    initial_tempo: 125,
    channel_volume: new Array(MAX_CHANNELS).fill(0),
    channel_panning: new Array(MAX_CHANNELS).fill(0),
    orders: new Array(256).fill(0),
    instruments: new Array(31),
    samples: new Array(31),
    patterns: [],
  };

  // 20-byte module title.
  {
    const t = [];
    for (let x = 0; x < 20; x++) t.push(r.read8());
    mod.title = bytesToCString(t);
  }

  // Channel panning + volume defaults.
  //   if ((x&3)!=1 && (x&3)!=2)  pan = 128 - SEP/2  (hard-ish left)
  //   else                       pan = 128 + SEP/2  (hard-ish right)
  //   vol = 64
  for (let x = 0; x < MAX_CHANNELS; x++) {
    if ((x & 3) !== 1 && (x & 3) !== 2) {
      mod.channel_panning[x] = clamp_u8(128 - (PANNING_SEP >> 1));
    } else {
      mod.channel_panning[x] = clamp_u8(128 + (PANNING_SEP >> 1));
    }
    mod.channel_volume[x] = 64;
  }

  // MOD module settings (already set above where they match; keep explicit
  // assignments to mirror mod.c order/intent).
  mod.freq_mode = 0;
  mod.global_volume = 64;
  mod.initial_speed = 6;
  mod.initial_tempo = 125;
  mod.inst_count = 0; // filled by Load_MOD_Pattern
  mod.inst_mode = false;
  mod.link_gxx = false;
  mod.old_effects = true;
  mod.restart_pos = 0;
  mod.samp_count = 0; // filled before Load_MOD_SampleData
  mod.stereo = true;
  mod.xm_mode = true;
  mod.old_mode = true;

  // Load 31 instruments + 31 sample headers.
  for (let x = 0; x < 31; x++) {
    mod.instruments[x] = createModInstrument(x);
    mod.samples[x] = loadModSample(r);
  }

  // Read sequence header.
  mod.order_count = r.read8(); // SONG_LENGTH
  mod.restart_pos = r.read8(); // PT restart byte (mostly unused)
  if (mod.restart_pos >= 127) mod.restart_pos = 0;

  let npatterns = 0;
  for (let x = 0; x < 128; x++) {
    mod.orders[x] = r.read8();
    if (mod.orders[x] >= npatterns) npatterns = mod.orders[x] + 1;
  }

  r.read32(); // discard the signature (we're back at 1080).

  mod.patt_count = npatterns;
  mod.patterns = new Array(mod.patt_count);

  // Load patterns. inst_count is mutated by reference.
  const instCountRef = { value: mod.inst_count };
  for (let x = 0; x < mod.patt_count; x++) {
    mod.patterns[x] = loadModPattern(r, mod_channels & 0xff, instCountRef);
  }
  mod.inst_count = instCountRef.value;

  // Load sample data. samp_count = inst_count (mod.c).
  mod.samp_count = mod.inst_count;
  for (let x = 0; x < 31; x++) {
    loadModSampleData(r, mod.samples[x], fixSample);
  }

  // Expose detected channel count (not in MAS_Module, but useful metadata;
  // the emitter derives channels from channel_volume/panning arrays which are
  // always MAX_CHANNELS, matching mas.c which writes all 32).
  mod.mod_channels = mod_channels;

  return mod;
}

export default parseMod;

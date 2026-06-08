// parse-txt.js — pure-JS ESM port of the PARSER half of text2data.cpp
// (FamiTone2's FamiTracker .txt -> data tool, nesdoug bug-fix fork Oct 2025).
//
// This is a byte-exact port of the FamiTracker-text-export parsing path:
//   text_open + the text_* scan primitives, parse_instruments, parse_song,
//   song_cleanup_instrument_numbers, envelopes_cleanup, envelope_pitch_convert.
//
// It produces the in-memory song model that text2data builds in its global
// structs (song_original, instruments[], envelopeVolume/Arpeggio/Pitch/Duty[],
// sample_list[], dpcm[]). The OUTPUT/emit half (output_header, output_instruments,
// output_song, split_song, process_and_output_song) lives in a separate module.
//
// The C source uses one normalized character buffer `text_src` with an
// offset cursor model. Hard-coded byte offsets (off+11 for ORDER columns,
// off+9 for the effect column, etc.) are reproduced exactly, so the input must
// be the fixed-width FamiTracker text export the C tool consumes.
//
// Plain JS ESM + JSDoc, no TypeScript. Integer math is made explicit with
// Math.trunc / | 0 where the C relied on truncating int division.
//
// C source contract: famitone2d/text2data.cpp

// ---------------------------------------------------------------------------
// Constants (text2data.cpp L25-34)
// ---------------------------------------------------------------------------

export const MIN_PATTERN_LEN = 6;
export const MAX_REPEAT_CNT = 60;
export const MAX_SUB_SONGS = Math.trunc((256 - 5) / 14); // = 17
export const MAX_ROWS = 256;
export const MAX_PATTERNS = 128 * MAX_SUB_SONGS;
export const MAX_ORDER = 128 * MAX_SUB_SONGS;
export const MAX_INSTRUMENTS = 64;
export const MAX_ENVELOPES = 128;
export const MAX_ENVELOPE_LEN = 256;

// ---------------------------------------------------------------------------
// Struct constructors (text2data.cpp L40-97). These mirror the C structs 1:1
// so the algorithm stays auditable; zero-init matches the C global memset(0).
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ChannelStruct
 * @property {number} note        0 empty position, 1 rest note, 2+ note from C-0
 * @property {number} instrument  -1 no change (signed char in C), 0+ instrument
 * @property {number} effect      raw effect letter char code (0 = none)
 * @property {number} parameter   effect parameter (hex)
 */

/** @returns {ChannelStruct} */
function newChannel() {
  return { note: 0, instrument: 0, effect: 0, parameter: 0 };
}

/**
 * @typedef {Object} RowStruct
 * @property {ChannelStruct[]} channel  fixed 5 channels
 * @property {number} speed
 */

/** @returns {RowStruct} */
function newRow() {
  return {
    channel: [newChannel(), newChannel(), newChannel(), newChannel(), newChannel()],
    speed: 0,
  };
}

/**
 * @typedef {Object} PatternStruct
 * @property {RowStruct[]} row     MAX_ROWS rows
 * @property {number} length
 */

/** @returns {PatternStruct} */
function newPattern() {
  const row = new Array(MAX_ROWS);
  for (let i = 0; i < MAX_ROWS; ++i) row[i] = newRow();
  return { row, length: 0 };
}

/**
 * @typedef {Object} SongStruct
 * @property {number} speed
 * @property {number} tempo
 * @property {number} pattern_length
 * @property {number} order_length
 * @property {number} order_loop
 * @property {PatternStruct[]} pattern   MAX_PATTERNS patterns
 */

/** @returns {SongStruct} */
function newSong() {
  const pattern = new Array(MAX_PATTERNS);
  for (let i = 0; i < MAX_PATTERNS; ++i) pattern[i] = newPattern();
  return {
    speed: 0,
    tempo: 0,
    pattern_length: 0,
    order_length: 0,
    order_loop: 0,
    pattern,
  };
}

/**
 * @typedef {Object} InstrumentStruct
 * @property {number} volume    env id (short int in C)
 * @property {number} pitch     env id
 * @property {number} arpeggio  env id
 * @property {number} duty      env id
 * @property {number} id
 * @property {boolean} in_use
 */

/** @returns {InstrumentStruct} */
function newInstrument() {
  return { volume: 0, pitch: 0, arpeggio: 0, duty: 0, id: 0, in_use: false };
}

/**
 * @typedef {Object} EnvelopeStruct
 * @property {Int16Array} value   MAX_ENVELOPE_LEN values (short int)
 * @property {number} length
 * @property {number} loop
 * @property {number} out_id
 * @property {boolean} in_use
 */

/** @returns {EnvelopeStruct} */
function newEnvelope() {
  return {
    value: new Int16Array(MAX_ENVELOPE_LEN),
    length: 0,
    loop: 0,
    out_id: 0,
    in_use: false,
  };
}

/**
 * @typedef {Object} SampleStruct
 * @property {number} off
 * @property {number} size
 * @property {number} pitch
 * @property {number} loop
 * @property {number} id
 */

/** @returns {SampleStruct} */
function newSample() {
  return { off: 0, size: 0, pitch: 0, loop: 0, id: 0 };
}

// ---------------------------------------------------------------------------
// Parser state. The C tool kept these as file-scope globals; we encapsulate
// them in a single object so the parser is reentrant (the JS API can be called
// repeatedly). All the text_* primitives close over `S`.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ParserState
 * @property {string} text_src   normalized source buffer
 * @property {number} text_size  length of text_src
 * @property {number} channels   active channel count (default 5)
 * @property {number} subSongsCount
 * @property {number} keep_instruments  if !=0, never remove any instrument
 * @property {number} no_warnings       if !=0, silence unsupported-effect error
 * @property {SongStruct} song_original
 * @property {InstrumentStruct[]} instruments       MAX_INSTRUMENTS
 * @property {EnvelopeStruct[]} envelopeVolume      MAX_ENVELOPES
 * @property {EnvelopeStruct[]} envelopeArpeggio    MAX_ENVELOPES
 * @property {EnvelopeStruct[]} envelopePitch       MAX_ENVELOPES
 * @property {EnvelopeStruct[]} envelopeDuty        MAX_ENVELOPES
 * @property {SampleStruct[]} sample_list           MAX_INSTRUMENTS
 * @property {Uint8Array} dpcm
 * @property {number} dpcm_size
 * @property {string[]} song_name   per-subsong human name (from TRACK line)
 */

/**
 * Build a fresh parser state with all the C globals zero-initialized.
 * @param {{channels?:number, keepInstruments?:boolean, noWarnings?:boolean}} [opts]
 * @returns {ParserState}
 */
function createState(opts = {}) {
  const mkArr = (n, fn) => {
    const a = new Array(n);
    for (let i = 0; i < n; ++i) a[i] = fn();
    return a;
  };
  return {
    text_src: '',
    text_size: 0,
    channels: opts.channels ?? 5,
    subSongsCount: 0,
    keep_instruments: opts.keepInstruments ? 1 : 0,
    no_warnings: opts.noWarnings ? 1 : 0,
    song_original: newSong(),
    instruments: mkArr(MAX_INSTRUMENTS, newInstrument),
    envelopeVolume: mkArr(MAX_ENVELOPES, newEnvelope),
    envelopeArpeggio: mkArr(MAX_ENVELOPES, newEnvelope),
    envelopePitch: mkArr(MAX_ENVELOPES, newEnvelope),
    envelopeDuty: mkArr(MAX_ENVELOPES, newEnvelope),
    sample_list: mkArr(MAX_INSTRUMENTS, newSample),
    dpcm: new Uint8Array(16384),
    dpcm_size: 0,
    song_name: new Array(MAX_SUB_SONGS).fill(''),
  };
}

// ---------------------------------------------------------------------------
// Errors. The C tool printed and called exit(1); we throw instead so callers
// can catch. parse_error / parse_error_ptn (L439-476).
// ---------------------------------------------------------------------------

export class FamiTrackerParseError extends Error {
  /**
   * @param {string} message
   * @param {{row?:number, col?:number, off?:number}} [loc]
   */
  constructor(message, loc = {}) {
    super(message);
    this.name = 'FamiTrackerParseError';
    if (loc.row !== undefined) this.row = loc.row;
    if (loc.col !== undefined) this.col = loc.col;
    if (loc.off !== undefined) this.off = loc.off;
  }
}

/**
 * text2data.cpp parse_error (L439-468): compute row/col for the message.
 * @param {ParserState} S
 * @param {number} off
 * @param {string} str
 * @returns {never}
 */
function parseError(S, off, str) {
  if (off < 0) {
    throw new FamiTrackerParseError(`Parsing error: ${str}`, { off });
  }
  let row = 1;
  let col = 1;
  let ptr = 0;
  while (ptr < off) {
    if (S.text_src.charCodeAt(ptr++) === 0x0a) {
      ++row;
      col = 0;
    }
    ++col;
  }
  throw new FamiTrackerParseError(
    `Parsing error (row ${row},col ${col}): ${str}`,
    { row, col, off },
  );
}

/**
 * text2data.cpp parse_error_ptn (L471-476).
 * @param {ParserState} S
 * @param {number} song
 * @param {number} pos
 * @param {number} row
 * @param {number} chn
 * @param {string} str
 * @returns {never}
 */
function parseErrorPtn(S, song, pos, row, chn, str) {
  const h2 = (n) => (n & 0xff).toString(16).padStart(2, '0');
  throw new FamiTrackerParseError(
    `Parsing error (song:${String(song + 1).padStart(2, '0')} pos:${h2(pos)} row:${h2(row)} chn ${chn}): ${str}`,
  );
}

// ---------------------------------------------------------------------------
// text_open (L154-205): normalize the raw file into text_src.
//  - TAB -> space
//  - drop CR (0x0d)
//  - append one trailing 0x0a
// We model text_src as a JS string; charCodeAt(i) gives the single byte the
// C indexed as text_src[i]. Characters past the buffer end read as NaN in JS,
// which compares false against every char test, mirroring C reads past the
// (allocated but unscanned) end well enough for the offset-based grammar; all
// loops are bounded by text_size anyway.
// ---------------------------------------------------------------------------

/**
 * @param {ParserState} S
 * @param {string} text  raw file contents
 */
function textOpen(S, text) {
  let out = '';
  for (let i = 0; i < text.length; ++i) {
    let c = text.charCodeAt(i);
    if (c === 0x09) c = 0x20; // tab -> space
    if (c !== 0x0d) out += String.fromCharCode(c); // drop CR
  }
  out += '\n'; // trailing 0x0a
  S.text_src = out;
  S.text_size = out.length;
}

// Convenience: read one char code at an offset (NaN if past the buffer).
/** @param {ParserState} S @param {number} off */
const cc = (S, off) => S.text_src.charCodeAt(off);

// ---------------------------------------------------------------------------
// Scan primitives (L219-400). Faithful to the C cursor model.
// ---------------------------------------------------------------------------

/** text_skip_line (L219-227) @param {ParserState} S @param {number} off */
function textSkipLine(S, off) {
  while (off < S.text_size) {
    if (cc(S, off++) === 0x0a) break;
  }
  return off;
}

/** text_skip_spaces (L230-235) */
function textSkipSpaces(S, off) {
  while (off < S.text_size) {
    if (cc(S, off) === 0x20) ++off;
    else break;
  }
  return off;
}

/** text_skip_dec_and_spaces (L238-254) */
function textSkipDecAndSpaces(S, off) {
  off = textSkipSpaces(S, off);
  while (off < S.text_size) {
    const n = cc(S, off);
    // n is '0'..'9' or '-'
    if (!((n >= 0x30 && n <= 0x39) || n === 0x2d)) break;
    ++off;
  }
  return textSkipSpaces(S, off);
}

/** text_skip_hex_and_spaces (L257-273) */
function textSkipHexAndSpaces(S, off) {
  off = textSkipSpaces(S, off);
  while (off < S.text_size) {
    const n = cc(S, off);
    if (
      !(
        (n >= 0x30 && n <= 0x39) ||
        (n >= 0x61 && n <= 0x66) || // a-f
        (n >= 0x41 && n <= 0x46) // A-F
      )
    ) {
      break;
    }
    ++off;
  }
  return textSkipSpaces(S, off);
}

/**
 * memcmp helper: does text_src match `tag` (an ASCII string) starting at off?
 * @param {ParserState} S @param {number} off @param {string} tag
 */
function matchAt(S, off, tag) {
  for (let k = 0; k < tag.length; ++k) {
    if (S.text_src.charCodeAt(off + k) !== tag.charCodeAt(k)) return false;
  }
  return true;
}

/**
 * text_find_tag (L276-286): find next occurrence of `tag` at >=off, return the
 * offset just past it (with trailing spaces skipped); -1 if none.
 */
function textFindTag(S, tag, off) {
  const end = S.text_size - tag.length;
  for (let i = off; i < end; ++i) {
    if (matchAt(S, i, tag)) return textSkipSpaces(S, i + tag.length);
  }
  return -1;
}

/**
 * text_find_tag_start_sub_song (L289-301): like text_find_tag but bails (-1)
 * if it hits "TRACK" first, so a pattern search can't bleed into the next
 * subsong.
 */
function textFindTagStartSubSong(S, tag, off) {
  const end = S.text_size - tag.length;
  for (let i = off; i < end; ++i) {
    if (matchAt(S, i, 'TRACK')) return -1;
    if (matchAt(S, i, tag)) return textSkipSpaces(S, i + tag.length);
  }
  return -1;
}

/** text_skip_tag (L304-314): skip the current non-space token, then spaces. */
function textSkipTag(S, off) {
  while (off < S.text_size) {
    if (cc(S, off) <= 0x20) break;
    ++off;
  }
  return textSkipSpaces(S, off);
}

/**
 * text_find_tag_section (L317-329): find tag but stop at '[' (INI sections);
 * unused by the FT path but ported for completeness/old-path support.
 */
function textFindTagSection(S, tag, off) {
  while (off < S.text_size - tag.length) {
    if (cc(S, off) === 0x5b /* '[' */) break;
    if (matchAt(S, off, tag)) return textSkipSpaces(S, off + tag.length);
    ++off;
  }
  return -1;
}

/** text_find_tag_start (L332-342): find tag, return offset AT the tag. */
function textFindTagStart(S, tag, off) {
  const end = S.text_size - tag.length;
  for (let i = off; i < end; ++i) {
    if (matchAt(S, i, tag)) return i;
  }
  return -1;
}

/** text_read_dec (L345-371): decimal with optional leading '-'. */
function textReadDec(S, off) {
  let num = 0;
  let sign = 1;
  if (cc(S, off) === 0x2d /* '-' */) {
    ++off;
    sign = -1;
  }
  while (off < S.text_size) {
    const n = cc(S, off++);
    if (n < 0x30 || n > 0x39) break;
    num = num * 10 + (n - 0x30);
  }
  return num * sign;
}

/** hex (L374-381): one hex digit, or -1. */
function hex(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** text_read_hex (L384-400). */
function textReadHex(S, off) {
  let num = 0;
  while (off < S.text_size) {
    const n = hex(cc(S, off++));
    if (n < 0) break;
    num = num * 16 + n;
  }
  return num;
}

// ---------------------------------------------------------------------------
// clear helpers (L404-436). Encapsulated as re-init of the relevant arrays.
// ---------------------------------------------------------------------------

/** clear_song (L414-417). */
function clearSong(S) {
  S.song_original = newSong();
}

// ---------------------------------------------------------------------------
// parse_instruments (L849-1120): subsong count, # Macros, # Instruments,
// # DPCM samples. Shared across all subsongs.
// ---------------------------------------------------------------------------

/** @param {ParserState} S */
function parseInstruments(S) {
  let off = 0;

  // count sub songs (L857-869)
  S.subSongsCount = 0;
  while (1) {
    off = textFindTag(S, 'TRACK', off);
    if (off < 0) break;
    ++S.subSongsCount;
  }
  if (S.subSongsCount > MAX_SUB_SONGS) parseError(S, 0, 'Too many sub songs');

  // parse envelopes (L871-937)
  off = textFindTag(S, '# Macros', 0);
  if (off === -1) off = textFindTag(S, '# SEQUENCES', 0); // Dn-FamiTracker
  if (off < 0) parseError(S, off, 'Macros section not found');

  while (off < S.text_size) {
    off = textFindTag(S, 'MACRO', off);
    if (off < 0) break;

    const type = textReadDec(S, off); // macro group number
    off = textSkipDecAndSpaces(S, off);

    const id = textReadDec(S, off); // macro id in a group
    if (id > MAX_ENVELOPES) parseError(S, off, 'Macro number is too large');
    off = textSkipDecAndSpaces(S, off);

    const loop = textReadDec(S, off); // envelope loop
    off = textSkipDecAndSpaces(S, off);

    textReadDec(S, off); // unknown parameter (release)
    off = textSkipDecAndSpaces(S, off);

    textReadDec(S, off); // unknown parameter (setting)
    off = textSkipDecAndSpaces(S, off);

    if (cc(S, off) !== 0x3a /* ':' */) parseError(S, off, 'Unexpected macro format');

    let env = null;
    switch (type) {
      case 0:
        env = S.envelopeVolume[id];
        break; // volume
      case 1:
        env = S.envelopeArpeggio[id];
        break; // arpeggio
      case 2:
        env = S.envelopePitch[id];
        break; // pitch
      case 4:
        env = S.envelopeDuty[id];
        break; // duty
      default:
        env = null; // type 3 (hi-pitch) ignored
    }

    if (env) {
      off += 2; // skip ": "
      let ptr = 0;
      while (off < S.text_size) {
        if (cc(S, off) === 0x0a) break;
        if (ptr >= MAX_ENVELOPE_LEN) parseError(S, off, 'Macro is too long');
        env.value[ptr++] = textReadDec(S, off);
        off = textSkipDecAndSpaces(S, off);
      }
      env.length = ptr;
      env.loop = loop;
    }
  }

  // parse instruments (L939-1051)
  for (let i = 0; i < MAX_INSTRUMENTS; ++i) S.sample_list[i].id = -1;

  off = textFindTag(S, '# Instruments', off);
  if (off === -1) off = textFindTag(S, '# INSTRUMENTS', 0); // Dn-FamiTracker
  if (off < 0) parseError(S, off, 'Instruments section not found');

  let ins_id = 0;

  while (off < S.text_size) {
    off = textSkipLine(S, off);

    if (matchAt(S, off, 'INST2A03')) {
      off = textSkipTag(S, off);

      let ins = textReadDec(S, off); // instrument number
      if (ins < 0 || ins >= MAX_INSTRUMENTS) parseError(S, off, 'Wrong instrument number');
      if (ins > 63) parseError(S, off, 'Only 64 instruments (0..63) supported');
      off = textSkipDecAndSpaces(S, off);

      S.instruments[ins].volume = textReadDec(S, off); // volume envelope id
      if (S.instruments[ins].volume < 0) {
        parseError(S, off, `Instrument ${ins} does not have volume envelope`);
      }
      off = textSkipDecAndSpaces(S, off);

      S.instruments[ins].arpeggio = textReadDec(S, off); // arpeggio envelope id
      off = textSkipDecAndSpaces(S, off);

      S.instruments[ins].pitch = textReadDec(S, off); // pitch envelope id
      off = textSkipDecAndSpaces(S, off);

      textReadDec(S, off); // unused hi-pitch envelope id
      off = textSkipDecAndSpaces(S, off);

      S.instruments[ins].duty = textReadDec(S, off); // duty cycle envelope id
      S.instruments[ins].id = ins_id;

      if (S.keep_instruments) S.instruments[ins].in_use = true;
      ++ins_id;
      continue;
    }

    if (matchAt(S, off, 'KEYDPCM')) {
      off = textSkipTag(S, off);

      let ins = textReadDec(S, off); // instrument number
      if (ins !== 0) continue;
      off = textSkipDecAndSpaces(S, off);

      const octave = textReadDec(S, off); // octave
      off = textSkipDecAndSpaces(S, off);

      const note = textReadDec(S, off); // note
      if (octave * 12 + note < 1 * 12 || octave * 12 + note >= 6 * 12 + 3) {
        parseError(S, off, 'DPCM samples could only be assigned to notes C-1..D-6');
      }

      ins = (octave - 1) * 12 + note; // sample-table slot
      off = textSkipDecAndSpaces(S, off);

      const id = textReadDec(S, off); // sample number
      off = textSkipDecAndSpaces(S, off);

      const pitch = textReadDec(S, off); // pitch
      off = textSkipDecAndSpaces(S, off);

      const loop = textReadDec(S, off); // loop
      off = textSkipDecAndSpaces(S, off);

      textReadDec(S, off); // unknown
      off = textSkipDecAndSpaces(S, off);

      textReadDec(S, off); // unknown
      off = textSkipDecAndSpaces(S, off);

      S.sample_list[ins].id = id;
      S.sample_list[ins].loop = loop;
      S.sample_list[ins].pitch = pitch;
      S.sample_list[ins].size = 0;
      continue;
    }

    break; // any other line ends the instrument loop
  }

  // parse sample data (L1053-1119)
  let ptr = 0;
  off = textFindTag(S, '# DPCM samples', off);

  while (off < S.text_size) {
    off = textFindTag(S, 'DPCMDEF', off);
    if (off < 0) break;

    const id = textReadDec(S, off);
    let note = -1;
    for (let i = 0; i < MAX_INSTRUMENTS; ++i) {
      if (S.sample_list[i].id === id) {
        note = i;
        break;
      }
    }
    if (note < 0) continue;

    off = textSkipDecAndSpaces(S, off);
    let size = textReadDec(S, off);

    for (let i = 0; i < MAX_INSTRUMENTS; ++i) {
      if (S.sample_list[i].id === id) {
        S.sample_list[i].off = ptr >> 6;
        S.sample_list[i].size = size >> 4;
      }
    }

    while (off < S.text_size) {
      off = textSkipLine(S, off);
      if (!matchAt(S, off, 'DPCM :')) break;
      off += 7;
      while (off < S.text_size) {
        if (cc(S, off) === 0x0a) break;
        const n = textReadHex(S, off);
        off = textSkipHexAndSpaces(S, off);
        S.dpcm[ptr++] = n;
        --size;
      }
    }

    if (size !== 0) parseError(S, off, 'Actual DPCM sample size does not match its definition');
    ptr = ((ptr >> 6) + 1) << 6;
  }

  for (let i = 0; i < MAX_INSTRUMENTS; ++i) {
    if (S.sample_list[i].off < 0) S.sample_list[i].off = 0;
  }
  S.dpcm_size = ptr;
}

// ---------------------------------------------------------------------------
// parse_song (L1123-1382): per-subsong TRACK header, ORDER list, PATTERN/ROW
// data, then order->linear conversion into song_original. When header_only,
// only the TRACK header (length/speed/tempo/name) is read.
// ---------------------------------------------------------------------------

/**
 * @param {ParserState} S
 * @param {number} subsong
 * @param {boolean} header_only
 */
function parseSong(S, subsong, header_only) {
  // local pattern[] and order[][5] (L1125-1126)
  const pattern = new Array(MAX_PATTERNS);
  for (let i = 0; i < MAX_PATTERNS; ++i) pattern[i] = newPattern();
  const order = new Array(MAX_ORDER);
  for (let i = 0; i < MAX_ORDER; ++i) order[i] = [0, 0, 0, 0, 0];

  const so = S.song_original;

  if (subsong >= S.subSongsCount) parseError(S, 0, 'No sub song found');

  let off = textFindTag(S, '# Tracks', 0);
  for (let i = 0; i <= subsong; ++i) off = textFindTag(S, 'TRACK', off);
  if (off < 0) parseError(S, off, "Can't find track section");

  off = textSkipSpaces(S, off);
  so.pattern_length = textReadDec(S, off);
  off = textSkipDecAndSpaces(S, off);
  so.speed = textReadDec(S, off);
  off = textSkipDecAndSpaces(S, off);
  so.tempo = textReadDec(S, off);

  // ** read the quoted subsong name (L1153-1167)
  for (let a = 0; a < 6; a++) {
    if (cc(S, off) === 0x22 /* '"' */) break;
    off++;
  }
  off++;
  let name = '';
  for (let a = 0; a < 256; a++) {
    if (cc(S, off) === 0x22 /* '"' */) break;
    name += String.fromCharCode(cc(S, off));
    off++;
  }
  S.song_name[subsong] = name;

  if (header_only) return;

  // parse order list (L1171-1195)
  let pos = 0;
  let maxptn = 0;

  off = textFindTagStart(S, 'ORDER', off);

  while (off < S.text_size) {
    if (cc(S, off) !== 0x4f /* 'O' */) break;

    order[pos][0] = textReadHex(S, off + 11);
    order[pos][1] = textReadHex(S, off + 14);
    order[pos][2] = textReadHex(S, off + 17);
    order[pos][3] = textReadHex(S, off + 20);
    order[pos][4] = textReadHex(S, off + 23);

    for (let chn = 0; chn < S.channels; ++chn) {
      if (order[pos][chn] > maxptn) maxptn = order[pos][chn];
    }

    off = textSkipLine(S, off);
    ++pos;
  }

  so.order_length = pos;

  // parse patterns (L1197-1307)
  let ptn = 0;

  for (let i = 0; i <= maxptn; ++i) {
    pattern[ptn].length = so.pattern_length;

    const str = `PATTERN ${(i & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;

    const off_prev = off;
    off = textFindTagStartSubSong(S, str, off);

    if (off < 0) {
      // pattern not found (FamiTracker cleanup removed it) — fill empties, skip
      off = off_prev;
      for (let row = 0; row < so.pattern_length; ++row) {
        for (let chn = 0; chn < S.channels; ++chn) {
          pattern[ptn].row[row].channel[chn].note = 0;
          pattern[ptn].row[row].channel[chn].instrument = 0;
          pattern[ptn].row[row].channel[chn].effect = 0;
          pattern[ptn].row[row].channel[chn].parameter = 0;
        }
      }
      ++ptn;
      continue;
    }

    off = textSkipLine(S, off);

    for (let row = 0; row < so.pattern_length; ++row) {
      if (!matchAt(S, off, 'ROW')) parseError(S, off, 'No row definition found ');
      if (textReadHex(S, off + 4) !== row) parseError(S, off, 'Unexpected row number');

      for (let chn = 0; chn < S.channels; ++chn) {
        // skip to a channel position, regardless of number of effect columns
        while (cc(S, off++) !== 0x3a /* ':' */);
        ++off; // skip the space after ':' -> land on note field

        let n = cc(S, off);
        let note;

        if (chn !== 3) {
          // normal channels
          switch (n) {
            case 0x2e: // '.'
              note = 0;
              break;
            case 0x2d: // '-'
              note = 1;
              break;
            case 0x43: // 'C'
              note = 2;
              break;
            case 0x44: // 'D'
              note = 4;
              break;
            case 0x45: // 'E'
              note = 6;
              break;
            case 0x46: // 'F'
              note = 7;
              break;
            case 0x47: // 'G'
              note = 9;
              break;
            case 0x41: // 'A'
              note = 11;
              break;
            case 0x42: // 'B'
              note = 13;
              break;
            default:
              parseError(S, off, 'Unexpected character in the note field');
          }

          if (cc(S, off + 1) === 0x23 /* '#' */) ++note;

          if (note > 1) {
            note += 12 * textReadDec(S, off + 2); // add octave
            if (note < 2 + 12 || note >= 2 + 12 + 63) {
              parseError(S, off, 'Note is out of supported range (C-1..D-6)');
            }
            note -= 12; // correct range
          }
        } else {
          // noise channel has different note format
          switch (n) {
            case 0x2e: // '.'
              note = 0;
              break;
            case 0x2d: // '-'
              note = 1;
              break;
            default: {
              const h = hex(n);
              if (h >= 0) note = ((h + 15) & 15) + 2;
              else parseError(S, off, 'Unexpected character in the note field');
            }
          }
        }

        let ins;
        if (cc(S, off + 4) === 0x2e /* '.' */) ins = -1;
        else ins = textReadHex(S, off + 4);
        if (ins > 63) parseError(S, off, 'Instrument number is out of range (0..63)');

        pattern[ptn].row[row].channel[chn].note = note;
        pattern[ptn].row[row].channel[chn].instrument = ins;
        pattern[ptn].row[row].channel[chn].effect = cc(S, off + 9) || 0;
        pattern[ptn].row[row].channel[chn].parameter = textReadHex(S, off + 10);

        if (ins >= 0) S.instruments[ins].in_use = true;
      }

      off = textSkipLine(S, off);
    }

    ++ptn;
  }

  // convert order list + patterns into linear song_original (L1309-1381)
  for (pos = 0; pos < so.order_length; ++pos) {
    so.pattern[pos].length = so.pattern_length;

    let shortest = so.pattern_length; // ** full size, shrink on D00/Bxx

    for (let chn = 0; chn < S.channels; ++chn) {
      for (let row = 0; row < so.pattern_length; ++row) {
        const nsrc = pattern[order[pos][chn]].row[row].channel[chn];
        const ndst = so.pattern[pos].row[row].channel[chn];

        ndst.note = nsrc.note;
        ndst.instrument = nsrc.instrument;

        switch (nsrc.effect) {
          case 0:
          case 0x2e /* '.' */:
            break; // no effect

          case 0x42 /* 'B' */: {
            // end song and loop to a provided order list position
            if (row > shortest) break; // **
            shortest = row + 1;

            so.order_length = pos + 1;
            so.order_loop = nsrc.parameter;
            so.pattern[pos].length = row + 1;

            row = MAX_ROWS; // stop parsing current pattern

            if (so.order_loop > pos) {
              parseErrorPtn(S, subsong, pos, row, chn, "Bxx loop position can't be a forward reference");
            }
            break;
          }

          case 0x44 /* 'D' */: {
            // end pattern early
            so.pattern[pos].length = row + 1;
            row = MAX_ROWS; // stop parsing current pattern
            if (nsrc.parameter) {
              parseErrorPtn(S, subsong, pos, row, chn, 'Dxx value can only be zero');
            }
            if (so.pattern[pos].length < shortest) shortest = so.pattern[pos].length; // **
            break;
          }

          case 0x46 /* 'F' */: {
            // change speed
            so.pattern[pos].row[row].speed = nsrc.parameter;
            break;
          }

          default: {
            if (!S.no_warnings) {
              parseErrorPtn(S, subsong, pos, row, chn, 'Unsupported effect');
            }
          }
        }
      }
    }

    so.pattern[pos].length = shortest; // **
  }
}

// ---------------------------------------------------------------------------
// song_cleanup_instrument_numbers (L1388-1483): drop redundant consecutive
// instrument numbers and redundant speed values, carry the loop-point
// instrument forward across the loop. Operates in place on song_original.
// ---------------------------------------------------------------------------

/** @param {ParserState} S */
function songCleanupInstrumentNumbers(S) {
  const so = S.song_original;
  const insloop = [-1, -1, -1, -1, -1];
  let speed = 0;

  for (let chn = 0; chn < S.channels; ++chn) {
    let ins = -1;
    speed = 0;

    for (let pos = 0; pos < so.order_length; ++pos) {
      for (let row = 0; row < so.pattern[pos].length; ++row) {
        const ch = so.pattern[pos].row[row].channel[chn];

        if (chn < 4) {
          // pulse, triangle, noise channels
          // ignore instrument numbers at empty rows and rest notes
          if (ch.note < 2 && ch.instrument >= 0) ch.instrument = -1;

          if (ch.instrument >= 0) {
            if (pos === so.order_loop && insloop[chn] < 0) insloop[chn] = ins; // **
            if (ins !== ch.instrument) ins = ch.instrument;
            else ch.instrument = -1;
          }
        } else {
          // dpcm channel
          ch.instrument = -1;
        }

        if (chn === 0) {
          const rspeed = so.pattern[pos].row[row].speed;
          if (rspeed) {
            if (speed === rspeed) so.pattern[pos].row[row].speed = 0;
            else speed = rspeed;
          }
        }
      }
    }

    if (ins < 0) ins = 0;
  }

  // set current instrument number for first actual note after the loop point
  for (let chn = 0; chn < 4; ++chn) {
    if (insloop[chn] < 0) continue;

    let stop = false;
    for (let pos = so.order_loop; pos < so.order_length; ++pos) {
      for (let row = 0; row < so.pattern[pos].length; ++row) {
        const ch = so.pattern[pos].row[row].channel[chn];
        if (ch.note > 1) {
          if (ch.instrument < 0) ch.instrument = insloop[chn];
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
  }

  if (!so.pattern[so.order_loop].row[0].speed) so.pattern[so.order_loop].row[0].speed = speed;
}

// ---------------------------------------------------------------------------
// envelopes_cleanup (L1489-1502): trim trailing zero-pairs from non-looping
// volume envelopes; clamp duty envelopes to length 1.
// ---------------------------------------------------------------------------

/** @param {ParserState} S */
function envelopesCleanup(S) {
  for (let i = 0; i < MAX_ENVELOPES; ++i) {
    if (S.envelopeVolume[i].loop < 0) {
      const ev = S.envelopeVolume[i];
      for (let j = ev.length - 1; j > 0; --j) {
        if (!ev.value[j] && !ev.value[j - 1]) --ev.length;
        else break;
      }
    }
    if (S.envelopeDuty[i].length > 1) S.envelopeDuty[i].length = 1;
  }
}

// ---------------------------------------------------------------------------
// envelope_pitch_convert (L1508-1526): convert pitch envelopes from absolute
// to accumulated (running sum, clamped -64..63).
// ---------------------------------------------------------------------------

/** @param {ParserState} S */
function envelopePitchConvert(S) {
  for (let i = 0; i < MAX_ENVELOPES; ++i) {
    let val = 0;
    const ep = S.envelopePitch[i];
    for (let j = 0; j < ep.length; ++j) {
      val += ep.value[j];
      if (val < -64) val = -64;
      if (val > 63) val = 63;
      ep.value[j] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Detect whether `text` is a FamiTracker text export (vs the old TextExporter
 * plug-in INI format). main() L2349.
 * @param {string} text  raw (un-normalized) file contents
 * @returns {boolean}
 */
export function isFamiTrackerTextExport(text) {
  return text.indexOf('FamiTracker text export') >= 0;
}

/**
 * Parse a FamiTracker .txt export into text2data's in-memory song model.
 *
 * This runs the full FT-export parse pipeline that text2data's main() drives
 * before output: parse_instruments once, then for each subsong clear_song +
 * parse_song + song_cleanup_instrument_numbers (which marks every used
 * instrument across all subsongs and renumbers nothing yet), then
 * envelopes_cleanup + envelope_pitch_convert.
 *
 * It returns the model in two shapes:
 *  - `raw`: the literal text2data structs (song_original after the FINAL
 *    subsong parse + cleanup, the four envelope arrays, instruments[],
 *    sample_list[], dpcm/dpcm_size). This is what the emit half consumes; note
 *    that song_original holds only the LAST subsong (the C re-parses per
 *    subsong during output), while instruments[].in_use is global.
 *  - a flattened convenience view ({title, author, speed, tempo, instruments,
 *    envelopes, orders, patterns, ...}) requested by the port contract.
 *
 * Because text2data derives the per-subsong order/pattern data lazily (it
 * re-runs parse_song for each subsong during output), this function also
 * exposes `parseSongInto(state, sub)` via the returned `state` + a `subsongs`
 * array capturing each subsong's parsed song_original snapshot, so callers and
 * the emitter can replay subsongs deterministically.
 *
 * @param {string} text  raw .txt contents
 * @param {Object} [opts]
 * @param {string} [opts.songName]  label prefix (text2data derives this from
 *   the input filename; there is no filename here, so it's explicit). Used only
 *   by the emit half; the parser does not need it.
 * @param {number} [opts.channels=5]  active channel count (1..5)
 * @param {boolean} [opts.keepInstruments=false]  -allin: never drop instruments
 * @param {boolean} [opts.noWarnings=false]  -Wno: silence unsupported-effect error
 * @returns {{
 *   isFamiTrackerExport: boolean,
 *   songName: string,
 *   title: string,
 *   author: string,
 *   channels: number,
 *   subSongsCount: number,
 *   subSongNames: string[],
 *   speed: number,
 *   tempo: number,
 *   instruments: InstrumentStruct[],
 *   envelopes: {volume:EnvelopeStruct[],arpeggio:EnvelopeStruct[],pitch:EnvelopeStruct[],duty:EnvelopeStruct[]},
 *   sampleList: SampleStruct[],
 *   dpcm: Uint8Array,
 *   dpcmSize: number,
 *   subsongs: Array<{index:number, name:string, song:SongStruct, orders:number[][], patterns:RowStruct[][]}>,
 *   state: ParserState,
 * }}
 */
export function parseFamiTrackerTxt(text, opts = {}) {
  if (!isFamiTrackerTextExport(text)) {
    throw new FamiTrackerParseError(
      'Input is not a FamiTracker text export (old TextExporter plug-in format is unsupported by this parser)',
      { off: -1 },
    );
  }

  const S = createState(opts);
  textOpen(S, text);

  // Title / Author are NOT used by text2data, but the contract asks for them.
  // Read them directly (they are quoted values on TITLE/AUTHOR lines).
  const title = readQuotedTag(S, 'TITLE');
  const author = readQuotedTag(S, 'AUTHOR');

  // 1. shared instruments/envelopes/samples
  parseInstruments(S);

  // 2. first sweep: parse every subsong to mark all in_use instruments BEFORE
  //    any renumbering, and capture a snapshot of each subsong's song model.
  const subsongs = [];
  for (let sub = 0; sub < S.subSongsCount; ++sub) {
    clearSong(S);
    parseSong(S, sub, false);
    songCleanupInstrumentNumbers(S);
    subsongs.push({
      index: sub,
      name: S.song_name[sub],
      song: snapshotSong(S.song_original, S.channels),
    });
  }

  // 3. envelope post-processing (shared, after all subsongs parsed)
  envelopesCleanup(S);
  envelopePitchConvert(S);

  // Flattened convenience view derived from the FIRST subsong (matches the
  // single-song mental model the contract's return type describes). The full
  // per-subsong data is in `subsongs`. instruments/envelopes are global.
  const first = subsongs[0]?.song;

  return {
    isFamiTrackerExport: true,
    songName: opts.songName ?? '',
    title,
    author,
    channels: S.channels,
    subSongsCount: S.subSongsCount,
    subSongNames: S.song_name.slice(0, S.subSongsCount),
    speed: first ? first.speed : 0,
    tempo: first ? first.tempo : 0,
    instruments: S.instruments,
    envelopes: {
      volume: S.envelopeVolume,
      arpeggio: S.envelopeArpeggio,
      pitch: S.envelopePitch,
      duty: S.envelopeDuty,
    },
    sampleList: S.sample_list,
    dpcm: S.dpcm,
    dpcmSize: S.dpcm_size,
    subsongs,
    state: S,
  };
}

/**
 * Re-parse one subsong into the parser state's song_original (the C tool does
 * this lazily during output). Exposed so the emit half can replay subsongs
 * deterministically: clear_song -> parse_song(sub,false) ->
 * song_cleanup_instrument_numbers. (envelopes_cleanup / pitch_convert are
 * one-shot and must already have run.)
 *
 * @param {ParserState} S
 * @param {number} sub
 * @returns {SongStruct} the freshly parsed+cleaned song_original
 */
export function parseSubsongIntoState(S, sub) {
  clearSong(S);
  parseSong(S, sub, false);
  songCleanupInstrumentNumbers(S);
  return S.song_original;
}

// ---------------------------------------------------------------------------
// Helpers for the public API.
// ---------------------------------------------------------------------------

/**
 * Read a quoted value following a tag (e.g. TITLE "x"). Returns '' if absent.
 * Not used by the core algorithm; convenience for the flattened view.
 * @param {ParserState} S @param {string} tag
 */
function readQuotedTag(S, tag) {
  let off = textFindTag(S, tag, 0);
  if (off < 0) return '';
  // advance to the opening quote on the same logical token run
  while (off < S.text_size && cc(S, off) !== 0x22 /* '"' */ && cc(S, off) !== 0x0a) ++off;
  if (cc(S, off) !== 0x22) return '';
  ++off;
  let s = '';
  while (off < S.text_size && cc(S, off) !== 0x22 && cc(S, off) !== 0x0a) {
    s += String.fromCharCode(cc(S, off));
    ++off;
  }
  return s;
}

/**
 * Deep-snapshot a SongStruct down to order_length patterns / pattern.length
 * rows, so each subsong's parsed data survives the next clear_song(). Channels
 * are copied for the active channel count.
 * @param {SongStruct} so
 * @param {number} channels
 * @returns {{speed:number,tempo:number,pattern_length:number,order_length:number,order_loop:number,pattern:PatternStruct[]}}
 */
function snapshotSong(so, _channels) {
  const pattern = new Array(so.order_length);
  for (let pos = 0; pos < so.order_length; ++pos) {
    const srcP = so.pattern[pos];
    const row = new Array(srcP.length);
    for (let r = 0; r < srcP.length; ++r) {
      const srcR = srcP.row[r];
      const channel = new Array(5);
      for (let c = 0; c < 5; ++c) {
        const sc = srcR.channel[c];
        channel[c] = { note: sc.note, instrument: sc.instrument, effect: sc.effect, parameter: sc.parameter };
      }
      row[r] = { channel, speed: srcR.speed };
    }
    pattern[pos] = { row, length: srcP.length };
  }
  return {
    speed: so.speed,
    tempo: so.tempo,
    pattern_length: so.pattern_length,
    order_length: so.order_length,
    order_loop: so.order_loop,
    pattern,
  };
}

// Export the internal pieces the emit half needs, and for unit testing.
export {
  createState,
  textOpen,
  textFindTag,
  textFindTagStart,
  textFindTagStartSubSong,
  textFindTagSection,
  textSkipLine,
  textSkipSpaces,
  textSkipDecAndSpaces,
  textSkipHexAndSpaces,
  textSkipTag,
  textReadDec,
  textReadHex,
  hex,
  parseInstruments,
  parseSong,
  songCleanupInstrumentNumbers,
  envelopesCleanup,
  envelopePitchConvert,
  clearSong,
  snapshotSong,
};

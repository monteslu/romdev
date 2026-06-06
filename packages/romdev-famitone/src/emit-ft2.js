// emit-ft2.js — pure-JS ESM port of the OUTPUT/emit half of FamiTone2's
// `text2data` tool, targeting the FamiTracker-text-export input + `-ca65`
// output path (the only combination the bundled `music_data.s` /
// `famitone2.s` driver uses).
//
// This module owns the emit functions from text2data.cpp:
//   output_header, output_instruments, output_process_envelope,
//   output_dump_byte_array, output_song, split_song, process_and_output_song.
// The PARSER half (text_open, parse_instruments, parse_song,
// song_cleanup_instrument_numbers, envelopes_cleanup, envelope_pitch_convert)
// lives in ./parse-txt.js and produces the in-memory song model this emitter
// consumes. `emitFamiTone2` accepts either that parsed model OR a raw
// FamiTracker `.txt` string (it parses it for you).
//
// The output byte format is byte-for-byte identical to text2data's `-ca65`
// output (verified against famitone2d/TESTS/TestMusic3_good.s + the bundled
// packages/romdev/src/platforms/nes/lib/asm/music_data.s body), modulo the
// romdev packaging wrapper lines (`.export` / `.segment "RODATA"` / doc
// comment), which text2data does not emit.
//
// GOLDEN-REFERENCE FIDELITY NOTE:
//   TestMusic3_good.s / music_data.s were produced by the ORIGINAL Shiru
//   text2data, NOT the nesdoug fork. The fork's `**`-marked additions that emit
//   each subsong's TRACK name as a `; <name>` comment (after the header tempo
//   words, and as a `\n; <name>\n` block before each `@songNchM:` label) DO NOT
//   appear in that golden output, so `subsongComments` defaults to false to stay
//   byte-identical. Every other `**` fork bug-fix (the `shortest` pattern-cut
//   tracking + the loop-point instrument carry-forward) lives in the PARSER and
//   IS replicated because it changes the emitted bytes. The testA-G fixtures
//   were made by the fork (with name comments) and pass with subsongComments:true.

import {
  parseFamiTrackerTxt,
  parseSubsongIntoState,
  parseSong,
  MIN_PATTERN_LEN,
  MAX_REPEAT_CNT,
  MAX_INSTRUMENTS,
  MAX_ENVELOPES,
  MAX_ENVELOPE_LEN,
} from './parse-txt.js';

// text2data.cpp L129-131: MAX_PACKED_ROWS=256, MAX_PACKED_SIZE=MAX_PACKED_ROWS*4
const MAX_PACKED_SIZE = 256 * 4;

// ---------------------------------------------------------------------------
// ca65 emit tokens (text2data.cpp main, L2328-2334, OUT_CA65 branch)
// ---------------------------------------------------------------------------
const DB = '.byte';
const DW = '.word';
const LL = '@';
const LOW = '.lobyte';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {number} n @returns {string} two-digit lowercase hex */
function hex2(n) {
  return (n & 0xff).toString(16).padStart(2, '0');
}

/** memcmp(a, b, n) === 0 */
function bytesEqual(a, b, n) {
  for (let i = 0; i < n; ++i) {
    if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  }
  return true;
}

/** Sanitize a song label exactly like the C filename->label pass (L2301-2312) */
function sanitizeSongName(name) {
  let out = '';
  for (let i = 0; i < name.length; ++i) {
    const c = name[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out += c;
    else out += '_';
  }
  if (out.length === 0) out = 'music';
  return out;
}

// ---------------------------------------------------------------------------
// The emitter. It holds the dedup pools (outputEnvelopes / packedPatterns)
// and an output string buffer, and reads the parsed model out of the parser
// state `S` (model.state). Each method is a 1:1 port of the matching C
// output_* function.
// ---------------------------------------------------------------------------

class Ft2Emitter {
  /**
   * @param {object} model the object returned by parseFamiTrackerTxt (carries
   *   `.state` = the live ParserState with the C globals)
   * @param {object} opts
   * @param {string} opts.name
   * @param {boolean} [opts.subsongComments]
   */
  constructor(model, opts) {
    this.model = model;
    this.S = model.state;
    this.songName = sanitizeSongName(opts.name != null ? String(opts.name) : 'music');
    this.subsongComments = opts.subsongComments ? 1 : 0;

    // shared dedup pools (common to all subsongs)
    /** @type {{data:number[], size:number}[]} */
    this.outputEnvelopes = [];
    this.outputEnvelopeCount = 0;

    /** @type {{data:number[], length:number, refId:number, refLength:number}[]} */
    this.packedPatterns = [];
    this.packedCount = 0;
    this.referenceId = 0;

    // song_split (output_song reads this; split_song writes it)
    this.songSplit = makeSong();

    /** @type {string[]} output buffer (joined at the end) */
    this.out = [];
  }

  /** Convenience: the live parser state. */
  get channels() {
    return this.S.channels;
  }
  get subSongsCount() {
    return this.S.subSongsCount;
  }
  get songOriginal() {
    return this.S.song_original;
  }

  // -- output buffer (replaces fprintf(outfile, ...)) ----------------------
  emit(s) {
    this.out.push(s);
  }

  // -- shared resets -------------------------------------------------------
  clearPackedPatterns() {
    this.packedPatterns = [];
    this.packedCount = 0;
    this.referenceId = 0;
  }

  /**
   * Envelope accessor tolerant of the C's out-of-range env ids. An env id of -1
   * ("no envelope") is an out-of-bounds index in the C that lands on an
   * adjacent zeroed global and always resolves to env0; we return a persistent
   * virtual zero-length, not-in-use envelope (out_id 0). Valid ids 0..127 hit
   * the real table.
   * @param {Array} table @param {number} idx
   */
  getEnv(table, idx) {
    if (idx >= 0 && idx < MAX_ENVELOPES) return table[idx];
    if (!this._virtualEnvs) this._virtualEnvs = new Map();
    let v = this._virtualEnvs.get(table);
    if (!v) {
      v = { value: new Int16Array(MAX_ENVELOPE_LEN), length: 0, loop: 0, out_id: 0, in_use: false };
      this._virtualEnvs.set(table, v);
    }
    return v;
  }

  // ========================================================================
  //  output_dump_byte_array (L1643): rows of up to 16 `$xx`
  // ========================================================================
  /**
   * @param {number[]|Int16Array|Uint8Array} data @param {number} length
   * @param {boolean} test @returns {number} length (size accounting)
   */
  outputDumpByteArray(data, length, test) {
    if (test) return length;
    let ptr = 0;
    let col = 0;
    while (ptr < length) {
      if (!col) this.emit(`\t${DB} `);
      this.emit(`$${hex2(data[ptr++])}`);
      ++col;
      if (col >= 16 || ptr === length) {
        this.emit('\n');
        col = 0;
      } else {
        this.emit(',');
      }
    }
    return length;
  }

  // ========================================================================
  //  output_process_envelope (L1676): RLE + loop pointer + dedup
  // ========================================================================
  /**
   * @param {Int16Array|number[]} value @param {number} length @param {number} loop
   * @returns {number} index into outputEnvelopes (0 = default envelope)
   */
  outputProcessEnvelope(value, length, loop) {
    if (length <= 0) return 0; // default envelope

    const data = [];
    let ptr = 0;
    let ptrLoop = -1;
    let prevVal = value[0] + 1; // prevent rle match
    let rleCnt = 0;

    for (let j = 0; j < length; ++j) {
      if (j === loop) ptrLoop = ptr;

      let val = value[j];
      if (val < -64) val = -64;
      if (val > 63) val = 63;
      val += 192;

      if (prevVal !== val || j === length - 1) {
        if (rleCnt) {
          if (rleCnt === 1) {
            data[ptr++] = prevVal;
          } else {
            while (rleCnt > 126) {
              data[ptr++] = 126;
              rleCnt -= 126;
            }
            data[ptr++] = rleCnt;
          }
          rleCnt = 0;
        }
        data[ptr++] = val;
        prevVal = val;
      } else {
        ++rleCnt;
      }
    }

    if (ptrLoop < 0) ptrLoop = ptr - 1;
    else if (data[ptrLoop] < 128) ++ptrLoop; // bump past an RLE count byte

    data[ptr++] = 0; // loop terminator
    data[ptr++] = ptrLoop; // loop position
    const size = ptr;

    for (let i = 0; i < this.outputEnvelopeCount; ++i) {
      if (this.outputEnvelopes[i].size === size && bytesEqual(this.outputEnvelopes[i].data, data, size)) {
        return i;
      }
    }
    this.outputEnvelopes[this.outputEnvelopeCount] = { data: data.slice(0, size), size };
    ++this.outputEnvelopeCount;
    return this.outputEnvelopeCount - 1;
  }

  // ========================================================================
  //  output_header (L1755)
  // ========================================================================
  /**
   * @param {string} songname @param {number} song -1 => all subsongs
   * @returns {number} size accounting
   */
  outputHeader(songname, song) {
    const S = this.S;
    this.emit(';this file for FamiTone2 library generated by text2data tool\n\n');
    this.emit(`${songname}_music_data:\n`);
    this.emit(`\t${DB} ${S.subSongsCount}\n`);
    this.emit(`\t${DW} ${LL}instruments\n`);
    this.emit(`\t${DW} ${LL}samples-3\n`);

    let size = 5;
    let from;
    let to;
    if (song < 0) {
      from = 0;
      to = S.subSongsCount;
    } else {
      from = song;
      to = from + 1;
    }

    for (let sub = from; sub < to; ++sub) {
      // header_only re-parse to pull tempo for this subsong (C: parse_song(sub,true))
      parseSubsongHeader(S, sub);

      this.emit(`\t${DW} `);
      let line = '';
      for (let chn = 0; chn < 5; ++chn) {
        if (chn < S.channels) line += `${LL}song${sub}ch${chn},`;
        else line += '0,';
      }

      // integer (truncating) division — | 0
      const tempoPal = ((256 * S.song_original.tempo) / ((50 * 60) / 24)) | 0; // /125
      const tempoNtsc = ((256 * S.song_original.tempo) / ((60 * 60) / 24)) | 0; // /150

      line += `${tempoPal},${tempoNtsc}`;
      if (this.subsongComments) line += ` ; ${S.song_name[sub] || ''}`;
      this.emit(`${line}\n`);

      size += 14;
    }

    this.emit('\n');
    return size;
  }

  // ========================================================================
  //  output_instruments (L1811)
  // ========================================================================
  outputInstruments() {
    const S = this.S;
    let size = 0;

    // default envelope at index 0 (kept-0 / _FT2DummyEnvelope): c0,00,00
    this.outputEnvelopeCount = 0;
    this.outputEnvelopes[0] = { data: [0xc0, 0x00, 0x00], size: 3 };
    ++this.outputEnvelopeCount;

    // mark used envelopes (vol/arp/pitch; duty handled inline)
    for (let i = 0; i < MAX_ENVELOPES; ++i) {
      S.envelopeVolume[i].in_use = false;
      S.envelopeArpeggio[i].in_use = false;
      S.envelopePitch[i].in_use = false;
    }
    for (let i = 0; i < MAX_INSTRUMENTS; ++i) {
      if (!S.instruments[i].in_use) continue;
      // env id -1 (no envelope) -> virtual zero env (see getEnv).
      this.getEnv(S.envelopeVolume, S.instruments[i].volume).in_use = true;
      this.getEnv(S.envelopeArpeggio, S.instruments[i].arpeggio).in_use = true;
      this.getEnv(S.envelopePitch, S.instruments[i].pitch).in_use = true;
    }

    // convert envelopes to bytes + dedup — ORDER MATTERS (vol, arp, pitch)
    for (let i = 0; i < MAX_ENVELOPES; ++i) {
      const e = S.envelopeVolume[i];
      e.out_id = this.outputProcessEnvelope(e.value, e.in_use ? e.length : 0, e.loop);
    }
    for (let i = 0; i < MAX_ENVELOPES; ++i) {
      const e = S.envelopeArpeggio[i];
      e.out_id = this.outputProcessEnvelope(e.value, e.in_use ? e.length : 0, e.loop);
    }
    for (let i = 0; i < MAX_ENVELOPES; ++i) {
      const e = S.envelopePitch[i];
      e.out_id = this.outputProcessEnvelope(e.value, e.in_use ? e.length : 0, e.loop);
    }

    // instrument list
    this.emit(`${LL}instruments:\n`);
    for (let i = 0; i < MAX_INSTRUMENTS; ++i) {
      if (!S.instruments[i].in_use) continue;
      const dutyEnv = this.getEnv(S.envelopeDuty, S.instruments[i].duty);
      const duty = dutyEnv.length > 0 ? dutyEnv.value[0] & 3 : 0;

      this.emit(`\t${DB} $${hex2((duty << 6) | 0x30)} ;instrument $${hex2(i)}\n`);
      this.emit(`\t${DW} `);
      this.emit(`${LL}env${this.getEnv(S.envelopeVolume, S.instruments[i].volume).out_id},`);
      this.emit(`${LL}env${this.getEnv(S.envelopeArpeggio, S.instruments[i].arpeggio).out_id},`);
      this.emit(`${LL}env${this.getEnv(S.envelopePitch, S.instruments[i].pitch).out_id}\n`);
      this.emit(`\t${DB} $00\n`);

      size += 2 * 3 + 2;
    }

    this.emit('\n');

    // samples list
    this.emit(`${LL}samples:\n`);
    if (S.dpcm_size) {
      for (let i = 0; i < 63; ++i) {
        const s = S.sample_list[i];
        this.emit(
          `\t${DB} $${hex2(s.off)}+${LOW}(FT_DPCM_PTR),$${hex2(s.size)},$${hex2(s.pitch | ((s.loop & 1) << 6))}\t;${i + 1}\n`,
        );
        size += 3;
      }
      this.emit('\n');
    }

    // envelope data
    for (let i = 0; i < this.outputEnvelopeCount; ++i) {
      this.emit(`${LL}env${i}:\n`);
      size += this.outputDumpByteArray(this.outputEnvelopes[i].data, this.outputEnvelopes[i].size, false);
    }

    return size;
  }

  // ========================================================================
  //  output_song (L1903)
  // ========================================================================
  /**
   * @param {number} sub @param {number} spdchn speed channel
   * @param {boolean} test measure-only (rolls back the dedup pool)
   * @returns {number} size accounting
   */
  outputSong(sub, spdchn, test) {
    const S = this.S;
    const split = this.songSplit;

    // instrument renumbering list
    const insRenumber = new Array(MAX_INSTRUMENTS).fill(0);
    let ins = 0;
    for (let i = 0; i < MAX_INSTRUMENTS; ++i) {
      if (S.instruments[i].in_use) {
        insRenumber[i] = ins;
        ++ins;
      } else {
        insRenumber[i] = 0;
      }
    }

    const pcnt = this.packedCount;
    const pref = this.referenceId;
    let size = 0;

    const tptn = { data: [], length: 0, refLength: 0 };

    if (!test) this.emit('\n');

    for (let chn = 0; chn < S.channels; ++chn) {
      if (!test) {
        this.emit('\n');
        if (this.subsongComments) this.emit(`; ${S.song_name[sub] || ''}\n`);
        this.emit(`${LL}song${sub}ch${chn}:\n`);
      }

      if (chn === spdchn) {
        // default speed
        let ptr = 0;
        tptn.data[ptr++] = 0xfb;
        tptn.data[ptr++] = split.speed;
        tptn.length = ptr;
        size += this.outputDumpByteArray(tptn.data, tptn.length, test);
      }

      for (let pos = 0; pos < split.order_length; ++pos) {
        if (!test && pos === split.order_loop) {
          this.emit(`${LL}song${sub}ch${chn}loop:\n`);
        }

        let ptr = 0;
        const ptn = split.pattern[pos];

        const len = ptn.length;
        let srow = 0;
        let refLen = len; // pattern length without repeating empty rows

        while (srow < len) {
          if (ptr >= MAX_PACKED_SIZE) {
            throw new Error('Not enough room in the tptn array');
          }
          const row = ptn.row[srow++];
          const note = row.channel[chn].note;

          if (chn === spdchn && row.speed) {
            tptn.data[ptr++] = 0xfb;
            tptn.data[ptr++] = row.speed;
          }

          if (note > 0) {
            // instrument change
            const rIns = row.channel[chn].instrument;
            if (rIns >= 0) tptn.data[ptr++] = 0x80 | (insRenumber[rIns] << 1);

            // peek for note,empty,note packing
            let n1 = 0;
            let n2 = 0;
            if (srow + 0 < len) {
              n1 = ptn.row[srow + 0].channel[chn].note;
              if (chn === spdchn && ptn.row[srow + 0].speed) n1 = 1;
            }
            if (srow + 1 < len) {
              n2 = ptn.row[srow + 1].channel[chn].note;
              if (chn === spdchn && ptn.row[srow + 1].speed) n2 = 1;
            }
            const nrow = !n1 && n2 ? 0x01 : 0x00; // next empty row flag

            tptn.data[ptr++] = ((note - 1) << 1) | nrow; // 0 rest, 1..60 octaves 1-5
            if (nrow) {
              ++srow;
              --refLen;
            }
            continue;
          }

          // count empty rows
          let empty = 0;
          while (srow < len) {
            if (empty >= MAX_REPEAT_CNT) break;
            if (ptn.row[srow].channel[chn].note) break;
            if (chn === spdchn && ptn.row[srow].speed) break;
            ++srow;
            ++empty;
          }
          refLen -= empty;
          tptn.data[ptr++] = 0x81 | (empty << 1);
        }

        tptn.length = ptr;
        tptn.refLength = refLen;

        // search for a data match in the common list (prefix match)
        let ref = -1;
        if (tptn.length > 4) {
          for (let i = 0; i < this.packedCount; ++i) {
            if (tptn.length <= this.packedPatterns[i].length) {
              if (bytesEqual(tptn.data, this.packedPatterns[i].data, tptn.length)) {
                ref = i;
                break;
              }
            }
          }
        }

        if (ref < 0) {
          // no match — append + emit @refN: + bytes
          this.packedPatterns[this.packedCount] = {
            data: tptn.data.slice(0, tptn.length),
            length: tptn.length,
            refLength: tptn.refLength,
            refId: this.referenceId,
          };
          ++this.packedCount;

          if (!test) this.emit(`${LL}ref${this.referenceId}:\n`);
          size += this.outputDumpByteArray(tptn.data, tptn.length, test);
        } else {
          // match — emit $ff,ref_len + .word @ref<id>
          if (!test) {
            this.emit(`\t${DB} $ff,$${hex2(refLen)}\n`);
            this.emit(`\t${DW} ${LL}ref${this.packedPatterns[ref].refId}\n`);
          }
          size += 4;
        }

        ++this.referenceId;
      }

      if (!test) {
        this.emit(`\t${DB} $fd\n`); // end of stream
        this.emit(`\t${DW} ${LL}song${sub}ch${chn}loop\n`);
      }
      size += 3;
    }

    if (test) {
      // do not pollute the common list while measuring
      this.packedCount = pcnt;
      this.referenceId = pref;
    }

    return size;
  }

  // ========================================================================
  //  split_song (L2136)
  // ========================================================================
  splitSong(factor) {
    const so = this.S.song_original;

    // if all patterns are shorter than MIN_PATTERN_LEN after split, factor = 1
    let cnt = 0;
    for (let spos = 0; spos < so.order_length; ++spos) {
      if (((so.pattern[spos].length / factor) | 0) < MIN_PATTERN_LEN) ++cnt;
    }
    if (cnt === so.order_length) factor = 1;

    const split = makeSong();
    split.speed = so.speed;
    split.tempo = so.tempo;

    let dpos = 0;
    for (let spos = 0; spos < so.order_length; ++spos) {
      if (spos === so.order_loop) split.order_loop = dpos;

      let nlen = (so.pattern[spos].length / factor) | 0;
      if (nlen < MIN_PATTERN_LEN) nlen = MIN_PATTERN_LEN;

      let drow = 0;
      const srcLen = so.pattern[spos].length;
      for (let srow = 0; srow < srcLen; ++srow) {
        copyRow(split.pattern[dpos].row[drow], so.pattern[spos].row[srow]);
        ++drow;
        if (drow >= nlen || srow === srcLen - 1) {
          split.pattern[dpos].length = drow;
          ++dpos;
          drow = 0;
        }
      }
    }
    split.order_length = dpos;
    this.songSplit = split;
  }

  // ========================================================================
  //  process_and_output_song (L2195): brute-force (spdchn, factor) search
  // ========================================================================
  processAndOutputSong(sub) {
    const so = this.S.song_original;
    let sizeMin = 65536;
    let bestChannel = 0;
    let bestFactor = 1;

    for (let spdchn = 0; spdchn < this.S.channels; ++spdchn) {
      const maxFactor = (so.pattern_length / MIN_PATTERN_LEN) | 0;
      for (let factor = 1; factor <= maxFactor; ++factor) {
        this.splitSong(factor);
        const size = this.outputSong(sub, spdchn, true);
        if (size < sizeMin) {
          sizeMin = size;
          bestChannel = spdchn;
          bestFactor = factor;
        }
      }
    }

    this.splitSong(bestFactor);
    return this.outputSong(sub, bestChannel, false);
  }

  // ========================================================================
  //  main() FT-export path, !separate branch (L2353-2400) — output portion.
  //  (The parser already ran the instrument/first-sweep/cleanup passes.)
  // ========================================================================
  run() {
    // emit header + instruments (uses the shared envelope/instrument tables
    // already populated + cleaned by the parser).
    this.clearPackedPatterns();
    this.outputHeader(this.songName, -1);
    this.outputInstruments();

    // reset shared dedup pool before real song emit, then second sweep:
    // for each subsong re-parse (clear_song -> parse_song -> cleanup) and emit.
    this.clearPackedPatterns();
    for (let sub = 0; sub < this.S.subSongsCount; ++sub) {
      parseSubsongIntoState(this.S, sub);
      this.processAndOutputSong(sub);
    }

    return this.out.join('');
  }
}

// ---------------------------------------------------------------------------
// song_split model (output-side only; the parser owns song_original).
// Uses a Proxy-backed lazy pattern array so we don't allocate MAX_PATTERNS
// full patterns per split.
// ---------------------------------------------------------------------------

function makeChannel() {
  return { note: 0, instrument: 0, effect: 0, parameter: 0 };
}
function makeRow() {
  return { channel: [makeChannel(), makeChannel(), makeChannel(), makeChannel(), makeChannel()], speed: 0 };
}
function makePattern() {
  const row = new Array(256);
  for (let i = 0; i < 256; ++i) row[i] = makeRow();
  return { row, length: 0 };
}
function makeSong() {
  const store = [];
  const pattern = new Proxy(store, {
    get(t, prop) {
      if (typeof prop === 'string' && prop.length > 0) {
        const c0 = prop.charCodeAt(0);
        if (c0 >= 0x30 && c0 <= 0x39) {
          const i = Number(prop);
          let p = t[i];
          if (!p) {
            p = makePattern();
            t[i] = p;
          }
          return p;
        }
      }
      return t[prop];
    },
  });
  return { speed: 0, tempo: 0, pattern_length: 0, order_length: 0, order_loop: 0, pattern };
}

function copyRow(dst, src) {
  for (let c = 0; c < 5; ++c) {
    dst.channel[c].note = src.channel[c].note;
    dst.channel[c].instrument = src.channel[c].instrument;
    dst.channel[c].effect = src.channel[c].effect;
    dst.channel[c].parameter = src.channel[c].parameter;
  }
  dst.speed = src.speed;
}

/**
 * Re-parse one subsong's header (speed/tempo/pattern_length + TRACK name) into
 * S.song_original, matching the C output_header's `parse_song(sub, true)` call
 * (header_only: it sets speed/tempo/pattern_length + song_name and returns
 * before parsing the order/patterns). song_original is fully re-parsed again in
 * the second sweep, so the partial state here is fine.
 * @param {object} S @param {number} sub
 */
function parseSubsongHeader(S, sub) {
  parseSong(S, sub, true);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a FamiTracker song into FamiTone2-format ca65 `.s` source.
 *
 * @param {string|object} songModel  EITHER the raw FamiTracker `.txt` export
 *   contents (a string — what FamiTracker's File > Export Text produces), OR a
 *   parsed model object as returned by `parseFamiTrackerTxt` (from ./parse-txt.js).
 *   Multi-subsong exports are supported.
 * @param {object} [opts]
 * @param {string} [opts.name='music']  base label for `<name>_music_data:`
 *   (non-alphanumerics become '_').
 * @param {number} [opts.channels=5]  number of 2A03 channels (1..5). Only used
 *   when `songModel` is a raw string (the parser sets this otherwise).
 * @param {boolean} [opts.keepInstruments=false]  `-allin` (raw-string input only).
 * @param {boolean} [opts.noWarnings=false]  `-Wno` (raw-string input only).
 * @param {boolean} [opts.subsongComments=false]  emit the nesdoug fork's
 *   per-subsong TRACK-name comments. Default off keeps the output byte-identical
 *   to the original-Shiru golden reference (TestMusic3_good.s / music_data.s).
 * @returns {string} the ca65 `.s` source string (the music_data the bundled
 *   FamiTone2 driver plays). Does NOT include the romdev packaging wrapper
 *   (`.export` / `.segment "RODATA"`); add those at the packaging layer.
 */
export function emitFamiTone2(songModel, opts = {}) {
  let model;
  if (typeof songModel === 'string') {
    model = parseFamiTrackerTxt(songModel, {
      channels: opts.channels,
      keepInstruments: opts.keepInstruments,
      noWarnings: opts.noWarnings,
      songName: opts.name,
    });
  } else if (songModel && typeof songModel === 'object' && songModel.state) {
    model = songModel;
  } else {
    throw new TypeError(
      'emitFamiTone2(songModel, opts): songModel must be a FamiTracker .txt string ' +
        'or a parsed model from parseFamiTrackerTxt()',
    );
  }
  return new Ft2Emitter(model, opts).run();
}

// Explicit alias matching the file name / port nomenclature.
export const emitFt2 = emitFamiTone2;

export default emitFamiTone2;

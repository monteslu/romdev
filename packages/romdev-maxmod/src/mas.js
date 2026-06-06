/****************************************************************************
 *                                                          __              *
 *                ____ ___  ____ __  ______ ___  ____  ____/ /              *
 *               / __ `__ \/ __ `/ |/ / __ `__ \/ __ \/ __  /               *
 *              / / / / / / /_/ />  </ / / / / / /_/ / /_/ /                 *
 *             /_/ /_/ /_/\__,_/_/|_/_/ /_/ /_/\____/\__,_/                 *
 *                                                                          *
 *  romdev-maxmod — mas.js                                                   *
 *                                                                          *
 *  Faithful pure-JS ESM port of devkitPro mmutil's SERIALIZER:             *
 *    - mas.c  : Write_MAS / Write_Instrument / Write_Instrument_Envelope /  *
 *               Write_Sample / Write_SampleData / Write_Pattern /           *
 *               Mark_Patterns                                               *
 *    - msl.c  : MSL_AddSample / MSL_AddSampleC (dedup) / MSL_AddModule /    *
 *               MSL_Export / MSL_PrintDefinition                            *
 *                                                                          *
 *  Original C: Copyright (c) 2008, Mukunda Johnson (mukunda@maxmod.org).    *
 *                                                                          *
 *  Target system is GBA ONLY (SYSTEM_GBA). The NDS-specific branches of    *
 *  Write_SampleData are included for completeness/parity but never taken    *
 *  here. The GBA test-ROM template (gba.c Write_GBA) is NOT ported — it is  *
 *  irrelevant to producing a soundbank .bin.                               *
 *                                                                          *
 *  Endianness: LITTLE-ENDIAN throughout (matches files.c write8/16/32).     *
 *  align32() pads the write cursor to a 4-byte boundary with BYTESMASHER    *
 *  (0xBA) — NOT zero (verified against files.c align32; see util.js).       *
 *                                                                          *
 *  Consumes the in-memory module model from util.js makeModule()/etc.       *
 *  (produced by mod.js / xm.js / it.js / s3m.js). Emits, via               *
 *  writeSoundbank(): the packed soundbank { bin, header }.                  *
 ****************************************************************************/

import {
  ByteWriter,
  BYTESMASHER,
  MAX_CHANNELS,
  SYSTEM_GBA,
  SYSTEM_NDS,
  MAS_TYPE_SONG,
  MAS_TYPE_SAMPLE_GBA,
  MAS_TYPE_SAMPLE_NDS,
  SAMPF_16BIT,
  SAMP_FORMAT_U8,
  sample_dsformat,
  sample_dsreptype,
} from './util.js';

/** version.h: MAS_VERSION — the single version byte stamped into every record. */
export const MAS_VERSION = 0x18;

/**
 * msl.c SAMPLE_HEADER_SIZE = 12 + (NDS ? 4 : 0). For GBA this is 12 (the
 * Write_SampleData GBA header: length u32 + loop u32 + format u8 + BA u8 +
 * freq u16 = 12). It does NOT include the 4-byte MSL_AddSample preamble
 * (type/ver/sfx/BA), which is accounted separately.
 * @param {number} target
 * @returns {number}
 */
function sampleHeaderSize(target) {
  return 12 + (target === SYSTEM_NDS ? 4 : 0);
}

// ---------------------------------------------------------------------------
// mas.c — envelope/instrument size calculators
// ---------------------------------------------------------------------------

/**
 * mas.c CalcEnvelopeSize: node_count*4 + 8.
 * @param {{node_count:number}} env
 * @returns {number}
 */
function calcEnvelopeSize(env) {
  return env.node_count * 4 + 8;
}

/**
 * mas.c CalcInstrumentSize: 12 (8 header + 2 notemap selector + 2 reserved)
 * plus each present envelope's size.
 * @param {object} inst
 * @returns {number}
 */
function calcInstrumentSize(inst) {
  let size = 12;
  if (inst.env_flags & 1) size += calcEnvelopeSize(inst.envelope_volume);
  if (inst.env_flags & 2) size += calcEnvelopeSize(inst.envelope_pan);
  if (inst.env_flags & 4) size += calcEnvelopeSize(inst.envelope_pitch);
  return size;
}

// ---------------------------------------------------------------------------
// mas.c — Write_Instrument_Envelope
// ---------------------------------------------------------------------------

/**
 * Faithful port of mas.c Write_Instrument_Envelope.
 *
 * Emits an 8-byte header (size/loop_start/loop_end/sus_start/sus_end/
 * node_count/env_filter/BA), then — ONLY if node_count > 1 — one 4-byte node
 * record per node (signed delta u16 + base|range<<7 u16).
 *
 * NOTE the faithful quirk: the `size` byte always says node_count*4+8, but for
 * node_count==1 NO node bytes follow (size says 12, only 8 bytes written). The
 * C does the same; the runtime never reads past for 1-node envelopes.
 *
 * @param {ByteWriter} w
 * @param {object} env
 */
function writeInstrumentEnvelope(w, env) {
  w.write8((env.node_count * 4 + 8) & 0xff); // maximum is 6+75
  w.write8(env.loop_start & 0xff);
  w.write8(env.loop_end & 0xff);
  w.write8(env.sus_start & 0xff);
  w.write8(env.sus_end & 0xff);
  w.write8(env.node_count & 0xff);
  w.write8(env.env_filter ? 1 : 0); // bool → 0/1
  w.write8(BYTESMASHER);

  if (env.node_count > 1) {
    for (let x = 0; x < env.node_count; x++) {
      const base = env.node_y[x];
      let delta;
      let range;
      if (x !== env.node_count - 1) {
        range = env.node_x[x + 1] - env.node_x[x];
        if (range > 511) range = 511;
        if (range < 1) range = 1;
        // (((node_y[x+1]-base)*512) + (range/2)) / range  — C integer division.
        // range/2 is integer (range is a positive int here).
        const num = (env.node_y[x + 1] - base) * 512 + ((range / 2) | 0);
        delta = Math.trunc(num / range);
        if (delta > 32767) delta = 32767;
        if (delta < -32768) delta = -32768;
        // mas.c then clamps delta so that base+((delta*range)>>9) stays in
        // [0,64], where >>9 is an arithmetic shift on a signed int. asr9()
        // reproduces that exactly (Math.floor for negatives), avoiding float
        // drift; delta*range fits well within 2^53.
        delta = clampDeltaToRange(base, delta, range);
      } else {
        range = 0;
        delta = 0;
      }
      w.write16(delta & 0xffff); // (u16)delta — two's complement
      w.write16((base | (range << 7)) & 0xffff);
    }
  }
}

/**
 * Arithmetic right shift by 9 on a 32-bit signed integer (C `>>9` on `int`).
 * @param {number} v
 * @returns {number}
 */
function asr9(v) {
  return Math.floor(v / 512);
}

/**
 * Replicate mas.c's two clamp loops exactly:
 *   while( base + ((delta*range)>>9) > 64 ) delta--;
 *   while( base + ((delta*range)>>9) <  0 ) delta++;
 * using a correct arithmetic-shift-by-9. (range*delta fits comfortably in 53
 * bits — range<=511, delta in [-32768,32767] — so plain JS multiply is exact.)
 * @param {number} base
 * @param {number} delta
 * @param {number} range
 * @returns {number}
 */
function clampDeltaToRange(base, delta, range) {
  while (base + asr9(delta * range) > 64) delta--;
  while (base + asr9(delta * range) < 0) delta++;
  return delta;
}

// ---------------------------------------------------------------------------
// mas.c — Write_Instrument
// ---------------------------------------------------------------------------

/**
 * Faithful port of mas.c Write_Instrument.
 *
 * align32() first, capture parapointer (relative to MAS_OFFSET = 0 in this
 * buffer model), then the 8-byte header in the LIVE (reordered) field order,
 * the notemap selector u16, a reserved u16, the present envelopes, and (if a
 * full notemap is needed) the 240-byte notemap table.
 *
 * @param {ByteWriter} w  module-local writer (offset 0 == MAS_OFFSET)
 * @param {object} inst
 * @returns {number} parapointer (offset of this instrument, relative to MAS_OFFSET)
 */
function writeInstrument(w, inst) {
  w.align32();
  const parapointer = w.tell();

  // LIVE order (mas.c, not the commented-out block):
  w.write8(inst.global_volume & 0xff);
  w.write8(inst.fadeout & 0xff); // (u8)fadeout — low byte
  w.write8(inst.random_volume & 0xff);
  w.write8(inst.dct & 0xff);
  w.write8(inst.nna & 0xff);
  w.write8(inst.env_flags & 0xff);
  w.write8(inst.setpan & 0xff);
  w.write8(inst.dca & 0xff);

  // Notemap selector.
  const first_notemap_samp = inst.notemap[0] >> 8;
  let full_notemap = 0;
  for (let y = 0; y < 120; y++) {
    if (
      (inst.notemap[y] & 0xff) !== y ||
      inst.notemap[y] >> 8 !== first_notemap_samp
    ) {
      full_notemap = 1;
      break;
    }
  }

  if (full_notemap) {
    // byte offset to the notemap table within this instrument record
    w.write16(calcInstrumentSize(inst) & 0xffff);
  } else {
    // single-sample fast path: 0x8000 | sample_index
    w.write16((0x8000 | first_notemap_samp) & 0xffff);
  }

  w.write16(0); // reserved

  if (inst.env_flags & 1) writeInstrumentEnvelope(w, inst.envelope_volume);
  if (inst.env_flags & 2) writeInstrumentEnvelope(w, inst.envelope_pan);
  if (inst.env_flags & 4) writeInstrumentEnvelope(w, inst.envelope_pitch);

  if (full_notemap) {
    for (let y = 0; y < 120; y++) w.write16(inst.notemap[y] & 0xffff);
  }

  return parapointer;
}

// ---------------------------------------------------------------------------
// mas.c — Write_SampleData  (the GBA sample blob: header + PCM + 4-byte tail)
// ---------------------------------------------------------------------------

/**
 * Faithful port of mas.c Write_SampleData.
 *
 * GBA branch (the only one taken here): a 12-byte header (length u32, loop u32,
 * format u8 = U8 = 0, BA u8, freq-scale u16) followed by raw 8-bit unsigned PCM
 * and a 4-byte tail (loop-restart bytes if looped, else 0x80×4).
 *
 * The NDS / 16-bit branches are ported for completeness but never used for GBA.
 *
 * Incoming `samp.data` MUST already be unsigned-8-bit PCM for GBA (signed→
 * unsigned done upstream in the loader / samplefix). This function writes it
 * verbatim.
 *
 * @param {ByteWriter} w
 * @param {object} samp
 * @param {number} target SYSTEM_GBA or SYSTEM_NDS
 */
function writeSampleData(w, samp, target) {
  const sample_length = samp.sample_length >>> 0;
  const sample_looplen = (samp.loop_end - samp.loop_start) >>> 0;
  const data = samp.data;

  if (target === SYSTEM_GBA) {
    w.write32(sample_length);
    w.write32(samp.loop_type ? sample_looplen : 0xffffffff);
    w.write8(SAMP_FORMAT_U8); // 0
    w.write8(BYTESMASHER);
    // freq scale = (frequency*1024 + 7884) / 15768, rounded. Use exact integer
    // math via Math.trunc on a JS number (freq*1024 well within 2^53).
    w.write16(Math.trunc((samp.frequency * 1024 + 15768 / 2) / 15768) & 0xffff);
    // (the commented-out write32(0) in the C is NOT emitted on GBA)
  } else {
    // NDS branch (parity only).
    if (samp.format & SAMPF_16BIT) {
      if (samp.loop_type) {
        w.write32(Math.trunc(samp.loop_start / 2) >>> 0);
        w.write32(Math.trunc((samp.loop_end - samp.loop_start) / 2) >>> 0);
      } else {
        w.write32(0);
        w.write32(Math.trunc(sample_length / 2) >>> 0);
      }
    } else {
      if (samp.loop_type) {
        w.write32(Math.trunc(samp.loop_start / 4) >>> 0);
        w.write32(Math.trunc((samp.loop_end - samp.loop_start) / 4) >>> 0);
      } else {
        w.write32(0);
        w.write32(Math.trunc(sample_length / 4) >>> 0);
      }
    }
    w.write8(sample_dsformat(samp));
    w.write8(sample_dsreptype(samp));
    w.write16(Math.trunc((samp.frequency * 1024 + 32768 / 2) / 32768) & 0xffff);
    w.write32(0);
  }

  // ---- sample data + 4-byte padding tail ----
  if (samp.format & SAMPF_16BIT) {
    // 16-bit (NDS-only). samp.data is treated as an array of u16.
    for (let x = 0; x < sample_length; x++) w.write16(read16At(data, x));
    if (samp.loop_type && sample_length >= samp.loop_start + 2) {
      w.write16(read16At(data, samp.loop_start));
      w.write16(read16At(data, samp.loop_start + 1));
    } else {
      w.write16(0);
      w.write16(0);
    }
  } else {
    for (let x = 0; x < sample_length; x++) w.write8(data ? data[x] & 0xff : 0);
    if (samp.loop_type && sample_length >= samp.loop_start + 4) {
      w.write8(data[samp.loop_start + 0] & 0xff);
      w.write8(data[samp.loop_start + 1] & 0xff);
      w.write8(data[samp.loop_start + 2] & 0xff);
      w.write8(data[samp.loop_start + 3] & 0xff);
    } else {
      for (let x = 0; x < 4; x++) w.write8(target === SYSTEM_GBA ? 128 : 0);
    }
  }
}

/**
 * Read a u16 element at index `i` from a sample data buffer that may be a
 * Uint8Array of bytes (LE pairs) or a Uint16Array. Mirrors the C cast
 * `((u16*)samp->data)[i]`. GBA never uses this path.
 * @param {Uint8Array|Uint16Array|null} data
 * @param {number} i
 * @returns {number}
 */
function read16At(data, i) {
  if (!data) return 0;
  if (data instanceof Uint16Array) return data[i] & 0xffff;
  // Uint8Array: interpret as little-endian u16 pairs.
  const lo = data[i * 2] || 0;
  const hi = data[i * 2 + 1] || 0;
  return (lo | (hi << 8)) & 0xffff;
}

// ---------------------------------------------------------------------------
// mas.c — Write_Sample  (per-module sample-reference record)
// ---------------------------------------------------------------------------

/**
 * Faithful port of mas.c Write_Sample.
 *
 * align32() first, capture parapointer. Writes the 12-byte reference record.
 * If msl_index == 0xFFFF (standalone .mas mode, sample not pooled), inlines the
 * sample audio via Write_SampleData; in soundbank mode msl_index is a real
 * index and the audio lives once in the bank's sample section.
 *
 * @param {ByteWriter} w  module-local writer (offset 0 == MAS_OFFSET)
 * @param {object} samp
 * @param {number} target
 * @returns {number} parapointer relative to MAS_OFFSET
 */
function writeSample(w, samp, target) {
  w.align32();
  const parapointer = w.tell();

  w.write8(samp.default_volume & 0xff);
  w.write8(samp.default_panning & 0xff);
  w.write16(Math.trunc(samp.frequency / 4) & 0xffff);
  w.write8(samp.vibtype & 0xff);
  w.write8(samp.vibdepth & 0xff);
  w.write8(samp.vibspeed & 0xff);
  w.write8(samp.global_volume & 0xff);
  w.write16(samp.vibrate & 0xffff);

  w.write16(samp.msl_index & 0xffff);

  if (samp.msl_index === 0xffff) writeSampleData(w, samp, target);

  return parapointer;
}

// ---------------------------------------------------------------------------
// mas.c — Mark_Patterns / Mark_Pattern_Row  (compression-mark seeding)
// ---------------------------------------------------------------------------

/**
 * mas.c Mark_Pattern_Row: mark the target row of the pattern referenced by
 * order[order] (following 254 skips / 255 end) as a compression boundary.
 * @param {object} mod
 * @param {number} order
 * @param {number} row
 */
function markPatternRow(mod, order, row) {
  if (row >= 256) return;
  if (mod.orders[order] === 255) order = 0;
  while (mod.orders[order] >= 254) {
    if (mod.orders[order] === 255) return;
    if (mod.orders[order] === 254) order++;
  }
  const p = mod.patterns[mod.orders[order]];
  // The C dereferences unconditionally (the 255 end-marker keeps `order` in
  // range for well-formed modules). Guard defensively so a malformed order list
  // can never throw; ensure cmarks exists (calloc'd in the C Pattern struct).
  if (!p) return;
  if (!p.cmarks) p.cmarks = new Array(256).fill(false);
  p.cmarks[row] = true;
}

/**
 * mas.c Mark_Patterns: scan all played patterns for pattern-break (fx==3,
 * param!=0 → next pattern row=param) and the fx==19/param==0xB0 pattern-loop
 * case (same row), setting cmarks[] so Write_Pattern resets run-length state at
 * jump targets.
 * @param {object} mod
 */
function markPatterns(mod) {
  for (let o = 0; o < mod.order_count; o++) {
    const p = mod.orders[o];
    if (p === 255) break;
    if (p === 254) continue;
    if (p >= mod.patt_count) continue;
    const patt = mod.patterns[p];
    for (let row = 0; row < patt.nrows; row++) {
      for (let col = 0; col < MAX_CHANNELS; col++) {
        const pe = patt.data[row * MAX_CHANNELS + col];
        if (pe.fx === 3) {
          if (pe.param !== 0) markPatternRow(mod, o + 1, pe.param);
        } else if (pe.fx === 19) {
          if (pe.param === 0xb0) markPatternRow(mod, o, row);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// mas.c — Write_Pattern  (IT-style row compression)
// ---------------------------------------------------------------------------

/**
 * Faithful port of mas.c Write_Pattern.
 *
 * @param {ByteWriter} w  module-local writer (offset 0 == MAS_OFFSET)
 * @param {object} patt
 * @param {boolean} xm_vol  mod.xm_mode (selects emptyvol: 0 for XM, 255 else)
 * @returns {number} parapointer relative to MAS_OFFSET
 */
function writePattern(w, patt, xm_vol) {
  const parapointer = w.tell();
  w.write8((patt.nrows - 1) & 0xff);

  if (!patt.cmarks) patt.cmarks = new Array(256).fill(false);
  patt.cmarks[0] = true;
  const emptyvol = xm_vol ? 0 : 255;

  // running per-channel state (sentinel 256 != any byte value)
  const last_mask = new Array(MAX_CHANNELS).fill(256);
  const last_note = new Array(MAX_CHANNELS).fill(256);
  const last_inst = new Array(MAX_CHANNELS).fill(256);
  const last_vol = new Array(MAX_CHANNELS).fill(256);
  const last_fx = new Array(MAX_CHANNELS).fill(256);
  const last_param = new Array(MAX_CHANNELS).fill(256);

  for (let row = 0; row < patt.nrows; row++) {
    if (patt.cmarks[row]) {
      for (let col = 0; col < MAX_CHANNELS; col++) {
        last_mask[col] = 256;
        last_note[col] = 256;
        last_inst[col] = 256;
        last_vol[col] = 256;
        last_fx[col] = 256;
        last_param[col] = 256;
      }
    }
    for (let col = 0; col < MAX_CHANNELS; col++) {
      const pe = patt.data[row * MAX_CHANNELS + col];
      // empty-cell test
      if (
        pe.note === 250 &&
        pe.inst === 0 &&
        pe.vol === emptyvol &&
        pe.fx === 0 &&
        pe.param === 0
      ) {
        continue;
      }

      let maskvar = 0;
      let chanvar = col + 1;

      if (pe.note !== 250) maskvar |= 1 | 16;
      if (pe.inst !== 0) maskvar |= 2 | 32;
      if (pe.note > 250) maskvar &= ~(16 | 32); // note-off/cut clears start/reset
      if (pe.vol !== emptyvol) maskvar |= 4 | 64;
      if (pe.fx !== 0 || pe.param !== 0) maskvar |= 8 | 128;

      // run-length suppression
      if (maskvar & 1) {
        if (pe.note === last_note[col]) {
          maskvar &= ~1;
        } else {
          last_note[col] = pe.note;
          if (last_note[col] === 254 || last_note[col] === 255)
            last_note[col] = 256;
        }
      }
      if (maskvar & 2) {
        if (pe.inst === last_inst[col]) maskvar &= ~2;
        else last_inst[col] = pe.inst;
      }
      if (maskvar & 4) {
        if (pe.vol === last_vol[col]) maskvar &= ~4;
        else last_vol[col] = pe.vol;
      }
      if (maskvar & 8) {
        if (pe.fx === last_fx[col] && pe.param === last_param[col]) {
          maskvar &= ~8;
        } else {
          last_fx[col] = pe.fx;
          last_param[col] = pe.param;
        }
      }

      // mask-changed bit
      if (maskvar !== last_mask[col]) {
        chanvar |= 128;
        last_mask[col] = maskvar;
      }

      w.write8(chanvar & 0xff);
      if (chanvar & 128) w.write8(maskvar & 0xff);
      if (maskvar & 1) w.write8(pe.note & 0xff);
      if (maskvar & 2) w.write8(pe.inst & 0xff);
      if (maskvar & 4) w.write8(pe.vol & 0xff);
      if (maskvar & 8) {
        w.write8(pe.fx & 0xff);
        w.write8(pe.param & 0xff);
      }
    }
    w.write8(0); // end-of-row terminator
  }

  return parapointer;
}

// ---------------------------------------------------------------------------
// mas.c — Write_MAS  (full MAS module body)
// ---------------------------------------------------------------------------

/**
 * Faithful port of mas.c Write_MAS.
 *
 * Builds ONE module record into its own buffer, mirroring the temp-file model:
 * the record is `[u32 MAS_FILESIZE][u8 type][u8 ver][u8 BA][u8 BA][...MAS
 * payload...]`. The 8-byte preamble precedes MAS_OFFSET; all parapointers are
 * relative to MAS_OFFSET. Because MAS_OFFSET is at a fixed offset (8) and the
 * record is align32-placed again at export and copied verbatim, internal
 * alignment is self-consistent.
 *
 * @param {object} mod
 * @param {boolean} msl_dep  true for soundbank (sets header flag bit 0x10)
 * @param {number} target SYSTEM_GBA
 * @returns {Uint8Array} the complete module record (preamble + payload)
 */
export function writeMAS(mod, msl_dep, target = SYSTEM_GBA) {
  const w = new ByteWriter();

  // ---- 8-byte preamble (before MAS_OFFSET) ----
  w.write32(BYTESMASHER); // filesize placeholder → backpatched at MAS_OFFSET-8
  w.write8(MAS_TYPE_SONG);
  w.write8(MAS_VERSION);
  w.write8(BYTESMASHER);
  w.write8(BYTESMASHER);

  const MAS_OFFSET = w.tell(); // == 8

  // ---- header ----
  w.write8(mod.order_count & 0xff);
  w.write8(mod.inst_count & 0xff);
  w.write8(mod.samp_count & 0xff);
  w.write8(mod.patt_count & 0xff);
  w.write8(
    ((mod.link_gxx ? 1 : 0) |
      (mod.old_effects ? 2 : 0) |
      (mod.freq_mode ? 4 : 0) |
      (mod.xm_mode ? 8 : 0) |
      (msl_dep ? 16 : 0) |
      (mod.old_mode ? 32 : 0)) & 0xff,
  );
  w.write8(mod.global_volume & 0xff);
  w.write8(mod.initial_speed & 0xff);
  w.write8(mod.initial_tempo & 0xff);
  w.write8(mod.restart_pos & 0xff);
  w.write8(BYTESMASHER);
  w.write8(BYTESMASHER);
  w.write8(BYTESMASHER);

  for (let x = 0; x < MAX_CHANNELS; x++) w.write8(mod.channel_volume[x] & 0xff);
  for (let x = 0; x < MAX_CHANNELS; x++) w.write8(mod.channel_panning[x] & 0xff);

  // order list (exactly 200 bytes)
  let x = 0;
  for (x = 0; x < mod.order_count; x++) {
    if (mod.orders[x] < 254) {
      w.write8(mod.orders[x] < mod.patt_count ? mod.orders[x] : 254);
    } else {
      w.write8(mod.orders[x] & 0xff);
    }
  }
  for (; x < 200; x++) w.write8(255);

  // offset table: inst_count + samp_count + patt_count u32 placeholders (BA)
  const fpos_pointer = w.tell();
  const nOffsets = mod.inst_count + mod.samp_count + mod.patt_count;
  for (let i = 0; i < nOffsets * 4; i++) w.write8(BYTESMASHER);

  // ---- bodies ----
  const instPP = new Array(mod.inst_count);
  for (let i = 0; i < mod.inst_count; i++) {
    instPP[i] = writeInstrument(w, mod.instruments[i]) - MAS_OFFSET;
  }

  const sampPP = new Array(mod.samp_count);
  for (let i = 0; i < mod.samp_count; i++) {
    sampPP[i] = writeSample(w, mod.samples[i], target) - MAS_OFFSET;
  }

  markPatterns(mod);
  const pattPP = new Array(mod.patt_count);
  for (let i = 0; i < mod.patt_count; i++) {
    pattPP[i] = writePattern(w, mod.patterns[i], !!mod.xm_mode) - MAS_OFFSET;
  }

  w.align32(); // final pad

  // ---- finalize: filesize + offset table ----
  const MAS_FILESIZE = w.tell() - MAS_OFFSET;
  w.patch32(MAS_OFFSET - 8, MAS_FILESIZE);

  // parapointers, in order: instruments, samples, patterns
  w.seek(fpos_pointer);
  for (let i = 0; i < mod.inst_count; i++) w.write32(instPP[i]);
  for (let i = 0; i < mod.samp_count; i++) w.write32(sampPP[i]);
  for (let i = 0; i < mod.patt_count; i++) w.write32(pattPP[i]);

  return w.toUint8Array();
}

// ---------------------------------------------------------------------------
// msl.c — sample blob builder + dedup pool + soundbank assembly
// ---------------------------------------------------------------------------

/**
 * msl.c MSL_AddSample (single sample record, no dedup). Builds the temp-stream
 * sample record:
 *   [u32 file_size][u8 type][u8 ver][u8 sfx][u8 BA][Write_SampleData output]
 * where file_size = (16bit ? len*2 : len) + SAMPLE_HEADER_SIZE + 4.
 *
 * Returns the record bytes (size word + body); the body length is file_size+4.
 *
 * @param {object} samp
 * @param {number} target
 * @returns {{bytes:Uint8Array, file_size:number}}
 */
function buildSampleRecord(samp, target) {
  const w = new ByteWriter();
  const len = samp.sample_length >>> 0;
  const file_size =
    ((samp.format & SAMPF_16BIT ? len * 2 : len) + sampleHeaderSize(target) + 4) >>> 0;

  w.write32(file_size);
  w.write8(target === SYSTEM_GBA ? MAS_TYPE_SAMPLE_GBA : MAS_TYPE_SAMPLE_NDS);
  w.write8(MAS_VERSION);
  w.write8(sampleSfxFlag(samp));
  w.write8(BYTESMASHER);

  writeSampleData(w, samp, target);

  return { bytes: w.toUint8Array(), file_size };
}

/**
 * filename[0]=='#' → SFX flag 1, else 0 (msl.c MSL_AddSample).
 * @param {object} samp
 * @returns {number}
 */
function sampleSfxFlag(samp) {
  // The parsers store `filename` as a char[] (Uint8Array, faithful to mmutil's
  // C); a caller may also pass a JS string. Read byte 0 either way.
  const fn = samp.filename;
  if (!fn || fn.length === 0) return 0;
  const c0 = typeof fn === 'string' ? fn.charCodeAt(0) : fn[0];
  return c0 === 0x23 /* '#' */ ? 1 : 0;
}

/**
 * msl.c MSL_AddSampleC dedup test. Two samples pool together iff:
 *   sample_length equal AND
 *   (loop_type ? loop_end-loop_start : 0xFFFFFFFF) equal AND
 *   target format equal (GBA: always U8) AND
 *   PCM data identical (byte-for-byte, or u16-for-u16 in 16-bit).
 *
 * Compares against an already-added pool entry's stored sample.
 * @param {object} a candidate
 * @param {object} b pooled
 * @param {number} target
 * @returns {boolean}
 */
function samplesEqual(a, b, target) {
  if ((a.sample_length >>> 0) !== (b.sample_length >>> 0)) return false;
  const aLoop = (a.loop_type ? a.loop_end - a.loop_start : 0xffffffff) >>> 0;
  const bLoop = (b.loop_type ? b.loop_end - b.loop_start : 0xffffffff) >>> 0;
  if (aLoop !== bLoop) return false;
  // GBA target format is always U8 for both; on NDS compare dsformat.
  if (target === SYSTEM_NDS) {
    if (sample_dsformat(a) !== sample_dsformat(b)) return false;
  }
  // compare PCM
  const len = a.sample_length >>> 0;
  if (a.format & SAMPF_16BIT) {
    for (let i = 0; i < len; i++) {
      if (read16At(a.data, i) !== read16At(b.data, i)) return false;
    }
  } else {
    const ad = a.data;
    const bd = b.data;
    for (let i = 0; i < len; i++) {
      const av = ad ? ad[i] & 0xff : 0;
      const bv = bd ? bd[i] & 0xff : 0;
      if (av !== bv) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// msl.c — MSL_PrintDefinition  (.h #define name munging)
// ---------------------------------------------------------------------------

/**
 * msl.c MSL_PrintDefinition. Returns the `#define <prefix><NAME>\t<id>\r\n`
 * line, or '' for an empty filename (matches the C early-return).
 *
 * Name munging: take the basename (after last '/' or '\'), stop at the first
 * '.', uppercase, and replace every char in the ranges ' '..'/', ':'..'@',
 * '['..'`', '{'.. with '_'.
 *
 * @param {string} filename
 * @param {number} id
 * @param {string} prefix
 * @returns {string}
 */
export function printDefinition(filename, id, prefix) {
  if (!filename || filename.length === 0) return '';
  // basename
  let s = 0;
  for (let x = 0; x < filename.length; x++) {
    const c = filename[x];
    if (c === '\\' || c === '/') s = x + 1;
  }
  let name = '';
  for (let x = s; x < filename.length; x++) {
    let ch = filename[x];
    if (ch === '.') break;
    ch = ch.toUpperCase();
    const code = ch.charCodeAt(0);
    // ' '(0x20)..'/'(0x2F), ':'(0x3A)..'@'(0x40), '['(0x5B)..'`'(0x60), '{'(0x7B)..
    if (
      (code >= 0x20 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      code >= 0x7b
    ) {
      ch = '_';
    }
    name += ch;
  }
  return `#define ${prefix}${name}\t${id}\r\n`;
}

// ---------------------------------------------------------------------------
// msl.c — MSL_Export  (top-level soundbank assembly) + writeSoundbank()
// ---------------------------------------------------------------------------

/**
 * Pack a set of modules (and optional standalone WAV/SFX samples) into a Maxmod
 * GBA soundbank. Faithful to msl.c's MSL_AddModule + MSL_AddSampleC dedup +
 * MSL_Export + the .h emission in MSL_Create.
 *
 * Each module's referenced samples are pooled into a shared unique-sample list
 * (deduped exactly as MSL_AddSampleC does); each sample's msl_index is set to
 * its pool index before the module's MAS bytes are written. Standalone samples
 * (e.g. loaded WAVs) are passed in `samples`. As in msl.c (MSL_LoadFile → WAV →
 * MSL_AddSample, NOT MSL_AddSampleC), standalone samples are NOT deduplicated —
 * each gets its own pool slot — and each emits an SFX_ define.
 *
 * Ordering: mmutil pools samples in input/argv order. devkitPro projects
 * conventionally list SFX/WAV inputs first, so standalone `samples` are pooled
 * before any module samples here. If you need a different interleaving you must
 * order the pool yourself (call the lower-level writeMAS/buildSampleRecord).
 *
 * @param {object[]} modules  parsed MASModule objects (mod/xm/it/s3m), in the
 *   load order that determines MOD_ ids (0-based).
 * @param {(object|{samp:object,name?:string})[]} [samples]  standalone Sample
 *   objects to add to the bank (e.g. WAV-loaded SFX). May be a raw Sample, or
 *   `{samp, name}` where `name` (an input path/filename) is munged for the SFX_
 *   define. A raw Sample uses its own `filename` (minus a leading '#') for the
 *   define name and emits a define only when filename[0]=='#'.
 * @param {Object} [opts]
 * @param {number} [opts.target] SYSTEM_GBA (default) or SYSTEM_NDS.
 * @param {{filename?:string}[]} [opts.moduleMeta]  optional per-module metadata;
 *   moduleMeta[i].filename is used for the MOD_ #define name (basename munged).
 *   If omitted, module.title is used (or no define if empty).
 * @returns {{bin:Uint8Array, header:string}}
 */
export function writeSoundbank(modules, samples = [], opts = {}) {
  const target = opts.target ?? SYSTEM_GBA;
  const moduleMeta = opts.moduleMeta || [];

  // ---- pooled unique samples ----
  /** @type {{samp:object, record:Uint8Array, file_size:number}[]} */
  const pool = [];
  /** lines for the .h header */
  let header = '';

  /**
   * msl.c MSL_AddSampleC: add a module sample with dedup; returns its pool
   * index (the sample's msl_index).
   * @param {object} samp
   * @returns {number}
   */
  const addSampleC = (samp) => {
    for (let i = 0; i < pool.length; i++) {
      if (samplesEqual(samp, pool[i].samp, target)) return i;
    }
    const { bytes, file_size } = buildSampleRecord(samp, target);
    pool.push({ samp, record: bytes, file_size });
    return pool.length - 1;
  };

  /**
   * msl.c MSL_AddSample: add a standalone sample WITHOUT dedup (always a new
   * pool slot). Used for WAV/SFX inputs.
   * @param {object} samp
   * @returns {number}
   */
  const addSample = (samp) => {
    const { bytes, file_size } = buildSampleRecord(samp, target);
    pool.push({ samp, record: bytes, file_size });
    return pool.length - 1;
  };

  // ---- standalone samples (e.g. WAV SFX), pooled first, no dedup ----
  for (const entry of samples) {
    const samp = entry && entry.samp ? entry.samp : entry;
    const explicitName = entry && entry.samp ? entry.name : undefined;
    const id = addSample(samp);
    // SFX_ define: explicit name wins; else the sample's own filename (minus
    // a leading '#'). msl.c emits the define for every WAV input.
    let defName = explicitName;
    if (defName == null) {
      const fn = samp.filename || '';
      defName = sampleSfxFlag(samp) ? fn.slice(1) : '';
    }
    if (defName) header += printDefinition(defName, id, 'SFX_');
  }

  // ---- modules: pool their samples (assigning msl_index), then emit MAS ----
  /** @type {Uint8Array[]} */
  const moduleRecords = [];
  for (let m = 0; m < modules.length; m++) {
    const mod = modules[m];
    for (let x = 0; x < mod.samp_count; x++) {
      const samp = mod.samples[x];
      const sampId = addSampleC(samp);
      if (sampleSfxFlag(samp)) {
        const fn = (samp.filename || '').slice(1);
        header += printDefinition(fn, sampId, 'SFX_');
      }
      samp.msl_index = sampId;
    }
    // build the temp-stream module record [u32 filesize][type/ver/BA/BA][payload]
    moduleRecords.push(writeMAS(mod, true, target));

    // MOD_ define (id = module index)
    const meta = moduleMeta[m] || {};
    const defName =
      meta.filename != null ? meta.filename : mod.title != null ? mod.title : '';
    if (defName) header += printDefinition(defName, m, 'MOD_');
  }

  const MSL_NSAMPS = pool.length;
  const MSL_NSONGS = moduleRecords.length;

  // ---- MSL_Export: assemble the final .bin ----
  const w = new ByteWriter();
  w.write16(MSL_NSAMPS & 0xffff);
  w.write16(MSL_NSONGS & 0xffff);
  w.writeString('*maxmod*'); // magic 0x2A 6D 61 78 6D 6F 64 2A

  // reserve parapointer tables (placeholder 0xAAAAAAAA)
  const sampTableOff = w.tell(); // == 0x0C
  for (let i = 0; i < MSL_NSAMPS; i++) w.write32(0xaaaaaaaa);
  for (let i = 0; i < MSL_NSONGS; i++) w.write32(0xaaaaaaaa);

  const parap_samp = new Array(MSL_NSAMPS);
  const parap_song = new Array(MSL_NSONGS);

  // copy sample blobs
  for (let i = 0; i < MSL_NSAMPS; i++) {
    w.align32();
    parap_samp[i] = w.tell();
    const rec = pool[i].record; // [u32 file_size][body...]
    // read file_size (first u32 LE) then re-emit it + body (file_size+4 bytes)
    const file_size = rec[0] | (rec[1] << 8) | (rec[2] << 16) | (rec[3] << 24);
    w.write32(file_size >>> 0);
    // body is rec[4..], which is exactly file_size+4 bytes (record built that way)
    for (let y = 0; y < (file_size >>> 0) + 4; y++) w.write8(rec[4 + y]);
  }

  // copy module blobs
  for (let i = 0; i < MSL_NSONGS; i++) {
    w.align32();
    parap_song[i] = w.tell();
    const rec = moduleRecords[i]; // [u32 MAS_FILESIZE][type/ver/BA/BA][payload]
    const file_size = rec[0] | (rec[1] << 8) | (rec[2] << 16) | (rec[3] << 24);
    w.write32(file_size >>> 0);
    for (let y = 0; y < (file_size >>> 0) + 4; y++) w.write8(rec[4 + y]);
  }

  // backpatch parapointer tables (absolute file offsets)
  w.seek(sampTableOff);
  for (let i = 0; i < MSL_NSAMPS; i++) w.write32(parap_samp[i] >>> 0);
  for (let i = 0; i < MSL_NSONGS; i++) w.write32(parap_song[i] >>> 0);

  // ---- trailers (MSL_Create) ----
  header += `#define MSL_NSONGS\t${MSL_NSONGS}\r\n`;
  header += `#define MSL_NSAMPS\t${MSL_NSAMPS}\r\n`;
  header += `#define MSL_BANKSIZE\t${MSL_NSAMPS + MSL_NSONGS}\r\n`;

  return { bin: w.toUint8Array(), header };
}

export default writeSoundbank;

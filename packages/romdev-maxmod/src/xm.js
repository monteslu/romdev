/****************************************************************************
 * romdev-maxmod — xm.js
 *
 * Faithful pure-JS ESM port of mmutil's xm.c (FastTracker II .XM loader).
 * Original: Copyright (c) 2008, Mukunda Johnson (mukunda@maxmod.org).
 * This port mirrors the C byte-for-byte: same read order, same little-endian
 * decode, same edge cases. Where a detail is subtle, the C is quoted inline.
 *
 * Produces the shared in-memory "module model" (MAS_Module shape from mas.h)
 * that a single mas-emitter consumes for mod/xm/it/s3m alike.
 ****************************************************************************/

// ---------------------------------------------------------------------------
// Constants (defs.h / mas.h / systems.h)
// ---------------------------------------------------------------------------

/** defs.h: #define MAX_CHANNELS 32 */
export const MAX_CHANNELS = 32;

/** mas.h sample format flags. */
export const SAMPF_16BIT = 0x001;
export const SAMPF_SIGNED = 0x002;
export const SAMPF_COMP = 0x004;

/** mas.h: SAMP_FORMAT_U8 == 0, SAMP_FORMAT_U16 == SAMPF_16BIT. */
export const SAMP_FORMAT_U8 = 0;
export const SAMP_FORMAT_U16 = SAMPF_16BIT;

/** systems.h */
export const SYSTEM_GBA = 0;
export const SYSTEM_NDS = 1;

// errors.h-style sentinels. We throw instead of returning ints, but expose the
// names on the thrown error so callers can branch the same way the C did.
const ERR_INVALID_MODULE = 'ERR_INVALID_MODULE';
const ERR_UNKNOWNPATTERN = 'ERR_UNKNOWNPATTERN';
const ERR_TOOMANYSAMPLES = 'ERR_TOOMANYSAMPLES';

/**
 * @typedef {object} XmError
 * @property {string} code one of ERR_* above
 */

function makeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// Little-endian reader — exact analog of files.c read8/read16/read24/read32
// plus file_seek_read / file_tell_read / skip8.
//
// files.c read8() does fread of one byte; reads past EOF in C leave the
// destination's prior (often zero) value. We clamp to 0 past EOF, which matches
// the practical behavior for well-formed modules (the loader always seeks to a
// known header end before reading the next structure).
// ---------------------------------------------------------------------------

class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    /** @type {Uint8Array} */
    this.b = bytes;
    /** @type {number} */
    this.pos = 0;
  }

  /** files.c read8() */
  read8() {
    const p = this.pos;
    this.pos = p + 1;
    return p < this.b.length ? this.b[p] : 0;
  }

  /** files.c read16(): a = read8(); a |= read8()<<8;  (little-endian) */
  read16() {
    let a = this.read8();
    a |= this.read8() << 8;
    return a >>> 0 & 0xffff;
  }

  /** files.c read32(): a = read16(); a |= read16()<<16;  (little-endian) */
  read32() {
    let a = this.read16();
    a = (a | (this.read16() << 16)) >>> 0;
    return a;
  }

  /** files.c file_seek_read(offset, SEEK_SET) */
  seekSet(offset) {
    this.pos = offset;
  }

  /** files.c file_tell_read() */
  tell() {
    return this.pos;
  }

  /** files.c skip8(count) -> fseek(SEEK_CUR) */
  skip8(count) {
    this.pos += count;
  }
}

// ---------------------------------------------------------------------------
// Module-model factory helpers — these produce the shared shape that the
// mas-emitter (Write_MAS / Write_Instrument / Write_Sample / Write_Pattern)
// consumes. Field names mirror the mas.h structs exactly so the emitter is
// format-agnostic across mod/xm/it/s3m.
// ---------------------------------------------------------------------------

/**
 * @returns {object} Instrument_Envelope (mas.h tInstrument_Envelope), zeroed.
 * node_x[25] u16, node_y[25] u8, plus the loop/sus/count/filter fields.
 */
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

/**
 * @returns {object} Instrument (mas.h tInstrument), zeroed via memset(inst,0,...).
 * Note: memset zeroes everything; Load_XM_Instrument later overwrites the
 * fields it cares about. notemap is 120 entries of u16.
 */
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
    name: new Uint8Array(32),
    envelope_volume: newEnvelope(),
    envelope_pan: newEnvelope(),
    envelope_pitch: newEnvelope(),
  };
}

/**
 * @returns {object} Sample (mas.h tSample), zeroed via memset(samp,0,...).
 * `data` is null until decoded; then a Uint8Array (8-bit) or Uint16Array
 * (16-bit), exactly like the C `void* data` that holds u8* or u16*.
 */
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
    name: new Uint8Array(32),
    filename: new Uint8Array(12),
  };
}

/**
 * @returns {object} PatternEntry (mas.h tPatternEntry), zeroed.
 */
function newPatternEntry() {
  return { note: 0, inst: 0, vol: 0, fx: 0, param: 0 };
}

/**
 * @returns {object} Pattern (mas.h tPattern). data[] is MAX_CHANNELS*256
 * entries (the C declares PatternEntry data[MAX_CHANNELS*256]); memset(0)
 * zeroes them, then Load_XM_Pattern sets note=250 / vol=0 for each used cell.
 */
function newPattern() {
  const data = new Array(MAX_CHANNELS * 256);
  for (let i = 0; i < data.length; i++) data[i] = newPatternEntry();
  return {
    parapointer: 0,
    nrows: 0,
    clength: 0,
    data,
    cmarks: new Array(256).fill(false),
  };
}

/**
 * @returns {object} MAS_Module (mas.h tMAS_Module), zeroed via memset.
 */
function newModule() {
  return {
    title: new Uint8Array(32),
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
}

// ---------------------------------------------------------------------------
// Small integer-cast helpers matching C truncation semantics.
// ---------------------------------------------------------------------------

/** (s8) cast: interpret low byte as signed 8-bit. */
function s8(v) {
  v &= 0xff;
  return v >= 0x80 ? v - 0x100 : v;
}

/** (u8) cast. */
function u8c(v) {
  return v & 0xff;
}

// ---------------------------------------------------------------------------
// Get_XM_Frequency (xm.c) — middle C scaled by relnote semitones + finetune.
//
//   middle_c = 8363.0;
//   freq = middle_c * pow(2, (1/12)*rn + (1/(12*128))*ft);
//   return (int)freq;     // truncation toward zero
// ---------------------------------------------------------------------------

/**
 * @param {number} relnote signed relative note (s8)
 * @param {number} finetune signed finetune (s8)
 * @returns {number} middle-C frequency in Hz (truncated to int)
 */
export function Get_XM_Frequency(relnote, finetune) {
  const rn = relnote;
  const ft = finetune;
  const middle_c = 8363.0;
  const freq = middle_c * Math.pow(2.0, (1.0 / 12.0) * rn + (1.0 / (12.0 * 128.0)) * ft);
  // (int)freq in C truncates toward zero. freq is always > 0 here.
  return Math.trunc(freq);
}

// ---------------------------------------------------------------------------
// CONV_XM_EFFECT (xm.c) — translate an XM effect (fx,param) into the internal
// IT-style command set the emitter expects. 'X'-cho where cho=64 maps an ASCII
// letter to its 1-based command index ('A'-64 == 1, ... 'Z'-64 == 26). The
// numeric commands 27/28/29/30 are the IT "compatibility / special" set.
//
// Returns a new [fx, param] pair (the C mutates via pointers).
// ---------------------------------------------------------------------------

const cho = 64; // #define cho 64

/**
 * @param {number} fxIn effect type byte
 * @param {number} paramIn effect parameter byte
 * @returns {[number, number]} converted [fx, param]
 */
export function CONV_XM_EFFECT(fxIn, paramIn) {
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
      // C stores the pattern-break row in decimal-coded form:
      //   wpm = (wpm&0xF) + (wpm>>4) * 10;
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
          wpm = wpm; // (C: wpm = wpm;)
          break;
        case 0: // set filter
          wfx = 0;
          wpm = 0;
          break;
        // NOTE: the C 'case 15' and 'case 0' fall through with no `break` on
        // case 0 in the source, but case 0 is the last label so it's a no-op.
        default:
          break;
      }
      break;

    case 0xf: // Fxx set speed
      if (wpm >= 32) wfx = 'T'.charCodeAt(0) - cho;
      else wfx = 'A'.charCodeAt(0) - cho;
      break;

    case 16: // Gxx set global volume
      wfx = 'V'.charCodeAt(0) - cho;
      wpm = wpm;
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
      if (wpm >> 4 === 1) {
        wfx = 'F'.charCodeAt(0) - cho;
        wpm = 0xe0 | (wpm & 0xf);
      } else if (wpm >> 4 === 2) {
        wfx = 'E'.charCodeAt(0) - cho;
        wpm = 0xe0 | (wpm & 0xf);
      } else {
        wfx = 0;
        wpm = 0;
      }
      break;

    default:
      break;
  }

  return [u8c(wfx), u8c(wpm)];
}

// ---------------------------------------------------------------------------
// Load_XM_Instrument (xm.c)
//
// Reads one instrument header, its note->sample map, vol/pan envelopes, then
// all of its sample headers, then all of its sample bodies (delta-decoded).
// Mutates `mas.samples[ns..ns+nsamples]` and advances `nextSample`.
// ---------------------------------------------------------------------------

/**
 * @param {object} inst Instrument model to fill (already created/zeroed)
 * @param {object} mas the module model (provides .samples array)
 * @param {{value:number}} nextSampleRef boxed *p_nextsample (u8)
 * @param {Reader} r
 * @param {(samp:object)=>void} [fixSample] optional FixSample hook (samplefix.c)
 */
function Load_XM_Instrument(inst, mas, nextSampleRef, r, fixSample) {
  const ns = nextSampleRef.value; // ns = *p_nextsample;

  // memset(inst,0,...) already done by newInstrument(); inst is fresh.

  const inst_headstart = r.tell();
  const inst_size = r.read32();

  for (let x = 0; x < 22; x++) inst.name[x] = r.read8(); // instrument name (22 bytes)

  r.read8(); // instrument type, SUPPOSED TO ALWAYS BE 0...
  const nsamples = r.read16();

  if (nsamples > 0) {
    const samp_headsize = r.read32();

    // read sample map (96 entries map notes 12..107):
    //   inst->notemap[x+12] = ((read8()+ns+1)*256) | (x+12);
    for (let x = 0; x < 96; x++) {
      inst.notemap[x + 12] = (((r.read8() + ns + 1) * 256) | (x + 12)) & 0xffff;
    }
    // Below note range (0..11) and above (96..119) clamp to entry 12's sample,
    // keeping their own note byte:
    //   inst->notemap[x] = (inst->notemap[12]&0xFF00) | x;
    for (let x = 0; x < 12; x++) {
      inst.notemap[x] = ((inst.notemap[12] & 0xff00) | x) & 0xffff;
    }
    for (let x = 96; x < 120; x++) {
      inst.notemap[x] = ((inst.notemap[12] & 0xff00) | x) & 0xffff;
    }

    // 12 volume-envelope nodes: node_x = read16, node_y = (u8)read16
    for (let x = 0; x < 12; x++) {
      inst.envelope_volume.node_x[x] = r.read16();
      inst.envelope_volume.node_y[x] = u8c(r.read16());
    }
    // 12 panning-envelope nodes
    for (let x = 0; x < 12; x++) {
      inst.envelope_pan.node_x[x] = r.read16();
      inst.envelope_pan.node_y[x] = u8c(r.read16());
    }

    inst.global_volume = 128;
    inst.envelope_volume.node_count = r.read8();
    inst.envelope_pan.node_count = r.read8();
    // sus_start == sus_end == one byte (assigned together in the C):
    inst.envelope_volume.sus_start = inst.envelope_volume.sus_end = r.read8();
    inst.envelope_volume.loop_start = r.read8();
    inst.envelope_volume.loop_end = r.read8();
    inst.envelope_pan.sus_start = inst.envelope_pan.sus_end = r.read8();
    inst.envelope_pan.loop_start = r.read8();
    inst.envelope_pan.loop_end = r.read8();

    const volbits = r.read8();
    const panbits = r.read8();

    inst.env_flags = 0;
    if (volbits & 1) inst.env_flags |= 1 | 8; // vol env present -> bits 0 and 3
    if (panbits & 1) inst.env_flags |= 2; // pan env present -> bit 1

    // If sustain not enabled, mark sus points as 255 (disabled):
    if (!(volbits & 2)) inst.envelope_volume.sus_start = inst.envelope_volume.sus_end = 255;
    if (!(panbits & 2)) inst.envelope_pan.sus_start = inst.envelope_pan.sus_end = 255;
    // If loop not enabled, mark loop points as 255 (disabled):
    if (!(volbits & 4)) inst.envelope_volume.loop_start = inst.envelope_volume.loop_end = 255;
    if (!(panbits & 4)) inst.envelope_pan.loop_start = inst.envelope_pan.loop_end = 255;

    const vibtype = r.read8();
    // vibsweep = 32768 / (read8()+1);  -- integer division, stored in u8
    const vibsweep = u8c(Math.trunc(32768 / (r.read8() + 1)));
    const vibdepth = r.read8();
    const vibrate = r.read8();
    // inst->fadeout = read16()/32;  (u16, then /32 integer)
    inst.fadeout = Math.trunc(r.read16() / 32) & 0xffff;

    // Skip to end of the instrument header before reading sample headers.
    r.seekSet(inst_headstart + inst_size);

    // read sample headers
    for (let x = 0; x < nsamples; x++) {
      if (ns + x >= 256) throw makeError(ERR_TOOMANYSAMPLES, 'too many samples');
      const samp_headstart = r.tell();
      const samp = newSample(); // memset(samp,0,...)
      mas.samples[ns + x] = samp;

      samp.msl_index = 0xffff;
      samp.sample_length = r.read32();
      samp.loop_start = r.read32();
      samp.loop_end = (r.read32() + samp.loop_start) >>> 0; // loop_end = read32()+loop_start
      samp.default_volume = r.read8();
      samp.global_volume = 64;

      samp.vibtype = vibtype;
      samp.vibdepth = vibdepth;
      samp.vibspeed = vibrate; // C: samp->vibspeed = vibrate;
      samp.vibrate = vibsweep; // C: samp->vibrate = vibsweep;

      const finetune = s8(r.read8());
      const loopbits = r.read8();
      // default_panning = (read8()>>1) | 128;
      samp.default_panning = ((r.read8() >> 1) | 128) & 0xff;
      const relnote = s8(r.read8());
      r.read8(); // reserved

      for (let y = 0; y < 22; y++) {
        samp.name[y] = r.read8();
        if (y < 12) samp.filename[y] = samp.name[y];
      }

      samp.frequency = Get_XM_Frequency(relnote, finetune);

      // 16-bit flag is bit 4 (0x10) of loopbits:
      //   samp->format = loopbits & 16 ? SAMP_FORMAT_U16 : SAMP_FORMAT_U8;
      samp.format = loopbits & 16 ? SAMP_FORMAT_U16 : SAMP_FORMAT_U8;
      if (samp.format & SAMPF_16BIT) {
        // lengths in the header are byte counts; halve them for 16-bit samples.
        samp.sample_length = Math.trunc(samp.sample_length / 2) >>> 0;
        samp.loop_start = Math.trunc(samp.loop_start / 2) >>> 0;
        samp.loop_end = Math.trunc(samp.loop_end / 2) >>> 0;
      }
      samp.loop_type = loopbits & 3;

      r.seekSet(samp_headstart + samp_headsize);
    }

    // read sample bodies (delta-decoded)
    for (let x = 0; x < nsamples; x++) {
      const samp = mas.samples[ns + x];
      if (samp.sample_length === 0) continue;

      let sample_old = 0;
      if (samp.format & SAMPF_16BIT) {
        // 16-bit delta decode:
        //   sample_old = (s16)((s16)read16() + sample_old);
        //   data[t] = sample_old + 32768;   (stored unsigned, +32768 bias)
        const data = new Uint16Array(samp.sample_length);
        for (let t = 0; t < samp.sample_length; t++) {
          // (s16)read16(): sign-extend the 16-bit delta.
          let delta = r.read16();
          if (delta >= 0x8000) delta -= 0x10000;
          // (s16)(delta + sample_old): wrap to signed 16-bit (this wrap is
          // intentional and load-bearing — matches the C running accumulator).
          let acc = (delta + sample_old) & 0xffff;
          if (acc >= 0x8000) acc -= 0x10000;
          sample_old = acc;
          data[t] = (sample_old + 32768) & 0xffff;
        }
        samp.data = data;
      } else {
        // 8-bit delta decode:
        //   sample_old = (s8)((s8)read8() + sample_old);
        //   data[t] = sample_old + 128;   (stored unsigned, +128 bias)
        const data = new Uint8Array(samp.sample_length);
        for (let t = 0; t < samp.sample_length; t++) {
          // (s8)read8(): sign-extend the 8-bit delta.
          let delta = r.read8();
          if (delta >= 0x80) delta -= 0x100;
          // (s8)(delta + sample_old): wrap to signed 8-bit.
          let acc = (delta + sample_old) & 0xff;
          if (acc >= 0x80) acc -= 0x100;
          sample_old = acc;
          data[t] = (sample_old + 128) & 0xff;
        }
        samp.data = data;
      }

      // The C unconditionally calls FixSample(samp) here. FixSample lives in
      // samplefix.c and is target-system dependent (GBA: 8-bit-down + loop
      // unroll/BIDI; NDS: signing/ADPCM). It is a SEPARATE mmutil module, so we
      // only invoke it when the caller injects it. Default: leave the raw
      // delta-decoded sample (16-bit u16+32768 / 8-bit u8+128) for the emitter
      // pipeline to fix. See parseXm options.fixSample.
      if (fixSample) fixSample(samp);
    }

    nextSampleRef.value = (ns + nsamples) & 0xff; // *p_nextsample = ns+nsamples;
  } else {
    // No samples: just skip past the instrument header.
    r.seekSet(inst_headstart + inst_size);
  }
}

// ---------------------------------------------------------------------------
// Load_XM_Pattern (xm.c)
// ---------------------------------------------------------------------------

/**
 * @param {object} patt Pattern model (fresh / will be reset)
 * @param {number} nchannels number of channels in the module
 * @param {Reader} r
 */
function Load_XM_Pattern(patt, nchannels, r) {
  const headstart = r.tell();
  const headsize = r.read32();

  if (r.read8() !== 0) throw makeError(ERR_UNKNOWNPATTERN, 'unknown pattern packing type');

  // memset(patt,0,...) — emulate by resetting the relevant fields. (patt was
  // freshly created via newPattern(), so cmarks/data are already zero; reset
  // anyway to mirror the C exactly.)
  for (let i = 0; i < patt.data.length; i++) {
    const e = patt.data[i];
    e.note = 0;
    e.inst = 0;
    e.vol = 0;
    e.fx = 0;
    e.param = 0;
  }
  patt.cmarks.fill(false);
  patt.parapointer = 0;
  patt.clength = 0;

  patt.nrows = r.read16();
  const clength = r.read16();

  // Initialize every used cell across ALL channels: note=250 ("no note"),
  // vol=0. (xm.c loops row<nrows*MAX_CHANNELS.)
  for (let row = 0; row < patt.nrows * MAX_CHANNELS; row++) {
    patt.data[row].note = 250;
    patt.data[row].vol = 0;
  }

  r.seekSet(headstart + headsize);

  if (clength === 0) {
    // pattern is empty
    return;
  }

  // read pattern data
  for (let row = 0; row < patt.nrows; row++) {
    for (let col = 0; col < nchannels; col++) {
      const e = row * MAX_CHANNELS + col;
      const cell = patt.data[e];
      const b = r.read8();

      let fx = 0;
      let param = 0;

      if (b & 128) {
        // packed
        if (b & 1) {
          // bit 0: Note follows
          cell.note = r.read8(); // (1-96, 1 = C-0); 97 = key-off
          if (cell.note === 97) cell.note = 255;
          else cell.note = (cell.note + 12 - 1) & 0xff; // shift to internal note range
        }
        if (b & 2) cell.inst = r.read8(); // bit 1: Instrument follows
        if (b & 4) cell.vol = r.read8(); // bit 2: Volume column byte follows
        if (b & 8) fx = r.read8();
        else fx = 0;
        if (b & 16) param = r.read8();
        else param = 0;

        if (fx !== 0 || param !== 0) {
          const conv = CONV_XM_EFFECT(fx, param);
          cell.fx = conv[0];
          cell.param = conv[1];
        }
      } else {
        // unpacked: all five fields present, b IS the note byte.
        cell.note = b; // (1-96, 1 = C-0); 97 = key-off
        if (cell.note === 97) cell.note = 255;
        else cell.note = (cell.note + 12 - 1) & 0xff;
        cell.inst = r.read8();
        cell.vol = r.read8();
        fx = r.read8();
        param = r.read8();
        const conv = CONV_XM_EFFECT(fx, param);
        cell.fx = conv[0];
        cell.param = conv[1];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Load_XM (xm.c) — top-level loader. Exposed as parseXm().
// ---------------------------------------------------------------------------

/**
 * Parse a FastTracker II .XM into the shared module model.
 *
 * @param {Uint8Array} bytes raw .xm file contents
 * @param {object} [options]
 * @param {(samp:object)=>void} [options.fixSample] optional FixSample hook
 *   (faithful to xm.c which calls FixSample(samp) per sample). Omit to keep raw
 *   delta-decoded samples for a later/external samplefix pass.
 * @returns {object} MAS_Module-shaped module model
 */
export function parseXm(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('parseXm expects a Uint8Array');
  }
  const fixSample = options.fixSample;
  const r = new Reader(bytes);
  const mod = newModule(); // memset(mod,0,...)

  mod.old_effects = true;
  mod.xm_mode = true;
  mod.global_volume = 64;
  mod.old_mode = false;

  // Signature check. The C reads four u32s and compares against little-endian
  // packed ASCII literals:
  //   'etxE' == "Exte", 'dedn' == "nded", 'doM ' == " Mod", ':elu' == "ule:"
  // then read8() must be ' ' (space). Full string: "Extended Module: ".
  // We compare the decoded u32s to the same packed constants.
  const sig0 = r.read32();
  const sig1 = r.read32();
  const sig2 = r.read32();
  const sig3 = r.read32();
  const sig4 = r.read8();
  // 'etxE' = 0x65|0x74<<8|0x78<<16|0x45<<24 = bytes 'E','x','t','e'
  if (
    sig0 !== packLE('Exte') ||
    sig1 !== packLE('nded') ||
    sig2 !== packLE(' Mod') ||
    sig3 !== packLE('ule:') ||
    sig4 !== 0x20 /* ' ' */
  ) {
    throw makeError(ERR_INVALID_MODULE, 'not an Extended Module (bad signature)');
  }

  for (let x = 0; x < 20; x++) mod.title[x] = r.read8(); // 20-byte title

  if (r.read8() !== 0x1a) throw makeError(ERR_INVALID_MODULE, 'missing 0x1A after title');

  r.skip8(20); // tracker name
  const xm_version = r.read16(); // unused beyond verbose print
  void xm_version;
  const xm_headsize = r.read32();
  mod.order_count = u8c(r.read16());
  mod.restart_pos = u8c(r.read16());
  const xm_nchannels = r.read16();
  mod.patt_count = u8c(r.read16());
  mod.inst_count = u8c(r.read16());
  mod.freq_mode = r.read16() & 1 ? true : false; // flags: bit0 = linear freq
  mod.initial_speed = u8c(r.read16());
  mod.initial_tempo = u8c(r.read16());

  for (let x = 0; x < 32; x++) {
    mod.channel_volume[x] = 64;
    mod.channel_panning[x] = 128;
  }

  // Read order table. The C reads 200 bytes total: real orders for indices
  // < order_count, otherwise it still consumes a byte but stores 255.
  let x = 0;
  for (x = 0; x < 200; x++) {
    if (x < mod.order_count) {
      mod.orders[x] = r.read8();
    } else {
      r.read8();
      mod.orders[x] = 255;
    }
  }
  // skip 200->255 (consume, discard)
  for (; x < 256; x++) r.read8();

  // Seek to the documented header end. (xm.c: "or maybe 60..")
  r.seekSet(60 + xm_headsize);

  // patterns
  mod.patterns = new Array(mod.patt_count);
  for (let i = 0; i < mod.patt_count; i++) {
    mod.patterns[i] = newPattern();
    Load_XM_Pattern(mod.patterns[i], xm_nchannels, r);
  }

  // instruments + samples
  mod.instruments = new Array(mod.inst_count);
  // The C allocates samples[256] up front; we use a sparse array sized to 256.
  mod.samples = new Array(256);
  const nextSampleRef = { value: 0 };

  for (let i = 0; i < mod.inst_count; i++) {
    mod.instruments[i] = newInstrument();
    Load_XM_Instrument(mod.instruments[i], mod, nextSampleRef, r, fixSample);
  }

  mod.samp_count = nextSampleRef.value;

  // Trim the samples array to the actually-used count so the emitter and the
  // shared model see exactly samp_count entries (the C keeps the 256-slot
  // buffer but only iterates samp_count). Any unfilled leading slots stay as
  // freshly-zeroed samples to preserve index alignment.
  for (let i = 0; i < mod.samp_count; i++) {
    if (!mod.samples[i]) mod.samples[i] = newSample();
  }
  mod.samples.length = mod.samp_count;

  return mod;
}

/**
 * Pack a 4-char ASCII string into a little-endian u32, matching how the C
 * multi-char literals ('etxE' etc.) compare against read32(). In C a
 * multi-char constant 'etxE' is big-endian-packed (E is the high byte), and
 * read32() reads bytes E,x,t,e low-to-high — so the comparison holds when we
 * pack the *file order* string "Exte" little-endian here.
 *
 * @param {string} s exactly 4 ASCII chars in file order
 * @returns {number} little-endian u32
 */
function packLE(s) {
  return (
    (s.charCodeAt(0) |
      (s.charCodeAt(1) << 8) |
      (s.charCodeAt(2) << 16) |
      (s.charCodeAt(3) << 24)) >>>
    0
  );
}

export default parseXm;

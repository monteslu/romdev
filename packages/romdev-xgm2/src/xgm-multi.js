// Port of sgdk.xgm2tool.format.XGMMulti — merge many XGM tracks into one multi-track XGM2 file.

import { align, alignBytes } from "./util.js";

// XGMSample.XGM_FULL_RATE in the Java source (mirrors the module-local const in
// xgm-sample.js, which does not re-export it as a static field). Value: 13300.
const XGM_FULL_RATE = 13300;

/**
 * Multi-track XGM container. Merges a list of {@link XGM} tracks into a single
 * XGM2 multi-track binary, sharing/deduplicating PCM samples across tracks.
 *
 * A multi XGM file supports a maximum of 252-1 = 251 samples (that don't let
 * much free slots to SFX when 251 samples are used).
 */
export class XGMMulti {
  /**
   * @param {Array<import("./xgm.js").XGM>} xgms list of XGM tracks (mutated in place)
   * @param {boolean} pack whether FM/PSG/GD3 data blocks are packed
   */
  constructor(xgms, pack) {
    if (!XGMMulti.silent)
      console.log("Converting " + xgms.length + " XGM to multi tracks XGM...");

    /** @type {Array<import("./xgm.js").XGM>} */
    this.xgms = xgms;
    /** @type {Array<XGMSample>} */
    this.sharedSamples = [];
    /** @type {boolean} */
    this.packed = pack;

    /** @type {boolean} */
    this.pal = false;
    /** @type {boolean} */
    this.hasGD3 = false;

    // just for user information
    this.mergedSample = 0;

    if (xgms.length > 128) {
      console.error(
        "Warning: multi tracks XGM is limited to 128 tracks max (" +
          (xgms.length - 128) +
          " tracks will be ignored)!"
      );

      // remove all tracks above 128
      while (xgms.length > 128) xgms.splice(xgms.length - 1, 1);
    }

    this.hasGD3 = false;
    /** @type {boolean|null} */
    let p = null;

    // set pal / hasGD3 flags
    for (const xgm of xgms) {
      if (p === null) p = xgm.pal;
      else if (p !== xgm.pal) {
        console.error("Warning: multi tracks XGM cannot mix PAL and NTSC tracks");
        // select NTSC by default
        p = false;
      }

      if (xgm.gd3 != null || xgm.xd3 != null) this.hasGD3 = true;
    }

    // set pal
    this.pal = p != null ? p : false;

    // build shared samples and update XGM according
    this.mergedSample = 0;
    for (const xgm of xgms) {
      for (const sample of xgm.samples) this.mergeSample(sample, xgm);

      xgm.rebuildFMCommands();
    }

    if (!XGMMulti.silent) {
      try {
        console.log("FM data size: " + this.getTotalFMMusicDataSize());
        console.log("PSG data size: " + this.getTotalPSGMusicDataSize());
      } catch (e) {
        //
      }

      console.log("PCM data size: " + this.getPCMDataSize());
      console.log(
        "Number of sample = " +
          this.sharedSamples.length +
          " (" +
          this.mergedSample +
          " merged samples)"
      );
    }
  }

  /**
   * @param {XGMSample} sample
   * @returns {XGMSample|null}
   */
  findMatchingSample(sample) {
    /** @type {XGMSample|null} */
    let bestMatch = null;
    let bestScore = 0;

    for (const s of this.sharedSamples) {
      if (s !== sample) {
        const score = s.getSimilarityScore(sample);
        if (score > bestScore) {
          bestMatch = s;
          bestScore = score;
        }
      }
    }

    // accept only if score >= 1
    if (bestScore >= 1) return bestMatch;

    return null;
  }

  /**
   * @param {XGMSample} sample
   * @param {import("./xgm.js").XGM} xgm
   */
  mergeSample(sample, xgm) {
    // find if already exist
    const matchingSample = this.findMatchingSample(sample);

    // we already have the sample ?
    if (matchingSample != null) {
      const sameDuration =
        Math.round(sample.getLength() / 60) === Math.round(matchingSample.getLength() / 60);
      // update VGM so it now uses the matching sample id
      xgm.updateSampleCommands(
        sample.id,
        matchingSample.id,
        sameDuration ? -1 : Math.trunc((sample.getLength() * 44100) / XGM_FULL_RATE)
      );

      this.mergedSample++;
      if (XGMMulti.verbose)
        console.log("Found duplicated sample #" + sample.id + " (merged)");
    } else {
      // maximum number of sample reached ?
      if (this.sharedSamples.length >= 249 - 1) {
        console.error(
          "Warning: multi tracks XGM is limited to 248 samples max, some samples will be lost !"
        );
        return;
      }

      // just add the sample
      this.sharedSamples.push(sample);

      const newId = this.sharedSamples.length;
      // update VGM so it now uses the new sample id
      xgm.updateSampleCommands(sample.id, newId, -1);
      // update sample id
      sample.id = newId;
    }
  }

  // consider packed flag and align size on 256 bytes
  /** @returns {number} */
  getTotalPSGMusicDataSize() {
    let result = 0;

    if (this.packed) {
      for (const xgm of this.xgms) result += align(xgm.getPackedPSGMusicDataSize(), 256);
    } else {
      for (const xgm of this.xgms) result += align(xgm.getPSGMusicDataSize(), 256);
    }

    return result;
  }

  // consider packed flag and align size on 256 bytes
  /** @returns {number} */
  getTotalFMMusicDataSize() {
    let result = 0;

    if (this.packed) {
      for (const xgm of this.xgms) result += align(xgm.getPackedFMMusicDataSize(), 256);
    } else {
      for (const xgm of this.xgms) result += align(xgm.getFMMusicDataSize(), 256);
    }

    return result;
  }

  /** @returns {number} */
  getPCMDataSize() {
    let result = 0;

    for (const sample of this.sharedSamples) result += sample.data.length;

    return result;
  }

  /** @returns {Uint8Array} */
  getPCMDataArray() {
    /** @type {number[]} */
    const result = [];

    for (let s = 0; s < this.sharedSamples.length; s++) {
      const copy = Uint8Array.from(this.sharedSamples[s].data);

      // sign the sample
      for (let i = 0; i < copy.length; i++) copy[i] = (copy[i] + 0x80) & 0xff;

      for (let i = 0; i < copy.length; i++) result.push(copy[i]);
    }

    return Uint8Array.from(result);
  }

  /** @returns {Uint8Array} */
  asByteArray() {
    let offset;
    let data;
    let len;
    /** @type {number[]} */
    const result = [];

    // 0000: XGM2 (ignored when compiled in ROM)
    if (!this.packed) {
      result.push(0x58, 0x47, 0x4d, 0x32); // "XGM2"
    }

    // 0004: version (0x10 currently)
    result.push(0x10);

    // 0005: format description (see xgm2.txt)
    data = 0;
    // bit #0: NTSC / PAL information: 0=NTSC 1=PAL
    if (this.pal) data |= 1;
    // bit #1: multi tracks file: 0=No 1=Yes (always 1 here)
    data |= 2;
    // bit #2: GD3 tags: 0=No 1=Yes
    if (this.hasGD3) data |= 4;
    // bit #3: packed FM / PSG / GD3 data blocks: 0=No 1=Yes
    if (this.packed) data |= 8;
    // write format
    result.push(data & 0xff);

    // 0006-0007: SLEN = Sample data bloc size / 256 (ex: $0200 means 512*256 = 131072 bytes)
    data = align(this.getPCMDataSize(), 256) >> 8;
    result.push((data >> 0) & 0xff);
    result.push((data >> 8) & 0xff);
    // 0008-0009: FMLEN = FM music data block size / 256 (ex: $0040 means 64*256 = 16384 bytes)
    data = this.getTotalFMMusicDataSize() >> 8;
    result.push((data >> 0) & 0xff);
    result.push((data >> 8) & 0xff);
    // 000A-000B: PSGLEN = PSG music data block size / 256 (ex: $0020 means 32*256 = 8192 bytes)
    data = this.getTotalPSGMusicDataSize() >> 8;
    result.push((data >> 0) & 0xff);
    result.push((data >> 8) & 0xff);

    // 000C-0203: SID (sample id) table
    // size = 512-8 = 504 bytes so end of table will align on 256 bytes in ROM
    offset = 0;
    for (let s = 0; s < this.sharedSamples.length; s++) {
      const sample = this.sharedSamples[s];
      len = sample.data.length;

      // each entry of the table consist of 2 bytes for the address:
      // entry+$0: sample address / 256
      result.push((offset >> 8) & 0xff);
      result.push((offset >> 16) & 0xff);
      offset += len;
    }
    // required to get last sample size
    result.push((offset >> 8) & 0xff);
    result.push((offset >> 16) & 0xff);
    // fill with silent mark
    for (let s = this.sharedSamples.length + 1; s < 504 / 2; s++) {
      result.push(0xff);
      result.push(0xff);
    }

    // 0204-0303: FMID (FM track id) table (multi-tracks)
    // contain address for FM music data tracks (fixed size = 256 bytes = 128 entries)
    offset = 0;
    for (const xgm of this.xgms) {
      // each entry of the table consist of 2 bytes for address (FM data track size is aligned to 256 bytes)
      // entry+$0: FM data track address / 256
      result.push((offset >> 0) & 0xff);
      result.push((offset >> 8) & 0xff);

      // next track (align on 256 bytes)
      offset +=
        align(this.packed ? xgm.getPackedFMMusicDataSize() : xgm.getFMMusicDataSize(), 256) >> 8;
    }
    for (let i = this.xgms.length; i < 128; i++) {
      result.push(0xff);
      result.push(0xff);
    }

    // 0304-0403: PSGID (PSG track id) table (multi-tracks)
    // contain address for PSG music data tracks (fixed size = 256 bytes = 128 entries)
    offset = 0;
    for (const xgm of this.xgms) {
      // each entry of the table consist of 2 bytes for address (PSG data track size is aligned to 256 bytes)
      // entry+$0: PSG data track address / 256
      result.push((offset >> 0) & 0xff);
      result.push((offset >> 8) & 0xff);

      // next track (align on 256 bytes)
      offset +=
        align(this.packed ? xgm.getPackedPSGMusicDataSize() : xgm.getPSGMusicDataSize(), 256) >> 8;
    }
    for (let i = this.xgms.length; i < 128; i++) {
      result.push(0xff);
      result.push(0xff);
    }

    // 0404-xx03: sample data (see SLEN field for size)
    pushAll(result, this.getPCMDataArray());

    if (this.packed) {
      // xx04-xx04: FM music data (all tracks, 256 bytes padded)
      for (const xgm of this.xgms)
        pushAll(result, alignBytes(xgm.getPackedFMMusicDataArray(), 256, 0));
      // xx04-xx04: PSG music data (all tracks, 256 bytes padded)
      for (const xgm of this.xgms)
        pushAll(result, alignBytes(xgm.getPackedPSGMusicDataArray(), 256, 0));
    } else {
      // xx04-xx04: FM music data (all tracks, 256 bytes padded)
      for (const xgm of this.xgms)
        pushAll(result, alignBytes(xgm.getFMMusicDataArray(), 256, 0));
      // xx04-xx04: PSG music data (all tracks, 256 bytes padded)
      for (const xgm of this.xgms)
        pushAll(result, alignBytes(xgm.getPSGMusicDataArray(), 256, 0));
    }

    // xx04-xx04: GD3/XD3
    if (this.hasGD3) {
      // 0x04-0x03: GID (GD3/XD3 tags id) table (multi-tracks)
      // contain address for GD3/XD3 tags tracks (fixed size = 256 bytes = 128 entries)
      offset = 0;
      for (const xgm of this.xgms) {
        // each entry of the table consist of 2 bytes for address as we consider we will never require more than
        // 65536 bytes for GD3 tags
        // an entry with -1 (0xFFFF) mean that we don't have GD3 tags for that track.
        // all GD3 tags with address >=65536 are ignored (set to -1)
        // entry+$0: GD3 tags data track address
        if (this.packed) {
          if (xgm.xd3 != null) {
            result.push((offset >> 0) & 0xff);
            result.push((offset >> 8) & 0xff);
            // next track
            offset += xgm.xd3.getTotalDataSize();
          }
        } else if (xgm.gd3 != null) {
          result.push((offset >> 0) & 0xff);
          result.push((offset >> 8) & 0xff);
          // next track
          offset += xgm.gd3.getTotalDataSize();
        } else {
          // no tag here
          result.push(0xff);
          result.push(0xff);
        }
      }
      for (let i = this.xgms.length; i < 128; i++) {
        result.push(0xff);
        result.push(0xff);
      }

      // xx04-xx04: GD3/XD3 tags data
      for (const xgm of this.xgms) {
        if (this.packed) {
          if (xgm.xd3 != null) pushAll(result, xgm.gd3.asByteArray());
        } else if (xgm.gd3 != null) pushAll(result, xgm.gd3.asByteArray());
      }
    }

    return Uint8Array.from(result);
  }
}

// User-information flags (mirror sgdk.xgm2tool.Launcher.silent / .verbose).
/** @type {boolean} */
XGMMulti.silent = true;
/** @type {boolean} */
XGMMulti.verbose = false;

/**
 * Append every byte of `src` (Uint8Array or number[]) to `dst`.
 * @param {number[]} dst
 * @param {Uint8Array|number[]} src
 */
function pushAll(dst, src) {
  for (let i = 0; i < src.length; i++) dst.push(src[i] & 0xff);
}

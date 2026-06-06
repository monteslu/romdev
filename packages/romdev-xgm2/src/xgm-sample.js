// Port of sgdk.xgm2tool.format.XGMSample — fixed-rate (13.3/6.65 KHz) XGM sample, 64-byte aligned.

import { resamplePcm8 } from "./util.js";

const XGM_FULL_RATE = 13300;
const XGM_HALF_RATE = (XGM_FULL_RATE / 2) | 0;

/**
 * XGM Sample have fixed sample rate of 13.3 or 6.65 Khz.
 * Size and Offset are 64 bytes boundary.
 *
 * Java's `data` is a signed `byte[]`; here it is a `Uint8Array` of signed PCM
 * bytes stored as two's-complement (0..255). When the algorithm needs the
 * signed value we sign-extend; the `& 0xff` idioms are mirrored exactly.
 */
export class XGMSample {
  /**
   * The advanced fingerprint compare (`Launcher.sampleAdvancedCompare`) relied on
   * the `com.musicg` audio-fingerprint library, which has no JS equivalent and no
   * allowed dependency. It is OFF by default in the upstream tool; index.js may flip
   * these flags but the advanced path is unsupported in this port.
   */
  static sampleAdvancedCompare = false;
  static verbose = false;

  // XGM fixed sample rates (package-private in Java; exposed as static here so
  // sibling ports — e.g. vgm.js — can reference XGMSample.XGM_FULL_RATE/HALF_RATE).
  static XGM_FULL_RATE = XGM_FULL_RATE;
  static XGM_HALF_RATE = XGM_HALF_RATE;

  /**
   * @param {number} id
   * @param {Uint8Array} data
   * @param {boolean} [halfRate=false]
   * @param {number} [originId=-1]
   * @param {number} [originAddr=0]
   * @param {number} [offset] when provided with `len`, copy `data[offset..offset+len)`
   * @param {number} [len]
   */
  constructor(id, data, halfRate = false, originId = -1, originAddr = 0, offset, len) {
    // XGMSample(int id, byte[] data, int offset, int len) → copy sub-range.
    if (offset !== undefined && len !== undefined) {
      data = data.slice(offset, offset + len);
    }

    this.id = id;
    this.data = data;

    // only used for VGM to XGM conversion
    this.halfRate = halfRate;
    this.originId = originId;
    this.originAddr = originAddr;
  }

  /**
   * Java: createFromVGMSample(int id, InternalSample sample).
   * @param {number} id
   * @param {{ rate:number, addr:number, len:number, id:number, getBank:()=>{data:Uint8Array} }} sample
   * @returns {XGMSample}
   */
  static createFromVGMSample(id, sample) {
    const half = sample.rate < 10000;

    return new XGMSample(
      id,
      resamplePcm8(
        sample.getBank().data,
        sample.addr,
        sample.len,
        sample.rate,
        half ? XGM_HALF_RATE : XGM_FULL_RATE,
        256
      ),
      half,
      sample.id,
      sample.addr
    );
  }

  /** @returns {number} */
  getLength() {
    return this.data.length;
  }

  /**
   * Similarity score against an origin sample. Returns 1 for an exact prefix match,
   * 0 otherwise (simple compare). The origin sample being meaningfully longer than
   * this one disqualifies it (cannot use a shorter sample to replace a longer one).
   * @param {XGMSample} originSample
   * @returns {number}
   */
  getSimilarityScore(originSample) {
    const deltaSize = originSample.data.length - this.data.length;
    // origin sample is longer ? cannot use a shorter sample to replace it...
    if (deltaSize > 150) return 0;

    const minSize = Math.min(this.data.length, originSample.data.length);

    // advanced sample compare using fingerprint
    if (XGMSample.sampleAdvancedCompare) {
      // Upstream used the com.musicg FingerprintManager (no JS port / no allowed dep).
      throw new Error("XGMSample.sampleAdvancedCompare is not supported in the JS port");
    }

    // simple sample compare (exact match) — compare the first minSize bytes.
    for (let i = 0; i < minSize; i++) {
      if ((this.data[i] & 0xff) !== (originSample.data[i] & 0xff)) return 0;
    }
    return 1;
  }
}

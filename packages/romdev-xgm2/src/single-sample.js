// Port of sgdk.xgm2tool.struct.SingleSample — single PCM sample at a point in time.

/**
 * Single sample class (time is always expressed in 1/44100 of second).
 *
 * @author Stephane Dallongeville (original Java)
 */
export class SingleSample {
  /** @type {number} */
  static BASE_RATE = 44100;

  /**
   * @param {number} sample sample value
   * @param {number} time time in 1/44100 of second
   * @param {boolean} [newSample=false] whether this starts a new sample
   */
  constructor(sample, time, newSample = false) {
    /** @type {boolean} */
    this.newSample = newSample;
    /** @type {number} */
    this.sample = sample;
    /** @type {number} */
    this.time = time;
  }

  /**
   * Compare by time (mirrors Java compareTo via Long.compare).
   *
   * @param {SingleSample} ss
   * @returns {number} negative / zero / positive
   */
  compareTo(ss) {
    return this.time < ss.time ? -1 : this.time > ss.time ? 1 : 0;
  }
}

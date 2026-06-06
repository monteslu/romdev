// Port of sgdk.xgm2tool.format.VGMSampleData — single timed byte of VGM sample data.

/**
 * Single byte of VGM sample data (time is expressed in 1/44100 of second).
 *
 * Implements Comparable<VGMSampleData> via {@link VGMSampleData#compareTo}.
 *
 * @author steph
 */
export class VGMSampleData {
  /**
   * @param {number} time sample time, in 1/44100 of a second (Java `long`)
   * @param {number} data sample byte value (Java `byte`)
   */
  constructor(time, data) {
    /** @type {number} */
    this.time = time;
    /** @type {number} */
    this.data = data;
  }

  /**
   * Compare by time (mirrors Long.compare(time, sample.time)).
   *
   * @param {VGMSampleData} sample
   * @returns {number} negative, zero, or positive
   */
  compareTo(sample) {
    return this.time < sample.time ? -1 : this.time > sample.time ? 1 : 0;
  }
}

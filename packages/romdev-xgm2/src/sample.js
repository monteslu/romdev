// Port of sgdk.xgm2tool.struct.Sample — signed 8-bit PCM sample with match/validity helpers.

/**
 * Sample (signed 8 bits data)
 *
 * @author Stephane Dallongeville
 */
export class Sample {
  /**
   * @param {Uint8Array} data signed 8-bit PCM data (two's complement bytes)
   * @param {number} sampleRate sample rate in Hz (0 means invalid)
   */
  constructor(data, sampleRate) {
    /** @type {Uint8Array} */
    this.data = data;
    /** @type {number} */
    this.sampleRate = sampleRate;
  }

  /**
   * @param {number} index
   * @returns {number} the signed 8-bit sample value at `index`
   */
  getSample(index) {
    return (this.data[index] << 24) >> 24;
  }

  /**
   * @returns {number} the number of samples
   */
  getSize() {
    return this.data.length;
  }

  /**
   * @param {Sample} sample
   * @param {number} startIndex
   * @returns {boolean} true if `sample` matches this sample's data starting at `startIndex`
   */
  match(sample, startIndex) {
    if (startIndex >= this.data.length) return false;

    const sdata = sample.data;

    for (
      let i = startIndex, si = 0;
      i < this.data.length && si < sdata.length;
      i++, si++
    )
      if (((this.data[i] << 24) >> 24) !== ((sdata[si] << 24) >> 24)) return false;

    return true;
  }

  /**
   * @returns {boolean} true if the sample is valid (non-zero sample rate)
   */
  isValid() {
    // 0 value in sampleRate means sample in invalid
    return this.sampleRate !== 0;
  }
}

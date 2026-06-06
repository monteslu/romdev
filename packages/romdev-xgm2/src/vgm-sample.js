// Port of sgdk.xgm2tool.format.VGMSample — a VGM sample (time in 1/44100 s).

import { VGMSampleData } from "./vgm-sample-data.js";

/**
 * Internal gap-occurrence counter (Java VGMSample.VGMGapCounter).
 */
class VGMGapCounter {
  constructor() {
    /** @type {number} */
    this.count = 1;
  }

  inc() {
    this.count++;
  }
}

/**
 * VGM Sample (time is always expressed in 1/44100 of second).
 *
 * @author Stephane Dallongeville
 */
export class VGMSample {
  constructor() {
    /** @type {VGMSampleData[]} */
    this.sampleDataList = [];
  }

  /**
   * @param {number} offset
   * @param {number} data signed byte value
   */
  addSampleData(offset, data) {
    this.sampleDataList.push(new VGMSampleData(offset, data));
  }

  sort() {
    // sort samples on time
    this.sampleDataList.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }

  /**
   * @returns {number}
   */
  getMeanSampleRate() {
    let sumDelta = 0;

    for (let i = 0; i < this.sampleDataList.length - 1; i++) {
      const s0 = this.sampleDataList[i + 0];
      const s1 = this.sampleDataList[i + 1];

      sumDelta += s1.time - s0.time;
    }

    if (this.sampleDataList.length > 1) sumDelta /= this.sampleDataList.length - 1;

    return Math.round(44100 / sumDelta);
  }

  /**
   * @returns {number}
   */
  getWantedSampleRate() {
    /** @type {Map<number, VGMGapCounter>} */
    const gapHisto = new Map();

    for (let i = 0; i < this.sampleDataList.length - 1; i++) {
      const s0 = this.sampleDataList[i + 0];
      const s1 = this.sampleDataList[i + 1];

      // key is time gap
      const key = s1.time - s0.time;
      // get number of occurrence for this gap
      const count = gapHisto.get(key);

      // create new count for this gap
      if (count == null) gapHisto.set(key, new VGMGapCounter());
      // just increment it
      else count.inc();
    }

    // find max count
    let maxCount = 0;
    for (const gap of gapHisto.values()) {
      const cnt = gap.count;

      if (cnt > maxCount) maxCount = cnt;
    }

    // allowed gap minimum count
    const minimumGapCount = Math.floor(maxCount / 3);

    let countedGap = 0;
    let timeSum = 0;
    for (const entry of gapHisto.entries()) {
      const cnt = entry[1].count;

      // enough count ?
      if (cnt >= minimumGapCount) {
        // time sum
        timeSum += entry[0] * cnt;
        // counted gap
        countedGap += cnt;
      }
    }

    // return wanted sample rate (estimation)
    return Math.round(timeSum / countedGap);
  }
}

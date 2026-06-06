// Port of sgdk.xgm2tool.format.XD3 — XD3 metadata tag (XGM2 GD3 equivalent).

import {
  getInt32,
  setInt32,
  getASCIIString,
  getBytesAscii,
} from "./util.js";

export class XD3 {
  /**
   * Three constructor forms (mirroring the Java overloads):
   *   new XD3()                            — empty tag
   *   new XD3(data, baseOffset)            — parse from a byte buffer
   *   new XD3(gd3, duration, loopDuration) — build from a GD3 tag
   *
   * @param {?(Uint8Array|GD3)} [a]
   * @param {number} [b]
   * @param {number} [c]
   */
  constructor(a, b, c) {
    if (a == null) {
      // public XD3()
      this.trackName = "";
      this.gameName = "";
      this.authorName = "";
      this.date = "";
      this.conversionAuthor = "";
      this.notes = "";
      this.duration = 0;
      this.loopDuration = 0;
    } else if (a instanceof Uint8Array) {
      // public XD3(byte[] data, int baseOffset)
      this._initFromData(a, b);
    } else {
      // public XD3(GD3 gd3, int duration, int loopDuration)
      this._initFromGD3(a, b, c);
    }
  }

  /**
   * @param {Uint8Array} data
   * @param {number} baseOffset
   */
  _initFromData(data, baseOffset) {
    let offset = baseOffset;

    // total size for XD3 data (we can ignore this field)
    getInt32(data, offset);
    offset += 4;

    // fields
    this.trackName = getASCIIString(data, offset);
    // +1 for 0 ending character
    offset += this.trackName.length + 1;
    this.gameName = getASCIIString(data, offset);
    // +1 for 0 ending character
    offset += this.gameName.length + 1;
    this.authorName = getASCIIString(data, offset);
    // +1 for 0 ending character
    offset += this.authorName.length + 1;
    this.date = getASCIIString(data, offset);
    // +1 for 0 ending character
    offset += this.date.length + 1;
    this.conversionAuthor = getASCIIString(data, offset);
    // +1 for 0 ending character
    offset += this.conversionAuthor.length + 1;
    this.notes = getASCIIString(data, offset);
    // +1 for 0 ending character
    offset += this.notes.length + 1;

    // duration and loop
    this.duration = getInt32(data, offset + 0);
    this.loopDuration = getInt32(data, offset + 4);
  }

  /**
   * @param {GD3} gd3
   * @param {number} duration
   * @param {number} loopDuration
   */
  _initFromGD3(gd3, duration, loopDuration) {
    this.trackName = gd3.trackName_EN;
    this.gameName = gd3.gameName_EN;
    this.authorName = gd3.authorName_EN;
    this.date = gd3.date;
    this.conversionAuthor = gd3.vgmConversionAuthor;
    this.notes = gd3.notes;

    this.duration = duration;
    this.loopDuration = loopDuration;
  }

  /** @returns {number} */
  computeDataSize() {
    return (
      this.trackName.length +
      this.gameName.length +
      this.authorName.length +
      this.date.length +
      this.conversionAuthor.length +
      this.notes.length +
      6 * 1 +
      8
    ); // +8 for durations informations
  }

  /** @returns {number} */
  getTotalDataSize() {
    return this.computeDataSize() + 4;
  }

  /** @returns {Uint8Array} */
  asByteArray() {
    // align size on 2 bytes
    let size = (this.computeDataSize() + 1) & 0xfffffffe;
    const result = new Uint8Array(size + 4);
    let offset = 0;

    // size of XD3 infos
    setInt32(result, offset, size);
    offset += 4;

    // fields
    size = this.trackName.length;
    result.set(getBytesAscii(this.trackName).subarray(0, size), offset);
    // +1 for 0 ending character in C
    offset += size + 1;
    size = this.gameName.length;
    result.set(getBytesAscii(this.gameName).subarray(0, size), offset);
    // +1 for 0 ending character in C
    offset += size + 1;
    size = this.authorName.length;
    result.set(getBytesAscii(this.authorName).subarray(0, size), offset);
    // +1 for 0 ending character in C
    offset += size + 1;
    size = this.date.length;
    result.set(getBytesAscii(this.date).subarray(0, size), offset);
    // +1 for 0 ending character in C
    offset += size + 1;
    size = this.conversionAuthor.length;
    result.set(getBytesAscii(this.conversionAuthor).subarray(0, size), offset);
    // +1 for 0 ending character in C
    offset += size + 1;
    size = this.notes.length;
    result.set(getBytesAscii(this.notes).subarray(0, size), offset);
    // +1 for 0 ending character in C
    offset += size + 1;

    // duration and loop
    setInt32(result, offset + 0, this.duration);
    setInt32(result, offset + 4, this.loopDuration);

    return result;
  }
}

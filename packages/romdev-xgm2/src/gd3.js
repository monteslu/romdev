// Port of sgdk.xgm2tool.format.GD3 — VGM GD3 metadata tag (parse/build).

import {
  getASCIIString,
  getInt32,
  getWideString,
  setInt32,
  getBytesAscii,
  getBytesUtf16,
} from "./util.js";

const XGMTOOL_PRINT = "Optimized with XGMTool";

export class GD3 {
  /**
   * @param {Uint8Array} [data] raw VGM data (when parsing) or an XD3 instance.
   * @param {number} [baseOffset] offset of the GD3 block within `data`.
   */
  constructor(data, baseOffset) {
    /** @type {number} */
    this.version = 0;

    /** @type {string} */
    this.trackName_EN = "";
    /** @type {string} */
    this.trackName_JP = "";
    /** @type {string} */
    this.gameName_EN = "";
    /** @type {string} */
    this.gameName_JP = "";
    /** @type {string} */
    this.systemName_EN = "";
    /** @type {string} */
    this.systemName_JP = "";
    /** @type {string} */
    this.authorName_EN = "";
    /** @type {string} */
    this.authorName_JP = "";
    /** @type {string} */
    this.date = "";
    /** @type {string} */
    this.vgmConversionAuthor = "";
    /** @type {string} */
    this.notes = "";

    if (data === undefined) {
      // GD3()
      this.version = 0x100;
      return;
    }

    if (baseOffset === undefined) {
      // GD3(XD3 xd3)
      const xd3 = data;
      this.trackName_EN = xd3.trackName;
      this.trackName_JP = xd3.trackName;
      this.gameName_EN = xd3.gameName;
      this.gameName_JP = xd3.gameName;
      this.systemName_EN = "SEGA Mega Drive";
      this.systemName_JP = "SEGA Mega Drive";
      this.authorName_EN = xd3.authorName;
      this.authorName_JP = xd3.authorName;
      this.date = xd3.date;
      this.vgmConversionAuthor = xd3.conversionAuthor;
      this.notes = xd3.notes;

      this.version = 0x100;
      return;
    }

    // GD3(byte[] data, int baseOffset)
    let offset = baseOffset;

    const id = getASCIIString(data, offset, 4);

    if (id !== "Gd3 ") {
      // Java: System.out.println("Error: GD3 header not recognized !\n");
    }
    offset += 4;

    // get version info
    this.version = getInt32(data, offset);
    offset += 4;

    // get total size for GD3 data (we can ignore this field)
    getInt32(data, offset);
    offset += 4;

    this.trackName_EN = getWideString(data, offset);
    offset += (this.trackName_EN.length + 1) * 2;
    this.trackName_JP = getWideString(data, offset);
    offset += (this.trackName_JP.length + 1) * 2;
    this.gameName_EN = getWideString(data, offset);
    offset += (this.gameName_EN.length + 1) * 2;
    this.gameName_JP = getWideString(data, offset);
    offset += (this.gameName_JP.length + 1) * 2;
    this.systemName_EN = getWideString(data, offset);
    offset += (this.systemName_EN.length + 1) * 2;
    this.systemName_JP = getWideString(data, offset);
    offset += (this.systemName_JP.length + 1) * 2;
    this.authorName_EN = getWideString(data, offset);
    offset += (this.authorName_EN.length + 1) * 2;
    this.authorName_JP = getWideString(data, offset);
    offset += (this.authorName_JP.length + 1) * 2;
    this.date = getWideString(data, offset);
    offset += (this.date.length + 1) * 2;
    this.vgmConversionAuthor = getWideString(data, offset);
    offset += (this.vgmConversionAuthor.length + 1) * 2;
    this.notes = getWideString(data, offset);
    offset += (this.notes.length + 1) * 2;

    // not ending with our signature ?
    if (!this.vgmConversionAuthor.endsWith(XGMTOOL_PRINT)) {
      if (this.vgmConversionAuthor.length !== 0) this.vgmConversionAuthor += " - ";

      // add XGMTool signature
      this.vgmConversionAuthor += XGMTOOL_PRINT;
    }
  }

  /** @returns {number} */
  computeDataSize() {
    return (
      this.trackName_EN.length * 2 +
      this.trackName_JP.length * 2 +
      this.gameName_EN.length * 2 +
      this.gameName_JP.length * 2 +
      this.systemName_EN.length * 2 +
      this.systemName_JP.length * 2 +
      this.authorName_EN.length * 2 +
      this.authorName_JP.length * 2 +
      this.date.length * 2 +
      this.vgmConversionAuthor.length * 2 +
      this.notes.length * 2 +
      11 * 2
    );
  }

  /** @returns {number} */
  getTotalDataSize() {
    return this.computeDataSize() + 12;
  }

  /** @returns {Uint8Array} */
  asByteArray() {
    // align size on 2 bytes
    const dataSize = this.computeDataSize();
    const result = new Uint8Array(dataSize + 12);
    let offset = 0;
    let size;

    // header
    result.set(getBytesAscii("Gd3 ").subarray(0, 4), offset);
    offset += 4;
    // version
    setInt32(result, offset, this.version);
    offset += 4;
    // size
    setInt32(result, offset, dataSize);
    offset += 4;

    // fields
    size = this.trackName_EN.length * 2;
    result.set(getBytesUtf16(this.trackName_EN).subarray(0, size), offset);
    // +2 for 0 ending character in C
    offset += size + 2;
    size = this.trackName_JP.length * 2;
    result.set(getBytesUtf16(this.trackName_JP).subarray(0, size), offset);
    offset += size + 2;
    size = this.gameName_EN.length * 2;
    result.set(getBytesUtf16(this.gameName_EN).subarray(0, size), offset);
    offset += size + 2;
    size = this.gameName_JP.length * 2;
    result.set(getBytesUtf16(this.gameName_JP).subarray(0, size), offset);
    offset += size + 2;
    size = this.systemName_EN.length * 2;
    result.set(getBytesUtf16(this.systemName_EN).subarray(0, size), offset);
    offset += size + 2;
    size = this.systemName_JP.length * 2;
    result.set(getBytesUtf16(this.systemName_JP).subarray(0, size), offset);
    offset += size + 2;
    size = this.authorName_EN.length * 2;
    result.set(getBytesUtf16(this.authorName_EN).subarray(0, size), offset);
    offset += size + 2;
    size = this.authorName_JP.length * 2;
    result.set(getBytesUtf16(this.authorName_JP).subarray(0, size), offset);
    offset += size + 2;
    size = this.date.length * 2;
    result.set(getBytesUtf16(this.date).subarray(0, size), offset);
    offset += size + 2;
    size = this.vgmConversionAuthor.length * 2;
    result.set(getBytesUtf16(this.vgmConversionAuthor).subarray(0, size), offset);
    offset += size + 2;
    size = this.notes.length * 2;
    result.set(getBytesUtf16(this.notes).subarray(0, size), offset);

    return result;
  }
}

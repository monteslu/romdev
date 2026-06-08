// Port of sgdk.xgm2tool.format.XGMFMCommand — XGM v2 FM (YM2612) command + builders.

import { Command } from "./command.js";
import { getInt8, getInt24, setInt8, setInt24 } from "./util.js";
// VGMCommand / XGM are referenced via passed-in instances; no static use needed here.

/**
 * Mirror of sgdk.tool.StringUtil.toHexaString(value, size): lowercase? No —
 * SGDK renders UPPERCASE zero-padded hex of `size` nibbles.
 * @param {number} value
 * @param {number} size number of hex digits
 * @returns {string}
 */
function toHexaString(value, size) {
  let hex = (value >>> 0).toString(16).toUpperCase();
  while (hex.length < size) hex = "0" + hex;
  return hex;
}

export class XGMFMCommand extends Command {
  // NEW DEFINE FOR XGM V2
  static WAIT_SHORT = 0x00;
  static WAIT_LONG = 0x0f;

  static PCM = 0x10;

  static FM_LOAD_INST = 0x20;
  static FM_FREQ = 0x30;
  static FM_KEY = 0x40;
  static FM_KEY_SEQ = 0x50;

  static FM0_PAN = 0x60;
  static FM1_PAN = 0x70;

  static FM_FREQ_WAIT = 0x80;
  static FM_TL = 0x90;

  static FM_FREQ_DELTA = 0xa0;
  static FM_FREQ_DELTA_WAIT = 0xb0;
  static FM_TL_DELTA = 0xc0;
  static FM_TL_DELTA_WAIT = 0xd0;

  static FM_WRITE = 0xe0;

  static FRAME_DELAY = 0xf0;

  static FM_KEY_ADV = 0xf8;
  static FM_LFO = 0xf9;
  static FM_CH3_SPECIAL_ON = 0xfa;
  static FM_CH3_SPECIAL_OFF = 0xfb;
  static FM_DAC_ON = 0xfc;
  static FM_DAC_OFF = 0xfd;

  static LOOP = 0xff;

  // internal id to trace command to remove
  static DUMMY = 0xf7;
  static LOOP_START = 0xf6;

  /**
   * @param {XGMFMCommand[]} commands
   * @param {number} channel
   * @param {boolean} getWait
   * @param {boolean} getLoopStart
   * @returns {XGMFMCommand[]}
   */
  static filterChannel(commands, channel, getWait, getLoopStart) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    for (const com of commands)
      if (com.getChannel() === channel || (getWait && com.isWait(true)) || (getLoopStart && com.isLoopStart()))
        result.push(com);

    return result;
  }

  /**
   * @param {XGMFMCommand[]} commands
   * @param {number} [startInd]
   * @param {number} [endInd]
   * @returns {XGMFMCommand[]}
   */
  static filterYMWrite(commands, startInd, endInd) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    if (startInd === undefined) {
      for (const com of commands) if (com.isYMWrite()) result.push(com);
      return result;
    }

    let ind = startInd;
    while (ind < endInd) {
      const com = commands[ind];

      if (com.isYMWrite()) result.push(com);

      ind++;
    }

    return result;
  }

  /**
   * @param {XGMFMCommand[]} commands
   * @param {boolean} wantFreqLow
   * @returns {XGMFMCommand[]}
   */
  static filterYMFreq(commands, wantFreqLow) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    for (const com of commands)
      if (com.isYMFreqWrite() || (wantFreqLow && com.isYMFreqDeltaWrite())) result.push(com);

    return result;
  }

  /**
   * @param {XGMFMCommand[]} commands
   * @param {number} startInd
   * @returns {number}
   */
  static findNextYMKeyCommand(commands, startInd) {
    let ind = startInd;

    while (ind < commands.length) {
      if (commands[ind].isYMKeyWrite()) return ind;
      ind++;
    }

    return ind;
  }

  /**
   * @param {Uint8Array|number[]} data
   * @param {number} offset
   * @returns {number}
   */
  static computeSize(data, offset) {
    const command = getInt8(data, offset);

    switch (command) {
      case XGMFMCommand.WAIT_LONG:
        return 2;
      case XGMFMCommand.FM_KEY_ADV:
        return 2;
      case XGMFMCommand.FM_LFO:
        return 2;
      case XGMFMCommand.FM_CH3_SPECIAL_ON:
      case XGMFMCommand.FM_CH3_SPECIAL_OFF:
      case XGMFMCommand.FM_DAC_ON:
      case XGMFMCommand.FM_DAC_OFF:
        return 1;
      case XGMFMCommand.FRAME_DELAY:
        return 1;
      case XGMFMCommand.LOOP:
        return 4;
    }

    switch (command & 0xf0) {
      default:
      case XGMFMCommand.WAIT_SHORT:
        return 1;

      case XGMFMCommand.PCM:
        return 2;

      case XGMFMCommand.FM_LOAD_INST:
        return 31;

      case XGMFMCommand.FM_FREQ:
      case XGMFMCommand.FM_FREQ_WAIT:
        return 3;

      case XGMFMCommand.FM_KEY:
        return 1;
      case XGMFMCommand.FM_KEY_SEQ:
        return 1;

      case XGMFMCommand.FM_TL:
      case XGMFMCommand.FM_TL_DELTA:
      case XGMFMCommand.FM_TL_DELTA_WAIT:
        return 2;

      case XGMFMCommand.FM0_PAN:
      case XGMFMCommand.FM1_PAN:
        return 1;

      case XGMFMCommand.FM_WRITE:
        return 1 + 2 * ((command & 0x07) + 1);

      case XGMFMCommand.FM_FREQ_DELTA:
      case XGMFMCommand.FM_FREQ_DELTA_WAIT:
        return 2;
    }
  }

  /**
   * Mirrors the Java constructor overloads:
   *  - XGMFMCommand(byte[] data, int offset)
   *  - XGMFMCommand(byte[] data)        (package-private)
   *  - XGMFMCommand(int command)        (private)
   *  - XGMFMCommand(byte[] data, int offset, int time)
   * @param {Uint8Array|number[]|number} data raw bytes, or an int command value
   * @param {number} [offset] when `data` is a byte array
   * @param {number} [time]
   */
  constructor(data, offset, time) {
    if (typeof data === "number") {
      // XGMFMCommand(int command)
      super(data);
      // size = data.length (super created a 1-byte array)
      // (size already 1 from Command(int command))
      return;
    }

    if (offset === undefined) {
      // XGMFMCommand(byte[] data)
      super(data);
      this.size = data.length;
      return;
    }

    // XGMFMCommand(byte[] data, int offset) [+ optional time]
    const size = XGMFMCommand.computeSize(data, offset);
    const slice = sliceBytes(data, offset, offset + size);
    super(slice);
    this.size = slice.length;

    if (time !== undefined) this.time = time;
  }

  /**
   * @returns {number}
   */
  getType() {
    if (this instanceof LoopStartCommand) return XGMFMCommand.LOOP_START;

    const com = this.getCommand();

    if (com === XGMFMCommand.WAIT_LONG) return XGMFMCommand.WAIT_LONG;
    if (com === XGMFMCommand.FM_KEY_ADV) return XGMFMCommand.FM_KEY_ADV;
    if (com === XGMFMCommand.FM_LFO) return XGMFMCommand.FM_LFO;
    if (com === XGMFMCommand.FM_CH3_SPECIAL_ON) return XGMFMCommand.FM_CH3_SPECIAL_ON;
    if (com === XGMFMCommand.FM_CH3_SPECIAL_OFF) return XGMFMCommand.FM_CH3_SPECIAL_OFF;
    if (com === XGMFMCommand.FM_DAC_ON) return XGMFMCommand.FM_DAC_ON;
    if (com === XGMFMCommand.FM_DAC_OFF) return XGMFMCommand.FM_DAC_OFF;
    if (com === XGMFMCommand.FRAME_DELAY) return XGMFMCommand.FRAME_DELAY;
    if (com === XGMFMCommand.LOOP) return XGMFMCommand.LOOP;
    if (com === XGMFMCommand.DUMMY) return XGMFMCommand.DUMMY;

    return com & 0xf0;
  }

  isWaitShort() {
    return this.getType() === XGMFMCommand.WAIT_SHORT;
  }

  isWaitLong() {
    return this.getType() === XGMFMCommand.WAIT_LONG;
  }

  /**
   * @param {boolean} realWaitOnly
   * @returns {boolean}
   */
  isWait(realWaitOnly) {
    if (realWaitOnly) return this.isWaitShort() || this.isWaitLong();

    return (
      this.isWaitShort() ||
      this.isWaitLong() ||
      this.isYMFreqWriteWait() ||
      this.isYMFreqDeltaWriteWait() ||
      this.isYMTLDeltaWait() ||
      this.isFrameDelay()
    );
  }

  getWaitFrame() {
    if (this.isWaitLong()) return getInt8(this.data, 1) + 16;
    if (this.isWaitShort()) return (getInt8(this.data, 0) & 0xf) + 1;
    if (this.isWait(false)) return 1;

    return 0;
  }

  isDummy() {
    return this.getType() === XGMFMCommand.DUMMY;
  }

  isFrameDelay() {
    return this.getType() === XGMFMCommand.FRAME_DELAY;
  }

  isLoop() {
    return this.getType() === XGMFMCommand.LOOP;
  }

  isLoopStart() {
    return this instanceof LoopStartCommand;
  }

  isPCM() {
    return this.getType() === XGMFMCommand.PCM;
  }

  isYMLoadInst() {
    return this.getType() === XGMFMCommand.FM_LOAD_INST;
  }

  isYMWrite() {
    return this.getType() === XGMFMCommand.FM_WRITE;
  }

  isYMFreqWriteNoWait() {
    return this.getType() === XGMFMCommand.FM_FREQ;
  }

  isYMFreqWriteWait() {
    return this.getType() === XGMFMCommand.FM_FREQ_WAIT;
  }

  isYMFreqWrite() {
    return this.isYMFreqWriteNoWait() || this.isYMFreqWriteWait();
  }

  getYMFreqValue() {
    if (this.isYMFreqWrite()) return ((this.data[1] & 0x3f) << 8) | (this.data[2] & 0xff);

    return -1;
  }

  isYMFreqSpecialWrite() {
    return this.isYMFreqWrite() && (this.getCommand() & 8) !== 0;
  }

  isYMFreqWithKeyON() {
    return this.isYMFreqWrite() && (this.data[1] & 0x80) !== 0;
  }

  isYMFreqWithKeyOFF() {
    return this.isYMFreqWrite() && (this.data[1] & 0x40) !== 0;
  }

  isYMFreqWithKeyWrite() {
    return this.isYMFreqWrite() && (this.data[1] & 0xc0) !== 0;
  }

  setYMFreqKeyON() {
    if (this.isYMFreqWrite()) this.data[1] = (this.data[1] | 0x80) & 0xff;
  }

  setYMFreqKeyOFF() {
    if (this.isYMFreqWrite()) this.data[1] = (this.data[1] | 0x40) & 0xff;
  }

  isYMFreqDeltaWriteNoWait() {
    return this.getType() === XGMFMCommand.FM_FREQ_DELTA;
  }

  isYMFreqDeltaWriteWait() {
    return this.getType() === XGMFMCommand.FM_FREQ_DELTA_WAIT;
  }

  isYMFreqDeltaWrite() {
    return this.isYMFreqDeltaWriteNoWait() || this.isYMFreqDeltaWriteWait();
  }

  isYMFreqDeltaSpecialWrite() {
    return this.isYMFreqDeltaWrite() && (this.getCommand() & 8) !== 0;
  }

  getYMFreqDeltaValue() {
    if (this.isYMFreqDeltaWrite()) {
      const delta = ((this.data[1] >> 1) & 0x7f) + 1;
      return (this.data[1] & 1) !== 0 ? -delta : delta;
    }

    return -1;
  }

  /**
   * @param {number} delta
   * @returns {boolean}
   */
  toFreqDelta(delta) {
    // can only convert FREQ command
    if (this.isYMFreqWrite()) {
      const cmd = this.isYMFreqWriteWait() ? XGMFMCommand.FM_FREQ_DELTA_WAIT : XGMFMCommand.FM_FREQ_DELTA;
      const deltav = delta < 0 ? -(delta + 1) : delta - 1;
      this.data = Uint8Array.from([
        (cmd | (this.data[0] & 0xf)) & 0xff,
        ((delta < 0 ? 1 : 0) | (deltav << 1)) & 0xff,
      ]);
      this.size = 2;
      return true;
    }

    return false;
  }

  isYMKeyFastWrite() {
    return this.getType() === XGMFMCommand.FM_KEY;
  }

  isYMKeyONWrite() {
    return this.isYMKeyFastWrite() && (this.data[0] & 8) !== 0;
  }

  isYMKeyOFFWrite() {
    return this.isYMKeyFastWrite() && (this.data[0] & 8) === 0;
  }

  isYMKeySequence() {
    return this.getType() === XGMFMCommand.FM_KEY_SEQ;
  }

  isYMKeySequenceONOFF() {
    return this.isYMKeySequence() && (this.data[0] & 8) !== 0;
  }

  isYMKeySequenceOFFON() {
    return this.isYMKeySequence() && (this.data[0] & 8) === 0;
  }

  isYMKeyAdvWrite() {
    return this.getType() === XGMFMCommand.FM_KEY_ADV;
  }

  isYMKeyWrite() {
    return this.isYMKeyFastWrite() || this.isYMKeySequence() || this.isYMKeyAdvWrite();
  }

  /**
   * @param {boolean} onOff
   * @returns {boolean}
   */
  toKeySeq(onOff) {
    if (this.isYMKeyFastWrite()) {
      this.data = Uint8Array.from([(XGMFMCommand.FM_KEY_SEQ | (this.data[0] & 0x7) | (onOff ? 8 : 0)) & 0xff]);
      this.size = 1;
      return true;
    }

    return false;
  }

  isYMSetTL() {
    return this.getType() === XGMFMCommand.FM_TL;
  }

  getYMTLValue() {
    if (this.isYMSetTL()) return (this.data[1] >> 1) & 0x7f;

    return -1;
  }

  isYMTLDeltaNoWait() {
    return this.getType() === XGMFMCommand.FM_TL_DELTA;
  }

  isYMTLDeltaWait() {
    return this.getType() === XGMFMCommand.FM_TL_DELTA_WAIT;
  }

  isYMTLDelta() {
    return this.isYMTLDeltaNoWait() || this.isYMTLDeltaWait();
  }

  getYMTLDelta() {
    if (this.isYMTLDelta()) {
      const delta = ((this.data[1] >> 2) & 0x3f) + 1;
      return (this.data[1] & 2) !== 0 ? -delta : delta;
    }

    return -1;
  }

  /**
   * @param {number} delta
   * @returns {boolean}
   */
  toTLDelta(delta) {
    // can only convert set TL command
    if (this.isYMSetTL()) {
      const deltav = delta < 0 ? -(delta + 1) : delta - 1;
      this.data = Uint8Array.from([
        (XGMFMCommand.FM_TL_DELTA | (this.data[0] & 0xf)) & 0xff,
        ((this.data[1] & 1) | (delta < 0 ? 2 : 0) | (deltav << 2)) & 0xff,
      ]);
      this.size = 2;
      return true;
    }

    return false;
  }

  isYMPAN() {
    return this.getType() === XGMFMCommand.FM0_PAN || this.getType() === XGMFMCommand.FM1_PAN;
  }

  isYMCH3SpecialMode() {
    return this.getType() === XGMFMCommand.FM_CH3_SPECIAL_ON || this.getType() === XGMFMCommand.FM_CH3_SPECIAL_OFF;
  }

  isYMDACMode() {
    return this.getType() === XGMFMCommand.FM_DAC_ON || this.getType() === XGMFMCommand.FM_DAC_OFF;
  }

  isYMLFO() {
    return this.getType() === XGMFMCommand.FM_LFO;
  }

  isYMSetting() {
    return this.isYMCH3SpecialMode() || this.isYMDACMode() || this.isYMLFO();
  }

  supportWait() {
    // can this command be muted in com + wait ?
    return this.isYMFreqWrite() || this.isYMFreqDeltaWrite() || this.isYMTLDelta();
  }

  addWait() {
    if (this.supportWait()) {
      if (this.isYMFreqWriteNoWait())
        this.data[0] = (this.data[0] + (XGMFMCommand.FM_FREQ_WAIT - XGMFMCommand.FM_FREQ)) & 0xff;
      else if (this.isYMFreqDeltaWriteNoWait())
        this.data[0] = (this.data[0] + (XGMFMCommand.FM_FREQ_DELTA_WAIT - XGMFMCommand.FM_FREQ_DELTA)) & 0xff;
      else if (this.isYMTLDeltaNoWait())
        this.data[0] = (this.data[0] + (XGMFMCommand.FM_TL_DELTA_WAIT - XGMFMCommand.FM_TL_DELTA)) & 0xff;
    }
  }

  getPCMId() {
    if (this.getType() === XGMFMCommand.PCM) return getInt8(this.data, 1);

    return -1;
  }

  /**
   * @param {number} value
   */
  setPCMId(value) {
    if (this.getType() === XGMFMCommand.PCM) setInt8(this.data, 1, value);
  }

  getPCMChannel() {
    if (this.getType() === XGMFMCommand.PCM) return getInt8(this.data, 0) & 3;

    return 0;
  }

  getPCMHalfRate() {
    if (this.getType() === XGMFMCommand.PCM) return (getInt8(this.data, 0) & 4) !== 0;

    return false;
  }

  getYMPort() {
    switch (this.getType()) {
      case XGMFMCommand.FM0_PAN:
        return 0;
      case XGMFMCommand.FM1_PAN:
        return 1;

      case XGMFMCommand.FM_LOAD_INST:
      case XGMFMCommand.FM_FREQ:
      case XGMFMCommand.FM_FREQ_WAIT:
      case XGMFMCommand.FM_FREQ_DELTA:
      case XGMFMCommand.FM_FREQ_DELTA_WAIT:
      case XGMFMCommand.FM_KEY:
      case XGMFMCommand.FM_KEY_SEQ:
        return (this.data[0] >> 2) & 1;

      case XGMFMCommand.FM_WRITE:
        return (this.data[0] >> 3) & 1;

      case XGMFMCommand.FM_TL:
      case XGMFMCommand.FM_TL_DELTA:
      case XGMFMCommand.FM_TL_DELTA_WAIT:
        return (this.data[1] >> 0) & 1;

      case XGMFMCommand.FM_KEY_ADV:
        return (this.data[1] >> 2) & 1;
    }

    return 0;
  }

  getYMChannel() {
    switch (this.getType()) {
      case XGMFMCommand.FM_FREQ:
      case XGMFMCommand.FM_FREQ_WAIT:
      case XGMFMCommand.FM_FREQ_DELTA:
      case XGMFMCommand.FM_FREQ_DELTA_WAIT:
        if ((this.data[0] & 8) !== 0) return 2;
      // fallthrough
      case XGMFMCommand.FM_LOAD_INST:
      case XGMFMCommand.FM_KEY:
      case XGMFMCommand.FM_KEY_SEQ:
      case XGMFMCommand.FM_TL:
      case XGMFMCommand.FM_TL_DELTA:
      case XGMFMCommand.FM_TL_DELTA_WAIT:
      case XGMFMCommand.FM0_PAN:
      case XGMFMCommand.FM1_PAN:
        return this.data[0] & 3;

      case XGMFMCommand.FM_WRITE:
        if ((this.data[1] & 0xf8) === 0xa8) return 2;
      // fallthrough
      case XGMFMCommand.FM_KEY_ADV:
        return this.data[1] & 3;
    }

    return -1;
  }

  getYMGlobalChannel() {
    return this.getYMPort() * 3 + this.getYMChannel();
  }

  /**
   * @override
   * @returns {number}
   */
  getChannel() {
    return this.getYMGlobalChannel();
  }

  getYMSlot() {
    switch (this.getType()) {
      case XGMFMCommand.FM_FREQ:
      case XGMFMCommand.FM_FREQ_WAIT:
      case XGMFMCommand.FM_FREQ_DELTA:
      case XGMFMCommand.FM_FREQ_DELTA_WAIT:
        return (this.data[0] & 8) !== 0 ? (this.data[0] & 3) + 1 : -1;
      case XGMFMCommand.FM_TL:
      case XGMFMCommand.FM_TL_DELTA:
      case XGMFMCommand.FM_TL_DELTA_WAIT:
        return (this.data[0] >> 2) & 3;
    }

    return -1;
  }

  getYMNumWrite() {
    if (this.isYMWrite()) return (this.data[0] & 7) + 1;

    return -1;
  }

  getLoopAddr() {
    if (this.isLoop()) return getInt24(this.data, 1);

    return -1;
  }

  /**
   * @param {number} address
   */
  setLoopAddr(address) {
    if (this.isLoop()) setInt24(this.data, 1, address);
  }

  setDummy() {
    const newData = new Uint8Array(this.data.length + 1);

    // set DUMMY command followed by old content
    newData[0] = XGMFMCommand.DUMMY & 0xff;
    newData.set(this.data, 1);

    // set data
    this.data = newData;
    this.size = newData.length;
  }

  /**
   * @param {number} header
   * @param {number[]} dataList
   */
  setYMWrite(header, dataList) {
    // empty list ? --> set to dummy command
    if (dataList.length === 0) {
      this.setDummy();
      return;
    }

    // just keep ignored writes
    const newData = new Uint8Array(dataList.length + 1);

    newData[0] = header & 0xff;

    // set new size
    newData[0] &= 0xf8;
    newData[0] |= (dataList.length / 2 - 1) & 0xff;

    for (let i = 0; i < dataList.length; i += 2) {
      newData[i + 1] = dataList[i + 0] & 0xff;
      newData[i + 2] = dataList[i + 1] & 0xff;
    }

    // update command
    this.data = newData;
    this.size = newData.length;
  }

  /**
   * @override
   * @returns {string}
   */
  toString() {
    let result = "";

    if (this.isWaitShort()) result += "FM WAIT S #" + this.getWaitFrame();
    else if (this.isWaitLong()) result += "FM WAIT L #" + this.getWaitFrame();
    else if (this.isPCM()) result += "PCM #" + this.getPCMId();
    else if (this.isYMLoadInst()) result += "FM LOADINST";
    else if (this.isYMFreqSpecialWrite())
      result +=
        "FM FREQ" +
        (this.isYMFreqWriteWait() ? " W" : "") +
        " S" +
        this.getYMSlot() +
        " " +
        ((this.data[1] & 0x40) !== 0 ? "x" : "") +
        ((this.data[1] & 0x80) !== 0 ? "o" : "");
    else if (this.isYMFreqWrite())
      result +=
        "FM FREQ" +
        (this.isYMFreqWriteWait() ? " W" : "") +
        " " +
        ((this.data[1] & 0x40) !== 0 ? "x" : "") +
        ((this.data[1] & 0x80) !== 0 ? "o" : "");
    else if (this.isYMFreqDeltaSpecialWrite())
      result +=
        "FM FREQD " +
        this.getYMFreqDeltaValue() +
        (this.isYMFreqDeltaWriteWait() ? " W" : "") +
        " S" +
        this.getYMSlot();
    else if (this.isYMFreqDeltaWrite())
      result += "FM FREQD " + this.getYMFreqDeltaValue() + (this.isYMFreqDeltaWriteWait() ? " W" : "");
    else if (this.isYMKeyONWrite()) result += "FM KEY ON";
    else if (this.isYMKeyOFFWrite()) result += "FM KEY OFF";
    else if (this.isYMKeyAdvWrite()) result += "FM KEY ADV";
    else if (this.isYMKeySequence()) result += "FM KEY SEQ";
    else if (this.isYMKeyWrite()) result += "FM KEY";
    else if (this.isYMSetTL()) result += "FM TL S" + this.getYMSlot();
    else if (this.isYMTLDelta())
      result += "FM TLD " + this.getYMTLDelta() + (this.isYMTLDeltaWait() ? " W." : "") + " S" + this.getYMSlot();
    else if (this.isYMPAN()) result += "FM PAN";
    else if (this.isYMDACMode()) {
      if (this.getType() === XGMFMCommand.FM_DAC_ON) result += "DAC ON";
      else result += "DAC OFF";
    } else if (this.isYMLFO()) result += "LFO";
    else if (this.isYMCH3SpecialMode()) result += "CH2 spe";
    else if (this.isYMWrite()) result += "FM WRITE";
    else if (this.isFrameDelay()) result += "FRAME DELAY";
    else if (this.isLoopStart()) result += "FM LOOP St";
    else if (this.isLoop()) result += "FM LOOP #" + toHexaString(this.getLoopAddr(), 6);
    else if (this.isDummy()) result += "FM DUMMY (" + new XGMFMCommand(this.data, 1).toString() + ")";

    return result;
  }

  static createFrameCommand() {
    return new XGMFMCommand(XGMFMCommand.WAIT_SHORT);
  }

  /**
   * @param {Iterable<import("./vgm-command.js").VGMCommand>} commands
   * @returns {XGMFMCommand[]}
   */
  static createYMKeyCommands(commands) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    for (const com of commands) result.push(XGMFMCommand.createYMKeyCommand(com));

    return result;
  }

  /**
   * @param {Iterable<import("./vgm-command.js").VGMCommand>} commands
   * @param {number} channel
   * @returns {XGMFMCommand[]}
   */
  static createYMCHCommands(commands, channel) {
    /** @type {XGMFMCommand[]} */
    const result = [];
    const remaining = Array.from(commands);

    while (remaining.length > 0) result.push(XGMFMCommand.createYMCHCommand(remaining, channel));

    return result;
  }

  /**
   * @param {number} wait
   * @returns {XGMFMCommand[]}
   */
  static createWaitCommands(wait) {
    /** @type {XGMFMCommand[]} */
    const result = [];
    let remain = wait;

    while (remain > 271) {
      result.push(new WaitLongCommand(271));
      remain -= 271;
    }
    if (remain > 15) result.push(new WaitLongCommand(remain));
    else result.push(new WaitShortCommand(remain));

    return result;
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand[]} commands
   * @returns {XGMFMCommand[]}
   */
  static createYMMiscCommands(commands) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    for (const command of commands) {
      const xgmCom = XGMFMCommand.createYMMiscCommand(command);

      if (xgmCom != null) result.push(xgmCom);
    }

    return result;
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand[]} commands
   * @returns {XGMFMCommand[]}
   */
  static createYMFreqCommands(commands) {
    /** @type {XGMFMCommand[]} */
    const result = [];
    /** @type {import("./vgm-command.js").VGMCommand[]} */
    const coupledCom = [];

    let ind = 0;
    while (ind < commands.length) {
      coupledCom.length = 0;
      coupledCom.push(commands[ind++]);
      coupledCom.push(commands[ind++]);

      result.push(XGMFMCommand.createYMFreqCommandFromVGM(coupledCom, false, false));
    }

    return result;
  }

  /**
   * @param {import("./xgm.js").XGM} xgm
   * @param {import("./vgm-command.js").VGMCommand[]} commands
   * @returns {XGMFMCommand[]}
   */
  static createPCMCommands(xgm, commands) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    for (const command of commands) {
      if (command.isStreamStartLong() || command.isStreamStart() || command.isStreamStop()) {
        const xgmCommand = XGMFMCommand.createPCMCommand(xgm, command, 0);

        if (xgmCommand != null) result.push(xgmCommand);
      }
    }

    return result;
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand} command
   * @returns {XGMFMCommand|null}
   */
  static createYMMiscCommand(command) {
    /** @type {Uint8Array} */
    let data;

    switch (command.getYM2612Register()) {
      case 0x22:
        // LFO
        data = new Uint8Array(2);
        data[0] = XGMFMCommand.FM_LFO & 0xff;
        data[1] = command.getYM2612Value() & 0xff;
        break;

      case 0x27:
        // CH2 special mode
        data = new Uint8Array(1);
        if ((command.getYM2612Value() & 0x40) !== 0) data[0] = XGMFMCommand.FM_CH3_SPECIAL_ON & 0xff;
        else data[0] = XGMFMCommand.FM_CH3_SPECIAL_OFF & 0xff;
        break;

      case 0x2b:
        // DAC enable
        data = new Uint8Array(1);
        if ((command.getYM2612Value() & 0x80) !== 0) data[0] = XGMFMCommand.FM_DAC_ON & 0xff;
        else data[0] = XGMFMCommand.FM_DAC_OFF & 0xff;
        break;

      default:
        // ignore
        return null;
    }

    return new XGMFMCommand(data);
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand} command
   * @returns {XGMFMCommand}
   */
  static createYMKeyCommand(command) {
    /** @type {Uint8Array} */
    let data;

    const value = command.getYM2612Value();
    const keyWrite = value & 0xf0;
    const ch = value & 0x07;

    // ALL OFF or ALL ON ?
    if (keyWrite === 0x00 || keyWrite === 0xf0) {
      data = new Uint8Array(1);
      // use FAST key command
      data[0] = (XGMFMCommand.FM_KEY | (keyWrite === 0 ? 0x00 : 0x08) | ch) & 0xff;
    } else {
      data = new Uint8Array(2);
      // use ADV key command
      data[0] = XGMFMCommand.FM_KEY_ADV & 0xff;
      data[1] = value & 0xff;
    }

    return new XGMFMCommand(data);
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand[]} commands
   * @param {number} channel
   * @returns {XGMFMCommand}
   */
  static createYMCHCommand(commands, channel) {
    const size = Math.min(8, commands.length);
    const data = new Uint8Array(size * 2 + 1);

    // set command
    data[0] = XGMFMCommand.FM_WRITE & 0xff;
    // set port
    data[0] |= channel >= 3 ? 8 : 0;
    // set size
    data[0] |= (size - 1) & 0xff;

    let off = 1;
    for (let i = 0; i < size; i++) {
      const command = commands[i];
      const reg = command.getYM2612Register();

      data[off++] = reg & 0xff;
      data[off++] = command.getYM2612Value() & 0xff;
    }

    // remove elements we have done
    commands.splice(0, size);

    return new XGMFMCommand(data);
  }

  /**
   * Mirror of the private static createYMFreqCommand(List<VGMCommand>, boolean, boolean).
   * Renamed to avoid clashing with the public int-arg overload of the same Java name.
   * @param {import("./vgm-command.js").VGMCommand[]} commands
   * @param {boolean} keyOffBefore
   * @param {boolean} keyOnAfter
   * @returns {XGMFMCommand}
   */
  static createYMFreqCommandFromVGM(commands, keyOffBefore, keyOnAfter) {
    const data = new Uint8Array(3);

    // frequency is set with 2 VGM commands
    const comFreqHigh = commands[0];
    const comFreqLowh = commands[1];

    const port = comFreqHigh.getYM2612Port();
    const ch = comFreqHigh.getYM2612PortChannel();
    const reg = comFreqHigh.getYM2612Register();
    const spe = reg >= 0xa8 && reg < 0xb0 ? 1 : 0;

    data[0] = (XGMFMCommand.FM_FREQ | (port << 3) | (spe << 2) | ch) & 0xff;
    data[1] = ((comFreqHigh.getYM2612Value() & 0x3f) | (keyOffBefore ? 0x40 : 0x00) | (keyOnAfter ? 0x80 : 0x00)) & 0xff;
    data[2] = comFreqLowh.getYM2612Value() & 0xff;

    return new XGMFMCommand(data);
  }

  /**
   * Mirror of the public static createYMFreqCommand(int, boolean, int, boolean, boolean).
   * @param {number} channel
   * @param {boolean} special
   * @param {number} freq
   * @param {boolean} keyOffBefore
   * @param {boolean} keyOnAfter
   * @returns {XGMFMCommand}
   */
  static createYMFreqCommand(channel, special, freq, keyOffBefore, keyOnAfter) {
    const data = new Uint8Array(3);

    const port = channel >= 3 ? 1 : 0;
    const ch = port === 1 ? (channel + 1) & 3 : channel & 3;

    data[0] = (XGMFMCommand.FM_FREQ | (port << 2) | (special ? 8 : 0) | ch) & 0xff;
    data[1] = (((freq >> 8) & 0x3f) | (keyOffBefore ? 0x40 : 0x00) | (keyOnAfter ? 0x80 : 0x00)) & 0xff;
    data[2] = freq & 0xff;

    return new XGMFMCommand(data);
  }

  /**
   * @param {number} channel
   * @returns {XGMFMCommand}
   */
  static createPCMStopCommand(channel) {
    const data = new Uint8Array(2);

    data[0] = (XGMFMCommand.PCM | (channel & 0x3)) & 0xff;
    // stop command (id #0)
    data[1] = 0;

    return new XGMFMCommand(data);
  }

  /**
   * @param {import("./xgm.js").XGM} xgm
   * @param {import("./vgm-command.js").VGMCommand} command
   * @param {number} channel
   * @returns {XGMFMCommand|null}
   */
  static createPCMCommand(xgm, command, channel) {
    const data = new Uint8Array(2);
    /** @type {XGMSample|null} */
    let sample;

    data[0] = (XGMFMCommand.PCM | (channel & 0x3)) & 0xff;

    if (command.isStreamStartLong()) {
      sample = xgm.getSampleByOriginAddress(command.getStreamSampleAddress());

      // no sample found
      if (sample == null) {
        return null;
      }
    } else if (command.isStreamStart()) {
      sample = xgm.getSampleByOriginId(command.getStreamBlockId() + 1);

      // no sample found
      if (sample == null) {
        return null;
      }
    } else {
      // stop command (id #0)
      data[1] = 0;
      return new XGMFMCommand(data);
    }

    // half speed playback
    if (sample.halfRate) data[0] |= 4;
    data[1] = sample.id & 0xff;

    return new XGMFMCommand(data);
  }

  /**
   * @param {number} port
   * @param {number} ch
   * @param {XGMFMCommand} com
   * @param {YM2612State} ymState
   * @returns {XGMFMCommand[]}
   */
  static convertToSetPanningCommands(port, ch, com, ymState) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    if (!com.isYMWrite()) return result;

    /** @type {number[]} */
    const ignored = [];
    const num = (com.data[0] & 0x07) + 1;

    for (let i = 0; i < num; i++) {
      // reg
      const reg = (getInt8(com.data, i * 2 + 1) & 0xfc) | ch;
      // value
      const value = getInt8(com.data, i * 2 + 2);
      // pan value
      const pan = (value >> 6) & 3;

      // panning write without LFO change ?
      if (reg >= 0xb4 && reg < 0xb8 && (ymState.get(port, reg) & 0x3f) === (value & 0x3f)) {
        const data = new Uint8Array(1);

        data[0] = (port === 0 ? XGMFMCommand.FM0_PAN : XGMFMCommand.FM1_PAN) & 0xff;
        // channel
        data[0] |= ch;
        // panning
        data[0] |= pan << 2;

        result.push(new XGMFMCommand(data, 0, com.time));
      } else {
        // keep trace of ignored
        ignored.push(reg);
        ignored.push(value);
      }
    }

    // update original command
    com.setYMWrite(com.data[0], ignored);

    return result;
  }

  /**
   * @param {number} port
   * @param {number} ch
   * @param {XGMFMCommand} com
   * @returns {XGMFMCommand[]}
   */
  static convertToSetTLCommands(port, ch, com) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    if (!com.isYMWrite()) return result;

    /** @type {number[]} */
    const ignored = [];
    const num = (com.data[0] & 0x07) + 1;

    for (let i = 0; i < num; i++) {
      // reg
      const reg = getInt8(com.data, i * 2 + 1);
      // value
      const value = getInt8(com.data, i * 2 + 2);

      // TL write ?
      if (reg >= 0x40 && reg < 0x50) {
        const data = new Uint8Array(2);
        const s = (reg >> 2) & 3;

        data[0] = (XGMFMCommand.FM_TL + (s << 2) + ch) & 0xff;
        data[1] = ((value & 0x7f) << 1) & 0xff;
        data[1] |= port & 1;

        result.push(new XGMFMCommand(data, 0, com.time));
      } else {
        // keep trace of ignored
        ignored.push(reg);
        ignored.push(value);
      }
    }

    // update original command
    com.setYMWrite(com.data[0], ignored);

    return result;
  }

  /**
   * @param {number} port
   * @param {number} ch
   * @param {XGMFMCommand[]} fmWriteCHCommands
   * @param {YM2612State} ymState
   * @returns {XGMFMCommand}
   */
  static convertToLoadInstCommand(port, ch, fmWriteCHCommands, ymState) {
    const data = new Uint8Array(31);
    /** @type {number[]} */
    const ignored = [];

    data[0] = (XGMFMCommand.FM_LOAD_INST | ((port & 1) << 2) | ((ch & 3) << 0)) & 0xff;

    // initialize values from YM state
    let d = 1;
    let time = 0;

    // slot writes
    for (let r = 0; r < 7; r++)
      for (let s = 0; s < 4; s++) data[d++] = ymState.get(port, 0x30 + (r << 4) + (s << 2) + ch) & 0xff;

    // ch writes
    data[d++] = ymState.get(port, 0xb0 + ch) & 0xff;
    data[d] = ymState.get(port, 0xb4 + ch) & 0xff;

    for (const com of fmWriteCHCommands) {
      if (!com.isYMWrite()) {
        continue;
      }

      // all commands should have same time here
      time = com.time;
      ignored.length = 0;
      const num = com.getYMNumWrite();

      for (let i = 0; i < num; i++) {
        // reg
        const reg = getInt8(com.data, i * 2 + 1);
        // value
        const value = getInt8(com.data, i * 2 + 2);

        // slot write ?
        if (reg >= 0x30 && reg < 0xa0) {
          const r = (reg >> 4) & 0xf;
          const s = (reg >> 2) & 3;
          // get data index
          const index = (r - 3) * 4 + s;

          data[index + 1] = value & 0xff;
        }
        // channel write (ALGO or PAN/LFO register)
        else if (reg >= 0xb0 && reg <= 0xb8) data[29 + (reg >= 0xb4 ? 1 : 0)] = value & 0xff;
        else {
          // keep trace of ignored
          ignored.push(reg);
          ignored.push(value);
        }
      }

      // update original command
      com.setYMWrite(com.data[0], ignored);
    }

    return new XGMFMCommand(data, 0, time);
  }
}

/**
 * Slice helper mirroring Arrays.copyOfRange(data, from, to) returning a Uint8Array.
 * @param {Uint8Array|number[]} data
 * @param {number} from
 * @param {number} to
 * @returns {Uint8Array}
 */
function sliceBytes(data, from, to) {
  const out = new Uint8Array(to - from);
  for (let i = 0; i < out.length; i++) out[i] = data[from + i] & 0xff;
  return out;
}

export class WaitShortCommand extends XGMFMCommand {
  /**
   * @param {number} wait
   */
  constructor(wait) {
    super(Uint8Array.from([(XGMFMCommand.WAIT_SHORT | ((wait - 1) & 0xf)) & 0xff]));
  }
}

export class WaitLongCommand extends XGMFMCommand {
  /**
   * @param {number} wait
   */
  constructor(wait) {
    super(Uint8Array.from([XGMFMCommand.WAIT_LONG & 0xff, (wait - 16) & 0xff]));
  }
}

export class FrameCommand extends XGMFMCommand {
  constructor() {
    super(Uint8Array.from([XGMFMCommand.WAIT_SHORT & 0xff]));
  }
}

export class FrameDelayCommand extends XGMFMCommand {
  constructor() {
    super(Uint8Array.from([XGMFMCommand.FRAME_DELAY & 0xff]));
  }
}

export class LoopCommand extends XGMFMCommand {
  /**
   * @param {number} offset
   */
  constructor(offset) {
    super(
      Uint8Array.from([
        XGMFMCommand.LOOP & 0xff,
        (offset >> 0) & 0xff,
        (offset >> 8) & 0xff,
        (offset >> 16) & 0xff,
      ]),
    );
  }
}

export class LoopStartCommand extends XGMFMCommand {
  constructor() {
    super(new Uint8Array(0));
  }
}

export class EndCommand extends LoopCommand {
  constructor() {
    super(-1);
  }
}

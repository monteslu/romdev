// Port of sgdk.xgm2tool.format.SampleBank — VGM sample data bank + InternalSample.

import * as Util from "./util.js";
import { VGMCommand } from "./vgm-command.js";
import { Sample } from "./sample.js";

/** Zero-padded uppercase hex string of `value` to `size` digits (StringUtil.toHexaString). */
function toHexaString(value, size) {
  let s = (value >>> 0).toString(16).toUpperCase();
  while (s.length < size) s = "0" + s;
  return s;
}

export class SampleBank {
  /**
   * @param {VGMCommand} command
   */
  constructor(command) {
    /** @type {InternalSample[]} */
    this.samples = [];
    /** @type {Uint8Array} */
    this.data = null;
    /** @type {number} */
    this.id = 0;

    if (!command.isDataBlock())
      throw new Error(
        `Incorrect sample data declaration at ${toHexaString(command.getOriginOffset(), 6)} !`
      );

    // id
    this.id = command.getDataBankId();
    // data block
    this.data = command.data.slice(7, command.getDataBlockLen() + 7);

    this.samples = [];

    // consider the whole bank as a single sample by default
    this.samples.push(new InternalSample(this, 0, 0, this.data.length, 0));
  }

  getLength() {
    return this.data.length;
  }

  /**
   * @param {VGMCommand} command
   */
  addBlock(command) {
    if (!command.isDataBlock()) return;

    // concat data block
    const newData = new Uint8Array(this.getLength() + command.getDataBlockLen());

    newData.set(this.data.subarray(0, this.getLength()), 0);
    newData.set(
      command.data.subarray(7, 7 + command.getDataBlockLen()),
      this.getLength()
    );

    // add new sample corresponding to this data block
    this.samples.push(
      new InternalSample(
        this,
        this.samples.length,
        this.getLength(),
        command.getDataBlockLen(),
        0
      )
    );

    // set new data
    this.data = newData;
  }

  getDataBlockCommand() {
    const comData = new Uint8Array(this.getLength() + 7);

    // build data block header
    comData[0] = 0x67;
    comData[1] = 0x66;
    comData[2] = 0x00;
    Util.setInt32(comData, 3, this.getLength());

    // copy sample data
    comData.set(this.data.subarray(0, this.data.length), 7);

    // return command
    return new VGMCommand(comData);
  }

  getDeclarationCommands() {
    /** @type {VGMCommand[]} */
    const result = [];

    // rebuild data
    result.push(
      new VGMCommand(
        Uint8Array.from([
          VGMCommand.STREAM_CONTROL & 0xff,
          this.id & 0xff,
          0x02,
          0x00,
          0x2a,
        ])
      )
    );
    result.push(
      new VGMCommand(
        Uint8Array.from([
          VGMCommand.STREAM_DATA & 0xff,
          this.id & 0xff,
          this.id & 0xff,
          0x01,
          0x00,
        ])
      )
    );

    return result;
  }

  /**
   * @param {number} address
   * @returns {InternalSample|null}
   */
  getSampleByAddress(address) {
    for (const sample of this.samples) {
      if (sample.matchAddress(address)) return sample;
    }

    return null;
  }

  /**
   * @param {number} id
   * @returns {InternalSample|null}
   */
  getSampleById(id) {
    for (const sample of this.samples) if (sample.id === id) return sample;

    return null;
  }

  /**
   * @param {number} address
   * @param {number} len
   * @param {number} rate
   * @returns {InternalSample}
   */
  addSample(address, len, rate) {
    let adjLen = len;

    // end outside bank ? --> bound it to bank size
    if (address + adjLen > this.getLength()) adjLen = this.getLength() - address;

    let result = this.getSampleByAddress(address);

    // not found --> create new sample
    if (result == null) {
      result = new InternalSample(this, this.samples.length, address, adjLen, rate);
      this.samples.push(result);
    } else {
      // get address delta (as we allow a small delta when searching for the sample
      const deltaAddr = address - result.addr;
      // adjust len from address delta
      adjLen -= deltaAddr;
      // bound to bank size if needed
      if (result.addr + adjLen > this.getLength())
        adjLen = this.getLength() - result.addr;

      // new defined sample ?
      if (result.rate === 0) {
        result.rate = rate;
        result.len = adjLen;
      }
      // adjust sample info
      else {
        // we apply smooth change of sample rate
        if (Util.isDiffRate(result.rate, rate)) {
          // smooth sample rate change
          result.rate = Math.floor((result.rate + rate) / 2);
        }

        // adjust length only if longer
        if (result.len < adjLen) {
          result.len = adjLen;
        }
      }
    }

    return result;
  }

  // remove unused part of the data array, pack it and update sample addresses
  // return map<sample_addr_old, sample_addr_new>
  /**
   * @returns {Map<number, number>}
   */
  optimize() {
    /** @type {Map<number, number>} */
    const sampleAddrChanges = new Map();

    // sort samples by address
    this.samples.sort((a, b) => a.compareTo(b));

    // rebuild contiguous buffer for all samples
    const newData = new Uint8Array(this.data.length);

    let addr = 0;
    let cumulatedOff = 0;
    for (const sample of this.samples) {
      if (sample.addr <= addr + cumulatedOff)
        // set position on current sample start address
        addr = sample.addr - cumulatedOff;
      // add delta to cumulated offset
      else cumulatedOff += sample.addr - (addr + cumulatedOff);

      // copy sample data to new buffer
      newData.set(this.data.subarray(sample.addr, sample.addr + sample.len), addr);
      // store old_addr / new_addr couple
      sampleAddrChanges.set(sample.addr, addr);
      // then fix sample address
      sample.addr = addr;
      // next
      addr += sample.len;
    }

    // set the data
    this.data = newData.slice(0, addr);

    return sampleAddrChanges;
  }
}

export class InternalSample {
  /**
   * @param {SampleBank} bank
   * @param {number} id
   * @param {number} addr
   * @param {number} len
   * @param {number} rate
   */
  constructor(bank, id, addr, len, rate) {
    /** @type {SampleBank} */
    this.bank = bank;
    /** @type {number} */
    this.id = id;
    /** @type {number} */
    this.addr = addr;
    /** @type {number} */
    this.len = len;
    /** @type {number} */
    this.rate = rate;
  }

  getBank() {
    return this.bank;
  }

  /**
   * @param {number} value
   */
  setRate(value) {
    if (value !== 0 && this.rate !== value) {
      this.rate = value;
    }
  }

  getFrameSize() {
    if (this.rate > 0) return Math.floor(this.rate / 60);

    // consider 4Khz by default for safety
    return Math.floor(4000 / 60);
  }

  /**
   * @param {number} address
   * @returns {boolean}
   */
  matchAddress(address) {
    const frameSize = this.getFrameSize();
    // allow a margin of 1 frame for address
    return Math.abs(this.addr - address) < frameSize;
  }

  /**
   * @param {number} r
   * @returns {VGMCommand}
   */
  getSetRateCommand(r) {
    return new VGMCommand(
      Uint8Array.from([
        VGMCommand.STREAM_FREQUENCY & 0xff,
        this.bank.id & 0xff,
        (r >> 0) & 0xff,
        (r >> 8) & 0xff,
        0x00,
        0x00,
      ])
    );
  }

  /**
   * @param {number} [l]
   * @returns {VGMCommand}
   */
  getStartLongCommand(l) {
    if (l === undefined) l = this.len;
    const adjLen = Math.min(l, this.len);
    return new VGMCommand(
      Uint8Array.from([
        VGMCommand.STREAM_START_LONG & 0xff,
        this.bank.id & 0xff,
        (this.addr >> 0) & 0xff,
        (this.addr >> 8) & 0xff,
        (this.addr >> 16) & 0xff,
        0x00,
        0x01,
        (adjLen >> 0) & 0xff,
        (adjLen >> 8) & 0xff,
        (adjLen >> 16) & 0xff,
        0x00,
      ])
    );
  }

  /**
   * @returns {VGMCommand}
   */
  getStopCommand() {
    return new VGMCommand(
      Uint8Array.from([VGMCommand.STREAM_STOP & 0xff, this.bank.id & 0xff])
    );
  }

  /**
   * @returns {Sample}
   */
  toIsolatedSample() {
    const ndata = new Uint8Array(this.len);

    ndata.set(this.bank.data.subarray(this.addr, this.addr + this.len), 0);

    return new Sample(ndata, this.rate);
  }

  /**
   * @param {InternalSample} is
   * @returns {number}
   */
  compareTo(is) {
    return this.addr < is.addr ? -1 : this.addr > is.addr ? 1 : 0;
  }

  toString() {
    return (
      "#" +
      this.id +
      " - rate:" +
      this.rate +
      " addr:" +
      toHexaString(this.addr, 6) +
      " len:" +
      toHexaString(this.len, 6)
    );
  }
}

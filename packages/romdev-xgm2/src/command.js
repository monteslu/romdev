// Port of sgdk.xgm2tool.format.Command — abstract base for VGM/XGM commands.

import { getInt8 } from "./util.js";

/**
 * Abstract base class for a sound chip command (VGM / XGM).
 * Subclasses must implement getChannel().
 */
export class Command {
  /**
   * Comparator ordering commands by their `time` field.
   * @param {Command} c1
   * @param {Command} c2
   * @returns {number}
   */
  static timeComparator(c1, c2) {
    // Integer.compare(c1.time, c2.time)
    return c1.time - c2.time;
  }

  /**
   * @param {Command[]} commands
   * @param {Command} command
   * @returns {boolean}
   */
  static contains(commands, command) {
    for (const c of commands) if (c.isSame(command)) return true;

    return false;
  }

  /**
   * @param {Command[]} commands
   * @returns {number}
   */
  static getDataSize(commands) {
    let result = 0;

    for (const c of commands) result += c.size;

    return result;
  }

  /**
   * Return index of the command at given time
   * @param {Command[]} commands
   * @param {number} time
   * @returns {number}
   */
  static getCommandIndexAtTime(commands, time) {
    // we could do that a lot faster by using dichotomy but we don't care
    for (let c = 0; c < commands.length; c++)
      if (commands[c].time >= time) return c;

    return commands.length - 1;
  }

  /**
   * Return command at given vgmTime
   * @param {Command[]} commands
   * @param {number} time
   * @returns {Command|null}
   */
  static getCommandAtTime(commands, time) {
    const ind = Command.getCommandIndexAtTime(commands, time);

    if (ind >= 0) return commands[ind];

    return null;
  }

  /**
   * Return command index at given origin offset
   * @param {Command[]} commands
   * @param {number} offset
   * @returns {number}
   */
  static getCommandIndexAtOffset(commands, offset) {
    for (let c = 0; c < commands.length; c++)
      if (commands[c].getOriginOffset() === offset) return c;

    return -1;
  }

  /**
   * Return command index at given origin offset
   * @param {Command[]} commands
   * @param {number} offset
   * @returns {Command|null}
   */
  static getCommandAtOffset(commands, offset) {
    const ind = Command.getCommandIndexAtOffset(commands, offset);

    if (ind >= 0) return commands[ind];

    return null;
  }

  /**
   * Update origin offset information for all command
   * @param {Command[]} commands
   * @param {number} startOffset
   */
  static computeOffsets(commands, startOffset) {
    let off = startOffset;

    for (const com of commands) {
      com.originOffset = off;
      off += com.size;
    }
  }

  /**
   * @param {number} port
   * @param {number} reg
   * @param {number} value
   * @returns {string}
   */
  static getYMCommandDesc(port, reg, value) {
    let res;

    if (reg < 0x20) return "Unknow YM write";

    if (reg < 0x30) {
      switch (reg & 0x0f) {
        case 2:
          return "Set LFO";
        case 4:
          return "Timer A MSB";
        case 5:
          return "Timer A LSB";
        case 6:
          return "Timer B";
        case 7:
          return "CH2 mode / timer reset";
        case 8:
          if ((value & 0xf0) === 0) res = "KEY OFF";
          else res = "KEY ON";
          return res + " CH" + ((value & 0x0f) >= 4 ? (value & 3) + 3 : value & 3);
        case 0xa:
          return "DAC value";
        case 0xb:
          return "DAC enable";
        default:
          return "Unknow YM write";
      }
    } else if (reg >= 0xa0) {
      if (reg >= 0xa8 && reg < 0xb0)
        res = "CH" + (port > 0 ? "5" : "2") + " OP" + ((reg & 3) + 1) + " - ";
      else res = "CH" + (port > 0 ? (reg & 3) + 3 : reg & 3) + " - ";

      switch (reg & 0xfc) {
        case 0xa0:
          return res + "FREQ LSB";
        case 0xa4:
          return res + "FREQ MSB";
        case 0xa8:
          return res + "FREQ LSB (SPE)";
        case 0xac:
          return res + "FREQ MSB (SPE)";
        case 0xb0:
          return res + "Feedback / AlgoR";
        case 0xb4:
          return res + "PAN / AMS / FMS";
        default:
          return res + "Unknow CH set";
      }
    } else {
      res =
        "CH" +
        (port > 0 ? (reg & 3) + 3 : reg & 3) +
        " " +
        "OP" +
        ((reg >> 2) & 3) +
        " - ";

      switch (reg & 0xf0) {
        case 0x30:
          return res + "DT / MUL";
        case 0x40:
          return res + "TL";
        case 0x50:
          return res + "RS / AR";
        case 0x60:
          return res + "AM / D1R";
        case 0x70:
          return res + "D2R";
        case 0x80:
          return res + "SL / RR";
        case 0x90:
          return res + "SSG-EG";
        default:
          return res + "Unknow slot set";
      }
    }
  }

  /**
   * @param {Uint8Array|number[]|number} data raw command bytes, or an int command value
   * @param {number} [time] time in 1/44100 of second (VGM format)
   */
  constructor(data, time) {
    if (typeof data === "number") {
      // Command(int command, int time) / Command(int command)
      const command = data;
      this.data = Uint8Array.from([command & 0xff]);
      this.time = time === undefined ? 0 : time;

      this.size = 1;
      this.originOffset = 0;
      return;
    }

    // Command(byte[] data, int time) / Command(byte[] data)
    /** @type {Uint8Array|number[]} */
    this.data = data;
    /**
     * Time is expressed in 1/44100 of second (VGM format)
     * @type {number}
     */
    this.time = time === undefined ? 0 : time;

    // not yet computed
    /**
     * Size of the command in byte
     * @type {number}
     */
    this.size = 0;
    /** @type {number} */
    this.originOffset = 0;
  }

  /**
   * @returns {number}
   */
  getCommand() {
    return getInt8(this.data, 0);
  }

  /**
   * @returns {number}
   */
  getOriginOffset() {
    return this.originOffset;
  }

  /**
   * @abstract
   * @returns {number}
   */
  getChannel() {
    throw new Error("Command.getChannel() not implemented");
  }

  /**
   * Return time of this command in ms
   * @returns {number}
   */
  getMilliSecond() {
    return Math.trunc((this.time * 1000) / 44100);
  }

  /**
   * Return time of this command in frame (PAL or NTSC depending the argument)
   * @param {boolean} pal
   * @returns {number}
   */
  getFrame(pal) {
    if (pal) return Math.trunc(this.time / 882);

    return Math.trunc(this.time / 735);
  }

  /**
   * @param {Command} com
   * @returns {boolean}
   */
  isSame(com) {
    // compare data
    return arraysEqual(this.data, com.data);
  }

  /**
   * @returns {Uint8Array|number[]}
   */
  asByteArray() {
    return this.data;
  }

  /**
   * @returns {string}
   */
  toHexaString() {
    return getBytesAsHexaString(this.data, 0, this.size, 32);
  }

  /**
   * @returns {string}
   */
  toString() {
    return this.toHexaString();
  }
}

/**
 * Mirror of java.util.Arrays.equals(byte[], byte[]): equal length and bytes.
 * @param {Uint8Array|number[]} a
 * @param {Uint8Array|number[]} b
 * @returns {boolean}
 */
function arraysEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  return true;
}

/**
 * Mirror of sgdk.xgm2tool.tool.Util.getBytesAsHexaString: render `size` bytes
 * starting at `offset` as space-separated 2-digit hex, wrapping after `maxByte`
 * bytes per line.
 * @param {Uint8Array|number[]} data
 * @param {number} offset
 * @param {number} size
 * @param {number} maxByte
 * @returns {string}
 */
function getBytesAsHexaString(data, offset, size, maxByte) {
  let result = "";
  let count = 0;

  for (let i = 0; i < size; i++) {
    const b = data[offset + i] & 0xff;
    let hex = b.toString(16).toUpperCase();
    if (hex.length < 2) hex = "0" + hex;
    result += hex;
    count++;
    if (count >= maxByte) {
      result += "\n";
      count = 0;
    } else result += " ";
  }

  return result;
}

// Port of sgdk.xgm2tool.format.XGMPSGCommand — XGM2 PSG (SN76489) command codec.

import { Command } from "./command.js";
import { getInt8, getInt24, setInt24 } from "./util.js";

/**
 * Faithful mirror of sgdk.tool.StringUtil.toHexaString(int value, int size):
 * Integer.toHexString (LOWERCASE) of `value`, then forced to exactly `size`
 * chars — keep last `size` chars if longer, left-pad with '0' if shorter.
 * @param {number} value
 * @param {number} size
 * @returns {string}
 */
function toHexaString(value, size) {
  // Integer.toHexString treats value as unsigned 32-bit.
  let result = (value >>> 0).toString(16);

  if (result.length > size) return result.substring(result.length - size);

  while (result.length < size) result = "0" + result;
  return result;
}

/**
 * XGM2 PSG command (Texas Instruments SN76489 / Sega PSG).
 * @extends Command
 */
export class XGMPSGCommand extends Command {
  /**
   * @param {XGMPSGCommand[]} commands
   * @param {number} channel
   * @param {boolean} getWait
   * @param {boolean} getLoopStart
   * @returns {XGMPSGCommand[]}
   */
  static filterChannel(commands, channel, getWait, getLoopStart) {
    const result = [];

    for (const com of commands)
      if (
        com.getChannel() === channel ||
        (getWait && com.isWait(true)) ||
        (getLoopStart && com.isLoopStart())
      )
        result.push(com);

    return result;
  }

  /**
   * @param {XGMPSGCommand[]} commands
   * @returns {XGMPSGCommand[]}
   */
  static filterEnv(commands) {
    const result = [];

    for (const com of commands) if (com.isEnv()) result.push(com);

    return result;
  }

  /**
   * @param {XGMPSGCommand[]} commands
   * @returns {XGMPSGCommand[]}
   */
  static filterFreq(commands) {
    const result = [];

    for (const com of commands) if (com.isFreq()) result.push(com);

    return result;
  }

  /**
   * @param {XGMPSGCommand[]} newPSGCommands
   * @returns {boolean}
   */
  static hasWaitCommand(newPSGCommands) {
    for (const com of newPSGCommands) if (com.getWaitFrame() > 0) return true;

    return false;
  }

  /**
   * @param {Uint8Array|number[]} data
   * @param {number} offset
   * @returns {number}
   */
  static computeSize(data, offset) {
    const command = getInt8(data, offset);

    switch (command) {
      case XGMPSGCommand.WAIT_LONG:
        return 2;
      case XGMPSGCommand.LOOP:
        return 4;
    }

    switch (command & 0xf0) {
      default:
      case XGMPSGCommand.WAIT_SHORT:
        return 1;

      case XGMPSGCommand.FREQ:
      case XGMPSGCommand.FREQ_WAIT:
      case XGMPSGCommand.FREQ_LOW:
        return 2;

      case XGMPSGCommand.FREQ0_DELTA:
      case XGMPSGCommand.FREQ1_DELTA:
      case XGMPSGCommand.FREQ2_DELTA:
      case XGMPSGCommand.FREQ3_DELTA:
      case XGMPSGCommand.ENV0:
      case XGMPSGCommand.ENV1:
      case XGMPSGCommand.ENV2:
      case XGMPSGCommand.ENV3:
      case XGMPSGCommand.ENV0_DELTA:
      case XGMPSGCommand.ENV1_DELTA:
      case XGMPSGCommand.ENV2_DELTA:
      case XGMPSGCommand.ENV3_DELTA:
        return 1;
    }
  }

  /**
   * Java has three constructors:
   *   XGMPSGCommand(byte[] data, int offset) — slices computeSize bytes
   *   XGMPSGCommand(byte[] data)             — wraps the given bytes
   *   XGMPSGCommand(int command)             — single-byte command
   * Dispatch on argument shape to reproduce all three.
   * @param {Uint8Array|number[]|number} data raw command bytes, or an int command value
   * @param {number} [offset] when provided, slice computeSize bytes from `offset`
   */
  constructor(data, offset) {
    if (typeof data === "number") {
      // XGMPSGCommand(int command) -> super(command)
      super(data);
      this.size = this.data.length;
    } else if (offset !== undefined) {
      // XGMPSGCommand(byte[] data, int offset)
      //   -> this(Arrays.copyOfRange(data, offset, offset + computeSize(data, offset)))
      const sub = data.slice(offset, offset + XGMPSGCommand.computeSize(data, offset));
      super(sub);
      this.size = this.data.length;
    } else {
      // XGMPSGCommand(byte[] data) -> super(data)
      super(data);
      this.size = this.data.length;
    }

    /** @type {boolean} */
    this.dummy = false;
  }

  /**
   * @returns {number}
   */
  getType() {
    if (this instanceof LoopStartCommand) return XGMPSGCommand.LOOP_START;

    const com = this.getCommand();

    if (this.isDummy()) return XGMPSGCommand.DUMMY;

    if (com === XGMPSGCommand.WAIT_LONG) return XGMPSGCommand.WAIT_LONG;
    if (com === XGMPSGCommand.LOOP) return XGMPSGCommand.LOOP;

    return com & 0xf0;
  }

  /**
   * @returns {boolean}
   */
  isWaitShort() {
    return this.getType() === XGMPSGCommand.WAIT_SHORT;
  }

  /**
   * @returns {boolean}
   */
  isWaitLong() {
    return this.getType() === XGMPSGCommand.WAIT_LONG;
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
      this.isFreqWait() ||
      this.isFreqLowWait() ||
      this.isFreqDeltaWait() ||
      this.isEnvDeltaWait()
    );
  }

  /**
   * @returns {number}
   */
  getWaitFrame() {
    if (this.isWaitLong()) return getInt8(this.data, 1) + 15;
    if (this.isWaitShort()) return (getInt8(this.data, 0) & 0xf) + 1;
    if (this.isWait(false)) return 1;

    return 0;
  }

  /**
   * @returns {boolean}
   */
  isLoopStart() {
    return this instanceof LoopStartCommand;
  }

  /**
   * @returns {boolean}
   */
  isLoop() {
    return this.getType() === XGMPSGCommand.LOOP;
  }

  /**
   * @returns {boolean}
   */
  isFreqWait() {
    return this.getType() === XGMPSGCommand.FREQ_WAIT;
  }

  /**
   * @returns {boolean}
   */
  isFreqNoWait() {
    return this.getType() === XGMPSGCommand.FREQ;
  }

  /**
   * @returns {boolean}
   */
  isFreq() {
    return this.isFreqNoWait() || this.isFreqWait();
  }

  /**
   * @returns {boolean}
   */
  isFreqLow() {
    return this.getType() === XGMPSGCommand.FREQ_LOW;
  }

  /**
   * @returns {boolean}
   */
  isFreqLowNoWait() {
    return this.isFreqLow() && (this.data[0] & 1) === 0;
  }

  /**
   * @returns {boolean}
   */
  isFreqLowWait() {
    return this.isFreqLow() && (this.data[0] & 1) !== 0;
  }

  /**
   * @returns {boolean}
   */
  isFreqDelta() {
    return (
      this.getType() === XGMPSGCommand.FREQ0_DELTA ||
      this.getType() === XGMPSGCommand.FREQ1_DELTA ||
      this.getType() === XGMPSGCommand.FREQ2_DELTA
    );
  }

  /**
   * @returns {boolean}
   */
  isFreqDeltaNoWait() {
    return this.isFreqDelta() && (this.data[0] & 8) === 0;
  }

  /**
   * @returns {boolean}
   */
  isFreqDeltaWait() {
    return this.isFreqDelta() && (this.data[0] & 8) !== 0;
  }

  /**
   * @returns {boolean}
   */
  isEnv() {
    return (
      this.getType() === XGMPSGCommand.ENV0 ||
      this.getType() === XGMPSGCommand.ENV1 ||
      this.getType() === XGMPSGCommand.ENV2 ||
      this.getType() === XGMPSGCommand.ENV3
    );
  }

  /**
   * @returns {boolean}
   */
  isEnvDelta() {
    return (
      this.getType() === XGMPSGCommand.ENV0_DELTA ||
      this.getType() === XGMPSGCommand.ENV1_DELTA ||
      this.getType() === XGMPSGCommand.ENV2_DELTA ||
      this.getType() === XGMPSGCommand.ENV3_DELTA
    );
  }

  /**
   * @returns {boolean}
   */
  isEnvDeltaNoWait() {
    return this.isEnvDelta() && (this.data[0] & 8) === 0;
  }

  /**
   * @returns {boolean}
   */
  isEnvDeltaWait() {
    return this.isEnvDelta() && (this.data[0] & 8) !== 0;
  }

  /**
   * can this command be muted in com + wait ?
   * @returns {boolean}
   */
  supportWait() {
    return this.isEnvDelta() || this.isFreq() || this.isFreqLow() || this.isFreqDelta();
  }

  /**
   * @returns {boolean}
   */
  addWait() {
    if (this.supportWait()) {
      if (this.isEnvDeltaNoWait()) this.data[0] |= 8;
      else if (this.isFreqNoWait())
        this.data[0] = (this.data[0] + (XGMPSGCommand.FREQ_WAIT - XGMPSGCommand.FREQ)) & 0xff;
      else if (this.isFreqLowNoWait()) this.data[0] |= 1;
      else if (this.isFreqDeltaNoWait()) this.data[0] |= 8;
      else return false;
    }

    return true;
  }

  /**
   * @override
   * @returns {number}
   */
  getChannel() {
    switch (this.getType()) {
      case XGMPSGCommand.ENV0:
      case XGMPSGCommand.ENV0_DELTA:
      case XGMPSGCommand.FREQ0_DELTA:
        return 0;
      case XGMPSGCommand.ENV1:
      case XGMPSGCommand.ENV1_DELTA:
      case XGMPSGCommand.FREQ1_DELTA:
        return 1;
      case XGMPSGCommand.ENV2:
      case XGMPSGCommand.ENV2_DELTA:
      case XGMPSGCommand.FREQ2_DELTA:
        return 2;
      case XGMPSGCommand.ENV3:
      case XGMPSGCommand.ENV3_DELTA:
      case XGMPSGCommand.FREQ3_DELTA:
        return 3;
    }

    if (this.isFreq()) return (getInt8(this.data, 0) >> 2) & 3;
    if (this.isFreqLow()) return (getInt8(this.data, 1) >> 5) & 3;

    return -1;
  }

  /**
   * @returns {number}
   */
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

  /**
   * @param {number} freq
   */
  setFreq(freq) {
    if (this.isFreq()) {
      this.data[0] = ((this.data[0] & 0xfc) | ((freq >> 8) & 0x3)) & 0xff;
      this.data[1] = freq & 0xff;
    }
  }

  /**
   * @returns {number}
   */
  getFreq() {
    if (this.isFreq()) return ((this.data[0] & 0x3) << 8) | (this.data[1] & 0xff);

    return -1;
  }

  /**
   * @param {number} freqLow
   */
  setFreqLow(freqLow) {
    if (this.isFreqLow()) this.data[1] = ((this.data[1] & 0xf0) | (freqLow & 0x0f)) & 0xff;
  }

  /**
   * @returns {number}
   */
  getFreqLow() {
    if (this.isFreqLow()) return this.data[1] & 0xf;

    return -1;
  }

  /**
   * @param {number} delta
   */
  setFreqDelta(delta) {
    if (this.isFreqDelta())
      this.data[0] =
        ((this.data[0] & 0xf8) | (delta < 0 ? 4 | -delta : delta)) & 0xff;
  }

  /**
   * @returns {number}
   */
  getFreqDelta() {
    if (this.isFreqDelta()) {
      const delta = ((this.data[0] >> 0) & 3) + 1;
      return (this.data[0] & 4) !== 0 ? -delta : delta;
    }

    return 0;
  }

  /**
   * only for freq or freq low command
   * @param {number} delta
   */
  toFreqDelta(delta) {
    if (this.isFreq() || this.isFreqLow()) {
      const deltav = delta < 0 ? -(delta + 1) : delta - 1;
      const v =
        (this.isFreqWait() || this.isFreqLowWait() ? 8 : 0) |
        (delta < 0 ? 4 : 0) |
        deltav;

      switch (this.getChannel()) {
        case 0:
          this.data = Uint8Array.from([(XGMPSGCommand.FREQ0_DELTA | v) & 0xff]);
          this.size = 1;
          break;
        case 1:
          this.data = Uint8Array.from([(XGMPSGCommand.FREQ1_DELTA | v) & 0xff]);
          this.size = 1;
          break;
        case 2:
          this.data = Uint8Array.from([(XGMPSGCommand.FREQ2_DELTA | v) & 0xff]);
          this.size = 1;
          break;
        case 3:
          this.data = Uint8Array.from([(XGMPSGCommand.FREQ3_DELTA | v) & 0xff]);
          this.size = 1;
          break;
      }
    }
  }

  /**
   * only for freq command
   * @param {number} freqLow
   */
  toFreqLow(freqLow) {
    if (this.isFreq()) {
      const wait = this.isFreqWait();
      const ch = this.getChannel();

      // same size (2) so we don't need to re-allocate data
      this.data[0] = (XGMPSGCommand.FREQ_LOW | (wait ? 1 : 0)) & 0xff;
      this.data[1] = (0x80 | (ch << 5) | freqLow) & 0xff;
    }
  }

  /**
   * @returns {number}
   */
  getEnv() {
    if (this.isEnv()) return getInt8(this.data, 0) & 0xf;

    return -1;
  }

  /**
   * @returns {number}
   */
  getEnvDelta() {
    if (this.isEnvDelta()) {
      const delta = ((this.data[0] >> 0) & 3) + 1;
      return (this.data[0] & 4) !== 0 ? -delta : delta;
    }

    return 0;
  }

  /**
   * only for env command
   * @param {number} delta
   */
  toEnvDelta(delta) {
    if (this.isEnv()) {
      const deltav = delta < 0 ? -(delta + 1) : delta - 1;
      const v = (delta < 0 ? 4 : 0) | deltav;

      switch (this.getChannel()) {
        case 0:
          this.data = Uint8Array.from([(XGMPSGCommand.ENV0_DELTA | v) & 0xff]);
          this.size = 1;
          break;
        case 1:
          this.data = Uint8Array.from([(XGMPSGCommand.ENV1_DELTA | v) & 0xff]);
          this.size = 1;
          break;
        case 2:
          this.data = Uint8Array.from([(XGMPSGCommand.ENV2_DELTA | v) & 0xff]);
          this.size = 1;
          break;
        case 3:
          this.data = Uint8Array.from([(XGMPSGCommand.ENV3_DELTA | v) & 0xff]);
          this.size = 1;
          break;
      }
    }
  }

  /**
   * @returns {boolean}
   */
  isDummy() {
    return this.dummy;
  }

  clearDummy() {
    this.dummy = false;
  }

  setDummy() {
    this.dummy = true;
  }

  /**
   * @override
   * @returns {string}
   */
  toString() {
    let result = "";

    if (this.isDummy())
      result += "PSG DUMMY - " + new XGMPSGCommand(this.data).toString();
    else if (this.isWaitShort()) result += "PSG WAIT S #" + this.getWaitFrame();
    else if (this.isWaitLong()) result += "PSG WAIT L #" + this.getWaitFrame();
    else if (this.isEnv()) result += "PSG ENV #" + toHexaString(this.getEnv(), 1);
    else if (this.isEnvDeltaNoWait()) result += "PSG ENVD " + this.getEnvDelta();
    else if (this.isEnvDeltaWait()) result += "PSG ENVD " + this.getEnvDelta() + " W";
    else if (this.isFreqNoWait()) result += "PSG FREQ #" + toHexaString(this.getFreq(), 3);
    else if (this.isFreqWait()) result += "PSG FREQ W #" + toHexaString(this.getFreq(), 3);
    else if (this.isFreqLowNoWait())
      result += "PSG FREQL #" + toHexaString(this.getFreqLow(), 1);
    else if (this.isFreqLowWait())
      result += "PSG FREQL W #" + toHexaString(this.getFreqLow(), 1);
    else if (this.isFreqDeltaNoWait()) result += "PSG FREQD " + this.getFreqDelta();
    else if (this.isFreqDeltaWait()) result += "PSG FREQD W " + this.getFreqDelta();
    else if (this.isLoopStart()) result += "PSG LOOP St";
    else if (this.isLoop())
      result += "PSG LOOP #" + toHexaString(this.getLoopAddr(), 6);

    return result;
  }

  /**
   * @param {number} wait
   * @returns {XGMPSGCommand[]}
   */
  static createWaitCommands(wait) {
    const result = [];
    let remain = wait;

    while (remain > 270) {
      result.push(new WaitLongCommand(270));
      remain -= 270;
    }
    if (remain > 14) result.push(new WaitLongCommand(remain));
    else result.push(new WaitShortCommand(remain));

    return result;
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand[]} commands
   * @returns {XGMPSGCommand[]}
   */
  static createPSGCommands(commands) {
    const result = [];
    const remaining = [...commands];
    const toneCommands = [];
    const toRemove = [];

    if (commands.length === 0) return result;

    /** @type {import("./vgm-command.js").VGMCommand|null} */
    let lowByteCom = null;
    // build complete tone commands
    for (const com of commands) {
      // data write ?
      if (com.isPSGHighByteWrite()) {
        if (lowByteCom !== null) {
          // previous command was low
          if (lowByteCom.isPSGToneLowWrite()) {
            // add complete set tone commands
            toneCommands.push(lowByteCom);
            toneCommands.push(com);
          } else {
            // overwrite previous env command data and remove current
            lowByteCom.data[1] =
              ((lowByteCom.data[1] & 0xf0) | (com.getPSGValue() & 0x0f)) & 0xff;
            // remove current
            toRemove.push(com);
          }
        }
      } else lowByteCom = com;
    }

    // remove complete tone commands from remaining
    removeAll(remaining, toneCommands);
    removeAll(remaining, toRemove);

    // add complete tone commands
    for (const c of XGMPSGCommand.createPSGToneCommands(toneCommands)) result.push(c);

    // then add others command
    for (const com of remaining)
      // should always be the case..
      if (com.isPSGLowByteWrite()) result.push(XGMPSGCommand.createPSGByteCommand(com));

    return result;
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand[]} commands
   * @returns {XGMPSGCommand[]}
   */
  static createPSGToneCommands(commands) {
    const result = [];

    for (let i = 0; i < commands.length; i += 2)
      result.push(XGMPSGCommand.createPSGToneCommand(commands[i + 0], commands[i + 1]));

    return result;
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand} command
   * @returns {XGMPSGCommand}
   */
  static createPSGByteCommand(command) {
    if (command.isPSGEnvWrite()) {
      let data;

      switch (command.getPSGChannel()) {
        default:
        case 0:
          data = XGMPSGCommand.ENV0;
          break;
        case 1:
          data = XGMPSGCommand.ENV1;
          break;
        case 2:
          data = XGMPSGCommand.ENV2;
          break;
        case 3:
          data = XGMPSGCommand.ENV3;
          break;
      }

      // set value
      data = (data | (command.getPSGValue() & 0xf)) & 0xff;

      // create PSG command
      return new XGMPSGCommand(Uint8Array.from([data]));
    } else if (command.isPSGToneLowWrite()) {
      return new XGMPSGCommand(
        Uint8Array.from([
          XGMPSGCommand.FREQ_LOW & 0xff,
          (0x80 | (command.getPSGChannel() << 5) | (command.getPSGValue() & 0xf)) & 0xff,
        ]),
      );
    } else {
      console.error(
        "Invalide PSG byte command: " + toHexaString(command.getPSGValue(), 2),
      );
      return new XGMPSGCommand(Uint8Array.from([0]));
    }
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand} vgmCommandLow
   * @param {import("./vgm-command.js").VGMCommand} vgmCommandHigh
   * @returns {XGMPSGCommand}
   */
  static createPSGToneCommand(vgmCommandLow, vgmCommandHigh) {
    const data = new Uint8Array(2);

    // set command
    data[0] = XGMPSGCommand.FREQ;

    // set channel
    data[0] = (data[0] | (vgmCommandLow.getPSGChannel() << 2)) & 0xff;
    // set value
    data[0] = (data[0] | ((vgmCommandHigh.getPSGValue() >> 4) & 3)) & 0xff;
    data[1] = ((vgmCommandHigh.getPSGValue() & 0xf) << 4) & 0xff;
    data[1] = (data[1] | (vgmCommandLow.getPSGValue() & 0xf)) & 0xff;

    return new XGMPSGCommand(data);
  }
}

// --- command type constants -------------------------------------------------

XGMPSGCommand.WAIT_SHORT = 0x00;
XGMPSGCommand.WAIT_LONG = 0x0e;
XGMPSGCommand.LOOP = 0x0f;

XGMPSGCommand.FREQ_LOW = 0x10;

XGMPSGCommand.FREQ = 0x20;
XGMPSGCommand.FREQ_WAIT = 0x30;

XGMPSGCommand.FREQ0_DELTA = 0x40;
XGMPSGCommand.FREQ1_DELTA = 0x50;
XGMPSGCommand.FREQ2_DELTA = 0x60;
XGMPSGCommand.FREQ3_DELTA = 0x70;

XGMPSGCommand.ENV0 = 0x80;
XGMPSGCommand.ENV1 = 0x90;
XGMPSGCommand.ENV2 = 0xa0;
XGMPSGCommand.ENV3 = 0xb0;

XGMPSGCommand.ENV0_DELTA = 0xc0;
XGMPSGCommand.ENV1_DELTA = 0xd0;
XGMPSGCommand.ENV2_DELTA = 0xe0;
XGMPSGCommand.ENV3_DELTA = 0xf0;

XGMPSGCommand.DUMMY = 0xff;
XGMPSGCommand.LOOP_START = 0xfe;

// --- inner command subclasses ----------------------------------------------

/**
 * @extends XGMPSGCommand
 */
export class WaitShortCommand extends XGMPSGCommand {
  /**
   * @param {number} wait
   */
  constructor(wait) {
    super(Uint8Array.from([(XGMPSGCommand.WAIT_SHORT | ((wait - 1) & 0xf)) & 0xff]));
  }
}

/**
 * @extends XGMPSGCommand
 */
export class WaitLongCommand extends XGMPSGCommand {
  /**
   * @param {number} wait
   */
  constructor(wait) {
    super(Uint8Array.from([XGMPSGCommand.WAIT_LONG & 0xff, (wait - 15) & 0xff]));
  }
}

/**
 * @extends XGMPSGCommand
 */
export class FrameCommand extends XGMPSGCommand {
  constructor() {
    super(Uint8Array.from([XGMPSGCommand.WAIT_SHORT & 0xff]));
  }
}

/**
 * @extends XGMPSGCommand
 */
export class LoopCommand extends XGMPSGCommand {
  /**
   * @param {number} offset
   */
  constructor(offset) {
    super(
      Uint8Array.from([
        XGMPSGCommand.LOOP & 0xff,
        (offset >> 0) & 0xff,
        (offset >> 8) & 0xff,
        (offset >> 16) & 0xff,
      ]),
    );
  }
}

/**
 * @extends XGMPSGCommand
 */
export class LoopStartCommand extends XGMPSGCommand {
  constructor() {
    super(Uint8Array.from([]));
  }
}

/**
 * @extends LoopCommand
 */
export class EndCommand extends LoopCommand {
  constructor() {
    super(-1);
  }
}

/**
 * Mirror of java.util.List.removeAll(Collection): remove from `list` every
 * element that `.equals()` (here: identity ===) an element of `toRemove`.
 * The Java code relies on object identity for these VGMCommand instances.
 * @template T
 * @param {T[]} list
 * @param {T[]} toRemove
 */
function removeAll(list, toRemove) {
  if (toRemove.length === 0) return;
  const set = new Set(toRemove);
  for (let i = list.length - 1; i >= 0; i--) if (set.has(list[i])) list.splice(i, 1);
}

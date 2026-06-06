// Port of sgdk.xgm2tool.format.VGMCommand — VGM command descriptor class.

import { Command } from "./command.js";
import {
  getInt8,
  getInt16,
  getInt32,
  getInt24,
  setInt8,
  setInt16,
  setInt32,
} from "./util.js";

/**
 * Mirror of sgdk.tool.StringUtil.toHexaString(int value, int size): uppercase
 * hexadecimal, zero-padded on the left up to `size` digits (no truncation when
 * the value is wider than `size`).
 * @param {number} value
 * @param {number} size
 * @returns {string}
 */
function toHexaString(value, size) {
  let result = (value >>> 0).toString(16).toUpperCase();
  while (result.length < size) result = "0" + result;
  return result;
}

/**
 * VGM command descriptor class.
 * @author Stephane Dallongeville
 */
export class VGMCommand extends Command {
  static DATA_BLOCK = 0x67;
  static END = 0x66;
  static SEEK = 0xe0;

  static WRITE_SN76489 = 0x50;
  static WRITE_YM2612_PORT0 = 0x52;
  static WRITE_YM2612_PORT1 = 0x53;

  static WAIT_NTSC_FRAME = 0x62;
  static WAIT_PAL_FRAME = 0x63;

  static STREAM_CONTROL = 0x90;
  static STREAM_DATA = 0x91;
  static STREAM_FREQUENCY = 0x92;
  static STREAM_START_LONG = 0x93;
  static STREAM_START = 0x95;
  static STREAM_STOP = 0x94;

  static LOOP_START = 0x30;
  static LOOP_END = 0x31;

  /**
   * @param {Uint8Array|number[]} data
   * @param {number} offset
   * @returns {number}
   */
  static computeSize(data, offset) {
    if (data.length === 0) return 0;

    const command = getInt8(data, offset);

    switch (command) {
      case 0x4f:
      case VGMCommand.WRITE_SN76489:
        return 2;

      case 0x51:
      case VGMCommand.WRITE_YM2612_PORT0:
      case VGMCommand.WRITE_YM2612_PORT1:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
      case 0x58:
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
        return 3;

      case 0x61:
        return 3;

      case VGMCommand.WAIT_NTSC_FRAME:
      case VGMCommand.WAIT_PAL_FRAME:
        return 1;

      case 0x66:
        return 1;

      case VGMCommand.DATA_BLOCK:
        // data block start
        return 7 + getInt32(data, offset + 0x03);

      case 0x68:
        // write data block start
        return 12 + getInt24(data, offset + 0x09);

      case VGMCommand.STREAM_CONTROL:
        return 5;
      case VGMCommand.STREAM_DATA:
        return 5;
      case VGMCommand.STREAM_FREQUENCY:
        return 6;
      case VGMCommand.STREAM_START_LONG:
        return 11;
      case VGMCommand.STREAM_STOP:
        return 2;
      case VGMCommand.STREAM_START:
        return 5;
    }

    switch (command >> 4) {
      default:
        return 1;
      case 0x3:
        return 2;
      case 0x4:
        return 3;
      case 0x7:
        return 1;
      case 0x8:
        return 1;
      case 0xa:
        return 3;
      case 0xb:
        return 3;
      case 0xc:
        return 4;
      case 0xd:
        return 4;
      case 0xe:
        return 5;
      case 0xf:
        return 5;
    }
  }

  static lastPSGChannel = 0;

  /**
   * Three constructor forms (matching the Java overloads):
   *  - new VGMCommand(data, offset): slice `size` bytes starting at `offset`.
   *  - new VGMCommand(data): take the whole array, size = data.length.
   *  - new VGMCommand(command): a single-byte command.
   * @param {Uint8Array|number[]|number} data
   * @param {number} [offset]
   */
  constructor(data, offset) {
    if (typeof data === "number") {
      // VGMCommand(int command) -> this(new byte[] {(byte) command})
      const command = data;
      const arr = Uint8Array.from([command & 0xff]);
      super(arr);
      // compute size
      this.size = VGMCommand.computeSize(arr, 0);
      // then fix data array to not have any offset
      this.data = arr.slice(0, this.size);
      // VGMCommand(byte[] data): size = data.length
      this.size = arr.length;
      return;
    }

    if (offset === undefined) {
      // VGMCommand(byte[] data) -> this(data, 0)
      super(data);
      // compute size
      this.size = VGMCommand.computeSize(data, 0);
      // then fix data array to not have any offset
      this.data = data.slice(0, this.size);
      // compute size (overrides with full length)
      this.size = data.length;
      return;
    }

    // VGMCommand(byte[] data, int offset)
    super(data);
    // compute size
    this.size = VGMCommand.computeSize(data, offset);
    // then fix data array to not have any offset
    this.data = data.slice(offset, offset + this.size);
  }

  /**
   * @returns {number}
   */
  getCommand() {
    if (this instanceof LoopStartCommand) return VGMCommand.LOOP_START;

    return getInt8(this.data, 0);
  }

  /**
   * @returns {boolean}
   */
  isDataBlock() {
    return this.getCommand() === VGMCommand.DATA_BLOCK;
  }

  /**
   * @returns {number}
   */
  getDataBankId() {
    return getInt8(this.data, 2);
  }

  /**
   * @returns {number}
   */
  getDataBlockLen() {
    return getInt32(this.data, 3);
  }

  /**
   * @returns {boolean}
   */
  isSeek() {
    return this.getCommand() === VGMCommand.SEEK;
  }

  /**
   * @returns {number}
   */
  getSeekAddress() {
    if (this.isSeek()) return getInt32(this.data, 0x01);

    return -1;
  }

  /**
   * @returns {boolean}
   */
  isEnd() {
    return this.getCommand() === VGMCommand.END;
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
  isPCM() {
    return (this.getCommand() & 0xf0) === 0x80;
  }

  /**
   * @returns {boolean}
   */
  isWait() {
    if (this.isShortWait()) return true;
    return this.getCommand() >= 0x61 && this.getCommand() <= 0x63;
  }

  /**
   * @returns {boolean}
   */
  isShortWait() {
    return (this.getCommand() & 0xf0) === 0x70;
  }

  /**
   * @returns {number}
   */
  getWaitValue() {
    if (this.isShortWait()) return (this.getCommand() & 0x0f) + 1;
    if (this.isPCM()) return this.getCommand() & 0x0f;

    switch (this.getCommand()) {
      case 0x61:
        return getInt16(this.data, 1);
      case VGMCommand.WAIT_NTSC_FRAME:
        return 0x2df;
      case VGMCommand.WAIT_PAL_FRAME:
        return 0x372;
    }

    return 0;
  }

  /**
   * @returns {number}
   */
  computeSize() {
    return VGMCommand.computeSize(this.data, 0);
  }

  /**
   * @returns {boolean}
   */
  isPSGWrite() {
    return this.getCommand() === VGMCommand.WRITE_SN76489;
  }

  /**
   * @returns {boolean}
   */
  isPSGLowByteWrite() {
    return this.isPSGWrite() && (this.getPSGValue() & 0x80) === 0x80;
  }

  /**
   * @returns {boolean}
   */
  isPSGHighByteWrite() {
    return this.isPSGWrite() && (this.getPSGValue() & 0x80) === 0x00;
  }

  /**
   * @returns {boolean}
   */
  isPSGEnvWrite() {
    return this.isPSGLowByteWrite() && (this.getPSGValue() & 0x10) === 0x10;
  }

  /**
   * @returns {boolean}
   */
  isPSGToneWrite() {
    // ok to assume that as we force PSG env write to use low byte write format
    return this.isPSGWrite() && !this.isPSGEnvWrite();
  }

  /**
   * @returns {boolean}
   */
  isPSGToneLowWrite() {
    return this.isPSGToneWrite() && this.isPSGLowByteWrite();
  }

  /**
   * @returns {boolean}
   */
  isPSGToneHighWrite() {
    return this.isPSGToneWrite() && this.isPSGHighByteWrite();
  }

  /**
   * @returns {number}
   */
  getPSGValue() {
    if (this.isPSGWrite()) return getInt8(this.data, 1);

    return -1;
  }

  /**
   * @returns {number}
   */
  getPSGChannel() {
    if (this.isPSGWrite()) {
      if (this.isPSGLowByteWrite())
        VGMCommand.lastPSGChannel = (this.getPSGValue() >> 5) & 3;

      return VGMCommand.lastPSGChannel;
    }

    return -1;
  }

  /**
   * @returns {number}
   */
  getPSGFrequence() {
    if (this.isPSGToneHighWrite()) return (this.getPSGValue() & 0x3f) << 4;
    if (this.isPSGToneLowWrite()) return this.getPSGValue() & 0xf;

    return -1;
  }

  /**
   * @returns {number}
   */
  getPSGEnv() {
    if (this.isPSGEnvWrite()) return this.getPSGValue() & 0xf;

    return -1;
  }

  /**
   * @returns {boolean}
   */
  isYM2612Port0Write() {
    return this.getCommand() === VGMCommand.WRITE_YM2612_PORT0;
  }

  /**
   * @returns {boolean}
   */
  isYM2612Port1Write() {
    return this.getCommand() === VGMCommand.WRITE_YM2612_PORT1;
  }

  /**
   * @returns {boolean}
   */
  isYM2612Write() {
    return this.isYM2612Port0Write() || this.isYM2612Port1Write();
  }

  /**
   * @returns {number}
   */
  getYM2612Port() {
    if (this.isYM2612Port0Write()) return 0;
    if (this.isYM2612Port1Write()) return 1;

    return -1;
  }

  /**
   * @returns {number}
   */
  getYM2612Register() {
    if (this.isYM2612Write()) return getInt8(this.data, 1);

    return -1;
  }

  /**
   * @returns {number}
   */
  getYM2612Value() {
    if (this.isYM2612Write()) return getInt8(this.data, 2);

    return -1;
  }

  /**
   * @returns {boolean}
   */
  isYM2612KeyWrite() {
    return this.isYM2612Port0Write() && this.getYM2612Register() === 0x28;
  }

  /**
   * @returns {boolean}
   */
  isYM2612KeyOnWrite() {
    return this.isYM2612KeyWrite() && (this.getYM2612Value() & 0xf0) === 0xf0;
  }

  /**
   * @returns {boolean}
   */
  isYM2612KeyOffWrite() {
    return this.isYM2612KeyWrite() && (this.getYM2612Value() & 0xf0) === 0x00;
  }

  // public int getYM2612KeyChannel()
  // {
  // if (isYM2612KeyWrite())
  // return getYM2612Value() & 0x7;
  //
  // return 0;
  // }

  /**
   * @returns {boolean}
   */
  isYM26120x2XWrite() {
    return this.isYM2612Port0Write() && (this.getYM2612Register() & 0xf0) === 0x20;
  }

  /**
   * @returns {boolean}
   */
  isYM2612DACOn() {
    return (
      this.isYM2612Port0Write() &&
      (this.getYM2612Register() & 0xff) === 0x2b &&
      (this.getYM2612Value() & 0x80) !== 0
    );
  }

  /**
   * @returns {boolean}
   */
  isYM2612DACOff() {
    return (
      this.isYM2612Port0Write() &&
      (this.getYM2612Register() & 0xff) === 0x2b &&
      (this.getYM2612Value() & 0x80) === 0
    );
  }

  /**
   * @returns {boolean}
   */
  isYM2612DACWrite() {
    return (
      this.isYM2612Port0Write() && (this.getYM2612Register() & 0xff) === 0x2a
    );
  }

  /**
   * @returns {boolean}
   */
  isYM2612CanIgnoreWrite() {
    if (this.isYM2612Port0Write())
      return (
        this.getYM2612Register() !== 0x28 &&
        this.getYM2612Register() !== 0x22 &&
        this.getYM2612Register() < 0x30
      );
    else if (this.isYM2612Port1Write()) return this.getYM2612Register() < 0x30;

    return false;
  }

  /**
   * @returns {boolean}
   */
  isYM2612TimersWrite() {
    return this.isYM2612Port0Write() && this.getYM2612Register() === 0x27;
  }

  /**
   * @returns {boolean}
   */
  isYM2612TimersNoSpecialNoCSMWrite() {
    return this.isYM2612TimersWrite() && (this.getYM2612Value() & 0xc0) === 0x00;
  }

  /**
   * @returns {boolean}
   */
  isYM2612GeneralWrite() {
    return (
      (this.isYM2612Port0Write() || this.isYM2612Port1Write()) &&
      this.getYM2612Register() < 0x30
    );
  }

  /**
   * @returns {boolean}
   */
  isYM2612ChannelSet() {
    return (
      (this.isYM2612Port0Write() || this.isYM2612Port1Write()) &&
      this.getYM2612Register() >= 0x30
    );
  }

  /**
   * @returns {boolean}
   */
  isYM2612FreqWrite() {
    const port = this.getYM2612Port();

    if (port !== -1) {
      const reg = this.getYM2612Register();
      return reg >= 0xa0 && reg < 0xb0;
    }

    return false;
  }

  /**
   * @returns {number}
   */
  getYM2612Channel() {
    const port = this.getYM2612Port();

    if (port !== -1) {
      const reg = this.getYM2612Register();
      let ch;

      // special key write command ?
      if (port === 0 && reg === 0x28) {
        const value = this.getYM2612Value();

        ch = value & 3;

        if (ch === 3) return -1;

        ch += (value & 4) !== 0 ? 3 : 0;

        return ch;
      }
      // special case: channel 3 in special mode
      else if (reg >= 0xa8 && reg < 0xb0) ch = 2;
      // classic channel decoding
      else if (reg >= 0x30 && reg < 0xb8) ch = reg & 3;
      else return -1;

      if (ch !== 3) return ch + port * 3;
    }

    return -1;
  }

  /**
   * @returns {number}
   */
  getChannel() {
    if (this.isYM2612Write()) return this.getYM2612Channel();
    if (this.isPSGWrite()) return this.getPSGChannel();

    return -1;
  }

  /**
   * @returns {number}
   */
  getYM2612PortChannel() {
    const ch = this.getYM2612Channel();

    if (ch === -1) return -1;
    if (ch >= 3) return ch - 3;
    return ch;
  }

  /**
   * @returns {boolean}
   */
  isStream() {
    return (
      this.isStreamControl() ||
      this.isStreamData() ||
      this.isStreamFrequency() ||
      this.isStreamStart() ||
      this.isStreamStartLong() ||
      this.isStreamStop()
    );
  }

  /**
   * @returns {boolean}
   */
  isStreamControl() {
    return this.getCommand() === VGMCommand.STREAM_CONTROL;
  }

  /**
   * @returns {boolean}
   */
  isStreamData() {
    return this.getCommand() === VGMCommand.STREAM_DATA;
  }

  /**
   * @returns {boolean}
   */
  isStreamFrequency() {
    return this.getCommand() === VGMCommand.STREAM_FREQUENCY;
  }

  /**
   * @returns {boolean}
   */
  isStreamStart() {
    return this.getCommand() === VGMCommand.STREAM_START;
  }

  /**
   * @returns {boolean}
   */
  isStreamStartLong() {
    return this.getCommand() === VGMCommand.STREAM_START_LONG;
  }

  /**
   * @returns {boolean}
   */
  isStreamStop() {
    return this.getCommand() === VGMCommand.STREAM_STOP;
  }

  /**
   * @returns {number}
   */
  getStreamId() {
    if (this.isStream()) return getInt8(this.data, 1);

    return -1;
  }

  /**
   * @returns {number}
   */
  getStreamBankId() {
    if (this.isStreamData()) return getInt8(this.data, 2);

    return -1;
  }

  /**
   * @returns {number}
   */
  getStreamBlockId() {
    if (this.isStreamStart()) return getInt8(this.data, 2);

    return -1;
  }

  /**
   * @param {number} value
   */
  setStreamBlockId(value) {
    if (this.isStreamStart()) setInt8(this.data, 2, value);
  }

  /**
   * @returns {number}
   */
  getStreamFrenquency() {
    if (this.isStreamFrequency()) return getInt32(this.data, 2);

    return -1;
  }

  /**
   * @returns {number}
   */
  getStreamSampleAddress() {
    if (this.isStreamStartLong()) return getInt32(this.data, 2);

    return -1;
  }

  /**
   * @param {number} value
   */
  setStreamSampleAddress(value) {
    if (this.isStreamStartLong()) setInt32(this.data, 2, value);
  }

  /**
   * @returns {number}
   */
  getStreamSampleSize() {
    if (this.isStreamStartLong()) return getInt32(this.data, 7);

    return -1;
  }

  /**
   * @returns {string}
   */
  getCommandDesc() {
    if (this.isStreamControl()) return "Stream ctrl";
    if (this.isStreamData()) return "Stream data";
    if (this.isStreamFrequency()) return "Stream freq";
    if (this.isStreamStart()) return "Stream start sh";
    if (this.isStreamStartLong()) return "Stream start";
    if (this.isStreamStop()) return "Stream stop";

    if (this.isDataBlock()) return "Data block";
    if (this.isPCM()) return "PCM";
    if (this.isSeek()) return "PCM seek";
    if (this.isLoopStart()) return "Loop start";
    if (this.isEnd()) return "End";

    if (this.isPSGEnvWrite())
      return "PSG env #" + toHexaString(this.getPSGEnv(), 1);
    if (this.isPSGToneHighWrite())
      return "PSG tone high #" + toHexaString(this.getPSGFrequence(), 3);
    if (this.isPSGToneLowWrite())
      return "PSG tone low #" + toHexaString(this.getPSGFrequence(), 1);

    if (this.isShortWait()) return "Short wait";
    if (this.isWait()) return "Wait";

    if (this.isYM2612Write())
      return Command.getYMCommandDesc(
        this.getYM2612Port(),
        this.getYM2612Register(),
        this.getYM2612Value()
      );

    return "Others";
  }

  /**
   * @param {VGMCommand[]} commands
   * @param {number} channel
   * @returns {VGMCommand|null}
   */
  static getKeyCommand(commands, channel) {
    for (const command of commands)
      if (command.isYM2612KeyWrite() && command.getYM2612Channel() === channel)
        return command;

    return null;
  }

  /**
   * @param {VGMCommand[]} commands
   * @param {number} channel
   * @returns {VGMCommand|null}
   */
  static getKeyOffCommand(commands, channel) {
    for (const command of commands)
      if (
        command.isYM2612KeyOffWrite() &&
        command.getYM2612Channel() === channel
      )
        return command;

    return null;
  }

  /**
   * @param {number} port
   * @param {number} reg
   * @param {number} value
   * @returns {VGMCommand}
   */
  static createYMCommand(port, reg, value) {
    if (port === 0)
      return new VGMCommand(
        Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0, reg & 0xff, value & 0xff])
      );

    return new VGMCommand(
      Uint8Array.from([VGMCommand.WRITE_YM2612_PORT1, reg & 0xff, value & 0xff])
    );
  }

  /**
   * @param {number} port
   * @param {number} baseReg
   * @param {number} value
   * @returns {VGMCommand[]}
   */
  static createYMCommands(port, baseReg, value) {
    const result = [];

    for (let ch = 0; ch < 3; ch++)
      for (let operator = 0; operator < 4; operator++)
        result.push(
          VGMCommand.createYMCommand(
            port,
            baseReg + ((operator & 3) << 2) + (ch & 3),
            value
          )
        );

    return result;
  }

  /**
   * @param {number} wait
   * @returns {VGMCommand[]}
   */
  static createWaitCommands(wait) {
    const result = [];

    if (wait === 0x2df) result.push(new VGMCommand(VGMCommand.WAIT_NTSC_FRAME));
    else if (wait === 0x372)
      result.push(new VGMCommand(VGMCommand.WAIT_PAL_FRAME));
    else {
      let remaining = wait;
      while (remaining > 0) {
        const data = new Uint8Array(3);
        const w = Math.min(65535, remaining);

        data[0] = 0x61;
        setInt16(data, 1, w);

        result.push(new VGMCommand(data));

        remaining -= w;
      }
    }

    return result;
  }

  /**
   * @returns {string}
   */
  toString() {
    return this.getCommandDesc();
  }

  /**
   * Comparator ordering commands by their YM2612 channel.
   * @param {VGMCommand} c1
   * @param {VGMCommand} c2
   * @returns {number}
   */
  static channelSorter(c1, c2) {
    // Integer.compare(c1.getYM2612Channel(), c2.getYM2612Channel())
    return c1.getYM2612Channel() - c2.getYM2612Channel();
  }

  /**
   * Comparator ordering commands by YM2612 channel, then register (freq regs
   * high before low).
   * @param {VGMCommand} c1
   * @param {VGMCommand} c2
   * @returns {number}
   */
  static channelRegSorter(c1, c2) {
    let result = c1.getYM2612Channel() - c2.getYM2612Channel();
    if (result === 0) {
      // freq registers ? high then low
      if (
        (c1.getYM2612Register() & 0xf4) === 0xa4 &&
        (c2.getYM2612Register() & 0xf4) === 0xa0
      )
        return -1;
      if (
        (c1.getYM2612Register() & 0xf4) === 0xa0 &&
        (c2.getYM2612Register() & 0xf4) === 0xa4
      )
        return 1;

      result = c1.getYM2612Register() - c2.getYM2612Register();
    }
    return result;
  }

  /**
   * Comparator for TL/SL level OFF before level ON ordering.
   * @param {VGMCommand} c1
   * @param {VGMCommand} c2
   * @returns {number}
   */
  static normalComSorter(c1, c2) {
    const reg1 = c1.getYM2612Register();
    const reg2 = c2.getYM2612Register();
    const val1 = c1.getYM2612Value();
    const val2 = c2.getYM2612Value();

    // TL register ?
    if ((reg1 & 0xf0) === 0x40) {
      // TL OFF ? --> should be first
      if ((val1 & 0x7f) === 0x7f) return -1;
      // TL ON ? --> should be last
      return 1;
    }
    // SL (D1L) register ?
    if ((reg1 & 0xf0) === 0x80) {
      // SL OFF ? --> should be first
      if ((val1 & 0xf0) === 0xf0) return -1;
      // SL ON ? --> should be last
      return 1;
    }

    // TL register ?
    if ((reg2 & 0xf0) === 0x40) {
      // TL OFF ? --> should be first
      if ((val2 & 0x7f) === 0x7f) return 1;
      // TL ON ? --> should be last
      return -1;
    }
    // SL (D1L) register ?
    if ((reg2 & 0xf0) === 0x80) {
      // SL OFF ? --> should be first
      if ((val2 & 0xf0) === 0xf0) return 1;
      // SL ON ? --> should be last
      return -1;
    }

    // other command --> we don't care order
    return 0;
  }
}

/**
 * Loop-start marker command (zero-length data). Reports its command as
 * {@link VGMCommand.LOOP_START}.
 */
export class LoopStartCommand extends VGMCommand {
  constructor() {
    super(new Uint8Array(0));
  }
}

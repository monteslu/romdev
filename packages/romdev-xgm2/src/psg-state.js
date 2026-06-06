// Port of sgdk.xgm2tool.struct.PSGState — SN76489 PSG register state + delta encoder.

import { VGMCommand } from "./vgm-command.js";

export class PSGState {
  constructor(state) {
    /** @type {number[][]} */
    this.registers = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    /** @type {boolean[][]} */
    this.init = [
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ];

    this.index = -1;
    this.type = -1;

    if (state instanceof PSGState) {
      for (let i = 0; i < 4; i++) {
        this.registers[i][0] = state.registers[i][0];
        this.registers[i][1] = state.registers[i][1];
        this.init[i][0] = state.init[i][0];
        this.init[i][1] = state.init[i][1];
      }
    } else {
      this.clear();
    }
  }

  clear() {
    for (let i = 0; i < 4; i++) {
      this.registers[i][0] = 0;
      this.registers[i][1] = 0;
      this.init[i][0] = false;
      this.init[i][1] = false;
    }
  }

  /**
   * @param {number} ind
   * @param {number} typ
   * @returns {number}
   */
  get(ind, typ) {
    switch (typ) {
      case 0:
        // tone / noise
        if (ind === 3) return this.registers[ind][typ] & 0x7;

        return this.registers[ind][typ] & 0x3ff;

      case 1:
        // volume
        return this.registers[ind][typ] & 0xf;
    }

    return 0;
  }

  /** @param {number} value */
  write(value) {
    if ((value & 0x80) !== 0) this.writeLow(value & 0x7f);
    else this.writeHigh(value & 0x7f);
  }

  /** @param {number} value */
  writeLow(value) {
    this.index = (value >> 5) & 0x03;
    this.type = (value >> 4) & 0x01;

    if (this.type === 0 && this.index === 3) {
      this.registers[this.index][this.type] &= ~0x7;
      this.registers[this.index][this.type] |= value & 0x7;
    } else {
      this.registers[this.index][this.type] &= ~0xf;
      this.registers[this.index][this.type] |= value & 0xf;
    }

    this.init[this.index][this.type] = true;
  }

  /** @param {number} value */
  writeHigh(value) {
    if (this.type === 0 && this.index === 3) {
      this.registers[this.index][this.type] &= ~0x7;
      this.registers[this.index][this.type] |= value & 0x7;
    } else if (this.type === 1) {
      this.registers[this.index][this.type] &= ~0xf;
      this.registers[this.index][this.type] |= value & 0xf;
    } else {
      this.registers[this.index][this.type] &= ~0x3f0;
      this.registers[this.index][this.type] |= (value & 0x3f) << 4;
    }

    this.init[this.index][this.type] = true;
  }

  /**
   * @param {PSGState} state
   * @param {number} ind
   * @param {number} typ
   * @returns {boolean}
   */
  isSame(state, ind, typ) {
    // consider same if 'state' is not initialised here
    if (!state.init[ind][typ]) return true;
    // consider different if we are not initialised here while 'state' is
    if (!this.init[ind][typ]) return false;

    return this.init[ind][typ] && state.get(ind, typ) === this.get(ind, typ);
  }

  /**
   * @param {PSGState} state
   * @param {number} ind
   * @param {number} typ
   * @returns {boolean}
   */
  isLowSame(state, ind, typ) {
    // consider same if 'state' is not initialised here
    if (!state.init[ind][typ]) return true;
    // consider different if we are not initialised here while 'state' is
    if (!this.init[ind][typ]) return false;

    return this.init[ind][typ] && (state.get(ind, typ) & 0xf) === (this.get(ind, typ) & 0xf);
  }

  /**
   * @param {PSGState} state
   * @param {number} ind
   * @param {number} typ
   * @returns {boolean}
   */
  isHighSame(state, ind, typ) {
    // consider same if 'state' is not initialised here
    if (!state.init[ind][typ]) return true;
    // consider different if we are not initialised here while 'state' is
    if (!this.init[ind][typ]) return false;

    return this.init[ind][typ] && (state.get(ind, typ) & 0x3f0) === (this.get(ind, typ) & 0x3f0);
  }

  /**
   * @param {PSGState} state
   * @param {number} ind
   * @param {number} typ
   * @returns {boolean}
   */
  isDiff(state, ind, typ) {
    return !this.isSame(state, ind, typ);
  }

  /**
   * @param {PSGState} state
   * @param {number} ind
   * @param {number} typ
   * @returns {boolean}
   */
  isLowDiffOnly(state, ind, typ) {
    return !this.isLowSame(state, ind, typ) && this.isHighSame(state, ind, typ);
  }

  /**
   * @param {number} ind
   * @param {number} typ
   * @param {number} value
   * @returns {VGMCommand}
   */
  createLowWriteCommand(ind, typ, value) {
    return new VGMCommand(
      new Uint8Array([VGMCommand.WRITE_SN76489, (0x80 | (ind << 5) | (typ << 4) | (value & 0xf)) & 0xff])
    );
  }

  /**
   * @param {number} ind
   * @param {number} typ
   * @param {number} value
   * @returns {VGMCommand[]}
   */
  static createWriteCommands(ind, typ, value) {
    /** @type {VGMCommand[]} */
    const result = [];

    // rebuild data
    result.push(
      new VGMCommand(
        new Uint8Array([VGMCommand.WRITE_SN76489, (0x80 | (ind << 5) | (typ << 4) | (value & 0xf)) & 0xff])
      )
    );
    if (typ === 0 && ind !== 3)
      result.push(
        new VGMCommand(new Uint8Array([VGMCommand.WRITE_SN76489, (0x00 | ((value >> 4) & 0x3f)) & 0xff]))
      );

    return result;
  }

  /**
   * Returns commands list to update to the specified PSG state
   * @param {PSGState} state
   * @returns {VGMCommand[]}
   */
  getDelta(state) {
    /** @type {VGMCommand[]} */
    const result = [];

    for (let ind = 0; ind < 4; ind++) {
      for (let typ = 0; typ < 2; typ++) {
        if (typ === 0) {
          // value different on low bits only --> add single command
          if (this.isLowDiffOnly(state, ind, typ))
            result.push(this.createLowWriteCommand(ind, typ, state.get(ind, typ)));
          // value is different --> add commands
          else if (this.isDiff(state, ind, typ))
            result.push(...PSGState.createWriteCommands(ind, typ, state.get(ind, typ)));
        } else {
          // value is different --> add commands
          if (this.isDiff(state, ind, typ))
            result.push(...PSGState.createWriteCommands(ind, typ, state.get(ind, typ)));
        }
      }
    }

    return result;
  }
}

// Port of sgdk.xgm2tool.struct.YM2612State — tracks/compares YM2612 register state and emits VGM/XGM deltas.

import { getInt8 } from "./util.js";
import { VGMCommand } from "./vgm-command.js";
import { XGMFMCommand } from "./xgm-fm-command.js";

/** @type {number[][]} */
const duals = [
  [0x24, 0x25],
  [0xa4, 0xa0],
  [0xa5, 0xa1],
  [0xa6, 0xa2],
  [0xac, 0xa8],
  [0xad, 0xa9],
  [0xae, 0xaa],
];

export class YM2612State {
  constructor(source) {
    /** @type {number[][]} */
    this.registers = [new Array(256).fill(0), new Array(256).fill(0)];
    /** @type {boolean[][]} */
    this.init = [new Array(256).fill(false), new Array(256).fill(false)];

    if (source instanceof YM2612State) {
      for (let i = 0; i < 0x100; i++) {
        this.registers[0][i] = source.registers[0][i];
        this.registers[1][i] = source.registers[1][i];
        this.init[0][i] = source.init[0][i];
        this.init[1][i] = source.init[1][i];
      }
    } else {
      this.clear();
    }
  }

  clear() {
    for (let i = 0; i < 0x20; i++) {
      this.registers[0][i] = 0;
      this.registers[1][i] = 0;
      this.init[0][i] = false;
      this.init[1][i] = false;
    }
    for (let i = 0x20; i < 0x100; i++) {
      this.registers[0][i] = 0;
      this.registers[1][i] = 0;
      this.init[0][i] = false;
      this.init[1][i] = false;
    }
  }

  /**
   * @param {number} port
   * @param {number} reg
   * @returns {number}
   */
  get(port, reg) {
    if (YM2612State.canIgnore(port, reg)) return 0;

    return this.registers[port][reg];
  }

  /**
   * @param {number} port
   * @param {number} reg
   * @param {number} value
   * @returns {boolean}
   */
  set(port, reg, value) {
    if (YM2612State.canIgnore(port, reg)) return false;

    let newValue = value;

    if (port === 0) {
      // special case of KEY ON/OFF register
      if (reg === 0x28) {
        // invalid channel number ? --> ignore
        if ((value & 3) === 3) return false;

        const oldValue = this.registers[port][value & 7];
        newValue &= 0xf0;

        if (oldValue !== newValue) {
          this.registers[port][value & 7] = newValue;
          // always write when key state change
          return true;
        }

        return false;
      }

      // special case of Timer register --> ignore useless bits
      if (reg === 0x27) newValue &= 0xc0;
    }

    if (!this.init[port][reg] || this.registers[port][reg] !== newValue) {
      this.registers[port][reg] = value;
      this.init[port][reg] = true;
      return true;
    }

    return false;
  }

  /**
   * @param {YM2612State} state
   * @param {number} port
   * @param {number} reg
   * @returns {boolean}
   */
  isDiff(state, port, reg) {
    if (!state.init[port][reg]) return false;
    if (YM2612State.canIgnore(port, reg)) return false;
    if (!this.init[port][reg]) return true;

    return this.get(port, reg) !== state.get(port, reg);
  }

  /**
   * Return true if write can be ignored
   * @param {number} port
   * @param {number} reg
   * @returns {boolean}
   */
  static canIgnore(port, reg) {
    switch (reg) {
      case 0x22:
      case 0x24:
      case 0x25:
      case 0x26:
      case 0x27:
      case 0x28:
      case 0x2b:
        return port === 1;
    }

    if (reg >= 0x30 && reg < 0xb8) return (reg & 3) === 3;

    return true;
  }

  /**
   * Return the dual entry for this reg (or null if no dual entry)
   * @param {number} reg
   * @returns {number[] | null}
   */
  static getDualReg(reg) {
    for (let i = 0; i < duals.length; i++) {
      const dual = duals[i];

      if (dual[0] === reg || dual[1] === reg) return dual;
    }

    return null;
  }

  /**
   * Returns commands list to update to the specified YM2612 state
   * @param {YM2612State} state
   * @param {boolean} ignoreTimerWrites
   * @returns {VGMCommand[]}
   */
  getDelta(state, ignoreTimerWrites) {
    /** @type {VGMCommand[]} */
    const result = [];

    // do global registers first
    for (let port = 0; port < 2; port++) {
      for (let reg = 0; reg < 0x30; reg++) {
        // can ignore or special case of KEY ON/OFF register
        if (YM2612State.canIgnore(port, reg) || (port === 0 && reg === 0x28)) continue;
        // ignore timer write
        if (ignoreTimerWrites && port === 0 && (reg === 0x24 || reg === 0x25 || reg === 0x26)) continue;
        // ignore timer write (special case of 0X27 register)
        if (ignoreTimerWrites && port === 0 && reg === 0x27) {
          // not initialized --> can ignore
          if (!state.init[port][reg]) continue;
          // old was initialized but value is unchanged for FM2_SPE/CSM mode ? --> ignore
          if (this.init[port][reg] && (this.registers[0][0x27] & 0xc0) === (state.registers[0][0x27] & 0xc0)) continue;
        }
        // ignore dual reg
        if (YM2612State.getDualReg(reg) != null) continue;

        // value is different --> add command
        if (this.isDiff(state, port, reg)) result.push(VGMCommand.createYMCommand(port, reg, state.get(port, reg)));
      }
    }

    // then do dual registers
    for (let i = 0; i < duals.length; i++) {
      const dual = duals[i];
      const reg0 = dual[0];
      const reg1 = dual[1];

      // value is different
      if (this.isDiff(state, 0, reg0) || this.isDiff(state, 0, reg1)) {
        // add commands
        result.push(VGMCommand.createYMCommand(0, reg0, state.get(0, reg0)));
        result.push(VGMCommand.createYMCommand(0, reg1, state.get(0, reg1)));
      }
      // port 1 too ?
      if (dual[0] > 0x30) {
        if (this.isDiff(state, 1, reg0) || this.isDiff(state, 1, reg1)) {
          // add commands
          result.push(VGMCommand.createYMCommand(1, reg0, state.get(1, reg0)));
          result.push(VGMCommand.createYMCommand(1, reg1, state.get(1, reg1)));
        }
      }
    }

    for (let port = 0; port < 2; port++) {
      for (let reg = 0x30; reg < 0xa0; reg += 0x10) {
        for (let ch = 0; ch < 3; ch++) {
          for (let sl = 0; sl < 0x10; sl += 4) {
            const r = reg + sl + ch;

            // can ignore
            if (YM2612State.canIgnore(port, r)) continue;
            // ignore dual reg
            if (YM2612State.getDualReg(r) != null) continue;

            // value is different --> add command
            if (this.isDiff(state, port, r)) result.push(VGMCommand.createYMCommand(port, r, state.get(port, r)));
          }
        }
      }

      for (let reg = 0xa0; reg < 0xb8; reg += 4) {
        for (let ch = 0; ch < 3; ch++) {
          const r = reg + ch;

          // can ignore
          if (YM2612State.canIgnore(port, r)) continue;
          // ignore dual reg
          if (YM2612State.getDualReg(r) != null) continue;

          // value is different --> add command
          if (this.isDiff(state, port, r)) result.push(VGMCommand.createYMCommand(port, r, state.get(port, r)));
        }
      }
    }

    return result;
  }

  /**
   * @param {XGMFMCommand[]} commands
   */
  updateState(commands) {
    let port;
    let ch;
    let sl;
    let reg;
    let v;

    for (const com of commands) {
      switch (com.getType()) {
        case XGMFMCommand.FM_LFO:
          this.set(0, 0x22, com.data[1]);
          break;
        case XGMFMCommand.FM_CH3_SPECIAL_ON:
          this.set(0, 0x27, (this.get(0, 0x27) & 0x3f) | 0x40);
          break;
        case XGMFMCommand.FM_CH3_SPECIAL_OFF:
          this.set(0, 0x27, this.get(0, 0x27) & 0x3f);
          break;
        case XGMFMCommand.FM_DAC_ON:
          this.set(0, 0x2b, (this.get(0, 0x2b) & 0x7f) | 0x80);
          break;
        case XGMFMCommand.FM_DAC_OFF:
          this.set(0, 0x2b, this.get(0, 0x2b) & 0x7f);
          break;

        case XGMFMCommand.FM0_PAN:
        case XGMFMCommand.FM1_PAN:
          port = com.getType() === XGMFMCommand.FM0_PAN ? 0 : 1;
          ch = com.data[0] & 0x03;
          v = (com.data[0] & 0x0c) << 4;
          this.set(port, 0xb4 + ch, (this.get(port, 0xb4 + ch) & 0x3f) | v);
          break;

        case XGMFMCommand.FM_WRITE:
          port = (com.data[0] >> 3) & 1;
          // num write
          v = (com.data[0] & 0x07) + 1;
          for (let i = 0; i < v; i++)
            this.set(port, getInt8(com.data, i * 2 + 1), getInt8(com.data, i * 2 + 2));
          break;

        case XGMFMCommand.FM_LOAD_INST:
          port = (com.data[0] >> 2) & 1;
          ch = com.data[0] & 0x03;
          // data offset
          v = 1;
          // slot writes
          for (let r = 0; r < 7; r++)
            for (sl = 0; sl < 4; sl++)
              this.set(port, 0x30 + (r << 4) + (sl << 2) + ch, getInt8(com.data, v++));
          // ch writes
          this.set(port, 0xb0 + ch, getInt8(com.data, v++));
          this.set(port, 0xb4 + ch, getInt8(com.data, v++));
          break;

        case XGMFMCommand.FM_TL:
          port = com.data[1] & 1;
          ch = com.data[0] & 3;
          sl = (com.data[0] >> 2) & 3;
          reg = 0x40 + (sl << 2) + ch;
          v = (com.data[1] >> 1) & 0x7f;
          this.set(port, reg, v);
          break;

        case XGMFMCommand.FM_TL_DELTA:
        case XGMFMCommand.FM_TL_DELTA_WAIT:
          port = com.data[1] & 1;
          ch = com.data[0] & 3;
          sl = (com.data[0] >> 2) & 3;
          reg = 0x40 + (sl << 2) + ch;
          v = (com.data[1] >> 2) & 0x3f;
          if ((com.data[1] & 2) !== 0) v = -v;
          // apply delta
          this.set(port, reg, this.get(port, reg) + v);
          break;

        case XGMFMCommand.FM_FREQ:
        case XGMFMCommand.FM_FREQ_WAIT:
          port = (com.data[0] >> 2) & 1;
          ch = com.data[0] & 3;
          // special mode ?
          if ((com.data[0] & 8) !== 0) {
            // high byte first
            this.set(port, 0xa6 + ch, com.data[2] & 0x3f);
            // then low byte
            this.set(port, 0xa2 + ch, com.data[1] & 0xff);
          } else {
            // high byte first
            this.set(port, 0xa4 + ch, com.data[2] & 0x3f);
            // then low byte
            this.set(port, 0xa0 + ch, com.data[1] & 0xff);
          }
          break;

        case XGMFMCommand.FM_FREQ_DELTA:
        case XGMFMCommand.FM_FREQ_DELTA_WAIT:
          port = (com.data[0] >> 2) & 1;
          ch = com.data[0] & 3;
          reg = ((com.data[0] & 8) !== 0 ? 0x40 : 0x42) + ch;
          v = (com.data[1] >> 1) & 0x7f;
          if ((com.data[1] & 1) !== 0) v = -v;

          // apply delta
          v = (((this.get(port, reg + 4) & 0x3f) << 8) | (this.get(port, reg + 0) & 0xff)) + v;
          // high byte first
          this.set(port, reg + 4, (v >> 8) & 0x3f);
          // then low byte
          this.set(port, reg + 0, (v >> 0) & 0xff);
          break;

        case XGMFMCommand.FM_KEY:
          ch = com.data[0] & 7;
          // key on/off
          this.set(0, 0x28, ((com.data[0] & 8) !== 0 ? 0xf0 : 0x00) + ch);
          break;

        case XGMFMCommand.FM_KEY_SEQ:
          ch = com.data[0] & 7;
          // key seq - on/off or off/on
          this.set(0, 0x28, ((com.data[0] & 8) !== 0 ? 0x00 : 0xf0) + ch);
          break;

        case XGMFMCommand.FM_KEY_ADV:
          this.set(0, 0x28, com.data[1]);
          break;

        default:
          // do nothing
          break;
      }
    }
  }
}

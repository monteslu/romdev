// Port of sgdk.xgm2tool.format.VGM — Sega Megadrive VGM file decoder / optimizer.

import * as Util from "./util.js";
import { Command } from "./command.js";
import { VGMCommand, LoopStartCommand } from "./vgm-command.js";
import { GD3 } from "./gd3.js";
import { SampleBank } from "./sample-bank.js";
import { PSGState } from "./psg-state.js";
import { YM2612State } from "./ym2612-state.js";
import { XGMFMCommand } from "./xgm-fm-command.js";
import { XGMPSGCommand } from "./xgm-psg-command.js";
import { XGMSample } from "./xgm-sample.js";

/**
 * Runtime configuration flags (mirror of sgdk.xgm2tool.Launcher's static flags
 * that influence VGM conversion logic). The original Launcher is not ported;
 * index.js assembles the public API and may flip these. Debug prints gated on
 * `silent` / `verbose` are dropped per the porting contract — only the flags
 * that affect actual data transformation are preserved.
 * @type {{silent:boolean, verbose:boolean, sampleRateFix:boolean, sampleIgnore:boolean, delayKeyOff:boolean}}
 */
export const Launcher = {
  silent: false,
  verbose: false,
  sampleRateFix: true,
  sampleIgnore: true,
  delayKeyOff: false,
};

/**
 * Sega Megadrive VGM file decoder.
 * @author Stephane Dallongeville
 */
export class VGM {
  static SAMPLE_END_DELAY = 400;
  static SAMPLE_MIN_SIZE = 100;
  static SAMPLE_MIN_DYNAMIC = 16;
  static SAMPLE_ALLOWED_MARGE = 64;
  static SAMPLE_MIN_MEAN_DELTA = 1.0;

  /**
   * Three constructor forms (matching the Java overloads):
   *  - new VGM(data, convert): parse a raw VGM byte array (data: Uint8Array, convert: boolean).
   *  - new VGM(vgm, convert): re-parse from another VGM's raw data (vgm: VGM, convert: boolean).
   *  - new VGM(xgm): build a VGM from an XGM (xgm: XGM).
   * @param {Uint8Array|VGM|object} data
   * @param {boolean} [convert]
   */
  constructor(data, convert) {
    // VGM(XGM xgm)
    if (convert === undefined && data != null && !(data instanceof Uint8Array) && !(data instanceof VGM)) {
      this.#fromXGM(/** @type {object} */ (data));
      return;
    }

    // VGM(VGM vgm, boolean convert) -> this(vgm.data, convert)
    if (data instanceof VGM) data = data.data;

    this.#fromData(/** @type {Uint8Array} */ (data), /** @type {boolean} */ (convert));
  }

  /**
   * VGM(byte[] data, boolean convert)
   * @param {Uint8Array} data
   * @param {boolean} convert
   */
  #fromData(data, convert) {
    if (!Util.getASCIIString(data, 0x00, 4).toUpperCase().startsWith("VGM "))
      throw new Error("File format not recognized !");

    /** @type {Uint8Array} */
    this.data = data;

    // just check for sub version info (need version 1.50 at least)
    /** @type {number} */
    this.version = data[8] & 0xff;
    // (version < 0x50 warning print dropped)

    // (convert/parsing status prints dropped)

    // start offset
    if (this.version >= 0x50) this.offsetStart = Util.getInt32(data, 0x34) + 0x34;
    else this.offsetStart = 0x40;
    // end offset
    this.offsetEnd = Util.getInt32(data, 0x04) + 0x04;

    // track len (in number of sample = 1/44100 sec)
    this.lenInSample = Util.getInt32(data, 0x18);

    // loop start offset
    this.loopStart = Util.getInt32(data, 0x1c);
    if (this.loopStart !== 0) this.loopStart += 0x1c;
    // loop len (in number of sample = 1/44100 sec)
    this.loopLenInSample = Util.getInt32(data, 0x20);

    // 50 or 60 Hz
    if (this.version >= 0x01) {
      this.rate = Util.getInt32(data, 0x24);
      // not 50 ? --> then assume 60Hz / NTSC by default
      if (this.rate !== 50) this.rate = 60;
    } else {
      // assume NTSC by default
      this.rate = 60;
    }

    // GD3 tags
    let addr = Util.getInt32(data, 0x14);
    // has GD3 tags ?
    if (addr !== 0) {
      // transform to absolute address
      addr += 0x14;
      // and get GD3 infos
      this.gd3 = new GD3(data, addr);
    } else this.gd3 = null;

    /** @type {SampleBank[]} */
    this.sampleBanks = [];
    /** @type {VGMCommand[]} */
    this.commands = [];

    // build command list
    this.parse();

    // update time and offsets for all commands
    this.updateTimes();
    this.updateOffsets();

    // and build samples
    this.buildSamples(convert);

    // update time and offsets for all commands
    this.updateTimes();
    this.updateOffsets();

    if (convert) {
      this.convertWaits();
      this.cleanCommands();
      this.cleanSamples();

      // need to be done here
      this.updateTimes();
      this.updateOffsets();

      this.fixKeyCommands();
      this.removeDummyStreamStopCommands();
      this.packWait();

      // update time and offsets for all commands
      this.updateTimes();
      this.updateOffsets();
    }

    // (duration / sample number prints dropped)
  }

  /**
   * VGM(XGM xgm)
   * @param {object} xgm
   */
  #fromXGM(xgm) {
    /** @type {Map<number, number>} */
    const sampleAddr = new Map();
    /** @type {number[][]} */
    const ymState = [new Array(0x100).fill(0), new Array(0x100).fill(0)];
    // 0 = env, 1 = freq
    /** @type {number[][]} */
    const psgState = [new Array(4).fill(0), new Array(4).fill(0)];
    /** @type {Command[]} */
    const mixedCommands = [];

    // add FM and PSG commands
    mixedCommands.push(...xgm.FMcommands);
    mixedCommands.push(...xgm.PSGcommands);

    // sort on time
    mixedCommands.sort(Command.timeComparator);

    this.data = null;
    /** @type {SampleBank[]} */
    this.sampleBanks = [];
    /** @type {VGMCommand[]} */
    this.commands = [];

    this.version = 0x60;
    this.offsetStart = 0;
    this.offsetEnd = 0;
    this.lenInSample = 0;
    this.loopStart = 0;
    this.loopLenInSample = 0;

    // PAL flag
    if (xgm.pal) this.rate = 50;
    else this.rate = 60;
    // GD3 tags
    if (xgm.gd3 != null) this.gd3 = xgm.gd3;
    else if (xgm.xd3 != null) this.gd3 = new GD3(xgm.xd3);
    else this.gd3 = null;

    // build sample data block / stream declaration commands
    if (xgm.samples.length !== 0) {
      const pcmDataSize = xgm.getPCMDataSize();

      // build data block command
      const comData = new Uint8Array(pcmDataSize + 7);
      comData[0] = 0x67;
      comData[1] = 0x66;
      comData[2] = 0x00;
      Util.setInt32(comData, 3, pcmDataSize);

      // copy sample data and build address map
      let off = 0;
      for (const sample of xgm.samples) {
        const len = sample.getLength();
        comData.set(sample.data.subarray(0, len), 7 + off);
        sampleAddr.set(sample.id, off);
        off += len;
      }

      // create data block command
      const command = new VGMCommand(comData);
      // add data block command
      this.commands.push(command);

      // add single stream control / data (id = 1)
      this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.STREAM_CONTROL & 0xff, 0x00, 0x02, 0x00, 0x2a])));
      this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.STREAM_DATA & 0xff, 0x00, 0x00, 0x01, 0x00])));

      // add data block
      const bank = this.addDataBlock(command);
      // then add samples
      for (const sample of xgm.samples)
        bank.addSample(sampleAddr.get(sample.id), sample.getLength(), XGMSample.XGM_FULL_RATE);
    }

    let time = 0;
    let loopOffset = -1;
    for (const command of mixedCommands) {
      let comsize;
      let port;
      let ch;
      let reg;
      let value;
      let lvalue;
      let addr;
      let len;
      let id;

      if (command instanceof XGMFMCommand) {
        const fmCommand = command;

        while (time < fmCommand.time) {
          if (this.rate === 50) {
            this.commands.push(new VGMCommand(Uint8Array.from([0x63])));
            time += 882;
          } else {
            this.commands.push(new VGMCommand(Uint8Array.from([0x62])));
            time += 735;
          }
        }

        port = fmCommand.getYMPort();
        ch = fmCommand.getYMChannel();

        switch (fmCommand.getType()) {
          // we use the FM loop command to rebuild loop on VGM
          case XGMFMCommand.LOOP:
            loopOffset = fmCommand.getLoopAddr();
            // 0xFFFFFF --> no loop
            if (loopOffset === 0xffffff) loopOffset = -1;
            break;

          case XGMFMCommand.PCM:
            id = fmCommand.getPCMId();
            // stop command
            if (id === 0) this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.STREAM_STOP & 0xff, 0x00])));
            else {
              const sample = xgm.getSample(id);

              // get sample address
              addr = sampleAddr.get(id);
              len = sample.getLength();
              // sample rate
              reg = fmCommand.getPCMHalfRate() ? XGMSample.XGM_HALF_RATE : XGMSample.XGM_FULL_RATE;

              this.commands.push(
                new VGMCommand(
                  Uint8Array.from([
                    VGMCommand.STREAM_FREQUENCY & 0xff,
                    0x00,
                    (reg >> 0) & 0xff,
                    (reg >> 8) & 0xff,
                    0x00,
                    0x00,
                  ])
                )
              );
              this.commands.push(
                new VGMCommand(
                  Uint8Array.from([
                    VGMCommand.STREAM_START_LONG & 0xff,
                    0x00,
                    (addr >> 0) & 0xff,
                    (addr >> 8) & 0xff,
                    (addr >> 16) & 0xff,
                    0x00,
                    0x01,
                    (len >> 0) & 0xff,
                    (len >> 8) & 0xff,
                    (len >> 16) & 0xff,
                    0x00,
                  ])
                )
              );
            }
            break;

          case XGMFMCommand.FM_LOAD_INST: {
            let d = 1;
            // slot writes
            for (let r = 0; r < 7; r++) {
              for (let s = 0; s < 4; s++) {
                reg = 0x30 + (r << 4) + (s << 2) + ch;
                value = fmCommand.data[d++];
                // save state
                ymState[port][reg] = value & 0xff;
                // create command
                this.commands.push(
                  new VGMCommand(Uint8Array.from([(VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff, reg & 0xff, value & 0xff]))
                );
              }
            }

            // ch writes
            reg = 0xb0 + ch;
            value = fmCommand.data[d++];
            // save state
            ymState[port][reg] = value & 0xff;
            // create command
            this.commands.push(
              new VGMCommand(Uint8Array.from([(VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff, reg & 0xff, value & 0xff]))
            );
            reg = 0xb4 + ch;
            value = fmCommand.data[d];
            // save state
            ymState[port][0xb4 + ch] = value & 0xff;
            // create command
            this.commands.push(
              new VGMCommand(Uint8Array.from([(VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff, reg & 0xff, value & 0xff]))
            );
            break;
          }

          case XGMFMCommand.FM_WRITE:
            comsize = fmCommand.getYMNumWrite();

            for (let j = 0; j < comsize; j++) {
              reg = Util.getInt8(fmCommand.data, j * 2 + 1);
              value = fmCommand.data[j * 2 + 2];
              // save state
              ymState[port][reg] = value & 0xff;
              // create command
              this.commands.push(
                new VGMCommand(Uint8Array.from([(VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff, reg & 0xff, value & 0xff]))
              );
            }
            break;

          case XGMFMCommand.FM0_PAN:
          case XGMFMCommand.FM1_PAN:
            reg = 0xb4 + ch;
            value = (ymState[port][reg] & 0x3f) | ((fmCommand.data[0] << 4) & 0xc0);
            // save state
            ymState[port][reg] = value & 0xff;
            // set command
            this.commands.push(
              new VGMCommand(Uint8Array.from([(VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff, reg & 0xff, value & 0xff]))
            );
            break;

          case XGMFMCommand.FM_FREQ:
          case XGMFMCommand.FM_FREQ_WAIT:
            // pre-key off ?
            if ((fmCommand.data[1] & 0x40) !== 0)
              this.commands.push(
                new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x28, (0x00 + (port << 2) + ch) & 0xff]))
              );

            // special mode ?
            reg = fmCommand.isYMFreqSpecialWrite() ? 0xa8 : 0xa0;
            // set channel from slot
            if (fmCommand.isYMFreqSpecialWrite()) ch = fmCommand.getYMSlot() - 1;
            lvalue = fmCommand.getYMFreqValue();
            // save state
            ymState[port][reg + ch + 4] = (lvalue >> 8) & 0x3f;
            ymState[port][reg + ch + 0] = lvalue & 0xff;
            // create commands
            this.commands.push(
              new VGMCommand(
                Uint8Array.from([
                  (VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff,
                  (reg + ch + 4) & 0xff,
                  ymState[port][reg + ch + 4] & 0xff,
                ])
              )
            );
            this.commands.push(
              new VGMCommand(
                Uint8Array.from([
                  (VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff,
                  (reg + ch + 0) & 0xff,
                  ymState[port][reg + ch + 0] & 0xff,
                ])
              )
            );

            // post-key on ?
            if ((fmCommand.data[1] & 0x80) !== 0)
              this.commands.push(
                new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x28, (0xf0 + (port << 2) + ch) & 0xff]))
              );
            break;

          case XGMFMCommand.FM_FREQ_DELTA:
          case XGMFMCommand.FM_FREQ_DELTA_WAIT:
            // special mode ?
            reg = fmCommand.isYMFreqDeltaSpecialWrite() ? 0xa8 : 0xa0;
            // set channel from slot
            if (fmCommand.isYMFreqDeltaSpecialWrite()) ch = fmCommand.getYMSlot() - 1;
            // get state
            lvalue = (ymState[port][reg + ch + 4] & 0x3f) << 8;
            lvalue |= ymState[port][reg + ch + 0] & 0xff;
            lvalue += fmCommand.getYMFreqDeltaValue();
            // save state
            ymState[port][reg + ch + 4] = (lvalue >> 8) & 0x3f;
            ymState[port][reg + ch + 0] = lvalue & 0xff;
            // create commands
            this.commands.push(
              new VGMCommand(
                Uint8Array.from([
                  (VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff,
                  (reg + ch + 4) & 0xff,
                  ymState[port][reg + ch + 4] & 0xff,
                ])
              )
            );
            this.commands.push(
              new VGMCommand(
                Uint8Array.from([
                  (VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff,
                  (reg + ch + 0) & 0xff,
                  ymState[port][reg + ch + 0] & 0xff,
                ])
              )
            );
            break;

          case XGMFMCommand.FM_TL:
            // compute reg
            reg = 0x40 + (fmCommand.getYMSlot() << 2) + ch;
            // save state
            ymState[port][reg] = fmCommand.getYMTLValue() & 0xff;
            // create commands
            this.commands.push(
              new VGMCommand(
                Uint8Array.from([(VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff, reg & 0xff, ymState[port][reg] & 0xff])
              )
            );
            break;

          case XGMFMCommand.FM_TL_DELTA:
          case XGMFMCommand.FM_TL_DELTA_WAIT:
            // compute reg
            reg = 0x40 + (fmCommand.getYMSlot() << 2) + ch;
            // get state
            lvalue = ymState[port][reg] & 0xff;
            lvalue += signed8(fmCommand.getYMTLDelta());
            // save state
            ymState[port][reg] = lvalue & 0xff;
            // create commands
            this.commands.push(
              new VGMCommand(
                Uint8Array.from([(VGMCommand.WRITE_YM2612_PORT0 + port) & 0xff, reg & 0xff, ymState[port][reg] & 0xff])
              )
            );
            break;

          case XGMFMCommand.FM_KEY:
            // create key command
            this.commands.push(
              new VGMCommand(
                Uint8Array.from([
                  VGMCommand.WRITE_YM2612_PORT0 & 0xff,
                  0x28,
                  (((fmCommand.data[0] & 8) !== 0 ? 0xf0 : 0x00) + (port << 2) + ch) & 0xff,
                ])
              )
            );
            break;

          case XGMFMCommand.FM_KEY_SEQ:
            // create key sequence commands
            if ((fmCommand.data[0] & 8) !== 0) {
              // ON-OFF sequence
              this.commands.push(
                new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x28, (0xf0 + (port << 2) + ch) & 0xff]))
              );
              this.commands.push(
                new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x28, (0x00 + (port << 2) + ch) & 0xff]))
              );
            } else {
              // OFF-ON sequence
              this.commands.push(
                new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x28, (0x00 + (port << 2) + ch) & 0xff]))
              );
              this.commands.push(
                new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x28, (0xf0 + (port << 2) + ch) & 0xff]))
              );
            }
            break;

          case XGMFMCommand.FM_KEY_ADV:
            // create key command
            this.commands.push(
              new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x28, fmCommand.data[1] & 0xff]))
            );
            break;

          case XGMFMCommand.FM_DAC_ON:
            // save state
            ymState[0][0x2b] = 0x80;
            this.commands.push(new VGMCommand(Uint8Array.from([0x52, 0x2b, 0x80]), 0));
            break;

          case XGMFMCommand.FM_DAC_OFF:
            // save state
            ymState[0][0x2b] = 0x00;
            this.commands.push(new VGMCommand(Uint8Array.from([0x52, 0x2b, 0x00]), 0));
            break;

          case XGMFMCommand.FM_LFO:
            // save state
            ymState[0][0x22] = fmCommand.data[1] & 0xff;
            // create command
            this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_YM2612_PORT0 & 0xff, 0x22, ymState[0][0x22] & 0xff])));
            break;

          case XGMFMCommand.FM_CH3_SPECIAL_ON:
            // get $27 value
            value = (ymState[0][0x27] & 0xbf) | 0x40;
            // save state
            ymState[0][0x27] = value & 0xff;
            // create command
            this.commands.push(new VGMCommand(Uint8Array.from([0x52, 0x27, value & 0xff]), 0));
            break;

          case XGMFMCommand.FM_CH3_SPECIAL_OFF:
            // get $27 value
            value = (ymState[0][0x27] & 0xbf) | 0x00;
            // save state
            ymState[0][0x27] = value & 0xff;
            // create command
            this.commands.push(new VGMCommand(Uint8Array.from([0x52, 0x27, value & 0xff]), 0));
            break;
        }
      } else if (command instanceof XGMPSGCommand) {
        const psgCommand = command;

        while (time < psgCommand.time) {
          if (this.rate === 50) {
            this.commands.push(new VGMCommand(Uint8Array.from([0x63])));
            time += 882;
          } else {
            this.commands.push(new VGMCommand(Uint8Array.from([0x62])));
            time += 735;
          }
        }

        ch = psgCommand.getChannel();
        let oldhighFreq;

        switch (psgCommand.getType()) {
          case XGMPSGCommand.ENV0:
          case XGMPSGCommand.ENV1:
          case XGMPSGCommand.ENV2:
          case XGMPSGCommand.ENV3:
            // save state
            psgState[0][ch] = psgCommand.getEnv() & 0xffff;
            // register value
            value = (0x90 + (ch << 5)) | psgState[0][ch];
            // create command
            this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_SN76489 & 0xff, value & 0xff])));
            break;

          case XGMPSGCommand.ENV0_DELTA:
          case XGMPSGCommand.ENV1_DELTA:
          case XGMPSGCommand.ENV2_DELTA:
          case XGMPSGCommand.ENV3_DELTA:
            // save state
            psgState[0][ch] = (psgCommand.getEnvDelta() + (psgState[0][ch] & 0xf)) & 0xffff;
            // register value
            value = (0x90 + (ch << 5)) | psgState[0][ch];
            // create command
            this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_SN76489 & 0xff, value & 0xff])));
            break;

          case XGMPSGCommand.FREQ:
          case XGMPSGCommand.FREQ_WAIT:
            oldhighFreq = psgState[1][ch] & 0x03f0;
            lvalue = psgCommand.getFreq();
            // save state
            psgState[1][ch] = lvalue & 0xffff;
            // create commands
            value = (0x80 + (ch << 5)) | (lvalue & 0x0f);
            this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_SN76489 & 0xff, value & 0xff])));
            // high byte changed and not channel 3 (single byte write for channel 3)
            if (oldhighFreq !== (lvalue & 0x3f0) && ch < 3) {
              value = 0x00 | ((lvalue >> 4) & 0x3f);
              this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_SN76489 & 0xff, value & 0xff])));
            }
            break;

          case XGMPSGCommand.FREQ_LOW:
            lvalue = (psgState[1][ch] & 0x03f0) | (psgCommand.getFreqLow() & 0xf);
            // save state
            psgState[1][ch] = lvalue & 0xffff;
            // create command
            value = (0x80 + (ch << 5)) | (lvalue & 0x0f);
            this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_SN76489 & 0xff, value & 0xff])));
            break;

          case XGMPSGCommand.FREQ0_DELTA:
          case XGMPSGCommand.FREQ1_DELTA:
          case XGMPSGCommand.FREQ2_DELTA:
          case XGMPSGCommand.FREQ3_DELTA:
            oldhighFreq = psgState[1][ch] & 0x03f0;
            lvalue = (psgState[1][ch] & 0x03ff) + psgCommand.getFreqDelta();
            // save state
            psgState[1][ch] = lvalue & 0xffff;
            // create commands
            value = (0x80 + (ch << 5)) | (lvalue & 0x0f);
            this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_SN76489 & 0xff, value & 0xff])));
            // high byte changed and not channel 3 (single byte write for channel 3)
            if (oldhighFreq !== (lvalue & 0x3f0) && ch < 3) {
              value = 0x00 | ((lvalue >> 4) & 0x3f);
              this.commands.push(new VGMCommand(Uint8Array.from([VGMCommand.WRITE_SN76489 & 0xff, value & 0xff])));
            }
            break;
        }
      }
    }

    // pack wait and update time and offsets for all command
    this.packWait();

    // we had a loop command ?
    if (loopOffset !== -1) {
      // find pointed XGM command
      const command = xgm.getFMCommandAtOffset(loopOffset);

      // found ? --> insert a VGM loop start command at corresponding position
      if (command != null)
        this.commands.splice(Command.getCommandIndexAtTime(this.commands, command.time), 0, new LoopStartCommand());

      // update time for added loop command (offsets don't change as loop commands are dummy)
      this.updateTimes();
    }

    // end marker
    this.commands.push(new VGMCommand(Uint8Array.from([0x66])));

    // update offsets and time
    this.updateOffsets();
    this.updateTimes();
  }

  /**
   * Update time information for all command
   */
  updateTimes() {
    let time = 0;

    for (const com of this.commands) {
      com.time = time;
      time += com.getWaitValue();
    }
  }

  /**
   * Update origin offset information for all command
   */
  updateOffsets() {
    Command.computeOffsets(this.commands, this.offsetStart);
  }

  /**
   * @returns {number}
   */
  getTotalTime() {
    const size = this.commands.length;
    if (size === 0) return 0;

    return this.commands[size - 1].time;
  }

  /**
   * @param {VGMCommand} from
   * @returns {number}
   */
  getTimeFrom(from) {
    return this.getTotalTime() - from.time;
  }

  parse() {
    let time = 0;
    let loopTimeSt = -1;
    let lastPSGLowWrite = 0;

    // parse all VGM commands
    let off = this.offsetStart;
    while (off < this.offsetEnd) {
      // check for loop start
      if (loopTimeSt === -1 && this.loopStart !== 0 && off >= this.loopStart) {
        this.commands.push(new LoopStartCommand());
        loopTimeSt = time;
      }

      const command = new VGMCommand(this.data, off);
      time += command.getWaitValue();
      off += command.size;

      // PSG write ?
      if (command.isPSGWrite()) {
        // get write type (tone / env)
        if (command.isPSGLowByteWrite()) lastPSGLowWrite = command.getPSGValue();
        // high byte write for env write ?
        else if ((lastPSGLowWrite & 0x10) === 0x10)
          // format it as low byte write
          command.data[1] = ((lastPSGLowWrite & 0xf0) | (command.data[1] & 0x0f)) & 0xff;
      }

      // stop here (we don't add the end command)
      if (command.isEnd()) break;

      // add command
      this.commands.push(command);
    }

    // we have a loop ?
    if (loopTimeSt >= 0 && this.loopLenInSample !== 0) {
      const delta = this.loopLenInSample - (time - loopTimeSt);

      // missing a bit of time before looping ?
      if (delta > Math.floor(44100 / 100))
        // insert wait frame command
        this.commands.push(new VGMCommand(this.rate === 60 ? VGMCommand.WAIT_NTSC_FRAME : VGMCommand.WAIT_PAL_FRAME));
    }

    // add final 'end command'
    this.commands.push(new VGMCommand(VGMCommand.END));
  }

  /**
   * @param {boolean} convert
   */
  buildSamples(convert) {
    // builds data blocks (compatible with all versions)
    for (const command of this.commands) if (command.isDataBlock()) this.addDataBlock(command);

    // clean seek
    this.cleanSeekCommands();
    // clean useless PCM data
    // cleanPlayPCMCommands();

    // extract samples from seek command
    let ind = 0;
    while (ind < this.commands.length) {
      if (this.commands[ind].isSeek()) ind = this.extractSampleFromSeek(ind, convert);
      else ind++;
    }

    // set bank id and frequency to -1 by default
    const sampleIdBanks = new Array(0x100);
    const sampleIdFrequencies = new Array(0x100);

    for (let i = 0; i < 0x100; i++) {
      sampleIdBanks[i] = -1;
      sampleIdFrequencies[i] = 0;
    }

    // first pass to extract sample info from stream commands
    ind = 0;
    while (ind < this.commands.length) {
      const command = this.commands[ind];

      // set bank id for given stream
      if (command.isStreamData()) sampleIdBanks[command.getStreamId()] = command.getStreamBankId();
      // set frequency for given stream
      else if (command.isStreamFrequency()) sampleIdFrequencies[command.getStreamId()] = command.getStreamFrenquency();
      // short start command
      else if (command.isStreamStart()) {
        const bankId = sampleIdBanks[command.getStreamId()];
        const bank = this.getDataBank(bankId);

        if (bank != null) {
          const sampleId = command.getStreamBlockId();
          const sample = bank.getSampleById(sampleId);

          // sample found --> adjust frequency
          if (sample != null) {
            sample.setRate(sampleIdFrequencies[command.getStreamId()]);
            // convert to long command as we use single data block
            if (convert) this.commands[ind] = sample.getStartLongCommand(sample.len);
          }
          // (sample not found print dropped)
        }
        // (sample bank not found print dropped)
      }

      // long start command
      if (command.isStreamStartLong()) {
        const bankId = sampleIdBanks[command.getStreamId()];
        const bank = this.getDataBank(bankId);

        if (bank != null) {
          const sampleAddress = command.getStreamSampleAddress();
          const sampleLen = command.getStreamSampleSize();

          // add sample
          bank.addSample(sampleAddress, sampleLen, sampleIdFrequencies[command.getStreamId()]);
        }
      }

      ind++;
    }

    if (convert) {
      // remove old seek and play PCM commands
      this.removeSeekAndPlayPCMCommands();
      // rebuild data blocks
      this.updateSampleDataBlocks();
    }
  }

  /**
   * @param {number} index
   * @param {boolean} convert
   * @returns {number}
   */
  extractSampleFromSeek(index, convert) {
    const seekIndex = index;
    let command = this.commands[seekIndex];
    // get sample address in data bank
    let sampleAddr = command.getSeekAddress();

    let bank;
    let ind;
    let len;
    let wait;
    let delta;
    let deltaMean;
    let endPlayWait;

    let startPlayInd;
    let endPlayInd;

    // sample stats
    let sampleData;
    let sampleMinData;
    let sampleMaxData;
    let sampleMeanDelta;

    // use the last bank (FIXME: not really nice to do that)
    if (this.sampleBanks.length !== 0) bank = this.sampleBanks[this.sampleBanks.length - 1];
    else bank = null;

    // then find seek command to extract sample
    len = 0;
    wait = -1;
    delta = 0;
    deltaMean = 0.0;
    endPlayWait = 0;

    sampleData = 128;
    sampleMinData = 128;
    sampleMaxData = 128;
    sampleMeanDelta = 0;

    startPlayInd = -1;
    endPlayInd = -1;
    ind = seekIndex + 1;
    while (ind < this.commands.length) {
      command = this.commands[ind];

      // sample done !
      if (command.isDataBlock() || command.isEnd()) break;
      if (command.isSeek()) {
        const seekAddr = command.getSeekAddress();
        const curAddr = sampleAddr + len;

        // seek on different address --> interrupt current play
        if (curAddr + VGM.SAMPLE_ALLOWED_MARGE < seekAddr || curAddr - VGM.SAMPLE_ALLOWED_MARGE > seekAddr) break;
        // (small offset change continue-play print dropped)
      }

      // playing ?
      if (wait !== -1) {
        delta = wait - endPlayWait;

        // delta >= 20 means rate < 2200 Hz --> very unlikely, discard it from mean computation
        if (delta < 20) {
          // compute delta mean for further correction
          if (deltaMean === 0) deltaMean = delta;
          else deltaMean = delta * 0.1 + deltaMean * 0.9;
        }

        // delta > SAMPLE_END_DELAY samples --> sample ended
        if (delta > VGM.SAMPLE_END_DELAY) {
          // found a sample --> add it
          if (len > 0 && endPlayWait > 0 && startPlayInd !== endPlayInd) {
            // ignore too short sample
            if (len < VGM.SAMPLE_MIN_SIZE && Launcher.sampleIgnore) {
              // (too small print dropped)
            }
            // ignore sample with too small dynamic
            else if (sampleMaxData - sampleMinData < VGM.SAMPLE_MIN_DYNAMIC && Launcher.sampleIgnore) {
              // (too quiet dynamic print dropped)
            }
            // ignore sample too quiet
            else if (sampleMeanDelta / len < VGM.SAMPLE_MIN_MEAN_DELTA && Launcher.sampleIgnore) {
              // (too quiet print dropped)
            } else if (bank != null) {
              const r = Math.round((44100.0 * len) / endPlayWait);
              const sample = bank.addSample(sampleAddr, len, r);

              if (convert) {
                // insert stream play command
                this.commands.splice(startPlayInd + 0, 0, sample.getSetRateCommand(sample.rate));
                this.commands.splice(startPlayInd + 1, 0, sample.getStartLongCommand(len));

                // always insert sample stop as sample len can change
                {
                  // insert stream stop command
                  this.commands.splice(endPlayInd + 0, 0, sample.getStopCommand());
                }
              }
            }
          }

          // reset
          sampleAddr += len;
          len = 0;
          wait = -1;
          delta = 0;
          deltaMean = 0.0;
          endPlayWait = 0;

          sampleData = 128;
          sampleMinData = 128;
          sampleMaxData = 128;
          sampleMeanDelta = 0;

          startPlayInd = -1;
          endPlayInd = -1;
        }
      }

      // compute sample len
      if (command.isPCM()) {
        // start play --> init wait
        if (wait === -1) {
          wait = 0;
          startPlayInd = ind;
        }

        // simple fix by using mean
        if (Launcher.sampleRateFix) {
          // can correct ?
          if (deltaMean !== 0) {
            const mean = Math.round(deltaMean);
            if (delta < mean - 2) wait += mean - delta;
            else if (delta > mean + 2) wait -= delta - mean;
          }
        }

        // keep trace of last play wait value
        endPlayWait = wait;
        endPlayInd = ind;

        // get current sample value
        if (bank != null) {
          // inside the bank
          if (sampleAddr + len < bank.getLength()) {
            const d = Util.getInt8(bank.data, sampleAddr + len);

            sampleMeanDelta += Math.abs(d - sampleData);
            if (sampleMinData > d) sampleMinData = d;
            if (sampleMaxData < d) sampleMaxData = d;
            sampleData = d;
          }
        }

        wait += command.getWaitValue();
        len++;
      }
      // playing ?
      else if (wait !== -1) wait += command.getWaitValue();

      ind++;
    }

    // found a sample --> add it
    if (len > 0 && endPlayWait > 0 && startPlayInd !== endPlayInd) {
      // ignore too short sample
      if (len < VGM.SAMPLE_MIN_SIZE && Launcher.sampleIgnore) {
        // (too small print dropped)
      }
      // ignore sample with too small dynamic
      else if (sampleMaxData - sampleMinData < VGM.SAMPLE_MIN_DYNAMIC && Launcher.sampleIgnore) {
        // (too quiet dynamic print dropped)
      }
      // ignore sample too quiet
      else if (sampleMeanDelta / len < VGM.SAMPLE_MIN_MEAN_DELTA && Launcher.sampleIgnore) {
        // (too quiet print dropped)
      } else if (bank != null) {
        const r = Math.round((44100.0 * len) / endPlayWait);
        const sample = bank.addSample(sampleAddr, len, r);

        if (convert) {
          // insert stream play command
          this.commands.splice(startPlayInd + 0, 0, sample.getSetRateCommand(sample.rate));
          this.commands.splice(startPlayInd + 1, 0, sample.getStartLongCommand(len));

          // always insert sample stop as sample len can change
          {
            // insert stream stop command
            this.commands.splice(endPlayInd + 0, 0, sample.getStopCommand());
          }
        }
      }
    }

    return ind;
  }

  /**
   * @param {number} id
   * @returns {SampleBank|null}
   */
  getDataBank(id) {
    for (const bank of this.sampleBanks) if (bank.id === id) return bank;

    return null;
  }

  /**
   * @param {VGMCommand} command
   * @returns {SampleBank}
   */
  addDataBlock(command) {
    let result;

    result = this.getDataBank(command.getDataBankId());
    // different id --> new bank
    if (result == null) {
      // (more than 1 bank warning print dropped)

      result = new SampleBank(command);
      this.sampleBanks.push(result);
    }
    // same id --> concat block
    else result.addBlock(command);

    return result;
  }

  cleanSeekCommands() {
    /** @type {Set<VGMCommand>} */
    const removed = new Set();
    let samplePlayed = false;

    for (let ind = this.commands.length - 1; ind >= 0; ind--) {
      const command = this.commands[ind];

      // seek command ?
      if (command.isSeek()) {
        // no sample played after this seek command --> remove it
        if (!samplePlayed) {
          // (useless seek print dropped)
          removed.add(this.commands[ind]);
        }

        samplePlayed = false;
      } else if (command.isPCM()) samplePlayed = true;
    }

    if (removed.size !== 0) {
      // rebuild the command list without useless seek
      /** @type {VGMCommand[]} */
      const newComms = [];

      for (const com of this.commands) if (!removed.has(com)) newComms.push(com);

      this.commands = newComms;
    }

    // update time and offsets for all command
    this.updateTimes();
    this.updateOffsets();
  }

  removeDummyStreamStopCommands() {
    for (let ind = this.commands.length - 2; ind >= 0; ind--) {
      // remove stream stop command followed by stream frequency (that means we start another sample immediately)
      if (this.commands[ind].isStreamStop())
        if (this.commands[ind + 1].isStreamFrequency()) this.commands.splice(ind, 1);
    }
  }

  removeSeekAndPlayPCMCommands() {
    /** @type {VGMCommand[]} */
    const newComms = [];

    for (let ind = 0; ind < this.commands.length; ind++) {
      const command = this.commands[ind];

      // remove Seek command
      if (command.isSeek()) continue;
      // replace PCM command by simple wait command
      else if (command.isPCM()) {
        const wait = command.getWaitValue();

        // remove or just replace by wait command
        if (wait === 0) continue;

        newComms.push(new VGMCommand(0x70 + (wait - 1)));
      } else newComms.push(command);
    }

    this.commands = newComms;
  }

  /**
   * @param {VGMCommand[]} frameCommands
   */
  cleanKeyCommands(frameCommands) {
    /** @type {Set<VGMCommand>} */
    const toRemove = new Set();

    const hasKeyOn = new Array(6).fill(false);
    const hasKeyOff = new Array(6).fill(false);

    // start from end of frame
    for (let c = frameCommands.length - 1; c >= 0; c--) {
      const com = frameCommands[c];

      if (com.isYM2612KeyOnWrite()) {
        const ch = com.getYM2612Channel();

        // can't have several key-on in a single frame
        if (ch === -1 || hasKeyOn[ch]) toRemove.add(com);
        else hasKeyOn[ch] = true;
      } else if (com.isYM2612KeyOffWrite()) {
        const ch = com.getYM2612Channel();

        // can't have more than 2 key-off in a single frame
        if (ch === -1 || hasKeyOff[ch]) toRemove.add(com);
        else {
          // allow an extra key-off after a key-on
          if (hasKeyOn[ch]) hasKeyOff[ch] = true;
        }
      }
    }

    /** @type {VGMCommand[]} */
    const temp = [];
    for (const com of frameCommands) if (!toRemove.has(com)) temp.push(com);

    /** @type {(boolean|null)[]} */
    const keyState = new Array(6).fill(null);
    // then in normal frame order
    for (const com of temp) {
      if (com.isYM2612KeyOnWrite()) {
        const ch = com.getYM2612Channel();

        // already on
        if (keyState[ch] != null && keyState[ch]) toRemove.add(com);

        keyState[ch] = true;
      } else if (com.isYM2612KeyOffWrite()) {
        const ch = com.getYM2612Channel();

        // already off
        if (keyState[ch] != null && !keyState[ch]) toRemove.add(com);

        keyState[ch] = false;
      }
    }

    // finally rebuild frameCommands
    frameCommands.length = 0;
    for (const com of temp) if (!toRemove.has(com)) frameCommands.push(com);
  }

  cleanCommands() {
    /** @type {VGMCommand[]} */
    let frameCommands = [];

    /** @type {VGMCommand[]} */
    const newCommands = [];
    /** @type {VGMCommand[]} */
    const optimizedCommands = [];
    /** @type {VGMCommand[]} */
    const keyOnOffCommands = [];
    /** @type {VGMCommand[]} */
    const ymCommands = [];
    /** @type {VGMCommand[]} */
    const lastCommands = [];

    let ymLoopState;
    let psgLoopState;
    let ymOldState;
    let ymState;
    let psgOldState;
    let psgState;

    ymLoopState = null;
    psgLoopState = null;
    ymOldState = new YM2612State();
    ymState = new YM2612State();
    psgOldState = new PSGState();
    psgState = new PSGState();

    let command;
    let startInd;
    let endInd;

    startInd = 0;
    while (true) {
      endInd = startInd;
      frameCommands.length = 0;

      // build frame commands
      do {
        command = this.commands[endInd];
        frameCommands.push(command);
        endInd++;
      } while (endInd < this.commands.length && !command.isWait() && !command.isEnd());

      // clean duplicated key com
      this.cleanKeyCommands(frameCommands);

      psgState = new PSGState(psgOldState);
      ymState = new YM2612State(ymOldState);

      // first frame ? --> reset special FM feature state (otherwise they may be not properly reseted on start play)
      if (startInd === 0) {
        // LFO
        ymState.set(0, 0x22, 0);
        // FM2 SPE mode / CSM
        ymState.set(0, 0x27, 0);
        // default panning
        ymState.set(0, 0xb4, 0xc0);
        ymState.set(0, 0xb5, 0xc0);
        ymState.set(0, 0xb6, 0xc0);
        ymState.set(1, 0xb4, 0xc0);
        ymState.set(1, 0xb5, 0xc0);
        ymState.set(1, 0xb6, 0xc0);
      }

      // clear frame sets
      optimizedCommands.length = 0;
      keyOnOffCommands.length = 0;
      ymCommands.length = 0;
      lastCommands.length = 0;

      let hasKeyCom = false;
      for (let ind = 0; ind < frameCommands.length; ind++) {
        command = frameCommands[ind];

        // keep data block / stream and loop commands at first
        if (command.isDataBlock() || command.isStream() || command.isLoopStart()) {
          optimizedCommands.push(command);

          // loop start ?
          if (command.isLoopStart()) {
            // save loop state
            ymLoopState = new YM2612State(ymOldState);
            psgLoopState = new PSGState(psgOldState);
          }
        } else if (command.isPSGWrite()) psgState.write(command.getPSGValue());
        else if (command.isYM2612Write()) {
          // key write ?
          if (command.isYM2612KeyWrite()) {
            // key state really changed ?
            if (ymState.set(command.getYM2612Port(), command.getYM2612Register(), command.getYM2612Value())) {
              // store it as getDelta won't return it
              keyOnOffCommands.push(command);
              hasKeyCom = true;
            }
          }
          // other write ?
          else {
            // check first if we need to flush commands (for accurate order of key events / register writes)
            if (hasKeyCom) {
              // add frame commands for delta YM
              ymCommands.push(...ymOldState.getDelta(ymState, true));
              // add frame commands for key on/off
              ymCommands.push(...keyOnOffCommands);

              keyOnOffCommands.length = 0;

              // update old state
              ymOldState = new YM2612State(ymState);

              hasKeyCom = false;
            }

            // write to YM state and check if state changed
            ymState.set(command.getYM2612Port(), command.getYM2612Register(), command.getYM2612Value());
          }
        }
        // add frame commands at last
        else if (command.isWait() || command.isSeek()) lastCommands.push(command);
        else {
          // (ignored command print dropped)
        }
      }

      let hasStreamStart = false;
      let hasStreamRate = false;
      // check we have single stream per frame (start from end)
      let ind = optimizedCommands.length - 1;
      while (ind >= 0) {
        command = optimizedCommands[ind];

        if (command.isStreamStartLong()) {
          if (hasStreamStart) {
            // (more than 1 PCM in single frame print dropped)
            optimizedCommands.splice(ind, 1);
          }

          hasStreamStart = true;
        } else if (command.isStreamFrequency()) {
          if (hasStreamRate) {
            // (stream rate removed print dropped)
            optimizedCommands.splice(ind, 1);
          }

          hasStreamRate = true;
        }

        ind--;
      }

      // end of track ?
      if (endInd >= this.commands.length || command.isEnd()) {
        // loop point ? --> use YM / PSG loop point state for proper state restoration
        if (ymLoopState != null) ymState = ymLoopState;
        if (psgLoopState != null) psgState = psgLoopState;
      }

      // send first merged YM commands (with intermediate key on/off)
      optimizedCommands.push(...ymCommands);
      // add frame commands for delta YM
      optimizedCommands.push(...ymOldState.getDelta(ymState, true));
      // add frame commands for key on/off
      optimizedCommands.push(...keyOnOffCommands);
      // add frame commands for delta PSG
      optimizedCommands.push(...psgOldState.getDelta(psgState));
      // add frame final commands
      optimizedCommands.push(...lastCommands);

      // add frame optimized set to new commands
      newCommands.push(...optimizedCommands);

      // end of the track --> stop here
      if (endInd >= this.commands.length || command.isEnd()) break;

      // update states
      ymOldState = new YM2612State(ymState);
      psgOldState = new PSGState(psgState);

      // next frame
      startInd = endInd;
    }

    // end command
    newCommands.push(new VGMCommand(VGMCommand.END));

    this.commands = newCommands;
    // update time and offsets for all command
    this.updateTimes();
    this.updateOffsets();
  }

  cleanSamples() {
    // detect unused samples
    for (let b = this.sampleBanks.length - 1; b >= 0; b--) {
      const bank = this.sampleBanks[b];
      const bankId = bank.id;

      for (let s = bank.samples.length - 1; s >= 0; s--) {
        const sample = bank.samples[s];
        const sampleId = sample.id;
        const minLen = Math.max(0, sample.len - 50);
        const maxLen = sample.len + 50;
        let used = false;
        let currentBankId = -1;

        for (let c = 0; c < this.commands.length - 1; c++) {
          const command = this.commands[c];

          if (command.isStreamData()) currentBankId = command.getStreamBankId();

          if (bankId === currentBankId) {
            if (command.isStreamStart()) {
              if (sampleId === command.getStreamBlockId()) {
                used = true;
                break;
              }
            } else if (command.isStreamStartLong()) {
              const sampleLen = command.getStreamSampleSize();

              if (sample.matchAddress(command.getStreamSampleAddress()) && sampleLen >= minLen && sampleLen <= maxLen) {
                used = true;
                break;
              }
            }
          }
        }

        // sample not used --> remove it
        if (!used) {
          // (unused sample print dropped)
          bank.samples.splice(s, 1);
        }
      }
    }

    // save old sample addresses (map<comm_offset, sample_address>)
    /** @type {Map<number, number>} */
    const oldSampleAddresses = new Map();
    let currentBank = null;

    for (let c = 0; c < this.commands.length - 1; c++) {
      const command = this.commands[c];

      if (command.isStreamData()) currentBank = this.getDataBank(command.getStreamBankId());

      if (command.isStreamStartLong() && currentBank != null) {
        const sample = currentBank.getSampleByAddress(command.getStreamSampleAddress());

        // store command offset / old sample address couple
        if (sample != null) oldSampleAddresses.set(command.getOriginOffset(), sample.addr);
        // (cannot find matching sample address warning dropped)
      }
    }

    // map containing <id_bank, <sample_old_addr, sample_new_addr>>
    /** @type {Map<number, Map<number, number>>} */
    const bankSampleAddrChange = new Map();

    // optimize sample data banks (remove unused data)
    for (const bank of this.sampleBanks) bankSampleAddrChange.set(bank.id, bank.optimize());

    // update samples address
    /** @type {Map<number, number>|null} */
    let sampleAddressChanges = null;
    for (let c = 0; c < this.commands.length - 1; c++) {
      const command = this.commands[c];

      // get sample address changes for the current bank
      if (command.isStreamData()) sampleAddressChanges = bankSampleAddrChange.get(command.getStreamBankId());

      // long stream start command ? --> need to update it
      if (command.isStreamStartLong()) {
        // no bank set ?
        if (sampleAddressChanges == null) {
          // (cannot update sample address warning dropped)
          continue;
        }

        const oldAddr = oldSampleAddresses.get(command.getOriginOffset());

        // should always be the case
        if (oldAddr != null) {
          // get new sample address
          const newAddr = sampleAddressChanges.get(oldAddr);

          if (newAddr != null) command.setStreamSampleAddress(newAddr);
          // (cannot update sample address warning dropped)
        }
        // (cannot update sample address warning dropped)
      }
    }

    // update sample banks declaration
    this.updateSampleDataBlocks();
  }

  updateSampleDataBlocks() {
    /** @type {VGMCommand[]} */
    const newComms = [];

    for (const bank of this.sampleBanks) {
      // add data block / declaration for each sample
      newComms.push(bank.getDataBlockCommand());
      newComms.push(...bank.getDeclarationCommands());
    }

    // remove previous data blocks
    for (let ind = 0; ind < this.commands.length; ind++) {
      const command = this.commands[ind];

      // don't add them
      if (command.isDataBlock() || command.isStreamControl() || command.isStreamData()) continue;

      newComms.push(this.commands[ind]);
    }

    this.commands = newComms;
  }

  fixKeyCommands() {
    /** @type {VGMCommand[]} */
    const delayedCommands = [];
    // maximum delta time allowed for key command (1/4 of frame)
    const maxDelta = Math.floor(Math.floor(44100 / this.rate) / 4);
    const keyOffTime = new Array(6);
    const keyOnTime = new Array(6);
    let i;

    delayedCommands.length = 0;
    for (i = 0; i < 6; i++) {
      keyOffTime[i] = -1;
      keyOnTime[i] = -1;
    }

    // this method should be called after waits has been converted to frame wait
    let ind = 0;
    while (ind < this.commands.length) {
      const command = this.commands[ind];

      // new frame
      if (command.isWait()) {
        // some delayed commands ?
        if (delayedCommands.length !== 0) {
          // insert them right after current command
          this.commands.splice(ind + 1, 0, ...delayedCommands);
          ind += delayedCommands.length;
          delayedCommands.length = 0;
        }

        // reset key traces
        for (i = 0; i < 6; i++) {
          keyOffTime[i] = -1;
          keyOnTime[i] = -1;
        }
      } else {
        if (command.isYM2612KeyWrite()) {
          const ch = command.getYM2612Channel();

          if (ch !== -1) {
            // key off command ?
            if (command.isYM2612KeyOffWrite()) {
              keyOffTime[ch] = command.time;

              // previous key on in same frame ?
              if (keyOnTime[ch] !== -1) {
                // delta time with previous key on is > max delta --> delayed key Off command
                if (command.time !== -1 && command.time - keyOnTime[ch] > maxDelta) {
                  if (Launcher.delayKeyOff) {
                    // (delayed key OFF warning print dropped)

                    // remove current command from list
                    removeFirst(this.commands, command);

                    // add to delayed only if we don't already have delayed key off for this channel
                    if (VGMCommand.getKeyOffCommand(delayedCommands, ch) == null) delayedCommands.push(command);
                  }
                  // (key ON/OFF & delayed key OFF disabled warning print dropped)
                }
              }
            }
            // key on command ?
            else {
              keyOnTime[ch] = command.time;

              // not a good idea to delay key on
            }
          }
        }
      }

      ind++;
    }
  }

  /**
   * @param {number} sampleAddress
   * @returns {import("./sample-bank.js").InternalSample|null}
   */
  getSample(sampleAddress) {
    for (const bank of this.sampleBanks) {
      const sample = bank.getSampleByAddress(sampleAddress);

      if (sample != null) return sample;
    }

    return null;
  }

  convertWaits() {
    /** @type {VGMCommand[]} */
    const newCommands = [];
    // number of sample per frame
    const samplePerFrame = Math.floor(44100 / this.rate);
    // -15%
    const samplePerFramePercent = Math.floor((samplePerFrame * 15) / 100);
    const samplePerFrameLimit = samplePerFrame - samplePerFramePercent;
    const comWait = this.rate === 60 ? VGMCommand.WAIT_NTSC_FRAME : VGMCommand.WAIT_PAL_FRAME;

    // force update times now
    this.updateTimes();

    let sampleCnt = 0;
    let lastWait = 0;
    for (const command of this.commands) {
      // add no wait command
      if (!command.isWait()) newCommands.push(command);
      else {
        lastWait = command.getWaitValue();
        sampleCnt += lastWait;
      }

      while (sampleCnt > (lastWait > samplePerFramePercent ? samplePerFrameLimit : samplePerFrame)) {
        newCommands.push(new VGMCommand(comWait));
        sampleCnt -= samplePerFrame;
      }
    }

    // set new commands
    this.commands = newCommands;
    // update time and offsets for all command
    this.updateTimes();
    this.updateOffsets();
  }

  packWait() {
    /** @type {VGMCommand[]} */
    const newCommands = [];

    let c = 0;
    while (c < this.commands.length) {
      // get next wait command
      while (!this.commands[c].isWait()) {
        // rebuild new command set
        newCommands.push(this.commands[c]);

        // done ? --> stop here
        if (++c >= this.commands.length) {
          this.commands = newCommands;
          this.updateTimes();
          this.updateOffsets();
          return;
        }
      }

      let wait = 0;
      // get next no wait command
      while (this.commands[c].isWait()) {
        // sum wait
        wait += this.commands[c].getWaitValue();
        // done ? --> stop here
        if (++c >= this.commands.length) break;
      }

      // add new wait commands
      newCommands.push(...VGMCommand.createWaitCommands(wait));
    }

    // set new commands
    this.commands = newCommands;

    // update time and offsets for all command
    this.updateTimes();
    this.updateOffsets();
  }

  /**
   * @param {number} sft
   */
  shiftSamples(sft) {
    if (sft === 0) return;

    /** @type {VGMCommand[][]} */
    const sampleCommands = new Array(sft);

    for (let i = 0; i < sampleCommands.length; i++) sampleCommands[i] = [];

    let frameRead = 0;
    let frameWrite = 1;
    let index = this.commands.length - 1;
    while (index >= 0) {
      const command = this.commands[index];

      if (command.isStream()) {
        sampleCommands[frameRead].push(command);
        this.commands.splice(index, 1);
      } else if (command.isWait() || command.isEnd()) {
        frameRead = (frameRead + 1) % sft;
        frameWrite = (frameWrite + 1) % sft;

        // add sample command to this frame
        while (sampleCommands[frameWrite].length !== 0)
          this.commands.splice(index, 0, sampleCommands[frameWrite].pop());
      }

      index--;
    }

    // add last remaining samples
    for (let i = 0; i < sampleCommands.length; i++)
      while (sampleCommands[i].length !== 0) this.commands.splice(0, 0, sampleCommands[i].pop());

    // update time and offsets for all command
    this.updateTimes();
    this.updateOffsets();
  }

  /**
   * @returns {number}
   */
  getSampleDataSize() {
    let result = 0;

    for (const bank of this.sampleBanks) result += bank.getLength();

    return result;
  }

  /**
   * @returns {number}
   */
  getSampleTotalLen() {
    let result = 0;

    for (const bank of this.sampleBanks) for (const sample of bank.samples) result += sample.len;

    return result;
  }

  /**
   * @returns {number}
   */
  getSampleNumber() {
    let result = 0;

    for (const sampleBank of this.sampleBanks) result += sampleBank.samples.length;

    return result;
  }

  /**
   * @returns {number}
   */
  getMusicDataSize() {
    let result = 0;

    for (const command of this.commands) if (!command.isDataBlock()) result += command.size;

    return result;
  }

  /**
   * @returns {Uint8Array}
   */
  asByteArray() {
    let gd3Offset = 0;
    /** @type {number[]} */
    const result = [];

    // 00: VGM
    pushBytes(result, Util.getBytesAscii("Vgm "));
    // 04: len (reserve 4 bytes)
    result.push(0x00, 0x00, 0x00, 0x00);
    // 08: version 1.60
    result.push(0x60, 0x01, 0x00, 0x00);
    // 0C: SN76489 clock
    result.push(0x99, 0x9e, 0x36, 0x00);
    // 10: YM2413 clock
    result.push(0x00, 0x00, 0x00, 0x00);
    // 14: GD3 offset
    result.push(0x00, 0x00, 0x00, 0x00);
    // 18: total number of sample (44100 samples per second)
    result.push(0x00, 0x00, 0x00, 0x00);
    // 1C: loop offset
    result.push(0, 0, 0, 0);
    // 20: loop number of samples (44100 samples per second)
    result.push(0, 0, 0, 0);
    // 24: rate (50 or 60 Hz)
    result.push(0x3c, 0x00, 0x00, 0x00);
    // 28: SN76489 flags
    result.push(0x09, 0x00, 0x10, 0x00);
    // 2C: YM2612 clock
    result.push(0xb5, 0x0a, 0x75, 0x00);
    // 30: YM2151 clock
    result.push(0x00, 0x00, 0x00, 0x00);
    // 34: VGM data offset
    result.push(0x4c, 0x00, 0x00, 0x00);
    // 38: Sega PCM clock
    result.push(0x00, 0x00, 0x00, 0x00);
    // 3C: Sega PCM interface
    result.push(0x00, 0x00, 0x00, 0x00);
    // 40-80
    for (let i = 0x40; i < 0x80; i++) result.push(0x00);

    let loopCommand = null;
    let loopOffset = 0;

    // write command (ignore loop marker)
    for (const command of this.commands) {
      // store start loop position
      if (command.isLoopStart()) {
        loopCommand = command;
        loopOffset = result.length - 0x1c;
      }
      // just write command
      else pushBytes(result, command.asByteArray());
    }

    // write GD3 tags if present
    if (this.gd3 != null) {
      // get GD3 offset
      gd3Offset = result.length;
      pushBytes(result, this.gd3.asByteArray());
    }

    const array = Uint8Array.from(result);

    if (loopCommand != null) {
      // set loop offset
      Util.setInt32(array, 0x1c, loopOffset);
      // and loop duration
      Util.setInt32(array, 0x20, this.getTimeFrom(loopCommand));
    }
    // set GD3 offset
    if (this.gd3 != null) Util.setInt32(array, 0x14, gd3Offset - 0x14);
    // set file size
    Util.setInt32(array, 0x04, array.length - 4);
    // set len in sample
    Util.setInt32(array, 0x18, this.getTotalTime() - 1);

    return array;
  }
}

/**
 * Sign-extend an 8-bit value (Java `(byte)` cast applied to getYMTLDelta()).
 * @param {number} v
 * @returns {number}
 */
function signed8(v) {
  return ((v & 0xff) << 24) >> 24;
}

/**
 * Remove the first occurrence of `item` from `arr` (mirror of List.remove(Object)).
 * @param {any[]} arr
 * @param {any} item
 */
function removeFirst(arr, item) {
  const idx = arr.indexOf(item);
  if (idx !== -1) arr.splice(idx, 1);
}

/**
 * Append all bytes of `bytes` to the number array `arr`.
 * @param {number[]} arr
 * @param {Uint8Array|number[]} bytes
 */
function pushBytes(arr, bytes) {
  for (let i = 0; i < bytes.length; i++) arr.push(bytes[i] & 0xff);
}

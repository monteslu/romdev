// Port of sgdk.xgm2tool.format.XGM — single-track XGM2 music file (parse/convert/build).

import { getASCIIString, getInt8, getInt16, alignBytes } from "./util.js";
import { Command } from "./command.js";
import { GD3 } from "./gd3.js";
import { XD3 } from "./xd3.js";
import { YM2612State } from "./ym2612-state.js";
import { XGMSample } from "./xgm-sample.js";
import { XGCPacker } from "./xgc-packer.js";
import {
  XGMFMCommand,
  LoopStartCommand as FMLoopStartCommand,
  EndCommand as FMEndCommand,
  FrameCommand as FMFrameCommand,
  FrameDelayCommand as FMFrameDelayCommand,
} from "./xgm-fm-command.js";
import {
  XGMPSGCommand,
  LoopStartCommand as PSGLoopStartCommand,
  EndCommand as PSGEndCommand,
  FrameCommand as PSGFrameCommand,
} from "./xgm-psg-command.js";

/**
 * Append every byte of `src` (Uint8Array / number[]) onto `arr` — mirrors
 * Java's ByteArrayOutputStream.write(byte[]).
 * @param {number[]} arr
 * @param {Uint8Array|number[]} src
 */
function writeBytes(arr, src) {
  for (let i = 0; i < src.length; i++) arr.push(src[i] & 0xff);
}

export class XGM {
  // single XGM supports a maximum of 124-1 = 123 samples

  /**
   * Construct an XGM. Three forms mirror the Java overloads:
   *   new XGM()                  — empty (protected)
   *   new XGM(data)              — parse from a byte buffer (Uint8Array)
   *   new XGM(vgm, pack)         — convert from a VGM instance
   *
   * @param {?(Uint8Array|import("./vgm.js").VGM)} [arg]
   * @param {boolean} [pack]
   */
  constructor(arg, pack) {
    /** @type {XGMSample[]} */
    this.samples = [];
    /** @type {XGMFMCommand[]} */
    this.FMcommands = [];
    /** @type {XGMPSGCommand[]} */
    this.PSGcommands = [];
    /** @type {GD3|null} */
    this.gd3 = null;
    /** @type {XD3|null} */
    this.xd3 = null;
    /** @type {boolean} */
    this.pal = false;
    /** @type {boolean} */
    this.packed = false;

    if (arg === undefined || arg === null) {
      // protected XGM()
      return;
    }

    if (arg instanceof Uint8Array) {
      this._initFromData(arg);
    } else {
      this._initFromVGM(arg, pack);
    }
  }

  /**
   * Mirror of public XGM(byte[] data).
   * @param {Uint8Array} data
   */
  _initFromData(data) {
    let flags;
    let offset;
    let pcmLen, fmLen, psgLen;

    if (getASCIIString(data, 0, 4).toUpperCase() !== "XGM2")
      throw new Error("Error: XGM2 file not recognized !");

    // 0004: version (0x10 currently)
    getInt8(data, 4);
    // 0005: format description (see xgm2.txt)
    flags = getInt8(data, 5);

    // bit #0: NTSC / PAL information: 0=NTSC 1=PAL
    this.pal = (flags & 1) !== 0;
    // bit #1: multi tracks file: 0=No 1=Yes (always 0 here)
    if ((flags & 2) !== 0)
      throw new Error("Cannot convert from multi tracks XGM file !");

    // bit #2: GD3 tags: 0=No 1=Yes
    if ((flags & 4) !== 0) this.gd3 = new GD3();
    // bit #3: packed FM / PSG / GD3 data blocks: 0=No 1=Yes
    this.packed = (flags & 8) !== 0;

    // 0006-0007: SLEN = Sample data bloc size / 256 (ex: $0200 means 512*256 = 131072 bytes)
    pcmLen = getInt16(data, 0x0006) * 256;
    // 0008-0009: FMLEN = FM music data block size / 256 (ex: $0040 means 64*256 = 16384 bytes)
    fmLen = getInt16(data, 0x0008) * 256;
    // 000A-000B: PSGLEN = PSG music data block size / 256 (ex: $0020 means 32*256 = 8192 bytes)
    psgLen = getInt16(data, 0x000a) * 256;

    // 000C-0103: sample id table (size = 124 entries = 248 bytes)
    for (let s = 0; s < 124 - 1; s++) {
      // get sample address
      const addr = getInt16(data, (s + 0) * 2 + 0x000c);
      // get next sample address (end address)
      const naddr = getInt16(data, (s + 1) * 2 + 0x000c);

      // does we have a sample ?
      if (addr !== 0xffff && naddr !== 0xffff)
        // add sample (id 0 is reserved for stop operation)
        this.samples.push(
          new XGMSample(s + 1, data, false, -1, 0, 0x0104 + (addr << 8), (naddr - addr) << 8)
        );
    }

    // calculate music data offset (0x0104 + sample data block size)
    offset = 0x0104 + pcmLen;

    if (this.packed) {
      // build FM command list
      this.parseFMMusic(XGCPacker.unpack(data.slice(offset, offset + fmLen), null));
      // build PSG command list
      this.parsePSGMusic(
        XGCPacker.unpack(data.slice(offset + fmLen, offset + fmLen + psgLen), null)
      );

      // FIXME: loop point is not properly restored for packed XGM (loop address has been adjusted for compressed
      // data)
      // for now we just lost the loop point
      this.setFMLoopAddress(0);
      this.setPSGLoopAddress(0);
    } else {
      // build FM command list
      this.parseFMMusic(data.slice(offset, offset + fmLen));
      // build PSG command list
      this.parsePSGMusic(data.slice(offset + fmLen, offset + fmLen + psgLen));
    }

    this.updateTimes();
    this.updateOffsets();

    // GD3 tags ?
    if (this.gd3 != null) {
      // packed enabled ?
      if (this.packed) {
        this.xd3 = new XD3(data, offset + fmLen + psgLen);
        this.gd3 = new GD3(this.xd3);
      } else {
        this.gd3 = new GD3(data, offset + fmLen + psgLen);
        this.xd3 = new XD3(this.gd3, this.getTotalTimeInFrame(), this.getLoopDurationInFrame());
      }
    }
  }

  /**
   * Mirror of public XGM(VGM vgm, boolean pack).
   * @param {import("./vgm.js").VGM} vgm
   * @param {boolean} pack
   */
  _initFromVGM(vgm, pack) {
    if (vgm.rate === 50) this.pal = true;
    else this.pal = false;

    this.gd3 = vgm.gd3;
    this.packed = pack;

    // first we extract samples from VGM
    this.extractSamples(vgm);
    // then we extract music data
    this.extractMusic(vgm);
    // XGM optimization
    this.optimizeCommands();
    // samples optimization
    this.optimizeSamples();

    // update times and offsets
    this.updateTimes();
    this.updateOffsets();

    // then update loop points offset
    this.updateLoopOffsets();

    // build XD3 after duration has been computed
    if (this.gd3 != null)
      this.xd3 = new XD3(this.gd3, this.getTotalTimeInFrame(), this.getLoopDurationInFrame());
  }

  /**
   * @param {Uint8Array|number[]} data
   */
  parseFMMusic(data) {
    // parse all XGM commands
    let off = 0;
    while (off < data.length) {
      const command = new XGMFMCommand(data, off);

      this.FMcommands.push(command);
      off += command.size;

      // stop here (need to check for it as data block is aligned on 256 bytes)
      if (command.isLoop()) break;
    }
  }

  /**
   * @param {Uint8Array|number[]} data
   */
  parsePSGMusic(data) {
    // parse all XGM commands
    let off = 0;
    while (off < data.length) {
      const command = new XGMPSGCommand(data, off);

      this.PSGcommands.push(command);
      off += command.size;

      // stop here (need to check for it as data block is aligned on 256 bytes)
      if (command.isLoop()) break;
    }
  }

  /**
   * @param {import("./vgm.js").VGM} vgm
   */
  extractSamples(vgm) {
    // extract samples
    for (const bank of vgm.sampleBanks) {
      for (const sample of bank.samples)
        // start from id 1 (0 is reserved for silent sample)
        this.samples.push(XGMSample.createFromVGMSample(this.samples.length + 1, sample));
    }
  }

  /**
   * @param {import("./vgm.js").VGM} vgm
   */
  extractMusic(vgm) {
    // need to classify by channel
    /** @type {Map<number, import("./vgm-command.js").VGMCommand>} */
    const ymKeyCommands = new Map();
    /** @type {Map<number, import("./vgm-command.js").VGMCommand[]>} */
    const ymChannelSetCommands = new Map();
    /** @type {Map<number, number>} */
    const ymFreqCommands = new Map();
    /** @type {import("./vgm-command.js").VGMCommand[]} */
    const ymMiscCommands = [];
    /** @type {import("./vgm-command.js").VGMCommand[]} */
    const psgCommands = [];
    /** @type {import("./vgm-command.js").VGMCommand[]} */
    const sampleCommands = [];
    /** @type {import("./vgm-command.js").VGMCommand[]} */
    const frameCommands = [];

    /** @type {XGMFMCommand[]} */
    const newFMCommands = [];
    /** @type {XGMPSGCommand[]} */
    const newPSGCommands = [];

    let index = 0;
    let highFreqLatch = 0;

    while (index < vgm.commands.length) {
      // prepare new commands for this frame
      newFMCommands.length = 0;
      newPSGCommands.length = 0;

      let frameToWait = 0;

      // get frame commands
      frameCommands.length = 0;
      while (index < vgm.commands.length) {
        const command = vgm.commands[index++];

        if (command.isLoopStart()) {
          newFMCommands.push(new FMLoopStartCommand());
          newPSGCommands.push(new PSGLoopStartCommand());
          continue;
        }
        // ignore data block
        if (command.isDataBlock()) continue;
        // wait command ?
        if (command.isWait()) {
          // get wait
          frameToWait += command.getWaitValue();

          // check if next commands are wait too
          while (index < vgm.commands.length) {
            const nextCom = vgm.commands[index];

            // not a wait --> stop here
            if (!nextCom.isWait()) break;

            frameToWait += nextCom.getWaitValue();
            index++;
          }

          // stop here
          break;
        }
        // stop here
        if (command.isEnd()) break;

        // add command
        frameCommands.push(command);
      }

      // group commands
      ymKeyCommands.clear();
      ymChannelSetCommands.clear();
      ymFreqCommands.clear();
      ymMiscCommands.length = 0;
      psgCommands.length = 0;
      sampleCommands.length = 0;

      for (const command of frameCommands) {
        let ch;
        let chKey;

        if (command.isStream()) sampleCommands.push(command);
        else if (command.isPSGWrite()) psgCommands.push(command);
        // YM command
        else if (command.isYM2612Write()) {
          ch = command.getYM2612Channel();
          chKey = ch;

          // we have a key event pending for this channel ? --> transfer all previous commands now
          if (ymKeyCommands.get(chKey) != null)
            pushAll(
              newFMCommands,
              XGM.compileYMCommands(ymChannelSetCommands, ymFreqCommands, ymMiscCommands, ymKeyCommands)
            );

          // frequency set command
          if (command.isYM2612FreqWrite()) {
            const reg = command.getYM2612Register();

            // FIXME: it seems that register 0xA4 and 0xAC has 2 separates latch
            // (see Java comments)

            // high byte !! having a single latch should be ok as we sort commands by channel / operator !
            if ((reg & 4) === 4) highFreqLatch = (command.getYM2612Value() & 0x3f) << 8;
            // low part, we can write it with last high part latch
            else {
              let c;

              // special mode freq set ? --> keep slot info (ch8-10)
              if ((reg & 8) !== 0) c = 8 + (reg & 3);
              else c = ch;

              ymFreqCommands.set(c, command.getYM2612Value() | highFreqLatch);
            }
          } else if (command.isYM2612KeyWrite()) ymKeyCommands.set(chKey, command);
          // general channel set command
          else if (command.isYM2612ChannelSet()) {
            let coms = ymChannelSetCommands.get(chKey);

            if (coms == null) {
              // build the list from this command
              coms = [];
              coms.push(command);
              ymChannelSetCommands.set(chKey, coms);
            }
            // simply add the command in the list
            else coms.push(command);
          }
          // YM misc command
          else ymMiscCommands.push(command);
        }
      }

      // YM commands first
      pushAll(
        newFMCommands,
        XGM.compileYMCommands(ymChannelSetCommands, ymFreqCommands, ymMiscCommands, ymKeyCommands)
      );
      // then PCM commands
      if (sampleCommands.length !== 0)
        pushAll(newFMCommands, XGMFMCommand.createPCMCommands(this, sampleCommands));
      // and finally PSG commands (need to have them separate as they can't be processed during DMA)
      if (psgCommands.length !== 0)
        pushAll(newPSGCommands, XGMPSGCommand.createPSGCommands(psgCommands));

      // last frame ?
      if (index >= vgm.commands.length) {
        // add end command (loop command internally, offset will be computed later)
        newFMCommands.push(new FMEndCommand());
        newPSGCommands.push(new PSGEndCommand());
      } else {
        while (frameToWait > 0) {
          // end frame
          newFMCommands.push(new FMFrameCommand());
          // add end frame
          newPSGCommands.push(new PSGFrameCommand());

          if (this.pal) frameToWait -= 882;
          else frameToWait -= 735;
        }
      }

      // finally add the new commands
      pushAll(this.FMcommands, newFMCommands);
      pushAll(this.PSGcommands, newPSGCommands);
    }
  }

  /**
   * @param {number} addr
   */
  setFMLoopAddress(addr) {
    // Loop is the last command
    const loopCom = this.FMcommands[this.FMcommands.length - 1];
    // set loop address
    loopCom.setLoopAddr(addr);
  }

  /**
   * @param {number} addr
   */
  setPSGLoopAddress(addr) {
    // Loop is the last command
    const loopCom = this.PSGcommands[this.PSGcommands.length - 1];
    // set loop address
    loopCom.setLoopAddr(addr);
  }

  updateLoopOffsets() {
    const fmLoopStartCom = this.getFMLoopStartCommand();
    const psgLoopStartCom = this.getPSGLoopStartCommand();

    if (fmLoopStartCom != null) this.setFMLoopAddress(fmLoopStartCom.getOriginOffset());
    if (psgLoopStartCom != null) this.setPSGLoopAddress(psgLoopStartCom.getOriginOffset());
  }

  /**
   * @returns {Map<number, XGMFMCommand[]>}
   */
  getFMCommandsPerFrame() {
    /** @type {Map<number, XGMFMCommand[]>} */
    const result = new Map();

    let c = 0;
    let frame = 0;
    while (c < this.FMcommands.length) {
      /** @type {XGMFMCommand[]} */
      const frameCommands = [];

      // not a wait command ?
      while (!this.FMcommands[c].isWait(false)) {
        // add command to frame list
        frameCommands.push(this.FMcommands[c]);

        // done ? --> stop here
        if (++c >= this.FMcommands.length) break;
      }

      const key = frame;

      if (c < this.FMcommands.length) {
        // get wait command
        const com = this.FMcommands[c];
        // add it to frame list
        frameCommands.push(com);

        // next frame
        frame += this.FMcommands[c].getWaitFrame();
        c++;
      }

      // add commands for this frame
      result.set(key, frameCommands);
    }

    return result;
  }

  /**
   * @returns {Map<number, XGMPSGCommand[]>}
   */
  getPSGCommandsPerFrame() {
    /** @type {Map<number, XGMPSGCommand[]>} */
    const result = new Map();

    let c = 0;
    let frame = 0;
    while (c < this.PSGcommands.length) {
      /** @type {XGMPSGCommand[]} */
      const frameCommands = [];

      // not a wait command ?
      while (!this.PSGcommands[c].isWait(false)) {
        // add command to frame list
        frameCommands.push(this.PSGcommands[c]);

        // done ? --> stop here
        if (++c >= this.PSGcommands.length) break;
      }

      const key = frame;

      if (c < this.PSGcommands.length) {
        // get wait command
        const com = this.PSGcommands[c];
        // add it to frame list
        frameCommands.push(com);

        // next frame
        frame += this.PSGcommands[c].getWaitFrame();
        c++;
      }

      // add commands for this frame
      result.set(key, frameCommands);
    }

    return result;
  }

  packWaitFM() {
    let c = 0;
    while (c < this.FMcommands.length) {
      // get next wait command
      while (!this.FMcommands[c].isWait(true)) {
        // done ? --> stop here
        if (++c >= this.FMcommands.length) return;
      }

      const startInd = c;
      let wait = 0;
      // get next no wait command
      while (this.FMcommands[c].isWait(true)) {
        // sum wait
        wait += this.FMcommands[c].getWaitFrame();
        // done ? --> stop here
        if (++c >= this.FMcommands.length) break;
      }

      // remove all wait commands
      while (c > startInd) this.FMcommands.splice(--c, 1);

      // add new wait commands
      const waitComs = XGMFMCommand.createWaitCommands(wait);
      this.FMcommands.splice(startInd, 0, ...waitComs);

      // next
      c += waitComs.length;
    }
  }

  packWaitPSG() {
    let c = 0;
    while (c < this.PSGcommands.length) {
      // get next wait command
      while (!this.PSGcommands[c].isWait(true)) {
        // done ? --> stop here
        if (++c >= this.PSGcommands.length) return;
      }

      const startInd = c;
      let wait = 0;
      // get next no wait command
      while (this.PSGcommands[c].isWait(true)) {
        // sum wait
        if (!this.PSGcommands[c].isDummy()) wait += this.PSGcommands[c].getWaitFrame();

        // done ? --> stop here
        if (++c >= this.PSGcommands.length) break;
      }

      // remove all wait commands
      while (c > startInd) this.PSGcommands.splice(--c, 1);

      // add new wait commands
      const waitComs = XGMPSGCommand.createWaitCommands(wait);
      this.PSGcommands.splice(startInd, 0, ...waitComs);

      // next
      c += waitComs.length;
    }
  }

  /**
   * @param {number} port
   * @param {number} ch
   * @param {XGMFMCommand[]} fmWriteCHCommands
   * @param {YM2612State} ymState
   * @returns {XGMFMCommand[]}
   */
  static optimizeSetPanning(port, ch, fmWriteCHCommands, ymState) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    for (const com of fmWriteCHCommands)
      pushAll(result, XGMFMCommand.convertToSetPanningCommands(port, ch, com, ymState));

    return result;
  }

  /**
   * @param {number} port
   * @param {number} ch
   * @param {XGMFMCommand[]} fmWriteCHCommands
   * @returns {XGMFMCommand[]}
   */
  static optimizeSetTL(port, ch, fmWriteCHCommands) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    for (const com of fmWriteCHCommands)
      pushAll(result, XGMFMCommand.convertToSetTLCommands(port, ch, com));

    return result;
  }

  /**
   * @param {number} port
   * @param {number} ch
   * @param {XGMFMCommand[]} fmWriteCHCommands
   * @param {YM2612State} ymState
   * @returns {XGMFMCommand[]}
   */
  static optimizeLoadInst(port, ch, fmWriteCHCommands, ymState) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    // load inst command is 31 bytes
    // we optimize as soon FM writes are >= 16 bytes (longer to parse and load inst command compress better)
    if (Command.getDataSize(fmWriteCHCommands) >= 16) {
      const com = XGMFMCommand.convertToLoadInstCommand(port, ch, fmWriteCHCommands, ymState);

      if (com != null) result.push(com);
    }

    return result;
  }

  /**
   * @param {XGMFMCommand[]} fmChannelCommands
   */
  removeDuplicateSetFreq(fmChannelCommands) {
    let freqSet = false;

    // only keep the last one so we start by the end
    for (let c = fmChannelCommands.length - 1; c >= 0; c--) {
      const com = fmChannelCommands[c];

      // don't optimize special mode freq set
      if (com.isYMFreqSpecialWrite() || com.isYMFreqDeltaSpecialWrite()) continue;

      if (com.isYMFreqWrite() || com.isYMFreqDeltaWrite()) {
        // already set ? --> set dummy
        if (freqSet) com.setDummy();
        else freqSet = true;
      }
    }
  }

  /**
   * @param {XGMFMCommand[]} fmChannelCommands
   */
  cleanKeyCommands(fmChannelCommands) {
    let hasKeyOn = false;
    let hasKeyOff = false;

    // start from end of frame
    for (let c = fmChannelCommands.length - 1; c >= 0; c--) {
      const com = fmChannelCommands[c];

      if (com.isYMKeyONWrite()) {
        // can't have several key-on in a single frame
        if (hasKeyOn) com.setDummy();
        else hasKeyOn = true;
      } else if (com.isYMKeyOFFWrite()) {
        // can't have more than 2 key-off in a single frame
        if (hasKeyOff) com.setDummy();
        else {
          // allow an extra key-off after a key-on
          if (hasKeyOn) hasKeyOff = true;
        }
      }
    }

    /** @type {boolean|null} */
    let keyState = null;
    // then in normal frame order
    for (const com of fmChannelCommands) {
      if (com.isYMKeyONWrite()) {
        // already on
        if (keyState != null && keyState) com.setDummy();

        keyState = true;
      } else if (com.isYMKeyOFFWrite()) {
        // already off
        if (keyState != null && !keyState) com.setDummy();

        keyState = false;
      }
    }
  }

  /**
   * @param {XGMFMCommand[]} fmChannelCommands
   */
  optimizeKeySeqCommands(fmChannelCommands) {
    /** @type {XGMFMCommand|null} */
    let lastKeyOFF = null;
    /** @type {XGMFMCommand|null} */
    let lastKeyON = null;

    for (const com of fmChannelCommands) {
      if (com.isYMKeyOFFWrite()) {
        // combine key on-off seq
        if (lastKeyON != null) {
          lastKeyON.setDummy();
          lastKeyON = null;
          com.toKeySeq(true);
        } else lastKeyOFF = com;
      } else if (com.isYMKeyONWrite()) {
        // combine key off-on seq
        if (lastKeyOFF != null) {
          lastKeyOFF.setDummy();
          lastKeyOFF = null;
          com.toKeySeq(false);
        } else lastKeyON = com;
      } else if (com.isYMSetTL() || com.isYMKeyAdvWrite() || com.isYMLoadInst() || com.isYMWrite()) {
        // can't combine
        lastKeyOFF = null;
        lastKeyON = null;
      }
    }
  }

  /**
   * @param {XGMFMCommand[]} fmChannelCommands
   */
  combineSetFreqKeyCommands(fmChannelCommands) {
    let canCombine = false;
    /** @type {XGMFMCommand|null} */
    let lastKeyOFF = null;
    /** @type {XGMFMCommand|null} */
    let lastKeyON = null;

    // safe key-on combine (start from end of frame)
    for (let c = fmChannelCommands.length - 1; c >= 0; c--) {
      const com = fmChannelCommands[c];

      // the driver does not support key on/off on setFreq special
      if (com.isYMFreqWrite() && !com.isYMFreqSpecialWrite()) {
        if (canCombine) {
          com.setYMFreqKeyON();
          lastKeyON.setDummy();
        }
        canCombine = false;
      } else if (com.isYMKeyONWrite()) {
        canCombine = true;
        lastKeyON = com;
      } else if (com.isYMKeyOFFWrite()) canCombine = false;
      else if (
        com.isYMSetTL() ||
        com.isYMKeyAdvWrite() ||
        com.isYMKeySequence() ||
        com.isYMLoadInst() ||
        com.isYMWrite()
      )
        canCombine = false;
    }

    canCombine = false;
    // safe key-off combine (start from beginning of frame)
    for (let c = 0; c < fmChannelCommands.length; c++) {
      const com = fmChannelCommands[c];

      // the driver does not support key on/off on setFreq special
      if (com.isYMFreqWrite() && !com.isYMFreqSpecialWrite()) {
        if (canCombine) {
          com.setYMFreqKeyOFF();
          lastKeyOFF.setDummy();
        }
        canCombine = false;
      } else if (com.isYMKeyOFFWrite()) {
        canCombine = true;
        lastKeyOFF = com;
      } else if (com.isYMKeyONWrite()) canCombine = false;
      else if (
        com.isYMSetTL() ||
        com.isYMKeyAdvWrite() ||
        com.isYMKeySequence() ||
        com.isYMLoadInst() ||
        com.isYMWrite()
      )
        canCombine = false;
    }

    let hasKeyOn = false;
    let canCombineOFF = false;
    let canCombineON = false;
    /** @type {XGMFMCommand|null} */
    let setFreq = null;

    // isolated key-off/on sequence combine
    for (const com of fmChannelCommands) {
      if (com.isYMKeyOFFWrite()) {
        // combine key off only if we don't have a keyOn before
        if (!hasKeyOn) {
          canCombineOFF = true;
          lastKeyOFF = com;
        }
      } else if (com.isYMKeyONWrite()) {
        canCombineON = true;
        hasKeyOn = true;
        lastKeyON = com;
      } else if (
        com.isYMSetTL() ||
        com.isYMKeyAdvWrite() ||
        com.isYMKeySequence() ||
        com.isYMLoadInst() ||
        com.isYMWrite()
      ) {
        // meet a set freq command ? --> combine now
        if (setFreq != null) {
          if (canCombineOFF) {
            setFreq.setYMFreqKeyOFF();
            lastKeyOFF.setDummy();
          }
          if (canCombineON) {
            setFreq.setYMFreqKeyON();
            lastKeyON.setDummy();
          }
        }

        // done
        canCombineOFF = false;
        canCombineON = false;
        setFreq = null;
        hasKeyOn = false;
      }
      // the driver does not support key on/off on setFreq special
      else if (com.isYMFreqWrite() && !com.isYMFreqSpecialWrite()) {
        setFreq = com;
        if (com.isYMFreqWithKeyON()) hasKeyOn = true;
      }
    }

    // last set Freq to combine ?
    if (setFreq != null) {
      if (canCombineOFF) {
        setFreq.setYMFreqKeyOFF();
        lastKeyOFF.setDummy();
      }
      if (canCombineON) {
        setFreq.setYMFreqKeyON();
        lastKeyON.setDummy();
      }
    }
  }

  /**
   * @param {XGMFMCommand[]} fmChannelCommands
   */
  packFMFreqCommands(fmChannelCommands) {
    const lastFreq = [-1, -1, -1, -1];

    for (const com of fmChannelCommands) {
      // reset state
      if (com.isLoopStart()) lastFreq.fill(-1);
      else if (com.isYMFreqWrite()) {
        const freq = com.getYMFreqValue();
        const slot = com.isYMFreqSpecialWrite() ? com.getYMSlot() : 0;

        // cannot pack set Freq with key event
        if (lastFreq[slot] !== -1 && !com.isYMFreqWithKeyWrite()) {
          // compute delta
          const delta = freq - lastFreq[slot];

          if (delta === 0) {
            // this can happen when we removed duplicate set freq --> set dummy
            com.setDummy();
          } else if (Math.abs(delta) <= 128) com.toFreqDelta(delta);
        }

        lastFreq[slot] = freq;
      }
    }
  }

  /**
   * @param {XGMFMCommand[]} fmChannelCommands
   */
  convertFMTLCommands(fmChannelCommands) {
    const lastTL = [-1, -1, -1, -1];

    for (const com of fmChannelCommands) {
      // reset state
      if (com.isLoopStart()) lastTL.fill(-1);
      else if (com.isYMLoadInst()) {
        // set TL state from load_inst command
        for (let s = 0; s < 4; s++) lastTL[s] = com.data[1 + 4 + s] & 0x7f;
      } else if (com.isYMSetTL()) {
        const tl = com.getYMTLValue();
        const slot = com.getYMSlot();

        if (lastTL[slot] !== -1) {
          // compute delta
          const delta = tl - lastTL[slot];

          if (delta === 0) {
            com.setDummy();
          } else if (Math.abs(delta) <= 64) com.toTLDelta(delta);
        }

        lastTL[slot] = tl;
      }
    }
  }

  /**
   * @param {XGMFMCommand[]} fmFrameCommands
   * @returns {number}
   */
  useExtWaitFMCommand(fmFrameCommands) {
    // no need to process
    if (fmFrameCommands.length <= 1) return -1;

    const waitCom = fmFrameCommands[fmFrameCommands.length - 1];

    // we should have the wait command in last position otherwise we may have reached the end of the track ! (loop
    // command)
    if (!waitCom.isWait(false)) return -1;
    // don't convert if we have a multi frame wait
    if (waitCom.getWaitFrame() > 1) return -1;

    const hasKeyCh = new Array(6).fill(false);

    // start from last command before wait
    for (let c = fmFrameCommands.length - 2; c >= 0; c--) {
      const com = fmFrameCommands[c];

      // can add wait and no key com found for this channel ?
      if (com.supportWait() && !hasKeyCh[com.getChannel()]) {
        // add it
        com.addWait();
        // make wait command dummy
        waitCom.setDummy();
        // return index of current command
        return c;
      }
      // better to not swap command order then...
      else if (com.isYMKeyWrite()) hasKeyCh[com.getChannel()] = true;
    }

    return -1;
  }

  optimizeFMCommands() {
    // 1. replace FM write by load instrument com
    // 2. replace FM write by set TL com
    // 3. replace FM write by panning com
    // 4. remove duplicate set ch freq in a single frame (keep last one)
    // 5. cleanup duplicate Key OFF/ON (start from end of frame)
    // 6. combine key ON/OFF with set FREQ com
    // 7. replace set FREQ with set FREQ low com when possible
    // 8. last pack key commands:
    // OFF followed by ON in same frame without FM write in between --> ON
    // ON followed by OFF in same frame without FM write in between --> OFF
    // 9. pack wait (should be last)

    /** @type {XGMFMCommand[]} */
    const newCommands = [];
    const ymState = new YM2612State();

    let commandsPerFrame = this.getFMCommandsPerFrame();
    let frames = Array.from(commandsPerFrame.keys());
    // sort frames
    frames.sort((a, b) => a - b);

    // do frame optimization
    for (const frame of frames) {
      // get commands for this frame
      const frameCommands = commandsPerFrame.get(frame);

      for (let channel = 0; channel < 6; channel++) {
        const port = channel >= 3 ? 1 : 0;
        const ch = channel >= 3 ? channel - 3 : channel;

        // get commands for current channel
        const fmChannelCommands = XGMFMCommand.filterChannel(frameCommands, channel, false, false);

        let startInd = 0;
        while (startInd < fmChannelCommands.length) {
          // need to split on key command as envelop settings are updated on key on/off event
          let endInd = XGMFMCommand.findNextYMKeyCommand(fmChannelCommands, startInd);

          // get YMWrite commands for current channel
          const fmWriteChannelCommands = XGMFMCommand.filterYMWrite(fmChannelCommands, startInd, endInd);

          // FM write commands optimization
          if (fmWriteChannelCommands.length !== 0) {
            // clear
            newCommands.length = 0;

            // convert to load inst command
            pushAll(newCommands, XGM.optimizeLoadInst(port, ch, fmWriteChannelCommands, ymState));
            // convert to set TL
            pushAll(newCommands, XGM.optimizeSetTL(port, ch, fmWriteChannelCommands));
            // convert to set panning
            pushAll(newCommands, XGM.optimizeSetPanning(port, ch, fmWriteChannelCommands, ymState));

            // update YM state from remaining commands
            ymState.updateState(fmWriteChannelCommands);

            if (newCommands.length !== 0) {
              let idx;

              // get index of first command
              idx = this.FMcommands.indexOf(fmWriteChannelCommands[0]);
              // insert new commands here
              this.FMcommands.splice(idx, 0, ...newCommands);

              // get index of first command
              idx = fmChannelCommands.indexOf(fmWriteChannelCommands[0]);
              // insert new commands here
              fmChannelCommands.splice(idx, 0, ...newCommands);
              // need to adjust end index
              endInd += newCommands.length;

              // update state from new commands
              ymState.updateState(newCommands);
            }
          }

          startInd = endInd + 1;
        }

        // FM commands optimization
        if (fmChannelCommands.length !== 0) {
          // remove duplicate set freq
          this.removeDuplicateSetFreq(fmChannelCommands);
          // cleanup key commands
          this.cleanKeyCommands(fmChannelCommands);
          // combine key / set freq commands
          this.combineSetFreqKeyCommands(fmChannelCommands);
          // optimize key sequence commands
          this.optimizeKeySeqCommands(fmChannelCommands);
        }
      }
    }

    // need to update time before processing global optimizations
    this.updateTimes();

    // do global optimizations
    for (let channel = 0; channel < 6; channel++) {
      // get commands for current channel (with wait commands as well)
      const fmChannelCommands = XGMFMCommand.filterChannel(this.FMcommands, channel, false, true);

      // pack FREQ to FREQ DELTA when possible
      this.packFMFreqCommands(fmChannelCommands);
      // convert set TL to delta TL when possible
      this.convertFMTLCommands(fmChannelCommands);
    }

    this.packWaitFM();

    // update commands per frame
    commandsPerFrame = this.getFMCommandsPerFrame();
    frames = Array.from(commandsPerFrame.keys());
    // sort frames
    frames.sort((a, b) => a - b);

    // do last frame optimization
    for (const frame of frames) {
      // get commands for this frame
      const frameCommands = commandsPerFrame.get(frame);

      // convert to ext wait commands when possible
      const indOpt = this.useExtWaitFMCommand(frameCommands);

      // optimized command is not the last frame command ?
      if (indOpt !== -1 && indOpt !== frameCommands.length - 2) {
        const comOpt = frameCommands[indOpt];
        const ind1 = this.FMcommands.indexOf(comOpt);
        const ind2 = this.FMcommands.indexOf(frameCommands[frameCommands.length - 2]);

        // move to last command (don't swap)
        this.FMcommands.splice(ind2 + 1, 0, comOpt);
        this.FMcommands.splice(ind1, 1);
      }
    }

    // rebuild final / cleaned list
    this.rebuildFMCommands();
  }

  rebuildFMCommands() {
    /** @type {XGMFMCommand[]} */
    const newCommands = [];

    // rebuild final / cleaned list
    let frameSize = 0;
    for (const com of this.FMcommands) {
      if (!com.isDummy()) {
        // above max frame size (take 1 extra byte for frame delay marker) ?
        if (frameSize + com.size > XGCPacker.FRAME_MAX_SIZE - 1) {
          console.log("Warning: maximum frame size exceeded (FM frame #" + com.getFrame(this.pal) + ")");

          // insert frame delay command (0xF0)
          newCommands.push(new FMFrameDelayCommand());
          // reset frame size
          frameSize = 0;
        } else if (com.isWait(false))
          // reset frame size
          frameSize = 0;
        else
          // increment frame size
          frameSize += com.size;

        // add command
        newCommands.push(com);
      }
    }

    this.FMcommands.length = 0;
    pushAll(this.FMcommands, newCommands);

    this.updateOffsets();
    this.updateTimes();
  }

  rebuildPSGCommands() {
    /** @type {XGMPSGCommand[]} */
    const newCommands = [];

    let frameSize = 0;
    for (const com of this.PSGcommands) {
      if (!com.isDummy()) {
        // above max frame size (take 1 extra byte for frame delay marker) ?
        if (frameSize + com.size > XGCPacker.FRAME_MAX_SIZE - 1) {
          console.log("Warning: maximum frame size exceeded (PSG frame #" + com.getFrame(this.pal) + ")");

          // insert frame delay command (0xF0)
          newCommands.push(new PSGFrameCommand());
          // reset frame size
          frameSize = 0;
        } else if (com.isWait(false))
          // reset frame size
          frameSize = 0;
        else
          // increment frame size
          frameSize += com.size;

        // add command
        newCommands.push(com);
      }
    }

    this.PSGcommands.length = 0;
    pushAll(this.PSGcommands, newCommands);

    this.updateOffsets();
    this.updateTimes();
  }

  /**
   * @param {XGMPSGCommand[]} psgFrameChannelCommands
   */
  removeDuplicatedFreqEnv(psgFrameChannelCommands) {
    // start from last command
    let freqLowSet = false;
    let freqSet = false;
    let envSet = false;
    for (let c = psgFrameChannelCommands.length - 1; c >= 0; c--) {
      const com = psgFrameChannelCommands[c];

      if (com.isEnv()) {
        // ENV is already set in the frame --> set dummy
        if (envSet) com.setDummy();
        else envSet = true;
      } else if (com.isFreq()) {
        // FREQ is already set in the frame --> set dummy
        if (freqSet) com.setDummy();
        else freqSet = true;
      } else if (com.isFreqLow()) {
        // FREQ is already set in the frame --> set dummy
        if (freqLowSet || freqSet) com.setDummy();
        else freqLowSet = true;
      }
    }
  }

  /**
   * @param {XGMPSGCommand[]} psgFrameCommands
   * @returns {number}
   */
  useExtWaitPSGCommand(psgFrameCommands) {
    // no need to process
    if (psgFrameCommands.length < 2) return -1;

    const waitCom = psgFrameCommands[psgFrameCommands.length - 1];

    // we should have the wait command in last position otherwise we may have reached the end of the track ! (loop
    // command)
    if (!waitCom.isWait(false)) return -1;
    // don't convert if we have a multi frame wait
    if (waitCom.getWaitFrame() > 1) return -1;

    // start from last command before wait
    for (let c = psgFrameCommands.length - 2; c >= 0; c--) {
      const com = psgFrameCommands[c];

      // can add wait ?
      if (com.supportWait()) {
        // add it
        com.addWait();
        // make wait command dummy
        waitCom.setDummy();
        // return index of current command
        return c;
      }
    }

    return -1;
  }

  /**
   * @param {XGMPSGCommand[]} psgChannelCommands
   */
  removeSilentPSGFreqCommands(psgChannelCommands) {
    let silent = false;
    /** @type {XGMPSGCommand|null} */
    let lastDummyFreqCom = null;
    /** @type {XGMPSGCommand|null} */
    let lastDummyFreqLowCom = null;
    let lastFreq = 0;

    for (const com of psgChannelCommands) {
      if (com.isDummy()) continue;

      // loop start ? --> reset state
      if (com.isLoopStart()) {
        silent = false;
        lastDummyFreqCom = null;
        lastDummyFreqLowCom = null;
      } else if (com.isEnv()) {
        // changed to silent ?
        if (com.getEnv() === 0xf) {
          silent = true;
          // reset it
          lastDummyFreqCom = null;
          lastDummyFreqLowCom = null;
        } else {
          // changed from silent to audible ?
          if (silent) {
            // restore last remove setFreq command
            if (lastDummyFreqCom != null) {
              lastDummyFreqCom.clearDummy();
              lastDummyFreqCom.setFreq(lastFreq);
            } else if (lastDummyFreqLowCom != null) {
              lastDummyFreqLowCom.clearDummy();
              lastDummyFreqLowCom.setFreqLow(lastFreq & 0xf);
            }

            silent = false;
          }
        }
      } else if (com.isFreq()) {
        // channel is currently silent ? --> set dummy
        if (silent) {
          lastFreq = com.getFreq();
          com.setDummy();
          // store last removed setFreq com
          lastDummyFreqCom = com;
        }
      } else if (com.isFreqLow()) {
        // channel is currently silent ? --> set dummy
        if (silent) {
          lastFreq = (lastFreq & 0x3f0) | com.getFreqLow();
          com.setDummy();
          // store last removed setFreq com
          lastDummyFreqLowCom = com;
        }
      }
    }
  }

  /**
   * @param {XGMPSGCommand[]} psgChannelCommands
   */
  packPSGFreqCommands(psgChannelCommands) {
    let lastFreq = -1;
    for (const com of psgChannelCommands) {
      if (com.isDummy()) continue;

      // loop start ? --> reset state
      if (com.isLoopStart()) lastFreq = -1;
      else if (com.isFreq()) {
        const freq = com.getFreq();

        if (lastFreq !== -1) {
          // compute delta
          const delta = freq - lastFreq;

          // can happen with the 'removeSilentPSGFreqCommands' optimization pass
          if (delta === 0) com.setDummy();
          else if (Math.abs(delta) <= 4) com.toFreqDelta(delta);
          // only low part changed ? --> change to freq low (same size but faster processing and potentially
          // compress better)
          else if ((lastFreq & 0xff0) === (freq & 0xff0)) com.toFreqLow(freq & 0xf);
        }

        lastFreq = freq;
      } else if (com.isFreqLow()) {
        if (lastFreq !== -1) {
          // new freq
          const freq = (lastFreq & 0xff0) | com.getFreqLow();
          // compute delta
          const delta = freq - lastFreq;

          // can happen with the 'removeSilentPSGFreqCommands' optimization pass
          if (delta === 0) com.setDummy();
          else if (Math.abs(delta) <= 4) com.toFreqDelta(delta);

          lastFreq = freq;
        }
      }
    }
  }

  /**
   * @param {XGMPSGCommand[]} psgChannelCommands
   */
  convertPSGEnvCommands(psgChannelCommands) {
    let lastEnv = -1;

    for (const com of psgChannelCommands) {
      if (com.isDummy()) continue;

      // loop start ? --> reset state
      if (com.isLoopStart()) lastEnv = -1;
      else if (com.isEnv()) {
        const env = com.getEnv();

        if (lastEnv !== -1) {
          // compute delta
          const delta = env - lastEnv;

          if (delta === 0) {
            com.setDummy();
          } else if (Math.abs(delta) <= 4) com.toEnvDelta(delta);
        }

        lastEnv = env;
      }
    }
  }

  optimizePSGCommands() {
    // NEW: add this for better optimization
    // 1. remove duplicate set FREQ and set ENV commands per frame / channel
    // 2. remove all FREQ commands when ENV keep silent
    // 3. replace FREQ by FREQ_LOW when possible
    // 5. pack wait
    // 4. replace ENV/FREQ/FREQ_LOW with .WAIT extension when possible

    let commandsPerFrame = this.getPSGCommandsPerFrame();
    let frames = Array.from(commandsPerFrame.keys());
    // sort frames
    frames.sort((a, b) => a - b);

    // do frame optimization
    for (const frame of frames) {
      // get commands for this frame
      const frameCommands = commandsPerFrame.get(frame);

      for (let channel = 0; channel < 4; channel++) {
        // get commands for current channel (with wait commands as well)
        const psgFrameChannelCommands = XGMPSGCommand.filterChannel(frameCommands, channel, false, false);

        // remove duplicate
        this.removeDuplicatedFreqEnv(psgFrameChannelCommands);
      }
    }

    // do global optimizations
    for (let channel = 0; channel < 4; channel++) {
      // get commands for current channel (with wait commands as well)
      const psgChannelCommands = XGMPSGCommand.filterChannel(this.PSGcommands, channel, true, true);

      // remove inaudible set FREQ command (only for channel 0-1)
      if (channel < 2) this.removeSilentPSGFreqCommands(psgChannelCommands);
      // pack FREQ to FREQ DELTA / LOW when possible
      this.packPSGFreqCommands(psgChannelCommands);
      // convert ENV to ENV DELTA when possible
      this.convertPSGEnvCommands(psgChannelCommands);
    }

    // build cleaned list (needed for proper wait packing)
    /** @type {XGMPSGCommand[]} */
    const newCommands = [];
    for (const com of this.PSGcommands) {
      if (!com.isDummy()) newCommands.push(com);
    }

    this.PSGcommands.length = 0;
    pushAll(this.PSGcommands, newCommands);

    // pack wait
    this.packWaitPSG();

    // update commands per frame
    commandsPerFrame = this.getPSGCommandsPerFrame();
    frames = Array.from(commandsPerFrame.keys());
    // sort frames
    frames.sort((a, b) => a - b);

    // do last frame optimization
    for (const frame of frames) {
      // get commands for this frame
      const frameCommands = commandsPerFrame.get(frame);

      // convert to ext wait commands when possible
      const indOpt = this.useExtWaitPSGCommand(frameCommands);

      // optimized command is not the last frame command ?
      if (indOpt !== -1 && indOpt !== frameCommands.length - 2) {
        // swap with last command
        const ind1 = this.PSGcommands.indexOf(frameCommands[indOpt]);
        const ind2 = this.PSGcommands.indexOf(frameCommands[frameCommands.length - 2]);
        const tmp = this.PSGcommands[ind1];
        this.PSGcommands[ind1] = this.PSGcommands[ind2];
        this.PSGcommands[ind2] = tmp;
      }
    }

    // rebuild final / cleaned list
    this.rebuildPSGCommands();
  }

  optimizeCommands() {
    this.optimizeFMCommands();
    this.optimizePSGCommands();
  }

  optimizeSamples() {
    const numSample = this.samples.length;

    // start from end as we delete merged samples
    for (let s = this.samples.length - 1; s >= 0; s--) this.mergeSample(s);

    // reset sample ids
    for (let s = 0; s < this.samples.length; s++) {
      const sample = this.samples[s];
      this.updateSampleCommands(sample.id, s + 1, -1);
      sample.id = s + 1;
    }

    // maximum number of sample reached ?
    if (this.samples.length >= 124 - 1) {
      console.error("Warning: XGM cannot have more than 123 samples, some samples will be lost !");

      // remove extra samples
      while (this.samples.length > 123) this.samples.splice(this.samples.length - 1, 1);

      return;
    }

    this.rebuildFMCommands();

    if (this.samples.length !== numSample)
      console.log("Merged " + (numSample - this.samples.length) + " sample(s)");
  }

  /**
   * @param {XGMSample} sample
   * @returns {XGMSample|null}
   */
  findMatchingSample(sample) {
    /** @type {XGMSample|null} */
    let bestMatch = null;
    let bestScore = 0;

    for (const s of this.samples) {
      if (s !== sample) {
        const score = s.getSimilarityScore(sample);
        if (score > bestScore) {
          bestMatch = s;
          bestScore = score;
        }
      }
    }

    // accept only if score >= 1
    if (bestScore >= 1) return bestMatch;

    return null;
  }

  /**
   * @param {number} sampleIndex
   */
  mergeSample(sampleIndex) {
    const sample = this.samples[sampleIndex];
    // find if already exist
    const matchingSample = this.findMatchingSample(sample);

    // we found a duplicate ?
    if (matchingSample != null) {
      const sameDuration =
        Math.round(sample.getLength() / 60) === Math.round(matchingSample.getLength() / 60);
      // update VGM so it now uses the matching sample id
      this.updateSampleCommands(
        sample.id,
        matchingSample.id,
        sameDuration ? -1 : Math.trunc((sample.getLength() * 44100) / XGMSample.XGM_FULL_RATE)
      );
      // remove duplicate from samples
      this.samples.splice(sampleIndex, 1);

      console.log("Found duplicated sample #" + sample.id + " (merged with #" + matchingSample.id + ")");
    }
  }

  /**
   * @param {Map<number, import("./vgm-command.js").VGMCommand[]>} ymChannelSetCommands
   * @param {Map<number, number>} ymFreqCommands
   * @param {import("./vgm-command.js").VGMCommand[]} ymMiscCommands
   * @param {Map<number, import("./vgm-command.js").VGMCommand>} ymKeyCommands
   * @returns {XGMFMCommand[]}
   */
  static compileYMCommands(ymChannelSetCommands, ymFreqCommands, ymMiscCommands, ymKeyCommands) {
    /** @type {XGMFMCommand[]} */
    const result = [];

    // channel set YM commands first (sorted by channel)
    for (const entry of ymChannelSetCommands.entries())
      pushAll(result, XGMFMCommand.createYMCHCommands(entry[1], entry[0]));
    // then frequency YM command (sorted by channel)
    for (const entry of ymFreqCommands.entries()) {
      const ch = entry[0];
      result.push(XGMFMCommand.createYMFreqCommand(ch & 7, (ch & 8) !== 0, entry[1], false, false));
    }
    // then YM misc commands
    if (ymMiscCommands.length !== 0) pushAll(result, XGMFMCommand.createYMMiscCommands(ymMiscCommands));
    // then key commands
    pushAll(result, XGMFMCommand.createYMKeyCommands(Array.from(ymKeyCommands.values())));

    // done
    ymChannelSetCommands.clear();
    ymFreqCommands.clear();
    ymMiscCommands.length = 0;
    ymKeyCommands.clear();

    return result;
  }

  /**
   * Find the FM LOOP Start command index
   * @returns {number}
   */
  getFMLoopStartCommandIndex() {
    for (let i = 0; i < this.FMcommands.length; i++)
      if (this.FMcommands[i].isLoopStart()) return i;

    return -1;
  }

  /**
   * Find the FM LOOP Start command
   * @returns {XGMFMCommand|null}
   */
  getFMLoopStartCommand() {
    const index = this.getFMLoopStartCommandIndex();

    if (index !== -1) return this.FMcommands[index];

    return null;
  }

  /**
   * Find the FM LOOP command
   * @returns {XGMFMCommand|null}
   */
  getFMLoopCommand() {
    for (const command of this.FMcommands) if (command.isLoop()) return command;

    return null;
  }

  /**
   * Find the PSG LOOP Start command index
   * @returns {number}
   */
  getPSGLoopStartCommandIndex() {
    for (let i = 0; i < this.PSGcommands.length; i++)
      if (this.PSGcommands[i].isLoopStart()) return i;

    return -1;
  }

  /**
   * Find the PSG LOOP Start command
   * @returns {XGMPSGCommand|null}
   */
  getPSGLoopStartCommand() {
    const index = this.getPSGLoopStartCommandIndex();

    if (index !== -1) return this.PSGcommands[index];

    return null;
  }

  /**
   * Find the PSG LOOP command
   * @returns {XGMPSGCommand|null}
   */
  getPSGLoopCommand() {
    for (const command of this.PSGcommands) if (command.isLoop()) return command;

    return null;
  }

  /**
   * Update time information for all command
   */
  updateTimes() {
    let time;

    time = 0;
    for (const com of this.FMcommands) {
      com.time = time;

      if (this.pal) time += com.getWaitFrame() * 882;
      else time += com.getWaitFrame() * 735;
    }
    time = 0;
    for (const com of this.PSGcommands) {
      com.time = time;

      if (this.pal) time += com.getWaitFrame() * 882;
      else time += com.getWaitFrame() * 735;
    }
  }

  /**
   * Update origin offset information for all command
   */
  updateOffsets() {
    Command.computeOffsets(this.FMcommands, 0);
    Command.computeOffsets(this.PSGcommands, 0);
  }

  /**
   * @returns {number}
   */
  getTotalTime() {
    const size = this.FMcommands.length;
    if (size === 0) return 0;

    return this.FMcommands[size - 1].time;
  }

  /**
   * @returns {number}
   */
  getTotalTimeInFrame() {
    return Math.trunc(this.getTotalTime() / (this.pal ? 882 : 735));
  }

  /**
   * @returns {number}
   */
  getTotalTimeInSecond() {
    return Math.trunc(this.getTotalTimeInFrame() / (this.pal ? 50 : 60));
  }

  /**
   * @param {import("./vgm-command.js").VGMCommand} from
   * @returns {number}
   */
  getTimeFrom(from) {
    return this.getTotalTime() - from.time;
  }

  /**
   * @returns {number}
   */
  getLoopDurationInSecond() {
    return Math.trunc(this.getLoopDurationInFrame() / (this.pal ? 50 : 60));
  }

  /**
   * @returns {number}
   */
  getLoopDurationInFrame() {
    const loopStartCom = this.getFMLoopStartCommand();
    return loopStartCom != null
      ? Math.trunc((this.getTotalTime() - loopStartCom.time) / (this.pal ? 882 : 735))
      : 0;
  }

  /**
   * Return elapsed time when specified command happen
   * @param {number} time
   * @returns {number}
   */
  getFMCommandIndexAtTime(time) {
    return Command.getCommandIndexAtTime(this.FMcommands, time);
  }

  /**
   * @param {number} offset
   * @returns {number}
   */
  getFMCommandIndexAtOffset(offset) {
    return Command.getCommandIndexAtOffset(this.FMcommands, offset);
  }

  /**
   * @param {number} offset
   * @returns {XGMFMCommand}
   */
  getFMCommandAtOffset(offset) {
    return /** @type {XGMFMCommand} */ (Command.getCommandAtOffset(this.FMcommands, offset));
  }

  /**
   * Return elapsed time when specified command happen
   * @param {number} time
   * @returns {XGMFMCommand}
   */
  getFMCommandAtTime(time) {
    return /** @type {XGMFMCommand} */ (Command.getCommandAtTime(this.FMcommands, time));
  }

  /**
   * @param {number} id
   * @returns {XGMSample|null}
   */
  getSample(id) {
    for (const sample of this.samples) if (sample.id === id) return sample;

    return null;
  }

  /**
   * @param {number} id
   * @returns {number}
   */
  getSampleLen(id) {
    const sample = this.getSample(id);
    if (sample != null) return sample.getLength();

    return 0;
  }

  /**
   * @param {number} id
   * @returns {XGMSample|null}
   */
  getSampleByOriginId(id) {
    for (const sample of this.samples) if (sample.originId === id) return sample;

    return null;
  }

  /**
   * @param {number} addr
   * @returns {XGMSample|null}
   */
  getSampleByOriginAddress(addr) {
    for (const sample of this.samples) if (sample.originAddr === addr) return sample;

    return null;
  }

  /**
   * @param {boolean} beforeLoop
   * @returns {number[]}
   */
  getLoopSplittedFMMusicFrameOffsets(beforeLoop) {
    /** @type {number[]} */
    const result = [];
    const loopStartComIndex = this.getFMLoopStartCommandIndex();
    const loopInd = loopStartComIndex === -1 ? this.FMcommands.length : loopStartComIndex;

    if (beforeLoop) {
      for (let i = 0; i < loopInd; i++) {
        const command = this.FMcommands[i];

        if (command.isWait(false) || command.isLoop() || command.isFrameDelay())
          result.push(command.getOriginOffset() + command.size);
      }
    } else {
      const baseOffset = loopStartComIndex !== -1 ? this.FMcommands[loopStartComIndex].getOriginOffset() : 0;

      for (let i = loopInd; i < this.FMcommands.length; i++) {
        const command = this.FMcommands[i];

        if (command.isWait(false) || command.isLoop() || command.isFrameDelay())
          result.push(command.getOriginOffset() + command.size - baseOffset);
      }
    }

    return result;
  }

  /**
   * @param {boolean} beforeLoop
   * @returns {number[]}
   */
  getLoopSplittedPSGMusicFrameOffsets(beforeLoop) {
    /** @type {number[]} */
    const result = [];
    const loopStartComIndex = this.getPSGLoopStartCommandIndex();
    const loopInd = loopStartComIndex === -1 ? this.PSGcommands.length : loopStartComIndex;

    if (beforeLoop) {
      for (let i = 0; i < loopInd; i++) {
        const command = this.PSGcommands[i];

        if (command.isWait(false) || command.isLoop())
          result.push(command.getOriginOffset() + command.size);
      }
    } else {
      const baseOffset = loopStartComIndex !== -1 ? this.PSGcommands[loopStartComIndex].getOriginOffset() : 0;

      for (let i = loopInd; i < this.PSGcommands.length; i++) {
        const command = this.PSGcommands[i];

        if (command.isWait(false) || command.isLoop())
          result.push(command.getOriginOffset() + command.size - baseOffset);
      }
    }

    return result;
  }

  /**
   * @returns {number[]}
   */
  getFMMusicFrameOffsets() {
    /** @type {number[]} */
    const result = [];

    for (const command of this.FMcommands) {
      if (command.isWait(false) || command.isLoop())
        result.push(command.getOriginOffset() + command.size);
    }

    return result;
  }

  /**
   * @returns {number[]}
   */
  getPSGMusicFrameOffsets() {
    /** @type {number[]} */
    const result = [];

    for (const command of this.PSGcommands) {
      if (command.isWait(false) || command.isLoop())
        result.push(command.getOriginOffset() + command.size);
    }

    return result;
  }

  /**
   * @param {boolean} [beforeLoop] when omitted, returns the full FM music data array.
   * @returns {Uint8Array}
   */
  getFMMusicDataArray(beforeLoop) {
    if (beforeLoop === undefined) {
      /** @type {number[]} */
      const result = [];

      for (const command of this.FMcommands) writeBytes(result, command.data);

      return Uint8Array.from(result);
    }

    const loopStartComIndex = this.getFMLoopStartCommandIndex();
    const loopInd = loopStartComIndex === -1 ? this.FMcommands.length : loopStartComIndex;
    /** @type {number[]} */
    const result = [];
    let ind;

    if (beforeLoop) {
      ind = 0;
      // build data array for no looping sequence
      while (ind < loopInd) writeBytes(result, this.FMcommands[ind++].data);
    } else {
      ind = loopInd;
      // build data array for looping sequence
      while (ind < this.FMcommands.length) writeBytes(result, this.FMcommands[ind++].data);
    }

    return Uint8Array.from(result);
  }

  /**
   * @param {boolean} [beforeLoop] when omitted, returns the full PSG music data array.
   * @returns {Uint8Array}
   */
  getPSGMusicDataArray(beforeLoop) {
    if (beforeLoop === undefined) {
      /** @type {number[]} */
      const result = [];

      for (const command of this.PSGcommands) writeBytes(result, command.data);

      return Uint8Array.from(result);
    }

    const loopStartComIndex = this.getPSGLoopStartCommandIndex();
    const loopInd = loopStartComIndex === -1 ? this.PSGcommands.length : loopStartComIndex;
    /** @type {number[]} */
    const result = [];
    let ind;

    if (beforeLoop) {
      ind = 0;
      // build data array for no looping sequence
      while (ind < loopInd) writeBytes(result, this.PSGcommands[ind++].data);
    } else {
      ind = loopInd;
      // build data array for looping sequence
      while (ind < this.PSGcommands.length) writeBytes(result, this.PSGcommands[ind++].data);
    }

    return Uint8Array.from(result);
  }

  /**
   * @returns {Uint8Array}
   */
  getPackedFMMusicDataArray() {
    // we need to split data block on start loop position
    // so we can properly restore loop offset after packing operation
    /** @type {number[]} */
    const result = [];

    // pack first part of data
    writeBytes(
      result,
      XGCPacker.pack(this.getFMMusicDataArray(true), this.getLoopSplittedFMMusicFrameOffsets(true), 0)
    );
    // do we have a loop section --> set loop offset
    if (this.getFMLoopStartCommandIndex() !== -1) this.setFMLoopAddress(result.length);
    // -1 = no loop
    else this.setFMLoopAddress(-1);
    // pack second part of data
    writeBytes(
      result,
      XGCPacker.pack(
        this.getFMMusicDataArray(false),
        this.getLoopSplittedFMMusicFrameOffsets(false),
        result.length
      )
    );

    return Uint8Array.from(result);
  }

  /**
   * @returns {Uint8Array}
   */
  getPackedPSGMusicDataArray() {
    // we need to split data block on start loop position
    // so we can properly restore loop offset after packing operation
    /** @type {number[]} */
    const result = [];

    // pack first part of data
    writeBytes(
      result,
      XGCPacker.pack(this.getPSGMusicDataArray(true), this.getLoopSplittedPSGMusicFrameOffsets(true), 0)
    );
    // do we have a loop section --> set loop offset
    if (this.getPSGLoopStartCommandIndex() !== -1) this.setPSGLoopAddress(result.length);
    // -1 = no loop
    else this.setPSGLoopAddress(-1);
    // pack second part of data
    writeBytes(
      result,
      XGCPacker.pack(
        this.getPSGMusicDataArray(false),
        this.getLoopSplittedPSGMusicFrameOffsets(false),
        result.length
      )
    );

    return Uint8Array.from(result);
  }

  /**
   * @returns {number}
   */
  getTotalMusicDataSize() {
    return this.getFMMusicDataSize() + this.getPSGMusicDataSize();
  }

  /**
   * @returns {number}
   */
  getFMMusicDataSize() {
    let result = 0;

    for (const command of this.FMcommands) result += command.size;

    return result;
  }

  /**
   * @returns {number}
   */
  getPSGMusicDataSize() {
    let result = 0;

    for (const command of this.PSGcommands) result += command.size;

    return result;
  }

  /**
   * @returns {number}
   */
  getPackedFMMusicDataSize() {
    return this.getPackedFMMusicDataArray().length;
  }

  /**
   * @returns {number}
   */
  getPackedPSGMusicDataSize() {
    return this.getPackedPSGMusicDataArray().length;
  }

  /**
   * @returns {Uint8Array}
   */
  getPCMDataArray() {
    /** @type {number[]} */
    const result = [];

    for (let s = 0; s < this.samples.length; s++) {
      const copy = Uint8Array.from(this.samples[s].data);

      // sign the sample
      for (let i = 0; i < copy.length; i++) copy[i] = (copy[i] + 0x80) & 0xff;

      writeBytes(result, copy);
    }

    return Uint8Array.from(result);
  }

  /**
   * @returns {number}
   */
  getPCMDataSize() {
    let result = 0;

    for (const sample of this.samples) result += sample.data.length;

    return result;
  }

  /**
   * @returns {Uint8Array}
   */
  asByteArray() {
    let offset;
    let data;
    let len;
    /** @type {number[]} */
    const result = [];

    // 0000: XGM2 id (ignored when compiled in ROM)
    if (!this.packed) writeBytes(result, getBytesAsciiRaw("XGM2"));
    // 0004: version (0x10 currently)
    result.push(0x10);

    // 0005: format description (see xgm2.txt)
    data = 0;
    // bit #0: NTSC / PAL information: 0=NTSC 1=PAL
    if (this.pal) data |= 1;
    // bit #1: multi tracks file: 0=No 1=Yes (always 0 here)
    // bit #2: GD3 tags: 0=No 1=Yes
    if (this.gd3 != null) data |= 4;
    // bit #3: packed FM / PSG / GD3 data blocks: 0=No 1=Yes
    if (this.packed) data |= 8;
    // write format
    result.push(data & 0xff);

    // get FM and PSG data blocks
    let pcmData = this.getPCMDataArray();
    let fmData;
    let psgData;

    if (this.packed) {
      fmData = this.getPackedFMMusicDataArray();
      psgData = this.getPackedPSGMusicDataArray();
    } else {
      fmData = this.getFMMusicDataArray();
      psgData = this.getPSGMusicDataArray();
    }

    // align on 256 bytes
    pcmData = alignBytes(pcmData, 256, 0);
    fmData = alignBytes(fmData, 256, 0);
    psgData = alignBytes(psgData, 256, 0);

    // 0006-0007: SLEN = Sample data bloc size / 256 (ex: $0200 means 512*256 = 131072 bytes)
    data = pcmData.length >> 8;
    result.push((data >> 0) & 0xff);
    result.push((data >> 8) & 0xff);
    // 0008-0009: FMLEN = FM music data block size / 256 (ex: $0040 means 64*256 = 16384 bytes)
    data = fmData.length >> 8;
    result.push((data >> 0) & 0xff);
    result.push((data >> 8) & 0xff);
    // 000A-000B: PSGLEN = PSG music data block size / 256 (ex: $0020 means 32*256 = 8192 bytes)
    data = psgData.length >> 8;
    result.push((data >> 0) & 0xff);
    result.push((data >> 8) & 0xff);

    // 000C-0103: SID (sample id) table
    // size = 256-8 = 248 bytes so end of table will align on 256 bytes in ROM
    offset = 0;
    for (let s = 0; s < this.samples.length; s++) {
      const sample = this.samples[s];
      len = sample.data.length;

      // each entry of the table consist of 2 bytes for the address:
      // entry+$0: sample address / 256
      result.push((offset >> 8) & 0xff);
      result.push((offset >> 16) & 0xff);
      offset += len;
    }
    // required to get last sample size
    result.push((offset >> 8) & 0xff);
    result.push((offset >> 16) & 0xff);
    // fill with silent mark
    for (let s = this.samples.length + 1; s < 248 / 2; s++) {
      result.push(0xff);
      result.push(0xff);
    }

    // 0104-xx04: sample data (see SLEN field for size)
    writeBytes(result, pcmData);
    // xx04-xx04: FM music data
    writeBytes(result, fmData);
    // xx04-xx04: PSG music data
    writeBytes(result, psgData);

    // xx04-xx04: GD3/XD3 data
    if (this.packed) {
      if (this.xd3 != null) writeBytes(result, this.xd3.asByteArray());
    } else if (this.gd3 != null) writeBytes(result, this.gd3.asByteArray());

    return Uint8Array.from(result);
  }

  /**
   * @param {number} originId
   * @param {number} replaceId
   * @param {number} durationInSample -1 means "no duration change"
   */
  updateSampleCommands(originId, replaceId, durationInSample) {
    // nothing to do..
    if (originId === replaceId && durationInSample === -1) return;

    let i = 0;
    while (i < this.FMcommands.length) {
      const command = this.FMcommands[i++];

      // found a command for the original sample ?
      if (command.isPCM() && command.getPCMId() === originId) {
        // --> set new sample id
        command.setPCMId(replaceId);

        // we have to change duration ?
        if (durationInSample !== -1) {
          // get duration
          const duration = durationInSample * (command.getPCMHalfRate() ? 2 : 1);
          const endTime = command.time + duration;
          let endTimeFrame = -1;
          let addStop = false;

          // find position where to add stop command
          while (i < this.FMcommands.length) {
            const tmpCom = this.FMcommands[i++];

            // find another PCM command in between ? no need to stop then
            if (tmpCom.isPCM()) {
              i--;
              break;
            }
            // duration reach ?
            if (tmpCom.time >= endTime) {
              if (endTimeFrame === -1) endTimeFrame = tmpCom.time;
              // next frame ?
              else if (tmpCom.time > endTimeFrame) {
                // need to add stop PCM command
                addStop = true;
                i--;
                break;
              }
            }
          }

          if (addStop) {
            this.FMcommands.splice(i - 1, 0, XGMFMCommand.createPCMStopCommand(command.getPCMChannel()));
            i++;
          }
        }
      }
    }
  }
}

/**
 * Append all elements of `src` to `dst` in order — mirrors Java's List.addAll.
 * @template T
 * @param {T[]} dst
 * @param {Iterable<T>} src
 */
function pushAll(dst, src) {
  for (const item of src) dst.push(item);
}

/**
 * Raw ASCII bytes for a string (mirrors Java "XGM2".getBytes() under the default
 * ASCII-compatible charset for these literals).
 * @param {string} text
 * @returns {Uint8Array}
 */
function getBytesAsciiRaw(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

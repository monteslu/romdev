// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/analysis/InstrAnalyzer.py

import { rabbitizer } from "../../../rabbitizer.js";
import { GlobalConfig } from "../../../common/GlobalConfig.js";
import { newIntSet } from "../../../common/symset.js";
import { enumValue, hexU } from "../../../py/pyutils.js";
import { atLeast } from "../../../version.js";

const GP_REG = 28;

export function isGpReg(reg) {
  return reg !== null && reg !== undefined && enumValue(reg) === GP_REG;
}

export function sameRabbitizerEnum(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return enumValue(a) === enumValue(b);
}

export class SymbolTypeInfo {
  constructor(accessType, unsignedMemoryAccess) {
    this.accessType = accessType;
    this.unsignedMemoryAccess = unsignedMemoryAccess;
  }

  get _key() {
    return `${enumValue(this.accessType)}|${this.unsignedMemoryAccess ? 1 : 0}`;
  }

  equals(other) {
    return other instanceof SymbolTypeInfo && sameRabbitizerEnum(this.accessType, other.accessType) && this.unsignedMemoryAccess === other.unsignedMemoryAccess;
  }
}

/** dict[SymbolTypeInfo, int] keyed by value equality, insertion ordered. */
export class SymbolTypeInfoDict {
  constructor() {
    this._m = new Map();
  }

  get size() {
    return this._m.size;
  }

  has(info) {
    return this._m.has(info._key);
  }

  get(info, dflt = undefined) {
    const e = this._m.get(info._key);
    return e === undefined ? dflt : e[1];
  }

  set(info, value) {
    const e = this._m.get(info._key);
    if (e === undefined) this._m.set(info._key, [info, value]);
    else e[1] = value;
    return this;
  }

  *keys() {
    for (const [k] of this._m.values()) yield k;
  }

  *entries() {
    for (const [k, v] of this._m.values()) yield [k, v];
  }

  [Symbol.iterator]() {
    return this.keys();
  }
}

export class CploadInfo {
  constructor(hiOffset, loOffset, adduOffset = null, reg = null) {
    this.hiOffset = hiOffset;
    this.loOffset = loOffset;
    this.adduOffset = adduOffset;
    this.reg = reg;
  }
}

/** Info for tracking when a $gp register is set */
export class GpSetInfo {
  constructor(hiOffset, loOffset, value) {
    this.hiOffset = hiOffset;
    this.loOffset = loOffset;
    this.value = value;
  }
}

function luiValue(instr) {
  return instr.getProcessedImmediate() * 0x10000;
}

export class InstrAnalyzer {
  constructor(funcVram, context) {
    this.funcVram = funcVram;
    /** read-only */
    this.context = context;

    this.currentGpValue = GlobalConfig.GP_VALUE;

    /** Every referenced vram found */
    this.referencedVrams = newIntSet();
    /** Every referenced constant found */
    this.referencedConstants = newIntSet();

    this.referencedVramsInstrOffset = new Map();

    // Branches
    /** key: branch instruction offset, value: target vram */
    this.branchInstrOffsets = new Map();
    /** key: branch instruction offset, value: relative branch target */
    this.branchTargetInstrOffsets = new Map();
    this.branchLabelOffsets = newIntSet();

    // Function calls
    this.funcCallInstrOffsets = new Map();
    this.funcCallOutsideRangesOffsets = new Map();

    // Jump register (jumptables)
    this.jumpRegisterIntrOffset = new Map();
    this.referencedJumpTableOffsets = new Map();
    /** key: jr instr offset, value: [jumptable reference offset, jumptable address, branch offset] */
    this.rejectedjumpRegisterIntrOffset = new Map();

    // Jump and link (functions)
    this.indirectFunctionCallIntrOffset = new Map();
    this.indirectFunctionCallOffsets = new Map();

    // Constants
    this.constantHiInstrOffset = new Map();
    this.constantLoInstrOffset = new Map();
    this.constantInstrOffset = new Map();

    // Symbols
    this.symbolHiInstrOffset = new Map();
    this.symbolLoInstrOffset = new Map();

    this.symbolGpInstrOffset = new Map();
    this.gpReferencedSymbols = newIntSet();

    this.symbolInstrOffset = new Map();

    /** key: address, value: SymbolTypeInfoDict */
    this.possibleSymbolTypes = new Map();
    this.symbolTypesOffsets = new Map();

    // %hi/%lo pairing
    this.hiToLowDict = new Map();
    this.lowToHiDict = new Map();

    this.luiInstrs = new Map();

    this.nonLoInstrOffsets = newIntSet();

    this.gotAccessAddresses = new Map();

    /** cploads which are not yet fully paired */
    this.unpairedCploads = [];
    /** Offset of every cpload instruction */
    this.cploadOffsets = newIntSet();
    /** Completed cpload, key: offset of last instruction of the cpload */
    this.cploads = new Map();

    /** Offsets of every instruction that set the $gp register */
    this.gpSetsOffsets = newIntSet();
    /** Instructions setting the $gp register, key: offset of the low instruction */
    this.gpSets = new Map();
  }

  processBranch(regsTracker, instr, instrOffset, _currentVram) {
    regsTracker.processBranch(instr, instrOffset);

    if (this.branchInstrOffsets.has(instrOffset)) return;

    const branchOffset = instr.getBranchOffsetGeneric();
    const branch = instrOffset + branchOffset;
    const targetBranchVram = this.funcVram + branch;

    if (!GlobalConfig.PIC) this.referencedVrams.add(targetBranchVram);

    this.branchLabelOffsets.add(branch);
    this.branchInstrOffsets.set(instrOffset, targetBranchVram);
    this.branchTargetInstrOffsets.set(instrOffset, branch);
  }

  processFuncCall(instr, instrOffset) {
    if (this.funcCallInstrOffsets.has(instrOffset)) return;

    const target = instr.getInstrIndexAsVram();
    if (!this.context.isAddressInGlobalRange(target)) this.funcCallOutsideRangesOffsets.set(instrOffset, target);

    if (!GlobalConfig.PIC) this.referencedVrams.add(target);
    this.referencedVramsInstrOffset.set(instrOffset, target);

    this.funcCallInstrOffsets.set(instrOffset, target);
  }

  processConstant(regsTracker, luiInstr, luiOffset, lowerInstr, lowerOffset) {
    const upperHalf = luiValue(luiInstr);
    const lowerHalf = lowerInstr.getProcessedImmediate();
    const constant = Number(BigInt(upperHalf) | BigInt(lowerHalf));

    this.referencedConstants.add(constant);

    this.constantHiInstrOffset.set(luiOffset, constant);
    this.constantLoInstrOffset.set(lowerOffset, constant);
    this.constantInstrOffset.set(luiOffset, constant);
    this.constantInstrOffset.set(lowerOffset, constant);

    this.hiToLowDict.set(luiOffset, lowerOffset);
    this.lowToHiDict.set(lowerOffset, luiOffset);

    regsTracker.processConstant(lowerInstr, constant, lowerOffset);

    return constant;
  }

  pairHiLo(hiValue, luiOffset, lowerInstr, lowerOffset) {
    // lui being None means this symbol is a $gp access
    if (!((hiValue === null && luiOffset === null) || (hiValue !== null && luiOffset !== null))) throw new Error("AssertionError");

    const lowerHalf = lowerInstr.getProcessedImmediate();

    if (this.symbolLoInstrOffset.has(lowerOffset)) {
      // This %lo has been processed already

      // Check the other lui has the same immediate value as this one, and reject the pair if it doesn't
      if (hiValue !== null) {
        const otherLuiOffset = this.lowToHiDict.has(lowerOffset) ? this.lowToHiDict.get(lowerOffset) : null;
        if (otherLuiOffset !== null) {
          const otherLuiInstr = this.luiInstrs.has(otherLuiOffset) ? this.luiInstrs.get(otherLuiOffset) : null;
          if (otherLuiInstr !== null) {
            if (hiValue !== luiValue(otherLuiInstr)) return null;
          }
        }
      }

      if (!GlobalConfig.COMPILER.value.pairMultipleHiToSameLow) {
        // IDO does not pair multiples %hi to the same %lo
        return this.symbolLoInstrOffset.get(lowerOffset);
      } else {
        if (luiOffset === null || hiValue === null) return null;

        if (this.hiToLowDict.get(luiOffset) === lowerOffset && this.lowToHiDict.get(lowerOffset) === luiOffset) {
          // This pair has been already paired
          return this.symbolLoInstrOffset.get(lowerOffset);
        }

        if (luiOffset + 4 === lowerOffset) {
          // Make an exception if the lower instruction is just after the LUI
        } else {
          const upperHalf = hiValue;
          const address = upperHalf + lowerHalf;
          if (address === this.symbolLoInstrOffset.get(lowerOffset)) {
            // Make an exception if the resulting address is the same
          } else {
            return this.symbolLoInstrOffset.get(lowerOffset);
          }
        }
      }
    }

    if (hiValue === null && this.currentGpValue === null) {
      // Trying to pair a gp relative offset, but we don't know the gp address
      return null;
    }

    let upperHalf;
    if (hiValue !== null) upperHalf = hiValue;
    else upperHalf = this.currentGpValue;

    return upperHalf + lowerHalf;
  }

  processSymbol(address, luiOffset, lowerInstr, lowerOffset) {
    if (address <= 0) {
      // PS2 seems to do LUI/ADDIU pairs for 0 and -1 for some reason, filter them out
      if (!GlobalConfig.PIC) return null;
    }

    // filter out stuff that may not be a real symbol
    let filterOut = false;
    if (!this.context.totalVramRange.isInRange(address)) {
      if (GlobalConfig.SYMBOL_FINDER_FILTER_LOW_ADDRESSES || GlobalConfig.SYMBOL_FINDER_FILTER_HIGH_ADDRESSES) {
        filterOut ||= GlobalConfig.SYMBOL_FINDER_FILTER_LOW_ADDRESSES && address < GlobalConfig.SYMBOL_FINDER_FILTER_ADDRESSES_ADDR_LOW;
        filterOut ||= GlobalConfig.SYMBOL_FINDER_FILTER_HIGH_ADDRESSES && address >= GlobalConfig.SYMBOL_FINDER_FILTER_ADDRESSES_ADDR_HIGH;
      } else {
        filterOut = true;
      }
    }

    if (filterOut) {
      const contextSym = this.context.globalSegment.getSymbol(address);
      if (contextSym !== null) {
        if (contextSym.isUserDeclared) {
          // If the user declared a symbol outside the total vram range then use it anyways
          filterOut = false;
        }
      }
    }

    if (address > 0 && filterOut && !sameRabbitizerEnum(lowerInstr.uniqueId, rabbitizer.InstrId.cpu_addiu)) {
      if (GlobalConfig.SYMBOL_FINDER_FILTERED_ADDRESSES_AS_CONSTANTS) {
        // Let's pretend this value is a constant
        const constant = address;
        this.referencedConstants.add(constant);

        this.constantLoInstrOffset.set(lowerOffset, constant);
        this.constantInstrOffset.set(lowerOffset, constant);
        if (luiOffset !== null) {
          this.constantHiInstrOffset.set(luiOffset, constant);
          this.constantInstrOffset.set(luiOffset, constant);

          this.hiToLowDict.set(luiOffset, lowerOffset);
          this.lowToHiDict.set(lowerOffset, luiOffset);
        }
      }
      return null;
    }

    if (!GlobalConfig.PIC) this.referencedVrams.add(address);

    if (!this.symbolLoInstrOffset.has(lowerOffset)) {
      this.symbolLoInstrOffset.set(lowerOffset, address);
      this.symbolInstrOffset.set(lowerOffset, address);
      this.referencedVramsInstrOffset.set(lowerOffset, address);
    }
    if (luiOffset !== null) {
      if (!this.symbolHiInstrOffset.has(luiOffset)) {
        this.symbolHiInstrOffset.set(luiOffset, address);
        this.symbolInstrOffset.set(luiOffset, address);
        this.referencedVramsInstrOffset.set(luiOffset, address);
      }

      this.hiToLowDict.set(luiOffset, lowerOffset);
      this.lowToHiDict.set(lowerOffset, luiOffset);
    } else {
      this.symbolGpInstrOffset.set(lowerOffset, address);
      this.gpReferencedSymbols.add(address);
      this.symbolInstrOffset.set(lowerOffset, address);
      this.referencedVramsInstrOffset.set(lowerOffset, address);
    }

    this.processSymbolType(address, lowerInstr, lowerOffset);

    return address;
  }

  processGotSymbol(address, instr, instrOffset) {
    if (address <= 0) return;
    this.gotAccessAddresses.set(instrOffset, address);
  }

  processSymbolType(address, instr, instrOffset) {
    const accessType = instr.getAccessType();
    const unsignedMemoryAccess = instr.doesUnsignedMemoryAccess();
    if (sameRabbitizerEnum(accessType, rabbitizer.AccessType.INVALID)) return;

    if (!this.possibleSymbolTypes.has(address)) this.possibleSymbolTypes.set(address, new SymbolTypeInfoDict());
    const symAccess = new SymbolTypeInfo(accessType, unsignedMemoryAccess);
    const dict = this.possibleSymbolTypes.get(address);
    if (!dict.has(symAccess)) dict.set(symAccess, 0);
    dict.set(symAccess, dict.get(symAccess) + 1);

    this.symbolTypesOffsets.set(instrOffset, symAccess);
  }

  processSymbolDereferenceType(regsTracker, instr, instrOffset) {
    const address = regsTracker.getAddressIfCanSetType(instr, instrOffset);
    if (address === null || address === undefined) return;
    this.processSymbolType(address, instr, instrOffset);
  }

  symbolFinder(regsTracker, instr, prevInstr, instrOffset) {
    if (instr.canBeHi()) {
      if (prevInstr === null) regsTracker.processLui(instr, instrOffset);
      else regsTracker.processLui(instr, instrOffset, prevInstr);
      this.luiInstrs.set(instrOffset, instr);
      return;
    }

    if (instr.doesLoad() && isGpReg(instr.rs)) regsTracker.processGpLoad(instr, instrOffset);

    if (!instr.canBeLo()) return;

    if (instr.isUnsigned()) {
      // Constants
      const luiOffset = regsTracker.getLuiOffsetForConstant(instr);
      if (luiOffset === null || luiOffset === undefined) return;
      const luiInstr = this.luiInstrs.has(luiOffset) ? this.luiInstrs.get(luiOffset) : null;
      if (luiInstr === null) return;
      this.processConstant(regsTracker, luiInstr, luiOffset, instr, instrOffset);
      return;
    }

    if (this.nonLoInstrOffsets.has(instrOffset)) return;

    const pairingInfo = regsTracker.preprocessLoAndGetInfo(instr, instrOffset);
    if (!pairingInfo.shouldProcess) {
      if (regsTracker.hasLoButNoHi(instr)) this.nonLoInstrOffsets.add(instrOffset);
      return;
    }

    if (pairingInfo.isGpGot && !GlobalConfig.PIC) return;

    let upperHalf = pairingInfo.value;
    let luiOffset = pairingInfo.instrOffset;
    if (pairingInfo.isGpRel) {
      if (atLeast("1.42.0") && !GlobalConfig.GP_VALUE && !GlobalConfig.PIC) {
        // If there's no gp value configured then it is very unlikely
        // for symbolizing as %gp_rel to be correct.
        return;
      }
      upperHalf = null;
      luiOffset = null;
    }

    if (luiOffset !== null) {
      const luiInstr = this.luiInstrs.get(luiOffset);
      if (luiInstr !== undefined && isGpReg(luiInstr.rt)) {
        if (instr.readsRs() && isGpReg(instr.rs) && instr.modifiesRt() && isGpReg(instr.rt)) {
          if (GlobalConfig.PIC) {
            // cpload
            this.unpairedCploads.push(new CploadInfo(luiOffset, instrOffset));
          } else {
            const hiGpValue = luiValue(luiInstr);
            const loGpValue = instr.getProcessedImmediate();
            const gpValue = hiGpValue + loGpValue;
            this.gpSets.set(instrOffset, new GpSetInfo(luiOffset, instrOffset, gpValue));
            this.gpSetsOffsets.add(luiOffset);
            this.gpSetsOffsets.add(instrOffset);
            if (!GlobalConfig.PIC) this.currentGpValue = gpValue;
          }
          // early return to avoid counting this pairing as a normal symbol
          return;
        }
      }
    }

    let address = this.pairHiLo(upperHalf, luiOffset, instr, instrOffset);
    if (address === null) return;

    if (upperHalf === null) {
      if (GlobalConfig.PIC) {
        this.processGotSymbol(address, instr, instrOffset);
        regsTracker.processLo(instr, address, instrOffset);
        return;
      }
    }

    address = this.processSymbol(address, luiOffset, instr, instrOffset);
    if (address !== null) regsTracker.processLo(instr, address, instrOffset);
  }

  processJumpRegister(regsTracker, instr, instrOffset) {
    const jrRegData = regsTracker.getJrRegData(instr);
    if (jrRegData.hasInfo()) {
      const offset = jrRegData.offset();
      const address = jrRegData.address();

      if (jrRegData.checkedForBranching()) {
        this.rejectedjumpRegisterIntrOffset.set(instrOffset, [offset, address, jrRegData.lastBranchOffset()]);
      } else {
        // Jumptables never check the register they are branching into,
        // since the references should always be valid.
        this.referencedJumpTableOffsets.set(offset, address);
      }

      this.jumpRegisterIntrOffset.set(instrOffset, address);
      if (!GlobalConfig.PIC) this.referencedVrams.add(address);
    }
  }

  processJumpAndLinkRegister(regsTracker, instr, instrOffset) {
    const jrRegData = regsTracker.getJrRegData(instr);
    if (jrRegData.hasInfo()) {
      const offset = jrRegData.offset();
      const address = jrRegData.address();

      this.indirectFunctionCallOffsets.set(offset, address);
      this.indirectFunctionCallIntrOffset.set(instrOffset, address);
      if (!GlobalConfig.PIC) this.referencedVrams.add(address);
    }
  }

  processInstr(regsTracker, instr, instrOffset, currentVram, prevInstr) {
    if (instr.isBranch() || instr.isUnconditionalBranch()) {
      this.processBranch(regsTracker, instr, instrOffset, currentVram);
    } else if (instr.isJumpWithAddress()) {
      this.processFuncCall(instr, instrOffset);
    } else if (instr.hasOperandAlias(rabbitizer.OperandType.cpu_immediate)) {
      this.symbolFinder(regsTracker, instr, prevInstr ?? null, instrOffset);
      this.processSymbolDereferenceType(regsTracker, instr, instrOffset);
    } else if (instr.isJumptableJump()) {
      this.processJumpRegister(regsTracker, instr, instrOffset);
    } else if (instr.isJump() && instr.doesLink()) {
      // jalr, implicit not isJumpWithAddress
      this.processJumpAndLinkRegister(regsTracker, instr, instrOffset);
    } else if (sameRabbitizerEnum(instr.uniqueId, rabbitizer.InstrId.cpu_addu)) {
      // special check for .cpload
      if (this.unpairedCploads.length > 0) {
        if (isGpReg(instr.rd) && isGpReg(instr.rs)) {
          const cpload = this.unpairedCploads.pop();
          cpload.adduOffset = instrOffset;
          cpload.reg = instr.rt;
          this.cploadOffsets.add(cpload.hiOffset);
          this.cploadOffsets.add(cpload.loOffset);
          this.cploadOffsets.add(instrOffset);
          this.cploads.set(instrOffset, cpload);
        }
      }
    }

    regsTracker.overwriteRegisters(instr, instrOffset);
    if (!GlobalConfig.PIC) {
      const dstReg = instr.getDestinationGpr();
      if (dstReg !== null && dstReg !== undefined && isGpReg(dstReg)) {
        if (!this.gpSets.has(instrOffset)) {
          this.gpSets.set(instrOffset, null);
          this.gpSetsOffsets.add(instrOffset);
          this.currentGpValue = null;
        }
      }
    }
  }

  processPrevFuncCall(regsTracker, instr, prevInstr, _currentVram = null) {
    regsTracker.unsetRegistersAfterFuncCall(instr, prevInstr);
  }

  printAnalisisDebugInfo_IterInfo(regsTracker, instr, currentVram) {
    if (!GlobalConfig.PRINT_FUNCTION_ANALYSIS_DEBUG_INFO) return;
    process.stdout.write(`_printAnalisisDebugInfo_IterInfo\n\nvram: ${hexU(currentVram)}\n${instr}\n\n`);
  }

  printSymbolFinderDebugInfo_UnpairedLuis() {
    if (!GlobalConfig.PRINT_UNPAIRED_LUIS_DEBUG_INFO) return;

    let firstNotePrinted = false;
    for (const [instructionOffset, luiInstr] of this.luiInstrs) {
      if (this.constantInstrOffset.has(instructionOffset)) continue;
      if (GlobalConfig.SYMBOL_FINDER_FILTER_LOW_ADDRESSES && luiInstr.getProcessedImmediate() < 0x8000) continue;
      if (GlobalConfig.SYMBOL_FINDER_FILTER_HIGH_ADDRESSES && luiInstr.getProcessedImmediate() >= 0xc000) continue;

      if (!this.symbolInstrOffset.has(instructionOffset)) {
        if (!firstNotePrinted) {
          process.stdout.write(`_printSymbolFinderDebugInfo_UnpairedLuis\nfuncVram: ${hexU(this.funcVram, 8)}\n`);
          firstNotePrinted = true;
        }
        process.stdout.write(`${hexU(luiInstr.vram, 6)}  NO          ${luiInstr}\n`);
      }
    }
    if (firstNotePrinted) process.stdout.write("\n");
  }
}

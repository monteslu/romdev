// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/MipsSymbolFunction.py

import { rabbitizer } from "../../rabbitizer.js";
import { GlobalConfig, Abi, InputFileType } from "../../common/GlobalConfig.js";
import { SymbolSpecialType, isSymbolSpecialType } from "../../common/ContextSymbols.js";
import { RelocType, RelocationInfo } from "../../common/Relocation.js";
import * as Utils from "../../common/Utils.js";
import { newIntSet } from "../../common/symset.js";
import { hexU, enumValue } from "../../py/pyutils.js";
import { atLeast } from "../../version.js";
import { SymbolText } from "./MipsSymbolText.js";
import { InstrAnalyzer, SymbolTypeInfoDict, isGpReg, sameRabbitizerEnum } from "./analysis/InstrAnalyzer.js";

function isAccess(accessType, name) {
  return sameRabbitizerEnum(accessType, rabbitizer.AccessType[name]);
}

export class SymbolFunction extends SymbolText {
  constructor(context, vromStart, vromEnd, inFileOffset, vram, instrsList, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, inFileOffset, vram, [], segmentVromStart, overlayCategory);
    this.instructions = [...instrsList];

    this.instrAnalyzer = new InstrAnalyzer(this.vram, context);

    /** set[tuple[int, bool]] (membership only) */
    this.branchesTaken = new Set();

    this.pointersOffsets = newIntSet();
    this.pointersRemoved = false;

    this.hasUnimplementedIntrs = false;
    this.isRsp = false;
    this.isLikelyHandwritten = false;
    this.gpRelHack = false;
  }

  get nInstr() {
    return this.instructions.length;
  }

  get sizew() {
    return this.instructions === undefined ? this.words.length : this.nInstr;
  }

  isFunction() {
    return true;
  }

  _lookAheadSymbolFinder(instr, prevInstr, instructionOffset, trackedRegistersOriginal, prev_is_likely) {
    if (!prevInstr.isBranch() && !prevInstr.isUnconditionalBranch()) return;

    const currentVram = this.getVramOffset(instructionOffset);

    const prevInstrOffset = instructionOffset - 4;
    const branchOffset = prevInstr.getBranchOffsetGeneric();
    let branch = prevInstrOffset + branchOffset;

    if (branch < 0) {
      // Avoid jumping outside of the function
      return;
    }

    const regsTracker = new rabbitizer.RegistersTracker(trackedRegistersOriginal);

    this.instrAnalyzer.processInstr(regsTracker, instr, instructionOffset, currentVram, null);

    const key = `${instructionOffset}|${prev_is_likely ? 1 : 0}`;
    if (this.branchesTaken.has(key)) return;
    this.branchesTaken.add(key);

    const sizew = this.instructions.length * 4;
    while (branch < sizew) {
      const prevTargetInstr = this.instructions.at(Math.floor(branch / 4) - 1);
      const targetInstr = this.instructions[Math.floor(branch / 4)];

      this.instrAnalyzer.processInstr(regsTracker, targetInstr, branch, this.getVramOffset(branch), prevTargetInstr);

      this._lookAheadSymbolFinder(targetInstr, prevTargetInstr, branch, regsTracker, prev_is_likely || prevTargetInstr.isBranchLikely());

      if (prevTargetInstr.isUnconditionalBranch()) {
        // Since we took the branch on the previous _lookAheadSymbolFinder
        // call then we don't have anything else to process here.
        return;
      }
      if (prevTargetInstr.isJump() && !prevTargetInstr.doesLink()) {
        // Technically this is another form of unconditional branching.
        return;
      }

      this.instrAnalyzer.processPrevFuncCall(regsTracker, targetInstr, prevTargetInstr);
      branch += 4;
    }
  }

  _runInstructionAnalyzer() {
    let regsTracker = new rabbitizer.RegistersTracker();

    const sizew = this.instructions.length * 4;

    let instructionOffset = 0;
    if (instructionOffset < sizew) {
      // First process the first instruction. We do this separately because the first one doesn't have a prev instruction.
      const currentVram = this.getVramOffset(instructionOffset);
      const instr = this.instructions[instructionOffset / 4];

      if (instr.isLikelyHandwritten() && !this.isRsp) {
        this.isLikelyHandwritten = true;
        this.endOfLineComment.set(instructionOffset / 4, " /* handwritten instruction */");
      }

      if (!GlobalConfig.DISASSEMBLE_UNKNOWN_INSTRUCTIONS && !instr.isImplemented()) {
        // Abort analysis
        this.hasUnimplementedIntrs = true;
        return;
      }

      this.instrAnalyzer.processInstr(regsTracker, instr, instructionOffset, currentVram, null);
      instructionOffset += 4;
    }

    while (instructionOffset < sizew) {
      const currentVram = this.getVramOffset(instructionOffset);
      const prevInstr = this.instructions[instructionOffset / 4 - 1];
      const instr = this.instructions[instructionOffset / 4];

      this.instrAnalyzer.printAnalisisDebugInfo_IterInfo(regsTracker, instr, currentVram);

      if (instr.isLikelyHandwritten() && !this.isRsp) {
        this.isLikelyHandwritten = true;
        this.endOfLineComment.set(instructionOffset / 4, " /* handwritten instruction */");
      }

      if (!GlobalConfig.DISASSEMBLE_UNKNOWN_INSTRUCTIONS && !instr.isImplemented()) {
        // Abort analysis
        this.hasUnimplementedIntrs = true;
        return;
      }

      if (!prevInstr.isBranchLikely() && !prevInstr.isUnconditionalBranch()) {
        this.instrAnalyzer.processInstr(regsTracker, instr, instructionOffset, currentVram, prevInstr);
      }

      // look-ahead symbol finder
      this._lookAheadSymbolFinder(instr, prevInstr, instructionOffset, regsTracker, prevInstr.isBranchLikely());

      if (prevInstr.isJumpWithAddress() && !prevInstr.doesLink()) {
        const targetVram = prevInstr.getBranchVramGeneric();
        if (targetVram < this.vram || targetVram >= this.vramEnd) {
          // Function is jumping outside the current function, so the state of
          // the registers is garbage to the rest of the function.
          regsTracker = new rabbitizer.RegistersTracker();
        }
      }

      this.instrAnalyzer.processPrevFuncCall(regsTracker, instr, prevInstr, currentVram);

      if (prevInstr.isUnconditionalBranch() || (prevInstr.isJumpWithAddress() && !prevInstr.doesLink()) || prevInstr.isReturn()) {
        // Execution diverges here, so it doesn't make sense to keep the current state.
        regsTracker = new rabbitizer.RegistersTracker();
      }

      instructionOffset += 4;
    }

    this.instrAnalyzer.printSymbolFinderDebugInfo_UnpairedLuis();
  }

  _processElfRelocSymbols() {
    if (this.context.globalRelocationOverrides.size === 0) return;
    if (GlobalConfig.INPUT_FILE_TYPE !== InputFileType.ELF) return;

    let instructionOffset = 0;
    let vrom = this.vromStart;
    for (const instr of this.instructions) {
      const relocInfo = this.context.globalRelocationOverrides.get(vrom);
      if (relocInfo !== undefined) {
        if (relocInfo.relocType === RelocType.MIPS_26) {
          if (relocInfo.staticReference !== null) {
            const targetVram = instr.getInstrIndexAsVram() + relocInfo.staticReference.sectionVram;
            if (instr.doesLink()) {
              // Function call
              relocInfo.symbol = this.addFunction(targetVram, true);
            } else {
              relocInfo.symbol = this.addBranchLabel(targetVram, true);
            }
            relocInfo.symbol._isStatic = true;
          }
        } else {
          const offsetAddend = this.instrAnalyzer.symbolInstrOffset.has(instructionOffset) ? this.instrAnalyzer.symbolInstrOffset.get(instructionOffset) : null;
          if (offsetAddend !== null) {
            const hiOffset = this.instrAnalyzer.lowToHiDict.has(instructionOffset) ? this.instrAnalyzer.lowToHiDict.get(instructionOffset) : null;
            if (hiOffset !== null) this.instrAnalyzer.symbolInstrOffset.set(hiOffset, offsetAddend);
          }

          if (relocInfo.staticReference !== null) {
            // For static symbols which only reference the start of a section
            let symbolVram = relocInfo.staticReference.sectionVram;
            if (instr.hasOperandAlias(rabbitizer.OperandType.cpu_immediate)) {
              if (this.instrAnalyzer.symbolInstrOffset.has(instructionOffset)) {
                const addressOffset = this.instrAnalyzer.symbolInstrOffset.get(instructionOffset);
                symbolVram += addressOffset;
              } else {
                symbolVram += instr.getProcessedImmediate();
              }
            }
            let contextSym = this.getSymbol(symbolVram, null, true);
            if (contextSym === null) contextSym = this.addSymbol(symbolVram, undefined, true);
            relocInfo.symbol = contextSym;
            relocInfo.symbol._isStatic = true;
            relocInfo.addend = symbolVram - contextSym.vram;
          } else if (offsetAddend !== null) {
            // Addends for global symbols
            relocInfo.addend = offsetAddend;
          }
        }
      }

      vrom += 4;
      instructionOffset += 4;
    }
  }

  _bumpPossibleType(gotAddress, loOffset) {
    const symAccess = this.instrAnalyzer.symbolTypesOffsets.get(loOffset);
    if (symAccess !== undefined) {
      if (!this.instrAnalyzer.possibleSymbolTypes.has(gotAddress)) this.instrAnalyzer.possibleSymbolTypes.set(gotAddress, new SymbolTypeInfoDict());
      const d = this.instrAnalyzer.possibleSymbolTypes.get(gotAddress);
      if (!d.has(symAccess)) d.set(symAccess, 0);
      d.set(symAccess, d.get(symAccess) + 1);
    }
  }

  _postProcessGotAccesses() {
    if (!GlobalConfig.PIC) return;

    const globalGotOffsets = new Set();

    for (const [gotAccessOffset, gotAccess] of this.instrAnalyzer.gotAccessAddresses) {
      const gpAccess = this.context.gpAccesses.requestAddress(gotAccess);
      if (gpAccess === null) {
        Utils.eprint(1, `0x${hexU(this.instructions[gotAccessOffset / 4].vram, 8)}`, `0x${hexU(gotAccess, 8)}`, this.instructions[gotAccessOffset / 4].disassemble());
        continue;
      }

      let gotAddress = gpAccess.address;
      if (!gpAccess.isGotLocal) {
        globalGotOffsets.add(gotAccessOffset);
        const contextSym = this.addSymbol(gotAddress, undefined, true);
        contextSym.isGot = gpAccess.isGot;
        contextSym.isGotGlobal = gpAccess.isGotGlobal;
        const loOffset = this.instrAnalyzer.hiToLowDict.get(gotAccessOffset);
        if (loOffset !== undefined) {
          this.instrAnalyzer.symbolLoInstrOffset.delete(loOffset);
          this.instrAnalyzer.symbolInstrOffset.delete(loOffset);
        }
      } else {
        // GOT-locals need to be paired
        const loOffset = this.instrAnalyzer.hiToLowDict.get(gotAccessOffset);
        if (loOffset !== undefined) {
          const loInstr = this.instructions[loOffset / 4];
          gotAddress += loInstr.getProcessedImmediate();
          this.instrAnalyzer.symbolInstrOffset.set(loOffset, gotAddress);
          this._bumpPossibleType(gotAddress, loOffset);
        }

        const contextSym = this.addSymbol(gotAddress, undefined, true);
        contextSym.isGot = true;
        contextSym.isGotLocal = true;
      }
      this.instrAnalyzer.symbolInstrOffset.set(gotAccessOffset, gotAddress);
      this.instrAnalyzer.referencedVrams.add(gotAddress);
    }

    // Aditional lookup for unpaired GOT-locals
    if (this.instrAnalyzer.gotAccessAddresses.size > 0) {
      for (const [loOffset, gotAccessOffset] of this.instrAnalyzer.lowToHiDict) {
        const gotAccess_ = this.instrAnalyzer.gotAccessAddresses.get(gotAccessOffset);
        if (gotAccess_ === undefined) continue;

        const gpAccess = this.context.gpAccesses.requestAddress(gotAccess_);
        if (gpAccess === null) {
          Utils.eprint(2, `0x${hexU(this.instructions[gotAccessOffset / 4].vram, 8)}`, `0x${hexU(gotAccess_, 8)}`, this.instructions[gotAccessOffset / 4].disassemble());
          continue;
        }

        if (!gpAccess.isGotLocal) continue;

        let gotAddress = gpAccess.address;

        const loInstr = this.instructions[loOffset / 4];
        gotAddress += loInstr.getProcessedImmediate();
        this.instrAnalyzer.symbolInstrOffset.set(loOffset, gotAddress);

        this._bumpPossibleType(gotAddress, loOffset);

        const contextSym = this.addSymbol(gotAddress, undefined, true);
        contextSym.isGot = true;
        contextSym.isGotLocal = true;
        this.instrAnalyzer.symbolInstrOffset.set(gotAccessOffset, gotAddress);
        this.instrAnalyzer.referencedVrams.add(gotAddress);
      }
    }

    for (const [loOffset, symVram0] of [...this.instrAnalyzer.symbolLoInstrOffset]) {
      let symVram = symVram0;
      const hiOffset = this.instrAnalyzer.lowToHiDict.get(loOffset);
      if (hiOffset !== undefined && this.instrAnalyzer.gotAccessAddresses.has(hiOffset)) {
        if (globalGotOffsets.has(hiOffset)) {
          this.instrAnalyzer.symbolInstrOffset.delete(loOffset);
          continue;
        }

        if (this.instrAnalyzer.symbolInstrOffset.has(hiOffset)) {
          symVram = this.instrAnalyzer.symbolInstrOffset.get(hiOffset);
          this.instrAnalyzer.symbolLoInstrOffset.set(loOffset, symVram);
        }

        if (this.instrAnalyzer.referencedJumpTableOffsets.has(loOffset)) this.instrAnalyzer.referencedJumpTableOffsets.set(loOffset, symVram);

        if (this.instrAnalyzer.indirectFunctionCallOffsets.has(loOffset)) this.instrAnalyzer.indirectFunctionCallOffsets.set(loOffset, symVram);
      }
    }
  }

  /** (instr, instrOffset, contextSym=None, gotHiLo=False, gotSmall=False) */
  _getRelocTypeForInstruction(instr, instrOffset, contextSym = null, gotHiLo = false, gotSmall = false) {
    if (instr.canBeHi()) {
      if (GlobalConfig.PIC) {
        if (contextSym !== null && gotHiLo) {
          if (contextSym.isGotGlobal && contextSym.getTypeSpecial() === SymbolSpecialType.function) return RelocType.MIPS_CALL_HI16;
          return RelocType.MIPS_GOT_HI16;
        }
      }
      return RelocType.MIPS_HI16;
    }

    if (isGpReg(instr.rs)) {
      if (!GlobalConfig.PIC || gotSmall) {
        if (instr.modifiesRt() && isGpReg(instr.rt)) {
          // Shouldn't make a gprel access if the dst register is $gp too
          return RelocType.MIPS_LO16;
        }
        return RelocType.MIPS_GPREL16;
      }

      if (contextSym !== null) {
        if (contextSym.isGotGlobal && contextSym.getTypeSpecial() === SymbolSpecialType.function && this.instrAnalyzer.indirectFunctionCallOffsets.has(instrOffset)) {
          return RelocType.MIPS_CALL16;
        } else if (contextSym.isGot) {
          return RelocType.MIPS_GOT16;
        } else {
          return RelocType.MIPS_GPREL16;
        }
      }
    } else if (GlobalConfig.PIC) {
      if (contextSym !== null && gotHiLo) {
        if (contextSym.isGotGlobal && contextSym.getTypeSpecial() === SymbolSpecialType.function) return RelocType.MIPS_CALL_LO16;
        return RelocType.MIPS_GOT_LO16;
      }
    }
    return RelocType.MIPS_LO16;
  }

  _generateRelocsFromInstructionAnalyzer() {
    const v142 = atLeast("1.42.0");

    if (v142 && !GlobalConfig.IGNORE_BRANCHES) {
      for (const [instrOffset, targetVram] of this.instrAnalyzer.branchInstrOffsets) {
        const instr = this.instructions[instrOffset / 4];
        if (!instr.isBranch() && !instr.isUnconditionalBranch()) continue;
        const branch = this.instrAnalyzer.branchTargetInstrOffsets.get(instrOffset);
        const branchTargetVrom = this.getVromOffset(branch);
        const labelSym = this.getSymbol(targetVram, branchTargetVrom, false);
        if (labelSym === null || labelSym.unknownSegment) continue;
        this.relocs.set(instrOffset, new RelocationInfo(RelocType.MIPS_PC16, labelSym));
      }
    }

    for (const [instrOffset, address0] of this.instrAnalyzer.symbolInstrOffset) {
      let address = address0;
      if (this.context.isAddressBanned(address)) continue;

      let contextSym = this.getSymbol(address);

      let gotHiLo = false;
      let gotSmall = false;
      if (contextSym === null && address < 0 && GlobalConfig.PIC && GlobalConfig.GP_VALUE !== null) {
        // Negative pointer may mean it is a weird GOT access
        const gotAccess = GlobalConfig.GP_VALUE + address;
        const gpAccess = this.context.gpAccesses.requestAddress(gotAccess);
        if (gpAccess !== null) {
          address = gpAccess.address;
          contextSym = this.getSymbol(address);
          gotHiLo = true;
          gotSmall = gpAccess.isSmallSection;
        } else {
          Utils.eprint(4, `0x${hexU(this.instructions[instrOffset / 4].vram, 8)}`, `0x${hexU(gotAccess, 8)}`, this.instructions[instrOffset / 4].disassemble());
        }
      }

      if (contextSym === null) continue;

      if (contextSym.isGotGlobal) {
        if (!this.instrAnalyzer.gotAccessAddresses.has(instrOffset) && !gotHiLo) continue;
      }

      const instr = this.instructions[instrOffset / 4];

      const relocType = this._getRelocTypeForInstruction(instr, instrOffset, contextSym, gotHiLo, gotSmall);
      if (relocType === RelocType.MIPS_GPREL16) contextSym.accessedAsGpRel = true;
      this.relocs.set(instrOffset, new RelocationInfo(relocType, contextSym, address - contextSym.vram));
    }

    for (const instrOffset of this.instrAnalyzer.cploadOffsets) {
      // .cpload directive is meant to use the `_gp_disp` pseudo-symbol
      const instr = this.instructions[instrOffset / 4];
      const relocType = this._getRelocTypeForInstruction(instr, instrOffset);
      this.relocs.set(instrOffset, new RelocationInfo(relocType, "_gp_disp"));
    }

    for (const [instrOffset, gpInfo] of this.instrAnalyzer.gpSets) {
      if (gpInfo === null) continue;
      const hiInstrOffset = gpInfo.hiOffset;
      const hiInstr = this.instructions[hiInstrOffset / 4];
      const instr = this.instructions[instrOffset / 4];

      const hiRelocType = this._getRelocTypeForInstruction(hiInstr, hiInstrOffset);
      const relocType = this._getRelocTypeForInstruction(instr, instrOffset);
      if (!GlobalConfig.PIC && gpInfo.value === GlobalConfig.GP_VALUE) {
        this.relocs.set(hiInstrOffset, new RelocationInfo(hiRelocType, "_gp"));
        this.relocs.set(instrOffset, new RelocationInfo(relocType, "_gp"));
      } else {
        const address = gpInfo.value;
        if (this.context.isAddressBanned(address)) continue;

        const contextSym = this.getSymbol(address);
        if (contextSym === null) continue;

        const addend = v142 ? address - contextSym.vram : 0;
        this.relocs.set(hiInstrOffset, new RelocationInfo(hiRelocType, contextSym, addend));
        this.relocs.set(instrOffset, new RelocationInfo(relocType, contextSym, addend));
      }
    }

    for (const [instrOffset, constant] of this.instrAnalyzer.constantInstrOffset) {
      const instr = this.instructions[instrOffset / 4];
      const relocType = this._getRelocTypeForInstruction(instr, instrOffset);

      if (relocType === RelocType.MIPS_HI16 || relocType === RelocType.MIPS_LO16) {
        // We can only do this kind of shenanigans for normal %hi/%lo relocs
        const symbol = this.getConstant(constant);
        if (symbol !== null) {
          this.relocs.set(instrOffset, new RelocationInfo(relocType, symbol.getName()));
        } else if (GlobalConfig.SYMBOL_FINDER_FILTERED_ADDRESSES_AS_HILO) {
          this.relocs.set(instrOffset, new RelocationInfo(relocType, `0x${hexU(constant)}`));
        } else {
          // Pretend this pair is a constant
          let loInstr = instr;
          if (instr.canBeHi()) {
            const lo = this.instrAnalyzer.hiToLowDict.get(instrOffset);
            if (lo === undefined) throw new Error(`KeyError: ${instrOffset}`);
            loInstr = this.instructions[lo / 4];
          }

          const generatedReloc = this._generateHiLoConstantReloc(constant, instr, loInstr);
          if (generatedReloc !== null) this.relocs.set(instrOffset, generatedReloc);
        }
      } else {
        const percent = relocType.getPercentRel();
        let comment = `Failed to symbolize address 0x${hexU(constant, 8)} for ${percent === null ? "None" : percent}. Make sure this address is within the recognized valid address space.`;
        if (relocType === RelocType.MIPS_GPREL16 || relocType === RelocType.MIPS_GOT16) {
          if (GlobalConfig.GP_VALUE === null) comment += " Please specify a gp_value.";
          else if (!this.context.isInTotalVramRange(GlobalConfig.GP_VALUE)) comment += ` The provided gp_value (0x${hexU(GlobalConfig.GP_VALUE, 8)}) seems wrong.`;
        }
        this.endOfLineComment.set(instrOffset / 4, ` /* ${comment} */`);
      }
    }

    for (const [instrOffset, targetVram] of this.instrAnalyzer.funcCallInstrOffsets) {
      const instr = this.instructions[instrOffset / 4];
      const is_j = instr.isJumpWithAddress() && !instr.doesLink();
      const symValidation = (contextSym) => {
        const t = contextSym.type;
        if (t === SymbolSpecialType.function) return true;
        if (t === null) return true;
        if (is_j && isSymbolSpecialType(t) && t.isTargetLabel()) return true;
        return false;
      };
      const funcSym = this.getSymbolFromAnySegment(targetVram, symValidation, false);
      if (funcSym === null) continue;
      this.relocs.set(instrOffset, new RelocationInfo(RelocType.MIPS_26, funcSym));
    }
  }

  analyze() {
    this.contextSym.inFileOffset = this.inFileOffset;
    if (this.parent !== null) this.contextSym.parentFileName = this.parent.getName();

    if (!GlobalConfig.DISASSEMBLE_UNKNOWN_INSTRUCTIONS && this.hasUnimplementedIntrs) {
      let offset = 0;
      for (const _instr of this.instructions) {
        const currentVram = this.getVramOffset(offset);
        const currentVrom = this.getVromOffset(offset);
        const contextSym = this.getSymbol(currentVram, currentVrom, false);
        if (contextSym !== null) contextSym.isDefined = true;
        offset += 4;
      }
      return;
    }

    this._runInstructionAnalyzer();

    this._postProcessGotAccesses();
    this._processElfRelocSymbols();

    // Branches
    for (const [instrOffset, targetBranchVram] of this.instrAnalyzer.branchInstrOffsets) {
      if (GlobalConfig.INPUT_FILE_TYPE === InputFileType.ELF) {
        if (this.context.globalRelocationOverrides.has(this.getVromOffset(instrOffset))) continue;
      }
      const branch = this.instrAnalyzer.branchTargetInstrOffsets.get(instrOffset);
      const labelSym = this.addBranchLabel(targetBranchVram, true, this.getVromOffset(branch));
      labelSym.referenceCounter += 1;
      labelSym.referenceFunctions.add(this.contextSym);
      labelSym.parentFunction = this.contextSym;
      labelSym.parentFileName = this.contextSym.parentFileName;
      this.contextSym.branchLabels.add(labelSym.vram, labelSym);
    }

    // Function calls
    for (const [instrOffset, targetVram] of this.instrAnalyzer.funcCallInstrOffsets) {
      if (this.context.isAddressBanned(targetVram)) continue;

      if (GlobalConfig.INPUT_FILE_TYPE === InputFileType.ELF) {
        if (this.context.globalRelocationOverrides.has(this.getVromOffset(instrOffset))) continue;
      }
      const funcSym = this.addFunction(targetVram, true);
      funcSym.referenceCounter += 1;
      funcSym.referenceFunctions.add(this.contextSym);
    }

    const v142 = atLeast("1.42.0");
    const smallTypes = v142 ? new Set(["u16", "s16", "s8", "u8"]) : new Set(["u16", "s16", "u8"]);

    // Symbols
    for (const [loOffset, symVram0] of this.instrAnalyzer.symbolLoInstrOffset) {
      let symVram = symVram0;
      if (this.context.isAddressBanned(symVram)) continue;

      if (GlobalConfig.INPUT_FILE_TYPE === InputFileType.ELF) {
        if (this.context.globalRelocationOverrides.has(this.getVromOffset(loOffset))) continue;
      }

      const symAccessDict = this.instrAnalyzer.possibleSymbolTypes.get(symVram);
      let symAccess = null;
      if (symAccessDict !== undefined && symAccessDict.size === 1) {
        // Infer type info if there's only one access type
        symAccess = symAccessDict.keys().next().value;
      }

      let contextSym = this.addSymbol(symVram, undefined, true, null, true);
      if (contextSym !== null) {
        // TODO: do this in a less ugly way
        if (contextSym.address !== symVram) {
          if (contextSym.address % 4 !== 0 || symVram % 4 !== 0) {
            if (smallTypes.has(contextSym.getType()) || (symAccess !== null && (isAccess(symAccess.accessType, "BYTE") || isAccess(symAccess.accessType, "SHORT")))) {
              if (!(contextSym.getSize() > 4)) {
                if (contextSym.userDeclaredSize === null || symVram >= contextSym.address + contextSym.userDeclaredSize) {
                  if (symAccess !== null) contextSym.setAccessTypeIfUnset(symAccess.accessType, symAccess.unsignedMemoryAccess);
                  contextSym.setFirstLoAccessIfUnset(loOffset);
                  contextSym = this.addSymbol(symVram, undefined, true);
                }
              }
            }
          }
        }
      }

      contextSym.referenceCounter += 1;
      contextSym.referenceFunctions.add(this.contextSym);
      contextSym.setFirstLoAccessIfUnset(loOffset);
      if (symAccess !== null) {
        contextSym.setAccessTypeIfUnset(symAccess.accessType, symAccess.unsignedMemoryAccess);
        if (contextSym.isAutogenerated) {
          // Handle mips1 doublefloats
          if (isAccess(contextSym.accessType, "FLOAT") && GlobalConfig.ABI === Abi.O32) {
            const instr = this.instructions[loOffset / 4];
            if (instr.doesDereference() && instr.isFloat() && !instr.isDouble()) {
              if (enumValue(instr.ft) % 2 !== 0) {
                // lwc1/swc1 with an odd fpr means it is an mips1 doublefloats reference
                if (symVram % 8 !== 0) {
                  // We need to remove the the symbol pointing to the middle of this doublefloats
                  const got = contextSym.isGot;
                  const gotLocal = contextSym.isGotLocal;
                  const gotGlobal = contextSym.isGotGlobal;
                  this.removeSymbol(symVram);

                  // Align down to 8
                  symVram = Math.floor(symVram / 8) * 8;
                  contextSym = this.addSymbol(symVram, undefined, true);
                  contextSym.referenceCounter += 1;
                  contextSym.referenceFunctions.add(this.contextSym);
                  contextSym.setFirstLoAccessIfUnset(loOffset);
                  contextSym.isGot = got;
                  contextSym.isGotLocal = gotLocal;
                  contextSym.isGotGlobal = gotGlobal;
                }
                contextSym.accessType = rabbitizer.AccessType.DOUBLEFLOAT;
                contextSym.unsignedAccessType = false;
                contextSym.isMips1Double = true;
              }
            }
          }
        }
      }
    }

    this._generateRelocsFromInstructionAnalyzer();

    // Jump tables
    for (const targetVram of this.instrAnalyzer.referencedJumpTableOffsets.values()) {
      const jumpTable = this.addJumpTable(targetVram, true);
      jumpTable.parentFunction = this.contextSym;
      this.contextSym.jumpTables.add(jumpTable.vram, jumpTable);
    }

    if (this.isLikelyHandwritten) {
      for (const instr of this.instructions) instr.inHandwrittenFunction = this.isLikelyHandwritten;
    }

    this.contextSym.autodetectedSize = this.sizew * 4;

    this.referencedVrams = this.instrAnalyzer.referencedVrams;
  }

  countExtraPadding() {
    let count = 0;
    if (this.contextSym.userDeclaredSize === this.sizew * 4) return 0;

    for (let i = this.instructions.length - 1; i > 0; i--) {
      const instr = this.instructions[i];
      const nextInstr = this.instructions[i - 1];

      if (nextInstr.hasDelaySlot()) return count;
      if (!instr.isNop()) return count;

      count += 1;
    }
    return count;
  }

  countDiffOpcodes(other) {
    let result = 0;
    for (let i = 0; i < Math.min(this.nInstr, other.nInstr); i++) {
      if (!this.instructions[i].sameOpcode(other.instructions[i])) result += 1;
    }
    return result;
  }

  countSameOpcodeButDifferentArguments(other) {
    let result = 0;
    for (let i = 0; i < Math.min(this.nInstr, other.nInstr); i++) {
      if (this.instructions[i].sameOpcodeButDifferentArguments(other.instructions[i])) result += 1;
    }
    return result;
  }

  blankOutDifferences(other_func) {
    if (!GlobalConfig.REMOVE_POINTERS) return false;
    let was_updated = false;
    for (let i = 0; i < Math.min(this.nInstr, other_func.nInstr); i++) {
      const instr1 = this.instructions[i];
      const instr2 = other_func.instructions[i];
      if (instr1.sameOpcodeButDifferentArguments(instr2)) {
        instr1.blankOut();
        instr2.blankOut();
        was_updated = true;
      }
    }
    return was_updated;
  }

  removePointers() {
    if (!GlobalConfig.REMOVE_POINTERS) return false;

    let was_updated = false;

    for (const instructionOffset of this.instrAnalyzer.symbolInstrOffset.keys()) this.instructions[instructionOffset / 4].blankOut();
    was_updated = this.instrAnalyzer.symbolInstrOffset.size > 0 || was_updated;

    for (const fileOffset of this.pointersOffsets) {
      const index = Math.floor((fileOffset - this.inFileOffset) / 4);
      if (index < 0) continue;
      if (index >= this.nInstr) continue;
      this.instructions[index].blankOut();
    }

    if (GlobalConfig.IGNORE_BRANCHES) {
      for (const instructionOffset of this.instrAnalyzer.branchInstrOffsets.keys()) this.instructions[instructionOffset / 4].blankOut();
      was_updated = this.instrAnalyzer.branchInstrOffsets.size > 0 || was_updated;
    }

    this.pointersRemoved = true;

    return was_updated;
  }

  removeTrailingNops() {
    let was_updated = false;
    let first_nop = this.nInstr;

    for (let i = this.nInstr - 1; i >= 0; i--) {
      const instr = this.instructions[i];
      if (!instr.isNop()) {
        if (instr.isReturn()) first_nop += 1;
        break;
      }
      first_nop = i;
    }

    if (first_nop < this.nInstr) {
      was_updated = true;
      this.instructions.splice(first_nop);
    }
    return was_updated;
  }

  _generateHiLoConstantReloc(constantValue, currentInstr, loInstr) {
    if (loInstr === null) {
      if (currentInstr.canBeHi()) return new RelocationInfo(RelocType.CUSTOM_CONSTANT_HI, `0x${hexU(constantValue)}`);
      return null;
    }

    if (loInstr.canBeLo()) {
      if (loInstr.isUnsigned()) {
        if (currentInstr.canBeHi()) return new RelocationInfo(RelocType.CUSTOM_CONSTANT_HI, `0x${hexU(constantValue)}`);
        if (currentInstr.canBeLo()) return new RelocationInfo(RelocType.CUSTOM_CONSTANT_LO, `0x${hexU(constantValue)}`);
        return null;
      } else {
        const loHalf = Number(BigInt(constantValue) & 0xffffn);
        if (loHalf < 0x8000) {
          // positive lo half
          if (currentInstr.canBeHi()) return new RelocationInfo(RelocType.CUSTOM_CONSTANT_HI, `0x${hexU(constantValue)}`);
          if (currentInstr.canBeLo()) return new RelocationInfo(RelocType.CUSTOM_CONSTANT_LO, `0x${hexU(constantValue)}`);
        } else {
          // negative lo half
        }
      }
    }
    return null;
  }

  /** Returns [immOverride|null, relocInfo|null] */
  _getImmOverrideForInstruction(instr, instrOffset, isSplittedSymbol = false) {
    if (this.pointersRemoved) return [null, null];

    let relocInfo = this.getReloc(instrOffset);
    if (relocInfo !== null) {
      if (relocInfo.isRelocNone()) {
        if (instr.isJumpWithAddress()) return [`0x${hexU(instr.getInstrIndexAsVram(), 8)}`, relocInfo];
      } else {
        const ignoredRelocs = new Set();
        if (this.gpRelHack) ignoredRelocs.add(RelocType.MIPS_GPREL16);
        return [relocInfo.getNameWithReloc(isSplittedSymbol, ignoredRelocs), relocInfo];
      }
    }

    if (instr.isBranch() || instr.isUnconditionalBranch()) {
      if (GlobalConfig.IGNORE_BRANCHES) return [null, null];
      const branchOffset = instr.getBranchOffsetGeneric();
      const targetBranchVram = this.getVramOffset(instrOffset + branchOffset);
      const labelSymbol = this.getSymbol(targetBranchVram, null, false);
      if (labelSymbol !== null) return [labelSymbol.getName(), null];
      return [null, null];
    }

    if (instr.hasOperandAlias(rabbitizer.OperandType.cpu_immediate)) {
      if (this.instrAnalyzer.symbolInstrOffset.has(instrOffset)) {
        const address = this.instrAnalyzer.symbolInstrOffset.get(instrOffset);
        relocInfo = this._generateHiLoConstantReloc(address, instr, instr);
        if (relocInfo !== null) return [relocInfo.getNameWithReloc(isSplittedSymbol), relocInfo];
      } else if (instr.canBeHi()) {
        // Unpaired LUI
        relocInfo = this._generateHiLoConstantReloc(instr.getProcessedImmediate() * 0x10000, instr, null);
        if (relocInfo !== null) return [relocInfo.getNameWithReloc(isSplittedSymbol), relocInfo];
      }
    }

    return [null, null];
  }

  getLabelForOffset(instructionOffset, migrate = false) {
    if (GlobalConfig.IGNORE_BRANCHES || instructionOffset === 0) {
      // Skip over this function to avoid duplication
      return "";
    }

    const currentVram = this.getVramOffset(instructionOffset);
    const currentVrom = this.getVromOffset(instructionOffset);
    const labelSym = this.getSymbol(currentVram, currentVrom, false);

    if (labelSym === null || labelSym.overlayCategory !== this.overlayCategory) return "";

    labelSym.isDefined = true;
    labelSym.sectionType = this.sectionType;
    labelSym.vromAddress = currentVrom;
    const labelSymType = labelSym.getTypeSpecial();

    let useLabelMacro =
      labelSymType === null ||
      labelSymType === SymbolSpecialType.function ||
      (labelSymType === SymbolSpecialType.jumptablelabel && !migrate) ||
      labelSymType === SymbolSpecialType.gccexcepttablelabel;
    if (!useLabelMacro) {
      if (GlobalConfig.ASM_GLOBALIZE_TEXT_LABELS_REFERENCED_BY_NON_JUMPTABLE) {
        // Check if any non-jumptable symbol references this label
        for (const otherSym of labelSym.referenceSymbols) {
          if (otherSym.getTypeSpecial() !== SymbolSpecialType.jumptable) {
            useLabelMacro = true;
            break;
          }
        }
      }
    }

    let label;
    if (useLabelMacro) {
      label = labelSym.getReferenceeSymbols();
      const labelMacro = labelSym.getLabelMacro(true);
      if (labelMacro !== null) label += `${labelMacro} ${labelSym.getName()}${GlobalConfig.LINE_ENDS}`;
      if (GlobalConfig.ASM_TEXT_FUNC_AS_LABEL) label += `${labelSym.getName()}:${GlobalConfig.LINE_ENDS}`;
    } else {
      label = labelSym.getName() + ":" + GlobalConfig.LINE_ENDS;
    }
    label = " ".repeat(GlobalConfig.ASM_INDENTATION_LABELS) + label;
    if (atLeast("1.39.0") && GlobalConfig.ASM_EMIT_ALIGN_BRANCH_LABELS) label = `${this._getAlignDirectiveStr(2, instructionOffset)}${label}`;
    return label;
  }

  _emitInstruction(instr, instructionOffset, wasLastInstABranch, isSplittedSymbol = false) {
    const [immOverride, relocInfo] = this._getImmOverrideForInstruction(instr, instructionOffset, isSplittedSymbol);
    let comment = this.generateAsmLineComment(instructionOffset, instr.getRaw());
    let extraLJust = 0;

    if (wasLastInstABranch) {
      extraLJust = -1;
      comment += " ";
    }

    let line = instr.disassemble(immOverride, extraLJust);

    if (this.gpRelHack) {
      // Get rid of `%gp_rel` and `$gp` since old assemblers don't support `%gp_rel`.
      if (relocInfo !== null && relocInfo.relocType === RelocType.MIPS_GPREL16) {
        if (instr.canBeLo() && instr.doesDereference()) {
          line = line.replace("($gp)", "").replace("($28)", "");
        } else if (sameRabbitizerEnum(instr.uniqueId, rabbitizer.InstrId.cpu_addiu)) {
          line = line.replace("addiu ", "la    ").replace(", $gp, ", ", ").replace(", $28, ", ", ");
        }

        let endComment = this.endOfLineComment.has(instructionOffset / 4) ? this.endOfLineComment.get(instructionOffset / 4) : "";
        if (!endComment.includes(" /* gp_rel: ")) {
          endComment += ` /* gp_rel: ${immOverride === null ? "None" : immOverride} */`;
          this.endOfLineComment.set(instructionOffset / 4, endComment);
        }
      }
    }

    return `${comment}  ${line}`;
  }

  _emitCpload(instr, instructionOffset, wasLastInstABranch, isSplittedSymbol = false) {
    let output = "";

    const cpload = this.instrAnalyzer.cploads.get(instructionOffset);
    if (cpload !== undefined) {
      const hiInstr = this.instructions[cpload.hiOffset / 4];
      const loInstr = this.instructions[cpload.loOffset / 4];
      let gpDisp = hiInstr.getProcessedImmediate() * 0x10000;
      gpDisp += loInstr.getProcessedImmediate();
      output += `/* _gp_disp: 0x${hexU(gpDisp)} */${GlobalConfig.LINE_ENDS}`;
      if (GlobalConfig.EMIT_CPLOAD) {
        if (cpload.reg === null) throw new Error("AssertionError");
        output += `.cpload $${cpload.reg.name}`;
      } else {
        output += this._emitInstruction(instr, instructionOffset, wasLastInstABranch, isSplittedSymbol);
      }
    } else if (!GlobalConfig.EMIT_CPLOAD) {
      output += this._emitInstruction(instr, instructionOffset, wasLastInstABranch, isSplittedSymbol);
    }
    // don't emit the other instructions which are part of .cpload if the directive was emitted
    return output;
  }

  disassemble(migrate = false, useGlobalLabel = true, isSplittedSymbol = false) {
    let output = "";

    if (migrate) output += this.getSpimdisasmVersionString();

    const asData = atLeast("1.42.0")
      ? (!GlobalConfig.DISASSEMBLE_UNKNOWN_INSTRUCTIONS && this.hasUnimplementedIntrs) || typeof this.contextSym.getTypeSpecial() === "string"
      : !GlobalConfig.DISASSEMBLE_UNKNOWN_INSTRUCTIONS && this.hasUnimplementedIntrs;
    if (asData) return this.disassembleAsData(useGlobalLabel, isSplittedSymbol);

    if (!GlobalConfig.PIC && this.gpRelHack && this.instrAnalyzer.gpReferencedSymbols.size > 0) {
      output += `/* Symbols accessed via $gp register */${GlobalConfig.LINE_ENDS}`;
      for (const gpAddress of this.instrAnalyzer.gpReferencedSymbols) {
        const gpSym = this.getSymbol(gpAddress, null, true);
        if (gpSym !== null) output += `.extern ${gpSym.getName()}, 1${GlobalConfig.LINE_ENDS}`;
      }
      output += GlobalConfig.LINE_ENDS;
    }

    output += this.contextSym.getReferenceeSymbols();
    output += this.getPrevAlignDirective(0);

    if (this.isLikelyHandwritten && GlobalConfig.ASM_COMMENT) {
      if (!this.isRsp) {
        // RSP functions are always handwritten, so this is redundant
        output += "/* Handwritten function */" + GlobalConfig.LINE_ENDS;
      }
    }

    this._generateRelocsFromInstructionAnalyzer();

    const symName = this.getName();

    let symSize = this.contextSym.getSize();
    if (this.contextSym.userDeclaredSize === null) {
      // Fixup symbol size to avoid counting padding as part of the symbol
      // on the emitted size and end directives.
      symSize -= 4 * this.countExtraPadding();
    }

    output += this.getNonMatchingLabel(symName, symSize);
    output += this.getSymbolAsmDeclaration(symName, useGlobalLabel);

    let wasLastInstABranch = false;
    let instructionOffset = 0;
    for (const instr of this.instructions) {
      let currentLine = this.getLabelForOffset(instructionOffset, migrate);

      const isCpload = this.instrAnalyzer.cploadOffsets.has(instructionOffset);
      if (isCpload) currentLine += this._emitCpload(instr, instructionOffset, wasLastInstABranch, isSplittedSymbol);
      else currentLine += this._emitInstruction(instr, instructionOffset, wasLastInstABranch, isSplittedSymbol);

      currentLine += this.getEndOfLineComment(instructionOffset / 4);
      if (currentLine !== "") currentLine += GlobalConfig.LINE_ENDS;

      if (GlobalConfig.EMIT_INLINE_RELOC) {
        const relocInfo = this.getReloc(instructionOffset);
        currentLine += this.relocToInlineStr(relocInfo, isSplittedSymbol);
      }

      output += currentLine;

      wasLastInstABranch = instr.hasDelaySlot();
      instructionOffset += 4;

      if (instructionOffset === symSize) {
        if (GlobalConfig.ASM_TEXT_END_LABEL) {
          const endName = atLeast("1.39.0") ? symName : this.getName();
          output += `${GlobalConfig.ASM_TEXT_END_LABEL} ${endName}` + GlobalConfig.LINE_ENDS;
        }
        output += this.getSizeDirective(symName);
      }
    }

    const nameEnd = this.getNameEnd();
    if (nameEnd !== null) output += this.getSymbolAsmDeclaration(nameEnd, useGlobalLabel);

    return output;
  }

  disassembleAsData(useGlobalLabel = true, isSplittedSymbol = false) {
    this.contextSym.setTypeSpecial("u32", true);
    this.words = [];
    this.instructions.forEach((instr, i) => {
      if (!instr.isImplemented() || !instr.isValid()) this.endOfLineComment.set(i, " /* invalid instruction */");
      this.words.push(instr.getRaw());
    });
    return super.disassembleAsData(useGlobalLabel, isSplittedSymbol);
  }
}

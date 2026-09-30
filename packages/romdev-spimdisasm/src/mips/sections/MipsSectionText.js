// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/sections/MipsSectionText.py

import { rabbitizer } from "../../rabbitizer.js";
import { GlobalConfig, ArchLevel } from "../../common/GlobalConfig.js";
import { Compiler } from "../../common/CompilerConfig.js";
import { FileSectionType } from "../../common/FileSectionType.js";
import * as Utils from "../../common/Utils.js";
import { sortedNumbers } from "../../py/pyutils.js";
import { SymbolFunction } from "../symbols/MipsSymbolFunction.js";
import { sameRabbitizerEnum } from "../symbols/analysis/InstrAnalyzer.js";
import { SectionBase } from "./MipsSectionBase.js";

export class SectionText extends SectionBase {
  constructor(context, vromStart, vromEnd, vram, filename, array_of_bytes, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, vram, filename, Utils.bytesToWords(array_of_bytes, vromStart, vromEnd), FileSectionType.Text, segmentVromStart, overlayCategory);

    this.instrCat = rabbitizer.InstrCategory.CPU;
    this.detectRedundantFunctionEnd = null;
    /** Get rid of `%gp_rel` and `$gp` since old assemblers don't support `%gp_rel`. */
    this.gpRelHack = false;

    this.enableStringGuessing = false;
  }

  get nFuncs() {
    return this.symbolList.length;
  }

  static wordListToInstructions(wordList, currentVram, instrCat) {
    const instrsList = [];
    for (const word of wordList) {
      const instr = new rabbitizer.Instruction(word, 0, instrCat);
      if (currentVram !== null && currentVram !== undefined) {
        instr.vram = currentVram;
        currentVram += 4;
      }
      instrsList.push(instr);
    }
    return instrsList;
  }

  wordListToInstructions(wordList, currentVram, instrCat) {
    return SectionText.wordListToInstructions(wordList, currentVram, instrCat);
  }

  _isRsp() {
    return sameRabbitizerEnum(this.instrCat, rabbitizer.InstrCategory.RSP);
  }

  getAsmPrelude_instructionDirectives() {
    let output = "";
    output += `/* assembler directives */${GlobalConfig.LINE_ENDS}`;
    output += `.set noat      /* allow manual use of $at */${GlobalConfig.LINE_ENDS}`;
    output += `.set noreorder /* do not insert nops after branches */${GlobalConfig.LINE_ENDS}`;
    if (GlobalConfig.ARCHLEVEL.value >= ArchLevel.MIPS3.value) output += `.set gp=64     /* allow use of 64-bit general purpose registers */${GlobalConfig.LINE_ENDS}`;
    output += GlobalConfig.LINE_ENDS;
    return output;
  }

  tryDetectRedundantFunctionEnd() {
    if (GlobalConfig.COMPILER !== Compiler.IDO) return false;
    if (this.detectRedundantFunctionEnd === null || this.detectRedundantFunctionEnd === undefined) return GlobalConfig.DETECT_REDUNDANT_FUNCTION_END;
    return this.detectRedundantFunctionEnd;
  }

  _findFunctions_branchChecker(instructionOffset, instr, funcsStartsList, unimplementedInstructionsFuncList, farthestBranch, isLikelyHandwritten, isInstrImplemented) {
    let haltFunctionSearching = false;

    if (instr.isJumpWithAddress()) {
      // If this instruction is a jump and it is jumping to a function then
      // don't treat it as a branch, it is probably actually being used as
      // a jump
      const targetVram = instr.getInstrIndexAsVram();
      const auxSym = this.getSymbol(targetVram, null, false, true, false);

      if (auxSym !== null && auxSym.isTrustableFunction(this._isRsp())) return [farthestBranch, haltFunctionSearching];
    }

    if (instr.doesLink()) {
      // This is used more as a function call than as an actual branch
      return [farthestBranch, haltFunctionSearching];
    }

    const branchOffset = instr.getBranchOffsetGeneric();
    // keep track of the farthest branch target
    farthestBranch = Math.max(farthestBranch, branchOffset);
    if (branchOffset < 0) {
      if (branchOffset + instructionOffset < 0) {
        // Whatever we are reading is not a valid instruction
        if (!instr.isJump()) haltFunctionSearching = true;
      }
      // make sure to not branch outside of the current function
      if (!isLikelyHandwritten && isInstrImplemented) {
        let j = funcsStartsList.length - 1;
        while (j >= 0) {
          if (branchOffset + instructionOffset < 0) break;
          const otherFuncStartOffset = funcsStartsList[j] * 4;
          if (branchOffset + instructionOffset < otherFuncStartOffset) {
            const vram = this.getVramOffset(otherFuncStartOffset);
            const vromAddress = this.getVromOffset(otherFuncStartOffset);
            const funcSymbol = this.getSymbol(vram, vromAddress, false, true, false);
            if (funcSymbol !== null && funcSymbol.isTrustableFunction(this._isRsp())) {
              j -= 1;
              continue;
            }
            funcsStartsList.splice(j, 1);
            // Python: del unimplementedInstructionsFuncList[j-1] (j-1 may be -1)
            let k = j - 1;
            if (k < 0) k += unimplementedInstructionsFuncList.length;
            if (k < 0 || k >= unimplementedInstructionsFuncList.length) throw new Error("IndexError: list assignment index out of range");
            unimplementedInstructionsFuncList.splice(k, 1);
          } else {
            break;
          }
          j -= 1;
        }
      }
    }
    return [farthestBranch, haltFunctionSearching];
  }

  _findFunctions_checkFunctionHalted(instructionOffset, currentVrom, currentVram, currentInstructionStart) {
    if (instructionOffset === currentInstructionStart) {
      // Check if we have a function after the first instruction of the current function.
      const funcSymbol = this.getSymbol(currentVram + 4, currentVrom + 4, false, true, false);
      if (funcSymbol !== null && funcSymbol.isTrustableFunction(this._isRsp())) {
        if (funcSymbol.vromAddress === null || currentVrom + 4 === funcSymbol.vromAddress) return true;
      }
    }
    return false;
  }

  _findFunctions_checkFunctionEnded(instructionOffset, instr, index, currentVrom, currentVram, currentFunctionSym, farthestBranch, currentInstructionStart, isLikelyHandwritten, instrsList, nInstr) {
    let functionEnded = false;
    let prevFuncHadUserDeclaredSize = false;
    let functionHalted = false;

    // Try to find the end of the function
    if (currentFunctionSym !== null && currentFunctionSym.userDeclaredSize !== null) {
      // If the function has a size set by the user then only use that and ignore the other ways of determining function-ends
      if (instructionOffset + 8 === currentInstructionStart + currentFunctionSym.getSize()) {
        functionEnded = true;
        prevFuncHadUserDeclaredSize = true;
      }
    } else if (this._findFunctions_checkFunctionHalted(instructionOffset, currentVrom, currentVram, currentInstructionStart)) {
      functionEnded = true;
      functionHalted = true;
    } else {
      const funcSymbol = this.getSymbol(currentVram + 8, currentVrom + 8, false, true, false);
      // If there's another function after this then the current function has ended
      if (funcSymbol !== null && funcSymbol.isTrustableFunction(this._isRsp())) {
        if (funcSymbol.vromAddress === null || currentVrom + 8 === funcSymbol.vromAddress) functionEnded = true;
      }

      if (!functionEnded && !(farthestBranch > 0) && instr.isJump()) {
        if (instr.isReturn()) {
          // Found a jr $ra and there are no branches outside of this function
          if (this.tryDetectRedundantFunctionEnd()) {
            let redundantPatternDetected = false;
            if (index + 3 < nInstr) {
              const instr1 = instrsList[index + 1];
              const instr2 = instrsList[index + 2];
              const instr3 = instrsList[index + 3];
              if (funcSymbol === null && instr1.isNop() && instr2.isReturn() && instr3.isNop()) redundantPatternDetected = true;
            }
            if (!redundantPatternDetected) functionEnded = true;
          } else {
            functionEnded = true;
          }
        } else if (instr.isJumptableJump()) {
          // Usually jumptables, ignore
        } else if (!instr.doesLink()) {
          if (isLikelyHandwritten || this._isRsp()) {
            functionEnded = true;
          } else if (instr.isJumpWithAddress()) {
            // tail-call optimization
            if (!rabbitizer.config.toolchainTweaks_treatJAsUnconditionalBranch) {
              functionEnded = true;
            } else {
              const targetVram = instr.getInstrIndexAsVram();
              const auxSym = this.getSymbol(targetVram, null, false, true, false);
              if (auxSym !== null && auxSym.isTrustableFunction(this._isRsp())) functionEnded = true;
            }
          }
        }
      }
    }

    return [functionEnded, prevFuncHadUserDeclaredSize, functionHalted];
  }

  _findFunctions(instrsList) {
    const nInstr = instrsList.length;

    if (nInstr === 0) return [[0], [false]];

    let functionEnded = false;
    let functionHalted = false;
    let farthestBranch = 0;
    const funcsStartsList = [0];
    const unimplementedInstructionsFuncList = [];

    let instructionOffset = 0;
    let currentInstructionStart = 0;
    let currentFunctionSym = this.getSymbol(this.getVramOffset(instructionOffset), this.getVromOffset(instructionOffset), false, true, false);

    let isLikelyHandwritten = this.isHandwritten;

    let isInstrImplemented = true;
    let index = 0;

    if (instrsList[0].isNop()) {
      // Loop over until we find a instruction that isn't a nop
      while (index < nInstr) {
        if (currentFunctionSym !== null) break;

        const instr = instrsList[index];
        if (!instr.isNop()) break;
        index += 1;
        instructionOffset += 4;

        currentInstructionStart = instructionOffset;
        currentFunctionSym = this.getSymbol(this.getVramOffset(instructionOffset), this.getVromOffset(instructionOffset), false, true, false);
      }

      if (index !== 0) {
        funcsStartsList.push(index);
        unimplementedInstructionsFuncList.push(!isInstrImplemented);
      }
    }

    let prevFuncHadUserDeclaredSize = false;

    while (index < nInstr) {
      let instr = instrsList[index];
      if (!instr.isImplemented() || !instr.isValid()) isInstrImplemented = false;

      if (functionEnded) {
        functionEnded = false;

        isLikelyHandwritten = this.isHandwritten;
        if (!functionHalted) {
          index += 1;
          instructionOffset += 4;
        }
        functionHalted = false;

        let auxSym = this.getSymbol(this.getVramOffset(instructionOffset), this.getVromOffset(instructionOffset), false, true, false);

        // Loop over until we find a instruction that isn't a nop
        while (index < nInstr) {
          if (auxSym !== null) break;

          instr = instrsList[index];
          if (!instr.isNop()) break;
          index += 1;
          instructionOffset += 4;

          auxSym = this.getSymbol(this.getVramOffset(instructionOffset), this.getVromOffset(instructionOffset), false, true, false);
        }

        currentInstructionStart = instructionOffset;
        currentFunctionSym = auxSym;

        funcsStartsList.push(index);
        unimplementedInstructionsFuncList.push(!isInstrImplemented);
        if (index >= nInstr) break;
        if (prevFuncHadUserDeclaredSize) {
          auxSym = this.addFunction(this.getVramOffset(instructionOffset), true, this.getVromOffset(instructionOffset));
          auxSym.isAutocreatedSymFromOtherSizedSym = true;
        }
        prevFuncHadUserDeclaredSize = false;
        instr = instrsList[index];
        isInstrImplemented = instr.isImplemented() && instr.isValid();
      }

      const currentVram = this.getVramOffset(instructionOffset);
      const currentVrom = this.getVromOffset(instructionOffset);

      if (!this._isRsp() && !isLikelyHandwritten) isLikelyHandwritten = instr.isLikelyHandwritten();

      if (instr.isBranch() || instr.isUnconditionalBranch()) {
        let haltFunctionSearching;
        [farthestBranch, haltFunctionSearching] = this._findFunctions_branchChecker(instructionOffset, instr, funcsStartsList, unimplementedInstructionsFuncList, farthestBranch, isLikelyHandwritten, isInstrImplemented);
        if (haltFunctionSearching) break;
      }

      [functionEnded, prevFuncHadUserDeclaredSize, functionHalted] = this._findFunctions_checkFunctionEnded(instructionOffset, instr, index, currentVrom, currentVram, currentFunctionSym, farthestBranch, currentInstructionStart, isLikelyHandwritten, instrsList, nInstr);

      index += 1;
      farthestBranch -= 4;
      instructionOffset += 4;
    }

    unimplementedInstructionsFuncList.push(!isInstrImplemented);
    return [funcsStartsList, unimplementedInstructionsFuncList];
  }

  _findCalls(instrsList) {
    // A simple pass to gather function calls.
    for (const instr of instrsList) {
      if (instr.doesLink()) {
        if (instr.isJumpWithAddress() || instr.isBranch()) {
          const funcVram = instr.getBranchVramGeneric();
          this.addFunction(funcVram, true);
        }
      }
    }
  }

  analyze() {
    const instrsList = this.wordListToInstructions(this.words, this.getVramOffset(0), this.instrCat);
    const nInstr = instrsList.length;

    this._findCalls(instrsList);
    const [funcsStartsList, unimplementedInstructionsFuncList] = this._findFunctions(instrsList);

    let previousSymbolExtraPadding = 0;
    const sectionAlign_text = GlobalConfig.COMPILER.value.sectionAlign_text;
    const textAlignment = sectionAlign_text !== null ? 2 ** sectionAlign_text : null;

    const startsCount = funcsStartsList.length;
    for (let startIndex = 0; startIndex < startsCount; startIndex++) {
      const start = funcsStartsList[startIndex];
      const hasUnimplementedIntrs = unimplementedInstructionsFuncList[startIndex];
      let end = nInstr;
      if (startIndex + 1 < startsCount) end = funcsStartsList[startIndex + 1];

      if (start >= end) break;

      const localOffset = start * 4;
      const vram = this.getVramOffset(localOffset);

      const vrom = this.getVromOffset(localOffset);
      const vromEnd = vrom + (end - start) * 4;

      if (GlobalConfig.DISASSEMBLE_UNKNOWN_INSTRUCTIONS || !hasUnimplementedIntrs) this.addFunction(vram, true, vrom);
      else this.addSymbol(vram, this.sectionType, true, vrom);

      this.symbolsVRams.add(vram);

      const func = new SymbolFunction(this.context, vrom, vromEnd, this.inFileOffset + localOffset, vram, instrsList.slice(start, end), this.segmentVromStart, this.overlayCategory);
      func.setCommentOffset(this.commentOffset);
      func.index = startIndex;
      func.pointersOffsets.update(this.pointersOffsets);
      func.hasUnimplementedIntrs = hasUnimplementedIntrs;
      func.parent = this;
      func.isRsp = this._isRsp();
      func.gpRelHack = this.gpRelHack;
      func.analyze();
      this.symbolList.push(func);

      if (textAlignment !== null) {
        // Section boundaries detection
        if ((this.vromStart + func.inFileOffset) % textAlignment === 0 && previousSymbolExtraPadding > 0) {
          this.fileBoundaries.push(func.inFileOffset);
        }
        previousSymbolExtraPadding = func.countExtraPadding();
      }
    }

    // Filter out repeated values and sort
    this.fileBoundaries = sortedNumbers(new Set(this.fileBoundaries));
  }

  compareToFile(other) {
    const result = super.compareToFile(other);
    if (other instanceof SectionText) {
      result.text = {
        diff_opcode: this.countDiffOpcodes(other),
        same_opcode_same_args: this.countSameOpcodeButDifferentArguments(other),
      };
    }
    return result;
  }

  countDiffOpcodes(other) {
    let result = 0;
    for (let i = 0; i < Math.min(this.nFuncs, other.nFuncs); i++) result += this.symbolList[i].countDiffOpcodes(other.symbolList[i]);
    return result;
  }

  countSameOpcodeButDifferentArguments(other) {
    let result = 0;
    for (let i = 0; i < Math.min(this.nFuncs, other.nFuncs); i++) result += this.symbolList[i].countSameOpcodeButDifferentArguments(other.symbolList[i]);
    return result;
  }

  blankOutDifferences(other_file) {
    if (!GlobalConfig.REMOVE_POINTERS) return false;
    if (!(other_file instanceof SectionText)) return false;

    let was_updated = false;
    for (let i = 0; i < Math.min(this.nFuncs, other_file.nFuncs); i++) {
      const func = this.symbolList[i];
      const other_func = other_file.symbolList[i];
      const func_updated = func.blankOutDifferences(other_func);
      if (func_updated) {
        let localOffset = func.inFileOffset - this.inFileOffset;
        func.instructions.forEach((instr, wordOffset) => {
          this.words[localOffset / 4 + wordOffset] = instr.getRaw();
        });
        localOffset = other_func.inFileOffset - other_file.inFileOffset;
        other_func.instructions.forEach((instr, wordOffset) => {
          other_file.words[localOffset / 4 + wordOffset] = instr.getRaw();
        });
      }
      was_updated = func_updated || was_updated;
    }
    return was_updated;
  }

  removePointers() {
    if (!GlobalConfig.REMOVE_POINTERS) return false;

    let was_updated = false;
    for (const func of this.symbolList) {
      const func_updated = func.removePointers();
      if (func_updated) {
        const localOffset = func.inFileOffset - this.inFileOffset;
        func.instructions.forEach((instr, wordOffset) => {
          this.words[localOffset / 4 + wordOffset] = instr.getRaw();
        });
      }
      was_updated = func_updated || was_updated;
    }
    return was_updated;
  }

  removeTrailingNops() {
    let was_updated = false;
    if (this.nFuncs > 0) {
      const func = this.symbolList.at(-1);
      func.removeTrailingNops();
      was_updated = true;
    }
    return was_updated;
  }

  getGpRelHack() {
    return this.gpRelHack;
  }

  setGpRelHack(value) {
    this.gpRelHack = value;
    for (const func of this.symbolList) func.gpRelHack = value;
  }

  suspectedPaddingGarbage() {
    const garbage = [];

    const sectionAlign_text = GlobalConfig.COMPILER.value.sectionAlign_text;
    const textAlignment = sectionAlign_text !== null ? 2 ** sectionAlign_text : null;
    if (textAlignment === null) return garbage;

    for (const func of this.symbolList) {
      if (func.sizew * 4 >= textAlignment) continue;
      if ((func.vram + func.sizew * 4) % textAlignment !== 0) continue;
      if (func.contextSym.referenceCounter !== 0) continue;

      if (func.sizew >= 2) {
        const instr = func.instructions.at(-2);
        if (instr.isJump() || instr.isBranch()) continue;
      }

      garbage.push(func.inFileOffset + func.sizew * 4);
    }

    return garbage;
  }
}

// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/MipsSymbolBss.py

import { FileSectionType } from "../../common/FileSectionType.js";
import { GlobalConfig } from "../../common/GlobalConfig.js";
import * as Utils from "../../common/Utils.js";
import { hexU } from "../../py/pyutils.js";
import { atLeast } from "../../version.js";
import { SymbolBase } from "./MipsSymbolBase.js";

export class SymbolBss extends SymbolBase {
  constructor(context, vromStart, vromEnd, inFileOffset, vram, spaceSize, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, inFileOffset, vram, [], FileSectionType.Bss, segmentVromStart, overlayCategory);
    this.spaceSize = spaceSize;
  }

  get sizew() {
    return Math.floor(this.spaceSize / 4);
  }

  analyze() {
    super.analyze();

    if (this.contextSym.hasUserDeclaredSize()) {
      // Check user declared size matches the size that will be generated
      const contextSymSize = this.contextSym.getSize();
      let sizeMismatch;
      if (atLeast("1.42.0")) {
        sizeMismatch = this.spaceSize < contextSymSize;
        if (GlobalConfig.CREATE_BSS_PADS) sizeMismatch = this.spaceSize !== contextSymSize;
      } else {
        sizeMismatch = this.spaceSize !== contextSymSize;
      }
      if (sizeMismatch) {
        const warningMessage = `
Range check triggered: .bss symbol (name: ${this.getName()}, address: 0x${hexU(this.contextSym.vram, 8)}):
    User declared size (0x${hexU(contextSymSize)}) does not match the .space that will be emitted (0x${hexU(this.spaceSize)}).
    Try checking the size again or look for symbols which overlaps this region`;
        if (GlobalConfig.PANIC_RANGE_CHECK) {
          if (this.spaceSize !== contextSymSize) throw new Error(`AssertionError: ${warningMessage}`);
        } else {
          Utils.eprint(`\n${warningMessage}\n`);
        }
      }
    }
  }

  disassembleAsBss(useGlobalLabel = true) {
    let output = this.contextSym.getReferenceeSymbols();
    output += this.getPrevAlignDirective(0);

    const symName = this.getName();

    if (!atLeast("1.42.0")) {
      output += this.getNonMatchingLabel(symName, this.spaceSize);
      output += this.getSymbolAsmDeclaration(symName, useGlobalLabel);
      output += this.generateAsmLineComment(0, null, false, false);
      output += ` .space 0x${hexU(this.spaceSize, 2)}${GlobalConfig.LINE_ENDS}`;
    } else {
      let symSize = null;
      if (!GlobalConfig.CREATE_BSS_PADS) {
        symSize = this.contextSym.userDeclaredSize;
        if (symSize !== null) {
          if (symSize <= 0 || symSize > this.spaceSize) symSize = null;
        }
      }

      let spaceSize = this.spaceSize;
      if (symSize !== null) spaceSize = symSize;

      output += this.getNonMatchingLabel(symName, spaceSize);
      output += this.getSymbolAsmDeclaration(symName, useGlobalLabel);
      output += this.generateAsmLineComment(0, null, false, false);
      output += ` .space 0x${hexU(spaceSize, 2)}${GlobalConfig.LINE_ENDS}`;

      if (symSize !== null) output += this._getSymEnd(symName);

      if (spaceSize !== this.spaceSize) {
        output += this.generateAsmLineComment(spaceSize, null, false, false);
        output += ` .space 0x${hexU(this.spaceSize - spaceSize, 2)}${GlobalConfig.LINE_ENDS}`;
      }
    }

    const nameEnd = this.getNameEnd();
    if (nameEnd !== null) output += this.getSymbolAsmDeclaration(nameEnd, useGlobalLabel);

    return output;
  }

  disassemble(_migrate = false, _useGlobalLabel = true, _isSplittedSymbol = false) {
    return this.disassembleAsBss();
  }
}

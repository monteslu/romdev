// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/MipsSymbolRodata.py

import { FileSectionType } from "../../common/FileSectionType.js";
import { GlobalConfig } from "../../common/GlobalConfig.js";
import { SymbolBase } from "./MipsSymbolBase.js";

export class SymbolRodata extends SymbolBase {
  constructor(context, vromStart, vromEnd, inFileOffset, vram, words, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, inFileOffset, vram, words, FileSectionType.Rodata, segmentVromStart, overlayCategory);
    this.stringEncoding = GlobalConfig.RODATA_STRING_ENCODING;
  }

  isJumpTable() {
    // jumptables must have at least 3 labels
    if (this.sizew < 3) return false;
    return this.contextSym.isJumpTable();
  }

  isMaybeConstVariable() {
    if (this.isFloat(0)) {
      if (this.sizew > 1) {
        for (const w of this.words.slice(1)) if (w !== 0) return true;
      }
      return false;
    } else if (this.isDouble(0)) {
      if (this.sizew > 2) {
        for (const w of this.words.slice(2)) if (w !== 0) return true;
      }
      return false;
    } else if (this.isJumpTable()) {
      return false;
    } else if (this.isString()) {
      return false;
    } else if (this.isPascalString()) {
      return false;
    }
    return true;
  }

  /** @deprecated Checks if the current symbol is .rdata */
  isRdata() {
    if (this.isMaybeConstVariable()) return true;
    // This symbol could be an unreferenced non-const variable
    if (this.contextSym.referenceFunctions.size === 1) return false;
    return true;
  }

  shouldMigrate() {
    if (this.contextSym.functionOwnerForMigration !== null) return true;
    if (this.contextSym.forceMigration) return true;
    if (this.contextSym.forceNotMigration) return false;
    if (this.contextSym.isMips1Double) return true;

    if (this.contextSym.referenceSymbols.size > 0) return false;
    if (this.contextSym.referenceFunctions.size > 1) return false;

    if (this.isMaybeConstVariable()) {
      if (GlobalConfig.ALLOW_MIGRATING_CONST_VARIABLES) return true;
      if (!GlobalConfig.COMPILER.value.allowRdataMigration) return false;
    }

    return true;
  }

  analyze() {
    if (this.contextSym.isDouble()) {
      if (this.sizew % 2 !== 0) {
        // doubles require an even amount of words
        this.contextSym.setTypeSpecial(null, true);
      } else {
        for (let i = 0; i < Math.floor(this.sizew / 2); i++) {
          if (!this.isDouble(i * 2)) {
            // checks there's no other overlaping symbols
            this.contextSym.setTypeSpecial(null, true);
            break;
          }
        }
      }
    }

    super.analyze();
  }

  countExtraPadding() {
    if (this.contextSym.hasUserDeclaredSize()) {
      if (this.sizew * 4 === this.contextSym.getSize()) return 0;
    }

    let count = 0;
    if (this.isString()) {
      for (let i = this.words.length - 1; i > 0; i--) {
        if (this.words[i] !== 0) break;
        if ((this.words[i - 1] & 0x000000ff) !== 0) break;
        count += 1;
      }
    } else if (this.isDouble(0)) {
      for (let i = this.words.length - 1; i > 0; i -= 2) {
        if (this.words[i] !== 0 || this.words[i - 1] !== 0) break;
        count += 2;
      }
    } else {
      for (let i = this.words.length - 1; i > 0; i--) {
        if (this.words[i] !== 0) break;
        count += 1;
      }
    }
    return count;
  }
}

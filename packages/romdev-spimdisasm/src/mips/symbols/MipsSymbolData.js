// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/MipsSymbolData.py

import { FileSectionType } from "../../common/FileSectionType.js";
import { GlobalConfig } from "../../common/GlobalConfig.js";
import * as Utils from "../../common/Utils.js";
import { hexU } from "../../py/pyutils.js";
import { SymbolBase } from "./MipsSymbolBase.js";

export class SymbolData extends SymbolBase {
  constructor(context, vromStart, vromEnd, inFileOffset, vram, words, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, inFileOffset, vram, words, FileSectionType.Data, segmentVromStart, overlayCategory);
  }

  analyze() {
    super.analyze();

    if (this.contextSym.hasUserDeclaredSize()) {
      // Check user declared size matches the size that will be generated
      const contextSymSize = this.contextSym.getSize();
      const actualSize = this.sizew * 4;
      if (actualSize < contextSymSize) {
        const warningMessage = `
Range check triggered: .data symbol (name: ${this.getName()}, address: 0x${hexU(this.contextSym.vram, 8)}):
    User declared size (0x${hexU(contextSymSize)}) does not match the amount of bytes that will be emitted (0x${hexU(actualSize)}).
    Try checking the size again or look for symbols which overlaps this region`;
        if (GlobalConfig.PANIC_RANGE_CHECK) {
          if (actualSize !== contextSymSize) throw new Error(`AssertionError: ${warningMessage}`);
        } else {
          Utils.eprint(`\n${warningMessage}\n`);
        }
      }
    }
  }
}

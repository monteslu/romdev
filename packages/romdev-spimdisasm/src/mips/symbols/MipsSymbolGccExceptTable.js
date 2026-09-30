// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/MipsSymbolGccExceptTable.py

import { FileSectionType } from "../../common/FileSectionType.js";
import { SymbolBase } from "./MipsSymbolBase.js";

export class SymbolGccExceptTable extends SymbolBase {
  constructor(context, vromStart, vromEnd, inFileOffset, vram, words, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, inFileOffset, vram, words, FileSectionType.GccExceptTable, segmentVromStart, overlayCategory);
  }
}

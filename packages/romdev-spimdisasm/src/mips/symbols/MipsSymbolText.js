// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/MipsSymbolText.py

import { FileSectionType } from "../../common/FileSectionType.js";
import { SymbolBase } from "./MipsSymbolBase.js";

export class SymbolText extends SymbolBase {
  constructor(context, vromStart, vromEnd, inFileOffset, vram, words, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, inFileOffset, vram, words, FileSectionType.Text, segmentVromStart, overlayCategory);
  }
}

// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/sections/MipsSectionGccExceptTable.py

import { rabbitizer } from "../../rabbitizer.js";
import { GlobalConfig } from "../../common/GlobalConfig.js";
import { FileSectionType } from "../../common/FileSectionType.js";
import * as Utils from "../../common/Utils.js";
import { SymbolGccExceptTable } from "../symbols/MipsSymbolGccExceptTable.js";
import { SectionBase } from "./MipsSectionBase.js";

/**
 * A `.gcc_except_table` section contains a single symbol that contains
 * information to handle C++ exceptions known as the Error Handler Table.
 */
export class SectionGccExceptTable extends SectionBase {
  constructor(context, vromStart, vromEnd, vram, filename, array_of_bytes, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, vram, filename, Utils.bytesToWords(array_of_bytes, vromStart, vromEnd), FileSectionType.GccExceptTable, segmentVromStart, overlayCategory);
  }

  _analyze_processExceptTable(localOffset, w, contextSym, lastVramSymbol, exceptTableSym, firstExceptTableWord) {
    if (contextSym !== null && contextSym.isGccExceptTable()) {
      exceptTableSym = contextSym;
      firstExceptTableWord = w;
    } else if (exceptTableSym !== null) {
      if (!this.pointersOffsets.has(localOffset)) {
        if (w === 0xffffffff) {
          // Except tables contain 2 negative ones at the end of the table.
        } else if (w === 0) {
          return [null, firstExceptTableWord];
        } else if (contextSym !== null) {
          return [null, firstExceptTableWord];
        } else if (((w >>> 24) & 0xff) !== ((firstExceptTableWord >>> 24) & 0xff)) {
          if (!(lastVramSymbol.isGccExceptTable() && lastVramSymbol.isGot && GlobalConfig.GP_VALUE !== null)) return [null, firstExceptTableWord];
        }
      }
    } else {
      return [null, firstExceptTableWord];
    }

    // Generate the current label
    if (w !== 0xffffffff && w !== 0) {
      let labelAddr = w;
      if (lastVramSymbol.isGot && GlobalConfig.GP_VALUE !== null) labelAddr = GlobalConfig.GP_VALUE + rabbitizer.Utils.from2Complement(w, 32);
      const labelSym = this.addGccExceptTableLabel(labelAddr, true);

      if (labelSym.unknownSegment) return [null, firstExceptTableWord];

      labelSym.referenceCounter += 1;
    }

    return [exceptTableSym, firstExceptTableWord];
  }

  analyze() {
    let lastVramSymbol = this._checkAndCreateFirstSymbol();
    let contextSym = null;

    // All symbols on this section are assumed to be except tables
    this.addGccExceptTable(this.getVramOffset(0), true, this.getVromOffset(0));

    const symbolList = [];
    let localOffset = 0;

    let exceptTableSym = null;
    let firstExceptTableWord = -1;
    let negativeOneCounter = 0;

    for (const w of this.words) {
      const currentVram = this.getVramOffset(localOffset);
      const currentVrom = this.getVromOffset(localOffset);

      if (w === 0) {
        if (!lastVramSymbol.isAutoCreatedPad) {
          const pad = this._addOwnedAutocreatedPad(localOffset);
          if (pad !== null) lastVramSymbol = pad;
        }
      }

      if (negativeOneCounter >= 2 && w !== 0) {
        // The except table ended
        contextSym = this._addOwnedSymbol(localOffset);
        if (contextSym !== null) {
          lastVramSymbol = contextSym;
          this.addGccExceptTable(currentVram, true, currentVrom);
        }
        negativeOneCounter = 0;
      } else {
        // Check if we have a symbol at this address, if not then use the last known one
        contextSym = this.getSymbol(currentVram, currentVrom, false);
        if (contextSym !== null) lastVramSymbol = contextSym;
      }

      [exceptTableSym, firstExceptTableWord] = this._analyze_processExceptTable(localOffset, w, contextSym, lastVramSymbol, exceptTableSym, firstExceptTableWord);

      if (exceptTableSym === null) {
        if (contextSym !== null || this.popPointerInDataReference(currentVram) !== null || (lastVramSymbol.isGccExceptTable() && w !== 0)) {
          contextSym = this._addOwnedSymbol(localOffset);
          if (contextSym !== null) lastVramSymbol = contextSym;
        }

        this.checkWordIsASymbolReference(w);
      }

      if (contextSym !== null) {
        this.symbolsVRams.add(currentVram);
        symbolList.push([localOffset, currentVram]);

        this._createAutoPadFromSymbol(localOffset, contextSym);
      }

      if (w === 0xffffffff) negativeOneCounter += 1;

      localOffset += 4;
    }

    for (let i = 0; i < symbolList.length; i++) {
      const [offset, vram] = symbolList[i];
      let words;
      if (i + 1 === symbolList.length) {
        words = this.words.slice(offset / 4);
      } else {
        const nextOffset = symbolList[i + 1][0];
        words = this.words.slice(offset / 4, nextOffset / 4);
      }

      const vrom = this.getVromOffset(offset);
      const vromEnd = vrom + words.length * 4;
      const sym = new SymbolGccExceptTable(this.context, vrom, vromEnd, offset + this.inFileOffset, vram, words, this.segmentVromStart, this.overlayCategory);
      sym.parent = this;
      sym.setCommentOffset(this.commentOffset);
      sym.analyze();
      this.symbolList.push(sym);
    }

    this.processStaticRelocs();
  }
}

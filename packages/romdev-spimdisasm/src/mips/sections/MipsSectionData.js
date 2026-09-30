// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/sections/MipsSectionData.py

import { GlobalConfig } from "../../common/GlobalConfig.js";
import { FileSectionType } from "../../common/FileSectionType.js";
import { symEq } from "../../common/ContextSymbols.js";
import * as Utils from "../../common/Utils.js";
import { atLeast } from "../../version.js";
import { SymbolData } from "../symbols/MipsSymbolData.js";
import { SectionBase } from "./MipsSectionBase.js";

export class SectionData extends SectionBase {
  constructor(context, vromStart, vromEnd, vram, filename, array_of_bytes, segmentVromStart, overlayCategory) {
    let words;
    if (GlobalConfig.ENDIAN_DATA !== null) words = Utils.endianessBytesToWords(GlobalConfig.ENDIAN_DATA, array_of_bytes, vromStart, vromEnd);
    else words = Utils.bytesToWords(array_of_bytes, vromStart, vromEnd);
    super(context, vromStart, vromEnd, vram, filename, words, FileSectionType.Data, segmentVromStart, overlayCategory);
  }

  analyze() {
    this._checkAndCreateFirstSymbol();

    let symbolList = [];
    let localOffset = 0;
    const localOffsetsWithSymbols = new Set();

    let needsFurtherAnalyzis = false;

    const v142 = atLeast("1.42.0");
    const ownedSegment = v142 ? this.getSegment() : null;

    for (const w of this.words) {
      const currentVram = this.getVramOffset(localOffset);

      let contextSym = this._getOwnedSymbol(localOffset);
      if (contextSym !== null) {
        symbolList.push([localOffset, contextSym]);
        localOffsetsWithSymbols.add(localOffset);
      } else if (this.popPointerInDataReference(currentVram) !== null) {
        contextSym = this._addOwnedSymbol(localOffset);
        if (contextSym !== null) {
          symbolList.push([localOffset, contextSym]);
          localOffsetsWithSymbols.add(localOffset);
        }
      }

      if (v142) {
        if (!this.context.isAddressBanned(w)) {
          if (this.checkWordIsASymbolReference(w)) {
            if (w < currentVram && this.containsVram(w)) {
              // References a data symbol from this section and it is behind this current symbol
              needsFurtherAnalyzis = true;
            }
          }

          if (!ownedSegment.isVramInRange(w)) {
            const prioritizedSegment = this._findPrioritizedSegment(w, ownedSegment);
            if (prioritizedSegment !== null) prioritizedSegment.addSymbol(w, undefined, true, null, true);
          }
        }
      } else if (this.checkWordIsASymbolReference(w)) {
        if (w < currentVram && this.containsVram(w)) needsFurtherAnalyzis = true;
      }

      localOffset += 4;
    }

    if (needsFurtherAnalyzis) {
      localOffset = 0;
      for (const _w of this.words) {
        const currentVram = this.getVramOffset(localOffset);

        if (this.popPointerInDataReference(currentVram) !== null && !localOffsetsWithSymbols.has(localOffset)) {
          const contextSym = this._addOwnedSymbol(localOffset);
          if (contextSym !== null) {
            symbolList.push([localOffset, contextSym]);
            localOffsetsWithSymbols.add(localOffset);
          }
        }

        localOffset += 4;
      }

      // Since we appended new symbols, this list is not sorted anymore
      symbolList = sortPairs(symbolList);
    }

    this.processStaticRelocs();

    for (let i = 0; i < symbolList.length; i++) {
      const [offset, contextSym] = symbolList[i];
      let words;
      if (i + 1 === symbolList.length) {
        words = this.words.slice(offset / 4);
      } else {
        const nextOffset = symbolList[i + 1][0];
        if (offset === nextOffset) continue;
        words = this.words.slice(offset / 4, nextOffset / 4);
      }

      const vrom = this.getVromOffset(offset);
      const vromEnd = vrom + 4 * words.length;
      const sym = new SymbolData(this.context, vrom, vromEnd, offset + this.inFileOffset, contextSym.vram, words, this.segmentVromStart, this.overlayCategory);
      sym.parent = this;
      sym.setCommentOffset(this.commentOffset);
      sym.stringEncoding = this.stringEncoding;
      sym.analyze();
      this.symbolList.push(sym);

      this.symbolsVRams.add(contextSym.vram);
    }
  }

  removePointers() {
    if (!GlobalConfig.REMOVE_POINTERS) return false;

    let was_updated = false;
    for (let i = 0; i < this.sizew; i++) {
      const top_byte = (this.words[i] >>> 24) & 0xff;
      if (top_byte === 0x80) {
        this.words[i] = (top_byte << 24) >>> 0;
        was_updated = true;
      }
      if ((top_byte & 0xf0) === 0x00 && (top_byte & 0x0f) !== 0x00) {
        this.words[i] = (top_byte << 24) >>> 0;
        was_updated = true;
      }
    }
    return was_updated;
  }
}

/**
 * list.sort() over (offset, ContextSymbol) tuples: offsets are unique in
 * practice; equal offsets would make CPython compare ContextSymbols and raise.
 */
export function sortPairs(list) {
  const out = list.map((p, i) => [p, i]);
  out.sort((a, b) => {
    if (a[0][0] !== b[0][0]) return a[0][0] < b[0][0] ? -1 : 1;
    if (symEq(a[0][1], b[0][1])) return a[1] - b[1];
    throw new TypeError("'<' not supported between instances of 'ContextSymbol' and 'ContextSymbol'");
  });
  return out.map((x) => x[0]);
}

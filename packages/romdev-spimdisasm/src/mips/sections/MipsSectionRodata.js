// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/sections/MipsSectionRodata.py

import { rabbitizer } from "../../rabbitizer.js";
import { GlobalConfig } from "../../common/GlobalConfig.js";
import { FileSectionType } from "../../common/FileSectionType.js";
import * as Utils from "../../common/Utils.js";
import { sortedNumbers } from "../../py/pyutils.js";
import { atLeast } from "../../version.js";
import { SymbolRodata } from "../symbols/MipsSymbolRodata.js";
import { SectionBase } from "./MipsSectionBase.js";
import { sortPairs } from "./MipsSectionData.js";

export class SectionRodata extends SectionBase {
  constructor(context, vromStart, vromEnd, vram, filename, array_of_bytes, segmentVromStart, overlayCategory) {
    let words;
    if (GlobalConfig.ENDIAN_RODATA !== null) words = Utils.endianessBytesToWords(GlobalConfig.ENDIAN_RODATA, array_of_bytes, vromStart, vromEnd);
    else words = Utils.bytesToWords(array_of_bytes, vromStart, vromEnd);
    super(context, vromStart, vromEnd, vram, filename, words, FileSectionType.Rodata, segmentVromStart, overlayCategory);

    this.stringEncoding = GlobalConfig.RODATA_STRING_ENCODING;
  }

  /** Returns [jumpTableSym|null, firstJumptableWord] */
  _analyze_processJumptable(localOffset, w, contextSym, lastVramSymbol, jumpTableSym, firstJumptableWord) {
    if (contextSym !== null && contextSym.isJumpTable()) {
      // New jumptable
      jumpTableSym = contextSym;
      firstJumptableWord = w;
    } else if (jumpTableSym !== null) {
      // The last symbol found was part of a jumptable, check if this word still is part of the jumptable
      if (!this.pointersOffsets.has(localOffset)) {
        if (w === 0) {
          return [null, firstJumptableWord];
        } else if (contextSym !== null) {
          return [null, firstJumptableWord];
        } else if (((w >>> 24) & 0xff) !== ((firstJumptableWord >>> 24) & 0xff)) {
          if (!(lastVramSymbol.isJumpTable() && lastVramSymbol.isGot && GlobalConfig.GP_VALUE !== null)) return [null, firstJumptableWord];
        }
      }
    } else {
      // No jumptable
      return [null, firstJumptableWord];
    }

    // Generate the current label
    let labelAddr;
    let labelVrom;
    if (lastVramSymbol.isGot && GlobalConfig.GP_VALUE !== null) {
      labelAddr = GlobalConfig.GP_VALUE + rabbitizer.Utils.from2Complement(w, 32);
      labelVrom = null;
    } else {
      labelAddr = w;
      const maybeVrom = this.vromStart + labelAddr - this.vram;
      const segment = this.getSegmentForVrom(this.segmentVromStart);
      if (!segment._isTheUnknownSegment && segment.isVromInRange(maybeVrom)) labelVrom = maybeVrom;
      else labelVrom = null;
    }
    const labelSym = this.addJumpTableLabel(labelAddr, true, labelVrom);

    if (labelSym.unknownSegment) return [null, firstJumptableWord];

    labelSym.referenceCounter += 1;
    if (jumpTableSym.parentFunction !== null) {
      labelSym.parentFunction = jumpTableSym.parentFunction;
      labelSym.parentFileName = jumpTableSym.parentFunction.parentFileName;
      jumpTableSym.parentFunction.branchLabels.add(labelSym.vram, labelSym);
    }

    return [jumpTableSym, firstJumptableWord];
  }

  analyze() {
    let lastVramSymbol = this._checkAndCreateFirstSymbol();

    let symbolList = [];
    let localOffset = 0;
    const localOffsetsWithSymbols = new Set();

    let needsFurtherAnalyzis = false;

    let jumpTableSym = null;
    let firstJumptableWord = -1;

    const v142 = atLeast("1.42.0");
    const ownedSegment = v142 ? this.getSegment() : null;

    for (const w of this.words) {
      const currentVram = this.getVramOffset(localOffset);
      const currentVrom = this.getVromOffset(localOffset);

      // Check if we have a symbol at this address, if not then use the last known one
      let contextSym = this.getSymbol(currentVram, currentVrom, false);
      if (contextSym !== null) lastVramSymbol = contextSym;

      [jumpTableSym, firstJumptableWord] = this._analyze_processJumptable(localOffset, w, contextSym, lastVramSymbol, jumpTableSym, firstJumptableWord);

      if (jumpTableSym === null) {
        if (contextSym !== null || this.popPointerInDataReference(currentVram) !== null || (lastVramSymbol.isJumpTable() && w !== 0)) {
          contextSym = this._addOwnedSymbol(localOffset);
          if (contextSym !== null) lastVramSymbol = contextSym;
        }

        this.checkWordIsASymbolReference(w);
      }

      if (contextSym !== null) {
        symbolList.push([localOffset, contextSym]);
        localOffsetsWithSymbols.add(localOffset);

        this._createAutoPadFromSymbol(localOffset, contextSym);
      } else if (jumpTableSym === null && this.popPointerInDataReference(currentVram) !== null) {
        contextSym = this._addOwnedSymbol(localOffset);
        if (contextSym !== null) {
          symbolList.push([localOffset, contextSym]);
          localOffsetsWithSymbols.add(localOffset);
        }
      }

      if (!lastVramSymbol.notPointerByType()) {
        if (v142) {
          if (!this.context.isAddressBanned(w)) {
            if (this.checkWordIsASymbolReference(w)) {
              if (w < currentVram && this.containsVram(w)) needsFurtherAnalyzis = true;
            }

            if (!ownedSegment.isVramInRange(w)) {
              const prioritizedSegment = this._findPrioritizedSegment(w, ownedSegment);
              if (prioritizedSegment !== null) prioritizedSegment.addSymbol(w, undefined, true, null, true);
            }
          }
        } else if (this.checkWordIsASymbolReference(w)) {
          if (w < currentVram && this.containsVram(w)) needsFurtherAnalyzis = true;
        }
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

    let previousSymbolWasLateRodata = false;
    let previousSymbolExtraPadding = 0;
    const compiler = GlobalConfig.COMPILER.value;
    const sectionAlign_rodata = compiler.sectionAlign_rodata;
    const rodataAlignment = sectionAlign_rodata !== null ? 2 ** sectionAlign_rodata : null;

    for (let i = 0; i < symbolList.length; i++) {
      const [offset, contextSym] = symbolList[i];
      let words;
      if (i + 1 === symbolList.length) {
        words = this.words.slice(offset / 4);
      } else {
        const nextOffset = symbolList[i + 1][0];
        words = this.words.slice(offset / 4, nextOffset / 4);
      }

      const vrom = this.getVromOffset(offset);
      const vromEnd = vrom + words.length * 4;
      const sym = new SymbolRodata(this.context, vrom, vromEnd, offset + this.inFileOffset, contextSym.vram, words, this.segmentVromStart, this.overlayCategory);
      sym.parent = this;
      sym.setCommentOffset(this.commentOffset);
      sym.stringEncoding = this.stringEncoding;
      sym.analyze();
      this.symbolList.push(sym);
      this.symbolsVRams.add(contextSym.vram);

      if (rodataAlignment !== null) {
        // Section boundaries detection
        if ((this.vromStart + sym.inFileOffset) % rodataAlignment === 0) {
          if (previousSymbolWasLateRodata && !sym.contextSym.isLateRodata()) {
            // late rodata followed by normal rodata implies a file split
            this.fileBoundaries.push(sym.inFileOffset);
          } else if (previousSymbolExtraPadding > 0) {
            if (sym.isDouble(0)) {
              // doubles require a bit extra of alignment
              if (previousSymbolExtraPadding >= 2) this.fileBoundaries.push(sym.inFileOffset);
            } else if (sym.isJumpTable()) {
              if (compiler.prevAlign_jumptable !== null && compiler.prevAlign_jumptable >= 3) {
                if (previousSymbolExtraPadding >= 2) this.fileBoundaries.push(sym.inFileOffset);
              }
            } else if (sym.isString()) {
              if (compiler.prevAlign_string !== null && compiler.prevAlign_string >= 3) {
                if (previousSymbolExtraPadding >= 2) this.fileBoundaries.push(sym.inFileOffset);
              }
            } else {
              this.fileBoundaries.push(sym.inFileOffset);
            }
          }
        }

        previousSymbolWasLateRodata = sym.contextSym.isLateRodata();
        previousSymbolExtraPadding = sym.countExtraPadding();
      }
    }

    this.processStaticRelocs();

    // Filter out repeated values and sort
    this.fileBoundaries = sortedNumbers(new Set(this.fileBoundaries));
  }

  removePointers() {
    if (!GlobalConfig.REMOVE_POINTERS) return false;

    let was_updated = super.removePointers();
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

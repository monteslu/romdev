// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/sections/MipsSectionBase.py

import { FileBase } from "../MipsFileBase.js";
import { GlobalConfig } from "../../common/GlobalConfig.js";
import { FileSectionType } from "../../common/FileSectionType.js";
import { SymbolSpecialType, symEq } from "../../common/ContextSymbols.js";
import * as Utils from "../../common/Utils.js";
import { atLeast } from "../../version.js";

export class SectionBase extends FileBase {
  constructor(context, vromStart, vromEnd, vram, filename, words, sectionType, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, vram, filename, words, sectionType, segmentVromStart, overlayCategory);

    this.stringEncoding = GlobalConfig.DATA_STRING_ENCODING;
    /** Allows to toggle string guessing at the section level. */
    this.enableStringGuessing = true;

    /** If not null, the autodetectedType of the symbols found on this section is set to this value. */
    this.typeForOwnedSymbols = null;

    /** If not null, the autodetectedSize of the symbols found on this section is set to this value. */
    this.sizeForOwnedSymbols = null;
  }

  checkWordIsASymbolReference(word) {
    if (!this.context.totalVramRange.isInRange(word)) return false;
    if (this.context.isAddressBanned(word)) return false;

    const contextSym = this.getSymbol(word, null, true, false);
    if (contextSym !== null) {
      const symType = contextSym.getTypeSpecial();
      if (
        symType === SymbolSpecialType.function ||
        symType === SymbolSpecialType.branchlabel ||
        symType === SymbolSpecialType.jumptablelabel ||
        (atLeast("1.39.0") && symType === SymbolSpecialType.gccexcepttablelabel)
      ) {
        // Avoid generating extra symbols in the middle of functions
        return false;
      }

      if (word < contextSym.vram + contextSym.getSize()) {
        // Avoid generating symbols in the middle of other symbols with known sizes
        return false;
      }
    }

    this.addPointerInDataReference(word);
    return true;
  }

  processStaticRelocs() {
    for (let i = 0; i < this.sizew; i++) {
      const word = this.words[i];
      const vrom = this.getVromOffset(i * 4);
      const relocInfo = this.context.globalRelocationOverrides.get(vrom);
      if (relocInfo === undefined || relocInfo.staticReference === null) continue;

      const relocVram = relocInfo.staticReference.sectionVram + word;
      const sectionType = relocInfo.staticReference.sectionType;
      let contextSym;
      if (this.sectionType === FileSectionType.Rodata && sectionType === FileSectionType.Text) {
        contextSym = this.addJumpTableLabel(relocVram, true);
      } else {
        contextSym = this.addSymbol(relocVram, sectionType, true);
      }
      contextSym._isStatic = true;
    }
  }

  /** Check if the very start of the file has a symbol and create it if it doesn't exist yet */
  _checkAndCreateFirstSymbol() {
    const currentVram = this.getVramOffset(0);
    const currentVrom = this.getVromOffsetNone(0);
    return this.addSymbol(currentVram, this.sectionType, true, currentVrom);
  }

  _getOwnedSymbol(localOffset) {
    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffsetNone(localOffset);

    const contextSym = this.getSymbol(currentVram, currentVrom, false);
    if (contextSym === null) return null;

    if (this.typeForOwnedSymbols !== null) contextSym.autodetectedType = this.typeForOwnedSymbols;
    if (this.sizeForOwnedSymbols !== null) contextSym.autodetectedSize = this.sizeForOwnedSymbols;

    if (this.sectionType !== FileSectionType.Bss) {
      contextSym.isMaybeString = this._stringGuesser(contextSym, localOffset);
      contextSym.isMaybePascalString = this._pascalStringGuesser(contextSym, localOffset);
    }

    this._createAutoPadFromSymbol(localOffset, contextSym);

    return contextSym;
  }

  _addOwnedSymbol(localOffset) {
    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffsetNone(localOffset);

    const contextSym = this.addSymbol(currentVram, this.sectionType, true, currentVrom, true);
    if (contextSym.vram !== currentVram) return null;

    if (this.typeForOwnedSymbols !== null) contextSym.autodetectedType = this.typeForOwnedSymbols;
    if (this.sizeForOwnedSymbols !== null) contextSym.autodetectedSize = this.sizeForOwnedSymbols;

    if (this.sectionType !== FileSectionType.Bss) {
      contextSym.isMaybeString = this._stringGuesser(contextSym, localOffset);
      contextSym.isMaybePascalString = this._pascalStringGuesser(contextSym, localOffset);
    }

    return contextSym;
  }

  _addOwnedAutocreatedPad(localOffset) {
    if (localOffset >= this.sizew * 4) return null;

    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffsetNone(localOffset);

    const extraContextSym = this.addSymbol(currentVram, this.sectionType, true, currentVrom);
    extraContextSym.isAutoCreatedPad = true;
    return extraContextSym;
  }

  _createAutoPadFromSymbol(localOffset, contextSym) {
    if (!contextSym.hasUserDeclaredSize()) {
      if (this.sizeForOwnedSymbols !== null && this.sizeForOwnedSymbols > 0) return this._addOwnedAutocreatedPad(localOffset + this.sizeForOwnedSymbols);
    }

    let createPads;
    if (this.sectionType === FileSectionType.Data) createPads = GlobalConfig.CREATE_DATA_PADS;
    else if (this.sectionType === FileSectionType.Rodata) createPads = GlobalConfig.CREATE_RODATA_PADS;
    else createPads = false;

    if (createPads && contextSym.hasUserDeclaredSize()) {
      const symDeclaredSize = contextSym.getSize();
      if (symDeclaredSize > 0) {
        // Try to respect the user-declared size for this symbol
        return this._addOwnedAutocreatedPad(localOffset + symDeclaredSize);
      }
    }

    return null;
  }

  _stringGuesser(contextSym, localOffset) {
    if (contextSym._ranStringCheck) return contextSym.isMaybeString;

    if (contextSym.isMaybeString || contextSym.isString()) return true;

    if (!this.enableStringGuessing) return false;

    let stringGuesserLevel;
    if (this.sectionType === FileSectionType.Rodata) stringGuesserLevel = GlobalConfig.RODATA_STRING_GUESSER_LEVEL;
    else stringGuesserLevel = GlobalConfig.DATA_STRING_GUESSER_LEVEL;

    if (stringGuesserLevel < 1) return false;

    if (contextSym.referenceCounter > 1) {
      if (stringGuesserLevel < 2) return false;
    }

    // This would mean the string is an empty string, which is not very likely
    const w = this.words[Math.floor(localOffset / 4)];
    if (w === 0) {
      if (stringGuesserLevel < 3) return false;
    }

    if (contextSym.hasOnlyAutodetectedType()) {
      if (stringGuesserLevel < 4) return false;
    }

    if (atLeast("1.39.0")) {
      // We don't want to decode as string if this is a pointer
      const suspectedPtr = this.getSymbol(w);
      if (suspectedPtr !== null) {
        if (w === suspectedPtr.vram) return false;
        const t = suspectedPtr.getTypeSpecial();
        if (
          t === SymbolSpecialType.function ||
          t === SymbolSpecialType.branchlabel ||
          t === SymbolSpecialType.jumptablelabel ||
          t === SymbolSpecialType.gccexcepttablelabel
        ) {
          // It is very unlikely for a symbol to be referencing the middle
          // of a function, so we allow this to be a string.
        } else {
          return false;
        }
      } else if (w % 4 === 0 && this.containsVram(w) && w !== contextSym.vram) {
        // Likely to be a pointer to a symbol in the current section.
        return false;
      }
    }

    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffset(localOffset);
    const [, rawStringSize] = Utils.decodeBytesToStrings(this.bytes, localOffset, this.stringEncoding);
    if (rawStringSize < 0) {
      // String can't be decoded
      return false;
    }

    // Check if there is already another symbol after the current one and before the end of the string,
    // in which case we say this symbol should not be a string
    const otherSym = this.getSymbol(currentVram + rawStringSize, currentVrom + rawStringSize, true, false, false);
    if (!symEq(otherSym, contextSym)) return false;

    return true;
  }

  _pascalStringGuesser(contextSym, localOffset) {
    if (contextSym._ranPascalStringCheck) return contextSym.isMaybePascalString;

    if (contextSym.isMaybePascalString || contextSym.isPascalString()) return true;

    if (!this.enableStringGuessing) return false;

    let stringGuesserLevel;
    if (this.sectionType === FileSectionType.Rodata) stringGuesserLevel = GlobalConfig.PASCAL_RODATA_STRING_GUESSER_LEVEL;
    else stringGuesserLevel = GlobalConfig.PASCAL_DATA_STRING_GUESSER_LEVEL;

    if (stringGuesserLevel < 1) return false;

    if (contextSym.referenceCounter > 1) {
      if (stringGuesserLevel < 2) return false;
    }

    // This would mean the string is an empty string, which is not very likely
    if (this.words[Math.floor(localOffset / 4)] === 0) {
      if (stringGuesserLevel < 3) return false;
    }

    if (contextSym.hasOnlyAutodetectedType()) {
      if (stringGuesserLevel < 4) return false;
    }

    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffset(localOffset);
    const [, rawStringSize] = Utils.decodeBytesToPascalStrings(this.bytes, localOffset, this.stringEncoding, 0x20);
    if (rawStringSize < 0) return false;

    const otherSym = this.getSymbol(currentVram + rawStringSize - 1, currentVrom + rawStringSize, true, false, false);
    if (!symEq(otherSym, contextSym)) return false;

    return true;
  }

  blankOutDifferences(other) {
    if (!GlobalConfig.REMOVE_POINTERS) return false;

    let was_updated = false;
    if (GlobalConfig.IGNORE_WORD_LIST.size > 0) {
      const minLen = Math.min(this.sizew, other.sizew);
      for (let i = 0; i < minLen; i++) {
        for (const upperByte of GlobalConfig.IGNORE_WORD_LIST) {
          const word = (upperByte * 0x1000000) >>> 0;
          if (((this.words[i] >>> 24) & 0xff) === upperByte && ((other.words[i] >>> 24) & 0xff) === upperByte) {
            this.words[i] = word;
            other.words[i] = word;
            was_updated = true;
          }
        }
      }
    }

    return was_updated;
  }

  suspectedPaddingGarbage() {
    return [];
  }
}

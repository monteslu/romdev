// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/symbols/MipsSymbolBase.py

import { rabbitizer } from "../../rabbitizer.js";
import { ElementBase } from "../../common/ElementBase.js";
import { GlobalConfig, InputEndian } from "../../common/GlobalConfig.js";
import { FileSectionType } from "../../common/FileSectionType.js";
import { SymbolSpecialType, isSymbolSpecialType } from "../../common/ContextSymbols.js";
import * as Utils from "../../common/Utils.js";
import { newIntSet } from "../../common/symset.js";
import { formatG } from "../../py/pyfloat.js";
import { hexU, pyStr } from "../../py/pyutils.js";
import { atLeast } from "../../version.js";

export class SymbolBase extends ElementBase {
  constructor(context, vromStart, vromEnd, inFileOffset, vram, words, sectionType, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, inFileOffset, vram, "", words, sectionType, segmentVromStart, overlayCategory);

    /** offset in words */
    this.endOfLineComment = new Map();

    this.contextSym = this.addSymbol(this.vram, this.sectionType, true);
    this.contextSym.vromAddress = this.vromStart;
    this.contextSym.isDefined = true;
    this.contextSym.sectionType = this.sectionType;

    this.stringEncoding = GlobalConfig.DATA_STRING_ENCODING;

    /** key: word offset */
    this.relocs = new Map();

    /** Every referenced vram found */
    this.referencedVrams = newIntSet();

    if (atLeast("1.42.0")) {
      // Void the autodetected symbol type if it is a branch target, but the
      // symbol isn't part of a text section.
      if (this.sectionType !== FileSectionType.Text) {
        const symType = this.contextSym.autodetectedType;
        if (isSymbolSpecialType(symType)) {
          if (symType.isTargetLabel()) this.contextSym.autodetectedType = null;
        }
      }
    }
  }

  getNameUnquoted() {
    return this.contextSym.getNameUnquoted();
  }

  getName() {
    return this.contextSym.getName();
  }

  getNameEnd() {
    return this.contextSym.getNameEnd();
  }

  setNameIfUnset(name) {
    this.contextSym.setNameIfUnset(name);
  }

  setNameGetCallback(callback) {
    this.contextSym.setNameGetCallback(callback);
  }

  setNameGetCallbackIfUnset(callback) {
    this.contextSym.setNameGetCallbackIfUnset(callback);
  }

  canUseAddendsOnData() {
    if (this.contextSym.notAllowedToReferenceAddends) return false;
    if (GlobalConfig.ALLOW_ALL_ADDENDS_ON_DATA) return true;
    return this.contextSym.allowedToReferenceAddends;
  }

  canUseConstantsOnData() {
    if (this.contextSym.notAllowedToReferenceConstants) return false;
    if (GlobalConfig.ALLOW_ALL_CONSTANTS_ON_DATA) return true;
    return this.contextSym.allowedToReferenceConstants;
  }

  /** (localOffset, wordValue=None, isDouble=False, emitRomOffset=True); wordValue may be a bigint when isDouble */
  generateAsmLineComment(localOffset, wordValue = null, isDouble = false, emitRomOffset = true) {
    const indentation = " ".repeat(GlobalConfig.ASM_INDENTATION);

    if (!GlobalConfig.ASM_COMMENT) return indentation;

    let offsetHex;
    if (emitRomOffset) offsetHex = `${hexU(localOffset + this.inFileOffset + this.commentOffset, GlobalConfig.ASM_COMMENT_OFFSET_WIDTH)} `;
    else offsetHex = "";

    const currentVram = this.getVramOffset(localOffset);
    const vramHex = hexU(currentVram, 8);

    let wordValueHex = "";
    if (wordValue !== null && wordValue !== undefined) {
      if (isDouble) wordValueHex = `${hexU(Utils.qwordToCurrenEndian(wordValue), 16)} `;
      else wordValueHex = `${hexU(Utils.wordToCurrenEndian(wordValue), 8)} `;
    }

    return `${indentation}/* ${offsetHex}${vramHex} ${wordValueHex}*/`;
  }

  generateBytesComment(rawData) {
    if (!GlobalConfig.ASM_COMMENT) return "";

    const indentation = " ".repeat(GlobalConfig.ASM_INDENTATION);
    let comment = `${indentation}/* `;
    for (const byte of rawData) comment += hexU(byte, 2);
    comment += ` */${GlobalConfig.LINE_ENDS}`;
    return comment;
  }

  getSymbolAsmDeclaration(symName, useGlobalLabel = true) {
    if (!useGlobalLabel) return `${symName}:` + GlobalConfig.LINE_ENDS;

    let output = "";
    output += this.getLabelFromSymbol(this.contextSym, symName);
    if (this.sectionType === FileSectionType.Text) {
      if (GlobalConfig.ASM_TEXT_ENT_LABEL) output += `${GlobalConfig.ASM_TEXT_ENT_LABEL} ${symName}${GlobalConfig.LINE_ENDS}`;
      if (GlobalConfig.ASM_TEXT_FUNC_AS_LABEL) output += `${symName}:${GlobalConfig.LINE_ENDS}`;
    } else if (GlobalConfig.ASM_DATA_SYM_AS_LABEL) {
      output += `${symName}:${GlobalConfig.LINE_ENDS}`;
    }
    return output;
  }

  getExtraLabelFromSymbol(contextSym) {
    let label = "";
    if (contextSym !== null && contextSym !== undefined) {
      label = GlobalConfig.LINE_ENDS;
      const symLabel = contextSym.getLabelMacro(true);
      if (symLabel !== null) {
        const symName = contextSym.getName();
        if (atLeast("1.39.0")) label += this.getNonMatchingLabel(symName, null);
        label += `${symLabel} ${symName}${GlobalConfig.LINE_ENDS}`;
        if (GlobalConfig.ASM_DATA_SYM_AS_LABEL) label += `${symName}:` + GlobalConfig.LINE_ENDS;
      }
    }
    return label;
  }

  getReloc(wordOffset) {
    let relocInfo = this.context.globalRelocationOverrides.get(this.getVromOffset(wordOffset));
    if (relocInfo === undefined) relocInfo = this.relocs.get(wordOffset);
    return relocInfo === undefined ? null : relocInfo;
  }

  relocToInlineStr(relocInfo, isSplittedSymbol = false) {
    if (relocInfo === null || relocInfo === undefined) return "";
    return relocInfo.getInlineStr(isSplittedSymbol);
  }

  getSizeDirective(symName) {
    if (GlobalConfig.ASM_EMIT_SIZE_DIRECTIVE) return `.size ${symName}, . - ${symName}${GlobalConfig.LINE_ENDS}`;
    return "";
  }

  getNonMatchingLabel(symName, symSize) {
    if (!atLeast("1.39.0")) return "";
    const nmLabel = GlobalConfig.ASM_NM_LABEL;
    const perSym = atLeast("1.42.0") ? this.contextSym.useNonMatchingLabel : true;
    if (nmLabel && perSym) {
      const out = `${nmLabel} ${symName}`;
      let sizePart;
      if (symSize !== null && symSize !== undefined) {
        symSize = Math.max(symSize, 1);
        sizePart = `, 0x${hexU(symSize)}`;
      } else {
        sizePart = "";
      }
      // We need an empty line between the nonmatching marker and the actual
      // label to avoid triggering the KMC compiler to emit an extra nop as
      // part of the function.
      return `${out}${sizePart}${GlobalConfig.LINE_ENDS}${GlobalConfig.LINE_ENDS}`;
    }
    return "";
  }

  isFunction() {
    return false;
  }

  isByte(_index) {
    if (this.isString() || this.isPascalString()) return false;
    return this.contextSym.isByte();
  }

  isShort(_index) {
    return this.contextSym.isShort();
  }

  isString() {
    if (this.contextSym.isPascalString()) return false;
    return this.contextSym.isString();
  }

  isPascalString() {
    if (this.contextSym.isString()) return false;
    return this.contextSym.isPascalString();
  }

  isFloat(index) {
    if (this.contextSym.isFloat()) {
      if (index >= this.words.length) return false;
      const word = this.words[index];
      // Filter out NaN and infinity
      if ((word & 0x7f800000) !== 0x7f800000) return true;
    }
    return false;
  }

  isDouble(index) {
    if (index % 2 !== 0) return false;

    if (this.contextSym.isDouble()) {
      if (index + 1 < this.words.length) {
        const word0 = this.words[index];
        // Filter out NaN and infinity (only the upper word matters for the exponent mask)
        if ((word0 & 0x7ff00000) !== 0x7ff00000) {
          // Prevent accidentally losing symbols
          const currentVram = this.getVramOffset(index * 4);
          const currentVrom = this.getVromOffset(index * 4);
          if (this.getSymbol(currentVram + 4, currentVrom, false) === null) return true;
        }
      }
    }
    return false;
  }

  isJumpTable() {
    return false;
  }

  /** @deprecated */
  isRdata() {
    return false;
  }

  shouldMigrate() {
    return false;
  }

  analyze() {
    this.contextSym.inFileOffset = this.inFileOffset;
    if (this.parent !== null) this.contextSym.parentFileName = this.parent.getName();

    const isWordSized = !this.contextSym.isByte() && !this.contextSym.isShort();

    if (this.sectionType !== FileSectionType.Bss) {
      for (let i = 0; i < this.sizew; i++) {
        const localOffset = 4 * i;
        for (let j = 0; j < 4; j++) {
          if (i === 0 && j === 0) continue;

          // Possible symbols in the middle of words
          const currentVram = this.getVramOffset(localOffset + j);
          const currentVrom = this.getVromOffset(localOffset + j);
          const contextSym = this.getSymbol(currentVram, currentVrom, false);
          if (contextSym !== null) {
            contextSym.vromAddress = this.getVromOffset(localOffset + j);
            contextSym.isDefined = true;
            contextSym.sectionType = this.sectionType;
            contextSym.setTypeIfUnset(this.contextSym.getTypeSpecial(), this.contextSym.isAutogenerated);
            contextSym.inFileOffset = this.inFileOffset + localOffset + j;
            if (this.parent !== null) contextSym.parentFileName = this.parent.getName();
          }
        }

        if (isWordSized) {
          const word = this.words[i];
          const referencedSym = this.getSymbol(word, null, false);
          if (referencedSym !== null) {
            if (!referencedSym.isJumpTable()) referencedSym.referenceSymbols.add(this.contextSym);
            this.referencedVrams.add(referencedSym.vram);
          }
        }
      }
    }
  }

  getEndOfLineComment(wordIndex) {
    if (!GlobalConfig.ASM_COMMENT) return "";
    return this.endOfLineComment.has(wordIndex) ? this.endOfLineComment.get(wordIndex) : "";
  }

  getJByteAsByte(i, j) {
    const localOffset = 4 * i;
    const w = this.words[i];

    const dotType = ".byte";

    let shiftValue = j * 8;
    if (GlobalConfig.ENDIAN === InputEndian.BIG) shiftValue = 24 - shiftValue;
    const subVal = (w >>> shiftValue) & 0xff;
    const value = `0x${hexU(subVal, 2)}`;

    const comment = this.generateAsmLineComment(localOffset + j);
    return `${comment} ${dotType} ${value}`;
  }

  getJByteAsShort(i, j) {
    const localOffset = 4 * i;
    const w = this.words[i];

    const dotType = ".short";

    let shiftValue = j * 8;
    if (GlobalConfig.ENDIAN === InputEndian.BIG) shiftValue = 16 - shiftValue;
    // Python: (w & (0xFFFF << shiftValue)) >> shiftValue; for shift 24 (little endian j=3) the mask exceeds 32 bits.
    const subVal = Number((BigInt(w) & (0xffffn << BigInt(shiftValue))) >> BigInt(shiftValue));
    const value = `0x${hexU(subVal, 4)}`;

    const comment = this.generateAsmLineComment(localOffset + j);
    return `${comment} ${dotType} ${value}`;
  }

  getNthWordAsBytesAndShorts(i, sym1, sym2, sym3, lastSymName, symSize = null) {
    const v139 = atLeast("1.39.0");
    let output = "";

    if (sym1 !== null || this.isByte(i) || (!this.isShort(i) && sym3 !== null)) {
      output += this.getJByteAsByte(i, 0);
      output += GlobalConfig.LINE_ENDS;

      if (v139) {
        if (sym1 !== null || i * 4 + 1 === symSize) {
          output += this._getSymEnd(lastSymName);
          if (sym1 !== null) lastSymName = sym1.getName();
        }
      } else if (sym1 !== null) {
        output += this.getSizeDirective(lastSymName);
        lastSymName = sym1.getName();
      }

      output += this.getExtraLabelFromSymbol(sym1);
      output += this.getJByteAsByte(i, 1);
      output += GlobalConfig.LINE_ENDS;
    } else {
      output += this.getJByteAsShort(i, 0);
      output += GlobalConfig.LINE_ENDS;
    }

    if (v139) {
      if (sym2 !== null || i * 4 + 2 === symSize) {
        output += this._getSymEnd(lastSymName);
        if (sym2 !== null) lastSymName = sym2.getName();
      }
    } else if (sym2 !== null) {
      output += this.getSizeDirective(lastSymName);
      lastSymName = sym2.getName();
    }

    output += this.getExtraLabelFromSymbol(sym2);
    if (sym3 !== null || (sym2 !== null && sym2.isByte()) || (this.isByte(i) && (sym2 === null || !sym2.isShort()))) {
      output += this.getJByteAsByte(i, 2);
      output += GlobalConfig.LINE_ENDS;

      if (v139) {
        if (sym3 !== null || i * 4 + 3 === symSize) {
          output += this._getSymEnd(lastSymName);
          if (sym3 !== null) lastSymName = sym3.getName();
        }
      } else if (sym3 !== null) {
        output += this.getSizeDirective(lastSymName);
        lastSymName = sym3.getName();
      }

      output += this.getExtraLabelFromSymbol(sym3);
      output += this.getJByteAsByte(i, 3);
      output += GlobalConfig.LINE_ENDS;
    } else {
      output += this.getJByteAsShort(i, 2);
      output += GlobalConfig.LINE_ENDS;
    }

    return [output, 0];
  }

  _allowWordSymbolReference(symbolRef, word) {
    if (symbolRef.isElfNotype) return false;
    if (symbolRef.vram < 0) return false;
    if (!this.contextSym.allowedToReferenceSymbols) return false;
    if (!symbolRef.allowedToBeReferenced) return false;

    const symType = symbolRef.getTypeSpecial();
    if (isSymbolSpecialType(symType)) {
      if (symType === SymbolSpecialType.function) {
        if (word !== symbolRef.vram) return false;
      }
      if (symType === SymbolSpecialType.branchlabel) return false;
      if (symType === SymbolSpecialType.jumptable) return false;
      if (symType.isTargetLabel()) {
        if (word !== symbolRef.vram) return false;
        if (!this.contextSym.isJumpTable() && !this.contextSym.isGccExceptTable()) return false;
      }
    }
    return true;
  }

  getNthWordAsWords(i, relocInfo, canReferenceSymbolsWithAddends = false, canReferenceConstants = false, isSplittedSymbol = false) {
    let output = "";
    const localOffset = 4 * i;
    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffset(localOffset);
    const w = this.words[i];

    let dotType = ".word";

    let label = "";
    if (i !== 0) label = this.getExtraLabelFromSymbol(this.getSymbol(currentVram, currentVrom, false));

    let value = `0x${hexU(w, 8)}`;

    if (relocInfo === undefined) relocInfo = this.getReloc(localOffset);
    const v142 = atLeast("1.42.0");

    // .elf relocated symbol
    if (relocInfo !== null) {
      if (relocInfo.isRelocNone()) {
        // If the reloc type is none then use the raw number instead
      } else if (relocInfo.staticReference !== null) {
        const relocVram = relocInfo.staticReference.sectionVram + w;
        const contextSym = this.getSymbol(relocVram, null, true, false);
        if (contextSym !== null) {
          const wordRel = relocInfo.relocType.getWordRel();
          if (!v142) value = contextSym.getSymbolPlusOffset(relocVram);
          if (wordRel !== null) {
            dotType = wordRel;
            if (v142) value = contextSym.getSymbolPlusOffset(relocVram);
          }
        }
      } else {
        if (!v142) value = relocInfo.getName(isSplittedSymbol);
        const wordRel = relocInfo.relocType.getWordRel();
        if (wordRel !== null) {
          dotType = wordRel;
          if (v142) value = relocInfo.getName(isSplittedSymbol);
        }
      }
    } else if (this.contextSym.isJumpTable()) {
      let labelSym;
      if (this.contextSym.isGot && GlobalConfig.GP_VALUE !== null) {
        const labelAddr = GlobalConfig.GP_VALUE + rabbitizer.Utils.from2Complement(w, 32);
        labelSym = this.getSymbol(labelAddr, null, false);
        if (labelSym !== null) {
          const labelType = labelSym.getTypeSpecial();
          if (labelType === SymbolSpecialType.jumptablelabel || labelType === SymbolSpecialType.function) dotType = ".gpword";
        }
      } else {
        labelSym = this.getSymbol(w, null, false);
      }

      if (labelSym !== null) {
        const labelType = labelSym.getTypeSpecial();
        if (labelType === SymbolSpecialType.jumptablelabel || labelType === SymbolSpecialType.function) {
          // We check for function references too because this symbol may have gotten wrongly identified as a jumptable because of tail call optimizations.
          value = labelSym.getName();
        }
      }
    } else {
      // This word could be a reference to a symbol
      if (!this.context.isAddressBanned(w)) {
        const symbolRef = this.getSymbol(w, null, canReferenceSymbolsWithAddends);
        if (symbolRef !== null && !this.context.isAddressBanned(symbolRef.vram)) {
          if (this._allowWordSymbolReference(symbolRef, w)) value = symbolRef.getSymbolPlusOffset(w);
        } else if (canReferenceConstants) {
          const constant = this.getConstant(w);
          if (constant !== null) value = constant.getName();
        }
      }
    }

    const comment = this.generateAsmLineComment(localOffset, w);
    output += `${label}${comment} ${dotType} ${value}`;
    output += this.getEndOfLineComment(i);
    output += GlobalConfig.LINE_ENDS;

    return [output, 0];
  }

  getNthWordAsFloat(i) {
    let output = "";
    const localOffset = 4 * i;
    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffset(localOffset);
    const w = this.words[i];

    let label = "";
    if (i !== 0) label = this.getExtraLabelFromSymbol(this.getSymbol(currentVram, currentVrom, false));

    const dotType = ".float";
    const floatValue = Utils.wordToFloat(w);
    const value = formatG(floatValue, 10);

    const comment = this.generateAsmLineComment(localOffset, w);
    output += `${label}${comment} ${dotType} ${value}`;
    output += this.getEndOfLineComment(i);
    output += GlobalConfig.LINE_ENDS;

    return [output, 0];
  }

  getNthWordAsDouble(i) {
    let output = "";
    const localOffset = 4 * i;
    const currentVram = this.getVramOffset(localOffset);
    const currentVrom = this.getVromOffset(localOffset);
    const w = this.words[i];

    let label = "";
    if (i !== 0) label = this.getExtraLabelFromSymbol(this.getSymbol(currentVram, currentVrom, false));

    const dotType = ".double";
    const otherHalf = this.words[i + 1];
    let doubleWord;
    if (GlobalConfig.ENDIAN === InputEndian.LITTLE) doubleWord = (BigInt(otherHalf) << 32n) | BigInt(w);
    else doubleWord = (BigInt(w) << 32n) | BigInt(otherHalf);
    const doubleValue = Utils.qwordToDouble(doubleWord);
    const value = formatG(doubleValue, 18);

    const comment = this.generateAsmLineComment(localOffset, doubleWord, true);
    output += `${label}${comment} ${dotType} ${value}`;
    output += this.getEndOfLineComment(i);
    output += GlobalConfig.LINE_ENDS;

    return [output, 1];
  }

  /** Returns [result, skip, symSize] (the 1.35 variant never touches symSize). */
  getNthWordAsString(i, lastSymName = null, symSize = null) {
    const localOffset = 4 * i;

    const buffer = Utils.wordsToBytes(this.words);
    const [decodedStrings, rawStringSize] = Utils.decodeBytesToStrings(buffer, localOffset, this.stringEncoding);
    if (rawStringSize < 0) return ["", -1, symSize];

    const skip = Math.floor(rawStringSize / 4);
    const comment = this.generateAsmLineComment(localOffset);
    let result = `${comment} `;

    let commentPaddingNum = 22;
    if (!GlobalConfig.ASM_COMMENT) commentPaddingNum = 1;

    if (rawStringSize === 0) decodedStrings.push("");
    for (const decodedValue of decodedStrings.slice(0, -1)) {
      result += `.ascii "${decodedValue}"`;
      result += GlobalConfig.LINE_ENDS + " ".repeat(commentPaddingNum);
    }
    result += `.asciz "${decodedStrings.at(-1)}"${GlobalConfig.LINE_ENDS}`;

    const alignedStrSize = (skip + 1) * 4;
    const subBuffer = buffer.subarray(localOffset, localOffset + alignedStrSize);
    result += this.generateBytesComment(subBuffer);

    if (atLeast("1.39.0")) {
      if (symSize !== null && symSize > 0 && alignedStrSize >= symSize) {
        // Users may use sizes that are not multiple of four, because
        // strings may be smaller than a multiple of four and padded, which
        // padding the user may not consider part of the size of the string.
        result += this._getSymEnd(lastSymName);
        // Make it -1 to to avoid emitting the enddlabel more than once
        symSize = -1;
      }
    }

    return [result, skip, symSize];
  }

  getNthWordAsPascalString(i) {
    const localOffset = 4 * i;

    const buffer = Utils.wordsToBytes(this.words);
    const [decodedStrings, rawStringSize] = Utils.decodeBytesToPascalStrings(buffer, localOffset, this.stringEncoding, 0x20);
    if (rawStringSize < 0) return ["", -1];

    const skip = Math.floor((rawStringSize - 1) / 4);
    const comment = this.generateAsmLineComment(localOffset);
    let result = `${comment} `;

    let commentPaddingNum = 22;
    if (!GlobalConfig.ASM_COMMENT) commentPaddingNum = 1;

    if (rawStringSize === 0) decodedStrings.push("");
    for (const decodedValue of decodedStrings.slice(0, -1)) {
      result += `.ascii "${decodedValue}"`;
      result += GlobalConfig.LINE_ENDS + " ".repeat(commentPaddingNum);
    }
    result += `.ascii "${decodedStrings.at(-1)}"${GlobalConfig.LINE_ENDS}`;

    const alignedStrSize = (skip + 1) * 4;
    const subBuffer = buffer.subarray(localOffset, localOffset + alignedStrSize);
    result += this.generateBytesComment(subBuffer);

    return [result, skip];
  }

  getNthWord(i, relocInfo, canReferenceSymbolsWithAddends = false, canReferenceConstants = false, isSplittedSymbol = false) {
    return this.getNthWordAsWords(i, relocInfo, canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
  }

  /** Returns how many extra word paddings this symbol has */
  countExtraPadding() {
    return 0;
  }

  _getAlignDirectiveStr(shiftValue, i) {
    const shiftedVal = 2 ** shiftValue;

    if (this.parent === null) return "";

    if (GlobalConfig.SYMBOL_ALIGNMENT_REQUIRES_ALIGNED_SECTION) {
      if (this.parent.vram % shiftedVal !== 0) return "";
      if (this.getVramOffset(i * 4) % shiftedVal !== 0) return "";
    } else {
      const subRam = this.getVramOffset(i * 4) - this.parent.vram;
      if (((subRam % shiftedVal) + shiftedVal) % shiftedVal !== 0) return "";
    }

    return `.align ${shiftValue}${GlobalConfig.LINE_ENDS}`;
  }

  getPrevAlignDirective(i) {
    const symAlignmentShift = this.contextSym.alignmentShift;
    const compiler = GlobalConfig.COMPILER.value;

    if (symAlignmentShift !== null) {
      return this._getAlignDirectiveStr(symAlignmentShift, i);
    } else if (this.isDouble(i)) {
      if (i === 0 || !atLeast("1.39.0")) {
        const shiftValue = compiler.prevAlign_double;
        if (shiftValue !== null) return this._getAlignDirectiveStr(shiftValue, i);
      }
    } else if (this.isJumpTable()) {
      if (i === 0) {
        const shiftValue = compiler.prevAlign_jumptable;
        if (shiftValue !== null) return this._getAlignDirectiveStr(shiftValue, i);
      }
    } else if (this.isString() || this.isPascalString()) {
      const shiftValue = compiler.prevAlign_string;
      if (shiftValue !== null) return this._getAlignDirectiveStr(shiftValue, i);
    } else if (this.isFunction()) {
      const shiftValue = compiler.prevAlign_function;
      if (shiftValue !== null) return this._getAlignDirectiveStr(shiftValue, i);
    }

    return "";
  }

  getPostAlignDirective(i) {
    if (this.isString() || this.isPascalString()) return this._getAlignDirectiveStr(2, i);
    return "";
  }

  _getSymEnd(lastSymName) {
    let output = "";
    if (GlobalConfig.ASM_DATA_END_LABEL) output += `${GlobalConfig.ASM_DATA_END_LABEL} ${lastSymName}${GlobalConfig.LINE_ENDS}`;
    output += this.getSizeDirective(lastSymName);
    return output;
  }

  disassembleAsData(useGlobalLabel = true, isSplittedSymbol = false) {
    if (!atLeast("1.39.0")) return this._disassembleAsData135(useGlobalLabel, isSplittedSymbol);

    let output = this.contextSym.getReferenceeSymbols();
    output += this.getPrevAlignDirective(0);

    const symName = this.getName();
    output += this.getNonMatchingLabel(symName, null);
    output += this.getSymbolAsmDeclaration(symName, useGlobalLabel);

    let lastSymName = symName;

    const canReferenceSymbolsWithAddends = this.canUseAddendsOnData();
    const canReferenceConstants = this.canUseConstantsOnData();

    let symSize = this.contextSym.userDeclaredSize;

    if (symSize !== null && symSize % 4 !== 0 && this.contextSym.userDeclaredType !== null) {
      const warningMsg = `
Warning: Symbol '${symName}' (0x${hexU(this.vram, 8)}) was given a size '0x${hexU(symSize)}' that is not a multiple of its given type '${pyStr(this.contextSym.userDeclaredType)}'
This may produce inconsistency issues like end labels not being emitted.
You are highly encouraged to fix it.
This may be changed to a hard error in the future.
`;
      if (symSize % 2 !== 0) {
        if (!this.isByte(0)) Utils.eprint(warningMsg);
      } else if (!this.isByte(0) && !this.isShort(0)) {
        Utils.eprint(warningMsg);
      }
    }

    let i = 0;
    while (i < this.sizew) {
      const currentVram = this.getVramOffset(i * 4);
      const currentVrom = this.getVromOffset(i * 4);
      const relocInfo = this.getReloc(i * 4);

      const sym1 = this.getSymbol(currentVram + 1, currentVrom, false, true, false);
      const sym2 = this.getSymbol(currentVram + 2, currentVrom, false, true, false);
      const sym3 = this.getSymbol(currentVram + 3, currentVrom, false, true, false);

      let data;
      let skip;
      if (relocInfo !== null) {
        // If there is any user provided reloc info then we use that instead of anything else.
        [data, skip] = this.getNthWord(i, relocInfo, canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
      } else if (sym1 !== null || sym2 !== null || sym3 !== null || this.isByte(i) || this.isShort(i)) {
        // Check for symbols in the middle of this word
        [data, skip] = this.getNthWordAsBytesAndShorts(i, sym1, sym2, sym3, lastSymName, symSize);

        if (sym3 !== null) lastSymName = sym3.getName();
        else if (sym2 !== null) lastSymName = sym2.getName();
        else if (sym1 !== null) lastSymName = sym1.getName();
        if (lastSymName !== symName) symSize = null;
      } else if (this.isFloat(i)) {
        [data, skip] = this.getNthWordAsFloat(i);
      } else if (this.isDouble(i)) {
        [data, skip] = this.getNthWordAsDouble(i);
      } else if (this.isString()) {
        [data, skip, symSize] = this.getNthWordAsString(i, lastSymName, symSize);
        if (skip < 0) {
          // Not a string
          this.contextSym.failedStringDecoding = true;
          [data, skip] = this.getNthWord(i, relocInfo, canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
        }
      } else if (this.isPascalString()) {
        [data, skip] = this.getNthWordAsPascalString(i);
        if (skip < 0) {
          // Not a string
          this.contextSym.failedPascalStringDecoding = true;
          [data, skip] = this.getNthWord(i, relocInfo, canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
        }
      } else {
        [data, skip] = this.getNthWord(i, relocInfo, canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
      }

      if (i !== 0) output += this.getPrevAlignDirective(i);
      output += data;
      if (GlobalConfig.EMIT_INLINE_RELOC) output += this.relocToInlineStr(relocInfo, isSplittedSymbol);
      output += this.getPostAlignDirective(i);

      i += skip;
      i += 1;

      if (i * 4 === symSize) output += this._getSymEnd(lastSymName);
    }

    if (symSize === null || i * 4 < symSize) {
      // Size was cleared up by some in-middle symbol, so we need to emit
      // the end label for the last sym.
      // Or the user specified a larger size than what the symbol symbol
      // actually is.
      output += this._getSymEnd(lastSymName);
    }

    const nameEnd = this.getNameEnd();
    if (nameEnd !== null) output += this.getSymbolAsmDeclaration(nameEnd, useGlobalLabel);

    return output;
  }

  /** spimdisasm 1.35.x variant of disassembleAsData */
  _disassembleAsData135(useGlobalLabel, isSplittedSymbol) {
    let output = this.contextSym.getReferenceeSymbols();
    output += this.getPrevAlignDirective(0);

    const symName = this.getName();
    output += this.getSymbolAsmDeclaration(symName, useGlobalLabel);

    let lastSymName = symName;

    const canReferenceSymbolsWithAddends = this.canUseAddendsOnData();
    const canReferenceConstants = this.canUseConstantsOnData();

    let i = 0;
    while (i < this.sizew) {
      const currentVram = this.getVramOffset(i * 4);
      const currentVrom = this.getVromOffset(i * 4);

      const sym1 = this.getSymbol(currentVram + 1, currentVrom, false, true, false);
      const sym2 = this.getSymbol(currentVram + 2, currentVrom, false, true, false);
      const sym3 = this.getSymbol(currentVram + 3, currentVrom, false, true, false);

      let data;
      let skip;
      if (sym1 !== null || sym2 !== null || sym3 !== null || this.isByte(i) || this.isShort(i)) {
        [data, skip] = this.getNthWordAsBytesAndShorts(i, sym1, sym2, sym3, lastSymName, null);

        if (sym3 !== null) lastSymName = sym3.getName();
        else if (sym2 !== null) lastSymName = sym2.getName();
        else if (sym1 !== null) lastSymName = sym1.getName();
      } else if (this.isFloat(i)) {
        [data, skip] = this.getNthWordAsFloat(i);
      } else if (this.isDouble(i)) {
        [data, skip] = this.getNthWordAsDouble(i);
      } else if (this.isString()) {
        [data, skip] = this.getNthWordAsString(i);
        if (skip < 0) {
          this.contextSym.failedStringDecoding = true;
          [data, skip] = this.getNthWord(i, this.getReloc(i * 4), canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
        }
      } else if (this.isPascalString()) {
        [data, skip] = this.getNthWordAsPascalString(i);
        if (skip < 0) {
          this.contextSym.failedPascalStringDecoding = true;
          [data, skip] = this.getNthWord(i, this.getReloc(i * 4), canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
        }
      } else {
        [data, skip] = this.getNthWord(i, this.getReloc(i * 4), canReferenceSymbolsWithAddends, canReferenceConstants, isSplittedSymbol);
      }

      if (i !== 0) output += this.getPrevAlignDirective(i);
      output += data;
      if (GlobalConfig.EMIT_INLINE_RELOC) output += this.relocToInlineStr(this.getReloc(i * 4), isSplittedSymbol);
      output += this.getPostAlignDirective(i);

      i += skip;
      i += 1;
    }

    output += this.getSizeDirective(lastSymName);

    const nameEnd = this.getNameEnd();
    if (nameEnd !== null) output += this.getSymbolAsmDeclaration(nameEnd, useGlobalLabel);

    return output;
  }

  disassemble(_migrate = false, useGlobalLabel = true, isSplittedSymbol = false) {
    return this.disassembleAsData(useGlobalLabel, isSplittedSymbol);
  }
}

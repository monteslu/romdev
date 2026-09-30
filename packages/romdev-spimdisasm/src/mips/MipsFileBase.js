// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/MipsFileBase.py

import { writeFileSync } from "node:fs";

import { ElementBase } from "../common/ElementBase.js";
import { GlobalConfig } from "../common/GlobalConfig.js";
import { Context } from "../common/Context.js";
import { FileSectionType } from "../common/FileSectionType.js";
import * as Utils from "../common/Utils.js";
import { newIntSet } from "../common/symset.js";
import { hexU } from "../py/pyutils.js";

export class FileBase extends ElementBase {
  constructor(context, vromStart, vromEnd, vram, filename, words, sectionType, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, 0, vram, filename, words, sectionType, segmentVromStart, overlayCategory);

    this.symbolList = [];

    this.pointersOffsets = newIntSet();

    this.isHandwritten = false;

    this.fileBoundaries = [];

    /** addresses of symbols in this section */
    this.symbolsVRams = newIntSet();

    this.bytes = Utils.wordsToBytes(this.words);

    /** In log2 */
    this.sectionAlignment = 4;

    this.sectionFlags = null;
  }

  setCommentOffset(commentOffset) {
    this.commentOffset = commentOffset;
    for (const sym of this.symbolList) sym.setCommentOffset(this.commentOffset);
  }

  getAsmPrelude_includes() {
    let output = "";
    output += `.include "macro.inc"${GlobalConfig.LINE_ENDS}`;
    output += GlobalConfig.LINE_ENDS;
    return output;
  }

  getAsmPrelude_instructionDirectives() {
    return "";
  }

  getAsmPrelude_sectionStart() {
    let output = "";

    output += `.section ${this.getSectionName()}`;
    if (this.sectionFlags !== null) output += `, "${this.sectionFlags}"`;
    output += GlobalConfig.LINE_ENDS;

    output += GlobalConfig.LINE_ENDS;
    if (this.sectionAlignment !== null) {
      output += `.align ${this.sectionAlignment}${GlobalConfig.LINE_ENDS}`;
      output += GlobalConfig.LINE_ENDS;
    }
    return output;
  }

  getAsmPrelude() {
    let output = "";
    if (GlobalConfig.ASM_PRELUDE_USE_INCLUDES) output += this.getAsmPrelude_includes();
    if (GlobalConfig.ASM_PRELUDE_USE_INSTRUCTION_DIRECTIVES) output += this.getAsmPrelude_instructionDirectives();
    if (GlobalConfig.ASM_PRELUDE_USE_SECTION_START) output += this.getAsmPrelude_sectionStart();
    return output;
  }

  getHash() {
    const buffer = Utils.wordsToBytes(this.words);
    return Utils.getStrHash(buffer);
  }

  printNewFileBoundaries() {
    if (!GlobalConfig.PRINT_NEW_FILE_BOUNDARIES) return;

    if (this.fileBoundaries.length > 0) {
      const out = [];
      out.push(`File ${this.name}`);
      out.push(`Section: ${this.sectionType.toStr()}`);
      out.push(`Found ${this.symbolList.length} symbols.`);
      out.push(`Found ${this.fileBoundaries.length} file boundaries.`);
      out.push("    offset, size,       vram, symbols");

      const boundaries = [...this.fileBoundaries];
      boundaries.push(this.sizew * 4 + this.inFileOffset);

      for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i];
        const end = boundaries[i + 1];

        let symbolsInBoundary = 0;
        for (const func of this.symbolList) {
          const funcOffset = func.inFileOffset - this.inFileOffset;
          if (start <= funcOffset && funcOffset < end) symbolsInBoundary += 1;
        }
        let fileVram = 0;
        if (this.vram !== null) fileVram = start + this.vram;
        out.push(`    ${hexU(start + this.commentOffset, 6)}, ${hexU(end - start, 6)}, ${hexU(fileVram, 8)}, ${String(symbolsInBoundary).padStart(7)}`);
      }
      out.push("");
      process.stdout.write(out.join("\n") + "\n");
    }
  }

  printAnalyzisResults() {
    this.printNewFileBoundaries();
  }

  compareToFile(otherFile) {
    const hashOne = this.getHash();
    const hashTwo = otherFile.getHash();

    const result = {
      equal: hashOne === hashTwo,
      hash_one: hashOne,
      hash_two: hashTwo,
      size_one: this.sizew * 4,
      size_two: otherFile.sizew * 4,
      diff_bytes: 0,
      diff_words: 0,
    };

    let diffBytes = 0;
    let diffWords = 0;

    if (!result.equal) {
      const minLen = Math.min(this.sizew, otherFile.sizew);
      for (let i = 0; i < minLen; i++) {
        for (let j = 0; j < 4; j++) {
          if (((this.words[i] >>> (j * 8)) & 0xff) !== ((otherFile.words[i] >>> (j * 8)) & 0xff)) diffBytes += 1;
        }
      }
      for (let i = 0; i < minLen; i++) {
        if (this.words[i] !== otherFile.words[i]) diffWords += 1;
      }
    }

    result.diff_bytes = diffBytes;
    result.diff_words = diffWords;

    return result;
  }

  blankOutDifferences(_other) {
    if (!GlobalConfig.REMOVE_POINTERS) return false;
    return false;
  }

  removePointers() {
    if (!GlobalConfig.REMOVE_POINTERS) return false;
    return false;
  }

  disassemble(migrate = false, useGlobalLabel = true) {
    let output = "";

    if (!migrate) output += this.getSpimdisasmVersionString();

    for (let i = 0; i < this.symbolList.length; i++) {
      const sym = this.symbolList[i];
      output += sym.disassemble(migrate, useGlobalLabel, false);
      if (i + 1 < this.symbolList.length) output += GlobalConfig.LINE_ENDS;
    }
    return output;
  }

  /** f: object with a write(str) method */
  disassembleToFile(f) {
    if (GlobalConfig.ASM_USE_PRELUDE) f.write(this.getAsmPrelude());
    f.write(this.disassemble());
  }

  saveToFile(filepath) {
    if (this.symbolList.length === 0) return;

    if (filepath === "-") {
      this.disassembleToFile({ write: (s) => process.stdout.write(s) });
    } else {
      if (GlobalConfig.WRITE_BINARY) {
        if (this.sizew > 0) {
          const buffer = Utils.wordsToBytes(this.words);
          Utils.writeBytesToFile(filepath + this.sectionType.toStr(), buffer);
        }
      }
      const parts = [];
      this.disassembleToFile({ write: (s) => parts.push(s) });
      writeFileSync(filepath + this.sectionType.toStr() + ".s", parts.join(""), "utf8");
    }
  }
}

export function createEmptyFile() {
  return new FileBase(new Context(), 0, 0, 0, "", [], FileSectionType.Unknown, 0, null);
}

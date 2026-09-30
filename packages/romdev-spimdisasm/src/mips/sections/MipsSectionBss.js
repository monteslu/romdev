// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/sections/MipsSectionBss.py

import { GlobalConfig } from "../../common/GlobalConfig.js";
import { FileSectionType } from "../../common/FileSectionType.js";
import { hexU, sortedNumbers } from "../../py/pyutils.js";
import { atLeast } from "../../version.js";
import { SymbolBss } from "../symbols/MipsSymbolBss.js";
import { SectionBase } from "./MipsSectionBase.js";

function assert(cond, msg = "") {
  if (!cond) throw new Error(`AssertionError${msg ? ": " + msg : ""}`);
}

export class SectionBss extends SectionBase {
  constructor(context, vromStart, vromEnd, bssVramStart, bssVramEnd, filename, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, bssVramStart, filename, [], FileSectionType.Bss, segmentVromStart, overlayCategory);

    this.bssVramStart = bssVramStart;
    this.bssVramEnd = bssVramEnd;

    this.vram = bssVramStart;
  }

  get bssTotalSize() {
    return this.bssVramEnd - this.bssVramStart;
  }

  get sizew() {
    if (this.bssVramEnd === undefined) return this.words.length;
    return Math.floor(this.bssTotalSize / 4);
  }

  setVram(vram) {
    super.setVram(vram);
    this.bssVramStart = vram;
    // Same evaluation order as upstream: bssTotalSize already sees the new start
    this.bssVramEnd = vram + this.bssTotalSize;
  }

  analyze() {
    this._checkAndCreateFirstSymbol();

    // If something that could be a pointer found in data happens to be in
    // the middle of this bss file's addresses space then consider it as a
    // new bss variable
    for (const ptr of this.getAndPopPointerInDataReferencesRange(this.bssVramStart, this.bssVramEnd)) {
      // Check if the symbol already exists, in case the user has provided size
      const contextSym = this.getSymbol(ptr, null, true);
      if (contextSym === null) this.addSymbol(ptr, this.sectionType, true);
    }

    const autoCreatedPads = new Set();
    const bssSymbolOffsets = new Set();
    const v142 = atLeast("1.42.0");
    for (const [symbolVram, contextSym] of this.getSymbolsRange(this.bssVramStart, this.bssVramEnd)) {
      // Mark every known symbol that happens to be in this address space as defined
      contextSym.sectionType = FileSectionType.Bss;

      assert(symbolVram >= this.bssVramStart);
      assert(symbolVram < this.bssVramEnd);
      bssSymbolOffsets.add(symbolVram - this.bssVramStart);

      if (v142) {
        // If the bss/sbss has an explicit non-zero size then produce an extra symbol after it,
        // so the generated symbol uses the user-declared size
        if (GlobalConfig.CREATE_BSS_PADS && contextSym.hasUserDeclaredSize()) {
          const contextSymSize = contextSym.getSize();
          if (contextSymSize > 0) {
            const newSymbolVram = symbolVram + contextSymSize;
            if (newSymbolVram !== this.bssVramEnd) {
              assert(newSymbolVram >= this.bssVramStart);
              assert(newSymbolVram < this.bssVramEnd, `${this.name}, symbolVram=${hexU(symbolVram, 8)}, newSymbolVram=${hexU(newSymbolVram, 8)}, self.bssVramEnd=${hexU(this.bssVramEnd, 8)}`);
              const symOffset = symbolVram + contextSymSize - this.bssVramStart;
              bssSymbolOffsets.add(symOffset);
              autoCreatedPads.add(symOffset);
            }
          }
        }
      } else if (contextSym.hasUserDeclaredSize()) {
        // If the bss has an explicit size then produce an extra symbol after it, so the generated bss symbol uses the user-declared size
        const newSymbolVram = symbolVram + contextSym.getSize();
        if (newSymbolVram !== this.bssVramEnd) {
          assert(newSymbolVram >= this.bssVramStart);
          assert(newSymbolVram < this.bssVramEnd, `${this.name}, symbolVram=${hexU(symbolVram, 8)}, newSymbolVram=${hexU(newSymbolVram, 8)}, self.bssVramEnd=${hexU(this.bssVramEnd, 8)}`);
          const symOffset = symbolVram + contextSym.getSize() - this.bssVramStart;
          bssSymbolOffsets.add(symOffset);
          autoCreatedPads.add(symOffset);
        }
      }
    }

    const sortedOffsets = sortedNumbers(bssSymbolOffsets);

    let i = 0;
    while (i < sortedOffsets.length) {
      const symbolOffset = sortedOffsets[i];
      const symbolVram = this.bssVramStart + symbolOffset;

      // Calculate the space of the bss variable
      let space = this.bssTotalSize - symbolOffset;
      if (i + 1 < sortedOffsets.length) {
        const nextSymbolOffset = sortedOffsets[i + 1];
        if (nextSymbolOffset <= this.bssTotalSize) space = nextSymbolOffset - symbolOffset;
      }

      assert(space > 0);

      const vrom = this.getVromOffset(symbolOffset);
      const vromEnd = vrom + space;
      const sym = new SymbolBss(this.context, vrom, vromEnd, symbolOffset + this.inFileOffset, symbolVram, space, this.segmentVromStart, this.overlayCategory);
      sym.parent = this;
      sym.contextSym.autodetectedSize = space;
      sym.setCommentOffset(this.commentOffset);
      if (autoCreatedPads.has(symbolOffset)) sym.contextSym.isAutoCreatedPad = true;
      sym.analyze();
      this.symbolList.push(sym);

      this.symbolsVRams.add(symbolVram);

      i += 1;
    }
  }
}

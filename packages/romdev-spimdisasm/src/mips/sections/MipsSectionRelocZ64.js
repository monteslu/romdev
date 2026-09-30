// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/sections/MipsSectionRelocZ64.py
// Relocation format used by some N64 overlay-based engines.

import path from "node:path";

import { FileSectionType, FileSections_ListBasic } from "../../common/FileSectionType.js";
import { RelocType } from "../../common/Relocation.js";
import * as Utils from "../../common/Utils.js";
import { hexU } from "../../py/pyutils.js";
import { SymbolData } from "../symbols/MipsSymbolData.js";
import { SectionBase } from "./MipsSectionBase.js";

export class RelocEntry {
  constructor(entry) {
    this.sectionId = entry >>> 30;
    this.relocType = (entry >>> 24) & 0x3f;
    this.offset = entry & 0x00ffffff;
  }

  get reloc() {
    return ((this.sectionId << 30) | (this.relocType << 24) | this.offset) >>> 0;
  }

  getSectionType() {
    return FileSectionType.fromId(this.sectionId);
  }

  getRelocType() {
    return RelocType.fromValue(this.relocType);
  }

  toString() {
    const section = this.getSectionType().toStr();
    let relocName = "None";
    const reloc = this.getRelocType();
    if (reloc !== null) relocName = reloc.name;
    return `${section} ${relocName} 0x${hexU(this.offset)}`;
  }
}

export class SectionRelocZ64 extends SectionBase {
  constructor(context, vromStart, vromEnd, vram, filename, array_of_bytes, segmentVromStart, overlayCategory) {
    super(context, vromStart, vromEnd, vram, filename, Utils.bytesToWords(array_of_bytes, vromStart, vromEnd), FileSectionType.Reloc, segmentVromStart, overlayCategory);

    this.seekup = this.words.at(-1);

    this.setCommentOffset(this.sizew * 4 - this.seekup);

    // Remove non reloc stuff
    const n = Math.floor(-this.seekup / 4);
    this.words = n === 0 ? this.words.slice(0) : this.words.slice(n);

    this.sectionSizes = new Map([
      [FileSectionType.Text, this.words[0]],
      [FileSectionType.Data, this.words[1]],
      [FileSectionType.Rodata, this.words[2]],
      [FileSectionType.Bss, this.words[3]],
    ]);
    this.relocCount = this.words[4];

    this.tail = this.words.slice(this.relocCount + 5, -1);

    this.entries = [];
    for (const word of this.words.slice(5, this.relocCount + 5)) this.entries.push(new RelocEntry(word));

    this.differentSegment = false;

    this.sectionFlags = "a";
    this.enableStringGuessing = false;
  }

  get nRelocs() {
    return this.entries.length;
  }

  get textSize() {
    return this.sectionSizes.get(FileSectionType.Text);
  }

  get dataSize() {
    return this.sectionSizes.get(FileSectionType.Data);
  }

  get rodataSize() {
    return this.sectionSizes.get(FileSectionType.Rodata);
  }

  get bssSize() {
    return this.sectionSizes.get(FileSectionType.Bss);
  }

  _makeSym(localOffset, vromLen, words, name) {
    const currentVram = this.getVramOffset(localOffset);
    const vrom = this.getVromOffset(localOffset);
    const vromEnd = vrom + vromLen;
    const sym = new SymbolData(this.context, vrom, vromEnd, localOffset + this.inFileOffset, currentVram, words, this.segmentVromStart, this.overlayCategory);
    sym.contextSym.name = name;
    sym.contextSym.userDeclaredType = "s32";
    sym.contextSym.allowedToReferenceSymbols = false;
    sym.contextSym.allowedToBeReferenced = false;
    sym.parent = this;
    sym.setCommentOffset(this.commentOffset);
    return sym;
  }

  analyze() {
    // The name may be a path, so we take the name of the file and discard everything else
    const relocName = path.parse(this.name).name;

    let localOffset = 0;

    let sym = this._makeSym(localOffset, 4 * 4, this.words.slice(0, 4), `${relocName}_OverlayInfo`);
    sym.endOfLineComment = new Map(FileSections_ListBasic.map((sectName, i) => [i, ` /* _${relocName}Segment${sectName.toCapitalizedStr()}Size */`]));
    sym.analyze();
    this.symbolList.push(sym);
    localOffset += 4 * 4;

    sym = this._makeSym(localOffset, 4, [this.relocCount], `${relocName}_RelocCount`);
    sym.analyze();
    this.symbolList.push(sym);
    localOffset += 4;

    sym = this._makeSym(localOffset, 4 * this.entries.length, this.entries.map((r) => r.reloc), `${relocName}_OverlayRelocations`);
    sym.endOfLineComment = new Map(this.entries.map((r, i) => [i, ` /* ${r.toString()} */`]));
    sym.analyze();
    this.symbolList.push(sym);
    localOffset += 4 * this.entries.length;

    if (this.tail.length > 0) {
      sym = this._makeSym(localOffset, 4 * this.tail.length, this.tail, `${relocName}_Padding`);
      sym.analyze();
      this.symbolList.push(sym);
      localOffset += 4 * this.tail.length;
    }

    sym = this._makeSym(localOffset, 4, [this.seekup], `${relocName}_OverlayInfoOffset`);
    sym.analyze();
    this.symbolList.push(sym);

    for (const s of this.symbolList) {
      if (s.vram !== null) this.symbolsVRams.add(s.vram);
    }
  }
}

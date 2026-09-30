// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/MipsFileSplits.py

import { FileSectionType, FileSections_ListBasic, FileSections_ListAll } from "../common/FileSectionType.js";
import { FileSplitEntry } from "../common/FileSplitFormat.js";
import { GlobalConfig } from "../common/GlobalConfig.js";
import * as Utils from "../common/Utils.js";
import { FileBase, createEmptyFile } from "./MipsFileBase.js";
import { SectionText } from "./sections/MipsSectionText.js";
import * as FilesHandlers from "./FilesHandlers.js";

export class FileSplits extends FileBase {
  constructor(context, vromStart, vromEnd, vram, filename, array_of_bytes, segmentVromStart, overlayCategory, splitsData = null, relocSection = null) {
    super(context, vromStart, vromEnd, vram, filename, Utils.bytesToWords(array_of_bytes, vromStart, vromEnd), FileSectionType.Unknown, segmentVromStart, overlayCategory);

    this.sectionsDict = new Map([
      [FileSectionType.Text, new Map()],
      [FileSectionType.Data, new Map()],
      [FileSectionType.Rodata, new Map()],
      [FileSectionType.Bss, new Map()],
      [FileSectionType.Reloc, new Map()],
    ]);

    this.splitsDataList = [];

    if (relocSection !== null && relocSection !== undefined) {
      relocSection.parent = this;
      if (!relocSection.differentSegment) {
        let relocStart = relocSection.textSize + relocSection.dataSize + relocSection.rodataSize;
        if (relocSection.differentSegment) relocStart += relocSection.bssSize;
        relocSection.vram = this.vram + relocStart;
      }
      this.sectionsDict.get(FileSectionType.Reloc).set(filename, relocSection);
    }

    if ((splitsData === null || splitsData === undefined) && (relocSection === null || relocSection === undefined)) {
      this.sectionsDict.get(FileSectionType.Text).set(filename, new SectionText(context, vromStart, vromEnd, vram, filename, array_of_bytes, segmentVromStart, overlayCategory));
    } else if (splitsData !== null && splitsData !== undefined && splitsData.length > 0) {
      for (const splitEntry of splitsData) this.splitsDataList.push(splitEntry);
    } else if (relocSection !== null && relocSection !== undefined) {
      let start = 0;
      let end = 0;
      for (let i = 0; i < FileSections_ListBasic.length; i++) {
        const sectionType = FileSections_ListBasic[i];
        const sectionSize = relocSection.sectionSizes.get(sectionType);

        if (i !== 0) start += relocSection.sectionSizes.get(FileSections_ListBasic[i - 1]);
        end += relocSection.sectionSizes.get(sectionType);

        if (sectionType === FileSectionType.Bss) {
          // bss is after reloc when the relocation is on the same segment
          if (!relocSection.differentSegment) {
            start += relocSection.sizew * 4;
            end += relocSection.sizew * 4;
          }
        }

        if (sectionSize === 0) continue;

        const v = this.vram + start;
        const splitEntry = new FileSplitEntry(start, v, filename, sectionType, end, false, false);
        this.splitsDataList.push(splitEntry);
      }
    }

    for (const splitEntry of this.splitsDataList) {
      if (splitEntry.section === FileSectionType.Dummy) continue;

      const f = FilesHandlers.createSectionFromSplitEntry(splitEntry, array_of_bytes, context, vromStart);
      f.parent = this;
      f.setCommentOffset(splitEntry.offset);

      this.sectionsDict.get(splitEntry.section).set(splitEntry.fileName, f);
    }
  }

  get nFuncs() {
    let nFuncs = 0;
    for (const f of this.sectionsDict.get(FileSectionType.Text).values()) nFuncs += f.nFuncs;
    return nFuncs;
  }

  setVram(vram) {
    super.setVram(vram);
    for (const sectDict of this.sectionsDict.values()) for (const section of sectDict.values()) section.setVram(vram);
  }

  getHash() {
    const words = [];
    for (const sectDict of this.sectionsDict.values()) for (const section of sectDict.values()) words.push(...section.words);
    return Utils.getStrHash(Utils.wordsToBytes(words));
  }

  analyze() {
    for (const relocSection of this.sectionsDict.get(FileSectionType.Reloc).values()) {
      for (const entry of relocSection.entries) {
        const sectionType = entry.getSectionType();
        if (entry.reloc === 0) continue;
        for (const subFile of this.sectionsDict.get(sectionType).values()) subFile.pointersOffsets.add(entry.offset);
      }
    }

    for (const sectDict of this.sectionsDict.values()) for (const section of sectDict.values()) section.analyze();
  }

  compareToFile(other_file) {
    if (other_file instanceof FileSplits) {
      const filesections = new Map([
        [FileSectionType.Text, new Map()],
        [FileSectionType.Data, new Map()],
        [FileSectionType.Rodata, new Map()],
        [FileSectionType.Bss, new Map()],
        [FileSectionType.Reloc, new Map()],
      ]);

      for (const sectionType of FileSections_ListAll) {
        const mine = this.sectionsDict.get(sectionType) ?? new Map();
        const theirs = other_file.sectionsDict.get(sectionType) ?? new Map();
        if (!filesections.has(sectionType)) filesections.set(sectionType, new Map());
        const out = filesections.get(sectionType);
        for (const [section_name, section] of mine) {
          if (theirs.has(section_name)) out.set(section_name, section.compareToFile(theirs.get(section_name)));
          else out.set(section_name, section.compareToFile(createEmptyFile()));
        }
        for (const [section_name, other_section] of theirs) {
          if (mine.has(section_name)) {
            const section = mine.get(section_name);
            if (!out.has(section_name)) out.set(section_name, section.compareToFile(other_section));
          } else {
            out.set(section_name, createEmptyFile().compareToFile(other_section));
          }
        }
      }

      return { filesections };
    }

    return super.compareToFile(other_file);
  }

  blankOutDifferences(other_file) {
    if (!GlobalConfig.REMOVE_POINTERS) return false;
    if (!(other_file instanceof FileSplits)) return false;

    let was_updated = false;
    for (const sectionType of FileSections_ListAll) {
      const mine = this.sectionsDict.get(sectionType) ?? new Map();
      const theirs = other_file.sectionsDict.get(sectionType) ?? new Map();
      for (const [section_name, section] of mine) {
        if (theirs.has(section_name)) was_updated = section.blankOutDifferences(theirs.get(section_name)) || was_updated;
      }
      for (const [section_name, other_section] of theirs) {
        if (mine.has(section_name)) was_updated = mine.get(section_name).blankOutDifferences(other_section) || was_updated;
      }
    }
    return was_updated;
  }

  removePointers() {
    if (!GlobalConfig.REMOVE_POINTERS) return false;
    let was_updated = false;
    for (const sectDict of this.sectionsDict.values()) for (const section of sectDict.values()) was_updated = section.removePointers() || was_updated;
    return was_updated;
  }

  saveToFile(filepath) {
    for (const sectDict of this.sectionsDict.values()) {
      for (let [name, section] of sectDict) {
        if (name !== "" && !filepath.endsWith("/")) name = " " + name;
        section.saveToFile(filepath + name);
      }
    }
  }
}

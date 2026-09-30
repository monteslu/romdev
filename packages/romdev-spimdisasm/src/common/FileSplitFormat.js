// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/FileSplitFormat.py

import * as Utils from "./Utils.js";
import { FileSectionType } from "./FileSectionType.js";
import { hexU, pyInt } from "../py/pyutils.js";

export class FileSplitEntry {
  constructor(offset, vram, fileName, section, nextOffset, isHandwritten, isRsp) {
    this.offset = offset;
    this.vram = vram;
    this.fileName = fileName;
    this.section = section;
    this.nextOffset = nextOffset;
    this.isHandwritten = isHandwritten;
    this.isRsp = isRsp;
  }
}

export class FileSplitFormat {
  constructor(csvPath = null) {
    this.splits = [];
    if (csvPath !== null && csvPath !== undefined) this.readCsvFile(csvPath);
  }

  get length() {
    return this.splits.length;
  }

  *[Symbol.iterator]() {
    let section = FileSectionType.Invalid;

    for (let i = 0; i < this.splits.length; i++) {
      const row = this.splits[i];
      if (row.length !== 3) throw new Error(`ValueError: expected 3 values, got ${row.length}`);
      let [offsetStr, vramStr, fileName] = row;

      let isHandwritten = false;
      let isRsp = false;
      offsetStr = offsetStr.toUpperCase();
      if (offsetStr.at(-1) === "H") {
        isHandwritten = true;
        offsetStr = offsetStr.slice(0, -1);
      } else if (offsetStr.at(-1) === "R") {
        isRsp = true;
        offsetStr = offsetStr.slice(0, -1);
      }

      const possibleSection = FileSectionType.fromStr(fileName);
      if (possibleSection !== FileSectionType.Invalid) {
        if (possibleSection === FileSectionType.End) break;
        section = possibleSection;
        continue;
      }

      const vram = pyInt(vramStr, 16);
      const offset = pyInt(offsetStr, 16);
      let nextOffset = 0xffffff;
      if (i + 1 < this.splits.length) {
        let nextOffsetStr;
        if (this.splits[i + 1][2] === ".end") nextOffsetStr = this.splits[i + 1][0];
        else if (this.splits[i + 1][2].startsWith(".")) nextOffsetStr = this.splits[i + 2][0];
        else nextOffsetStr = this.splits[i + 1][0];
        const last = nextOffsetStr.toUpperCase().at(-1);
        if (last === "H" || last === "R") nextOffsetStr = nextOffsetStr.slice(0, -1);
        nextOffset = pyInt(nextOffsetStr, 16);
      }

      yield new FileSplitEntry(offset, vram, fileName, section, nextOffset, isHandwritten, isRsp);
    }
  }

  readCsvFile(csvPath) {
    this.splits = Utils.readCsv(csvPath);
    this.splits = this.splits.filter((x) => x.length > 0);
  }

  append(element) {
    if (element instanceof FileSplitEntry) {
      let offset = hexU(element.offset);
      if (element.isRsp) offset += "R";
      else if (element.isHandwritten) offset += "H";

      const vram = hexU(element.vram);
      const fileName = element.fileName;

      if (element.section !== FileSectionType.Invalid) {
        const section = element.section.toStr();
        this.splits.push(["offset", "vram", section]);
      }

      this.splits.push([offset, vram, fileName]);
    } else if (Array.isArray(element)) {
      if (element.length !== 3) throw new TypeError();
      for (const x of element) if (typeof x !== "string") throw new TypeError();
      this.splits.push(element);
    } else {
      throw new TypeError();
    }
  }

  appendEndSection(offset, vram) {
    this.splits.push([hexU(offset), hexU(vram), ".end"]);
  }
}

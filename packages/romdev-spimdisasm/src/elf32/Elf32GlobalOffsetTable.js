// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32GlobalOffsetTable.py

import { Elf32SectionHeaderNumber } from "./Elf32Constants.js";
import { unpackFrom, endianFmt } from "./_util.js";

export class GotEntry {
  constructor(symEntry, initial = null) {
    this.symEntry = symEntry;
    this.initial = initial;
  }

  getAddress() {
    if (this.initial !== null) return this.initial;
    return this.symEntry.value;
  }
}

export class Elf32GlobalOffsetTable {
  constructor(array_of_bytes, offset, rawSize) {
    this.offset = offset;
    this.rawSize = rawSize;

    this.entries = unpackFrom(endianFmt() + `${Math.floor(rawSize / 4)}I`, array_of_bytes, offset);

    this.localsTable = [];
    this.globalsTable = [];
  }

  /** Python __getitem__ */
  get(key) {
    let idx = key;
    if (idx < 0) idx += this.entries.length;
    if (idx < 0 || idx >= this.entries.length) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
    return this.entries[idx];
  }

  getItem(key) {
    return this.get(key);
  }

  get length() {
    return this.entries.length;
  }

  initTables(dynamic, dynsym) {
    if (dynamic.gotSym === null || dynamic.localGotNo === null) return;

    for (let i = 0; i < dynamic.localGotNo; i++) this.localsTable.push(this.get(i));

    for (let i = dynamic.gotSym; i < dynsym.length; i++) {
      const symEntry = dynsym.get(i);
      const gotEntry = new GotEntry(symEntry);

      if (symEntry.shndx === Elf32SectionHeaderNumber.UNDEF.value || symEntry.shndx === Elf32SectionHeaderNumber.COMMON.value) {
        const gotIndex = dynamic.localGotNo + (i - dynamic.gotSym);
        gotEntry.initial = this.get(gotIndex);
      }

      this.globalsTable.push(gotEntry);
    }
  }
}

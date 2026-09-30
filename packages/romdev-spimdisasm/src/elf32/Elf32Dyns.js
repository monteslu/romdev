// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32Dyns.py

import { Elf32DynamicTable } from "./Elf32Constants.js";
import { unpackFrom, endianFmt, dataclassRepr } from "./_util.js";

// a.k.a. Dyn
export class Elf32DynEntry {
  /** tag: dynamic entry type, val: integer value */
  constructor(tag, val) {
    this.tag = tag;
    this.val = val;
  }

  /** Address value */
  get ptr() {
    return this.val;
  }

  static fromBytearray(array_of_bytes, offset = 0) {
    return new Elf32DynEntry(...unpackFrom(endianFmt() + "II", array_of_bytes, offset));
  }

  static structSize() {
    return 0x08;
  }

  __repr__() {
    return dataclassRepr("Elf32DynEntry", this, ["tag", "val"]);
  }

  toString() {
    return this.__repr__();
  }
}

export class Elf32Dyns {
  constructor(array_of_bytes, offset, rawSize) {
    this.dyns = [];
    this.offset = offset;
    this.rawSize = rawSize;

    this.pltGot = null;
    this.localGotNo = null;
    this.symTabNo = null;
    this.gotSym = null;

    const n = Math.floor(rawSize / Elf32DynEntry.structSize());
    for (let i = 0; i < n; i++) {
      const entry = Elf32DynEntry.fromBytearray(array_of_bytes, offset + i * Elf32DynEntry.structSize());
      this.dyns.push(entry);

      if (entry.tag === Elf32DynamicTable.PLTGOT.value) this.pltGot = entry.val;
      else if (entry.tag === Elf32DynamicTable.MIPS_LOCAL_GOTNO.value) this.localGotNo = entry.val;
      else if (entry.tag === Elf32DynamicTable.MIPS_SYMTABNO.value) this.symTabNo = entry.val;
      else if (entry.tag === Elf32DynamicTable.MIPS_GOTSYM.value) this.gotSym = entry.val;
    }
  }

  /** Python __getitem__ */
  get(key) {
    let idx = key;
    if (idx < 0) idx += this.dyns.length;
    if (idx < 0 || idx >= this.dyns.length) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
    return this.dyns[idx];
  }

  getItem(key) {
    return this.get(key);
  }

  [Symbol.iterator]() {
    return this.dyns[Symbol.iterator]();
  }

  getGpValue() {
    if (this.pltGot === null) return null;
    return this.pltGot + 0x7ff0;
  }
}

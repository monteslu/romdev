// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32StringTable.py
//
// Python `strtab[key]` is `strtab.get(key)` here.

import { decodeUtf8 } from "./_util.js";

const encoder = new TextEncoder();

// a.k.a. strtab (string table)
export class Elf32StringTable {
  constructor(array_of_bytes, offset, rawsize) {
    this.strings = array_of_bytes.slice(offset, offset + rawsize);
    this.offset = offset;
    this.rawsize = rawsize;
  }

  /** Python __getitem__: NUL-terminated UTF-8 string starting at `key`. */
  get(key) {
    let i = key;
    if (i < 0) i += this.strings.length;
    const start = i;
    for (;;) {
      if (i < 0 || i >= this.strings.length) throw Object.assign(new Error("index out of range"), { name: "IndexError" });
      if (this.strings[i] === 0) break;
      i += 1;
    }
    return decodeUtf8(this.strings.subarray(start, i));
  }

  getItem(key) {
    return this.get(key);
  }

  *[Symbol.iterator]() {
    let i = 0;
    while (i < this.rawsize) {
      const string = this.get(i);
      yield string;
      i += encoder.encode(string).length + 1;
    }
  }
}

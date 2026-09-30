// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32Rels.py

import { unpackFrom, endianFmt, dataclassRepr } from "./_util.js";

export class Elf32RelEntry {
  constructor(offset, info) {
    this.offset = offset;
    this.info = info;
  }

  get rSym() {
    return this.info >>> 8;
  }

  get rType() {
    return this.info & 0xff;
  }

  static fromBytearray(array_of_bytes, offset = 0) {
    return new Elf32RelEntry(...unpackFrom(endianFmt() + "II", array_of_bytes, offset));
  }

  __repr__() {
    return dataclassRepr("Elf32RelEntry", this, ["offset", "info"]);
  }

  toString() {
    return this.__repr__();
  }
}

export class Elf32Rels {
  constructor(sectionName, array_of_bytes, offset, rawSize) {
    this.sectionName = sectionName;
    this.relocations = [];
    this.offset = offset;
    this.rawSize = rawSize;

    const n = Math.floor(rawSize / 0x08);
    for (let i = 0; i < n; i++) this.relocations.push(Elf32RelEntry.fromBytearray(array_of_bytes, offset + i * 0x08));
  }

  [Symbol.iterator]() {
    return this.relocations[Symbol.iterator]();
  }
}

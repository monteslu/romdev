// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32Syms.py

import { unpackFrom, endianFmt, dataclassRepr } from "./_util.js";

const FIELDS = ["name", "value", "size", "info", "other", "shndx"];

// a.k.a. Sym (symbol)
export class Elf32SymEntry {
  constructor(name, value, size, info, other, shndx) {
    this.name = name;
    this.value = value;
    this.size = size;
    this.info = info;
    this.other = other;
    this.shndx = shndx;
  }

  get stBind() {
    return this.info >> 4;
  }

  get stType() {
    return this.info & 0xf;
  }

  static fromBytearray(array_of_bytes, offset = 0) {
    return new Elf32SymEntry(...unpackFrom(endianFmt() + "IIIBBH", array_of_bytes, offset));
  }

  static structSize() {
    return 0x10;
  }

  __repr__() {
    return dataclassRepr("Elf32SymEntry", this, FIELDS);
  }

  toString() {
    return this.__repr__();
  }
}

export class Elf32Syms {
  constructor(array_of_bytes, offset, rawSize) {
    this.symbols = [];
    this.offset = offset;
    this.rawSize = rawSize;

    const n = Math.floor(rawSize / Elf32SymEntry.structSize());
    for (let i = 0; i < n; i++) this.symbols.push(Elf32SymEntry.fromBytearray(array_of_bytes, offset + i * Elf32SymEntry.structSize()));
  }

  /** Python __getitem__ */
  get(key) {
    let idx = key;
    if (idx < 0) idx += this.symbols.length;
    if (idx < 0 || idx >= this.symbols.length) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
    return this.symbols[idx];
  }

  getItem(key) {
    return this.get(key);
  }

  [Symbol.iterator]() {
    return this.symbols[Symbol.iterator]();
  }

  get length() {
    return this.symbols.length;
  }
}

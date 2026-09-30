// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32SectionHeaders.py
//
// Python `headers[key]` is `headers.get(key)` here (same None cases and the
// same IndexError when key == len(headers)).

import * as Utils from "../common/Utils.js";
import { Elf32SectionHeaderNumber } from "./Elf32Constants.js";
import { unpackFrom, endianFmt, dataclassRepr } from "./_util.js";

const FIELDS = ["name", "type", "flags", "addr", "offset", "size", "link", "info", "addralign", "entsize"];

// a.k.a. Shdr (section header)
export class Elf32SectionHeaderEntry {
  constructor(name, type, flags, addr, offset, size, link, info, addralign, entsize) {
    this.name = name;
    this.type = type;
    this.flags = flags;
    this.addr = addr;
    this.offset = offset;
    this.size = size;
    this.link = link;
    this.info = info;
    this.addralign = addralign;
    this.entsize = entsize;
  }

  static fromBytearray(array_of_bytes, offset = 0) {
    const unpacked = unpackFrom(endianFmt() + "10I", array_of_bytes, offset);
    return new Elf32SectionHeaderEntry(...unpacked);
  }

  __repr__() {
    return dataclassRepr("Elf32SectionHeaderEntry", this, FIELDS);
  }

  toString() {
    return this.__repr__();
  }
}

export class Elf32SectionHeaders {
  constructor(array_of_bytes, shoff, shnum) {
    this.sections = [];
    this.shoff = shoff;
    this.shnum = shnum;

    this.mipsText = null;
    this.mipsData = null;

    for (let i = 0; i < shnum; i++) {
      this.sections.push(Elf32SectionHeaderEntry.fromBytearray(array_of_bytes, shoff + i * 0x28));
    }
  }

  /** Python __getitem__ */
  get(key) {
    if (key === Elf32SectionHeaderNumber.UNDEF.value) return null;
    if (key === Elf32SectionHeaderNumber.COMMON.value) {
      Utils.eprint("Warning: Elf32SectionHeaderNumber.COMMON not implemented\n");
      return null;
    }
    if (key === Elf32SectionHeaderNumber.MIPS_ACOMMON.value) {
      Utils.eprint("Warning: Elf32SectionHeaderNumber.MIPS_ACOMMON not implemented\n");
      return null;
    }
    if (key === Elf32SectionHeaderNumber.MIPS_TEXT.value) return this.mipsText;
    if (key === Elf32SectionHeaderNumber.MIPS_DATA.value) return this.mipsData;
    if (key === Elf32SectionHeaderNumber.MIPS_SCOMMON.value) {
      Utils.eprint("Warning: Elf32SectionHeaderNumber.MIPS_SCOMMON not implemented\n");
      return null;
    }
    if (key === Elf32SectionHeaderNumber.MIPS_SUNDEFINED.value) {
      Utils.eprint("Warning: Elf32SectionHeaderNumber.MIPS_SUNDEFINED not implemented\n");
      return null;
    }
    if (key > this.sections.length) return null;
    let idx = key;
    if (idx < 0) idx += this.sections.length;
    if (idx < 0 || idx >= this.sections.length) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
    return this.sections[idx];
  }

  getItem(key) {
    return this.get(key);
  }

  [Symbol.iterator]() {
    return this.sections[Symbol.iterator]();
  }

  get length() {
    return this.sections.length;
  }
}

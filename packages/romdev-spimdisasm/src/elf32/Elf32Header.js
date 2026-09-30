// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32Header.py

import { Elf32HeaderIdentifier } from "./Elf32Constants.js";
import { unpackFrom, enumCall, dataclassRepr } from "./_util.js";

export class Elf32Identifier {
  /** ident: 16 bytes as a list of ints */
  constructor(ident) {
    this.ident = ident;
  }

  checkMagic() {
    if (this.ident[0] !== 0x7f) return false;
    if (this.ident[1] !== 0x45) return false; // 'E'
    if (this.ident[2] !== 0x4c) return false; // 'L'
    if (this.ident[3] !== 0x46) return false; // 'F'
    return true;
  }

  getFileClass() {
    return enumCall(Elf32HeaderIdentifier.FileClass, this.ident[4]);
  }

  getDataEncoding() {
    return enumCall(Elf32HeaderIdentifier.DataEncoding, this.ident[5]);
  }

  getVersion() {
    return this.ident[6];
  }

  getOsAbi() {
    return enumCall(Elf32HeaderIdentifier.OsAbi, this.ident[7]);
  }

  getAbiVersion() {
    return this.ident[8];
  }

  // should always return 0
  getPad() {
    return this.ident[9];
  }

  static fromBytearray(array_of_bytes, offset = 0) {
    const ident = unpackFrom(">16B", array_of_bytes, 0 + offset);
    const identifier = new Elf32Identifier(ident);

    if (!identifier.checkMagic()) throw Object.assign(new Error("Not an ELF file: wrong magic"), { name: "RuntimeError" });

    if (identifier.getFileClass() !== Elf32HeaderIdentifier.FileClass.CLASS32) {
      throw Object.assign(new Error(`Unsupported ELF file class: ${identifier.getFileClass()} (expected CLASS32)`), { name: "RuntimeError" });
    }

    if (identifier.getPad() !== 0) throw new Error("AssertionError");

    return identifier;
  }

  static structSize() {
    return 0x10;
  }

  __repr__() {
    return dataclassRepr("Elf32Identifier", this, ["ident"]);
  }

  toString() {
    return this.__repr__();
  }
}

const HEADER_FIELDS = ["ident", "type", "machine", "version", "entry", "phoff", "shoff", "flags", "ehsize", "phentsize", "phnum", "shentsize", "shnum", "shstrndx"];

// a.k.a. Ehdr (elf header)
export class Elf32Header {
  constructor(ident, type, machine, version, entry, phoff, shoff, flags, ehsize, phentsize, phnum, shentsize, shnum, shstrndx) {
    this.ident = ident;
    this.type = type;
    this.machine = machine;
    this.version = version;
    this.entry = entry;
    this.phoff = phoff;
    this.shoff = shoff;
    this.flags = flags;
    this.ehsize = ehsize;
    this.phentsize = phentsize;
    this.phnum = phnum;
    this.shentsize = shentsize;
    this.shnum = shnum;
    this.shstrndx = shstrndx;
  }

  static fromBytearray(array_of_bytes, offset = 0) {
    const identifier = Elf32Identifier.fromBytearray(array_of_bytes, offset);

    const dataEncoding = identifier.getDataEncoding();
    let endianFormat;
    if (dataEncoding === Elf32HeaderIdentifier.DataEncoding.DATA2MSB) endianFormat = ">";
    else if (dataEncoding === Elf32HeaderIdentifier.DataEncoding.DATA2LSB) endianFormat = "<";
    else throw Object.assign(new Error(`Unsupported ELF data encoding: ${dataEncoding}`), { name: "RuntimeError" });

    const unpacked = unpackFrom(endianFormat + "HHIIIIIHHHHHH", array_of_bytes, Elf32Identifier.structSize() + offset);
    return new Elf32Header(identifier, ...unpacked);
  }

  static structSize() {
    return 0x34;
  }

  __repr__() {
    return dataclassRepr("Elf32Header", this, HEADER_FIELDS);
  }

  toString() {
    return this.__repr__();
  }
}

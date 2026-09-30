// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32RegInfo.py

import { unpackFrom, endianFmt, dataclassRepr } from "./_util.js";

export class Elf32RegInfo {
  /** gprmask: uint32, cprmask: uint32[4], gpValue: int32 */
  constructor(gprmask, cprmask, gpValue) {
    this.gprmask = gprmask;
    this.cprmask = cprmask;
    this.gpValue = gpValue;
  }

  static fromBytearray(array_of_bytes, offset = 0) {
    const gpr = unpackFrom(endianFmt() + "I", array_of_bytes, 0 + offset)[0];
    const cpr = unpackFrom(endianFmt() + "4I", array_of_bytes, 4 + offset);
    const gp = unpackFrom(endianFmt() + "i", array_of_bytes, 0x14 + offset)[0];
    return new Elf32RegInfo(gpr, cpr, gp);
  }

  __repr__() {
    return dataclassRepr("Elf32RegInfo", this, ["gprmask", "cprmask", "gpValue"]);
  }

  toString() {
    return this.__repr__();
  }
}

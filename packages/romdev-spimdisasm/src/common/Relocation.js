// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/Relocation.py

import { createEnum, hexU } from "../py/pyutils.js";
import { ContextSymbol } from "./ContextSymbols.js";
import { GlobalConfig } from "./GlobalConfig.js";

let _percentRel;
let _wordRel;
let _operationRel;

export const RelocType = createEnum(
  "RelocType",
  [
    ["MIPS_NONE", 0],
    ["MIPS_16", 1],
    ["MIPS_32", 2],
    ["MIPS_REL32", 3],
    ["MIPS_26", 4],
    ["MIPS_HI16", 5],
    ["MIPS_LO16", 6],
    ["MIPS_GPREL16", 7],
    ["MIPS_LITERAL", 8],
    ["MIPS_GOT16", 9],
    ["MIPS_PC16", 10],
    ["MIPS_CALL16", 11],
    ["MIPS_GPREL32", 12],
    ["MIPS_GOT_HI16", 22],
    ["MIPS_GOT_LO16", 23],
    ["MIPS_CALL_HI16", 30],
    ["MIPS_CALL_LO16", 31],
    ["CUSTOM_CONSTANT_HI", -1],
    ["CUSTOM_CONSTANT_LO", -2],
  ],
  {
    getPercentRel() {
      return _percentRel.has(this) ? _percentRel.get(this) : null;
    },
    getWordRel() {
      return _wordRel.has(this) ? _wordRel.get(this) : null;
    },
  },
  {
    fromValue(value) {
      return RelocType.fromValueOrNull(value);
    },
    fromStr(value) {
      value = value.toUpperCase();
      for (const m of RelocType.members) if (m.name === value) return m;
      return null;
    },
  },
);

_percentRel = new Map([
  [RelocType.MIPS_HI16, "%hi"],
  [RelocType.MIPS_LO16, "%lo"],
  [RelocType.MIPS_GPREL16, "%gp_rel"],
  [RelocType.MIPS_GOT16, "%got"],
  [RelocType.MIPS_CALL16, "%call16"],
  [RelocType.MIPS_GOT_HI16, "%got_hi"],
  [RelocType.MIPS_GOT_LO16, "%got_lo"],
  [RelocType.MIPS_CALL_HI16, "%call_hi"],
  [RelocType.MIPS_CALL_LO16, "%call_lo"],
]);

_wordRel = new Map([
  [RelocType.MIPS_32, ".word"],
  [RelocType.MIPS_GPREL32, ".gpword"],
]);

_operationRel = new Map([
  [RelocType.CUSTOM_CONSTANT_HI, ">> 16"],
  [RelocType.CUSTOM_CONSTANT_LO, "& 0xFFFF"],
]);

export class RelocationStaticReference {
  constructor(sectionType, sectionVram) {
    this.sectionType = sectionType;
    this.sectionVram = sectionVram;
  }
}

export class RelocationInfo {
  constructor(relocType, symbol, addend = 0, staticReference = null, globalReloc = false) {
    this.relocType = relocType;
    this.symbol = symbol;
    this.addend = addend;
    this.staticReference = staticReference;
    this.globalReloc = globalReloc;
  }

  getName(isSplittedSymbol = false) {
    let name;
    if (this.symbol instanceof ContextSymbol) name = this.symbol.getName();
    else name = this.symbol;

    if (this.addend === 0) return name;

    if (GlobalConfig.COMPILER.value.bigAddendWorkaroundForMigratedFunctions && isSplittedSymbol) {
      if (this.relocType === RelocType.MIPS_LO16) {
        if (this.addend < -0x8000) return `${name} - (0x${hexU(-this.addend)} & 0xFFFF)`;
        if (this.addend > 0x7fff) return `${name} + (0x${hexU(this.addend)} & 0xFFFF)`;
      }
    }

    if (this.addend < 0) return `${name} - 0x${hexU(-this.addend)}`;
    return `${name} + 0x${hexU(this.addend)}`;
  }

  getNameWithReloc(isSplittedSymbol = false, ignoredRelocs = null) {
    if (ignoredRelocs === null || ignoredRelocs === undefined) ignoredRelocs = new Set();
    const name = this.getName(isSplittedSymbol);

    const percentRel = this.relocType.getPercentRel();
    if (percentRel !== null) {
      if (ignoredRelocs.has(this.relocType)) return `(${name})`;
      return `${percentRel}(${name})`;
    }

    const wordRel = this.relocType.getWordRel();
    if (wordRel !== null) return `${wordRel} ${name}`;

    const operationRel = _operationRel.has(this.relocType) ? _operationRel.get(this.relocType) : null;
    if (operationRel !== null) return `(${name} ${operationRel})`;

    return name;
  }

  getInlineStr(isSplittedSymbol = false) {
    let output = `    # ${this.relocType.name} '${this.getName(isSplittedSymbol)}'`;
    if (this.staticReference !== null) output += " (static)";
    if (this.globalReloc) output += " (global reloc)";
    output += `${GlobalConfig.LINE_ENDS}`;
    return output;
  }

  isRelocNone() {
    return this.relocType === RelocType.MIPS_NONE;
  }
}

// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/FileSectionType.py

import { createEnum } from "../py/pyutils.js";

let gNameToSectionType;
let gSmallNameToSectionType;

export const FileSectionType = createEnum(
  "FileSectionType",
  [
    ["Dummy", -4],
    ["End", -3],
    ["Unknown", -2],
    ["Invalid", -1],
    ["Text", 1],
    ["Data", 2],
    ["Rodata", 3],
    ["Bss", 4],
    ["Reloc", 5],
    ["GccExceptTable", 6],
  ],
  {
    toStr() {
      switch (this.name) {
        case "Text": return ".text";
        case "Data": return ".data";
        case "Rodata": return ".rodata";
        case "Bss": return ".bss";
        case "Reloc": return ".reloc";
        case "GccExceptTable": return ".gcc_except_table";
        default: return "";
      }
    },
    toCapitalizedStr() {
      switch (this.name) {
        case "Text": return "Text";
        case "Data": return "Data";
        case "Rodata": return "RoData";
        case "Bss": return "Bss";
        case "Reloc": return "Reloc";
        case "GccExceptTable": return "GccExceptTable";
        default: return "";
      }
    },
    toSectionName() {
      switch (this.name) {
        case "Text": return ".text";
        case "Data": return ".data";
        case "Rodata": return ".rodata";
        case "Bss": return ".bss";
        case "Reloc": return ".ovl";
        case "GccExceptTable": return ".gcc_except_table";
        default: return "";
      }
    },
  },
  {
    fromId(sectionId) {
      const m = FileSectionType.fromValueOrNull(sectionId);
      return m === null ? FileSectionType.Invalid : m;
    },
    fromStr(x) {
      return gNameToSectionType.has(x) ? gNameToSectionType.get(x) : FileSectionType.Invalid;
    },
    fromSmallStr(x) {
      return gSmallNameToSectionType.has(x) ? gSmallNameToSectionType.get(x) : FileSectionType.Invalid;
    },
  },
);

gNameToSectionType = new Map([
  [".text", FileSectionType.Text],
  [".data", FileSectionType.Data],
  [".rodata", FileSectionType.Rodata],
  [".rdata", FileSectionType.Rodata],
  [".bss", FileSectionType.Bss],
  [".ovl", FileSectionType.Reloc],
  [".reloc", FileSectionType.Reloc],
  [".gcc_except_table", FileSectionType.GccExceptTable],
  [".end", FileSectionType.End],
  [".dummy", FileSectionType.Dummy],
]);
gSmallNameToSectionType = new Map([
  [".sdata", FileSectionType.Data],
  [".srodata", FileSectionType.Rodata],
  [".srdata", FileSectionType.Rodata],
  [".sbss", FileSectionType.Bss],
]);

export const FileSections_ListBasic = Object.freeze([FileSectionType.Text, FileSectionType.Data, FileSectionType.Rodata, FileSectionType.Bss]);
export const FileSections_ListAll = Object.freeze([
  FileSectionType.Text,
  FileSectionType.Data,
  FileSectionType.Rodata,
  FileSectionType.Bss,
  FileSectionType.Reloc,
  FileSectionType.GccExceptTable,
]);

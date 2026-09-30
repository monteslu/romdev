// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/FilesHandlers.py

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { rabbitizer } from "../rabbitizer.js";
import { GlobalConfig } from "../common/GlobalConfig.js";
import { FileSectionType } from "../common/FileSectionType.js";
import * as Utils from "../common/Utils.js";
import { hexU } from "../py/pyutils.js";
import { SectionText } from "./sections/MipsSectionText.js";
import { SectionData } from "./sections/MipsSectionData.js";
import { SectionRodata } from "./sections/MipsSectionRodata.js";
import { SectionBss } from "./sections/MipsSectionBss.js";
import { SectionRelocZ64 } from "./sections/MipsSectionRelocZ64.js";
import { FunctionRodataEntry } from "./FuncRodataEntry.js";

function byteLength(b) {
  return b.length ?? b.byteLength;
}

export function createSectionFromSplitEntry(splitEntry, array_of_bytes, context, vromStart = 0) {
  const offsetStart = splitEntry.offset;
  let offsetEnd = splitEntry.nextOffset;

  if (offsetEnd === 0xffffff) offsetEnd = byteLength(array_of_bytes);

  if (offsetStart >= 0 && offsetEnd >= 0) Utils.printVerbose(`Parsing offset range [${hexU(offsetStart, 2)}, ${hexU(offsetEnd, 2)}]`);
  else if (offsetEnd >= 0) Utils.printVerbose(`Parsing until offset 0x${hexU(offsetEnd, 2)}`);
  else if (offsetStart >= 0) Utils.printVerbose(`Parsing since offset 0x${hexU(offsetStart, 2)}`);

  const sectionStart = vromStart + offsetStart;
  const sectionEnd = vromStart + offsetEnd;

  Utils.printVerbose(`Using VRAM ${hexU(splitEntry.vram, 8)}`);
  const vram = splitEntry.vram;

  let f;
  if (splitEntry.section === FileSectionType.Text) {
    f = new SectionText(context, sectionStart, sectionEnd, vram, splitEntry.fileName, array_of_bytes, 0, null);
    if (splitEntry.isRsp) f.instrCat = rabbitizer.InstrCategory.RSP;
  } else if (splitEntry.section === FileSectionType.Data) {
    f = new SectionData(context, sectionStart, sectionEnd, vram, splitEntry.fileName, array_of_bytes, 0, null);
  } else if (splitEntry.section === FileSectionType.Rodata) {
    f = new SectionRodata(context, sectionStart, sectionEnd, vram, splitEntry.fileName, array_of_bytes, 0, null);
  } else if (splitEntry.section === FileSectionType.Bss) {
    const bssVramEnd = splitEntry.vram + offsetEnd - offsetStart;
    f = new SectionBss(context, sectionStart, sectionEnd, splitEntry.vram, bssVramEnd, splitEntry.fileName, 0, null);
  } else if (splitEntry.section === FileSectionType.Reloc) {
    f = new SectionRelocZ64(context, sectionStart, sectionEnd, vram, splitEntry.fileName, array_of_bytes, 0, null);
  } else {
    Utils.eprint("Error! Section not set!");
    throw new Utils.SystemExit(-1);
  }

  f.isHandwritten = splitEntry.isHandwritten;

  return f;
}

export function writeSection(p, fileSection) {
  mkdirSync(path.dirname(String(p)), { recursive: true });
  fileSection.saveToFile(String(p));
  return p;
}

/** @deprecated Use the static methods from FunctionRodataEntry instead */
export function getRdataAndLateRodataForFunctionFromSection(func, rodataSection) {
  const entry = FunctionRodataEntry.getEntryForFuncFromSection(func, rodataSection);
  let lateRodataSize = 0;
  for (const rodataSym of entry.lateRodataSyms) lateRodataSize += rodataSym.sizew;
  return [entry.rodataSyms, entry.lateRodataSyms, lateRodataSize];
}

/** @deprecated Use the static methods from FunctionRodataEntry instead */
export function getRdataAndLateRodataForFunction(func, rodataFileList) {
  const entry = FunctionRodataEntry.getEntryForFuncFromPossibleRodataSections(func, rodataFileList);
  let lateRodataSize = 0;
  for (const rodataSym of entry.lateRodataSyms) lateRodataSize += rodataSym.sizew;
  return [entry.rodataSyms, entry.lateRodataSyms, lateRodataSize];
}

/** @deprecated Use the static methods from FunctionRodataEntry instead */
export function writeFunctionRodataToFile(f, func, rdataList, lateRodataList, _lateRodataSize = 0) {
  const entry = new FunctionRodataEntry(func, rdataList, lateRodataList);
  entry.writeToFile(f, false);
}

function writeTextFile(p, producer) {
  const parts = [];
  producer({ write: (s) => parts.push(s) });
  writeFileSync(p, parts.join(""), "utf8");
}

/** @deprecated Use the static methods from FunctionRodataEntry instead */
export function writeSplitedFunction(p, func, rodataFileList) {
  mkdirSync(String(p), { recursive: true });
  const entry = FunctionRodataEntry.getEntryForFuncFromPossibleRodataSections(func, rodataFileList);
  const funcPath = path.join(String(p), func.getName() + ".s");
  writeTextFile(funcPath, (f) => entry.writeToFile(f, true));
}

export function writeOtherRodata(p, rodataFileList) {
  for (const rodataSection of rodataFileList) {
    if (!(rodataSection instanceof SectionRodata)) throw new Error("AssertionError");

    const rodataPath = path.join(String(p), rodataSection.name);
    mkdirSync(rodataPath, { recursive: true });

    for (const rodataSym of rodataSection.symbolList) {
      if (rodataSym.shouldMigrate()) continue;

      const rodataSymbolPath = path.join(rodataPath, rodataSym.getName() + ".s");
      Utils.printVerbose(`Writing unmigrated rodata ${rodataSymbolPath}`);

      writeTextFile(rodataSymbolPath, (f) => {
        f.write(".section .rodata" + GlobalConfig.LINE_ENDS);
        f.write(rodataSym.disassemble(true));
      });
    }
  }
}

/** processedSegments: Map<FileSectionType, SectionBase[]> */
export function writeMigratedFunctionsList(processedSegments, functionMigrationPath, name) {
  const funcAndRodataOrderPath = path.join(String(functionMigrationPath), `${name}_migrated_functions.txt`);

  const rodataSymbols = [];
  for (const section of processedSegments.get(FileSectionType.Rodata) ?? []) {
    for (const sym of section.symbolList) rodataSymbols.push([sym, null]);
  }
  const rodataSymbolsVrams = new Set(rodataSymbols.map(([sym]) => sym.vram));

  const funcs = [];
  for (const section of processedSegments.get(FileSectionType.Text) ?? []) {
    for (const func of section.symbolList) {
      funcs.push(func);

      const referencedRodata = new Set();
      for (const v of func.instrAnalyzer.referencedVrams) if (rodataSymbolsVrams.has(v)) referencedRodata.add(v);
      for (let i = 0; i < rodataSymbols.length; i++) {
        if (referencedRodata.size === 0) break;

        const [rodataSym, funcReferencingThisSym] = rodataSymbols[i];

        if (!referencedRodata.has(rodataSym.vram)) continue;

        referencedRodata.delete(rodataSym.vram);

        if (funcReferencingThisSym !== null) continue;

        rodataSymbols[i] = [rodataSym, func];
      }
    }
  }

  const resultingList = [];
  const alreadyAddedFuncs = new Set();

  let lastFunc = null;
  for (const [rodataSym, funcReferencingThisSym] of rodataSymbols) {
    if (funcReferencingThisSym === null) {
      resultingList.push(rodataSym);
    } else if (!alreadyAddedFuncs.has(funcReferencingThisSym)) {
      alreadyAddedFuncs.add(funcReferencingThisSym);
      lastFunc = funcReferencingThisSym;

      for (const func of funcs) {
        if (func.vram >= funcReferencingThisSym.vram) break;
        if (alreadyAddedFuncs.has(func)) continue;

        alreadyAddedFuncs.add(func);
        resultingList.push(func);
      }
      resultingList.push(funcReferencingThisSym);
    }
  }

  if (lastFunc === null) {
    resultingList.push(...funcs);
  } else {
    for (const func of funcs) {
      if (func.vram <= lastFunc.vram) continue;
      resultingList.push(func);
    }
  }

  writeFileSync(funcAndRodataOrderPath, resultingList.map((sym) => sym.getName() + "\n").join(""), "utf8");
}

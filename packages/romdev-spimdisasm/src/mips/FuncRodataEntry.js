// SPDX-License-Identifier: MIT
// Port of spimdisasm/mips/FuncRodataEntry.py

import { GlobalConfig } from "../common/GlobalConfig.js";
import { SectionRodata } from "./sections/MipsSectionRodata.js";

function assert(cond, msg = "") {
  if (!cond) throw new Error(`AssertionError${msg !== "" ? ": " + msg : ""}`);
}

/**
 * Class to facilitate rodata migration.
 *
 * Dataclass fields (positional, same order as Python):
 * (function=None, rodataSyms=[], lateRodataSyms=[], sectionText=".text", sectionRodata=".rodata", sectionLateRodata=".late_rodata")
 */
export class FunctionRodataEntry {
  constructor(func = null, rodataSyms = null, lateRodataSyms = null, sectionText = ".text", sectionRodata = ".rodata", sectionLateRodata = ".late_rodata") {
    this.function = func ?? null;
    this.rodataSyms = rodataSyms ?? [];
    this.lateRodataSyms = lateRodataSyms ?? [];
    this.sectionText = sectionText;
    this.sectionRodata = sectionRodata;
    this.sectionLateRodata = sectionLateRodata;
  }

  hasRodataSyms() {
    return this.rodataSyms.length > 0 || this.lateRodataSyms.length > 0;
  }

  *iterRodataSyms() {
    yield* this.rodataSyms;
    yield* this.lateRodataSyms;
  }

  /** f: object with a write(str) method */
  writeToFile(f, writeFunction = true) {
    // Disassemble the function first without writing it, since it may affect other symbols.
    let disassembledFunction = null;
    if (this.function !== null) disassembledFunction = this.function.disassemble(this.hasRodataSyms(), true, true);

    if (this.rodataSyms.length > 0) {
      // Write the rdata
      f.write(`.section ${this.sectionRodata}${GlobalConfig.LINE_ENDS}`);
      for (const sym of this.rodataSyms) {
        f.write(sym.disassemble(true, true, true));
        f.write(GlobalConfig.LINE_ENDS);
      }
    }

    if (this.lateRodataSyms.length > 0) {
      assert(this.function !== null);
      // Write the late_rodata
      f.write(`.section ${this.sectionLateRodata}${GlobalConfig.LINE_ENDS}`);

      let lateRodataSize = 0;
      for (const sym of this.lateRodataSyms) lateRodataSize += sym.sizew;

      if (lateRodataSize / this.function.instructions.length > 1 / 3) {
        let align = 4;
        const firstLateRodataVram = this.lateRodataSyms[0].vram;
        if (firstLateRodataVram !== null && firstLateRodataVram % 8 === 0) align = 8;
        f.write(`.late_rodata_alignment ${align}${GlobalConfig.LINE_ENDS}`);
      }
      for (const sym of this.lateRodataSyms) {
        f.write(sym.disassemble(true, true, true));
        f.write(GlobalConfig.LINE_ENDS);
      }
    }

    if (disassembledFunction !== null) {
      if (this.rodataSyms.length > 0 || this.lateRodataSyms.length > 0) f.write(`${GlobalConfig.LINE_ENDS}.section ${this.sectionText}${GlobalConfig.LINE_ENDS}`);

      if (writeFunction) {
        // Write the function itself
        f.write(disassembledFunction);
      }
    }
  }

  getName() {
    assert(this.function !== null || this.hasRodataSyms());

    if (this.function !== null) return this.function.getName();

    const rodataSymsLen = this.rodataSyms.length;
    if (rodataSymsLen > 0) {
      assert(rodataSymsLen === 1, String(rodataSymsLen));
      return this.rodataSyms[0].getName();
    }

    const lateRodataSyms = this.lateRodataSyms.length;
    assert(lateRodataSyms === 1, String(lateRodataSyms));
    return this.lateRodataSyms[0].getName();
  }

  static _shouldMigrateRodataSymbolToFunction(rodataSym, intersection, funcName, already_migrated_syms) {
    if (already_migrated_syms.has(rodataSym.vram)) return false;

    const functionOwner = rodataSym.contextSym.functionOwnerForMigration;
    if (functionOwner !== null) {
      // If a function owner was specified for this symbol then it is only
      // allowed to be migrated to that function and none other
      return functionOwner === funcName;
    }

    if (!intersection.has(rodataSym.vram)) return false;

    if (!rodataSym.shouldMigrate()) return false;

    return true;
  }

  static _updateMigrableSymbolsSets(rodataSym, intersection, funcName, migrableRodataSyms, maybeMigrableRodataSyms, rodataMigratedSomewhereElse, already_migrated_syms) {
    if (rodataMigratedSomewhereElse) return rodataMigratedSomewhereElse;

    if (FunctionRodataEntry._shouldMigrateRodataSymbolToFunction(rodataSym, intersection, funcName, already_migrated_syms)) {
      migrableRodataSyms.add(rodataSym.vram);

      for (const x of maybeMigrableRodataSyms) migrableRodataSyms.add(x);
      maybeMigrableRodataSyms.clear();
    } else if (migrableRodataSyms.size > 0) {
      if (rodataSym.contextSym.referenceSymbols.size > 0 || rodataSym.contextSym.referenceFunctions.size > 0) {
        rodataMigratedSomewhereElse = true;
      } else if (rodataSym.shouldMigrate()) {
        if (already_migrated_syms.has(rodataSym.vram)) rodataMigratedSomewhereElse = true;
        else maybeMigrableRodataSyms.add(rodataSym.vram);
      } else {
        rodataMigratedSomewhereElse = true;
      }
    }

    return rodataMigratedSomewhereElse;
  }

  /**
   * Pairs the given function to the migrable rodata symbols of the given rodata section.
   */
  static getEntryForFuncFromSection(func, rodataSection, already_migrated_syms = null) {
    if (already_migrated_syms === null || already_migrated_syms === undefined) already_migrated_syms = new Set();
    if (rodataSection === null || rodataSection === undefined) return new FunctionRodataEntry(func);

    const rodataList = [];
    const lateRodataList = [];

    const intersection = new Set();
    for (const v of func.instrAnalyzer.referencedVrams) if (rodataSection.symbolsVRams.has(v)) intersection.add(v);

    const funcName = func.getName();

    const migrableRodataSyms = new Set();
    const migrableLateRodataSyms = new Set();
    const maybeMigrableRodataSyms = new Set();
    const maybeMigrableLateRodataSyms = new Set();
    let rodataMigratedSomewhereElse = false;
    let lateRodataMigratedSomewhereElse = false;
    for (const rodataSym of rodataSection.symbolList) {
      if (rodataMigratedSomewhereElse) {
        if (!GlobalConfig.COMPILER.value.hasLateRodata) break;
        if (lateRodataMigratedSomewhereElse) break;
      }

      if (rodataSym.contextSym.isLateRodata()) {
        lateRodataMigratedSomewhereElse = FunctionRodataEntry._updateMigrableSymbolsSets(rodataSym, intersection, funcName, migrableLateRodataSyms, maybeMigrableLateRodataSyms, lateRodataMigratedSomewhereElse, already_migrated_syms);
      } else {
        rodataMigratedSomewhereElse = FunctionRodataEntry._updateMigrableSymbolsSets(rodataSym, intersection, funcName, migrableRodataSyms, maybeMigrableRodataSyms, rodataMigratedSomewhereElse, already_migrated_syms);
      }
    }

    for (const rodataSym of rodataSection.symbolList) {
      if (migrableLateRodataSyms.has(rodataSym.vram)) lateRodataList.push(rodataSym);
      else if (migrableRodataSyms.has(rodataSym.vram)) rodataList.push(rodataSym);
    }

    return new FunctionRodataEntry(func, rodataList, lateRodataList);
  }

  /** Searches and try to pair migrable rodata symbols to the given function. */
  static getEntryForFuncFromPossibleRodataSections(func, rodataFileList) {
    for (const rodataSection of rodataFileList) {
      assert(rodataSection instanceof SectionRodata);

      const entry = FunctionRodataEntry.getEntryForFuncFromSection(func, rodataSection);
      if (entry.hasRodataSyms()) return entry;
    }

    return new FunctionRodataEntry(func);
  }

  /**
   * Return all functions to rodata symbols pairings from the given sections,
   * preserving the original ordering of both sections.
   */
  static getAllEntriesFromSections(textSection, rodataSection) {
    const remainingRodataSymbols = rodataSection !== null && rodataSection !== undefined ? [...rodataSection.symbolList] : [];
    let head = 0;
    const handledSymbols = new Set();

    const allEntries = [];

    const textSymbols = textSection !== null && textSection !== undefined ? textSection.symbolList : [];
    for (const func of textSymbols) {
      const entry = FunctionRodataEntry.getEntryForFuncFromSection(func, rodataSection ?? null, handledSymbols);

      for (const sym of entry.iterRodataSyms()) handledSymbols.add(sym.vram);

      // Preserve the order of rodata symbols by looking for symbols that has not been migrated yet
      if (entry.rodataSyms.length > 0) {
        const firstFuncRodataSym = entry.rodataSyms[0];

        while (head < remainingRodataSymbols.length) {
          const rodataSym = remainingRodataSymbols[head];

          if (handledSymbols.has(rodataSym.vram)) {
            // Drop migrated symbols
            head += 1;
            continue;
          }

          if (rodataSym.vram >= firstFuncRodataSym.vram) {
            // Take all the symbols up to symbols referenced by the current function
            break;
          }

          allEntries.push(new FunctionRodataEntry(null, [rodataSym]));
          handledSymbols.add(rodataSym.vram);
          head += 1;
        }
      }

      allEntries.push(entry);
    }

    // Check if there's any rodata symbol remaining and add it to the list
    for (let k = head; k < remainingRodataSymbols.length; k++) {
      const rodataSym = remainingRodataSymbols[k];
      if (!handledSymbols.has(rodataSym.vram)) allEntries.push(new FunctionRodataEntry(null, [rodataSym]));
    }

    return allEntries;
  }
}

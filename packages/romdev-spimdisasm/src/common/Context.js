// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/Context.py (the argparse parts are not ported).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as Utils from "./Utils.js";
import { SymbolsSegment } from "./SymbolsSegment.js";
import { GpAccessContainer, GotEntry } from "./GpAccesses.js";
import { RelocationInfo, RelocType } from "./Relocation.js";
import { hexU, pyStrip } from "../py/pyutils.js";
import { atLeast } from "../version.js";

export class AddressRange {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }

  isInRange(address) {
    return this.start <= address && address < this.end;
  }

  decreaseStart(address) {
    this.start = Math.min(this.start, address);
  }

  increaseEnd(address) {
    this.end = Math.max(this.end, address);
  }

  toString() {
    return `AddressRange(0x${hexU(this.start, 8)}, 0x${hexU(this.end, 8)})`;
  }
}

export class SymbolsRanges {
  constructor(start, end) {
    this.mainAddressRange = new AddressRange(start, end);
    this.specialRanges = [];
  }

  isInRange(address) {
    if (this.mainAddressRange.isInRange(address)) return true;
    for (const spRange of this.specialRanges) if (spRange.isInRange(address)) return true;
    return false;
  }

  decreaseStart(address) {
    this.mainAddressRange.decreaseStart(address);
  }

  increaseEnd(address) {
    this.mainAddressRange.increaseEnd(address);
  }

  addSpecialRange(start, end) {
    if (end <= start) return null;
    const addrRange = new AddressRange(start, end);
    this.specialRanges.push(addrRange);
    return addrRange;
  }

  toString() {
    let ret = `MainRange: ${this.mainAddressRange}\n`;
    this.specialRanges.forEach((spRange, i) => {
      ret += `    ${i}'th special: ${spRange}\n`;
    });
    return ret;
  }
}

/** A minimal text sink compatible with Python's TextIO.write for saveContextToFile. */
class StringSink {
  constructor() {
    this.parts = [];
  }
  write(s) {
    this.parts.push(s);
  }
  toString() {
    return this.parts.join("");
  }
}

export class Context {
  static N64DefaultBanned = new Set([
    0x7fffffe0, // osInvalICache
    0x7ffffff0, // osInvalDCache, osWritebackDCache, osWritebackDCacheAll
    0x7fffffff,
    0x80000010,
    0x80000020,
  ]);

  constructor() {
    // Arbitrary initial range
    this.globalSegment = new SymbolsSegment(this, 0x0, 0x1000, 0x80000000, 0x80001000, null);
    // For symbols that we don't know where they come from
    this.unknownSegment = new SymbolsSegment(this, null, null, 0x00000000, 0xffffffff, null);
    if (atLeast("1.39.0")) this.unknownSegment._isTheUnknownSegment = true;
    else this._isTheUnknownSegment = true;

    /** Outer key is overlay type, inner key is the vrom of the overlay's segment */
    this.overlaySegments = new Map();

    this.absoluteSegment = new SymbolsSegment(this, null, null, 0x00000000, 0xffffffff, null);
    this.absoluteSegment._isAbsoluteSegment = true;

    this.totalVramRange = new SymbolsRanges(this.globalSegment.vramStart, this.globalSegment.vramEnd);
    this._defaultVramRanges = true;

    // Stuff that looks like pointers, but the disassembler shouldn't count it as a pointer
    this.bannedSymbols = new Set();
    this.bannedRangedSymbols = [];

    /** key: vrom address */
    this.globalRelocationOverrides = new Map();

    this.gpAccesses = new GpAccessContainer();
  }

  changeGlobalSegmentRanges(vromStart, vromEnd, vramStart, vramEnd) {
    if (vromStart === vromEnd) Utils.eprint(`Warning: globalSegment's will has its vromStart equal to the vromEnd (0x${hexU(vromStart)})`);
    if (vramStart === vramEnd) Utils.eprint(`Warning: globalSegment's will has its vramStart equal to the vramEnd (0x${hexU(vramStart)})`);
    this.globalSegment.changeRanges(vromStart, vromEnd, vramStart, vramEnd);
    if (this._defaultVramRanges) {
      this.totalVramRange.mainAddressRange.start = vramStart;
      this.totalVramRange.mainAddressRange.end = vramEnd;
      this._defaultVramRanges = false;
    }
    this.totalVramRange.decreaseStart(vramStart);
    this.totalVramRange.increaseEnd(vramEnd);
  }

  addOverlaySegment(overlayCategory, segmentVromStart, segmentVromEnd, segmentVramStart, segmentVramEnd, name = null) {
    if (!this.overlaySegments.has(overlayCategory)) this.overlaySegments.set(overlayCategory, new Map());
    const segment = new SymbolsSegment(this, segmentVromStart, segmentVromEnd, segmentVramStart, segmentVramEnd, overlayCategory, atLeast("1.42.0") ? name : null);
    this.overlaySegments.get(overlayCategory).set(segmentVromStart, segment);

    if (this._defaultVramRanges) {
      this.totalVramRange.mainAddressRange.start = segmentVramStart;
      this.totalVramRange.mainAddressRange.end = segmentVramEnd;
      this._defaultVramRanges = false;
    }
    this.totalVramRange.decreaseStart(segmentVramStart);
    this.totalVramRange.increaseEnd(segmentVramEnd);

    return segment;
  }

  isInTotalVramRange(address) {
    return this.totalVramRange.isInRange(address);
  }

  addSpecialVramRange(start, end) {
    return this.totalVramRange.addSpecialRange(start, end);
  }

  setupGotTable(pltGot, table) {
    this.gpAccesses.setupGotTable(pltGot, table);

    for (const gotEntry of this.gpAccesses.got.iterGlobals()) {
      const contextSym = this.globalSegment.addSymbol(gotEntry.value());
      contextSym.isUserDeclared = true;
      contextSym.isGotGlobal = true;
    }
  }

  /** @deprecated prefer setupGotTable() instead. */
  initGotTable(pltGot, localsTable, globalsTable) {
    const table = [];
    for (const x of localsTable) table.push(new GotEntry(x, false));
    for (const x of globalsTable) table.push(new GotEntry(x, true));
    this.setupGotTable(pltGot, table);
  }

  addSmallSection(address, size) {
    this.gpAccesses.addSmallSection(address, size);
  }

  fillDefaultBannedSymbols() {
    for (const x of Context.N64DefaultBanned) this.bannedSymbols.add(x);
  }

  isAddressInGlobalRange(address) {
    return this.totalVramRange.isInRange(address);
  }

  addBannedSymbol(address) {
    this.bannedSymbols.add(address);
  }

  addBannedSymbolRange(rangeStart, rangeEnd) {
    this.bannedRangedSymbols.push(new AddressRange(rangeStart, rangeEnd));
  }

  addBannedSymbolRangeBySize(rangeStart, size) {
    this.bannedRangedSymbols.push(new AddressRange(rangeStart, rangeStart + size));
  }

  isAddressBanned(address) {
    if (this.bannedSymbols.has(address)) return true;
    for (const ranged of this.bannedRangedSymbols) if (ranged.isInRange(address)) return true;
    return false;
  }

  addGlobalReloc(vromAddres, relocType, symbol, addend = 0) {
    const reloc = new RelocationInfo(relocType, symbol, addend, null, true);
    this.globalRelocationOverrides.set(vromAddres, reloc);
    return reloc;
  }

  readSplatRelocAddrs(filepath) {
    if (!existsSync(String(filepath))) {
      Utils.eprintQuietless(`reloc_addrs file '${filepath}' not found.`);
      return;
    }

    const getRequired = (pairs, key, line) => {
      const value = pairs.has(key) ? pairs.get(key) : null;
      if (value === null) Utils.panic(`\nError parsing reloc_addrs file '${filepath}'.\n    Missing key '${key}'.\n    While parsing line '${line}'`);
      return value;
    };

    const text = readFileSync(String(filepath), "utf8");
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let line of lines) {
      line = pyStrip(line);
      const pairs = Utils.parseColonSeparatedPairLine(line);

      const romStr = getRequired(pairs, "rom", line);
      const rom = Utils.intFromStr(romStr);
      if (rom === null) Utils.panic(`\nInvalid value '${romStr}' for attribute 'rom'.\n    While parsing line '${line}'`);

      const relocStr = getRequired(pairs, "reloc", line);
      const reloc = RelocType.fromStr(relocStr);
      if (reloc === null) Utils.panic(`\nInvalid value '${relocStr}' for attribute 'reloc'.\n    While parsing line '${line}'`);

      const symbol = getRequired(pairs, "symbol", line);

      const addend = Utils.getMaybeIntFromMaybeStr(pairs.has("addend") ? pairs.get("addend") : null) || 0;

      this.addGlobalReloc(rom, reloc, symbol, addend);
    }
  }

  saveContextToFile(contextPath) {
    contextPath = String(contextPath);
    const parsed = path.parse(contextPath);
    const stem = parsed.name;
    const suffix = parsed.ext;
    const withName = (n) => path.join(parsed.dir, n);

    let sink = new StringSink();
    this.globalSegment.saveContextToFile(sink);
    writeFileSync(contextPath, sink.toString());

    const unknownPath = withName(`${stem}_unksegment${suffix}`);
    sink = new StringSink();
    this.unknownSegment.saveContextToFile(sink);
    writeFileSync(unknownPath, sink.toString());

    for (const [overlayCategory, segmentsPerVrom] of this.overlaySegments) {
      for (const [segmentVrom, overlaySegment] of segmentsPerVrom) {
        const ovlPath = atLeast("1.42.0")
          ? withName(`${stem}_${overlayCategory}_${overlaySegment.name === null ? "None" : overlaySegment.name}_${hexU(segmentVrom, 6)}${suffix}`)
          : withName(`${stem}_${overlayCategory}_${hexU(segmentVrom, 6)}${suffix}`);
        sink = new StringSink();
        overlaySegment.saveContextToFile(sink);
        writeFileSync(ovlPath, sink.toString());
      }
    }
  }
}

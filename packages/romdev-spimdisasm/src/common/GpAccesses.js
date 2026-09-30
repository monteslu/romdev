// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/GpAccesses.py

import * as Utils from "./Utils.js";
import { SortedDict } from "./SortedDict.js";
import { hexU } from "../py/pyutils.js";

export class GotEntry {
  constructor(value, isGlobal) {
    this._value = value;
    this._isGlobal = isGlobal;
  }

  value() {
    return this._value;
  }

  isGlobal() {
    return this._isGlobal;
  }
}

export class GlobalOffsetTable {
  constructor() {
    this._table = [];
    this._tableAddress = null;
  }

  setupTable(pltGot, table) {
    this._tableAddress = pltGot;
    this._table = [...table];
  }

  /** @deprecated Prefer setupTable() instead. */
  initTables(pltGot, localsTable, globalsTable) {
    const table = [];
    for (const x of localsTable) table.push(new GotEntry(x, false));
    for (const x of globalsTable) table.push(new GotEntry(x, true));
    this.setupTable(pltGot, table);
  }

  tableAddress() {
    return this._tableAddress;
  }

  *iterGlobals() {
    for (const entry of this._table) if (entry._isGlobal) yield entry;
  }

  *iterLocals() {
    for (const entry of this._table) if (!entry._isGlobal) yield entry;
  }

  _getGotEntry(address) {
    if (this._tableAddress === null) return null;

    const index = Math.floor((address - this._tableAddress) / 4);

    if (index < 0) {
      Utils.eprint(`Warning: %got address 0x${hexU(address)} not found on local or global table (negative index)`);
      Utils.eprint(`    index: ${index}, len(table):${this._table.length}`);
      return null;
    }

    if (index >= this._table.length) {
      Utils.eprint(`Warning: %got address 0x${hexU(address)} not found on local or global table (out of range)`);
      Utils.eprint(`    index: ${index}, len(table): ${this._table.length}`);
      return null;
    }
    return this._table[index];
  }
}

export class SmallSection {
  constructor(address, size) {
    this.address = address;
    this.size = size;
  }

  isInRange(address) {
    return this.address <= address && address < this.address + this.size;
  }
}

export class GpAccess {
  constructor(address, isGotLocal = false, isGotGlobal = false, isSmallSection = false) {
    this.address = address;
    this.isGotLocal = isGotLocal;
    this.isGotGlobal = isGotGlobal;
    this.isSmallSection = isSmallSection;
  }

  get isGot() {
    return this.isGotLocal || this.isGotGlobal;
  }
}

export class GpAccessContainer {
  constructor() {
    this.got = new GlobalOffsetTable();
    this.smallSections = new SortedDict();
  }

  addSmallSection(address, size) {
    this.smallSections.set(address, new SmallSection(address, size));
  }

  setupGotTable(tableAddress, table) {
    this.got.setupTable(tableAddress, table);
    this.addSmallSection(tableAddress, table.length * 4);
  }

  /** @deprecated Prefer setupGotTable() instead */
  initGotTable(tableAddress, localsTable, globalsTable) {
    const table = [];
    for (const x of localsTable) table.push(new GotEntry(x, false));
    for (const x of globalsTable) table.push(new GotEntry(x, true));
    this.setupGotTable(tableAddress, table);
  }

  requestAddress(address) {
    const small = this.smallSections.getKeyRight(address);
    if (small === null) {
      Utils.eprint(`Warning: No section found for $gp access at address 0x${hexU(address, 8)}`);
      return null;
    }

    const [sectionAddr, sectionData] = small;

    if (sectionAddr !== this.got._tableAddress) {
      if (!sectionData.isInRange(address)) {
        Utils.eprint(`Warning: No section found for $gp access at address 0x${hexU(address, 8)}`);
        return null;
      }

      // small section
      const access = new GpAccess(address);
      access.isSmallSection = true;
      return access;
    }

    // got
    const gotEntry = this.got._getGotEntry(address);
    if (gotEntry === null) return null;

    const access = new GpAccess(gotEntry._value);
    access.isGotGlobal = gotEntry._isGlobal;
    access.isGotLocal = !gotEntry._isGlobal;

    return access;
  }
}

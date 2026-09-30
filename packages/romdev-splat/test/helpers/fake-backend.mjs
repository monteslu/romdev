// A stand-in for romdev-spimdisasm/romdev-rabbitizer with just enough of the
// API for splat runs that never disassemble (no `code` mode): context,
// GlobalConfig, enums. Any disassembly call throws.

class SymbolsSegment {
  constructor(vromStart = null, vromEnd = null, vramStart = null, vramEnd = null) {
    this.vromStart = vromStart; this.vromEnd = vromEnd; this.vramStart = vramStart; this.vramEnd = vramEnd;
    this.symbols = new Map();
  }
  _add(vram, type) {
    let s = this.symbols.get(vram);
    if (!s) {
      s = {
        vram, type, name: null, size: null, vromAddress: null, isDefined: false, referenceCounter: 0,
        overlayCategory: null, setNameGetCallbackIfUnset() {}, setNameGetCallback() {}, setAlignment() {},
      };
      this.symbols.set(vram, s);
    }
    return s;
  }
  addFunction(v) { return this._add(v, 'function'); }
  addJumpTable(v) { return this._add(v, 'jumptable'); }
  addJumpTableLabel(v) { return this._add(v, 'jumptablelabel'); }
  addBranchLabel(v) { return this._add(v, 'branchlabel'); }
  addSymbol(v) { return this._add(v, null); }
  fillLibultraSymbols() {}
  fillIQueSymbols() {}
  fillHardwareRegs() {}
}

class Context {
  constructor() {
    this.globalSegment = new SymbolsSegment();
    this.bannedSymbols = new Set();
    this.overlays = [];
    this.relocs = [];
  }
  fillDefaultBannedSymbols() {}
  addBannedSymbolRangeBySize() {}
  addOverlaySegment(cat, a, b, c, d) { const s = new SymbolsSegment(a, b, c, d); this.overlays.push(s); return s; }
  changeGlobalSegmentRanges(a, b, c, d) { Object.assign(this.globalSegment, { vromStart: a, vromEnd: b, vramStart: c, vramEnd: d }); }
  addGlobalReloc(...a) { this.relocs.push(a); }
  saveContextToFile() { throw new Error('fake backend: saveContextToFile'); }
}

class FakeSection {
  constructor(...a) { this.args = a; this.symbolList = []; this.fileBoundaries = []; this.gpRelHack = false; }
  analyze() {}
  setCommentOffset() {}
  setGpRelHack(v) { this.gpRelHack = v; }
  getGpRelHack() { return this.gpRelHack; }
  getSymbol() { return null; }
  disassemble() { throw new Error("fake backend: disassemble"); }
}

const enumFromStr = (names) => ({ fromStr: (s) => (names.includes(s) ? s : null) });

export function makeFakeBackend() {
  const spimdisasm = {
    __version__: '1.39.3',
    __version_info__: [1, 39, 3],
    common: {
      Context,
      GlobalConfig: {},
      Compiler: enumFromStr(['IDO', 'GCC', 'SN64', 'PSYQ', 'KMC', 'EGCS', 'MWCCPS2', 'EEGCC']),
      compilerOptions: {},
      InputEndian: { BIG: 'big', LITTLE: 'little' },
      RelocType: enumFromStr(['MIPS_HI16', 'MIPS_LO16', 'MIPS_32', 'MIPS_26', 'MIPS_GPREL16']),
      SymbolSpecialType: { function: 'function', jumptable: 'jumptable', branchlabel: 'branchlabel', jumptablelabel: 'jumptablelabel' },
      gKnownTypes: new (class extends Set { has() { return true; } })(['s32']),
    },
    mips: { sections: { SectionText: FakeSection, SectionData: FakeSection, SectionRodata: FakeSection, SectionBss: FakeSection } },
  };
  const rabbitizer = {
    config: {},
    Abi: { fromStr: (s) => s },
    InstrCategory: { CPU: 'CPU', RSP: 'RSP', R3000GTE: 'R3000GTE', R4000ALLEGREX: 'R4000ALLEGREX', R5900: 'R5900' },
    TrinaryValue: { TRUE: 1, FALSE: 0 },
  };
  return { spimdisasm, rabbitizer };
}

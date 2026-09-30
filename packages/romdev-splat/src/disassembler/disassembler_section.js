// splat.disassembler.disassembler_section
import { opts } from '../util/options.js';
import { state as symbolsState } from '../util/symbols.js';
import { spim } from './spim.js';

export class SpimdisasmDisassemberSection {
  constructor() { this.spim_section = null; }

  disassemble() { return this.spim_section.disassemble(); }
  analyze() { this.spim_section.analyze(); }
  set_comment_offset(romStart) { this.spim_section.setCommentOffset(romStart); }
  get_section() { return this.spim_section; }

  make_bss_section(romStart, romEnd, vramStart, bssEnd, name, segmentRomStart, exclusiveRamId) {
    this.spim_section = new (spim().mips.sections.SectionBss)(symbolsState.spim_context, romStart, romEnd,
      vramStart, bssEnd, name, segmentRomStart, exclusiveRamId);
  }

  make_data_section(romStart, romEnd, vramStart, name, romBytes, segmentRomStart, exclusiveRamId) {
    this.spim_section = new (spim().mips.sections.SectionData)(symbolsState.spim_context, romStart, romEnd,
      vramStart, name, romBytes, segmentRomStart, exclusiveRamId);
  }

  make_rodata_section(romStart, romEnd, vramStart, name, romBytes, segmentRomStart, exclusiveRamId) {
    this.spim_section = new (spim().mips.sections.SectionRodata)(symbolsState.spim_context, romStart, romEnd,
      vramStart, name, romBytes, segmentRomStart, exclusiveRamId);
  }

  make_text_section(romStart, romEnd, vramStart, name, romBytes, segmentRomStart, exclusiveRamId) {
    this.spim_section = new (spim().mips.sections.SectionText)(symbolsState.spim_context, romStart, romEnd,
      vramStart, name, romBytes, segmentRomStart, exclusiveRamId);
  }
}

function make() {
  if (['n64', 'psx', 'ps2', 'psp'].includes(opts.platform)) return new SpimdisasmDisassemberSection();
  throw new Error('No disassembler section for requested platform');
}

export function makeTextSection(...a) { const s = make(); s.make_text_section(...a); return s; }
export function makeDataSection(...a) { const s = make(); s.make_data_section(...a); return s; }
export function makeRodataSection(...a) { const s = make(); s.make_rodata_section(...a); return s; }
export function makeBssSection(...a) { const s = make(); s.make_bss_section(...a); return s; }

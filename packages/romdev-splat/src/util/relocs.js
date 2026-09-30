// splat.util.relocs
import { exists } from '../runtime.js';
import * as log from './log.js';
import { opts } from './options.js';
import { hex, pyInt0 } from './pyfmt.js';
import { readLines, state as symbolsState } from './symbols.js';
import { spim } from '../disassembler/spim.js';

export let allRelocs = new Map();

export function reset() { allRelocs = new Map(); }

export function initialize() {
  allRelocs = new Map();
  for (const path of opts.reloc_addrs_paths) {
    if (!exists(path)) continue;
    const lines = readLines(path);
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum].split('//')[0].trim();
      if (line === '') continue;
      let romAddr = null; let relocType = null; let symbolName = null; let addend = null;
      for (const info of line.split(' ')) {
        if (!info.includes(':')) continue;
        if (info.split(':').length - 1 > 1) {
          log.parsingErrorPreamble(path, lineNum, line);
          log.write(`Too many ':'s in '${info}'`);
          log.error('');
        }
        const [attrName, attrVal] = info.split(':');
        if (attrName === '') {
          log.parsingErrorPreamble(path, lineNum, line);
          log.write(`Missing attribute name in '${info}', is there extra whitespace?`);
          log.error('');
        }
        if (attrVal === '') {
          log.parsingErrorPreamble(path, lineNum, line);
          log.write(`Missing attribute value in '${info}', is there extra whitespace?`);
          log.error('');
        }
        try {
          if (attrName === 'rom') { romAddr = pyInt0(attrVal); continue; }
          if (attrName === 'reloc') { relocType = attrVal; continue; }
          if (attrName === 'symbol') { symbolName = attrVal; continue; }
          if (attrName === 'addend') { addend = pyInt0(attrVal); continue; }
        } catch (e) {
          log.parsingErrorPreamble(path, lineNum, line);
          log.write(`value of attribute '${attrName}' could not be read:`);
          log.write('');
          throw e;
        }
      }
      if (romAddr === null) { log.parsingErrorPreamble(path, lineNum, line); log.error("Missing required 'rom' attribute for reloc"); }
      if (relocType === null) { log.parsingErrorPreamble(path, lineNum, line); log.error("Missing required 'reloc' attribute for reloc"); }
      if (symbolName === null) { log.parsingErrorPreamble(path, lineNum, line); log.error("Missing required 'symbol' attribute for reloc"); }
      const reloc = { rom_address: romAddr, reloc_type: relocType, symbol_name: symbolName, addend: addend !== null ? addend : 0 };
      if (allRelocs.has(romAddr)) {
        log.parsingErrorPreamble(path, lineNum, line);
        log.error(`Duplicated 'rom' address for reloc: 0x${hex(romAddr)}`);
      }
      allRelocs.set(romAddr, reloc);
    }
  }
}

export function initializeSpimContext() {
  const S = spim();
  for (const [romAddress, reloc] of allRelocs) {
    const relocType = S.common.RelocType.fromStr(reloc.reloc_type);
    if (relocType === null || relocType === undefined) {
      log.error(`Reloc type '${reloc.reloc_type}' is not valid. Rom address: 0x${hex(romAddress)}`);
    }
    symbolsState.spim_context.addGlobalReloc(romAddress, relocType, reloc.symbol_name, reloc.addend);
  }
}

// splat.util.symbols
import { atLeast } from '../runtime.js';
import * as log from './log.js';
import { opts } from './options.js';
import { IntervalTree } from './intervaltree.js';
import { hex, pyInt0, pyRepr } from './pyfmt.js';
import { stem } from './pypath.js';
import { readText, exists } from '../runtime.js';
import { spim } from '../disassembler/spim.js';
import * as disassemblerInstance from '../disassembler/disassembler_instance.js';

export const state = {
  all_symbols: [],
  all_symbols_dict: new Map(),
  all_symbols_ranges: new IntervalTree(),
  ignored_addresses: new Set(),
  to_mark_as_defined: new Set(),
  spim_context: null,
};

export const TRUEY_VALS = ['true', 'on', 'yes', 'y'];
export const FALSEY_VALS = ['false', 'off', 'no', 'n'];
export const splat_sym_types = new Set(['func', 'jtbl', 'jtbl_label', 'label']);
const ILLEGAL_FILENAME_CHARS = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

export function resetSymbols() {
  state.all_symbols = [];
  state.all_symbols_dict = new Map();
  state.all_symbols_ranges = new IntervalTree();
  state.ignored_addresses = new Set();
  state.to_mark_as_defined = new Set();
  state.spim_context = new (spim().common.Context)();
}

function checkValidType(typename) {
  if (typename[0] !== typename[0].toLowerCase() && typename[0] === typename[0].toUpperCase()) return true;
  if (splat_sym_types.has(typename)) return true;
  if (disassemblerInstance.getInstance().known_types().has(typename)) return true;
  return false;
}

const isTruey = (s) => TRUEY_VALS.includes(s.toLowerCase());
const isFalsey = (s) => FALSEY_VALS.includes(s.toLowerCase());

export function addSymbol(sym) {
  state.all_symbols.push(sym);
  if (sym.vram_start !== null && sym.vram_start !== undefined) {
    let l = state.all_symbols_dict.get(sym.vram_start);
    if (!l) { l = []; state.all_symbols_dict.set(sym.vram_start, l); }
    l.push(sym);
  }
  if (sym.size > 4) state.all_symbols_ranges.addi(sym.vram_start, sym.vram_end, sym);
}

export function toCname(symbolName) {
  symbolName = symbolName.replace(/[^0-9a-zA-Z_]/g, '_');
  if ('0123456789'.includes(symbolName[0])) symbolName = '_' + symbolName;
  return symbolName;
}

function pyStrip(s) { return s.replace(/^[\s\x1c-\x1f\x85\xa0]+|[\s\x1c-\x1f\x85\xa0]+$/g, ''); }

// Python str.split(" ") keeps empty strings between consecutive spaces.
function handleSymAddrs(path, lines, allSegments) {
  const getSegForName = (n) => allSegments.find((s) => s.name === n) || null;
  const getSegForRom = (rom) => allSegments.find((s) => s.contains_rom(rom)) || null;

  const seen = new Map();
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = pyStrip(lines[lineNum]);
    if (line === '' || line.startsWith('//')) continue;
    const commentLoc = line.indexOf('//');
    let lineMain = line;
    let lineExt = '';
    if (commentLoc !== -1) {
      lineExt = pyStrip(line.slice(commentLoc + 2));
      lineMain = pyStrip(line.slice(0, commentLoc));
    }

    let name; let addr;
    try {
      if ((line.match(/;/g) || []).length !== 1) throw new Error('Line must contain a single semi-colon');
      const lineSplit = lineMain.split('=');
      name = pyStrip(lineSplit[0]);
      if (lineSplit.length < 2) throw new Error('list index out of range');
      addr = pyInt0(pyStrip(lineSplit[1]).slice(0, -1));
    } catch (e) {
      log.parsingErrorPreamble(path, lineNum, line);
      log.write('Line must be of the form');
      log.write('<function_name> = <address>; // attr0:val0 attr1:val1 [...]');
      log.write('with <address> in hex preceded by 0x, or dec');
      log.write('');
      throw e;
    }

    const sym = new Symbol(addr, { given_name: name });
    let ignoreSym = false;
    if (lineExt) {
      for (const info of lineExt.split(' ')) {
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
          if (attrName === 'type') {
            if (!checkValidType(attrVal)) {
              log.parsingErrorPreamble(path, lineNum, line);
              log.write(`Unrecognized symbol type in '${info}', it should be one of`);
              log.write(pyRepr([...splat_sym_types, ...spim().common.gKnownTypes]));
              log.write('You may use a custom type that starts with a capital letter');
              log.error('');
            }
            sym.type = attrVal;
            continue;
          }
          if (attrName === 'size') { sym.given_size = pyInt0(attrVal); continue; }
          if (attrName === 'rom') { sym.rom = pyInt0(attrVal); continue; }
          if (attrName === 'segment') {
            const seg = getSegForName(attrVal);
            if (seg === null) {
              log.parsingErrorPreamble(path, lineNum, line);
              log.write(`Cannot find segment '${attrVal}'`);
              log.error('');
            } else {
              sym.segment = seg;
            }
            continue;
          }
          if (attrName === 'name_end') { sym.given_name_end = attrVal; continue; }
          if (attrName === 'filename') { sym.given_filename = attrVal; continue; }
          if (attrName === 'visibility') { sym.given_visibility = attrVal; continue; }
          if (attrName === 'function_owner') { sym.function_owner = attrVal; continue; }
          if (attrName === 'align' && atLeast('0.35.0')) {
            const align = pyInt0(attrVal);
            if (align < 0) {
              log.parsingErrorPreamble(path, lineNum, line);
              log.error(`The given alignment for '${sym.name}' (0x${hex(sym.vram_start, 8)}) is negative.`);
            }
            // (align & -align).bit_length() - 1
            const low = align & -align;
            const shift = low === 0 ? -1 : Math.log2(low);
            if (shift < 0 || 2 ** shift !== align) {
              log.parsingErrorPreamble(path, lineNum, line);
              log.error(`The given alignment '0x${hex(align)}' for symbol '${sym.name}' (0x${hex(sym.vram_start, 8)}) is not a power of two.`);
            }
            if (sym.vram_start % align !== 0) {
              log.parsingErrorPreamble(path, lineNum, line);
              log.error(`The symbol '${sym.name}' (0x${hex(sym.vram_start, 8)}) is not aligned already to the given alignment '0x${hex(align)}'.`);
            }
            sym.given_align = align;
            continue;
          }
        } catch (e) {
          if (e && e.name === 'SplatError') throw e;
          log.parsingErrorPreamble(path, lineNum, line);
          log.write(`value of attribute '${attrName}' could not be read:`);
          log.write('');
          throw e;
        }

        const tfVal = isTruey(attrVal) ? true : (isFalsey(attrVal) ? false : null);
        if (tfVal === null) {
          log.parsingErrorPreamble(path, lineNum, line);
          log.write(`Invalid Boolean value '${attrVal}' for attribute '${attrName}', should be one of`);
          log.write(pyRepr([...TRUEY_VALS, ...FALSEY_VALS]));
          log.error('');
        } else {
          switch (attrName) {
            case 'defined': sym.defined = tfVal; break;
            case 'extract': sym.extract = tfVal; break;
            case 'ignore': ignoreSym = tfVal; break;
            case 'force_migration': sym.force_migration = tfVal; break;
            case 'force_not_migration': sym.force_not_migration = tfVal; break;
            case 'allow_addend': sym.allow_addend = tfVal; break;
            case 'dont_allow_addend': sym.dont_allow_addend = tfVal; break;
            case 'can_reference': sym.can_reference = tfVal; break;
            case 'can_be_referenced': sym.can_be_referenced = tfVal; break;
            case 'allow_duplicated': sym.allow_duplicated = true; break;
            default: break;
          }
        }
      }
    }

    if (ignoreSym) {
      if (sym.given_size === null || sym.given_size === 0) {
        state.ignored_addresses.add(sym.vram_start);
      } else {
        state.spim_context.addBannedSymbolRangeBySize(sym.vram_start, sym.given_size);
      }
      continue;
    }

    if (sym.segment === null && sym.rom !== null) sym.segment = getSegForRom(sym.rom);
    if (sym.segment) sym.segment.add_symbol(sym);

    sym.user_declared = true;

    if (seen.has(sym.name)) {
      const item = seen.get(sym.name);
      if (!sym.allow_duplicated || !item.allow_duplicated) {
        log.parsingErrorPreamble(path, lineNum, line);
        log.error(`Duplicate symbol detected! ${sym.name} has already been defined at vram 0x${hex(item.vram_start, 8)}`);
      }
    }

    const items = state.all_symbols_dict.get(addr);
    if (items) {
      for (const item of items) {
        if (sym.rom === item.rom && sym.segment === item.segment) {
          if (!sym.allow_duplicated || !item.allow_duplicated) {
            log.parsingErrorPreamble(path, lineNum, line);
            log.error(`Duplicate symbol detected! ${sym.name} clashes with ${item.name} defined at vram 0x${hex(addr, 8)}.\n  If this is intended, specify either a segment or a rom address for this symbol`);
          }
        }
      }
    }

    const fname = sym.filename;
    if ([...fname].length > 253 || ILLEGAL_FILENAME_CHARS.some((c) => fname.includes(c))) {
      log.parsingErrorPreamble(path, lineNum, line);
      log.error('Ilegal symbol filename detected!\n'
        + '  The symbol\n'
        + `    ${sym.name}\n`
        + '  exceeds the 255 bytes filename limit that most OS imposes or uses illegal characters,\n'
        + '  which will be a problem when writing the symbol to its own file.\n'
        + `  To fix this specify a \`filename\` for this symbol, like \`filename:func_${hex(sym.vram_start, 8)}\`.\n`
        + '  Make sure the filename does not exceed 253 bytes nor it contains any of the following characters:\n'
        + `    ${pyRepr(ILLEGAL_FILENAME_CHARS)}`);
    }

    seen.set(sym.name, sym);
    addSymbol(sym);
  }
}

/** Python file.readlines() over universal-newline text. */
function readLines(p) {
  const text = readText(p);
  const lines = text.split('\n');
  const out = lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l));
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export function initialize(allSegments) {
  state.all_symbols = [];
  state.all_symbols_dict = new Map();
  state.all_symbols_ranges = new IntervalTree();
  for (const path of opts.symbol_addrs_paths) {
    if (exists(path)) handleSymAddrs(path, readLines(path), allSegments);
  }
}

export { readLines, stem };

export function initializeSpimContext(allSegments, CommonSegCode) {
  let globalVromStart = null;
  let globalVromEnd = null;
  let globalVramStart = opts.global_vram_start;
  let globalVramEnd = opts.global_vram_end;
  const overlaySegments = []; // insertion-ordered set

  const ctx = state.spim_context;
  for (const a of state.ignored_addresses) ctx.bannedSymbols.add(a);

  const globalSegmentsAfterOverlays = [];

  for (const segment of allSegments) {
    if (!(segment instanceof CommonSegCode)) continue;
    if (segment.special_vram_segment) continue;
    if (!Number.isInteger(segment.vram_start) || !Number.isInteger(segment.vram_end)
      || !Number.isInteger(segment.rom_start) || !Number.isInteger(segment.rom_end)) continue;

    const ramId = segment.get_exclusive_ram_id();
    if (ramId === null) {
      if (globalVramStart === null) globalVramStart = segment.vram_start;
      else if (segment.vram_start < globalVramStart) globalVramStart = segment.vram_start;

      if (globalVramEnd === null) globalVramEnd = segment.vram_end;
      else if (globalVramEnd < segment.vram_end) {
        globalVramEnd = segment.vram_end;
        if (overlaySegments.length > 0) globalSegmentsAfterOverlays.push(segment);
      }

      if (globalVromStart === null) globalVromStart = segment.rom_start;
      else if (segment.rom_start < globalVromStart) globalVromStart = segment.rom_start;

      if (globalVromEnd === null) globalVromEnd = segment.rom_end;
      else if (globalVromEnd < segment.rom_end) globalVromEnd = segment.rom_end;
    } else if (segment.vram_start !== segment.vram_end) {
      const spimSegment = ctx.addOverlaySegment(ramId, segment.rom_start, segment.rom_end, segment.vram_start, segment.vram_end);
      for (const list of segment.seg_symbols.values()) {
        for (const sym of list) addSymbolToSpimSegment(spimSegment, sym);
      }
      if (!overlaySegments.includes(spimSegment)) overlaySegments.push(spimSegment);
    }
  }

  if (globalVramStart !== null && globalVramEnd !== null && globalVromStart !== null && globalVromEnd !== null) {
    ctx.changeGlobalSegmentRanges(globalVromStart, globalVromEnd, globalVramStart, globalVramEnd);

    let overlapsFound = false;
    for (const ovl of overlaySegments) {
      if (ovl.vramEnd > globalVramStart && globalVramEnd > ovl.vramStart) {
        log.write(`Error: the vram range ([0x${hex(ovl.vramStart, 8)}, 0x${hex(ovl.vramEnd, 8)}]) of the non-global segment at rom address 0x${hex(ovl.vromStart)} overlaps with the global vram range ([0x${hex(globalVramStart, 8)}, 0x${hex(globalVramEnd, 8)}])`, { status: 'warn' });
        overlapsFound = true;
      }
    }
    if (overlapsFound) {
      log.write('Many overlaps between non-global and global segments were found.');
      log.write('This is usually caused by missing `exclusive_ram_id` tags on segments that have a higher vram address than other `exclusive_ram_id`-tagged segments');
      if (globalSegmentsAfterOverlays.length > 0) {
        log.write('These segments are the main suspects for missing a `exclusive_ram_id` tag:', { status: 'warn' });
        for (const seg of globalSegmentsAfterOverlays) log.write(`    '${seg.name}', rom: 0x${hex(seg.rom_start, 6)}`);
      } else {
        log.write('No suspected segments??', { status: 'warn' });
      }
      log.error('Stopping due to the above errors');
    }
  }

  for (const segment of allSegments) {
    if (!(segment instanceof CommonSegCode)) continue;
    if (segment.get_exclusive_ram_id() !== null) continue;
    for (const list of segment.seg_symbols.values()) {
      for (const sym of list) addSymbolToSpimSegment(ctx.globalSegment, sym);
    }
  }

  if (globalVramStart && globalVramEnd) {
    for (const sym of state.all_symbols) {
      if (sym.segment !== null) continue;
      if (sym.vram_start < globalVramStart || sym.vram_end > globalVramEnd) continue;
      addSymbolToSpimSegment(ctx.globalSegment, sym);
    }
  }
}

function applyCommonAttrs(contextSym, sym, withAddendAttrs) {
  if (sym.user_declared) contextSym.isUserDeclared = true;
  if (sym.defined) contextSym.isDefined = true;
  if (sym.rom !== null) contextSym.vromAddress = sym.rom;
  if (sym.given_size !== null) contextSym.size = sym.size;
  if (sym.force_migration) contextSym.forceMigration = true;
  if (sym.force_not_migration) contextSym.forceNotMigration = true;
  contextSym.functionOwnerForMigration = sym.function_owner;
  if (withAddendAttrs) {
    if (sym.allow_addend) contextSym.allowedToReferenceAddends = true;
    if (sym.dont_allow_addend) contextSym.notAllowedToReferenceAddends = true;
    if (sym.can_reference !== null) contextSym.allowedToReferenceSymbols = sym.can_reference;
    if (sym.can_be_referenced !== null) contextSym.allowedToBeReferenced = sym.can_be_referenced;
  }
  contextSym.setNameGetCallbackIfUnset(() => sym.name);
  if (sym.given_name_end) contextSym.nameEnd = sym.given_name_end;
  if (sym.given_visibility) contextSym.visibility = sym.given_visibility;
  if (sym.given_align && atLeast('0.35.0')) contextSym.setAlignment(sym.given_align);
  return contextSym;
}

export function addSymbolToSpimSegment(segment, sym) {
  const auto = !sym.user_declared;
  let contextSym;
  // SymbolsSegment.addX(address, isAutogenerated, vromAddress); addSymbol has sectionType second.
  if (sym.type === 'func') contextSym = segment.addFunction(sym.vram_start, auto, sym.rom);
  else if (sym.type === 'jtbl') contextSym = segment.addJumpTable(sym.vram_start, auto, sym.rom);
  else if (sym.type === 'jtbl_label') contextSym = segment.addJumpTableLabel(sym.vram_start, auto, sym.rom);
  else if (sym.type === 'label') contextSym = segment.addBranchLabel(sym.vram_start, auto, sym.rom);
  else {
    contextSym = segment.addSymbol(sym.vram_start, undefined, auto, sym.rom);
    if (sym.type !== null) contextSym.type = sym.type;
  }
  return applyCommonAttrs(contextSym, sym, true);
}

export function addSymbolToSpimSection(section, sym) {
  const auto = !sym.user_declared;
  let contextSym;
  // ElementBase.addX(vramAddress, *, isAutogenerated, symbolVrom); addSymbol has sectionType first.
  if (sym.type === 'func') contextSym = section.addFunction(sym.vram_start, auto, sym.rom);
  else if (sym.type === 'jtbl') contextSym = section.addJumpTable(sym.vram_start, auto, sym.rom);
  else if (sym.type === 'jtbl_label') contextSym = section.addJumpTableLabel(sym.vram_start, auto, sym.rom);
  else if (sym.type === 'label') contextSym = section.addBranchLabel(sym.vram_start, auto, sym.rom);
  else {
    contextSym = section.addSymbol(sym.vram_start, undefined, auto, sym.rom);
    if (sym.type !== null) contextSym.type = sym.type;
  }
  return applyCommonAttrs(contextSym, sym, false);
}

// force_in_segment=true when the symbol belongs to this specific segment,
// false when it is just a reference. splat 0.34 had no such parameter.
export function createSymbolFromSpimSymbol(segment, contextSym, forceInSegment) {
  const S = spim().common.SymbolSpecialType;
  let inSegment = false;
  let symType = null;
  if (contextSym.type === S.jumptable) { inSegment = true; symType = 'jtbl'; }
  else if (contextSym.type === S.function) { symType = 'func'; }
  else if (contextSym.type === S.branchlabel) { inSegment = true; symType = 'label'; }
  else if (contextSym.type === S.jumptablelabel) { inSegment = true; symType = 'jtbl_label'; }

  if (!inSegment) {
    const ramId = segment.get_exclusive_ram_id();
    if (contextSym.overlayCategory === null && ramId === null) {
      inSegment = segment.contains_vram(contextSym.vram);
    } else if (contextSym.overlayCategory === ramId) {
      if (contextSym.vromAddress !== null) inSegment = segment.contains_rom(contextSym.vromAddress);
      else inSegment = segment.contains_vram(contextSym.vram);
    }
  }

  const force = atLeast('0.35.0') ? forceInSegment : false;
  const sym = segment.create_symbol(contextSym.vram, force || inSegment, { type: symType, reference: true });

  if (sym.given_name === null && contextSym.name !== null) sym.given_name = contextSym.name;

  contextSym.setNameGetCallback(() => sym.name);

  if (contextSym.size !== null) sym.given_size = contextSym.getSize();
  if (contextSym.vromAddress !== null) sym.rom = contextSym.getVrom();
  if (contextSym.isDefined) sym.defined = true;
  if (contextSym.referenceCounter > 0) sym.referenced = true;
  return sym;
}

export function markCFuncsAsDefined() {
  for (const symbol of state.all_symbols) {
    if (state.to_mark_as_defined.size === 0) return;
    const n = symbol.name;
    if (state.to_mark_as_defined.has(n)) {
      symbol.defined = true;
      state.to_mark_as_defined.delete(n);
    }
  }
}

export class Symbol {
  constructor(vramStart, fields = {}) {
    this.vram_start = vramStart;
    this.given_name = null;
    this.given_name_end = null;
    this.rom = null;
    this.type = null;
    this.given_size = null;
    this.segment = null;
    this.defined = false;
    this.referenced = false;
    this.extract = true;
    this.user_declared = false;
    this.force_migration = false;
    this.force_not_migration = false;
    this.function_owner = null;
    this.allow_addend = false;
    this.dont_allow_addend = false;
    this.can_reference = null;
    this.can_be_referenced = null;
    this.linker_section = null;
    this.allow_duplicated = false;
    this.given_filename = null;
    this.given_visibility = null;
    this.given_align = null;
    this._generated_default_name = null;
    this._last_type = null;
    Object.assign(this, fields);
  }

  toString() { return this.name; }

  format_name(format) {
    let ret = format.replaceAll('$VRAM', hex(this.vram_start, 8));
    if (ret.includes('$ROM')) {
      if (!Number.isInteger(this.rom)) {
        log.error(`Attempting to rom-name a symbol with no ROM address: ${hex(this.vram_start, 8)} typed ${this.type === null ? 'None' : this.type}`);
      }
      ret = ret.replaceAll('$ROM', hex(this.rom));
    }
    if (ret.includes('$SEG')) {
      if (this.segment === null) return hex(this.vram_start);
      ret = ret.replaceAll('$SEG', this.segment.name);
    }
    return ret;
  }

  get default_name() {
    if (this._generated_default_name !== null && this.type === this._last_type) {
      return this._generated_default_name;
    }
    let suffix;
    if (this.segment) {
      suffix = Number.isInteger(this.rom)
        ? this.format_name(this.segment.symbol_name_format)
        : this.format_name(this.segment.symbol_name_format_no_rom);
    } else {
      suffix = Number.isInteger(this.rom)
        ? this.format_name(opts.symbol_name_format)
        : this.format_name(opts.symbol_name_format_no_rom);
    }
    let prefix;
    if (this.type === 'func') prefix = 'func';
    else if (this.type === 'jtbl') prefix = 'jtbl';
    else if (this.type === 'jtbl_label' || this.type === 'label') return `.L${suffix}`;
    else prefix = 'D';
    this._last_type = this.type;
    this._generated_default_name = `${prefix}_${suffix}`;
    return this._generated_default_name;
  }

  get rom_end() { return !this.rom ? null : this.rom + this.size; }
  get vram_end() { return this.vram_start + this.size; }
  get name() { return this.given_name ? this.given_name : this.default_name; }
  get size() { return this.given_size !== null ? this.given_size : 4; }
  get filename() { return this.given_filename !== null ? this.given_filename : this.name; }
  contains_vram(o) { return o >= this.vram_start && o < this.vram_end; }
  contains_rom(o) { return o >= this.rom && o < this.rom_end; }
}

// splat.segtypes.linker_entry
import { atLeast, exists, readText, mkdirp, writeText, resolvePath, rt } from '../runtime.js';
import * as log from '../util/log.js';
import { opts } from '../util/options.js';
import { toCname } from '../util/symbols.js';
import { P, parent, relativeTo, suffix, suffixes, withSuffix } from '../util/pypath.js';
import { hex } from '../util/pyfmt.js';

const cleanCache = new Map();

export function resetCleanUpCache() { cleanCache.clear(); }

// clean 'foo/../bar' to 'bar'
export function cleanUpPath(path) {
  const key = path;
  if (cleanCache.has(key)) return cleanCache.get(key);
  const resolved = resolvePath(path);
  const base = resolvePath(opts.base_path);
  let out;
  try {
    out = relativeTo(resolved, base);
  } catch {
    try {
      out = relativeTo(resolved, resolvePath(rt.cwd));
    } catch {
      out = path;
    }
  }
  cleanCache.set(key, out);
  return out;
}

export function pathToObjectPath(path) {
  path = cleanUpPath(path);
  const fullSuffix = opts.use_o_as_suffix ? '.o' : suffix(path) + '.o';
  if (!String(path).startsWith(String(opts.build_path))) path = P(opts.build_path, path);
  return cleanUpPath(withSuffix(path, fullSuffix));
}

export function writeFileIfDifferent(path, newContent) {
  const old = exists(path) ? readText(path) : '';
  if (old !== newContent) {
    mkdirp(parent(path));
    writeText(path, newContent, opts.c_newline);
  }
}

const style = () => opts.segment_symbols_style;
export const getSegmentRomStart = (c) => (style() === 'makerom' ? `_${c}SegmentRomStart` : `${c}_ROM_START`);
export const getSegmentRomEnd = (c) => (style() === 'makerom' ? `_${c}SegmentRomEnd` : `${c}_ROM_END`);
export const getSegmentVramStart = (c) => (style() === 'makerom' ? `_${c}SegmentStart` : `${c}_VRAM`);
export const getSegmentVramEnd = (c) => (style() === 'makerom' ? `_${c}SegmentEnd` : `${c}_VRAM_END`);

function pyCapitalize(s) { return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; }

export function convertSectionNameToLinkerFormat(sectionType) {
  if (!sectionType.startsWith('.')) throw new Error('AssertionError');
  if (style() === 'makerom') {
    if (sectionType === '.rodata') return 'RoData';
    return pyCapitalize(sectionType.slice(1));
  }
  return toCname(sectionType.toUpperCase());
}

export function getSegmentSectionStart(segName, sectionType) {
  const sec = convertSectionNameToLinkerFormat(sectionType);
  return style() === 'makerom' ? `_${segName}Segment${sec}Start` : `${segName}${sec}_START`;
}
export function getSegmentSectionEnd(segName, sectionType) {
  const sec = convertSectionNameToLinkerFormat(sectionType);
  return style() === 'makerom' ? `_${segName}Segment${sec}End` : `${segName}${sec}_END`;
}
export function getSegmentSectionSize(segName, sectionType) {
  const sec = convertSectionNameToLinkerFormat(sectionType);
  return style() === 'makerom' ? `_${segName}Segment${sec}Size` : `${segName}${sec}_SIZE`;
}

export function getSegmentVramEndSymbolName(segment) { return getSegmentVramEnd(segment.get_cname()); }

export class LinkerEntry {
  constructor(segment, srcPaths, objectPath, sectionOrder, sectionLink, noload = false) {
    this.segment = segment;
    this.src_paths = srcPaths.map((p) => cleanUpPath(p));
    this.section_order = sectionOrder;
    this.section_link = sectionLink;
    this.noload = noload;
    this.bss_contains_common = segment.bss_contains_common;
    this.object_path = pathToObjectPath(objectPath);
  }

  get section_order_type() { return this.section_order === '.rdata' ? '.rodata' : this.section_order; }
  get section_link_type() { return this.section_link === '.rdata' ? '.rodata' : this.section_link; }

  emit_symbol_for_data(w) {
    if (!opts.ld_generate_symbol_per_data_segment) return;
    if (this.object_path && this.section_link_type === '.data') {
      // str(dir / name) + ".".join(object_path.suffixes[:-1])
      const sfx = suffixes(this.object_path).slice(0, -1).join('.');
      const pathCname = (P(this.segment.dir, this.segment.name) + sfx).replace(/[^0-9a-zA-Z_]/g, '_');
      w._write_symbol(pathCname, '.');
    }
  }

  emit_path(w) {
    if (this.object_path === null) throw new Error(`AssertionError: ${this.segment.name}, ${this.segment.rom_start}`);
    if (this.noload && this.bss_contains_common) {
      w._write_object_path_section(this.object_path, `${this.section_link} COMMON .scommon`);
    } else {
      const wildcard = opts.ld_wildcard_sections ? '*' : '';
      w._write_object_path_section(this.object_path, `${this.section_link}${wildcard}`);
    }
  }

  emit_entry(w) {
    this.emit_symbol_for_data(w);
    this.emit_path(w);
  }
}

export class LinkerWriter {
  constructor(isPartial = false) {
    this.linker_discard_section = opts.ld_discard_section;
    this.sections_allowlist = opts.ld_sections_allowlist;
    this.sections_denylist = opts.ld_sections_denylist;
    this.entries = [];
    this.dependencies_entries = [];
    this.buffer = [];
    this.header_symbols = new Set();
    this.is_partial = isPartial;
    this._indent_level = 0;

    this._writeln('SECTIONS');
    this._begin_block();
    if (!this.is_partial) {
      this._writeln(`__romPos = ${opts.ld_rom_start};`);
      if (atLeast('0.35.0') && opts.ld_gp_expression !== null) this._writeln(`_gp = ${opts.ld_gp_expression};`);
      else if (opts.gp !== null) this._writeln(`_gp = 0x${hex(opts.gp)};`);
    }
  }

  write_max_vram_end_sym(symbol, overlays) {
    for (const segment of overlays) {
      if (segment === overlays[0]) this._writeln(`${symbol} = ${getSegmentVramEndSymbolName(segment)};`);
      else this._writeln(`${symbol} = MAX(${symbol}, ${getSegmentVramEndSymbolName(segment)});`);
    }
  }

  add(segment, maxVramSyms) {
    const entries = segment.get_linker_entries();
    this.entries.push(...entries);
    this.dependencies_entries.push(...entries);
    const segName = segment.get_cname();
    for (const [sym, segs] of maxVramSyms) this.write_max_vram_end_sym(sym, segs);

    if (opts.ld_legacy_generation) {
      this.add_legacy(segment, entries);
      return;
    }

    const sectionEntries = new Map();
    for (const sectionName of segment.section_order) {
      if (opts.section_order.includes(sectionName)) sectionEntries.set(sectionName, []);
    }

    let prevEntry = null;
    for (const entry of entries) {
      if (sectionEntries.has(entry.section_order_type)) { prevEntry = entry.section_order_type; break; }
    }

    let anyLoad = false;
    let anyNoload = false;
    for (const entry of entries) {
      if (sectionEntries.has(entry.section_order_type)) {
        sectionEntries.get(entry.section_order_type).push(entry);
      } else if (prevEntry !== null) {
        if (!sectionEntries.has(prevEntry)) {
          log.error(`\nError on linker script generation: section '${prevEntry}' not found.\n  Make sure the section '${prevEntry}' is listed on 'section_order' of the yaml options.`);
        }
        sectionEntries.get(prevEntry).push(entry);
      }
      anyLoad = anyLoad || !entry.noload;
      anyNoload = anyNoload || entry.noload;
      prevEntry = entry.section_order_type;
    }

    if (segment.ld_align_segment_start) {
      this._write_symbol('__romPos', `ALIGN(__romPos, 0x${hex(segment.ld_align_segment_start)})`);
      this._write_symbol('.', `ALIGN(., 0x${hex(segment.ld_align_segment_start)})`);
    }

    this._write_symbol(getSegmentRomStart(segName), '__romPos');

    let isFirst = true;
    if (anyLoad) {
      this._write_segment_sections(segment, segName, sectionEntries, false, isFirst);
      isFirst = false;
    }
    if (anyNoload) {
      this._write_segment_sections(segment, segName, sectionEntries, true, isFirst);
      isFirst = false;
    }
    this._end_segment(segment, !anyLoad);
  }

  add_legacy(segment, entries) {
    const segName = segment.get_cname();
    const started = new Map(opts.section_order.map((s) => [s, false]));

    // entry -> section, for the last entry of each section type
    const lastSeen = new Map();
    const lastSeenValues = new Set();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (opts.section_order.includes(entry.section_order_type) && !lastSeenValues.has(entry.section_order_type)) {
        lastSeen.set(entry, entry.section_order_type);
        lastSeenValues.add(entry.section_order_type);
      }
    }

    if (segment.ld_align_segment_start) {
      this._write_symbol('__romPos', `ALIGN(__romPos, 0x${hex(segment.ld_align_segment_start)})`);
      this._write_symbol('.', `ALIGN(., 0x${hex(segment.ld_align_segment_start)})`);
    }

    this._write_symbol(getSegmentRomStart(segName), '__romPos');
    this._begin_segment(segment, segName, false, true);

    let i = 0;
    for (const entry of entries) {
      if (entry.noload) break;
      const st = started.has(entry.section_order_type) ? started.get(entry.section_order_type) : true;
      if (!st) {
        this._begin_section(segName, entry.section_order_type);
        started.set(entry.section_order_type, true);
      }
      entry.emit_entry(this);
      if (lastSeen.has(entry)) this._end_section(segName, entry.section_order_type, segment);
      i++;
    }

    if (entries.some((e) => e.noload)) {
      this._end_block();
      this._begin_segment(segment, segName, true, false);
      for (const entry of entries.slice(i)) {
        const st = started.has(entry.section_order_type) ? started.get(entry.section_order_type) : true;
        if (!st) {
          this._begin_section(segName, entry.section_order_type);
          started.set(entry.section_order_type, true);
        }
        entry.emit_entry(this);
        if (lastSeen.has(entry)) this._end_section(segName, entry.section_order_type, segment);
      }
    }
    this._end_segment(segment, false);
  }

  add_referenced_partial_segment(segment, maxVramSyms) {
    const entries = segment.get_linker_entries();
    this.entries.push(...entries);
    const segmentsPath = opts.ld_partial_build_segments_path;
    const segName = segment.get_cname();
    for (const [sym, segs] of maxVramSyms) this.write_max_vram_end_sym(sym, segs);

    if (segment.ld_align_segment_start) {
      this._write_symbol('__romPos', `ALIGN(__romPos, 0x${hex(segment.ld_align_segment_start)})`);
      this._write_symbol('.', `ALIGN(., 0x${hex(segment.ld_align_segment_start)})`);
    }
    this._write_symbol(getSegmentRomStart(segName), '__romPos');

    const anyLoad = entries.some((e) => !e.noload);
    let isFirst = true;
    if (anyLoad) {
      this._begin_segment(segment, segName, false, isFirst);
      for (const sectionName of segment.section_order) {
        if (!opts.section_order.includes(sectionName)) continue;
        if (sectionName === '.bss') continue;
        const entry = new LinkerEntry(segment, [], P(segmentsPath, `${segName}.o`), sectionName, sectionName, false);
        this.dependencies_entries.push(entry);
        entry.emit_entry(this);
      }
      isFirst = false;
    }
    if (entries.some((e) => e.noload)) {
      if (!isFirst) this._end_block();
      this._begin_segment(segment, segName, true, isFirst);
      let bssContainsCommon = false;
      for (const entry of entries) {
        if (entry.segment.bss_contains_common) { bssContainsCommon = true; break; }
      }
      const entry = new LinkerEntry(segment, [], P(segmentsPath, `${segName}.o`), '.bss', '.bss', true);
      entry.bss_contains_common = bssContainsCommon;
      this.dependencies_entries.push(entry);
      entry.emit_entry(this);
    }
    this._end_segment(segment, !anyLoad);
  }

  add_partial_segment(segment) {
    const entries = segment.get_linker_entries();
    this.entries.push(...entries);
    this.dependencies_entries.push(...entries);
    const segName = segment.get_cname();

    const sectionEntries = new Map();
    for (const sectionName of segment.section_order) {
      if (opts.section_order.includes(sectionName)) sectionEntries.set(sectionName, []);
    }
    let prevEntry = null;
    for (const entry of entries) {
      if (sectionEntries.has(entry.section_order_type)) {
        sectionEntries.get(entry.section_order_type).push(entry);
      } else if (prevEntry !== null) {
        if (!sectionEntries.has(prevEntry)) {
          log.error(`\nError on linker script generation: section '${prevEntry}' not found.\n  Make sure the section '${prevEntry}' is listed on 'section_order' of the yaml options.`);
        }
        sectionEntries.get(prevEntry).push(entry);
      }
      prevEntry = entry.section_order_type;
    }

    for (const [sectionName, ents] of sectionEntries) {
      if (ents.length === 0) continue;
      this._begin_partial_segment(sectionName, segment, ents[0].noload);
      this._begin_section(segName, sectionName);
      for (const entry of ents) entry.emit_entry(this);
      this._end_section(segName, sectionName, segment);
      this._end_partial_segment(sectionName);
    }
  }

  save_linker_script(outputPath) {
    if (this.sections_allowlist.length > 0) {
      const address = this.is_partial ? '' : ' 0';
      for (const sect of this.sections_allowlist) {
        this._writeln(`${sect}${address} :`);
        this._begin_block();
        this._writeln(`*(${sect});`);
        this._end_block();
      }
      this._writeln('');
    }
    if (this.linker_discard_section || this.sections_denylist.length > 0) {
      this._writeln('/DISCARD/ :');
      this._begin_block();
      for (const sect of this.sections_denylist) this._writeln(`*(${sect});`);
      if (this.linker_discard_section) this._writeln('*(*);');
      this._end_block();
    }
    this._end_block();
    if (this._indent_level !== 0) throw new Error('AssertionError');
    writeFileIfDifferent(outputPath, this.buffer.join('\n') + '\n');
  }

  save_symbol_header() {
    const path = opts.ld_symbol_header_path;
    if (path) {
      const syms = [...this.header_symbols].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      writeFileIfDifferent(path,
        '#ifndef _HEADER_SYMBOLS_H_\n#define _HEADER_SYMBOLS_H_\n\n#include "common.h"\n\n'
        + syms.map((s) => `extern Addr ${s};\n`).join('')
        + '\n#endif\n');
    }
  }

  save_dependencies_file(outputPath, targetElfPath) {
    const target = atLeast('0.35.0') ? cleanUpPath(targetElfPath) : targetElfPath;
    let output = `${target}:`;
    for (const entry of this.dependencies_entries) {
      if (entry.object_path === null) continue;
      output += ` \\\n    ${entry.object_path}`;
    }
    output += '\n';
    for (const entry of this.dependencies_entries) {
      if (entry.object_path === null) continue;
      output += `${entry.object_path}:\n`;
    }
    writeFileIfDifferent(outputPath, output);
  }

  _writeln(line) {
    if (line.length === 0) this.buffer.push(line);
    else this.buffer.push('    '.repeat(this._indent_level) + line);
  }

  _begin_block() { this._writeln('{'); this._indent_level += 1; }
  _end_block() { this._indent_level -= 1; this._writeln('}'); }

  _write_symbol(symbol, value) {
    symbol = toCname(symbol);
    if (typeof value === 'number') value = `0x${hex(value)}`;
    this._writeln(`${symbol} = ${value};`);
    this.header_symbols.add(symbol);
  }

  _write_object_path_section(objectPath, section) { this._writeln(`${objectPath}(${section});`); }

  _begin_segment(segment, segName, noload, isFirst) {
    let vramStr;
    if (opts.ld_use_symbolic_vram_addresses && segment.vram_symbol !== null) vramStr = segment.vram_symbol + ' ';
    else vramStr = Number.isInteger(segment.vram_start) ? `0x${hex(segment.vram_start)} ` : '';

    let addrStr = ' ';
    if (isFirst) addrStr += vramStr;
    if (noload) { segName += '_bss'; addrStr += '(NOLOAD) '; }

    this._write_symbol(getSegmentVramStart(segName), `ADDR(.${segName})`);
    let line = `.${segName}${addrStr}:`;
    if (!noload) line += ` AT(${getSegmentRomStart(segName)})`;
    if (opts.emit_subalign && segment.subalign !== null) line += ` SUBALIGN(${segment.subalign})`;
    this._writeln(line);
    this._begin_block();
    if (segment.ld_fill_value !== null) this._writeln(`FILL(0x${hex(segment.ld_fill_value, 8)});`);
  }

  _end_segment(segment, allBss = false) {
    this._end_block();
    const name = segment.get_cname();
    if (!allBss) this._writeln(`__romPos += SIZEOF(.${name});`);
    if (!opts.segment_end_before_align && segment.align) {
      this._writeln(`__romPos = ALIGN(__romPos, ${segment.align});`);
      if (opts.ld_align_segment_vram_end) this._writeln(`. = ALIGN(., ${segment.align});`);
    }
    this._write_symbol(getSegmentRomEnd(name), '__romPos');
    this._write_symbol(getSegmentVramEndSymbolName(segment), '.');
    if (opts.segment_end_before_align && segment.align) {
      this._writeln(`__romPos = ALIGN(__romPos, ${segment.align});`);
      if (opts.ld_align_segment_vram_end) this._writeln(`. = ALIGN(., ${segment.align});`);
    }
    this._writeln('');
  }

  _begin_partial_segment(sectionName, segment, noload) {
    let line = `${sectionName}`;
    if (noload) line += ' (NOLOAD)';
    line += ' :';
    if (opts.emit_subalign && segment.subalign !== null) line += ` SUBALIGN(${segment.subalign})`;
    this._writeln(line);
    this._begin_block();
  }

  _end_partial_segment() { this._end_block(); this._writeln(''); }

  _begin_section(segName, curSection) {
    this._write_symbol(getSegmentSectionStart(segName, curSection), '.');
  }

  _end_section(segName, curSection, segment) {
    const start = getSegmentSectionStart(segName, curSection);
    const end = getSegmentSectionEnd(segName, curSection);
    const size = getSegmentSectionSize(segName, curSection);
    if (opts.ld_align_section_vram_end && segment.align !== null) this._writeln(`. = ALIGN(., ${segment.align});`);
    this._write_symbol(end, '.');
    this._write_symbol(size, `ABSOLUTE(${end} - ${start})`);
  }

  _write_segment_sections(segment, segName, sectionEntries, noload, isFirst) {
    if (!isFirst) this._end_block();
    this._begin_segment(segment, segName, noload, isFirst);
    for (const [sectionName, ents] of sectionEntries) {
      if (ents.length === 0) continue;
      if (ents[0].noload !== noload) continue;
      this._begin_section(segName, sectionName);
      for (const entry of ents) entry.emit_entry(this);
      this._end_section(segName, sectionName, segment);
    }
  }
}

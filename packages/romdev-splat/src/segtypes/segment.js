// splat.segtypes.segment
import { atLeast } from '../runtime.js';
import * as log from '../util/log.js';
import { opts } from '../util/options.js';
import * as vramClasses from '../util/vram_classes.js';
import * as symbols from '../util/symbols.js';
import { Symbol, toCname } from '../util/symbols.js';
import { IntervalTree } from '../util/intervaltree.js';
import { P } from '../util/pypath.js';
import { hex, isDict, isList, pyInt, pyStr, truthy } from '../util/pyfmt.js';
import { registry } from './registry.js';

const has = (o, k) => isDict(o) && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d = null) => (has(o, k) ? o[k] : d);

export function parseSegmentVram(segment) {
  if (has(segment, 'vram')) return pyInt(segment.vram);
  return null;
}

export function parseSegmentVramSymbol(segment) {
  if (has(segment, 'vram_symbol')) return pyStr(segment.vram_symbol);
  return null;
}

export function parseSegmentVramClass(segment) {
  if (has(segment, 'vram_class')) return vramClasses.resolve(segment.vram_class);
  return null;
}

export function parseSegmentFollowsVram(segment) {
  if (isDict(segment)) return get(segment, 'follows_vram', null);
  return null;
}

export function parseSegmentAlign(segment) {
  if (has(segment, 'align')) return pyInt(segment.align);
  return null;
}

export function parseSegmentSubalign(segment) {
  const def = opts.subalign;
  if (isDict(segment)) {
    let subalign = get(segment, 'subalign', def);
    if (subalign !== null) subalign = pyInt(subalign);
    return subalign;
  }
  return def;
}

export function parseSegmentSectionOrder(segment) {
  const def = opts.section_order;
  if (isDict(segment)) return get(segment, 'section_order', def);
  return def;
}

export class SegmentStatisticsInfo {
  constructor(size, count) { this.size = size; this.count = count; }
  merge(o) { return new SegmentStatisticsInfo(this.size + o.size, this.count + o.count); }
}

/** defaultdict(lambda: SegmentStatisticsInfo(0, 0)) */
export function emptyStatistics() { return new Map(); }
export function statGet(stats, k) {
  if (!stats.has(k)) stats.set(k, new SegmentStatisticsInfo(0, 0));
  return stats.get(k);
}

export class Segment {
  static require_unique_name = true;

  static get_class_for_type(segType) {
    if (segType.startsWith('.')) segType = segType.slice(1);
    let cls;
    if (opts.allow_segment_overrides) {
      cls = Segment.get_extension_segment_class(segType);
      if (cls === null) cls = Segment.get_base_segment_class(segType);
    } else {
      cls = Segment.get_base_segment_class(segType);
      if (cls === null) cls = Segment.get_extension_segment_class(segType);
    }
    if (cls === null) {
      log.error(`could not load segment type '${segType}'\n(hint: confirm your extension directory is configured correctly)`);
    }
    return cls;
  }

  static get_base_segment_class(segType) {
    const platform = opts.platform;
    const p = registry.platform[platform];
    if (p && Object.prototype.hasOwnProperty.call(p, segType)) return p[segType];
    if (Object.prototype.hasOwnProperty.call(registry.common, segType)) return registry.common[segType];
    return null;
  }

  static get_extension_segment_class(segType) {
    const extPath = opts.extensions_path;
    if (!extPath) {
      log.error(`could not load presumed extended segment type '${segType}' because no extensions path is configured`);
    }
    return registry.loadExtension(extPath, segType, opts.platform);
  }

  /** -> [start|null, isAuto] */
  static parse_segment_start(segment) {
    const s = isDict(segment) ? get(segment, 'start', null) : segment[0];
    if (s === null || s === undefined) return [null, false];
    if (s === 'auto') return [null, true];
    return [pyInt(s), false];
  }

  static parse_segment_type(segment) {
    if (isDict(segment)) {
      if (!has(segment, 'type')) throw new Error("KeyError: 'type'");
      return pyStr(segment.type);
    }
    return pyStr(segment[1]);
  }

  static parse_segment_name(cls, romStart, segment) {
    if (has(segment, 'name')) return pyStr(segment.name);
    if (has(segment, 'dir')) return pyStr(segment.dir);
    if (isList(segment) && segment.length >= 3) return pyStr(segment[2]);
    return pyStr(cls.get_default_name(romStart));
  }

  static parse_segment_symbol_name_format(segment) {
    if (has(segment, 'symbol_name_format')) return pyStr(segment.symbol_name_format);
    return opts.symbol_name_format;
  }

  static parse_segment_symbol_name_format_no_rom(segment) {
    if (has(segment, 'symbol_name_format_no_rom')) return pyStr(segment.symbol_name_format_no_rom);
    return opts.symbol_name_format_no_rom;
  }

  static parse_segment_file_path(segment) {
    if (has(segment, 'path')) return P(segment.path);
    return null;
  }

  static parse_segment_bss_contains_common(segment, def) {
    if (has(segment, 'bss_contains_common')) return truthy(segment.bss_contains_common);
    return def;
  }

  static parse_linker_section_order(yaml) {
    if (has(yaml, 'linker_section_order')) return pyStr(yaml.linker_section_order);
    return null;
  }

  static parse_linker_section(yaml) {
    if (has(yaml, 'linker_section')) return pyStr(yaml.linker_section);
    return null;
  }

  static parse_ld_fill_value(yaml, def) {
    if (has(yaml, 'ld_fill_value')) return yaml.ld_fill_value;
    return def;
  }

  static parse_ld_align_segment_start(yaml) {
    if (has(yaml, 'ld_align_segment_start')) return yaml.ld_align_segment_start;
    return opts.ld_align_segment_start;
  }

  static parse_suggestion_rodata_section_start(yaml) {
    if (isDict(yaml)) {
      const v = get(yaml, 'suggestion_rodata_section_start', null);
      if (v !== null) {
        if (typeof v !== 'boolean') throw new Error('AssertionError');
        return v;
      }
    }
    return null;
  }

  static parse_pair_segment(yaml) {
    if (!atLeast('0.35.0')) return null;
    if (has(yaml, 'pair_segment')) return yaml.pair_segment;
    return null;
  }

  constructor(romStart, romEnd, type, name, vramStart, args, yaml) {
    this.rom_start = romStart;
    this.rom_end = romEnd;
    this.type = type;
    this.name = name;
    this.vram_start = vramStart;

    this.align = null;
    this.given_subalign = opts.subalign;
    this.exclusive_ram_id = null;
    this.given_dir = '.';
    this.given_find_file_boundaries = null;
    this.given_seg_symbols = new Map();
    this.symbol_ranges_ram = new IntervalTree();
    this.symbol_ranges_rom = new IntervalTree();
    this.given_section_order = opts.section_order;
    this.vram_class = null;
    this.given_follows_vram = null;
    this.given_vram_symbol = null;
    this.given_symbol_name_format = opts.symbol_name_format;
    this.given_symbol_name_format_no_rom = opts.symbol_name_format_no_rom;
    this.parent = null;
    this.sibling = null;
    this.siblings = new Map();
    this.pair_segment_name = Segment.parse_pair_segment(yaml);
    this.paired_segment = null;
    this.file_path = null;
    this.args = args;
    this.yaml = yaml;

    this.extract = true;
    this.has_linker_entry = true;
    if (this.rom_start === null) this.extract = false;
    else if (this.type.startsWith('.')) this.extract = false;

    this.warnings = [];
    this.did_run = false;
    this.bss_contains_common = Segment.parse_segment_bss_contains_common(yaml, opts.ld_bss_contains_common);
    this.special_vram_segment = false;
    this.linker_section_order = Segment.parse_linker_section_order(yaml);
    this.linker_section = Segment.parse_linker_section(yaml);
    this.ld_fill_value = Segment.parse_ld_fill_value(yaml, opts.ld_fill_value);
    this.ld_align_segment_start = Segment.parse_ld_align_segment_start(yaml);
    this.is_generated = false;
    this.given_suggestion_rodata_section_start = Segment.parse_suggestion_rodata_section_start(yaml);
    this.is_auto_segment = false;
    this.index_within_group = null;

    if (this.rom_start !== null && this.rom_end !== null && this.rom_start !== undefined && this.rom_end !== undefined) {
      if (this.rom_start > this.rom_end) {
        log.error(`Error: segments out of order - (${this.name} starts at 0x${hex(this.rom_start)}, but next segment starts at 0x${hex(this.rom_end)})`);
      }
    }
  }

  static from_yaml(cls, yaml, romStart, romEnd, parent, vram = null) {
    const type = Segment.parse_segment_type(yaml);
    const name = Segment.parse_segment_name(cls, romStart, yaml);
    const vramClass = parseSegmentVramClass(yaml);
    let vramStart;
    if (vram !== null && vram !== undefined) vramStart = vram;
    else if (vramClass) vramStart = vramClass.vram;
    else vramStart = parseSegmentVram(yaml);

    const args = isDict(yaml) ? [] : yaml.slice(3);

    const ret = new cls(romStart, romEnd, type, name, vramStart, args, yaml);
    if (parent !== null) {
      // Python `"subalign" in yaml` works for dicts (keys) and lists (items).
      const inYaml = (k) => (isDict(yaml) ? has(yaml, k) : yaml.includes(k));
      if (inYaml('subalign')) {
        log.error(`Non top-level segment '${name}' (rom address 0x${hex(romStart)}) specified a \`subalign\`. \`subalign\` is valid only for top-level segments`);
      }
      if (inYaml('ld_fill_value')) {
        log.error(`Non top-level segment '${name}' (rom address 0x${hex(romStart)}) specified a \`ld_fill_value\`. \`ld_fill_value\` is valid only for top-level segments`);
      }
    }
    ret.parent = parent;

    if (atLeast('0.35.0') && opts.ld_bss_is_noload && ret.isBss) {
      if (parent && parent.isCode) {
        if (parent.bss_size <= 0) {
          log.error(`Top-level segment '${parent.name}' is missing a \`bss_size\` value.\n    A non-zero \`bss_size\` value must be defined on the top-level segments that contain '${ret.type}' sections (produced by the '${ret.name}' section).`);
        }
        if (Number.isInteger(ret.vram_start) && Number.isInteger(parent.vram_end) && ret.vram_start >= parent.vram_end) {
          log.error(`The section '${ret.name}' (vram 0x${hex(ret.vram_start, 8)}) is outside its parent's address range '${parent.name}' (0x${hex(parent.vram_start, 8)} ~ 0x${hex(parent.vram_end, 8)}).\n    This may happen when the specified \`bss_size\` value is too small.`);
        }
      }
    }

    ret.given_section_order = parseSegmentSectionOrder(yaml);
    ret.given_subalign = parseSegmentSubalign(yaml);

    if (isDict(yaml)) {
      ret.extract = truthy(get(yaml, 'extract', ret.extract));
      ret.exclusive_ram_id = get(yaml, 'exclusive_ram_id', null);
      ret.given_dir = P(get(yaml, 'dir', ''));
      ret.has_linker_entry = truthy(get(yaml, 'linker_entry', true));
      ret.given_find_file_boundaries = get(yaml, 'find_file_boundaries', null);
    }

    ret.given_symbol_name_format = Segment.parse_segment_symbol_name_format(yaml);
    ret.given_symbol_name_format_no_rom = Segment.parse_segment_symbol_name_format_no_rom(yaml);
    ret.file_path = Segment.parse_segment_file_path(yaml);
    ret.bss_contains_common = Segment.parse_segment_bss_contains_common(yaml, opts.ld_bss_contains_common);
    ret.given_follows_vram = parseSegmentFollowsVram(yaml);
    ret.given_vram_symbol = parseSegmentVramSymbol(yaml);

    if (vramClass) {
      ret.vram_class = vramClass;
      if (ret.given_follows_vram) log.error(`Error: segment ${ret.name} has both a vram class and a follows_vram property`);
      if (ret.given_vram_symbol) log.error(`Error: segment ${ret.name} has both a vram class and a vram_symbol property`);
    }

    if (!ret.align) ret.align = parseSegmentAlign(yaml);
    return ret;
  }

  static is_text() { return false; }
  static is_data() { return false; }
  static is_rodata() { return false; }
  static is_noload() { return false; }
  static estimate_size() { return null; }
  static get_default_name(addr) { return hex(addr); }

  is_text() { return this.constructor.is_text(); }
  is_data() { return this.constructor.is_data(); }
  is_rodata() { return this.constructor.is_rodata(); }
  is_noload() { return this.constructor.is_noload(); }
  get_default_name(addr) { return this.constructor.get_default_name(addr); }

  // isinstance() markers (avoid circular imports between segment classes)
  get isBss() { return false; }
  get isCode() { return false; }
  get isGroup() { return false; }
  get isCodeSubsegment() { return false; }

  get needs_symbols() { return false; }

  get dir() {
    if (this.parent) return P(this.parent.dir, this.given_dir);
    return this.given_dir;
  }

  get show_file_boundaries() {
    if (this.given_find_file_boundaries !== null && this.given_find_file_boundaries !== undefined) {
      return this.given_find_file_boundaries;
    }
    if (!this.parent) return opts.find_file_boundaries;
    return this.parent.show_file_boundaries;
  }

  get symbol_name_format() { return this.given_symbol_name_format; }
  get symbol_name_format_no_rom() { return this.given_symbol_name_format_no_rom; }

  get subalign() {
    if (this.parent !== null) throw new Error(`AssertionError: subalign is not valid for non-top-level segments. (${this})`);
    return this.given_subalign;
  }

  get vram_symbol() {
    if (this.vram_class && this.vram_class.vram_symbol) return this.vram_class.vram_symbol;
    if (this.given_vram_symbol) return this.given_vram_symbol;
    return null;
  }

  get_exclusive_ram_id() {
    if (this.parent) return this.parent.get_exclusive_ram_id();
    return this.exclusive_ram_id;
  }

  add_symbol(symbol) {
    let l = this.given_seg_symbols.get(symbol.vram_start);
    if (!l) { l = []; this.given_seg_symbols.set(symbol.vram_start, l); }
    l.push(symbol);
    if (symbol.size > 4) {
      this.symbol_ranges_ram.addi(symbol.vram_start, symbol.vram_end, symbol);
      if (symbol.rom !== null) this.symbol_ranges_rom.addi(symbol.rom, symbol.rom_end, symbol);
    }
  }

  get seg_symbols() {
    if (this.parent) return this.parent.seg_symbols;
    return this.given_seg_symbols;
  }

  get size() {
    if (this.rom_start !== null && this.rom_end !== null && this.rom_start !== undefined && this.rom_end !== undefined) {
      return this.rom_end - this.rom_start;
    }
    return null;
  }

  get statistics() {
    const stats = emptyStatistics();
    if (this.size !== null) stats.set(this.statistics_type, new SegmentStatisticsInfo(this.size, 1));
    return stats;
  }

  get statistics_type() { return this.type; }

  get vram_end() {
    if (this.vram_start !== null && this.vram_start !== undefined && this.size !== null) return this.vram_start + this.size;
    return null;
  }

  get section_order() { return this.given_section_order; }

  get rodata_follows_data() {
    const so = this.section_order;
    if (!so.includes('.rodata') || !so.includes('.data')) return false;
    return so.indexOf('.rodata') - so.indexOf('.data') === 1;
  }

  get suggestion_rodata_section_start() {
    if (this.given_suggestion_rodata_section_start !== null) return this.given_suggestion_rodata_section_start;
    if (this.parent !== null) return this.parent.suggestion_rodata_section_start;
    return opts.suggestion_rodata_section_start;
  }

  get_cname() {
    let name = this.name;
    if (this.parent) name = this.parent.name + '_' + name;
    return toCname(name);
  }

  contains_vram(vram) {
    const vs = this.vram_start; const ve = this.vram_end;
    if (vs !== null && vs !== undefined && ve !== null && ve !== undefined) return vram >= vs && vram < ve;
    return false;
  }

  contains_rom(rom) {
    if (this.rom_start !== null && this.rom_start !== undefined && this.rom_end !== null && this.rom_end !== undefined) {
      return rom >= this.rom_start && rom < this.rom_end;
    }
    return false;
  }

  rom_to_ram(romAddr) {
    if (this.vram_start !== null && this.vram_start !== undefined && this.rom_start !== null && this.rom_start !== undefined) {
      return this.vram_start + romAddr - this.rom_start;
    }
    return null;
  }

  ram_to_rom(ramAddr) {
    if (!this.contains_vram(ramAddr) && ramAddr !== this.vram_end) return null;
    if (this.vram_start !== null && this.vram_start !== undefined && this.rom_start !== null && this.rom_start !== undefined) {
      return this.rom_start + ramAddr - this.vram_start;
    }
    return null;
  }

  should_scan() { return this.should_split(); }
  should_split() { return this.extract && opts.is_mode_active(this.type); }
  scan() {}
  split() {}
  cache() { return [this.yaml, this.rom_end]; }

  get_linker_section() { return '.data'; }

  get_linker_section_order() {
    if (this.linker_section_order !== null) return this.linker_section_order;
    return this.get_linker_section();
  }

  get_linker_section_linksection() {
    if (this.linker_section !== null) return this.linker_section;
    return this.get_linker_section();
  }

  get_section_flags() { return null; }

  get_section_asm_line() {
    let line = `.section ${this.get_linker_section_linksection()}`;
    const flags = this.get_section_flags();
    if (flags) line += `, "${flags}"`;
    return line;
  }

  out_path() { return null; }

  get_most_parent() {
    let seg = this;
    while (seg.parent) seg = seg.parent;
    return seg;
  }

  get_linker_entries() {
    if (!this.has_linker_entry) return [];
    const path = this.out_path();
    if (path) {
      return [new registry.LinkerEntry(this, [path], path, this.get_linker_section_order(),
        this.get_linker_section_linksection(), this.is_noload())];
    }
    return [];
  }

  log(msg) {
    if (opts.verbose) log.write(`${this.type} ${this.name}: ${msg}`);
  }

  warn(msg) { this.warnings.push(msg); }

  is_name_default() { return this.name === this.get_default_name(this.rom_start); }

  unique_id() {
    const s = this.parent ? this.parent.unique_id() + '_' : '';
    return s + this.type + '_' + this.name;
  }

  static visible_ram(seg1, seg2) {
    if (seg1.get_most_parent() === seg2.get_most_parent()) return true;
    if (seg1.get_exclusive_ram_id() === null || seg2.get_exclusive_ram_id() === null) return true;
    return seg1.get_exclusive_ram_id() !== seg2.get_exclusive_ram_id();
  }

  retrieve_symbol(syms, addr) {
    const all = syms.get(addr);
    if (!all) return null;
    const items = all.filter((i) => i.segment === null || Segment.visible_ram(this, i.segment));
    if (items.length === 0) return null;
    return items[0];
  }

  retrieve_sym_type(syms, addr, type) {
    const all = syms.get(addr);
    if (!all) return null;
    const items = all.filter((i) => (i.segment === null || Segment.visible_ram(this, i.segment)) && type === i.type);
    return items.length ? items[0] : null;
  }

  get_symbol(addr, { in_segment = false, type = null, create = false, define = false, reference = false, search_ranges = false, local_only = false } = {}) {
    let ret = null;
    let rom = null;
    const mostParent = this.get_most_parent();

    if (in_segment) {
      rom = mostParent.ram_to_rom(addr);
      ret = mostParent.retrieve_symbol(mostParent.seg_symbols, addr);
      if (!ret && search_ranges) {
        if (rom !== null) {
          const c = mostParent.symbol_ranges_rom.at(rom);
          if (c.length) ret = c[0].data;
        }
        if (!ret) {
          const c = mostParent.symbol_ranges_ram.at(addr);
          if (c.length) ret = c[0].data;
        }
      }
    } else if (!local_only) {
      ret = mostParent.retrieve_symbol(symbols.state.all_symbols_dict, addr);
      if (!ret && search_ranges) {
        const c = symbols.state.all_symbols_ranges.at(addr);
        if (c.length) ret = c[0].data;
      }
    }

    if (!ret && create) {
      ret = new Symbol(addr, { rom, type });
      symbols.addSymbol(ret);
      if (in_segment) {
        ret.segment = mostParent;
        let l = mostParent.seg_symbols.get(addr);
        if (!l) { l = []; mostParent.seg_symbols.set(addr, l); }
        l.push(ret);
      }
    }

    if (ret) {
      if (define) ret.defined = true;
      if (reference) ret.referenced = true;
      if (ret.type === null) ret.type = type;
      if (ret.rom === null) ret.rom = rom;
      if (in_segment && ret.segment === null) ret.segment = mostParent;
    }
    return ret;
  }

  create_symbol(addr, inSegment, { type = null, define = false, reference = false, search_ranges = false, local_only = false } = {}) {
    const ret = this.get_symbol(addr, { in_segment: inSegment, type, create: true, define, reference, search_ranges, local_only });
    if (!ret) throw new Error('AssertionError');
    return ret;
  }

  toString() { return `${this.name} (${this.type})`; }
}

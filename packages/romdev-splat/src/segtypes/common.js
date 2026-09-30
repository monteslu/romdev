// splat.segtypes.common.*
import { atLeast, exists, mkdirp, readText, writeText, writeBytes, TextFile, print } from '../runtime.js';
import * as log from '../util/log.js';
import { opts } from '../util/options.js';
import * as symbols from '../util/symbols.js';
import { P, parent, relativeTo, relpath, suffix, withSuffix, name as pathName } from '../util/pypath.js';
import { hex, isDict, isList, truthy, ljust } from '../util/pyfmt.js';
import { rt } from '../runtime.js';
import { Segment, parseSegmentAlign, parseSegmentVram, emptyStatistics, statGet } from './segment.js';
import { LinkerEntry, LinkerWriter } from './linker_entry.js';
import { makeTextSection, makeDataSection, makeRodataSection, makeBssSection } from '../disassembler/disassembler_section.js';
import { spim, rabbitizer } from '../disassembler/spim.js';

const has = (o, k) => isDict(o) && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d = null) => (has(o, k) ? o[k] : d);

export class CommonSegment extends Segment {}

// ---------------------------------------------------------------- group

/** CommonSegGroup behaviour, shared with CommonSegData (Python multiple inheritance). */
const GroupMixin = {
  get_next_seg_start(i, subsegmentYamls) {
    for (let j = i + 1; j < subsegmentYamls.length; j++) {
      const [ret] = Segment.parse_segment_start(subsegmentYamls[j]);
      if (ret !== null) return ret;
    }
    return this.rom_end;
  },

  group_parse_subsegments(yaml) {
    const ret = [];
    if (!truthy(yaml) || !has(yaml, 'subsegments')) return ret;
    let prevStart = -1;
    let lastRomEnd = 0;
    const subs = yaml.subsegments;
    for (let i = 0; i < subs.length; i++) {
      const subYaml = subs[i];
      if (isList(subYaml) && subYaml.length === 1) continue;
      const typ = Segment.parse_segment_type(subYaml);
      let [start, isAutoSegment] = Segment.parse_segment_start(subYaml);
      const cls = Segment.get_class_for_type(typ);
      if (start === null) start = i === 0 ? this.rom_start : lastRomEnd;

      let end = null;
      if (i < subs.length - 1) [end] = Segment.parse_segment_start(subs[i + 1]);
      if (start !== null && end === null) {
        const est = cls.estimate_size(subYaml);
        if (est !== null) end = start + est;
      }
      if (end === null) end = this.get_next_seg_start(i, subs);

      if (start !== null && prevStart !== null && start < prevStart) {
        log.error(`Error: Group segment ${this.name} contains subsegments which are out of ascending rom order (0x${hex(prevStart)} followed by 0x${hex(start)})`);
      }

      let vram = null;
      if (start !== null) {
        const mp = this.get_most_parent();
        if (mp.vram_start !== null && mp.rom_start !== null) vram = mp.vram_start + start - mp.rom_start;
      }
      if (cls.is_noload()) { start = lastRomEnd; end = lastRomEnd; }

      const segment = Segment.from_yaml(cls, subYaml, start, end, this, vram);
      if (segment.special_vram_segment) this.special_vram_segment = true;
      segment.is_auto_segment = isAutoSegment;
      segment.index_within_group = ret.length;
      ret.push(segment);
      prevStart = start;
      if (end !== null) lastRomEnd = end;
    }
    ret.forEach((s, i) => { s.index_within_group = i; });
    return ret;
  },

  group_statistics() {
    const stats = emptyStatistics();
    for (const sub of this.subsegments) {
      for (const [ty, info] of sub.statistics) stats.set(ty, statGet(stats, ty).merge(info));
    }
    return stats;
  },

  group_scan(romBytes) {
    for (const sub of this.subsegments) if (sub.should_scan()) sub.scan(romBytes);
  },

  group_split(romBytes) {
    for (const sub of this.subsegments) if (sub.should_split()) sub.split(romBytes);
  },

  group_cache() { return this.subsegments.map((s) => s.cache()); },

  get_subsegment_for_ram(addr) {
    for (const sub of this.subsegments) if (sub.contains_vram(addr)) return sub;
    if (this.paired_segment && this.paired_segment.isGroup) {
      for (const sub of this.paired_segment.subsegments) if (sub.contains_vram(addr)) return sub;
    }
    return null;
  },

  get_next_subsegment_for_ram(addr, currentSubsegIndex) {
    const start = currentSubsegIndex !== null ? currentSubsegIndex : 0;
    for (const sub of this.subsegments.slice(start)) {
      if (sub.vram_start === null) continue;
      if (sub.vram_start > addr) return sub;
    }
    return null;
  },

  pair_subsegments_to_other_segment(other) {
    for (const segment of this.subsegments) {
      for (const sibling of other.subsegments) {
        if (segment.name === sibling.name) {
          segment.siblings.set(sibling.get_linker_section_linksection(), sibling);
          sibling.siblings.set(segment.get_linker_section_linksection(), segment);
          if (segment.is_text()) sibling.sibling = segment;
          else if (sibling.is_text()) segment.sibling = sibling;
          break;
        }
      }
    }
  },
};

export class CommonSegGroup extends CommonSegment {
  constructor(...a) {
    super(...a);
    this.subsegments = this.parse_subsegments(this.yaml);
  }

  get isGroup() { return true; }
  parse_subsegments(yaml) { return this.group_parse_subsegments(yaml); }

  get needs_symbols() { return this.subsegments.some((s) => s.needs_symbols); }
  get statistics() { return this.group_statistics(); }
  get_linker_entries() { return this.subsegments.flatMap((s) => s.get_linker_entries()); }
  scan(romBytes) { this.group_scan(romBytes); }
  split(romBytes) { this.group_split(romBytes); }
  should_split() { return this.extract; }
  should_scan() { return this.extract; }
  cache() { return this.group_cache(); }
}
Object.assign(CommonSegGroup.prototype, GroupMixin);

// ---------------------------------------------------------------- code

function listIndex(l, v) { const i = l.indexOf(v); return i === -1 ? null : i; }

export class CommonSegCode extends CommonSegGroup {
  constructor(...a) {
    super(...a);
    this.reported_file_split = false;
    this.align = parseSegmentAlign(this.yaml);
    if (this.align === null) this.align = 0x10;
  }

  get isCode() { return true; }

  // Python sets this before CommonSegGroup.__init__ parses the subsegments.
  get bss_size() { return isDict(this.yaml) ? get(this.yaml, 'bss_size', 0) : 0; }

  get needs_symbols() { return true; }

  get vram_end() {
    if (this.vram_start !== null && this.size !== null) return this.vram_start + this.size + this.bss_size;
    return null;
  }

  _generate_segment_from_all(repType, ReplaceClass, baseName, baseSeg, romStart = null, romEnd = null, vramStart = null) {
    const rep = new ReplaceClass(romStart, romEnd, repType, baseName, vramStart, [], {});
    rep.extract = false;
    rep.given_subalign = this.given_subalign;
    rep.exclusive_ram_id = this.get_exclusive_ram_id();
    rep.given_dir = this.given_dir;
    rep.given_symbol_name_format = this.symbol_name_format;
    rep.given_symbol_name_format_no_rom = this.symbol_name_format_no_rom;
    if (rep === baseSeg) throw new Error('AssertionError');
    rep.sibling = baseSeg;
    rep.parent = this;
    rep.is_generated = true;
    rep.is_auto_segment = true;
    if (rep.special_vram_segment) this.special_vram_segment = true;
    rep.bss_contains_common = this.bss_contains_common;
    return rep;
  }

  _insert_all_auto_sections(ret, baseSegments, readonlyBefore) {
    const als = opts.auto_link_sections;
    if (als.length === 0) return ret;
    const baseList = [...baseSegments.entries()];

    let lastInsertedIndex = baseList.length - 1;
    ret.forEach((seg, i) => {
      if (seg.is_text()) lastInsertedIndex = i;
      else if (readonlyBefore && seg.is_rodata()) lastInsertedIndex = i;
    });

    for (let i = 0; i < als.length; i++) {
      const sect = als[i];
      for (const [, seg] of baseList) {
        const linkSection = seg.get_linker_section_order();
        if (linkSection === sect || linkSection === '') {
          lastInsertedIndex = ret.indexOf(seg);
          continue;
        }
        let sibling = seg.siblings.get(sect);
        if (sibling === undefined || sibling === null) {
          const ReplaceClass = Segment.get_class_for_type(sect);
          sibling = this._generate_segment_from_all(sect, ReplaceClass, seg.name, seg);
          seg.siblings.set(sect, sibling);
          lastInsertedIndex += 1;
          ret.splice(lastInsertedIndex < 0 ? Math.max(0, ret.length + lastInsertedIndex) : lastInsertedIndex, 0, sibling);
        }
        lastInsertedIndex = ret.indexOf(sibling);
      }
      while (lastInsertedIndex < ret.length) {
        const linkSection = ret.at(lastInsertedIndex).get_linker_section_order(); // Python negative indexing
        if (linkSection !== '' && !als.slice(0, i + 1).includes(linkSection)) {
          lastInsertedIndex -= 1;
          if (lastInsertedIndex < 0) lastInsertedIndex = 0;
          break;
        }
        lastInsertedIndex += 1;
      }
    }
    return ret;
  }

  parse_subsegments(segmentYaml) {
    if (!has(segmentYaml, 'subsegments')) {
      if (!this.parent) throw new Error(`No subsegments provided in top-level code segment ${this.name}`);
      return [];
    }
    const baseSegments = new Map();
    let ret = [];
    let prevStart = -1;
    let prevVram = -1;
    let lastRomEnd = null;

    let readonlyBefore = false;
    const textIndex = listIndex(this.section_order, '.text');
    if (textIndex !== null) {
      const rodataIndex = listIndex(this.section_order, '.rodata');
      if (rodataIndex !== null) readonlyBefore = rodataIndex < textIndex;
      else {
        const rdataIndex = listIndex(this.section_order, '.rdata');
        if (rdataIndex !== null) readonlyBefore = rdataIndex < textIndex;
      }
    }

    const subs = segmentYaml.subsegments;
    for (let i = 0; i < subs.length; i++) {
      const subYaml = subs[i];
      if (isList(subYaml) && subYaml.length === 1) continue;
      const typ = Segment.parse_segment_type(subYaml);
      let [start, isAutoSegment] = Segment.parse_segment_start(subYaml);
      const cls = Segment.get_class_for_type(typ);
      if (start === null) start = i === 0 ? this.rom_start : lastRomEnd;

      let end = null;
      if (i < subs.length - 1) [end] = Segment.parse_segment_start(subs[i + 1]);
      if (start !== null && end === null) {
        const est = cls.estimate_size(subYaml);
        if (est !== null) end = start + est;
      }
      if (end === null) end = this.get_next_seg_start(i, subs);

      if (start !== null && prevStart !== null && start < prevStart) {
        log.error(`Error: Group segment '${this.name}' contains subsegments which are out of ascending rom order (0x${hex(prevStart)} followed by 0x${hex(start)})`);
      }

      let vram = null;
      if (start !== null) vram = this.get_most_parent().rom_to_ram(start);

      if (cls.is_noload() && lastRomEnd !== null) { start = lastRomEnd; end = lastRomEnd; }

      const segment = Segment.from_yaml(cls, subYaml, start, end, this, vram);
      segment.is_auto_segment = isAutoSegment;

      if (segment.vram_start !== null && prevVram !== null && segment.vram_start < prevVram) {
        log.error(`Error: Group segment '${this.name}' contains subsegments which are out of ascending vram order (0x${hex(prevVram)} followed by 0x${hex(segment.vram_start)}).\n`
          + `Detected when processing file '${segment.name}' of type '${segment.type}'`);
      }

      ret.push(segment);
      if (segment.is_text()) baseSegments.set(segment.name, segment);
      if (readonlyBefore && segment.is_rodata() && segment.sibling === null) baseSegments.set(segment.name, segment);
      if (segment.special_vram_segment) this.special_vram_segment = true;
      segment.bss_contains_common = this.bss_contains_common;
      prevStart = start;
      prevVram = segment.vram_start;
      if (end !== null) lastRomEnd = end;
    }

    for (const segment of ret) {
      let sibling = baseSegments.has(segment.name) ? baseSegments.get(segment.name) : null;
      if (sibling === segment) sibling = null;
      segment.sibling = sibling;
      if (sibling !== null) {
        segment.siblings.set(sibling.get_linker_section_linksection(), sibling);
        sibling.siblings.set(segment.get_linker_section_linksection(), segment);
      }
    }

    ret = this._insert_all_auto_sections(ret, baseSegments, readonlyBefore);
    ret.forEach((s, i) => { s.index_within_group = i; });
    return ret;
  }

  scan(romBytes) {
    for (const sub of this.subsegments) if (sub.is_text() && sub.should_scan()) sub.scan(romBytes);
    for (const sub of this.subsegments) if (!sub.is_text() && sub.should_scan()) sub.scan(romBytes);
  }
}

// ---------------------------------------------------------------- codesubsegment

export class CommonSegCodeSubsegment extends Segment {
  constructor(...a) {
    super(...a);
    this.init_code_subsegment();
  }

  init_code_subsegment() {
    const vram = parseSegmentVram(this.yaml);
    if (vram !== null) this.vram_start = vram;
    this.str_encoding = isDict(this.yaml) ? get(this.yaml, 'str_encoding', null) : null;
    this.spim_section = null;
    const IC = rabbitizer().InstrCategory;
    this.instr_category = IC.CPU;
    if (opts.platform === 'ps2') this.instr_category = IC.R5900;
    else if (opts.platform === 'psx') this.instr_category = IC.R3000GTE;
    else if (opts.platform === 'psp') this.instr_category = IC.R4000ALLEGREX;
    this.detect_redundant_function_end = isDict(this.yaml) ? get(this.yaml, 'detect_redundant_function_end', null) : null;
    this.is_hasm = false;
    this.use_gp_rel_macro = opts.use_gp_rel_macro;
  }

  get isCodeSubsegment() { return true; }
  get needs_symbols() { return true; }
  get_linker_section() { return '.text'; }

  configure_disassembler_section(ds) {
    const section = ds.get_section();
    section.isHandwritten = this.is_hasm;
    section.instrCat = this.instr_category;
    section.detectRedundantFunctionEnd = this.detect_redundant_function_end;
    section.setGpRelHack(!this.use_gp_rel_macro);
  }

  scan_code(romBytes, isHasm = false) {
    this.is_hasm = isHasm;
    if (this.is_auto_segment) return;
    if (!Number.isInteger(this.rom_start)) {
      log.error(`Segment '${this.name}' (type '${this.type}') requires a rom_start. Got '${this.rom_start === null ? 'None' : this.rom_start}'`);
    }
    const segmentRomStart = this.get_most_parent().rom_start;
    if (!Number.isInteger(this.vram_start)) {
      log.error(`Segment '${this.name}' (type '${this.type}') requires a vram address. Got '${this.vram_start === null ? 'None' : this.vram_start}'`);
    }
    this.spim_section = makeTextSection(this.rom_start, this.rom_end, this.vram_start, this.name, romBytes,
      segmentRomStart, this.get_exclusive_ram_id());
    this.configure_disassembler_section(this.spim_section);
    this.spim_section.analyze();
    this.spim_section.set_comment_offset(this.rom_start);
    for (const func of this.spim_section.get_section().symbolList) this.process_insns(func);
  }

  process_insns(funcSpim) {
    const section = this.spim_section.get_section();
    symbols.createSymbolFromSpimSymbol(this.get_most_parent(), funcSpim.contextSym, false);
    for (const referencedVram of funcSpim.referencedVrams) {
      const cs = section.getSymbol(referencedVram, undefined, false);
      if (cs !== null && cs !== undefined) symbols.createSymbolFromSpimSymbol(this.get_most_parent(), cs, false);
    }
    const instrs = funcSpim.instructions;
    const symOff = funcSpim.instrAnalyzer.symbolInstrOffset;
    for (let i = 0; i < instrs.length; i++) {
      const insn = instrs[i];
      if (opts.platform === 'ps2') {
        const TV = rabbitizer().TrinaryValue;
        insn.flag_r5900UseDollar = this instanceof CommonSegC ? TV.FALSE : TV.TRUE;
        insn.flag_r5900DisasmAsData = TV.TRUE;
      }
      const off = i * 4;
      const symAddress = symOff instanceof Map ? symOff.get(off) : symOff[off];
      if (symAddress !== undefined) {
        const cs = section.getSymbol(symAddress);
        if (cs !== null && cs !== undefined) symbols.createSymbolFromSpimSymbol(this.get_most_parent(), cs, false);
      }
    }
  }

  print_file_boundaries() {
    if (!this.show_file_boundaries || !this.spim_section) return;
    const section = this.spim_section.get_section();
    for (const inFileOffset of section.fileBoundaries) {
      if (!this.parent.reported_file_split) {
        this.parent.reported_file_split = true;
        let symAddr = 0;
        for (const sym of section.symbolList) {
          const symOffset = sym.inFileOffset - section.inFileOffset;
          if (inFileOffset === symOffset) break;
          symAddr = sym.vram;
        }
        print(`\nSegment ${this.name}, symbol at vram ${hex(symAddr)} ends with extra nops, indicating a likely file split.`);
        print('File split suggestions for this segment will follow in config yaml format:');
      }
      print(`      - [0x${hex(this.rom_start + inFileOffset)}, ${this.type}]`);
    }
  }

  should_scan() {
    return opts.is_mode_active('code') && this.rom_start !== null && this.rom_end !== null;
  }

  should_split() { return this.extract && opts.is_mode_active('code') && this.should_scan(); }
  should_self_split() { return this.should_split(); }

  get_asm_file_header() {
    const ret = ['.include "macro.inc"', ''];
    ret.push(...this.get_asm_file_extra_directives());
    const preamble = opts.generated_s_preamble;
    if (preamble) { ret.push(preamble); ret.push(''); }
    ret.push(this.get_section_asm_line());
    ret.push('');
    return ret;
  }

  get_asm_file_extra_directives() {
    const ret = ['.set noat', '.set noreorder'];
    if (opts.add_set_gp_64) ret.push('.set gp=64');
    ret.push('');
    return ret;
  }

  asm_out_path() { return P(opts.asm_path, this.dir, `${this.name}.s`); }
  out_path() { return this.asm_out_path(); }

  split_as_asm_file(outPath) {
    if (this.spim_section === null) return;
    if (!outPath) return;
    mkdirp(parent(outPath));
    this.print_file_boundaries();
    const f = new TextFile(outPath, '\n');
    for (const line of this.get_asm_file_header()) f.write(line + '\n');
    f.write(this.spim_section.disassemble());
    f.close();
  }

  split_as_asmtu_file(outPath) {
    const modern = atLeast('0.35.0');
    if (!modern) {
      if (this.spim_section === null) return;
      if (!outPath) return;
    }
    mkdirp(parent(outPath));
    this.print_file_boundaries();
    const f = new TextFile(outPath, '\n');
    if (this.spim_section !== null) {
      for (const line of this.get_asm_file_header()) f.write(line + '\n');
      f.write(this.spim_section.disassemble());
    }
    const wanted = (sibling) => sibling && sibling.isCodeSubsegment && sibling.spim_section !== null
      && (!sibling.should_self_split() || (modern && opts.make_full_disasm_for_code));
    for (const sect of this.section_order) {
      if (sect === this.get_linker_section_linksection()) continue;
      const sibling = this.siblings.get(sect);
      if (!sibling) continue;
      if (wanted(sibling)) {
        f.write('\n');
        f.write(`${sibling.get_section_asm_line()}\n\n`);
        f.write(sibling.spim_section.disassemble());
      }
    }
    for (const [sect, sibling] of this.siblings) {
      if (sect === this.get_linker_section_linksection()) continue;
      if (this.section_order.includes(sect)) continue;
      if (wanted(sibling)) {
        f.write('\n');
        f.write(`${sibling.get_section_asm_line()}\n\n`);
        f.write(sibling.spim_section.disassemble());
      }
    }
    f.close();
  }
}

// ---------------------------------------------------------------- asm / hasm / asmtu

export class CommonSegAsm extends CommonSegCodeSubsegment {
  static is_text() { return true; }
  get_section_flags() { return 'ax'; }
  scan(romBytes) {
    if (this.rom_start !== null && this.rom_end !== null && this.rom_start !== this.rom_end) this.scan_code(romBytes);
  }
  split() {
    if (this.rom_start === this.rom_end) return;
    this.split_as_asm_file(this.out_path());
  }
}

export class CommonSegAsmtu extends CommonSegAsm {
  split() {
    if (this.rom_start === this.rom_end) return;
    if (this.spim_section === null) return;
    const outPath = this.out_path();
    this.split_as_asmtu_file(outPath);
  }
}

export class CommonSegHasm extends CommonSegAsm {
  asm_out_path() {
    if (opts.hasm_in_src_path) return P(opts.src_path, this.dir, `${this.name}.s`);
    return super.asm_out_path();
  }
  scan(romBytes) {
    if (this.rom_start !== null && this.rom_end !== null && this.rom_start !== this.rom_end) this.scan_code(romBytes, true);
  }
  split() {
    if (this.rom_start === this.rom_end) return;
    const outPath = this.out_path();
    if (outPath && !exists(outPath)) this.split_as_asm_file(outPath);
  }
}

// ---------------------------------------------------------------- c / cpp

// Python re: r'//.*?$|/\*.*?\*/|\'(?:\\.|[^\\\'])*\'|"(?:\\.|[^\\"])*"' with DOTALL|MULTILINE
const STRIP_C_COMMENTS_RE = /\/\/[\s\S]*?(?=\n|$(?![\s\S]))|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^\\'])*'|"(?:\\[\s\S]|[^\\"])*"/g;
// r"^(?:static\s+)?[^\s]+\s+([^\s(]+)\(([^;)]*)\)[^;]+?{" MULTILINE
const C_FUNC_RE = /^(?:static\s+)?[^\s]+\s+([^\s(]+)\(([^;)]*)\)[^;]+?\{/gm;
// r"GLOBAL_ASM\(\"(\w+\/)*(\w+)\.s\"\)" MULTILINE
const C_GLOBAL_ASM_IDO_RE = /GLOBAL_ASM\("(\w+\/)*(\w+)\.s"\)/gm;

export class CommonSegC extends CommonSegCodeSubsegment {
  constructor(...a) {
    super(...a);
    this.defined_funcs = new Set();
    this.global_asm_funcs = new Set();
    this.global_asm_rodata_syms = new Set();
    this.file_extension = 'c';
    this.use_gp_rel_macro = opts.use_gp_rel_macro_nonmatching;
  }

  static strip_c_comments(text) {
    return text.replace(STRIP_C_COMMENTS_RE, (s) => (s.startsWith('/') ? ' ' : s));
  }

  static get_funcs_defined_in_c(cFile) {
    const text = CommonSegC.strip_c_comments(readText(cFile));
    const out = new Set();
    for (const m of text.matchAll(C_FUNC_RE)) out.add(m[1]);
    return out;
  }

  static *find_all_instances(string, sub) {
    let start = 0;
    for (;;) {
      start = string.indexOf(sub, start);
      if (start === -1) return;
      yield start;
      start += sub.length;
    }
  }

  static get_close_parenthesis(string, pos) {
    let count = 0;
    for (;;) {
      const c = string[pos];
      if (c === undefined) throw new Error('IndexError: string index out of range');
      if (c === '(') count += 1;
      else if (c === ')') {
        if (count === 0) return pos + 1;
        count -= 1;
      }
      pos += 1;
    }
  }

  static *find_include_macro(text, macroName) {
    for (const pos of CommonSegC.find_all_instances(text, `${macroName}(`)) {
      const close = CommonSegC.get_close_parenthesis(text, pos + `${macroName}(`.length);
      const contents = text.slice(pos, close);
      const args = contents.split(',');
      const strip = (s) => s.replace(/^[ )]+|[ )]+$/g, '');
      if (opts.use_legacy_include_asm) {
        if (args.length >= 3) yield strip(args[2]);
      } else if (args.length >= 2) yield strip(args[1]);
    }
  }

  static get_global_asm_funcs(cFile) {
    const text = CommonSegC.strip_c_comments(readText(cFile));
    if (opts.compiler.name === 'IDO') return new Set([...text.matchAll(C_GLOBAL_ASM_IDO_RE)].map((m) => m[2]));
    return new Set(CommonSegC.find_include_macro(text, 'INCLUDE_ASM'));
  }

  static get_global_asm_rodata_syms(cFile) {
    const text = CommonSegC.strip_c_comments(readText(cFile));
    if (opts.compiler.name === 'IDO') return new Set([...text.matchAll(C_GLOBAL_ASM_IDO_RE)].map((m) => m[2]));
    return new Set(CommonSegC.find_include_macro(text, 'INCLUDE_RODATA'));
  }

  static is_text() { return true; }
  get_section_flags() { return 'ax'; }

  out_path() { return P(opts.src_path, this.dir, `${this.name}.${this.file_extension}`); }

  scan(romBytes) {
    if (this.rom_start !== null && this.rom_end !== null && this.rom_start !== this.rom_end) {
      const path = this.out_path();
      if (path && opts.do_c_func_detection && exists(path)) {
        this.defined_funcs = CommonSegC.get_funcs_defined_in_c(path);
        this.global_asm_funcs = CommonSegC.get_global_asm_funcs(path);
        this.global_asm_rodata_syms = CommonSegC.get_global_asm_rodata_syms(path);
        for (const s of this.defined_funcs) symbols.state.to_mark_as_defined.add(s);
        for (const s of this.global_asm_funcs) symbols.state.to_mark_as_defined.add(s);
        for (const s of this.global_asm_rodata_syms) symbols.state.to_mark_as_defined.add(s);
      }
      this.scan_code(romBytes);
    }
  }

  split() {
    const modern = atLeast('0.35.0');
    if (this.is_auto_segment) {
      if (modern && opts.make_full_disasm_for_code) this.split_as_asmtu_file(this.asm_out_path());
      return;
    }
    if (this.rom_start === this.rom_end) return;

    const asmOutDir = P(opts.nonmatchings_path, this.dir);
    const matchingAsmOutDir = P(opts.matchings_path, this.dir);
    this.print_file_boundaries();

    const S = spim();
    let rodataSectionType = '';
    let rodataSpimSegment = null;
    if (opts.migrate_rodata_to_functions) {
      for (const sect of ['.rodata', '.rdata']) {
        const rs = this.siblings.get(sect);
        if (!rs) continue;
        if (rs.is_generated) continue;
        if (!rs.type.startsWith('.')) {
          log.write(`\nProblem detected with the \`${rs.type}\` section of the \`${rs.name}\` file during rodata migration.`, { status: 'warn' });
          log.write(`\t The \`${rs.type}\` section was not prefixed with a dot, which is required for the rodata migration feature to work properly and avoid build errors due to duplicated symbols at link-time.`);
          log.error(`\t To fix this, please prefix the section type with a dot (like \`.${rs.type}\`).`);
        }
        rodataSectionType = rs.get_linker_section_linksection();
        rodataSpimSegment = rs.spim_section.get_section();
        break;
      }
    }

    const nameOf = (s) => (modern ? s.getNameUnquoted() : s.getName());

    const entries = S.mips.FunctionRodataEntry.getAllEntriesFromSections(this.spim_section.get_section(), rodataSpimSegment);

    let isNewCFile = false;
    const cPath = this.out_path();
    if (cPath) {
      if (!exists(cPath) && opts.create_c_files) {
        this.create_c_file(asmOutDir, cPath, entries);
        isNewCFile = true;
      }
      this.create_asm_dependencies_file(cPath, asmOutDir, isNewCFile, entries);
    }

    for (const entry of entries) {
      entry.sectionText = this.get_linker_section_linksection();
      entry.sectionRodata = rodataSectionType;
      if (entry.function !== null && entry.function !== undefined) {
        const fname = nameOf(entry.function);
        if (this.global_asm_funcs.has(fname) || isNewCFile || opts.disassemble_all) {
          const funcSym = this.get_symbol(entry.function.vram, { in_segment: true, type: 'func', local_only: true });
          if (!funcSym) throw new Error('AssertionError');
          if (!this.global_asm_funcs.has(fname) && opts.disassemble_all && !isNewCFile) {
            this.create_c_asm_file(entry, matchingAsmOutDir, funcSym);
          } else {
            this.create_c_asm_file(entry, asmOutDir, funcSym);
          }
        }
      } else {
        for (const rsym of entry.rodataSyms) {
          if (this.global_asm_rodata_syms.has(nameOf(rsym)) || isNewCFile || opts.disassemble_all) {
            const rodataSym = this.get_symbol(rsym.vram, { in_segment: true, local_only: true });
            if (!rodataSym) throw new Error('AssertionError');
            this.create_unmigrated_rodata_file(rsym, asmOutDir, rodataSym);
          }
        }
      }
    }

    if (opts.make_full_disasm_for_code) {
      const section = this.spim_section.get_section();
      const oldValue = section.getGpRelHack();
      section.setGpRelHack(false);
      const TV = modern && opts.platform === 'ps2' ? rabbitizer().TrinaryValue : null;
      if (TV) for (const func of section.symbolList) for (const inst of func.instructions) inst.flag_r5900UseDollar = TV.TRUE;
      this.split_as_asmtu_file(this.asm_out_path());
      if (TV) for (const func of section.symbolList) for (const inst of func.instructions) inst.flag_r5900UseDollar = TV.FALSE;
      section.setGpRelHack(oldValue);
    }
  }

  get_c_preamble() { return [opts.generated_c_preamble, '']; }

  check_gaps_in_migrated_rodata(func, rodataList) {
    const modern = atLeast('0.35.0');
    const nameOf = (s) => (modern ? s.getNameUnquoted() : s.getName());
    for (let i = 0; i < rodataList.length - 1; i++) {
      const a = rodataList[i];
      const b = rodataList[i + 1];
      if (a.vramEnd !== b.vram) {
        log.write('\nA gap was detected in migrated rodata symbols!', { status: 'warn' });
        log.write(`\t In function '${nameOf(func)}' (0x${hex(func.vram, 8)}), gap detected between '${nameOf(a)}' (0x${hex(a.vram, 8)}) and '${nameOf(b)}' (0x${hex(b.vram, 8)})`);
        log.write(`\t The address of the missing rodata symbol is 0x${hex(a.vramEnd, 8)}`);
        log.write('\t Try to force the migration of that symbol with `force_migration:True` in the symbol_addrs.txt file; or avoid the migration of symbols around this address with `force_not_migration:True`');
      }
    }
  }

  create_c_asm_file(entry, outDir, funcSym) {
    const outpath = P(outDir, this.name, `${funcSym.filename}.s`);
    if (exists(outpath) && !funcSym.extract) return;
    mkdirp(parent(outpath));
    const f = new TextFile(outpath, '\n');
    if (opts.asm_inc_header) f.write(opts.asm_inc_header.split('\n').join(opts.c_newline));
    const R = rabbitizer();
    const named = R.config.regNames_namedRegisters;
    R.config.regNames_namedRegisters = opts.named_regs_for_c_funcs;
    try {
      entry.writeToFile(f);
    } finally {
      R.config.regNames_namedRegisters = named;
    }
    if (entry.function !== null && entry.function !== undefined) {
      this.check_gaps_in_migrated_rodata(entry.function, entry.rodataSyms);
      this.check_gaps_in_migrated_rodata(entry.function, entry.lateRodataSyms);
    }
    f.close();
    this.log(`Disassembled ${funcSym.filename} to ${outpath}`);
  }

  create_unmigrated_rodata_file(spimRodataSym, outDir, rodataSym) {
    const outpath = P(outDir, this.name, `${rodataSym.filename}.s`);
    if (exists(outpath) && !rodataSym.extract) return;
    mkdirp(parent(outpath));
    const f = new TextFile(outpath, '\n');
    const preamble = opts.generated_s_preamble;
    if (preamble) f.write(preamble + '\n');
    if (rodataSym.linker_section === null) throw new Error(`AssertionError: ${rodataSym.name}`);
    f.write(`.section ${rodataSym.linker_section}\n\n`);
    f.write(spimRodataSym.disassemble());
    f.close();
    this.log(`Disassembled ${rodataSym.filename} to ${outpath}`);
  }

  get_c_line_include_macro(sym, asmOutDir, macroName) {
    if (opts.compiler.name === 'IDO') {
      const asmOutpath = P(asmOutDir, this.name, `${sym.filename}.s`);
      const rel = relpath(asmOutpath, opts.base_path, rt.cwd);
      return `#pragma GLOBAL_ASM("${P(rel)}")`;
    }
    if (opts.use_legacy_include_asm) {
      const relDir = relativeTo(asmOutDir, opts.nonmatchings_path);
      return `${macroName}(const s32, "${P(relDir, this.name)}", ${sym.filename});`;
    }
    return `${macroName}("${P(asmOutDir, this.name)}", ${sym.filename});`;
  }

  get_c_lines_for_function(sym, spimSym, asmOutDir) {
    const lines = [];
    const modern = atLeast('0.35.0');
    const ins = spimSym.instructions;
    if (opts.auto_decompile_empty_functions && ins.length === 2 && ins[0].isReturn() && ins[1].isNop()) {
      lines.push(`void ${modern ? spimSym.getNameUnquoted() : spimSym.getName()}(void) {`);
      lines.push('}');
    } else {
      lines.push(this.get_c_line_include_macro(sym, asmOutDir, 'INCLUDE_ASM'));
    }
    lines.push('');
    return lines;
  }

  get_c_lines_for_rodata_sym(sym, asmOutDir) {
    return [this.get_c_line_include_macro(sym, asmOutDir, 'INCLUDE_RODATA'), ''];
  }

  create_c_file(asmOutDir, cPath, entries) {
    let lines = this.get_c_preamble();
    for (const entry of entries) {
      if (entry.function !== null && entry.function !== undefined) {
        const funcSym = this.get_symbol(entry.function.vram, { in_segment: true, type: 'func', local_only: true });
        lines = lines.concat(this.get_c_lines_for_function(funcSym, entry.function, asmOutDir));
      } else {
        for (const rsym of entry.rodataSyms) {
          const rodataSym = this.get_symbol(rsym.vram, { in_segment: true, local_only: true });
          lines = lines.concat(this.get_c_lines_for_rodata_sym(rodataSym, asmOutDir));
        }
      }
    }
    mkdirp(parent(cPath));
    writeText(cPath, lines.join('\n'), opts.c_newline);
    log.write(`Wrote ${this.name} to ${cPath}`);
  }

  create_asm_dependencies_file(cPath, asmOutDir, isNewCFile, entries) {
    if (!opts.create_asm_dependencies) return;
    if (this.global_asm_funcs.size + this.global_asm_rodata_syms.size === 0 && !isNewCFile) return;
    const modern = atLeast('0.35.0');
    const nameOf = (s) => (modern ? s.getNameUnquoted() : s.getName());
    const buildPath = opts.build_path;
    const depPath = P(buildPath, withSuffix(cPath, '.asmproc.d'));
    mkdirp(parent(depPath));
    const f = new TextFile(depPath, opts.c_newline);
    const oPath = opts.use_o_as_suffix
      ? P(buildPath, withSuffix(cPath, '.o'))
      : P(buildPath, withSuffix(cPath, suffix(cPath) + '.o'));
    f.write(`${oPath}:`);
    const dependList = [];
    for (const entry of entries) {
      if (entry.function !== null && entry.function !== undefined) {
        const funcName = nameOf(entry.function);
        if (this.global_asm_funcs.has(funcName) || isNewCFile) {
          const outpath = P(asmOutDir, this.name, funcName + '.s');
          mkdirp(parent(outpath));
          dependList.push(outpath);
          f.write(` \\\n    ${outpath}`);
        }
      } else {
        for (const rsym of entry.rodataSyms) {
          const rodataName = nameOf(rsym);
          if (this.global_asm_rodata_syms.has(rodataName) || isNewCFile) {
            const outpath = P(asmOutDir, this.name, rodataName + '.s');
            mkdirp(parent(outpath));
            dependList.push(outpath);
            f.write(` \\\n    ${outpath}`);
          }
        }
      }
    }
    f.write('\n');
    for (const d of dependList) f.write(`${d}:\n`);
    f.close();
  }
}

export class CommonSegCpp extends CommonSegC {
  constructor(...a) { super(...a); this.file_extension = 'cpp'; }
}

// ---------------------------------------------------------------- data / rodata / bss

export class CommonSegData extends CommonSegCodeSubsegment {
  constructor(...a) {
    super(...a);
    // CommonSegGroup.__init__ (next in the Python MRO) parses subsegments.
    this.subsegments = this.group_parse_subsegments(this.yaml);
  }

  get isGroup() { return true; }
  static is_data() { return true; }

  asm_out_path() {
    let typ = this.type;
    if (typ.startsWith('.')) typ = typ.slice(1);
    return P(opts.data_path, this.dir, `${this.name}.${typ}.s`);
  }

  out_path() {
    if (this.type.startsWith('.')) {
      if (this.sibling) return this.sibling.out_path();
      return P(opts.src_path, this.dir, `${this.name}.c`);
    }
    return this.asm_out_path();
  }

  scan(romBytes) {
    this.group_scan(romBytes);
    if (this.rom_start !== null && this.rom_end !== null) this.disassemble_data(romBytes);
  }

  get_asm_file_extra_directives() { return []; }

  split(romBytes) {
    this.group_split(romBytes);
    if (this.spim_section === null || !this.should_self_split()) return;
    this.split_as_asm_file(this.asm_out_path());
  }

  should_self_split() {
    return opts.is_mode_active('data') && (!this.type.startsWith('.') || opts.disassemble_all);
  }

  should_scan() { return true; }
  should_split() { return true; }
  cache() { return [Segment.prototype.cache.call(this), this.group_cache()]; }
  get_linker_section() { return '.data'; }
  get_section_flags() { return 'wa'; }
  get_linker_entries() { return Segment.prototype.get_linker_entries.call(this); }
  get statistics() { return this.group_statistics(); }

  configure_disassembler_section(ds) {
    const section = ds.get_section();
    if (opts.data_string_encoding !== null) section.stringEncoding = opts.data_string_encoding;
    if (this.str_encoding !== null) section.stringEncoding = this.str_encoding;
  }

  check_disasm_preconditions() {
    if (!Number.isInteger(this.rom_start)) {
      log.error(`Segment '${this.name}' (type '${this.type}') requires a rom_start. Got '${this.rom_start === null ? 'None' : this.rom_start}'`);
    }
    if (!Number.isInteger(this.rom_end)) throw new Error(`AssertionError: ${this.rom_end}`);
    const segmentRomStart = this.get_most_parent().rom_start;
    if (!Number.isInteger(segmentRomStart)) throw new Error(`AssertionError: ${segmentRomStart}`);
    if (!Number.isInteger(this.vram_start)) {
      log.error(`Segment '${this.name}' (type '${this.type}') requires a vram address. Got '${this.vram_start === null ? 'None' : this.vram_start}'`);
    }
    return segmentRomStart;
  }

  disassemble_data(romBytes) {
    if (this.is_auto_segment) return;
    const segmentRomStart = this.check_disasm_preconditions();
    this.spim_section = makeDataSection(this.rom_start, this.rom_end, this.vram_start, this.name, romBytes,
      segmentRomStart, this.get_exclusive_ram_id());
    this.configure_disassembler_section(this.spim_section);
    this.spim_section.analyze();
    this.spim_section.set_comment_offset(this.rom_start);

    let rodataEncountered = false;
    const section = this.spim_section.get_section();
    for (const symbol of section.symbolList) {
      symbols.createSymbolFromSpimSymbol(this.get_most_parent(), symbol.contextSym, true);
      for (const referencedVram of symbol.referencedVrams) {
        const cs = section.getSymbol(referencedVram, undefined, false);
        if (cs !== null && cs !== undefined) symbols.createSymbolFromSpimSymbol(this.get_most_parent(), cs, false);
      }
      if (this.suggestion_rodata_section_start && !rodataEncountered && this.get_most_parent().rodata_follows_data) {
        if (symbol.contextSym.isJumpTable()) {
          rodataEncountered = true;
          print(`\n\nData segment ${this.name}, symbol at vram ${hex(symbol.contextSym.vram)} is a jumptable, indicating the start of the rodata section _may_ be near here.`);
          print('Please note the real start of the rodata section may be way before this point.');
          if (symbol.contextSym.vromAddress !== null) print(`      - [0x${hex(symbol.contextSym.vromAddress)}, rodata]`);
        }
      }
    }
  }
}
Object.assign(CommonSegData.prototype, {
  get_next_seg_start: GroupMixin.get_next_seg_start,
  group_parse_subsegments: GroupMixin.group_parse_subsegments,
  group_statistics: GroupMixin.group_statistics,
  group_scan: GroupMixin.group_scan,
  group_split: GroupMixin.group_split,
  group_cache: GroupMixin.group_cache,
  get_subsegment_for_ram: GroupMixin.get_subsegment_for_ram,
  get_next_subsegment_for_ram: GroupMixin.get_next_subsegment_for_ram,
  pair_subsegments_to_other_segment: GroupMixin.pair_subsegments_to_other_segment,
});

export class CommonSegRodata extends CommonSegData {
  get_linker_section() { return '.rodata'; }
  get_section_flags() { return 'a'; }
  static is_data() { return false; }
  static is_rodata() { return true; }

  get_possible_text_subsegment_for_symbol(rodataSym) {
    if (this.sibling !== null || !opts.pair_rodata_to_text) return null;
    if (!rodataSym.shouldMigrate()) return null;
    const refs = rodataSym.contextSym.referenceFunctions;
    const list = refs instanceof Set ? [...refs] : [...refs];
    if (list.length !== 1) return null;
    const func = list[0];
    const textSegment = this.parent.get_subsegment_for_ram(func.vram);
    if (textSegment === null || !textSegment.is_text()) return null;
    return [textSegment, func];
  }

  configure_disassembler_section(ds) {
    const section = ds.get_section();
    if (opts.string_encoding !== null) section.stringEncoding = opts.string_encoding;
    if (this.str_encoding !== null) section.stringEncoding = this.str_encoding;
  }

  disassemble_data(romBytes) {
    if (this.is_auto_segment) return;
    const segmentRomStart = this.check_disasm_preconditions();
    this.spim_section = makeRodataSection(this.rom_start, this.rom_end, this.vram_start, this.name, romBytes,
      segmentRomStart, this.get_exclusive_ram_id());
    this.configure_disassembler_section(this.spim_section);
    this.spim_section.analyze();
    this.spim_section.set_comment_offset(this.rom_start);

    const modern = atLeast('0.35.0');
    const nameOf = (s) => (modern ? s.getNameUnquoted() : s.getName());
    const possibleTextSegments = new Set();
    let lastJumptableAddrRemainder = 0;
    const misaligned = [];
    const section = this.spim_section.get_section();
    for (const symbol of section.symbolList) {
      const generated = symbols.createSymbolFromSpimSymbol(this.get_most_parent(), symbol.contextSym, true);
      generated.linker_section = this.get_linker_section_linksection();
      for (const referencedVram of symbol.referencedVrams) {
        const cs = section.getSymbol(referencedVram, undefined, false);
        if (cs !== null && cs !== undefined) symbols.createSymbolFromSpimSymbol(this.get_most_parent(), cs, false);
      }
      const possible = this.get_possible_text_subsegment_for_symbol(symbol);
      if (possible !== null) {
        const [textSegment, refFunc] = possible;
        if (!possibleTextSegments.has(textSegment)) {
          print(`\nRodata segment '${this.name}' may belong to the text segment '${textSegment.name}'`);
          print(`    Based on the usage from the function ${nameOf(refFunc)} to the symbol ${nameOf(symbol)}`);
          possibleTextSegments.add(textSegment);
        }
      }
      if (opts.platform === 'psx' || opts.platform === 'ps2') {
        if (generated.type === 'jtbl') {
          const vramDiff = generated.vram_start - this.vram_start;
          const rem = ((vramDiff % 8) + 8) % 8;
          if (rem !== lastJumptableAddrRemainder) {
            lastJumptableAddrRemainder = rem;
            misaligned.push(this.rom_start + vramDiff);
          }
        }
      }
    }
    if (misaligned.length > 0) {
      print(`\nThe rodata segment '${this.name}' has jumptables that are not aligned properly file-wise, indicating one or more likely file split.`);
      print('File split suggestions for this segment will follow in config yaml format:');
      for (const off of misaligned) print(`      - [0x${hex(off)}, ${this.type}]`);
      print();
    }
  }
}

export class CommonSegRdata extends CommonSegRodata {
  get_linker_section() { return '.rdata'; }
}

export class CommonSegSdata extends CommonSegData {
  get_linker_section() { return '.sdata'; }
}

export class CommonSegBss extends CommonSegData {
  get isBss() { return true; }
  get_linker_section() { return '.bss'; }
  get_section_flags() { return 'wa'; }
  static is_data() { return !opts.ld_bss_is_noload; }
  static is_noload() { return !!opts.ld_bss_is_noload; }

  configure_disassembler_section() {}

  disassemble_data(romBytes) {
    if (!opts.ld_bss_is_noload) { super.disassemble_data(romBytes); return; }
    if (this.is_auto_segment) return;
    const segmentRomStart = this.check_disasm_preconditions();
    const next = this.parent.get_next_subsegment_for_ram(this.vram_start, this.index_within_group);
    const bssEnd = next === null ? this.get_most_parent().vram_end : next.vram_start;
    if (!Number.isInteger(bssEnd)) throw new Error(`AssertionError: ${this.name} ${bssEnd}`);
    this.spim_section = makeBssSection(this.rom_start, this.rom_end, this.vram_start, bssEnd, this.name,
      segmentRomStart, this.get_exclusive_ram_id());
    this.configure_disassembler_section(this.spim_section);
    this.spim_section.analyze();
    this.spim_section.set_comment_offset(this.rom_start);
    for (const s of this.spim_section.get_section().symbolList) {
      symbols.createSymbolFromSpimSymbol(this.get_most_parent(), s.contextSym, true);
    }
  }

  should_scan() {
    if (!opts.ld_bss_is_noload) return super.should_scan();
    return opts.is_mode_active('code') && this.vram_start !== null;
  }
}

export class CommonSegSbss extends CommonSegBss {
  get_linker_section() { return '.sbss'; }
}

// ---------------------------------------------------------------- bin family

export class CommonSegBin extends CommonSegment {
  static is_data() { return true; }
  out_path() { return P(opts.asset_path, this.dir, `${this.name}.bin`); }

  split(romBytes) {
    const path = this.out_path();
    mkdirp(parent(path));
    if (this.rom_end === null) log.error(`segment ${this.name} needs to know where it ends; add a position marker [0xDEADBEEF] after it`);
    if (this.size === null || this.size <= 0) log.error(`Segment ${this.name} has zero size.`);
    writeBytes(path, romBytes.subarray(this.rom_start, this.rom_end));
    this.log(`Wrote ${this.name} to ${path}`);
  }

  get statistics_type() { return this.is_name_default() ? 'unk' : this.type; }
}

const REGEX_SYM_NAME_NORMALIZER = /[^0-9a-zA-Z_]/g;

export class CommonSegTextbin extends CommonSegment {
  constructor(...a) {
    super(...a);
    this.use_src_path = isDict(this.yaml) ? get(this.yaml, 'use_src_path', false) : false;
  }

  static is_text() { return true; }
  get_linker_section() { return '.text'; }
  get_section_flags() { return 'ax'; }

  out_path() {
    if (truthy(this.use_src_path)) return P(opts.src_path, this.dir, `${this.name}.s`);
    return P(opts.data_path, this.dir, `${this.name}.s`);
  }

  bin_path() {
    let typ = this.type;
    if (typ.startsWith('.')) typ = typ.slice(1);
    return P(opts.asset_path, this.dir, `${this.name}.${typ}.bin`);
  }

  write_bin(romBytes) {
    const binpath = this.bin_path();
    mkdirp(parent(binpath));
    writeBytes(binpath, romBytes.subarray(this.rom_start, this.rom_end));
    this.log(`Wrote ${this.name} to ${binpath}`);
  }

  write_asm_contents(romBytes, f) {
    if (!atLeast('0.35.0')) { this.write_asm_contents_0_34(romBytes, f); return; }
    const binpath = this.bin_path();
    let asmLabel = opts.asm_function_macro;
    if (!this.is_text()) asmLabel = opts.asm_data_macro;

    f.write(`${this.get_section_asm_line()}\n\n`);
    let symName = null; let symNameEnd = null; let symSizeMatches = null;
    const vram = this.rom_to_ram(this.rom_start);
    if (vram !== null) {
      const sym = this.get_symbol(vram, { in_segment: true });
      if (sym !== null) {
        sym.defined = true;
        symName = sym.name;
        symNameEnd = sym.given_name_end;
        if (sym.given_size === null || sym.given_size === this.rom_end - this.rom_start) symSizeMatches = this.rom_end - this.rom_start;
      }
    }
    if (symName === null) {
      const n = this.name.replace(REGEX_SYM_NAME_NORMALIZER, '_');
      let sfx;
      if (this.is_text()) sfx = 'textbin';
      else if (this.is_data()) sfx = 'databin';
      else if (this.is_rodata()) sfx = 'rodatabin';
      else sfx = 'incbin';
      symName = `__${n}_${sfx}`;
    }
    if (opts.asm_nonmatching_label_macro !== '') {
      const siz = symSizeMatches !== null ? `, 0x${hex(symSizeMatches)}` : '';
      f.write(`${opts.asm_nonmatching_label_macro} ${symName}${siz}\n\n`);
    }
    f.write(`${asmLabel} ${symName}\n`);
    if (asmLabel === '.globl') {
      if (this.is_text()) f.write(`.ent ${symName}\n`);
      f.write(`${symName}:\n`);
    }
    f.write(`.incbin "${binpath}"\n`);
    if (opts.asm_emit_size_directive) f.write(`.size ${symName}, . - ${symName}\n`);
    if (this.is_text() && opts.asm_end_label !== '') f.write(`${opts.asm_end_label} ${symName}\n`);
    else if (opts.asm_data_end_label !== '') f.write(`${opts.asm_data_end_label} ${symName}\n`);
    if (symNameEnd !== null && symSizeMatches !== null) {
      f.write(`${asmLabel} ${symNameEnd}\n`);
      if (asmLabel === '.globl') f.write(`${symNameEnd}:\n`);
      if (this.is_text() && opts.asm_end_label !== '') f.write(`${opts.asm_end_label} ${symNameEnd}\n`);
      else if (opts.asm_data_end_label !== '') f.write(`${opts.asm_data_end_label} ${symNameEnd}\n`);
    }
  }

  write_asm_contents_0_34(romBytes, f) {
    const binpath = this.bin_path();
    let asmLabel = opts.asm_function_macro;
    if (!this.is_text()) asmLabel = opts.asm_data_macro;
    f.write(`${this.get_section_asm_line()}\n\n`);
    let sym = null;
    const vram = this.rom_to_ram(this.rom_start);
    if (vram !== null) sym = this.get_symbol(vram, { in_segment: true });
    if (sym !== null) {
      f.write(`${asmLabel} ${sym.name}\n`);
      if (asmLabel === '.globl') {
        if (this.is_text()) f.write(`.ent ${sym.name}\n`);
        f.write(`${sym.name}:\n`);
      }
      sym.defined = true;
    }
    f.write(`.incbin "${binpath}"\n`);
    if (sym !== null) {
      if (this.is_text() && opts.asm_end_label !== '') f.write(`${opts.asm_end_label} ${sym.name}\n`);
      if (sym.given_name_end !== null) {
        if (sym.given_size === null || sym.given_size === this.rom_end - this.rom_start) {
          f.write(`${asmLabel} ${sym.given_name_end}\n`);
          if (asmLabel === '.globl') f.write(`${sym.given_name_end}:\n`);
        }
      }
    }
  }

  split(romBytes) {
    if (this.rom_end === null) log.error(`segment ${this.name} needs to know where it ends; add a position marker [0xDEADBEEF] after it`);
    this.write_bin(romBytes);
    const sPath = this.out_path();
    if (exists(sPath)) return;
    mkdirp(parent(sPath));
    const f = new TextFile(sPath, null);
    f.write('.include "macro.inc"\n\n');
    const preamble = opts.generated_s_preamble;
    if (preamble) f.write(preamble + '\n');
    this.write_asm_contents(romBytes, f);
    for (const sect of this.section_order) {
      if (sect === this.get_linker_section_linksection()) continue;
      const sibling = this.siblings.get(sect);
      if (!sibling) continue;
      if (sibling instanceof CommonSegTextbin) {
        f.write('\n');
        sibling.write_asm_contents(romBytes, f);
      }
    }
    f.close();
  }

  should_scan() { return this.rom_start !== null && this.rom_end !== null; }
  should_split() { return this.extract && this.should_scan(); }
}

function incbinSplit(self, romBytes) {
  if (self.rom_end === null) log.error(`segment ${self.name} needs to know where it ends; add a position marker [0xDEADBEEF] after it`);
  self.write_bin(romBytes);
  if (self.sibling === null) {
    const sPath = self.out_path();
    mkdirp(parent(sPath));
    const f = new TextFile(sPath, null);
    f.write('.include "macro.inc"\n\n');
    const preamble = opts.generated_s_preamble;
    if (preamble) f.write(preamble + '\n');
    self.write_asm_contents(romBytes, f);
    f.close();
  }
}

export class CommonSegDatabin extends CommonSegTextbin {
  static is_text() { return false; }
  static is_data() { return true; }
  get_linker_section() { return '.data'; }
  get_section_flags() { return 'wa'; }
  split(romBytes) { incbinSplit(this, romBytes); }
}

export class CommonSegRodatabin extends CommonSegTextbin {
  static is_text() { return false; }
  static is_rodata() { return true; }
  get_linker_section() { return '.rodata'; }
  get_section_flags() { return 'a'; }
  split(romBytes) { incbinSplit(this, romBytes); }
}

// ---------------------------------------------------------------- header / lib / pad / linker_offset

export class CommonSegHeader extends CommonSegment {
  static is_data() { return true; }
  should_split() { return this.extract && opts.is_mode_active('code'); }

  static get_line(typ, data, comment) {
    let dstr;
    if (typ === 'ascii') {
      // bytes.decode("ASCII").strip()
      for (const b of data) if (b > 0x7f) throw new Error("UnicodeDecodeError: 'ascii' codec can't decode byte");
      let text = Buffer.from(data).toString('latin1').replace(/^[\s\x1c-\x1f]+|[\s\x1c-\x1f]+$/g, '');
      text = text.replaceAll('\x00', '\\0');
      dstr = '"' + text + '"';
    } else {
      dstr = '0x' + Buffer.from(data).toString('hex').toUpperCase();
    }
    dstr = ljust(dstr, 20 - typ.length);
    return `.${typ} ${dstr} /* ${comment} */`;
  }

  get_line(typ, data, comment) { return this.constructor.get_line(typ, data, comment); }

  out_path() { return P(opts.asm_path, this.dir, `${this.name}.s`); }
  parse_header() { return []; }

  split(romBytes) {
    const lines = this.parse_header(romBytes);
    const srcPath = this.out_path();
    mkdirp(parent(srcPath));
    writeText(srcPath, lines.join('\n'), '\n');
    this.log(`Wrote ${this.name} to ${srcPath}`);
  }

  static get_default_name() { return 'header'; }
}

export class LinkerEntryLib extends LinkerEntry {
  constructor(segment, srcPaths, objectPath, sectionOrder, sectionLink, noload) {
    super(segment, srcPaths, objectPath, sectionOrder, sectionLink, noload);
    this.object_path = objectPath;
  }
  emit_entry(w) { this.emit_path(w); }
}

export class CommonSegLib extends CommonSegment {
  constructor(...a) {
    super(...a);
    const vram = parseSegmentVram(this.yaml);
    if (vram !== null) this.vram_start = vram;
    if (isDict(this.yaml)) {
      this.object = get(this.yaml, 'object', null);
      this.section = get(this.yaml, 'section', '.text');
      if (this.object === null) log.error(`Error: ${this.name} is missing object file`);
    } else {
      if (this.args.length < 1) log.error(`Error: ${this.name} is missing object file`);
      if (this.args.length > 1) [this.object, this.section] = [this.args[0], this.args[1]];
      else [this.object, this.section] = [this.args[0], '.text'];
    }
    this.extract = false;
  }

  get_linker_section() { return this.section; }

  get_linker_entries() {
    const path = P(opts.lib_path, this.name);
    const objectPath = P(`${path}.a:${this.object}.o`);
    return [new LinkerEntryLib(this, [path], objectPath, this.get_linker_section_order(),
      this.get_linker_section_linksection(), this.is_noload())];
  }
}

export class LinkerEntryPad extends LinkerEntry {
  constructor(segment) {
    super(segment, [], '.', 'pad', 'pad', false);
    this.object_path = null;
  }
  emit_entry(w) { w._writeln(`. += 0x${hex(this.segment.size)};`); }
}

export class CommonSegPad extends CommonSegment {
  get_linker_section_order() { return ''; }
  get_linker_section_linksection() { return ''; }
  get_linker_entries() { return [new LinkerEntryPad(this)]; }
}

export class LinkerEntryOffset extends LinkerEntry {
  constructor(segment) {
    super(segment, [], '.', 'linker_offset', 'linker_offset', false);
    this.object_path = null;
  }
  emit_entry(w) { w._write_symbol(`${this.segment.get_cname()}_OFFSET`, '.'); }
}

export class CommonSegLinker_offset extends Segment {
  get_linker_section_order() { return ''; }
  get_linker_section_linksection() { return ''; }
  get_linker_entries() { return [new LinkerEntryOffset(this)]; }
}

export { LinkerWriter, pathName, readText };

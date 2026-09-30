// splat.scripts.split
import crypto from 'node:crypto';
import { rt, atLeast, readBytes, mkdirp, writeText, TextFile, exists, abs } from './runtime.js';
import * as log from './util/log.js';
import * as conf from './util/conf.js';
import * as options from './util/options.js';
import * as symbols from './util/symbols.js';
import * as relocs from './util/relocs.js';
import * as palettes from './util/palettes.js';
import * as vramClasses from './util/vram_classes.js';
import * as filePresets from './util/file_presets.js';
import { Statistics } from './util/statistics.js';
import { Cache } from './util/cache.js';
import { IntervalTree } from './util/intervaltree.js';
import { P, parent, withSuffix } from './util/pypath.js';
import { hex, pyStr } from './util/pyfmt.js';
import { Segment } from './segtypes/segment.js';
import { LinkerWriter, getSegmentVramEndSymbolName, resetCleanUpCache } from './segtypes/linker_entry.js';
import { CommonSegCode } from './segtypes/common.js';
import * as disassemblerInstance from './disassembler/disassembler_instance.js';
import { spim } from './disassembler/spim.js';
import './segtypes/index.js';

const S = { segmentRoms: new IntervalTree(), segmentRams: new IntervalTree(), config: null };

export function initializeSegments(configSegments) {
  S.segmentRoms = new IntervalTree();
  S.segmentRams = new IntervalTree();
  const segmentsByName = new Map();
  const ret = [];
  let doCrossSegmentPairing = false;
  let lastRomEnd = 0;

  for (let i = 0; i < configSegments.length; i++) {
    const segYaml = configSegments[i];
    if (Array.isArray(segYaml) && segYaml.length === 1) continue;

    const segType = Segment.parse_segment_type(segYaml);
    const segmentClass = Segment.get_class_for_type(segType);
    let [thisStart] = Segment.parse_segment_start(segYaml);

    let nextStart = null;
    for (let j = i + 1; j < configSegments.length; j++) {
      [nextStart] = Segment.parse_segment_start(configSegments[j]);
      if (nextStart !== null) break;
    }
    if (nextStart === null) {
      log.error('Next segment address could not be found. Segments list must end with a rom end pos marker ([0x10000000])');
    }

    if (segmentClass.is_noload()) {
      thisStart = lastRomEnd;
      nextStart = lastRomEnd;
    }

    const segment = Segment.from_yaml(segmentClass, segYaml, thisStart, nextStart, null);

    if (segment.constructor.require_unique_name) {
      if (segmentsByName.has(segment.name)) log.error(`segment name '${segment.name}' is not unique`);
      segmentsByName.set(segment.name, segment);
    }
    if (segment.pair_segment_name !== null) doCrossSegmentPairing = true;

    ret.push(segment);
    if (Number.isInteger(segment.rom_start) && Number.isInteger(segment.rom_end) && segment.rom_start !== segment.rom_end) {
      S.segmentRoms.addi(segment.rom_start, segment.rom_end, segment);
    }
    const ve = segment.vram_end;
    if (Number.isInteger(segment.vram_start) && Number.isInteger(ve) && segment.vram_start !== ve) {
      S.segmentRams.addi(segment.vram_start, ve, segment);
    }
    if (nextStart !== null) lastRomEnd = nextStart;
  }

  for (const segment of ret) {
    if (segment.given_follows_vram) {
      if (!segmentsByName.has(segment.given_follows_vram)) {
        log.error(`segment '${segment.given_follows_vram}', the 'follows_vram' value for segment '${segment.name}', does not exist`);
      }
      segment.given_vram_symbol = getSegmentVramEndSymbolName(segmentsByName.get(segment.given_follows_vram));
    }
  }

  if (ret[ret.length - 1].type === 'pad') {
    log.error('Last segment in config cannot be a pad segment; see https://github.com/ethteck/splat/wiki/Segments#pad');
  }

  if (doCrossSegmentPairing) {
    for (const seg of ret) {
      if (seg.pair_segment_name === null) continue;
      let found = false;
      for (const other of ret) {
        if (seg === other) continue;
        if (seg.pair_segment_name === other.name && other.isGroup) {
          if (other.pair_segment_name !== null) {
            log.error(`Both segments '${seg.name}' and '${other.name}' have a \`pair_segment\` value, when only at most one of the cross-paired segments can have this attribute.`);
          }
          found = true;
          seg.paired_segment = other;
          other.paired_segment = seg;
          if (seg.isGroup && other.isGroup) seg.pair_subsegments_to_other_segment(other);
          break;
        }
      }
      if (!found) {
        log.error(`Segment '${seg.pair_segment_name}' not found.\n    It is referenced by segment '${seg.name}', because of the \`pair_segment\` attribute.`);
      }
    }
  }
  return ret;
}

function assignSymbolsToSegments() {
  for (const symbol of symbols.state.all_symbols) {
    if (symbol.segment) continue;
    if (symbol.rom) {
      const cands = S.segmentRoms.at(symbol.rom);
      if (cands.length > 1) log.error(`multiple segments rom overlap symbol ${symbol}`);
      else if (cands.length === 0) log.error(`no segment rom overlaps symbol ${symbol}`);
      else cands[0].data.add_symbol(symbol);
    } else {
      for (const cand of S.segmentRams.at(symbol.vram_start)) {
        const seg = cand.data;
        if (!seg.get_exclusive_ram_id()) seg.add_symbol(symbol);
      }
    }
  }
}

function calcSegmentDependences(allSegments) {
  const vramClassToSegments = new Map();
  for (const seg of allSegments) {
    if (seg.vram_class !== null) {
      if (!vramClassToSegments.has(seg.vram_class.name)) vramClassToSegments.set(seg.vram_class.name, []);
      vramClassToSegments.get(seg.vram_class.name).push(seg);
    }
  }
  const out = new Map();
  for (const vc of vramClasses.state.vramClasses.values()) {
    if (vc.follows_classes.length) {
      out.set(vc, []);
      for (const fc of vc.follows_classes) {
        if (vramClassToSegments.has(fc)) out.get(vc).push(...vramClassToSegments.get(fc));
      }
    }
  }
  return out;
}

function readTargetBinary() {
  const romBytes = readBytes(options.opts.target_path);
  const config = S.config;
  if ('sha1' in config) {
    const sha1 = crypto.createHash('sha1').update(romBytes).digest('hex');
    const expected = String(config.sha1).toLowerCase();
    if (expected !== sha1) log.error(`sha1 mismatch: expected ${expected}, was ${sha1}`);
  } else {
    log.write('Warning: no sha1 in config');
  }
  return romBytes;
}

function initializePlatform() {
  const o = options.opts;
  if (o.platform === 'n64') {
    const ctx = symbols.state.spim_context;
    ctx.fillDefaultBannedSymbols();
    if (o.libultra_symbols) ctx.globalSegment.fillLibultraSymbols();
    if (o.ique_symbols) ctx.globalSegment.fillIQueSymbols();
    if (o.hardware_regs) ctx.globalSegment.fillHardwareRegs(true);
  } else if (o.platform === 'psx') {
    // nothing
  } else if (o.platform === 'ps2') {
    throw new Error('romdev-splat: the ps2 platform is not ported');
  } else if (o.platform === 'psp') {
    throw new Error('romdev-splat: the psp platform is not ported');
  }
}

function initializeAllSymbols(allSegments) {
  symbols.initialize(allSegments);
  relocs.initialize();
  assignSymbolsToSegments();
  if (options.opts.is_mode_active('code')) {
    symbols.initializeSpimContext(allSegments, CommonSegCode);
    relocs.initializeSpimContext();
  }
}

function doScan(allSegments, romBytes, stats, cache) {
  const processed = [];
  for (const segment of allSegments) {
    for (const [ty, sub] of segment.statistics) stats.add_size(ty, sub.size);
    if (segment.should_scan()) {
      if (cache.check_cache_hit(segment, false)) continue;
      segment.did_run = true;
      segment.scan(romBytes);
      processed.push(segment);
      for (const [ty, sub] of segment.statistics) stats.count_split(ty, sub.count);
    }
  }
  symbols.markCFuncsAsDefined();
  return processed;
}

function doSplit(allSegments, romBytes, stats, cache) {
  for (const segment of allSegments) {
    if (cache.check_cache_hit(segment, true)) {
      for (const [ty, sub] of segment.statistics) stats.count_cached(ty, sub.count);
      continue;
    }
    if (segment.should_split()) {
      let segmentBytes = romBytes;
      if (segment.file_path) segmentBytes = readBytes(segment.file_path);
      segment.split(segmentBytes);
    }
  }
}

function writeLinkerScript(allSegments) {
  const o = options.opts;
  const deps = calcSegmentDependences(allSegments);
  const toSearch = new Set(deps.keys());
  const maxVramEndInsertionPoints = new Map();
  for (let i = allSegments.length - 1; i >= 0; i--) {
    const seg = allSegments[i];
    if (seg.vram_class !== null && toSearch.has(seg.vram_class)) {
      if (!maxVramEndInsertionPoints.has(seg)) maxVramEndInsertionPoints.set(seg, []);
      maxVramEndInsertionPoints.get(seg).push([seg.vram_class.vram_symbol, deps.get(seg.vram_class)]);
      toSearch.delete(seg.vram_class);
    }
  }

  const linkerWriter = new LinkerWriter();
  const partialScriptsPath = o.ld_partial_scripts_path;
  const segmentsPath = o.ld_partial_build_segments_path;
  if (o.ld_partial_linking) {
    if (partialScriptsPath === null) log.error('Partial linking is enabled but `ld_partial_scripts_path` has not been set');
    if (segmentsPath === null) log.error('Partial linking is enabled but `ld_partial_build_segments_path` has not been set');
  }

  for (const segment of allSegments) {
    const maxVramSyms = maxVramEndInsertionPoints.get(segment) || [];
    if (o.ld_partial_linking) {
      linkerWriter.add_referenced_partial_segment(segment, maxVramSyms);
      const sub = new LinkerWriter(true);
      sub.add_partial_segment(segment);
      const segName = segment.get_cname();
      sub.save_linker_script(P(partialScriptsPath, `${segName}.ld`));
      if (o.ld_dependencies) sub.save_dependencies_file(P(partialScriptsPath, `${segName}.d`), P(segmentsPath, `${segName}.o`));
    } else {
      linkerWriter.add(segment, maxVramSyms);
    }
  }

  linkerWriter.save_linker_script(o.ld_script_path);
  linkerWriter.save_symbol_header();
  writeLdDependencies(linkerWriter);
  return linkerWriter;
}

function writeLdDependencies(linkerWriter) {
  const o = options.opts;
  if (o.ld_dependencies) {
    if (o.elf_path === null) {
      log.error('Generation of dependency file for linker script requested but `elf_path` was not provided in the yaml options');
    }
    linkerWriter.save_dependencies_file(withSuffix(o.ld_script_path, '.d'), o.elf_path);
  }
}

function writeElfSectionsFile(allSegments) {
  const o = options.opts;
  if (o.elf_section_list_path) {
    let list = '';
    for (const segment of allSegments) list += '.' + segment.get_cname() + '\n';
    mkdirp(parent(o.elf_section_list_path));
    writeText(o.elf_section_list_path, list, '\n');
  }
}

function writeUndefinedAuto(toWrite, filePath) {
  mkdirp(parent(filePath));
  writeText(filePath, toWrite.map((s) => `${s.name} = 0x${hex(s.vram_start)};\n`).join(''), '\n');
}

/** list.sort(key=...) is stable; Array.prototype.sort is stable too. */
function sortByVram(list) { return list.sort((a, b) => a.vram_start - b.vram_start); }

function writeUndefinedFuncsAuto() {
  const o = options.opts;
  if (o.create_undefined_funcs_auto) {
    const toWrite = sortByVram(symbols.state.all_symbols.filter((s) => s.referenced && !s.defined && s.type === 'func'));
    writeUndefinedAuto(toWrite, o.undefined_funcs_auto_path);
  }
}

function writeUndefinedSymsAuto() {
  const o = options.opts;
  if (o.create_undefined_syms_auto) {
    const toWrite = sortByVram(symbols.state.all_symbols.filter((s) => s.referenced && !s.defined
      && !['func', 'label', 'jtbl_label'].includes(s.type)));
    writeUndefinedAuto(toWrite, o.undefined_syms_auto_path);
  }
}

function printSegmentWarnings(allSegments) {
  for (const segment of allSegments) {
    if (segment.warnings.length > 0) {
      log.write(`\x1b[2m0x${hex(segment.rom_start, 6)}\x1b[0m ${segment.type} \x1b[1m${segment.name}\x1b[0m:`);
      for (const w of segment.warnings) log.write('warning: ' + w, { status: 'warn' });
      log.write('');
    }
  }
}

function dumpSymbols() {
  const o = options.opts;
  if (!o.dump_symbols) return;
  const hidden = P(o.base_path, '.splat');
  mkdirp(hidden);
  const f = new TextFile(P(hidden, 'splat_symbols.csv'), null);
  f.write('vram_start,given_name,name,type,given_size,size,rom,defined,user_declared,referenced,extract\n');
  for (const s of sortByVram([...symbols.state.all_symbols])) {
    f.write(`${hex(s.vram_start)},${pyStr(s.given_name)},${s.name},${pyStr(s.type)},`);
    f.write(s.given_size !== null ? `0x${hex(s.given_size)},` : 'None,');
    f.write(`${s.size},`);
    f.write(s.rom !== null ? `0x${hex(s.rom)},` : 'None,');
    f.write(`${pyStr(s.defined)},${pyStr(s.user_declared)},${pyStr(s.referenced)},${pyStr(s.extract)}\n`);
  }
  f.close();
  symbols.state.spim_context.saveContextToFile(abs(P(hidden, 'spim_context.csv')));
}

export function splatVersionString() { return rt.version.join('.'); }

/** splat.scripts.split.main, synchronous once the backend is loaded. */
export function main(configPaths, modes, verbose, useCache = true, skipVersionCheck = false, stdoutOnly = false,
  disassembleAll = false, makeFullDisasmForCode = false, overrides = {}) {
  if (stdoutOnly) log.write('--stdout-only flag is deprecated', { status: 'warn' });

  resetCleanUpCache();
  disassemblerInstance.reset();
  symbols.resetSymbols();
  relocs.reset();

  S.config = conf.load(configPaths, modes, verbose, disassembleAll, makeFullDisasmForCode, overrides);
  const o = options.opts;

  disassemblerInstance.createDisassemblerInstance(skipVersionCheck, splatVersionString());

  const romBytes = readTargetBinary();
  mkdirp(o.base_path);

  const stats = new Statistics();
  const cache = new Cache(S.config, useCache, verbose);

  if (!o.is_unsupported_platform) initializePlatform();

  const allSegments = initializeSegments(S.config.segments);
  initializeAllSymbols(allSegments);

  if (o.is_mode_active('img')) palettes.initialize(allSegments);

  doScan(allSegments, romBytes, stats, cache);
  doSplit(allSegments, romBytes, stats, cache);

  if (o.is_mode_active('ld')) {
    const lw = writeLinkerScript(allSegments);
    writeLdDependencies(lw);
    writeElfSectionsFile(allSegments);
  }

  writeUndefinedFuncsAuto();
  writeUndefinedSymsAuto();
  printSegmentWarnings(allSegments);
  stats.print_statistics(romBytes.length);
  cache.save(verbose);

  if (o.is_mode_active('code')) {
    dumpSymbols();
    if (atLeast('0.35.0')) filePresets.writeAllFiles();
  }
  return { segments: allSegments, symbols: symbols.state.all_symbols, spim };
}

export { exists };

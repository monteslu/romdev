// splat.util.options: the yaml `options:` block, parsed and validated the way
// splat does (unknown keys are an error, types are checked, paths are
// normalised with os.path.normpath).
import { atLeast } from '../runtime.js';
import { P, normpath, parent } from './pypath.js';
import { compilers, forName } from './compiler.js';
import { isList, isPyInt, pyTypeName, isDict } from './pyfmt.js';
import { PyFloat } from './yaml11.js';

/** @type {any} */
export let opts = null;

const TYPES = {
  str: (v) => typeof v === 'string',
  bool: (v) => typeof v === 'boolean',
  int: (v) => isPyInt(v),
  list: (v) => isList(v),
  float: (v) => v instanceof PyFloat,
  object: () => true,
};

function typeErr(opt, t, v) {
  return new Error(`Expected ${opt} to have type <class '${t}'>, got <class '${pyTypeName(v)}'>`);
}

class OptParser {
  constructor(yaml) {
    this.yaml = yaml;
    this.read = new Set();
  }

  has(opt) { return Object.prototype.hasOwnProperty.call(this.yaml, opt); }

  parseOpt(opt, t, def = null) {
    if (!this.has(opt)) {
      if (def !== null && def !== undefined) return def;
      throw new Error(`Missing required option ${opt}`);
    }
    this.read.add(opt);
    const value = this.yaml[opt];
    if (TYPES[t](value)) return value;
    if (t === 'float' && isPyInt(value)) return new PyFloat(Number(value));
    throw typeErr(opt, t, value);
  }

  parseOptionalOpt(opt, t) {
    if (!this.has(opt)) return null;
    return this.parseOpt(opt, t);
  }

  parseOptionalOptWithDefault(opt, t, def) {
    if (!this.has(opt)) return def;
    this.read.add(opt);
    const value = this.yaml[opt];
    if (value === null || TYPES[t](value)) return value;
    if (t === 'float' && isPyInt(value)) return new PyFloat(Number(value));
    throw typeErr(opt, t, value);
  }

  parseOptWithin(opt, t, within, def = null) {
    const value = this.parseOpt(opt, t, def);
    if (!within.includes(value)) throw new Error(`Invalid value for ${opt}: ${value}`);
    return value;
  }

  parsePath(basePath, opt, def = null) {
    return normpath(P(basePath, this.parseOpt(opt, 'str', def)));
  }

  parseOptionalPath(basePath, opt) {
    if (!this.has(opt)) return null;
    return this.parsePath(basePath, opt);
  }

  parsePathList(basePath, opt, def) {
    const paths = this.parseOpt(opt, 'object', def);
    if (typeof paths === 'string') return [P(basePath, paths)];
    if (isList(paths)) return paths.map((p) => P(basePath, p));
    throw new Error(`Expected str or list for '${opt}', got <class '${pyTypeName(paths)}'>`);
  }

  checkNoUnreadOpts() {
    const unread = Object.keys(this.yaml).filter((o) => !this.read.has(o));
    if (unread.length) throw new Error(`Unrecognized YAML option(s): ${unread.join(', ')}`);
  }
}

function parseYaml(yaml, configPaths, modes, verbose, disasmAll, makeFullDisasmForCode, overrides) {
  if (!isDict(yaml)) throw new Error('options must be a mapping');
  const p = new OptParser(yaml);
  const modern = atLeast('0.35.0');

  const basename = p.parseOpt('basename', 'str');
  const isUnsupportedPlatform = p.parseOpt('is_unsupported_platform', 'bool', false);
  const platform = isUnsupportedPlatform
    ? p.parseOpt('platform', 'str')
    : p.parseOptWithin('platform', 'str', ['n64', 'psx', 'ps2', 'psp']);

  const table = compilers();
  const comp = forName(p.parseOpt('compiler', 'str', 'IDO'), table);

  let basePath = normpath(P(parent(configPaths[0]), p.parseOpt('base_path', 'str')));
  if (overrides.basePath != null) basePath = normpath(overrides.basePath);
  const asmPath = p.parsePath(basePath, 'asm_path', 'asm');

  let asmEmitSizeDirective = p.parseOptionalOpt('asm_emit_size_directive', 'bool');
  if (asmEmitSizeDirective === null) asmEmitSizeDirective = comp.asm_emit_size_directive;

  let alignOnBranchLabels = false;
  if (modern) {
    alignOnBranchLabels = p.parseOptionalOpt('align_on_branch_labels', 'bool');
    if (alignOnBranchLabels === null) alignOnBranchLabels = comp.align_on_branch_labels;
  }

  const endianness = p.parseOptWithin('endianness', 'str', ['big', 'little'],
    ['psx', 'ps2', 'psp'].includes(platform) ? 'little' : 'big');

  let includeAsmMacroStyle = 'default';
  if (modern) {
    includeAsmMacroStyle = p.parseOptWithin('include_asm_macro_style', 'str', ['default', 'maspsx_hack'], 'default');
  }

  const defaultLdBssIsNoload = platform !== 'psx';
  const defaultAddSetGp64 = !(platform === 'psx' || platform === 'ps2');

  const ret = {
    verbose,
    dump_symbols: p.parseOpt('dump_symbols', 'bool', false),
    modes,
    base_path: basePath,
    target_path: p.parsePath(basePath, 'target_path'),
    elf_path: p.parseOptionalPath(basePath, 'elf_path'),
    platform,
    is_unsupported_platform: isUnsupportedPlatform,
    allow_segment_overrides: p.parseOpt('allow_segment_overrides', 'bool', false),
    compiler: comp,
    compilers: table,
    endianness,
    section_order: p.parseOpt('section_order', 'list', ['.text', '.data', '.rodata', '.bss']),
    generated_c_preamble: p.parseOpt('generated_c_preamble', 'str', '#include "common.h"'),
    generated_s_preamble: p.parseOpt('generated_s_preamble', 'str', ''),
  };
  if (modern) {
    ret.generated_macro_inc_content = p.parseOptionalOpt('generated_macro_inc_content', 'str');
    ret.generate_asm_macros_files = p.parseOpt('generate_asm_macros_files', 'bool', true);
  } else {
    ret.generated_macro_inc_content = null;
    ret.generate_asm_macros_files = false;
  }
  ret.include_asm_macro_style = includeAsmMacroStyle;
  ret.generated_asm_macros_directory = modern ? p.parsePath(basePath, 'generated_asm_macros_directory', 'include') : P(basePath, 'include');
  Object.assign(ret, {
    use_o_as_suffix: p.parseOpt('o_as_suffix', 'bool', false),
    gp: p.parseOptionalOpt('gp_value', 'int'),
    check_consecutive_segment_types: p.parseOpt('check_consecutive_segment_types', 'bool', true),
    asset_path: p.parsePath(basePath, 'asset_path', 'assets'),
    symbol_addrs_paths: p.parsePathList(basePath, 'symbol_addrs_path', 'symbol_addrs.txt'),
    reloc_addrs_paths: p.parsePathList(basePath, 'reloc_addrs_path', 'reloc_addrs.txt'),
    build_path: p.parsePath(basePath, 'build_path', 'build'),
    src_path: p.parsePath(basePath, 'src_path', 'src'),
    asm_path: asmPath,
    data_path: p.parsePath(asmPath, 'data_path', 'data'),
    nonmatchings_path: p.parsePath(asmPath, 'nonmatchings_path', 'nonmatchings'),
    matchings_path: p.parsePath(asmPath, 'matchings_path', 'matchings'),
    cache_path: p.parsePath(basePath, 'cache_path', '.splache'),
    hasm_in_src_path: p.parseOpt('hasm_in_src_path', 'bool', false),
    create_undefined_funcs_auto: p.parseOpt('create_undefined_funcs_auto', 'bool', true),
    undefined_funcs_auto_path: p.parsePath(basePath, 'undefined_funcs_auto_path', 'undefined_funcs_auto.txt'),
    create_undefined_syms_auto: p.parseOpt('create_undefined_syms_auto', 'bool', true),
    undefined_syms_auto_path: p.parsePath(basePath, 'undefined_syms_auto_path', 'undefined_syms_auto.txt'),
    extensions_path: p.parseOptionalPath(basePath, 'extensions_path'),
    lib_path: p.parsePath(basePath, 'lib_path', 'lib'),
    elf_section_list_path: p.parseOptionalPath(basePath, 'elf_section_list_path'),
    subalign: p.parseOptionalOptWithDefault('subalign', 'int', 16),
    emit_subalign: p.parseOpt('emit_subalign', 'bool', true),
    auto_link_sections: p.parseOpt('auto_link_sections', 'list', ['.data', '.rodata', '.bss']),
    ld_script_path: p.parsePath(basePath, 'ld_script_path', `${basename}.ld`),
    ld_symbol_header_path: p.parseOptionalPath(basePath, 'ld_symbol_header_path'),
    ld_discard_section: p.parseOpt('ld_discard_section', 'bool', true),
    ld_sections_allowlist: p.parseOpt('ld_sections_allowlist', 'list', []),
    ld_sections_denylist: p.parseOpt('ld_sections_denylist', 'list', []),
    ld_wildcard_sections: p.parseOpt('ld_wildcard_sections', 'bool', false),
    ld_use_symbolic_vram_addresses: p.parseOpt('ld_use_symbolic_vram_addresses', 'bool', true),
    ld_partial_linking: p.parseOpt('ld_partial_linking', 'bool', false),
    ld_partial_scripts_path: p.parseOptionalPath(basePath, 'ld_partial_scripts_path'),
    ld_partial_build_segments_path: p.parseOptionalPath(basePath, 'ld_partial_build_segments_path'),
    ld_dependencies: p.parseOpt('ld_dependencies', 'bool', false),
    ld_legacy_generation: p.parseOpt('ld_legacy_generation', 'bool', false),
    segment_end_before_align: p.parseOpt('segment_end_before_align', 'bool', false),
    segment_symbols_style: p.parseOptWithin('segment_symbols_style', 'str', ['splat', 'makerom'], 'splat'),
    ld_rom_start: p.parseOpt('ld_rom_start', 'int', 0),
    ld_fill_value: p.parseOptionalOptWithDefault('ld_fill_value', 'int', 0),
    ld_bss_is_noload: p.parseOpt('ld_bss_is_noload', 'bool', defaultLdBssIsNoload),
    ld_align_segment_start: p.parseOptionalOptWithDefault('ld_align_segment_start', 'int', null),
    ld_align_segment_vram_end: p.parseOpt('ld_align_segment_vram_end', 'bool', true),
    ld_align_section_vram_end: p.parseOpt('ld_align_section_vram_end', 'bool', true),
    ld_generate_symbol_per_data_segment: p.parseOpt('ld_generate_symbol_per_data_segment', 'bool', false),
    ld_bss_contains_common: p.parseOpt('ld_bss_contains_common', 'bool', false),
  });
  ret.ld_gp_expression = modern ? p.parseOptionalOptWithDefault('ld_gp_expression', 'str', null) : null;
  Object.assign(ret, {
    create_c_files: p.parseOpt('create_c_files', 'bool', true),
    auto_decompile_empty_functions: p.parseOpt('auto_decompile_empty_functions', 'bool', true),
    do_c_func_detection: p.parseOpt('do_c_func_detection', 'bool', true),
    c_newline: p.parseOpt('c_newline', 'str', comp.c_newline),
    symbol_name_format: p.parseOpt('symbol_name_format', 'str', '$VRAM'),
    symbol_name_format_no_rom: p.parseOpt('symbol_name_format_no_rom', 'str', '$VRAM_$SEG'),
    find_file_boundaries: p.parseOpt('find_file_boundaries', 'bool', true),
    pair_rodata_to_text: p.parseOpt('pair_rodata_to_text', 'bool', true),
    migrate_rodata_to_functions: p.parseOpt('migrate_rodata_to_functions', 'bool', true),
    asm_inc_header: p.parseOpt('asm_inc_header', 'str', comp.asm_inc_header),
    asm_function_macro: p.parseOpt('asm_function_macro', 'str', comp.asm_function_macro),
    asm_function_alt_macro: p.parseOpt('asm_function_alt_macro', 'str', comp.asm_function_alt_macro),
    asm_jtbl_label_macro: p.parseOpt('asm_jtbl_label_macro', 'str', comp.asm_jtbl_label_macro),
    asm_data_macro: p.parseOpt('asm_data_macro', 'str', comp.asm_data_macro),
    asm_end_label: p.parseOpt('asm_end_label', 'str', comp.asm_end_label),
  });
  ret.asm_data_end_label = modern ? p.parseOpt('asm_data_end_label', 'str', comp.asm_data_end_label) : '';
  ret.asm_ehtable_label_macro = p.parseOpt('asm_ehtable_label_macro', 'str', comp.asm_ehtable_label_macro);
  ret.asm_nonmatching_label_macro = modern
    ? p.parseOpt('asm_nonmatching_label_macro', 'str', comp.asm_nonmatching_label_macro) : '';
  Object.assign(ret, {
    asm_emit_size_directive: asmEmitSizeDirective,
    mnemonic_ljust: p.parseOpt('mnemonic_ljust', 'int', 11),
    rom_address_padding: p.parseOpt('rom_address_padding', 'bool', false),
    mips_abi_gpr: p.parseOptWithin('mips_abi_gpr', 'str', ['numeric', '32', 'o32', 'n32', 'n64'], 'o32'),
    mips_abi_float_regs: p.parseOptWithin('mips_abi_float_regs', 'str', ['numeric', '32', 'o32', 'n32', 'n64'], 'numeric'),
    named_regs_for_c_funcs: p.parseOpt('named_regs_for_c_funcs', 'bool', true),
    add_set_gp_64: p.parseOpt('add_set_gp_64', 'bool', defaultAddSetGp64),
    create_asm_dependencies: p.parseOpt('create_asm_dependencies', 'bool', false),
    string_encoding: p.parseOptionalOpt('string_encoding', 'str'),
    data_string_encoding: p.parseOptionalOpt('data_string_encoding', 'str'),
    rodata_string_guesser_level: p.parseOptionalOpt('rodata_string_guesser_level', 'int'),
    data_string_guesser_level: p.parseOptionalOpt('data_string_guesser_level', 'int'),
    allow_data_addends: p.parseOpt('allow_data_addends', 'bool', true),
    header_encoding: p.parseOpt('header_encoding', 'str', 'ASCII'),
    gfx_ucode: p.parseOptWithin('gfx_ucode', 'str', ['f3d', 'f3db', 'f3dex', 'f3dexb', 'f3dex2'], 'f3dex2'),
    libultra_symbols: p.parseOpt('libultra_symbols', 'bool', false),
    ique_symbols: p.parseOpt('ique_symbols', 'bool', false),
    hardware_regs: p.parseOpt('hardware_regs', 'bool', false),
    image_type_in_extension: p.parseOpt('image_type_in_extension', 'bool', false),
    use_legacy_include_asm: p.parseOpt('use_legacy_include_asm', 'bool', false),
    align_on_branch_labels: alignOnBranchLabels,
    disasm_unknown: p.parseOpt('disasm_unknown', 'bool', false),
    detect_redundant_function_end: p.parseOpt('detect_redundant_function_end', 'bool', true),
    disassemble_all: p.parseOpt('disassemble_all', 'bool', false) || disasmAll,
    make_full_disasm_for_code: p.parseOpt('make_full_disasm_for_code', 'bool', false) || makeFullDisasmForCode,
    global_vram_start: p.parseOptionalOpt('global_vram_start', 'int'),
    global_vram_end: p.parseOptionalOpt('global_vram_end', 'int'),
    use_gp_rel_macro_nonmatching: p.parseOpt('use_gp_rel_macro_nonmatching', 'bool', true),
    use_gp_rel_macro: p.parseOpt('use_gp_rel_macro', 'bool', true),
    suggestion_rodata_section_start: p.parseOpt('suggestion_rodata_section_start', 'bool', true),
  });
  p.checkNoUnreadOpts();

  ret.is_mode_active = (mode) => ret.modes.includes(mode) || ret.modes.includes('all');
  return ret;
}

export function initialize(config, configPaths, modes, verbose = false, disasmAll = false, makeFullDisasmForCode = false, overrides = {}) {
  if (!modes || modes.length === 0) modes = ['all'];
  opts = parseYaml(config.options, configPaths, modes, verbose, disasmAll, makeFullDisasmForCode, overrides);
  return opts;
}

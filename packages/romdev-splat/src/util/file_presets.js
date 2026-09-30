// splat.util.file_presets (splat >= 0.35): include/include_asm.h,
// include/macro.inc, include/labels.inc and include/gte_macros.inc.
import { exists, mkdirp, readText, writeText } from '../runtime.js';
import * as log from './log.js';
import { opts } from './options.js';
import { parent } from './pypath.js';
import { GTE_MACROS } from './gte_macros.js';

export function writeAllFiles() {
  if (!opts.generate_asm_macros_files) return;
  writeIncludeAsmH();
  writeAssemblyIncFiles();
}

function write(filepath, contents) {
  mkdirp(parent(filepath));
  if (exists(filepath)) {
    if (readText(filepath) === contents) return;
  }
  writeText(filepath, contents, '\n');
}

function writeIncludeAsmH() {
  if (!opts.compiler.uses_include_asm) return;
  const directory = opts.generated_asm_macros_directory;
  let includeAsmMacro;
  if (opts.include_asm_macro_style === 'maspsx_hack') {
    includeAsmMacro = `\
#define INCLUDE_ASM(FOLDER, NAME) \\
    void __maspsx_include_asm_hack_##NAME() { \\
        __asm__( \\
            ".text # maspsx-keep \\n" \\
            "    .align 2 # maspsx-keep\\n" \\
            "    .set noat # maspsx-keep\\n" \\
            "    .set noreorder # maspsx-keep\\n" \\
            "    .include \\"" FOLDER "/" #NAME ".s\\" # maspsx-keep\\n" \\
            "    .set reorder # maspsx-keep\\n" \\
            "    .set at # maspsx-keep\\n" \\
        ); \\
    }
`;
  } else {
    includeAsmMacro = `\
#define INCLUDE_ASM(FOLDER, NAME) \\
    __asm__( \\
        ".section .text\\n" \\
        "    .set noat\\n" \\
        "    .set noreorder\\n" \\
        "    .include \\"" FOLDER "/" #NAME ".s\\"\\n" \\
        "    .set reorder\\n" \\
        "    .set at\\n" \\
    )
`;
  }
  const includeRodataMacro = `\
#define INCLUDE_RODATA(FOLDER, NAME) \\
    __asm__( \\
        ".section .rodata\\n" \\
        "    .include \\"" FOLDER "/" #NAME ".s\\"\\n" \\
        ".section .text" \\
    )
`;
  const fileData = `\
#ifndef INCLUDE_ASM_H
#define INCLUDE_ASM_H

#if !defined(M2CTX) && !defined(PERMUTER)

#ifndef INCLUDE_ASM
${includeAsmMacro}\
#endif
#ifndef INCLUDE_RODATA
${includeRodataMacro}\
#endif

#if INCLUDE_ASM_USE_MACRO_INC
__asm__(".include \\"${directory}/macro.inc\\"\\n");
#else
__asm__(".include \\"${directory}/labels.inc\\"\\n");
#endif

#else

#ifndef INCLUDE_ASM
#define INCLUDE_ASM(FOLDER, NAME)
#endif
#ifndef INCLUDE_RODATA
#define INCLUDE_RODATA(FOLDER, NAME)
#endif

#endif /* !defined(M2CTX) && !defined(PERMUTER) */

#endif /* INCLUDE_ASM_H */
`;
  write(`${directory}/include_asm.h`, fileData);
}

const COP0_AND_FLOAT_ALIASES = `
# COP0 register aliases

.set Index,         $0
.set Random,        $1
.set EntryLo0,      $2
.set EntryLo1,      $3
.set Context,       $4
.set PageMask,      $5
.set Wired,         $6
.set Reserved07,    $7
.set BadVaddr,      $8
.set Count,         $9
.set EntryHi,       $10
.set Compare,       $11
.set Status,        $12
.set Cause,         $13
.set EPC,           $14
.set PRevID,        $15
.set Config,        $16
.set LLAddr,        $17
.set WatchLo,       $18
.set WatchHi,       $19
.set XContext,      $20
.set Reserved21,    $21
.set Reserved22,    $22
.set Reserved23,    $23
.set Reserved24,    $24
.set Reserved25,    $25
.set PErr,          $26
.set CacheErr,      $27
.set TagLo,         $28
.set TagHi,         $29
.set ErrorEPC,      $30
.set Reserved31,    $31

# Float register aliases

.set $fv0,          $f0
.set $fv0f,         $f1
.set $fv1,          $f2
.set $fv1f,         $f3
.set $ft0,          $f4
.set $ft0f,         $f5
.set $ft1,          $f6
.set $ft1f,         $f7
.set $ft2,          $f8
.set $ft2f,         $f9
.set $ft3,          $f10
.set $ft3f,         $f11
.set $fa0,          $f12
.set $fa0f,         $f13
.set $fa1,          $f14
.set $fa1f,         $f15
.set $ft4,          $f16
.set $ft4f,         $f17
.set $ft5,          $f18
.set $ft5f,         $f19
.set $fs0,          $f20
.set $fs0f,         $f21
.set $fs1,          $f22
.set $fs1f,         $f23
.set $fs2,          $f24
.set $fs2f,         $f25
.set $fs3,          $f26
.set $fs3f,         $f27
.set $fs4,          $f28
.set $fs4f,         $f29
.set $fs5,          $f30
.set $fs5f,         $f31
`;

function writeAssemblyIncFiles() {
  const directory = opts.generated_asm_macros_directory;
  const o = opts;

  let funcMacros = `\
# A function symbol.
.macro ${o.asm_function_macro} label, visibility=global
    .\\visibility \\label
    .type \\label, @function
    \\label:
        .ent \\label
.endm
`;
  if (o.asm_end_label !== '') {
    funcMacros += `
# The end of a function symbol.
.macro ${o.asm_end_label} label
    .size \\label, . - \\label
    .end \\label
.endm
`;
  }
  if (o.asm_function_alt_macro !== '' && o.asm_function_alt_macro !== o.asm_function_macro) {
    funcMacros += `
# An alternative entry to a function.
.macro ${o.asm_function_alt_macro} label, visibility=global
    .\\visibility \\label
    .type \\label, @function
    \\label:
        .aent \\label
.endm
`;
  }
  if (o.asm_ehtable_label_macro !== '' && o.asm_ehtable_label_macro !== o.asm_function_macro) {
    funcMacros += `
# A label referenced by an error handler table.
.macro ${o.asm_ehtable_label_macro} label, visibility=global
    .\\visibility \\label
    \\label:
.endm
`;
  }

  let jlabelMacroLabelsinc = '';
  let jlabelMacroMacroinc = '';
  if (o.asm_jtbl_label_macro !== '' && o.asm_jtbl_label_macro !== o.asm_function_macro) {
    jlabelMacroMacroinc = `
# A label referenced by a jumptable.
.macro ${o.asm_jtbl_label_macro} label, visibility=global
    .\\visibility \\label
    \\label:
.endm
`;
    if (o.migrate_rodata_to_functions) {
      jlabelMacroLabelsinc = `
# A label referenced by a jumptable.
.macro ${o.asm_jtbl_label_macro} label, visibility=local
    .\\visibility \\label
    \\label:
.endm
`;
    } else {
      jlabelMacroLabelsinc = jlabelMacroMacroinc;
    }
  }

  let dataMacros = '';
  if (o.asm_data_macro !== '' && o.asm_data_macro !== o.asm_function_macro) {
    dataMacros += `
# A data symbol.
.macro ${o.asm_data_macro} label, visibility=global
    .\\visibility \\label
    .type \\label, @object
    \\label:
.endm
`;
  }
  if (o.asm_data_end_label !== '') {
    dataMacros += `
# End of a data symbol.
.macro ${o.asm_data_end_label} label
    .size \\label, . - \\label
.endm
`;
  }

  let nmMacros = '';
  if (o.asm_nonmatching_label_macro !== '') {
    nmMacros = `
# Label to signal the symbol haven't been matched yet.
.macro ${o.asm_nonmatching_label_macro} label, size=1
    .global \\label\\().NON_MATCHING
    .type \\label\\().NON_MATCHING, @object
    .size \\label\\().NON_MATCHING, \\size
    \\label\\().NON_MATCHING:
.endm
`;
  }

  const macrosInc = `\
${funcMacros}
${jlabelMacroMacroinc}
${dataMacros}
${nmMacros}\
`;

  if (o.compiler.uses_include_asm) {
    let preamble = '# This file is used by the original compiler/assembler.\n# Defines the expected assembly macros.\n';
    if (o.platform === 'psx') preamble += '\n.include "gte_macros.inc"\n';
    const labelsInc = `\
${preamble}
${funcMacros}
${jlabelMacroLabelsinc}
${dataMacros}
${nmMacros}\
`;
    write(`${directory}/labels.inc`, labelsInc);
  }

  let gas;
  if (o.platform === 'n64' || o.platform === 'psx') gas = macrosInc;
  else if (o.platform === 'ps2' || o.platform === 'psp') {
    gas = macrosInc.replaceAll('\\label', '"\\label"').replaceAll('"\\label"\\().NON_MATCHING', '"\\label\\().NON_MATCHING"');
  } else if (!o.is_unsupported_platform) {
    log.error(`Unknown platform '${o.platform}'`);
  } else gas = macrosInc;

  if (o.platform === 'n64') {
    gas += COP0_AND_FLOAT_ALIASES;
  } else if (o.platform === 'psx') {
    gas += '\n.include "gte_macros.inc"\n';
    write(`${directory}/gte_macros.inc`, GTE_MACROS);
  }

  if (o.generated_macro_inc_content !== null) gas += `\n${o.generated_macro_inc_content}\n`;

  const preamble = '# This file is used by modern gas.\n# Defines the expected assembly macros\n';
  gas = `\
# Evaluate this file only once in case it's included more than once
.ifndef _MACRO_INC_GUARD
.internal _MACRO_INC_GUARD
.set _MACRO_INC_GUARD, 1

${gas}
.endif
`;
  write(`${directory}/macro.inc`, `${preamble}\n${gas}`);
}

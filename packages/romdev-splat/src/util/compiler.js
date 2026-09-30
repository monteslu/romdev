// splat.util.compiler (defaults gated on the splat version: 0.37 changed the
// default label macros and added data-end / nonmatching / include_asm fields).
import { atLeast } from '../runtime.js';

function make(name, fields = {}) {
  const modern = atLeast('0.35.0');
  const base = modern
    ? {
      asm_function_macro: 'glabel', asm_function_alt_macro: 'alabel', asm_jtbl_label_macro: 'jlabel',
      asm_data_macro: 'dlabel', asm_end_label: 'endlabel', asm_data_end_label: 'enddlabel',
      asm_ehtable_label_macro: 'ehlabel', asm_nonmatching_label_macro: 'nonmatching',
    }
    : {
      asm_function_macro: 'glabel', asm_function_alt_macro: 'glabel', asm_jtbl_label_macro: 'glabel',
      asm_data_macro: 'glabel', asm_end_label: '', asm_data_end_label: '',
      asm_ehtable_label_macro: 'ehlabel', asm_nonmatching_label_macro: '',
    };
  return {
    name,
    ...base,
    c_newline: '\n',
    asm_inc_header: '',
    asm_emit_size_directive: null,
    j_as_branch: false,
    uses_include_asm: true,
    align_on_branch_labels: false,
    ...fields,
  };
}

/** Build the compiler table for the active splat version. */
export function compilers() {
  const modern = atLeast('0.35.0');
  const GCC = make('GCC', {
    asm_inc_header: '.set noat      /* allow manual use of $at */\n.set noreorder /* don\'t insert nops after branches */\n\n',
    j_as_branch: true,
  });
  const SN64 = make('SN64', {
    asm_function_macro: '.globl', asm_function_alt_macro: '.globl', asm_jtbl_label_macro: '.globl',
    asm_data_macro: '.globl', asm_end_label: '.end',
    ...(modern ? { asm_data_end_label: '', asm_nonmatching_label_macro: '' } : {}),
    c_newline: '\r\n', asm_emit_size_directive: false, j_as_branch: true,
  });
  const IDO = make('IDO', { asm_emit_size_directive: false, uses_include_asm: !modern ? true : false });
  const KMC = make('KMC', { j_as_branch: true });
  const EGCS = make('EGCS', { j_as_branch: true });
  const PSYQ = make('PSYQ', { j_as_branch: true });
  const MWCCPS2 = make('MWCCPS2', { uses_include_asm: !modern });
  const EEGCC = make('EEGCC', { align_on_branch_labels: modern });
  const table = {};
  for (const c of [GCC, SN64, IDO, KMC, EGCS, PSYQ, MWCCPS2, EEGCC]) table[c.name] = c;
  return table;
}

export function forName(name, table) {
  name = name.toUpperCase();
  return table[name] || make(name);
}

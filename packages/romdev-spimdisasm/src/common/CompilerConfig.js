// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/CompilerConfig.py

import { createEnum } from "../py/pyutils.js";
import { atLeast, onVersionChange } from "../version.js";

/** Dataclass CompilerProperties. Positional args follow the Python field order. */
export class CompilerProperties {
  constructor(
    name,
    hasLateRodata = false,
    prevAlign_double = 3,
    prevAlign_jumptable = null,
    prevAlign_string = 2,
    prevAlign_function = null,
    pairMultipleHiToSameLow = true,
    allowRdataMigration = false,
    bigAddendWorkaroundForMigratedFunctions = true,
    sectionAlign_text = null,
    sectionAlign_rodata = null,
  ) {
    this.name = name;
    this.hasLateRodata = hasLateRodata;
    this.prevAlign_double = prevAlign_double;
    this.prevAlign_jumptable = prevAlign_jumptable;
    this.prevAlign_string = prevAlign_string;
    this.prevAlign_function = prevAlign_function;
    this.pairMultipleHiToSameLow = pairMultipleHiToSameLow;
    this.allowRdataMigration = allowRdataMigration;
    this.bigAddendWorkaroundForMigratedFunctions = bigAddendWorkaroundForMigratedFunctions;
    this.sectionAlign_text = sectionAlign_text;
    this.sectionAlign_rodata = sectionAlign_rodata;
  }

  /** Keyword-style constructor helper: CompilerProperties.of("GCC", {prevAlign_jumptable: 3}) */
  static of(name, kw = {}) {
    const p = new CompilerProperties(name);
    Object.assign(p, kw);
    return p;
  }
}

// Per-version property tables (keyword arguments as in the Python source).
function compilerKwargs() {
  const defaultDouble = atLeast("1.39.0") ? 3 : null;
  return {
    GCC: { prevAlign_double: defaultDouble, prevAlign_jumptable: 3 },
    IDO: { prevAlign_double: defaultDouble, hasLateRodata: true, pairMultipleHiToSameLow: false, bigAddendWorkaroundForMigratedFunctions: false, sectionAlign_text: 4, sectionAlign_rodata: 4 },
    KMC: { prevAlign_double: defaultDouble, prevAlign_jumptable: 3, sectionAlign_text: 4, sectionAlign_rodata: 4 },
    SN64: { prevAlign_double: 3, prevAlign_jumptable: 3, allowRdataMigration: true, sectionAlign_text: 4, sectionAlign_rodata: 4 },
    EGCS: { prevAlign_double: defaultDouble, prevAlign_jumptable: 3, sectionAlign_text: 4, sectionAlign_rodata: 4 },
    PSYQ: { prevAlign_double: 3, prevAlign_jumptable: 3, allowRdataMigration: true },
    MWCCPS2: atLeast("1.42.0")
      ? { prevAlign_double: defaultDouble, prevAlign_jumptable: 4, bigAddendWorkaroundForMigratedFunctions: false }
      : { prevAlign_double: defaultDouble, prevAlign_jumptable: 4 },
    EEGCC: { prevAlign_double: defaultDouble, prevAlign_jumptable: 3, prevAlign_string: 3, prevAlign_function: 3 },
  };
}

const COMPILER_NAMES = ["GCC", "IDO", "KMC", "SN64", "EGCS", "PSYQ", "MWCCPS2", "EEGCC"];

const initialKw = compilerKwargs();

export const Compiler = createEnum(
  "Compiler",
  COMPILER_NAMES.map((n) => [n, CompilerProperties.of(n, initialKw[n])]),
  {},
  {
    fromStr(value) {
      return compilerOptions.has(value) ? compilerOptions.get(value) : null;
    },
  },
);

/** dict[str, Compiler] */
export const compilerOptions = new Map(COMPILER_NAMES.map((n) => [n, Compiler[n]]));

function resetCompilerProperties() {
  const kw = compilerKwargs();
  for (const n of COMPILER_NAMES) {
    const fresh = CompilerProperties.of(n, kw[n]);
    Object.assign(Compiler[n].value, fresh);
  }
}

onVersionChange(resetCompilerProperties);

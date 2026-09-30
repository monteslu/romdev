// instrument-cli.js - `instrument-ugen` (instrument ugen),
// `instrument-uopt-alias` (instrument alias) and `instrument-uopt`
// (instrument uopt): write instrumented copies of statically recompiled IDO
// pass sources. Inputs are never edited unless --in-place.
//
// Plain JS ESM + JSDoc.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { instrumentUgen } from "./instrument.js";
import { instrumentUoptAlias } from "./instrument-alias.js";
import { SUPPORTED_PROFILES, instrumentUoptProfiles } from "./instrument-profiles.js";
import { readTextUniversal } from "./instrument-uopt-cli.js";
import { isInputError, osErrorText } from "./py.js";

const errText = (e) => (e?.code && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);

/** Shared shape: refuse an accidental in-place edit, transform, write. */
function transform(args, io, ctx, apply, describe) {
  const sourcePath = ctx.resolve(args.input), outputPath = ctx.resolve(args.output);
  if (sourcePath === outputPath && !args.in_place) {
    io.eprint("error: input and output are identical; pass --in-place to confirm");
    return 2;
  }
  let result;
  try {
    result = apply(readTextUniversal(sourcePath));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, result.source, "utf8");
  } catch (e) {
    if (!isInputError(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  io.print(describe(result));
  return 0;
}

export function instrumentUgenCommand(args, io, ctx) {
  return transform(args, io, ctx,
    (source) => instrumentUgen(source, { function_pattern: args.functions, procedure_function: args.procedure_function || null, emit_provenance: args.emit_provenance }),
    (r) => `instrumented ${r.functions} functions and ${r.free_list_hooks} free-list hooks; procedure hooks=${r.procedure_hooks}; emit hooks=${r.emit_hooks} -> ${args.output}`);
}

export function instrumentAliasCommand(args, io, ctx) {
  return transform(args, io, ctx,
    (source) => instrumentUoptAlias(source, { allow_unverified_source: args.allow_unverified_source }),
    (r) => `instrumented ${r.trace_points} alias-decision sites using ${r.profile} -> ${args.output}`);
}

export function instrumentProfilesCommand(args, io, ctx) {
  return transform(args, io, ctx,
    (source) => instrumentUoptProfiles(source, args.profile, { allow_unverified_source: args.allow_unverified_source }),
    (r) => `instrumented ${r.trace_points} sites from ${r.profiles.join(", ")} using ${r.profile} -> ${args.output}`);
}

const unverified = { flags: ["--allow-unverified-source"], action: "store_true", help: "bypass the source hash for profile development" };
const inPlace = { flags: ["--in-place"], action: "store_true", help: "permit input and output to be the same path" };

export const COMMAND_SPECS = [
  {
    path: ["instrument-ugen"], handler: instrumentUgenCommand,
    help: "instrument statically recompiled ugen C",
    description: "Add opt-in function and free-list traces to generated ugen C.",
    arguments: [
      { dest: "input", help: "pristine generated ugen.c" },
      { dest: "output", help: "instrumented output path" },
      { flags: ["--functions"], default: "^f_", help: "regular expression selecting generated functions (default: ^f_)" },
      { flags: ["--procedure-function"], default: "f_init_regs", help: "generated function invoked once at each target procedure start; its invocation ordinal is stamped on free-list events (default: f_init_regs, empty disables)" },
      { flags: ["--emit-provenance"], action: "store_true", help: "also hook every ibuffer emit helper, so each instruction ugen writes is reported in emission order with the source line it carries into the assembler's scheduler (DKWB-EMIT-V1 records, gated on DKWB_UGEN_SCHED)" },
      inPlace,
    ],
  },
  {
    path: ["instrument-uopt-alias"], handler: instrumentAliasCommand,
    help: "trace base provenance in the pinned IDO 5.3 uopt profile",
    description: "Add base-provenance and alias-query traces to pinned uopt C.",
    arguments: [{ dest: "input", help: "pristine generated uopt.c" }, { dest: "output", help: "instrumented output path" }, unverified, inPlace],
  },
  {
    path: ["instrument-uopt"], handler: instrumentProfilesCommand,
    help: "apply compatible profiles to the pinned IDO 5.3 uopt source",
    description: "Apply one or more compatible profiles to pinned uopt C.",
    arguments: [
      { dest: "input", help: "pristine generated uopt.c" },
      { dest: "output", help: "instrumented output path" },
      { flags: ["--profile"], action: "append", choices: [...SUPPORTED_PROFILES], required: true, help: "profile to apply; repeat for a combined source" },
      unverified, inPlace,
    ],
  },
];

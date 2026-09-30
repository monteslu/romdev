// instrument-uopt-cli.js - `instrument globalcolor` (flat spelling
// instrument-uopt-globalcolor): write an instrumented copy of the pinned
// IDO 5.3 static-recomp uopt.c. Never edits its input unless --in-place.
//
// Plain JS ESM + JSDoc.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { instrumentUoptGlobalcolor } from "./instrument-uopt.js";
import { ValueError, isInputError, osErrorText } from "./py.js";

/** Text-mode read: strict UTF-8 with universal newlines, as the original read it. */
export function readTextUniversal(file) {
  const data = readFileSync(file);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new ValueError(`'utf-8' codec can't decode ${file}: invalid UTF-8`); }
  return text.replace(/\r\n?/g, "\n");
}

export async function instrumentUoptCommand(args, io, ctx) {
  const sourcePath = ctx.resolve(args.input);
  const outputPath = ctx.resolve(args.output);
  if (sourcePath === outputPath && !args.in_place) {
    io.eprint("error: input and output are identical; pass --in-place to confirm");
    return 2;
  }
  let result;
  try {
    result = instrumentUoptGlobalcolor(readTextUniversal(sourcePath), { allow_unverified_source: args.allow_unverified_source });
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, result.source, "utf8");
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  io.print(`instrumented ${result.trace_points} globalcolor sites using ${result.profile} -> ${args.output}`);
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["instrument-uopt-globalcolor"], handler: instrumentUoptCommand,
    help: "instrument the pinned IDO 5.3 static-recomp uopt profile",
    description: "Add globalcolor traces and force probes to pinned uopt C.",
    arguments: [
      { dest: "input", help: "pristine generated uopt.c" },
      { dest: "output", help: "instrumented output path" },
      { flags: ["--allow-unverified-source"], action: "store_true", help: "bypass the source hash for profile development" },
      { flags: ["--in-place"], action: "store_true", help: "permit input and output to be the same path" },
    ],
  },
];

// source-correlation-cli.js - `trace source`: join allocator web lines to
// preprocessor and listing evidence, preserving ambiguous matches.
//
// Plain JS ESM + JSDoc.

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import { parseGlobalcolorTrace } from "./globalcolor.js";
import { correlateTraceSource, QuotedPathError } from "./source-correlation.js";
import { readTraceText } from "./trace-source.js";
import { dumps } from "./pyjson.js";
import { strip, isInputError, osErrorText } from "./py.js";

const expand = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
function resolveStrict(ctx, p) {
  const abs = ctx.resolve(expand(p));
  try { return realpathSync(abs); } catch { return abs; }
}

export async function traceSourceCommand(args, io, ctx) {
  let report;
  try {
    const tracePath = resolveStrict(ctx, args.trace), sourcePath = resolveStrict(ctx, args.source);
    const listingPath = args.listing ? resolveStrict(ctx, args.listing) : null;
    report = correlateTraceSource(parseGlobalcolorTrace(readTraceText(tracePath, { warn: (n) => io.eprint(`warning: ${n}`) })), {
      source_text: readFileSync(sourcePath, "utf8"), source_origin: sourcePath,
      listing_text: listingPath ? readFileSync(listingPath, "utf8") : null, source_file: args.source_file, proc: args.proc,
    });
  } catch (e) {
    if (!isInputError(e) && !(e instanceof QuotedPathError)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    const s = report.states;
    io.print(`trace source: ${report.correlated_webs}/${report.web_count} web(s) correlated; ${s.ambiguous} ambiguous, ${s.unresolved} unresolved`);
    for (const row of report.webs.slice(0, args.limit)) {
      io.print(`${row.fingerprint} ${row.force_key} line=${row.trace_line === null ? "None" : row.trace_line} state=${row.state}`);
      for (const src of row.source_candidates) io.print(`  source ${src.file}:${src.line} ${strip(src.text)}`);
      for (const loc of row.listing_locations) io.print(`  listing line ${loc.listing_line}: ${loc.file || `file#${loc.file_index}`}:${loc.line}`);
    }
    if (report.webs.length > args.limit) io.print(`... ${report.webs.length - args.limit} more web(s); use --json`);
    io.print(`proof: ${report.proof}`);
  }
  return report.correlated_webs ? 0 : 1;
}

export const COMMAND_SPECS = [
  {
    path: ["trace-source"], handler: traceSourceCommand, help: "join allocator web lines to preprocessor and listing evidence",
    description: "Map trace logical line numbers through retained #line markers and optional .file/.loc directives, preserving ambiguous matches.",
    arguments: [
      { dest: "trace", help: "captured allocator trace" },
      { dest: "source", help: "retained preprocessed or composed source" },
      { flags: ["--listing"], help: "optional retained assembly listing" },
      { flags: ["--source-file"], help: "select one exact marker filename (or unique basename)" },
      { flags: ["--proc"], type: "int", help: "include one allocator invocation" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];

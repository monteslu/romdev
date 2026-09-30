// staleness-cli.js - `check-staleness`: refuse to trust a build older than
// the inputs it came from. A wrapper that rebuilds a ROM and then compares it
// can ask, in one line, whether the image is newer than the edited source.
//
// Plain JS ESM + JSDoc.

import { ArgumentTypeError } from "./argparse.js";
import { DEFAULT_TOLERANCE_SECONDS, stalenessReport } from "./staleness.js";
import { dumps } from "./pyjson.js";
import { floatRepr, strRepr, strip } from "./py.js";

const DESCRIPTION = "Check a build chain named in build order, earliest input first. Every "
  + "earlier path is treated as an input to every later one, so a ROM that "
  + "was relinked after its object but before the source was recompiled is "
  + "reported stale against the source. Exit status is 0 when every artifact "
  + "is at least as new as the inputs before it, and 1 otherwise -- including "
  + "when a path is missing, because an unproven chain is not a fresh one.";

const EPILOG = "example: decomp-workbench check-staleness src/track.c build/track.o build/game.elf build/game.z64";

/** `--tolerance`: a non-negative number of seconds. */
export function tolerance(value) {
  const s = strip(value).toLowerCase().replace(/_/g, "");
  const seconds = /^[-+]?(inf|infinity)$/.test(s) ? (s.startsWith("-") ? -Infinity : Infinity) : /^[-+]?nan$/.test(s) ? NaN : s === "" ? NaN : Number(s);
  if (Number.isNaN(seconds) && !/nan$/.test(s)) throw new ArgumentTypeError(`${strRepr(value)} is not a number`);
  if (Number.isNaN(seconds) || seconds < 0) {
    throw new ArgumentTypeError(`--tolerance is a slack window in seconds and must not be negative; got ${strRepr(value)}`);
  }
  return seconds;
}
tolerance.displayName = "_tolerance";

export function checkStalenessCommand(args, io, ctx) {
  if (args.paths.length < 2) {
    io.eprint("error: name at least two paths in build order; one artifact has nothing to be older than");
    return 2;
  }
  const labels = [...(args.label ?? [])];
  if (labels.length && labels.length !== args.paths.length) {
    io.eprint(`error: ${args.paths.length} path(s) and ${labels.length} --label(s); they must correspond`);
    return 2;
  }
  const report = stalenessReport(args.paths, { labels: labels.length ? labels : null, hashes: args.sha256, tolerance_seconds: args.tolerance, cwd: ctx.cwd });
  if (args.json) io.print(dumps(report.asDict()));
  else io.print(report.lines().join("\n"));
  if (report.stale && args.allow_stale) return 0;
  return report.fresh ? 0 : 1;
}

export const COMMAND_SPECS = [
  {
    path: ["check-staleness"], handler: checkStalenessCommand, defaults: { report_command: "check-staleness" },
    help: "refuse to trust a build older than the inputs it came from", description: DESCRIPTION, epilog: EPILOG,
    arguments: [
      { dest: "paths", nargs: "+", help: "artifacts in build order: source, object, ELF, ROM" },
      { flags: ["--label"], action: "append", metavar: "NAME", help: "name one row of the report; repeat once per path" },
      { flags: ["--sha256"], action: "store_true", help: "record each artifact's content hash, so a host can compare runs" },
      { flags: ["--tolerance"], type: tolerance, default: DEFAULT_TOLERANCE_SECONDS, metavar: "SECONDS",
        help: `how much older a derived artifact may be before it is stale (default: ${floatRepr(DEFAULT_TOLERANCE_SECONDS)}, one filesystem timestamp tick)` },
      { flags: ["--allow-stale"], action: "store_true", help: "report the staleness but exit 0 anyway" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];

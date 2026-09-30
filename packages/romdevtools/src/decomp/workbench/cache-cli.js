// cache-cli.js - `cache status`, `cache prune` and `cache restore`: cache
// cleanup is always explicit, prune defaults to a dry run, and --apply moves
// entries to recoverable trash instead of deleting them.
//
// Plain JS ESM + JSDoc.

import { dumps } from "./pyjson.js";
import { isInputError } from "./py.js";
import { resolvePath, expanduser, osText, isOSError } from "./py-path.js";
import { cacheStatus, formatBytes, parseDuration, parseSize, pruneCache, restorePrunedCache } from "./cache.js";
import { groupListingSpec } from "./group-listing.js";

export const DEFAULT_CACHE = ".decomp-workbench/cache";
export const DEFAULT_TRASH = ".decomp-workbench/trash";

export function cacheStatusCommand(args, io, ctx) {
  let report;
  try { report = cacheStatus(ctx.resolve(expanduser(args.cache_dir))); } catch (e) {
    if (!isOSError(e)) throw e;
    io.eprint(`error: ${osText(e)}`); return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`cache: ${report.files} file(s), ${report.human_bytes} (${report.bytes} bytes; ${report.path})`);
    if (!report.exists) io.print("state: empty (the cache directory has not been created yet)");
  }
  return 0;
}

export function cachePruneCommand(args, io, ctx) {
  let report;
  try {
    const older_than = args.older_than ? parseDuration(args.older_than) : null;
    const max_size = args.max_size ? parseSize(args.max_size) : null;
    report = pruneCache(ctx.resolve(expanduser(args.cache_dir)), { older_than, max_size, keep_recent: args.keep_recent, apply: args.apply, trash_root: ctx.resolve(expanduser(args.trash_dir)) });
  } catch (e) {
    if (!isOSError(e) && !isInputError(e)) throw e;
    io.eprint(`error: ${isOSError(e) ? osText(e) : e.message}`); return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`cache prune ${report.mode}: ${report.selected_files} file(s), ${formatBytes(report.selected_bytes)}`);
    if (args.apply && report.trash_directory) {
      io.print(`moved to: ${report.trash_directory}`);
      io.print(`recovery: decomp-workbench cache restore ${report.trash_directory}`);
    } else if (!args.apply && report.selected_files) io.print("next: repeat with --apply to move these files to recoverable trash");
  }
  return 0;
}

export function cacheRestoreCommand(args, io, ctx) {
  let restored;
  try { restored = restorePrunedCache(ctx.resolve(expanduser(args.trash_directory)), ctx.resolve(expanduser(args.cache_dir))); } catch (e) {
    if (!isOSError(e)) throw e;
    io.eprint(`error: ${osText(e)}`); return 2;
  }
  const payload = { schema: "decomp-workbench-cache-restore-v1", cache_directory: resolvePath(args.cache_dir, ctx.cwd),
    trash_directory: resolvePath(args.trash_directory, ctx.cwd), restored_files: restored };
  if (args.json) io.print(dumps(payload));
  else io.print(`restored ${restored} cache file(s) into ${payload.cache_directory}`);
  return 0;
}

const cacheDir = { flags: ["--cache-dir"], default: DEFAULT_CACHE, help: `content cache (default: ${DEFAULT_CACHE})` };
const json = { flags: ["--json"], action: "store_true", help: "emit JSON" };

const SUBS = [
  { path: ["cache", "status"], help: "show cache size and age", handler: cacheStatusCommand, defaults: { report_command: "cache-status" },
    arguments: [cacheDir, json] },
  { path: ["cache", "prune"], help: "plan or recoverably apply an age-based prune", handler: cachePruneCommand, defaults: { report_command: "cache-prune" },
    arguments: [
      { flags: ["--older-than"], metavar: "DURATION", help: "minimum age, for example 30d, 12h, or 1w2d" },
      { flags: ["--max-size"], metavar: "SIZE", help: "select least-recent files until the cache is at most this size" },
      { flags: ["--keep-recent"], type: "int", default: 0, metavar: "N", help: "protect the N most recently used files from either policy" },
      { flags: ["--apply"], action: "store_true", help: "move selected files to trash; omitted means dry-run" },
      cacheDir,
      { flags: ["--trash-dir"], default: DEFAULT_TRASH, help: `recoverable trash root (default: ${DEFAULT_TRASH})` },
      json,
    ] },
  { path: ["cache", "restore"], help: "restore a prune trash directory without overwriting entries", handler: cacheRestoreCommand, defaults: { report_command: "cache-restore" },
    arguments: [{ dest: "trash_directory" }, cacheDir, json] },
];

export const COMMAND_SPECS = [
  groupListingSpec(["cache"], {
    help: "inspect and recoverably prune compiled-object cache entries",
    description: "Cache cleanup is always explicit. Prune defaults to a dry run and --apply moves entries to recoverable trash instead of deleting them.",
    subcommands: SUBS, required: false,
  }),
  ...SUBS,
];

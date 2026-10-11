// decompme-cli.js - the two commands allowed to touch the network:
// fetch-scratch and public-match-check. Both are explicit, single-purpose and
// opt-in; every option that shapes the request is visible here.
//
// Plain JS ESM + JSDoc.

import { dumps } from "./pyjson.js";
import { isInputError, osErrorText, sorted } from "./py.js";
import { DEFAULT_API_BASE, EXPORT_MEMBERS, fetchScratch, scratchUrl } from "./decompme-fetch.js";
import { DEFAULT_PAGE_SIZE, publicMatchCheck, renderPublicMatchCheck } from "./decompme-search.js";
import { NetworkError, PoliteClient } from "./http-client.js";

/**
 * The client one invocation uses: everything below it is domain logic that
 * never sees a socket.
 */
export function buildClient(args) {
  return new PoliteClient({ timeout: args.timeout, contact: args.contact });
}

/** The one replaceable seam: tests swap seams.buildClient for a scripted client. */
export const seams = { buildClient };

function clientArguments() {
  return [
    { flags: ["--timeout"], type: "float", default: 30.0, help: "seconds to wait for one request (default: 30)" },
    { flags: ["--contact"], help: "contact appended to the User-Agent, so a server operator can reach whoever is making the requests" },
    { flags: ["--api-base"], default: DEFAULT_API_BASE, help: `API root to query (default: ${DEFAULT_API_BASE})` },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
  ];
}

const reportable = (e) => e instanceof NetworkError || isInputError(e);
const message = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);

export async function fetchScratchCommand(args, io, ctx) {
  let report;
  try {
    report = await fetchScratch(args.slug, { client: seams.buildClient(args), outdir: ctx.resolve(args.outdir), api_base: args.api_base, force: args.force, keep_archive: !args.no_archive });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${message(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  io.print(`scratch ${report.slug}: ${report.reused ? "reused cached export" : "downloaded"} -> ${report.output}`);
  io.print(`page: ${scratchUrl(report.slug, { api_base: args.api_base })}`);
  io.print(`members: ${sorted(Object.keys(report.files)).join(" ")}`);
  if (report.missing_members.length) io.print("not in this export: " + report.missing_members.join(" ") + " (optional; check-scratch reports what it can measure)");
  const { score, max_score: maximum } = report.metadata;
  if (score !== undefined && score !== null && maximum !== undefined && maximum !== null) io.print(`decomp.me display: score=${score}/${maximum}`);
  for (const action of report.next_actions) io.print(`next: ${action.command_argv.join(" ")}`);
  return 0;
}

export async function publicMatchCheckCommand(args, io, ctx) {
  let report;
  try {
    report = await publicMatchCheck({ client: seams.buildClient(args), query: args.query, address: args.address, max_score: args.max_score,
      instructions: args.instructions, api_base: args.api_base, page_size: args.page_size });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${message(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else io.print(renderPublicMatchCheck(report).join("\n"));
  if (args.fail_on_match && report.verdict !== "no-public-match") return 1;
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["fetch-scratch"], handler: fetchScratchCommand, defaults: { report_command: "fetch-scratch" },
    help: "download one decomp.me scratch export into the standard layout",
    description: `Download a scratch export over HTTPS and unpack it to OUTDIR/SLUG (${EXPORT_MEMBERS.join(", ")}), keeping the ZIP alongside it. The request identifies this workbench and its version; a scratch already on disk is reported rather than downloaded again. This is one of the two commands that open a network connection, and it never runs implicitly.`,
    arguments: [
      { dest: "slug", help: "decomp.me scratch slug or scratch URL" },
      { flags: ["--outdir"], default: ".", help: "directory to create SLUG/ inside (default: the current directory)" },
      { flags: ["--force"], action: "store_true", help: "download again and replace an export already fetched here" },
      { flags: ["--no-archive"], action: "store_true", help: "do not keep the downloaded ZIP next to the unpacked export" },
      ...clientArguments(),
    ],
  },
  {
    path: ["public-match-check"], handler: publicMatchCheckCommand, defaults: { report_command: "public-match-check" },
    help: "gate 0: is this function already matched in a public scratch?",
    description: "Query the public decomp.me search by name, by address, or both, and report every candidate with its score, its max_score, and whether its match is site-verified or owner-declared. Bind on --max-score (the target's instruction count times 100) to catch scratches named after a data label instead of the function. This is one of the two commands that open a network connection.",
    arguments: [
      { dest: "query", nargs: "?", help: "function name or any search term; optional if --address is given" },
      { flags: ["--address"], help: "target address in hex; searched in upper, lower, and 0x spellings, which finds scratches a name lookup misses" },
      { flags: ["--max-score"], type: "int", help: "keep only results with this max_score (instruction count x 100)" },
      { flags: ["--instructions"], type: "int", help: "the same binding written as an instruction count" },
      { flags: ["--page-size"], type: "int", default: DEFAULT_PAGE_SIZE, help: `results to request per term (default: ${DEFAULT_PAGE_SIZE})` },
      { flags: ["--fail-on-match"], action: "store_true", help: "return exit 1 when any public match or override claim is found" },
      ...clientArguments(),
    ],
  },
];

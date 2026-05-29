// findFreeSpace — scan a ROM for runs of repeated fill bytes ($FF / $00).
//
// Used by ROM hackers to find unused space to splice new code into.
// Identical task on every platform — pure byte scan.

import { readFile } from "node:fs/promises";
import { jsonContent, safeTool } from "../util.js";

/**
 * @param {Object} args
 * @param {string} args.path
 * @param {number} [args.minLength] minimum run length to report (default 32)
 * @param {number[]} [args.fillBytes] which bytes count as "free" (default [0xFF, 0x00])
 * @param {number} [args.start] start file offset (default 0)
 * @param {number} [args.end] end file offset exclusive (default file length)
 * @param {number} [args.maxRunsReturned]
 */
export async function findFreeSpaceCore(args) {
  const path = args.path;
  const minLength = args.minLength ?? 32;
  const fillBytes = args.fillBytes ?? [0xFF, 0x00];
  const fillSet = new Set(fillBytes);
  const data = new Uint8Array(await readFile(path));
  const start = args.start ?? 0;
  const end = Math.min(args.end ?? data.length, data.length);
  const maxRunsReturned = args.maxRunsReturned ?? 256;

  const runs = [];
  let i = start;
  while (i < end) {
    if (!fillSet.has(data[i])) { i++; continue; }
    const fillByte = data[i];
    let j = i + 1;
    while (j < end && data[j] === fillByte) j++;
    const len = j - i;
    if (len >= minLength) {
      runs.push({
        offset: i,
        length: len,
        fillByte,
      });
    }
    i = j;
  }

  // Sort longest-first; most workflows want "biggest free chunk" first.
  runs.sort((a, b) => b.length - a.length);
  const totalFreeBytes = runs.reduce((acc, r) => acc + r.length, 0);

  return {
    path,
    fileSize: data.length,
    scannedRange: { start, end },
    minLength,
    fillBytes,
    runsFound: runs.length,
    totalFreeBytes,
    runs: runs.slice(0, maxRunsReturned).map((r) => ({
      offset: "0x" + r.offset.toString(16).toUpperCase().padStart(6, "0"),
      offsetDec: r.offset,
      length: r.length,
      fillByte: "0x" + r.fillByte.toString(16).toUpperCase().padStart(2, "0"),
    })),
    truncated: runs.length > maxRunsReturned
      ? `${runs.length - maxRunsReturned} additional runs not returned (raise maxRunsReturned).`
      : undefined,
  };
}

export function registerFreeSpaceTools(server, z) {
  server.tool(
    "findFreeSpace",
    "Scan a ROM (or any binary) for contiguous runs of fill bytes ($FF or $00 by default) longer " +
    "than `minLength`. Used by ROM hackers to find unused regions where new code or data can be " +
    "spliced in without overwriting anything that matters.\n\n" +
    "Returns runs sorted longest-first (biggest free chunk = most likely candidate). Each run reports " +
    "file offset (hex AND decimal), length, and which fill byte it consists of. Tighten the scan " +
    "with `start`/`end` to restrict to a specific bank, or `fillBytes` to look for non-standard " +
    "padding (some platforms pad with $EA NOPs etc).\n\n" +
    "Workflow: findFreeSpace → assembleSnippet at the chosen offset → patchFile with `expect` set " +
    "to a few of the fill bytes → diffRoms to confirm. Cross-platform — works on any binary.",
    {
      path: z.string().describe("Absolute path to the file to scan."),
      minLength: z.number().int().min(1).default(32).describe("Minimum run length to report. Tune up for big patches, down for tiny inserts."),
      fillBytes: z.array(z.number().int().min(0).max(255)).default([0xFF, 0x00]).describe("Which byte values count as free. Default [0xFF, 0x00]. Some carts pad with $EA — pass [0xEA] to scan for those."),
      start: z.number().int().min(0).optional().describe("File offset to start scanning at (e.g. 16 to skip iNES header). Default 0."),
      end: z.number().int().min(1).optional().describe("File offset to stop at (exclusive). Default = file length."),
      maxRunsReturned: z.number().int().min(1).max(2048).default(256),
    },
    safeTool(async (args) => {
      const r = await findFreeSpaceCore(args);
      return jsonContent(r);
    }),
  );
}

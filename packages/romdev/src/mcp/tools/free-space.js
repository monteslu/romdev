// findFreeSpace — scan a ROM for runs of repeated fill bytes ($FF / $00).
//
// Used by ROM hackers to find unused space to splice new code into.
// Identical task on every platform — pure byte scan.

import { readFile } from "node:fs/promises";

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

// findFreeSpace folded into the `romPatch` tool (romPatch({op:'findFree'}),
// rom-id.js, which imports findFreeSpaceCore). Nothing registered here.
export function registerFreeSpaceTools() {}

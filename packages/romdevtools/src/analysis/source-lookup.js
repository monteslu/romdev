// source-lookup — find the project's OWN annotated source lines covering a CPU
// address range, by matching the trailing address comment the disassembler
// emits per line (`… ; E4DB 20 E4 D2`). The single most-repeated navigation
// op in an annotation session: "show me my commented source for $E4DB".
//
// v0.98.0 feedback #1 (headline): the alternatives all miss —
// target:'rom' re-decodes fresh (loses the annotations + re-decodes data as
// code), target:'source' is PICO-8-only, symbols({op:'lookup'}) gives the
// enclosing symbol name but not the text. The fallback was a hand-built
// nibble-class regex over a 7000-line bank file, easy to truncate silently.
//
// This reads the project's source files directly and returns the lines whose
// emitted address annotation falls in [startAddress, endAddress], with a few
// lines of context, so the grep→sed→eyeball loop collapses to one call.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const SOURCE_EXT = new Set([".asm", ".s", ".inc", ".a65", ".a68", ".z80"]);

/** Trailing address comment the disassembler emits, e.g. "; E4DB 20 E4 D2"
 *  or "; 00E4DB …" (6-hex on 24-bit CPUs). We take the FIRST hex token after
 *  a `;` that looks like an address (4 or 6 hex, followed by space + hex byte
 *  or end), which is exactly the da65 `--comments 4` / objdump layout the rest
 *  of the RE tools already parse. */
const ADDR_COMMENT = /;\s*([0-9A-Fa-f]{4,6})(?:\s+[0-9A-Fa-f]{2}\b|\s*$)/;

async function collectSourceFiles(dir, acc, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectSourceFiles(full, acc, depth + 1);
    else if (SOURCE_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full);
  }
}

/**
 * @param {object} args
 * @param {string} args.projectDir  the disasm project root (searched for source files)
 * @param {number} args.startAddress
 * @param {number} [args.endAddress]  defaults to startAddress (single line)
 * @param {number} [args.context=2]   source lines of context on each side of a hit block
 * @param {number} [args.maxLines=400]
 */
export async function sourceLookupCore({ projectDir, startAddress, endAddress, context = 2, maxLines = 400 }) {
  if (!projectDir) throw new Error("disasm({target:'sourceLookup'}): `projectDir` (the disasm project root) is required.");
  if (startAddress == null) throw new Error("disasm({target:'sourceLookup'}): `startAddress` is required.");
  const lo = startAddress;
  const hi = endAddress ?? startAddress;
  if (hi < lo) throw new Error("disasm({target:'sourceLookup'}): endAddress must be >= startAddress.");

  let st;
  try { st = await stat(projectDir); } catch { throw new Error(`sourceLookup: projectDir '${projectDir}' not found.`); }
  const files = [];
  if (st.isDirectory()) await collectSourceFiles(projectDir, files);
  else files.push(projectDir); // a single file is also fine
  if (!files.length) {
    throw new Error(`sourceLookup: no source files (${[...SOURCE_EXT].join("/")}) under '${projectDir}'.`);
  }

  const results = [];
  let totalLines = 0;
  let filesWithAddrComments = 0;
  for (const file of files.sort()) {
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    let sawAddr = false;
    const hitRows = [];
    for (let i = 0; i < lines.length; i++) {
      const m = ADDR_COMMENT.exec(lines[i]);
      if (!m) continue;
      sawAddr = true;
      const addr = parseInt(m[1], 16);
      if (addr >= lo && addr <= hi) hitRows.push({ line: i, addr });
    }
    if (sawAddr) filesWithAddrComments++;
    if (!hitRows.length) continue;

    // Merge hit rows into contiguous blocks (+context), so a range returns
    // readable chunks instead of scattered single lines.
    const blocks = [];
    for (const { line, addr } of hitRows) {
      const last = blocks[blocks.length - 1];
      if (last && line - last.end <= context * 2 + 1) { last.end = line; last.hiAddr = addr; }
      else blocks.push({ start: line, end: line, loAddr: addr, hiAddr: addr });
    }
    for (const b of blocks) {
      const from = Math.max(0, b.start - context);
      const to = Math.min(lines.length - 1, b.end + context);
      const excerpt = [];
      for (let i = from; i <= to; i++) {
        excerpt.push({ n: i + 1, text: lines[i], hit: i >= b.start && i <= b.end });
        totalLines++;
      }
      results.push({
        file: path.relative(st.isDirectory() ? projectDir : path.dirname(projectDir), file) || path.basename(file),
        firstAddress: "$" + b.loAddr.toString(16).toUpperCase(),
        lines: excerpt,
      });
      if (totalLines >= maxLines) break;
    }
    if (totalLines >= maxLines) break;
  }

  return {
    projectDir,
    range: "$" + lo.toString(16).toUpperCase() + (hi !== lo ? "..$" + hi.toString(16).toUpperCase() : ""),
    filesScanned: files.length,
    matches: results.length,
    results,
    ...(totalLines >= maxLines ? { truncated: `hit the maxLines cap (${maxLines}); narrow the range.` } : {}),
    note: results.length
      ? "Each result is your project's OWN source (annotations intact), matched on the trailing address comment the disassembler emits. `hit:true` lines are inside the requested range; the rest are context."
      : filesWithAddrComments === 0
        ? "No source line carries a trailing address comment (e.g. `; E4DB 20 E4 D2`). This project wasn't emitted by disasm({target:'project'}) with address comments, so there's nothing to match on — use symbols({op:'lookup', address}) to get the enclosing label, then open that source region yourself."
        : "No source line's address annotation falls in this range (the address may live in a data table with no per-line comment, or in a bank whose file wasn't found). Widen the range or check the bank.",
  };
}

// fidelity.js - section-scoped object fidelity gates for compiler
// instrumentation and pass replay: .text/.rodata/.data bytes, relocations and
// the symbol table, read through the project's objdump. Whole-file
// differences in unstable debug metadata are reported separately.
//
// Plain JS ESM + JSDoc.

import { runProgramSync } from "./proc.js";
import { createHash } from "node:crypto";
import { statSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitlines, strip } from "./py.js";
import { RuntimeError, FileNotFoundError } from "./py-extra.js";
import { discoverObjdump } from "./objdump.js";
import { executableIdentity, fileSha256 } from "./campaign.js";

export const FIDELITY_SCHEMA = "decomp-workbench-object-fidelity-v1";
export const DEFAULT_SECTIONS = Object.freeze([".text", ".rodata", ".data"]);
const HEX_DUMP_ADDRESS_RE = /^\s*[0-9a-fA-F]+\s+/;
const HEX_DUMP_TOKEN_RE = /[0-9a-fA-F]{2,8}(?=\s|$)/y;

function run(executable, args, { timeout, env }) {
  const r = runProgramSync([executable, ...args], { encoding: "utf8", timeout: timeout * 1000, env });
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") throw new RuntimeError(`objdump ${args.join(" ")} timed out after ${timeout} seconds`);
    throw r.error;
  }
  if (r.status) {
    const diagnostic = strip(r.stderr) || strip(r.stdout);
    if (diagnostic.includes("section") && diagnostic.includes("not found")) return "";
    throw new RuntimeError(`objdump ${args.join(" ")} failed with exit ${r.status}: ${diagnostic}`);
  }
  return r.stdout;
}

/** The bytes of an `objdump -s` hex dump. */
export function sectionBytes(text) {
  const chunks = [];
  for (const line of splitlines(text)) {
    const address = HEX_DUMP_ADDRESS_RE.exec(line);
    if (!address) continue;
    let position = address[0].length;
    for (let n = 0; n < 4; n++) {
      HEX_DUMP_TOKEN_RE.lastIndex = position;
      const token = HEX_DUMP_TOKEN_RE.exec(line);
      if (!token || token[0].length % 2) break;
      chunks.push(token[0]);
      position = HEX_DUMP_TOKEN_RE.lastIndex;
      const ws = /^\s+/.exec(line.slice(position));
      if (!ws) break;
      // GNU objdump separates data from its ASCII column with two spaces.
      if (ws[0].length >= 2) break;
      position += ws[0].length;
    }
  }
  return chunks.length ? Buffer.from(chunks.join(""), "hex") : Buffer.alloc(0);
}

/** A symbol or relocation table with the input filename/header removed. */
export function canonicalTable(text) {
  const lines = [];
  for (const line of splitlines(text)) {
    const s = strip(line);
    if (!s || s.endsWith("file format elf32-bigmips")) continue;
    if (s.startsWith("SYMBOL TABLE:") || s.startsWith("RELOCATION RECORDS FOR")) { lines.push(s); continue; }
    if (s.includes(":") && !/^[0-9a-fA-F]/.test(s)) continue;
    lines.push(s.replace(/\s+/g, " "));
  }
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Hash meaningful object sections while isolating unstable debug metadata. */
export function objectFidelityFingerprint(file, { objdump = null, sections = DEFAULT_SECTIONS, timeout = 10.0, env = process.env } = {}) {
  let objectPath = path.resolve(String(file).replace(/^~(?=\/|$)/, os.homedir()));
  try { objectPath = realpathSync(objectPath); } catch { /* reported below */ }
  let isFile = false;
  try { isFile = statSync(objectPath).isFile(); } catch { isFile = false; }
  if (!isFile) throw new FileNotFoundError(`object does not exist: ${objectPath}`);
  const executable = discoverObjdump(objdump, { env });
  const rows = {};
  for (const section of sections) {
    const content = sectionBytes(run(executable, ["-s", "-j", section, objectPath], { timeout, env }));
    rows[section] = { present: content.length > 0, bytes: content.length, sha256: sha(content) };
  }
  const relocations = canonicalTable(run(executable, ["-r", objectPath], { timeout, env }));
  const symbols = canonicalTable(run(executable, ["-t", objectPath], { timeout, env }));
  return {
    object: objectPath, file_sha256: fileSha256(objectPath), objdump: executableIdentity([executable]),
    sections: rows, relocations_sha256: sha(relocations), symbols_sha256: sha(symbols),
  };
}

/** Compare the exact sections instrumentation is allowed to preserve. */
export function compareObjectFidelity(stock, instrumented, { objdump = null, sections = DEFAULT_SECTIONS, timeout = 10.0, env = process.env } = {}) {
  const expected = objectFidelityFingerprint(stock, { objdump, sections, timeout, env });
  const actual = objectFidelityFingerprint(instrumented, { objdump, sections, timeout, env });
  const eq = (a, b) => a.present === b.present && a.bytes === b.bytes && a.sha256 === b.sha256;
  const gates = {};
  for (const s of sections) gates[s] = eq(expected.sections[s], actual.sections[s]);
  gates.relocations = expected.relocations_sha256 === actual.relocations_sha256;
  gates.symbols = expected.symbols_sha256 === actual.symbols_sha256;
  return {
    schema: FIDELITY_SCHEMA,
    pass: Object.values(gates).every(Boolean),
    gates, stock: expected, instrumented: actual,
    file_identical: expected.file_sha256 === actual.file_sha256,
    proof: "Section-scoped fidelity. Whole-file differences may remain in unstable debug metadata and are reported separately.",
  };
}

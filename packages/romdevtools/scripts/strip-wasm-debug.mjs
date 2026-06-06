#!/usr/bin/env node
// strip-wasm-debug.mjs — remove DWARF/name CUSTOM sections from a .wasm file.
//
// emcc relinks at -O0 by default, which preserves the .debug_* and `name`
// custom sections carried in the input bitcode. For big tools (cc1-arm) that
// is ~95MB of dead weight in the shipped artifact. Custom sections are not
// referenced by the module's execution, so dropping them is safe and leaves
// code/data/types/etc. byte-identical. (The build now also passes -g0 so fresh
// builds are already lean; this script fixes an already-built artifact in place
// without an hours-long toolchain rebuild.)
//
// Usage: node strip-wasm-debug.mjs <file.wasm> [file2.wasm ...]
//   Strips .debug_*, the `name` section, and .debug_loc/ranges/etc.
//   Keeps `target_features` (tiny, and tools may inspect it). Writes in place.

import { readFileSync, writeFileSync } from "node:fs";

// Custom-section names to drop. Everything DWARF + the (large) name section.
const DROP = (name) => name.startsWith(".debug_") || name === "name";

/** Decode an unsigned LEB128 at offset; returns [value, bytesRead]. */
function uleb(buf, o) {
  let result = 0, shift = 0, bytes = 0, b;
  do { b = buf[o + bytes]; result |= (b & 0x7f) << shift; shift += 7; bytes++; } while (b & 0x80);
  return [result >>> 0, bytes];
}

function stripWasm(buf) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error("not a wasm module (bad magic)");
  const out = [buf.subarray(0, 8)]; // magic + version
  let o = 8;
  let dropped = 0, droppedBytes = 0;
  while (o < buf.length) {
    const id = buf[o];
    const [len, lenBytes] = uleb(buf, o + 1);
    const bodyStart = o + 1 + lenBytes;
    const sectionEnd = bodyStart + len;
    if (id === 0) {
      // Custom section: body begins with a name (uleb length + bytes).
      const [nameLen, nameLenBytes] = uleb(buf, bodyStart);
      const name = buf.toString("utf8", bodyStart + nameLenBytes, bodyStart + nameLenBytes + nameLen);
      if (DROP(name)) {
        dropped++; droppedBytes += sectionEnd - o;
        o = sectionEnd;
        continue;
      }
    }
    out.push(buf.subarray(o, sectionEnd));
    o = sectionEnd;
  }
  return { buf: Buffer.concat(out), dropped, droppedBytes };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node strip-wasm-debug.mjs <file.wasm> [...]");
  process.exit(1);
}
for (const f of files) {
  const before = readFileSync(f);
  const { buf, dropped, droppedBytes } = stripWasm(before);
  writeFileSync(f, buf);
  const mb = (n) => (n / 1e6).toFixed(1) + "MB";
  console.log(`${f}: ${mb(before.length)} → ${mb(buf.length)} (dropped ${dropped} custom sections, ${mb(droppedBytes)})`);
}

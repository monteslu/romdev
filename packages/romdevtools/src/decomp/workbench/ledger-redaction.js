// ledger-redaction.js - keep the target's instruction text out of ledger
// files. A campaign ledger is written automatically into the project tree, so
// it is redacted at its serialisation boundary: the in-memory comparison is
// untouched, and nothing that reaches a ledger can be turned back into target
// instruction text.
//
// The sweep is recursive over containers and default-deny over field names:
// any key naming the target side (any case, any leading punctuation) is
// dropped at any depth unless its value is a path; site records keep only an
// allow-list plus a 16-bit salted digest, a masked opcode for the first few
// sites, and register counts. It does not read string contents, which is why
// ledgers stay gitignored.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ValueError, sorted, hex } from "./py.js";
import { pyRepr } from "./pyrepr.js";

export const REDACTION_SCHEMA = "decomp-workbench-ledger-redaction-v1";
export const SITE_LISTS = Object.freeze(["diff_sites", "aligned_diff_sites", "register_diff", "relocation_target_differences"]);
export const SITE_KEEP = Object.freeze(new Set(["index", "class", "aligned_row", "target_index", "candidate", "candidate_word",
  "candidate_index", "candidate_registers", "instruction_index", "relocation_index", "candidate_instruction_offset"]));
export const DIGEST_HEX = 4;
export const MASKED_OPCODE_SITE_LIMIT = 3;
export const SALT_BYTES = 16;
export const MAX_DEPTH = 64;

// BLAKE2s (RFC 7693), keyed, with a caller-chosen digest length.
const IV = new Uint32Array([0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19]);
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function compress(h, block, t, last) {
  const v = new Uint32Array(16), m = new Uint32Array(16);
  for (let i = 0; i < 16; i++) m[i] = block[i * 4] | (block[i * 4 + 1] << 8) | (block[i * 4 + 2] << 16) | (block[i * 4 + 3] << 24);
  for (let i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = IV[i]; }
  v[12] ^= t >>> 0; v[13] ^= Math.floor(t / 0x100000000) >>> 0;
  if (last) v[14] = ~v[14] >>> 0;
  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) >>> 0; v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) >>> 0; v[b] = rotr(v[b] ^ v[c], 12);
    v[a] = (v[a] + v[b] + y) >>> 0; v[d] = rotr(v[d] ^ v[a], 8);
    v[c] = (v[c] + v[d]) >>> 0; v[b] = rotr(v[b] ^ v[c], 7);
  };
  for (let r = 0; r < 10; r++) {
    const s = SIGMA[r];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] = (h[i] ^ v[i] ^ v[i + 8]) >>> 0;
}

/** Keyed BLAKE2s digest (hex), `outlen` bytes. */
export function blake2s(data, { key = Buffer.alloc(0), outlen = 32 } = {}) {
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010000 ^ (key.length << 8) ^ outlen;
  const input = key.length ? Buffer.concat([Buffer.concat([key, Buffer.alloc(64 - key.length)]), Buffer.from(data)]) : Buffer.from(data);
  let t = 0, off = 0;
  const block = new Uint8Array(64);
  while (input.length - off > 64) { t += 64; compress(h, input.subarray(off, off + 64), t, false); off += 64; }
  block.fill(0); block.set(input.subarray(off));
  t += input.length - off;
  compress(h, block, t, true);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(h[i], i * 4);
  return out.subarray(0, outlen).toString("hex");
}

/** A warning if this ledger holds any pre-redaction records, else null. */
export function warnIfUnredacted(ledgerPath, { scan_lines = null } = {}) {
  const p = String(ledgerPath);
  let unredacted = 0, total = 0, truncated = false;
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  if (lines.length && lines.at(-1) === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (scan_lines !== null && i + 1 > scan_lines) { truncated = true; break; }
    const line = lines[i];
    if (!line.trim()) continue;
    total += 1;
    let record;
    try { record = JSON.parse(line); } catch { unredacted += 1; continue; }
    if (!record || typeof record !== "object" || Array.isArray(record) || !record.redaction || typeof record.redaction !== "object" || Array.isArray(record.redaction)) unredacted += 1;
  }
  if (!total || !unredacted) return null;
  const scope = truncated ? `the first ${total} record(s)` : `${total} record(s)`;
  return `warning: ${p} contains ${unredacted} of ${scope} written before ledger redaction. They carry the target ROM's `
    + "instruction text; only newly appended records are redacted. Treat the whole file as ROM-derived -- do not commit it, "
    + "and delete it or re-run the campaign for a clean ledger.";
}

/** The sidecar file holding this ledger's digest salt. */
export function saltPath(ledgerPath) { const p = String(ledgerPath); return path.join(path.dirname(p), path.basename(p) + ".salt"); }

const fromHex = (raw) => { if (!/^([0-9a-fA-F]{2})*$/.test(raw)) throw new ValueError("non-hex"); return Buffer.from(raw, "hex"); };

/** This ledger's salt, generated on first use (0600, beside the ledger). */
export function loadOrCreateSalt(ledgerPath) {
  const p = saltPath(ledgerPath);
  try { const raw = fs.readFileSync(p, "utf8").trim(); if (raw) return fromHex(raw); } catch { /* create */ }
  const salt = randomBytes(SALT_BYTES);
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  let fd;
  try { fd = fs.openSync(p, "wx", 0o600); } catch (e) { if (e.code === "EEXIST") return fromHex(fs.readFileSync(p, "utf8").trim()); throw e; }
  try { fs.writeSync(fd, salt.toString("hex")); } finally { fs.closeSync(fd); }
  return salt;
}

/** The lossy salted digest of one target word or assembly string. */
export function digestTarget(value, salt) {
  const text = typeof value === "string" ? value : pyRepr(value);
  return blake2s(Buffer.from(text, "utf8"), { key: Buffer.from(salt), outlen: 8 }).slice(0, DIGEST_HEX);
}

/** `word` with all operand fields zeroed, or null if it will not parse. */
export function maskOpcode(word) {
  if (typeof word !== "string") return null;
  const s = word.trim().replace(/_/g, "").replace(/^0[xX]/, "");
  if (!/^[+-]?[0-9a-fA-F]+$/.test(s)) return null;
  const value = parseInt(s, 16);
  if (value < 0 || value > 0xFFFFFFFF) return null;
  const opcode = Math.floor(value / 2 ** 26) & 0x3F;
  let masked = opcode * 2 ** 26;
  if (opcode === 0x00) masked += value & 0x3F;
  else if (opcode === 0x01) masked += value & 0x001F0000;
  return hex(masked, 8);
}

/** Raised when a record cannot be redacted safely. */
export class RedactionError extends ValueError { constructor(message) { super(message); this.kind = "RedactionError"; } }

const KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const OBJECT_SUFFIXES = [".o", ".obj", ".elf", ".a", ".ko", ".so"];

function isTargetKey(key) {
  if (typeof key !== "string") return false;
  return key.toLowerCase().replace(/^[_\-. ]+/, "").startsWith("target");
}

function isPathLike(value) {
  if (typeof value !== "string" || !value) return false;
  if (value.length > 4096 || /\s/.test(value)) return false;
  return value.includes("/") || OBJECT_SUFFIXES.some((s) => value.endsWith(s));
}

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Set);

/** A copy of one diff-site record with the target side masked. */
export function redactSite(site, salt, { mask_opcodes, depth = 0 }) {
  const out = {};
  for (const [k, v] of Object.entries(site)) if (SITE_KEEP.has(k)) out[k] = sweep(v, salt, false, 0, depth + 1);
  const dropped = sorted(Object.keys(site).filter((k) => !SITE_KEEP.has(k)));
  if (dropped.length) out.dropped_fields = dropped;
  const word = site.target_word, text = site.target;
  const source = typeof word === "string" && word ? word : text;
  if (typeof source === "string" && source) out.target_digest = digestTarget(source, salt);
  if (mask_opcodes) { const m = maskOpcode(word); if (m !== null) out.target_opcode_masked = m; }
  if (Array.isArray(site.target_registers)) out.target_register_count = site.target_registers.length;
  return out;
}

function sweep(node, salt, inSiteList, position, depth = 0) {
  if (depth > MAX_DEPTH) throw new RedactionError(`ledger record nests deeper than ${MAX_DEPTH} levels; refusing to write a record the redactor cannot fully traverse`);
  if (Array.isArray(node)) return node.map((item, i) => sweep(item, salt, inSiteList, i, depth + 1));
  if (node instanceof Set) return new Set([...node].map((item) => sweep(item, salt, false, 0, depth + 1)));
  if (!isDict(node)) return node;
  if (inSiteList) return redactSite(node, salt, { mask_opcodes: position < MASKED_OPCODE_SITE_LIMIT, depth });
  const out = {};
  const dropped = [];
  for (const [key, value] of Object.entries(node)) {
    if (!KEY_SHAPE.test(key)) { dropped.push("<str key of unexpected shape>"); continue; }
    if (isTargetKey(key) && !isPathLike(value)) { dropped.push(key); continue; }
    out[key] = sweep(value, salt, SITE_LISTS.includes(key), 0, depth + 1);
  }
  if (dropped.length) out.dropped_fields = sorted([...new Set([...(out.dropped_fields || []), ...dropped])]);
  return out;
}

/** `comparison` with every target-side field removed, at any depth. */
export function redactComparison(comparison, salt) { return sweep(comparison, salt, false, 0); }

/** One ledger record with the target's instruction text removed. */
export function redactRecord(record, salt) {
  const out = sweep(record, salt, false, 0);
  out.redaction = { schema: REDACTION_SCHEMA, digest_bits: DIGEST_HEX * 4, masked_opcode_sites: MASKED_OPCODE_SITE_LIMIT };
  return out;
}

// scratch-check.js - safe, upload-neutral inspection of decomp.me exports and
// workbench bundles. ZIP members are never extracted: the small, bounded
// export is held in memory, which makes path traversal impossible and gives
// directories and ZIPs the same validation path.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, strRepr, sorted } from "./py.js";
import { ZipFile, BadZipFile } from "./zipfile.js";
import { splitCommand } from "./command-line.js";
import { analyzeExpression, fileScopeDefinitions, lintSources } from "./context-lint.js";

export const MAX_FILES = 64;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const DECOMP_ME_METADATA = "metadata.json";
export const WORKBENCH_MANIFEST = "scratch.json";
export const SITE_SOURCE_MARKER = '#line 1 "src.c"\n';
export const SITE_CXX_SOURCE_MARKER = '#line 1 "src.cxx"\n';
export const DECOMP_ME_SOURCE_SUFFIXES = [".c", ".c++", ".cc", ".cpp", ".cxx"];

const casefold = (s) => s.toLowerCase();
const expanduser = (p) => (p === "~" || String(p).startsWith("~/") ? (process.env.HOME ?? "") + String(p).slice(1) : String(p));
const resolve = (p) => { try { return fs.realpathSync(path.resolve(expanduser(p))); } catch { return path.resolve(expanduser(p)); } };

/** One validated scratch export held in memory. `files` is a Map name -> Buffer. */
export class ScratchPackage {
  constructor({ path: p, kind, files, metadata, checksums_valid }) {
    Object.assign(this, { path: p, kind, files, metadata, checksums_valid });
  }

  /** Decode one required text member as UTF-8. */
  text(name) {
    if (!this.files.has(name)) throw new ValueError(`scratch is missing ${name}`);
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.files.get(name)); }
    catch { throw new ValueError(`scratch member is not UTF-8 text: ${name}`); }
  }

  /** Write one validated member to a caller-owned directory. */
  materialize(name, directory) {
    if (!this.files.has(name)) throw new ValueError(`scratch is missing ${name}`);
    const destination = path.join(directory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, this.files.get(name));
    return destination;
  }

  /** Useful, bounded metadata without reproducing owner records. */
  publicMetadata() {
    if (this.kind === "decomp.me-export") {
      const keys = ["slug", "parent", "name", "language", "platform", "compiler", "compiler_flags", "preset", "diff_label", "score", "max_score", "match_override", "creation_time", "last_updated"];
      const out = {};
      for (const k of keys) if (Object.prototype.hasOwnProperty.call(this.metadata, k)) out[k] = this.metadata[k];
      return out;
    }
    const decompMe = this.metadata.decomp_me;
    const result = { schema: this.metadata.schema ?? null };
    if (decompMe && typeof decompMe === "object" && !Array.isArray(decompMe)) result.decomp_me = decompMe;
    if ("project" in this.metadata) result.project = this.metadata.project;
    return result;
  }
}

function posixParts(p) { return p.split("/").filter((x) => x && x !== "."); }

/** A normalized member path, rejecting traversal and odd archives. */
function safeMemberPath(rawName) {
  const normalized = rawName.replace(/\\/g, "/");
  if (!rawName || rawName.endsWith("/")) return null;
  const parts = posixParts(normalized);
  if (normalized.startsWith("/") || parts.includes("..")) throw new ValueError(`unsafe scratch member path: ${strRepr(rawName)}`);
  if (!parts.length) throw new ValueError(`invalid scratch member path: ${strRepr(rawName)}`);
  return { name: parts[parts.length - 1], parent: parts.slice(0, -1).join("/") || "." };
}

function validateMemberSet(files) {
  if (!files.size) throw new ValueError("scratch contains no files");
  if (files.size > MAX_FILES) throw new ValueError(`scratch contains more than ${MAX_FILES} files`);
  let total = 0;
  for (const c of files.values()) total += c.length;
  if (total > MAX_TOTAL_BYTES) throw new ValueError(`scratch exceeds the ${Math.floor(MAX_TOTAL_BYTES / (1024 * 1024))} MiB size limit`);
}

function readZip(p) {
  const files = new Map();
  const folded = new Set();
  const parents = new Set();
  let archive;
  try {
    archive = new ZipFile(p);
    const members = archive.infolist().filter((i) => !i.isDir());
    if (members.length > MAX_FILES) throw new ValueError(`scratch contains more than ${MAX_FILES} files`);
    let total = 0;
    for (const member of members) {
      const mp = safeMemberPath(member.filename);
      if (mp === null) continue;
      const name = mp.name;
      parents.add(mp.parent);
      if (member.flag_bits & 0x1) throw new ValueError(`encrypted scratch member is not supported: ${name}`);
      if (member.file_size > MAX_FILE_BYTES) throw new ValueError(`scratch member exceeds the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MiB limit: ${name}`);
      total += member.file_size;
      if (total > MAX_TOTAL_BYTES) throw new ValueError(`scratch exceeds the ${Math.floor(MAX_TOTAL_BYTES / (1024 * 1024))} MiB size limit`);
      const f = casefold(name);
      if (folded.has(f)) throw new ValueError(`duplicate scratch member basename: ${name}`);
      folded.add(f);
      files.set(name, archive.read(member));
    }
    if (parents.size > 1) {
      throw new ValueError(`scratch ZIP members must share one flat directory; found: ${sorted([...parents]).join(", ")}`);
    }
  } catch (e) {
    if (e instanceof BadZipFile) throw new ValueError(`not a valid ZIP archive: ${p}`);
    throw e;
  }
  validateMemberSet(files);
  return files;
}

function readDirectory(p) {
  const files = new Map();
  const folded = new Set();
  const all = fs.readdirSync(p).map((n) => path.join(p, n));
  const links = all.filter((x) => fs.lstatSync(x).isSymbolicLink());
  if (links.length) throw new ValueError(`scratch directory cannot contain symbolic links: ${path.basename(links[0])}`);
  const nested = all.filter((x) => fs.statSync(x).isDirectory());
  if (nested.length) throw new ValueError(`scratch directory must be flat; found nested directory: ${path.basename(nested[0])}`);
  const entries = all.filter((x) => fs.statSync(x).isFile());
  if (entries.length > MAX_FILES) throw new ValueError(`scratch contains more than ${MAX_FILES} files`);
  for (const item of entries) {
    const size = fs.statSync(item).size;
    const name = path.basename(item);
    if (size > MAX_FILE_BYTES) throw new ValueError(`scratch member exceeds the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MiB limit: ${name}`);
    const f = casefold(name);
    if (folded.has(f)) throw new ValueError(`duplicate scratch member basename: ${name}`);
    folded.add(f);
    files.set(name, fs.readFileSync(item));
  }
  validateMemberSet(files);
  return files;
}

function parseJson(files, name) {
  let raw;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(files.get(name)); } catch { throw new ValueError(`${name} is not UTF-8 JSON`); }
  let value;
  try { value = JSON.parse(raw); } catch (e) { throw new ValueError(`${name} is not valid JSON: ${jsonMsg(raw)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValueError(`${name} must contain a JSON object`);
  return value;
}

/** The original parser's short message (`msg`) for a decode failure. */
function jsonMsg(raw) {
  if (!raw.trim()) return "Expecting value";
  try { JSON.parse(raw); } catch (e) {
    const m = String(e.message);
    if (/Unexpected end/i.test(m)) return "Expecting value";
    if (/Expected property name/i.test(m)) return "Expecting property name enclosed in double quotes";
    if (/Unexpected non-whitespace character after JSON/i.test(m)) return "Extra data";
    if (/Expected ',' or '}'/i.test(m)) return "Expecting ',' delimiter";
    if (/Expected ':'/i.test(m)) return "Expecting ':' delimiter";
  }
  return "Expecting value";
}

function canonicalizeDecompMeSources(files) {
  const pairs = DECOMP_ME_SOURCE_SUFFIXES.map((s) => [`code${s}`, `ctx${s}`]).filter(([c, x]) => files.has(c) && files.has(x));
  if (!pairs.length) {
    throw new ValueError(`decomp.me export is missing a source pair (${DECOMP_ME_SOURCE_SUFFIXES.map((s) => `code${s}/ctx${s}`).join(", ")})`);
  }
  if (pairs.length > 1) throw new ValueError(`decomp.me export has ambiguous source pairs: ${pairs.map(([c, x]) => `${c}/${x}`).join(", ")}`);
  const [codeName, contextName] = pairs[0];
  const canonical = new Map(files);
  if (codeName !== "code.c") { canonical.delete(codeName); canonical.set("code.c", files.get(codeName)); }
  if (contextName !== "ctx.c") { canonical.delete(contextName); canonical.set("ctx.c", files.get(contextName)); }
  return canonical;
}

const isNumber = (v) => typeof v === "number";

function validateDecompMe(files, metadata) {
  for (const key of ["platform", "compiler", "diff_label"]) {
    const v = metadata[key];
    if (v !== undefined && v !== null && typeof v !== "string") throw new ValueError(`metadata field ${strRepr(key)} must be a string`);
  }
  for (const key of ["score", "max_score"]) {
    const v = metadata[key];
    if (v !== undefined && v !== null && (!isNumber(v) || !Number.isFinite(v))) throw new ValueError(`metadata field ${strRepr(key)} must be a finite number`);
  }
  const score = metadata.score, maximum = metadata.max_score;
  if (isNumber(maximum) && maximum <= 0) throw new ValueError("metadata field 'max_score' must be positive");
  if (isNumber(score) && score < 0) throw new ValueError("metadata field 'score' cannot be negative");
  if (isNumber(score) && isNumber(maximum) && score > maximum) throw new ValueError("metadata field 'score' cannot exceed 'max_score'");
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function validateBundle(files, manifest) {
  if (manifest.schema !== "decomp-workbench-scratch-bundle-v1") throw new ValueError("unsupported workbench scratch bundle schema");
  const recorded = manifest.files;
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded) || !Object.keys(recorded).length) throw new ValueError("scratch.json has no file checksums");
  for (const [name, details] of Object.entries(recorded)) {
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new ValueError("scratch.json contains an invalid file record");
    const base = posixParts(name).pop() ?? "";
    if (base !== name) throw new ValueError(`scratch.json has an invalid file name: ${strRepr(name)}`);
    const expected = details.sha256;
    if (typeof expected !== "string" || !/^[0-9a-fA-F]{64}$/.test(expected)) throw new ValueError(`scratch.json has an invalid SHA-256 for ${name}`);
    if (!files.has(name)) throw new ValueError(`workbench bundle is missing ${name}`);
    if (sha256(files.get(name)) !== expected.toLowerCase()) throw new ValueError(`workbench bundle checksum mismatch: ${name}`);
  }
  return true;
}

/** Load and validate a decomp.me export ZIP/directory or workbench bundle. */
export function loadScratch(p) {
  const resolved = resolve(p);
  let files;
  let st = null;
  try { st = fs.statSync(resolved); } catch { st = null; }
  if (st?.isDirectory()) files = readDirectory(resolved);
  else if (st?.isFile()) files = readZip(resolved);
  else throw new ValueError(`scratch path does not exist: ${resolved}`);
  if (files.has(DECOMP_ME_METADATA)) {
    const metadata = parseJson(files, DECOMP_ME_METADATA);
    files = canonicalizeDecompMeSources(files);
    validateDecompMe(files, metadata);
    return new ScratchPackage({ path: resolved, kind: "decomp.me-export", files, metadata, checksums_valid: null });
  }
  if (files.has(WORKBENCH_MANIFEST)) {
    const manifest = parseJson(files, WORKBENCH_MANIFEST);
    const checksumsValid = validateBundle(files, manifest);
    return new ScratchPackage({ path: resolved, kind: "workbench-bundle", files, metadata: manifest, checksums_valid: checksumsValid });
  }
  throw new ValueError("unrecognized scratch: expected metadata.json or scratch.json");
}

/** The selected language/frontend, without conflating a preset with it. */
export function scratchFrontend(pkg) {
  let metadata;
  if (pkg.kind === "workbench-bundle") {
    const s = pkg.metadata.decomp_me;
    metadata = s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } else metadata = pkg.metadata;
  const compiler = typeof metadata.compiler === "string" ? metadata.compiler : null;
  const compilerId = typeof metadata.compiler_id === "string" ? metadata.compiler_id : pkg.kind === "decomp.me-export" ? compiler : null;
  const language = typeof metadata.language === "string" ? metadata.language : null;
  const normalizedLanguage = language ? casefold(language) : "";
  const normalizedCompiler = casefold(compilerId || compiler || "");
  const cxx = normalizedLanguage.includes("++") || ["cxx", "cpp", "old_cxx"].includes(normalizedLanguage) || normalizedCompiler.endsWith("_c++");
  const sourceName = cxx ? "src.cxx" : "src.c";
  let driver = null, frontend = null;
  if (normalizedCompiler.startsWith("ido") && (normalizedCompiler.endsWith("_c++") || cxx)) { driver = "NCC"; frontend = "EDG C++"; }
  else if (normalizedCompiler.startsWith("ido")) { driver = "cc"; frontend = "cfe C"; }
  return { compiler, compiler_id: compilerId, language: language || (cxx ? "C++" : null), frontend, expected_driver: driver, source_name: sourceName, line_reset: `#line 1 "${sourceName}"` };
}

/** decomp.me's editable-source marker for the selected language. */
export function siteSourceMarker(pkg) { return `#line 1 "${scratchFrontend(pkg).source_name}"\n`; }

/** Context plus source with decomp.me's language-aware source line reset. */
export function composeSiteSource(pkg, source) {
  if (pkg.kind !== "decomp.me-export") throw new ValueError("site-faithful compilation requires a decomp.me export");
  const context = pkg.text("ctx.c");
  let candidate;
  if (source === null || source === undefined) candidate = pkg.text("code.c");
  else {
    const sourcePath = resolve(source);
    let st = null;
    try { st = fs.statSync(sourcePath); } catch { st = null; }
    if (!st?.isFile()) throw new ValueError(`candidate source is not a file: ${sourcePath}`);
    try { candidate = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(sourcePath)); }
    catch { throw new ValueError(`candidate source is not UTF-8 text: ${sourcePath}`); }
  }
  const separator = context.endsWith("\n") ? "" : "\n";
  return context + separator + siteSourceMarker(pkg) + candidate;
}

/** decomp.me's distance and percentage as context, never as truth. */
export function scratchScore(metadata) {
  const score = metadata.score, maximum = metadata.max_score;
  if (!isNumber(score) || !isNumber(maximum) || maximum <= 0) return null;
  return { score: score, max_score: maximum, percentage: 100.0 * (1.0 - score / maximum) };
}

/** Deprecated compatibility hook; decomp.me's source boundary is safe. */
export function contextNewlineWarning(_context) { return null; }

const BROKEN_SPLICE = /\\[ \t]+$/;

/** Line-splice hazards in code.c before a paste silently loses them. */
export function codeSpliceReport(code) {
  const broken = [], loadBearing = [];
  let inDirective = false, continuing = false;
  code.split("\n").forEach((line, i) => {
    const number = i + 1;
    if (!continuing) inDirective = line.replace(/^[\s]+/, "").startsWith("#");
    const splices = line.endsWith("\\");
    if (BROKEN_SPLICE.test(line)) broken.push(number);
    else if (splices && !inDirective) loadBearing.push(number);
    continuing = splices;
  });
  return { broken, load_bearing: loadBearing };
}

/** Names defined at file scope in both ctx.c and code.c. */
export function duplicateFileScopeSymbols(context, code) {
  const ctxNames = fileScopeDefinitions(context), codeNames = fileScopeDefinitions(code);
  const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);
  const keys = (m) => (m instanceof Map ? [...m.keys()] : Object.keys(m));
  const codeSet = new Set(keys(codeNames));
  return sorted(keys(ctxNames).filter((n) => codeSet.has(n))).map((name) => ({ symbol: name, ctx_line: get(ctxNames, name), code_line: get(codeNames, name) }));
}

/** Seed the context lint's macro table from metadata.json's -D flags. */
export function definesFromCompilerFlags(flags) {
  if (typeof flags !== "string") return new Map();
  let tokens;
  try { tokens = splitCommand(flags); } catch (e) { if (e?.name === "ValueError" || e instanceof ValueError) return new Map(); throw e; }
  const result = new Map();
  for (const token of tokens) {
    if (!token.startsWith("-D") || token.length <= 2) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq < 0 ? body : body.slice(0, eq);
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    if (eq < 0) { result.set(name, null); continue; }
    const analysis = analyzeExpression(body.slice(eq + 1), result);
    result.set(name, analysis.ok ? analysis.value : null);
  }
  return result;
}

/** The ctx.c/code.c checks that catch the two known paste traps. */
export function scratchContextHardening(pkg) {
  if (pkg.kind !== "decomp.me-export") return { applicable: false };
  const context = pkg.text("ctx.c"), code = pkg.text("code.c");
  const defines = definesFromCompilerFlags(pkg.metadata.compiler_flags);
  const report = lintSources([["ctx.c", context], ["code.c", code]], defines);
  return {
    applicable: true,
    context_newline_warning: contextNewlineWarning(context),
    duplicate_symbols: duplicateFileScopeSymbols(context, code),
    code_splices: codeSpliceReport(code),
    context_lint: report.asDict(),
  };
}

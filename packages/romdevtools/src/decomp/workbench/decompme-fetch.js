// decompme-fetch.js - fetch one decomp.me scratch export into the standard
// local layout. The archive is downloaded once, validated with exactly the
// loader that reads a local export, and then written out; a scratch already
// fetched is reported and never fetched again.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, strRepr, sorted } from "./py.js";
import { loadScratch } from "./scratch-check.js";

export const DEFAULT_API_BASE = "https://decomp.me/api";
export const FETCH_SCHEMA = "decomp-workbench-scratch-fetch-v1";
export const EXPORT_MEMBERS = ["metadata.json", "ctx.c", "code.c", "target.o", "target.s"];
export const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ACCEPT_ARCHIVE = "application/zip, application/octet-stream";

/** Parse a URL the way the original's urlparse split it (scheme, netloc, path). */
export function urlParts(text) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)/.exec(text);
  if (!m) return { scheme: "", netloc: "", path: text.split(/[?#]/)[0] };
  return { scheme: m[1].toLowerCase(), netloc: m[3] ?? "", path: m[4] ?? "" };
}

/** The slug named by `value`, which may be a slug or a scratch URL. */
export function scratchSlug(value) {
  let text = value.trim();
  if (!text) throw new ValueError("scratch slug is empty");
  if (text.includes("://")) {
    let parts = urlParts(text).path.split("/").filter(Boolean);
    const i = parts.indexOf("scratch");
    if (i >= 0) parts = parts.slice(i + 1);
    text = parts.length ? parts[0] : "";
  }
  if (!SLUG_RE.test(text)) throw new ValueError(`not a decomp.me scratch slug: ${strRepr(value)}. Pass the slug (for example 'aBcDe') or the scratch URL.`);
  return text;
}

export function exportUrl(slug, { api_base = DEFAULT_API_BASE } = {}) { return `${api_base.replace(/\/+$/, "")}/scratch/${slug}/export`; }

/** The human page for `slug`, derived from the API base. */
export function scratchUrl(slug, { api_base = DEFAULT_API_BASE } = {}) {
  const p = urlParts(api_base);
  const origin = p.netloc ? `${p.scheme}://${p.netloc}` : "https://decomp.me";
  return `${origin}/scratch/${slug}`;
}

const digest = (b) => createHash("sha256").update(b).digest("hex");

function describe(pkg, destination, archive) {
  const files = {};
  for (const name of sorted([...pkg.files.keys()])) {
    const content = pkg.files.get(name);
    files[name] = { bytes: content.length, sha256: digest(content) };
  }
  return {
    schema: FETCH_SCHEMA, output: destination, archive: fs.existsSync(archive) ? archive : null, files,
    missing_members: EXPORT_MEMBERS.filter((n) => !pkg.files.has(n)), metadata: pkg.publicMetadata(),
  };
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const nonEmpty = (p) => { try { return fs.readdirSync(p).length > 0; } catch { return false; } };

function existingExport(destination) {
  if (!isDir(destination) || !nonEmpty(destination)) return null;
  let pkg;
  try { pkg = loadScratch(destination); } catch (e) { if (e instanceof ValueError || e?.name === "ValueError") return null; throw e; }
  return pkg.kind === "decomp.me-export" ? pkg : null;
}

function nextActions(destination) {
  return [{ why: "validate the export and read its truth stack locally", command_argv: ["decomp-workbench", "check-scratch", destination] }];
}

function resolveDir(p) {
  const e = p === "~" || p.startsWith("~/") ? (process.env.HOME ?? "") + p.slice(1) : p;
  const abs = path.resolve(e);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

/** Download and unpack one export, or report the copy already on disk. */
export async function fetchScratch(slug, { client, outdir = ".", api_base = DEFAULT_API_BASE, force = false, keep_archive = true }) {
  slug = scratchSlug(slug);
  const root = resolveDir(outdir);
  const destination = path.join(root, slug);
  const archive = path.join(root, `${slug}.zip`);
  const source = exportUrl(slug, { api_base });
  if (!force) {
    const cached = existingExport(destination);
    if (cached !== null) {
      const report = describe(cached, destination, archive);
      Object.assign(report, { slug, source_url: source, reused: true });
      report.next_actions = nextActions(destination);
      return report;
    }
    if (fs.existsSync(destination) && nonEmpty(destination)) {
      throw new ValueError(`${destination} already exists and is not a decomp.me export. Choose another --outdir, or remove it and re-run.`);
    }
  }
  fs.mkdirSync(root, { recursive: true });
  const body = (await client.get(source, { accept: ACCEPT_ARCHIVE })).body;
  const stagingArchive = path.join(root, `.${slug}.zip.partial`);
  const stagingDir = path.join(root, `.${slug}.partial`);
  try {
    fs.writeFileSync(stagingArchive, body);
    const pkg = loadScratch(stagingArchive);
    if (pkg.kind !== "decomp.me-export") throw new ValueError(`${source} did not return a decomp.me export (no metadata.json in the archive).`);
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    for (const name of pkg.files.keys()) pkg.materialize(name, stagingDir);
    if (fs.existsSync(destination)) {
      if (existingExport(destination) === null && nonEmpty(destination)) throw new ValueError(`refusing to replace ${destination}: it is not a decomp.me export.`);
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, destination);
    if (keep_archive) fs.renameSync(stagingArchive, archive);
  } finally {
    for (const leftover of [stagingArchive, stagingDir]) {
      if (isDir(leftover)) fs.rmSync(leftover, { recursive: true, force: true });
      else if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
    }
  }
  const unpacked = loadScratch(destination);
  const report = describe(unpacked, destination, archive);
  Object.assign(report, { slug, source_url: source, reused: false });
  report.next_actions = nextActions(destination);
  return report;
}

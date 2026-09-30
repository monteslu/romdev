// relocation-identity.js - declarative, project-supplied identities for
// relocation sites. The workbench does not parse a project's overlay atlas:
// a project provider translates its own ownership model into this code-free
// schema, and this module validates it and joins it to the relocation
// surface by exact site, never by a synthetic VMA or a row position.
//
// Plain JS ESM + JSDoc.

import { ValueError, pyInt, strip, strRepr, sorted } from "./py.js";

export const IDENTITY_PROVIDER_SCHEMA = "decomp-workbench-relocation-identities-v1";
export const IDENTITY_REPORT_SCHEMA = "decomp-workbench-relocation-identity-report-v1";
export const STATUSES = Object.freeze(["resolved", "unknown", "contradicted"]);

/** One exact object relocation site. */
export class SiteKey {
  constructor({ object, section, offset, type, symbol }) { Object.assign(this, { object, section, offset, type, symbol }); Object.freeze(this); }
  static fromSite(site) { return new SiteKey({ object: site.object, section: site.section, offset: site.object_offset, type: site.type, symbol: site.symbol }); }
  /** The dataclass repr, which orders unused provider entries. */
  repr() { return `SiteKey(object=${strRepr(this.object)}, section=${strRepr(this.section)}, offset=${this.offset}, type=${this.type}, symbol=${strRepr(this.symbol)})`; }
  get id() { return JSON.stringify([this.object, this.section, this.offset, this.type, this.symbol]); }
}

export class RelocationIdentity {
  constructor({ key, status, namespace = null, module = null, section = null, offset = null, addend = 0, evidence = "" }) {
    Object.assign(this, { key, status, namespace, module, section, offset, addend, evidence });
    Object.freeze(this);
  }
  asDict() {
    const identity = this.status === "resolved"
      ? { namespace: this.namespace, module: this.module, section: this.section, offset: this.offset, addend: this.addend } : null;
    return { object: this.key.object, section: this.key.section, object_offset: this.key.offset, type: this.key.type, symbol: this.key.symbol,
      status: this.status, identity, evidence: this.evidence };
  }
}

function integer(value, where) {
  if (typeof value === "boolean") throw new ValueError(`${where} must be an integer, not a boolean`);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") { try { return pyInt(value, 0); } catch { /* fall through */ } }
  throw new ValueError(`${where} must be an integer or 0x-prefixed integer string`);
}

function text(value, where, required = true) {
  if ((value === null || value === undefined) && !required) return null;
  if (typeof value !== "string" || !strip(value)) throw new ValueError(`${where} must be a non-empty string`);
  return strip(value);
}

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate one provider result; a Map keyed by SiteKey.id. */
export function parseIdentityProvider(value) {
  if (!isMapping(value) || value.schema !== IDENTITY_PROVIDER_SCHEMA) throw new ValueError(`identity provider schema must be ${IDENTITY_PROVIDER_SCHEMA}`);
  const entries = value.entries;
  if (!Array.isArray(entries)) throw new ValueError("identity provider entries must be a list");
  const result = new Map();
  entries.forEach((raw, index) => {
    const where = `identity provider entry ${index}`;
    if (!isMapping(raw)) throw new ValueError(`${where} must be an object`);
    const key = new SiteKey({ object: text(raw.object, `${where}.object`) || "", section: text(raw.section, `${where}.section`) || "",
      offset: integer(raw.object_offset, `${where}.object_offset`), type: integer(raw.type, `${where}.type`), symbol: text(raw.symbol, `${where}.symbol`) || "" });
    if (key.offset < 0 || key.type < 0) throw new ValueError(`${where} contains a negative offset or type`);
    if (result.has(key.id)) throw new ValueError(`${where} duplicates an exact relocation site`);
    const status = text(raw.status, `${where}.status`) || "";
    if (!STATUSES.includes(status)) throw new ValueError(`${where}.status must be resolved, unknown, or contradicted`);
    const identityRaw = raw.identity ?? null;
    let namespace = null, module = null, identitySection = null, identityOffset = null, addend = 0;
    if (status === "resolved") {
      if (!isMapping(identityRaw)) throw new ValueError(`${where}.identity is required when status=resolved`);
      namespace = text(identityRaw.namespace, `${where}.identity.namespace`);
      module = text(identityRaw.module, `${where}.identity.module`);
      identitySection = text(identityRaw.section, `${where}.identity.section`);
      identityOffset = integer(identityRaw.offset, `${where}.identity.offset`);
      addend = integer("addend" in identityRaw ? identityRaw.addend : 0, `${where}.identity.addend`);
      if (identityOffset < 0) throw new ValueError(`${where}.identity.offset must be non-negative`);
    } else if (identityRaw !== null) throw new ValueError(`${where}.identity is allowed only when status=resolved`);
    result.set(key.id, new RelocationIdentity({ key, status, namespace, module, section: identitySection, offset: identityOffset, addend,
      evidence: text("evidence" in raw ? raw.evidence : "", `${where}.evidence`, false) || "" }));
  });
  return result;
}

/** Join exact sites, distinguishing absent knowledge from contradiction. */
export function identityReport(sites, provider) {
  const rows = [];
  const consumed = new Set();
  const counts = { resolved: 0, unknown: 0, contradicted: 0 };
  for (const site of sites) {
    const key = SiteKey.fromSite(site);
    const supplied = provider.get(key.id);
    let row;
    if (supplied === undefined) row = new RelocationIdentity({ key, status: "unknown" });
    else { row = supplied; consumed.add(key.id); }
    counts[row.status] += 1;
    rows.push(row.asDict());
  }
  const unused = sorted([...provider.entries()].filter(([id]) => !consumed.has(id)).map(([, v]) => v), (v) => v.key.repr()).map((v) => v.asDict());
  return {
    schema: IDENTITY_REPORT_SCHEMA, sites: sites.length, resolved: counts.resolved, unknown: counts.unknown, contradicted: counts.contradicted,
    complete: sites.length > 0 && counts.resolved === sites.length && counts.contradicted === 0, entries: rows, unused_provider_entries: unused,
  };
}

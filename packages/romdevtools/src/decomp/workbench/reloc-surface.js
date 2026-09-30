// reloc-surface.js - synthesize a module's relocation surface from the
// shipped image. A module that ships unrelocated stores the relocation
// record's addend at each site, not a final address, so for a candidate
// whose schedule agrees at the site every placeholder symbol's linker value
// is READ from the image:
//   R_MIPS_26          (vma & 0xF0000000) | (stored_imm26 << 2)
//   R_MIPS_HI16+LO16   (stored_hi << 16) + sext16(stored_lo)
//   R_MIPS_32          stored_word
// minus the addend the object's own instruction already carries. Two sites
// of one symbol that demand different values are refused by name (the
// schedule diverged at the site), never averaged. Pure functions; nothing
// builds or links.
//
// Plain JS ESM + JSDoc.

import { SHN_UNDEF, rMipsName } from "./elf.js";
import { ValueError, pyInt, strip, strRepr, sorted, hex, splitlines, pyStr } from "./py.js";

export const SURFACE_SCHEMA = "decomp-workbench-reloc-surface-v1";
export const MODULE_MAP_SCHEMA = "decomp-workbench-module-map-v1";
export const R_MIPS_32 = 2, R_MIPS_26 = 4, R_MIPS_HI16 = 5, R_MIPS_LO16 = 6;
export const SUPPORTED_TYPES = Object.freeze(new Set([R_MIPS_32, R_MIPS_26, R_MIPS_HI16, R_MIPS_LO16]));
export const STB_GLOBAL = 1, STB_WEAK = 2, STT_FUNC = 2;
export const LINKABLE_BINDINGS = Object.freeze(new Set([STB_GLOBAL, STB_WEAK]));
export const ASSIGNMENT_RE = /^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>[^;]+?)\s*;/;

const U32 = 2 ** 32;
const u32 = (x) => ((x % U32) + U32) % U32;
const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeNameOf = (v) => (typeof v === "number" ? (Number.isInteger(v) ? "int" : "float") : Array.isArray(v) ? "list" : v === null || v === undefined ? "NoneType" : typeof v === "object" ? "dict" : typeof v === "string" ? "str" : typeof v);

/** The module section map is missing, malformed, or self-inconsistent. */
export class ModuleMapError extends ValueError {}

export class SectionRange {
  constructor({ name, offset, size }) { Object.assign(this, { name, offset, size }); Object.freeze(this); }
  get end() { return this.offset + this.size; }
  contains(moduleOffset, width = 1) { return this.offset <= moduleOffset && moduleOffset + width <= this.end; }
  asDict() { return { name: this.name, offset: this.offset, size: this.size }; }
}

/** Where one object's section sits inside the module (module-relative). */
export class Placement {
  constructor({ object, section, offset, size = null }) { Object.assign(this, { object, section, offset, size }); Object.freeze(this); }
  get end() { return this.size === null ? null : this.offset + this.size; }
  asDict() { return { object: this.object, section: this.section, offset: this.offset, size: this.size }; }
}

/** One entry of the module's own shipped relocation table. */
export class TableSite {
  constructor({ offset, type = null }) { Object.assign(this, { offset, type }); Object.freeze(this); }
  asDict() { return { offset: this.offset, type: this.type, kind: this.type === null ? null : rMipsName(this.type) }; }
}

const basename = (p) => p.replace(/\\/g, "/").split("/").at(-1);

export class ModuleMap {
  constructor({ name, image_start, image_end, synthetic_vma = 0, sections = [], placements = [], table_sites = [], alias_template = null }) {
    Object.assign(this, { name, image_start, image_end, synthetic_vma, sections, placements, table_sites, alias_template });
    Object.freeze(this);
  }
  section(name) { return this.sections.find((s) => s.name === name) ?? null; }
  placementsFor(objectName) {
    const base = basename(objectName);
    return this.placements.filter((p) => p.object === objectName || basename(p.object) === base);
  }
  imageOffset(moduleOffset) { return this.image_start + moduleOffset; }
  asDict() {
    return { name: this.name, image_start: this.image_start, image_end: this.image_end, synthetic_vma: this.synthetic_vma,
      sections: this.sections.map((s) => s.asDict()), placements: this.placements.map((p) => p.asDict()),
      table_sites: this.table_sites.length, alias_template: this.alias_template };
  }
}

function integer(value, where) {
  if (typeof value === "boolean") throw new ModuleMapError(`${where}: expected an integer, not a boolean`);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    try { return pyInt(strip(value), 0); } catch { throw new ModuleMapError(`${where}: ${strRepr(value)} is not an integer`); }
  }
  throw new ModuleMapError(`${where}: expected an integer, got ${typeNameOf(value)}`);
}

function mapping(value, where) {
  if (!isMapping(value)) throw new ModuleMapError(`${where}: expected a JSON object`);
  return value;
}

const TYPE_NUMBERS = { R_MIPS_32, R_MIPS_26, R_MIPS_HI16, R_MIPS_LO16 };
function relocType(value, where) {
  if (typeof value === "string") {
    const name = strip(value).toUpperCase();
    if (name in TYPE_NUMBERS) return TYPE_NUMBERS[name];
  }
  return integer(value, where);
}

const get = (o, k, d = undefined) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

/** Build a ModuleMap from the host's JSON document. Refuses rather than guesses. */
export function parseModuleMap(payload, { origin = "module map" } = {}) {
  const document = mapping(payload, origin);
  const schema = get(document, "schema", null);
  if (schema !== null && schema !== MODULE_MAP_SCHEMA) throw new ModuleMapError(`${origin}: unknown schema ${strRepr(schema)}; expected ${strRepr(MODULE_MAP_SCHEMA)}`);
  const body = mapping(get(document, "module", document), `${origin}: module`);
  for (const required of ["image_start", "image_end"]) if (!(required in body)) throw new ModuleMapError(`${origin}: module is missing ${strRepr(required)}`);
  const imageStart = integer(body.image_start, `${origin}: image_start`);
  const imageEnd = integer(body.image_end, `${origin}: image_end`);
  if (imageEnd <= imageStart) throw new ModuleMapError(`${origin}: image_end (0x${hex(imageEnd)}) must be past image_start (0x${hex(imageStart)})`);
  const span = imageEnd - imageStart;
  const sections = [];
  const rawSections = get(body, "sections", {});
  let items;
  if (isMapping(rawSections)) items = Object.entries(rawSections);
  else if (Array.isArray(rawSections)) items = rawSections.map((entry) => [pyStr(get(mapping(entry, `${origin}: sections`), "name", "")), entry]);
  else throw new ModuleMapError(`${origin}: sections must be an object or a list`);
  for (const [name, entry] of items) {
    const where = `${origin}: section ${strRepr(name)}`;
    const record = mapping(entry, where);
    const offset = integer(get(record, "offset", 0), `${where} offset`);
    const size = integer(get(record, "size", 0), `${where} size`);
    if (!name) throw new ModuleMapError(`${origin}: every section needs a name`);
    if (offset < 0 || size < 0) throw new ModuleMapError(`${where}: negative offset or size`);
    if (offset + size > span) throw new ModuleMapError(`${where}: ends at 0x${hex(offset + size)}, past the module's 0x${hex(span)} bytes`);
    sections.push(new SectionRange({ name, offset, size }));
  }
  const placements = [];
  for (const entry of get(body, "text_placement", get(body, "placements", []))) {
    const where = `${origin}: text_placement`;
    const record = mapping(entry, where);
    const obj = get(record, "object");
    if (typeof obj !== "string" || !strip(obj)) throw new ModuleMapError(`${where}: every entry needs an 'object' path`);
    const section = String(get(record, "section", ".text"));
    const offset = integer(get(record, "offset", 0), `${where} ${obj} offset`);
    const extent = get(record, "size") === undefined || get(record, "size") === null ? null : integer(record.size, `${where} ${obj} size`);
    const placement = new Placement({ object: obj, section, offset, size: extent });
    const owner = sections.find((s) => s.name === section) ?? null;
    if (owner !== null) {
      const end = placement.end !== null ? placement.end : offset + 1;
      if (!owner.contains(offset, Math.max(end - offset, 1))) {
        throw new ModuleMapError(`${where}: ${obj} at 0x${hex(offset)} is outside section ${strRepr(section)} (0x${hex(owner.offset)}..0x${hex(owner.end)})`);
      }
    }
    placements.push(placement);
  }
  const tableSites = [];
  for (const entry of get(body, "relocation_sites", [])) {
    const where = `${origin}: relocation_sites`;
    if (isMapping(entry)) {
      const offset = integer(get(entry, "offset", null), where);
      const rawType = get(entry, "type", null);
      tableSites.push(new TableSite({ offset, type: rawType === null ? null : relocType(rawType, where) }));
    } else tableSites.push(new TableSite({ offset: integer(entry, where), type: null }));
  }
  const aliasTemplate = get(body, "alias_template", null);
  if (aliasTemplate !== null && typeof aliasTemplate !== "string") throw new ModuleMapError(`${origin}: alias_template must be a string`);
  return new ModuleMap({ name: String(get(body, "name", "module")), image_start: imageStart, image_end: imageEnd,
    synthetic_vma: integer(get(body, "synthetic_vma", 0), `${origin}: synthetic_vma`), sections, placements, table_sites: tableSites, alias_template: aliasTemplate });
}

/** One relocation site, mapped from an object offset into the image. */
export class Site {
  constructor({ symbol, object, section, object_offset, type, module_offset = null, image_offset = null, stored = null, object_addend = null, in_table = null, note = "" }) {
    Object.assign(this, { symbol, object, section, object_offset, type, module_offset, image_offset, stored, object_addend, in_table, note });
    Object.freeze(this);
  }
  get kind() { return rMipsName(this.type); }
  get mapped() { return this.stored !== null && this.object_addend !== null; }
  asDict() {
    return { symbol: this.symbol, object: this.object, section: this.section, object_offset: this.object_offset, type: this.type, kind: this.kind,
      module_offset: this.module_offset, image_offset: this.image_offset, stored: this.stored, object_addend: this.object_addend,
      in_table: this.in_table, note: this.note };
  }
}

export class SymbolValue {
  constructor({ name, value, sites = [] }) { Object.assign(this, { name, value, sites }); Object.freeze(this); }
  asDict() { return { name: this.name, value: this.value, sites: this.sites.map((s) => s.asDict()) }; }
}

export class Conflict {
  constructor({ symbol, reason, detail = "", values = [], sites = [] }) { Object.assign(this, { symbol, reason, detail, values, sites }); Object.freeze(this); }
  asDict() { return { symbol: this.symbol, reason: this.reason, detail: this.detail, values: [...this.values], sites: this.sites.map((s) => s.asDict()) }; }
}

export class Alias {
  constructor({ identity, name, object, module_offset }) { Object.assign(this, { identity, name, object, module_offset }); Object.freeze(this); }
  asDict() { return { identity: this.identity, name: this.name, object: this.object, module_offset: this.module_offset }; }
}

export class RelocSurface {
  constructor({ module, objects = [], sites = [], values = [], conflicts = [], aliases = [], corroborated = false, warnings = [] }) {
    Object.assign(this, { module, objects, sites, values, conflicts, aliases, corroborated, warnings });
    Object.freeze(this);
  }
  get ok() { return !this.conflicts.length; }
  valueMap() { const m = new Map(); for (const v of this.values) m.set(v.name, v.value); return m; }
  asDict() {
    return { schema: SURFACE_SCHEMA, module: this.module, objects: [...this.objects], corroborated: this.corroborated,
      values: this.values.map((v) => v.asDict()), conflicts: this.conflicts.map((c) => c.asDict()), aliases: this.aliases.map((a) => a.asDict()),
      sites: this.sites.map((s) => s.asDict()), warnings: [...this.warnings], ok: this.ok };
  }
}

export function sext16(value) { return value & 0x8000 ? value - 0x10000 : value; }

/** The relocation's stored field from the word at `offset`. */
export function storedField(data, offset, rType) {
  if (offset < 0 || offset + 4 > data.length) return null;
  const word = data.readUInt32BE(offset);
  if (rType === R_MIPS_26) return word & 0x03FFFFFF;
  if (rType === R_MIPS_HI16 || rType === R_MIPS_LO16) return word & 0xFFFF;
  return word;
}

/** Attach each HI16 to its matching LO16 (MIPS REL pairing). */
function pairs(sites) {
  const pending = new Map();
  const out = [];
  for (const site of sites) {
    if (site.type === R_MIPS_HI16) { if (!pending.has(site.symbol)) pending.set(site.symbol, []); pending.get(site.symbol).push(site); }
    else if (site.type === R_MIPS_LO16) {
      const his = pending.get(site.symbol) ?? [];
      pending.delete(site.symbol);
      if (his.length) for (const high of his) out.push([high, site]);
      else out.push([null, site]);
    } else out.push([site, null]);
  }
  for (const group of pending.values()) for (const high of group) out.push([high, null]);
  return out;
}

function requiredValue(high, low, vma) {
  const anchor = high ?? low;
  if (anchor === null) return null;
  for (const site of [high, low]) if (site !== null && (site.stored === null || site.object_addend === null)) return null;
  let target, have;
  if (high !== null && low !== null && high.type === R_MIPS_HI16) {
    target = high.stored * 65536 + sext16(low.stored);
    have = high.object_addend * 65536 + sext16(low.object_addend);
  } else if (anchor.type === R_MIPS_26) {
    target = u32(Math.floor(vma / 0x10000000) % 16 * 0x10000000 + anchor.stored * 4);
    have = anchor.object_addend * 4;
  } else if (anchor.type === R_MIPS_32) { target = anchor.stored; have = anchor.object_addend; }
  else if (anchor.type === R_MIPS_HI16) { target = anchor.stored * 65536; have = anchor.object_addend * 65536; }
  else { target = sext16(anchor.stored); have = sext16(anchor.object_addend); }
  return u32(target - have);
}

/** Names defined, with a linkable binding, in the module's own placed sections. */
export function moduleDefinedNames(objects, sections = [".text"]) {
  const wanted = new Set(sections);
  const out = new Set();
  for (const [, elf] of objects) {
    const indices = new Set(elf.sections.filter((s) => wanted.has(s.name)).map((s) => s.index));
    for (const symbol of elf.symbols) {
      if (!symbol.name || !indices.has(symbol.shndx)) continue;
      if (LINKABLE_BINDINGS.has(symbol.bind)) out.add(symbol.name);
    }
  }
  return out;
}

const noted = (site, note) => new Site({ symbol: site.symbol, object: site.object, section: site.section, object_offset: site.object_offset,
  type: site.type, module_offset: site.module_offset, image_offset: site.image_offset, note });

/** Map every relocation in this object's placed sections into the image. */
export function collectSites(elf, module, image, { object_name, skip = [] }) {
  const skipped = new Set(skip);
  const warnings = [];
  const placements = module.placementsFor(object_name);
  if (!placements.length) {
    warnings.push(`${object_name}: the module map places no section of this object; no site can be mapped into the image`);
    return [[], warnings];
  }
  const table = new Map();
  for (const entry of module.table_sites) { if (!table.has(entry.offset)) table.set(entry.offset, []); table.get(entry.offset).push(entry); }
  const sites = [];
  for (const placement of placements) {
    const sectionBytes = elf.sectionBytes(placement.section);
    if (sectionBytes === null) {
      warnings.push(`${object_name}: the map places ${placement.section} but the object has no such section`);
      continue;
    }
    const header = elf.section(placement.section);
    const ownIndex = header === null ? null : header.index;
    for (const reloc of elf.relocationsFor(placement.section)) {
      const symbol = elf.symbol(reloc.sym_index);
      const name = symbol !== null ? symbol.name : "";
      if (!name || skipped.has(name)) continue;
      if (symbol !== null && symbol.shndx !== SHN_UNDEF && symbol.shndx === ownIndex) continue;
      const moduleOffset = placement.offset + reloc.offset;
      const imageOffset = module.imageOffset(moduleOffset);
      const site = new Site({ symbol: name, object: object_name, section: placement.section, object_offset: reloc.offset, type: reloc.type,
        module_offset: moduleOffset, image_offset: imageOffset });
      if (!SUPPORTED_TYPES.has(reloc.type)) { sites.push(noted(site, `unsupported relocation ${rMipsName(reloc.type)}`)); continue; }
      const owner = module.section(placement.section) ?? module.section(placement.section.replace(/^\.+/, ""));
      if (owner !== null && !owner.contains(moduleOffset, 4)) { sites.push(noted(site, "outside the module section")); continue; }
      if (!(module.image_start <= imageOffset && imageOffset < module.image_end)) { sites.push(noted(site, "outside the module's image range")); continue; }
      const stored = storedField(image, imageOffset, reloc.type);
      const addend = storedField(sectionBytes, reloc.offset, reloc.type);
      if (stored === null || addend === null) { sites.push(noted(site, "unmapped")); continue; }
      const matches = table.get(moduleOffset) ?? [];
      let inTable = null;
      if (module.table_sites.length) inTable = matches.some((e) => e.type === null || e.type === reloc.type);
      sites.push(new Site({ symbol: name, object: object_name, section: placement.section, object_offset: reloc.offset, type: reloc.type,
        module_offset: moduleOffset, image_offset: imageOffset, stored, object_addend: addend, in_table: inTable }));
    }
  }
  return [sites, warnings];
}

function groupByObject(sites) {
  const byObject = new Map();
  for (const site of sites) {
    const k = JSON.stringify([site.object, site.section]);
    if (!byObject.has(k)) byObject.set(k, []);
    byObject.get(k).push(site);
  }
  return byObject;
}

/** Reduce mapped sites to one value per symbol, or a stated refusal. */
export function solve(sites, module) {
  const byObject = groupByObject(sites);
  const corroborated = new Set(sites.filter((s) => s.in_table).map((s) => s.symbol));
  const wanted = new Map(); // name -> Map(value -> sites)
  const unreadable = new Map();
  const push = (m, k, items) => { if (!m.has(k)) m.set(k, []); m.get(k).push(...items); };
  for (const group of byObject.values()) {
    for (const [high, low] of pairs(group)) {
      const anchor = high ?? low;
      if (anchor === null) continue;
      const members = [high, low].filter((s) => s !== null);
      const name = anchor.symbol;
      if (corroborated.has(name) && !members.every((s) => s.in_table)) continue;
      if (members.some((s) => !s.mapped)) { push(unreadable, name, members); continue; }
      const value = requiredValue(high, low, module.synthetic_vma);
      if (value === null) { push(unreadable, name, members); continue; }
      if (!wanted.has(name)) wanted.set(name, new Map());
      push(wanted.get(name), value, members);
    }
  }
  const values = [];
  const conflicts = [];
  const seen = new Set(sites.map((s) => s.symbol));
  for (const name of sorted([...seen].filter((n) => !wanted.has(n) && !unreadable.has(n)))) {
    conflicts.push(new Conflict({ symbol: name, reason: "no-corroborated-site",
      detail: "the shipped relocation table names this symbol, but not at any site this object still spells the same way: the schedule diverges at every corroborated site",
      sites: sites.filter((s) => s.symbol === name) }));
  }
  for (const name of sorted([...wanted.keys()])) {
    const candidates = wanted.get(name);
    if (candidates.size === 1) {
      const [value, agreeing] = candidates.entries().next().value;
      values.push(new SymbolValue({ name, value, sites: agreeing }));
      continue;
    }
    const keys = sorted([...candidates.keys()]);
    const total = [...candidates.values()].reduce((n, g) => n + g.length, 0);
    conflicts.push(new Conflict({ symbol: name, reason: "schedule-divergence-at-site",
      detail: `${candidates.size} distinct values across ${total} site(s): ` + keys.map((v) => `0x${hex(v, 8)}`).join(", "),
      values: keys, sites: [...candidates.values()].flat() }));
  }
  for (const name of sorted([...unreadable.keys()])) {
    if (wanted.has(name)) continue;
    conflicts.push(new Conflict({ symbol: name, reason: "unmapped-site", detail: "no site of this symbol could be read from the image", sites: unreadable.get(name) }));
  }
  return [values, sorted(conflicts, (c) => c.symbol)];
}

/** Symbols whose value rests on an R_MIPS_HI16 with no R_MIPS_LO16. */
export function unpairedHi16(sites) {
  const out = new Set();
  for (const group of groupByObject(sites).values()) {
    for (const [high, low] of pairs(group)) if (low === null && high !== null && high.type === R_MIPS_HI16) out.add(high.symbol);
  }
  return sorted([...out]);
}

/**
 * str.format(template, **fields) for the alias template: `{name}`,
 * `{name:spec}` with the integer/string format-spec mini-language, `{{`/`}}`.
 */
export function formatTemplate(template, fields) {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "{") {
      if (template[i + 1] === "{") { out += "{"; i++; continue; }
      const close = template.indexOf("}", i);
      if (close < 0) throw new ValueError("Single '{' encountered in format string");
      const body = template.slice(i + 1, close);
      i = close;
      const colon = body.indexOf(":");
      let field = colon < 0 ? body : body.slice(0, colon);
      const spec = colon < 0 ? "" : body.slice(colon + 1);
      let conversion = null;
      const bang = field.indexOf("!");
      if (bang >= 0) { conversion = field.slice(bang + 1); field = field.slice(0, bang); }
      if (!(field in fields)) { const e = new Error(`'${field}'`); e.name = "KeyError"; throw e; }
      let value = fields[field];
      if (conversion === "r") value = typeof value === "string" ? strRepr(value) : String(value);
      else if (conversion === "s") value = String(value);
      out += formatSpec(value, spec);
    } else if (c === "}") {
      if (template[i + 1] === "}") { out += "}"; i++; continue; }
      throw new ValueError("Single '}' encountered in format string");
    } else out += c;
  }
  return out;
}

function formatSpec(value, spec) {
  const m = /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/s.exec(spec);
  if (!m) throw new ValueError(`Invalid format specifier '${spec}'`);
  let [, fill, align, sign, alt, zero, width, grouping, , type] = m;
  width = width ? Number(width) : 0;
  if (typeof value === "string") {
    const text = value;
    return pad(text, width, fill ?? " ", align ?? "<");
  }
  let n = Number(value);
  let digits;
  const neg = n < 0;
  const abs = Math.abs(n);
  const t = type ?? "d";
  let prefix = "";
  if (t === "x" || t === "X") { digits = abs.toString(16); if (t === "X") digits = digits.toUpperCase(); if (alt) prefix = t === "X" ? "0X" : "0x"; }
  else if (t === "o") { digits = abs.toString(8); if (alt) prefix = "0o"; }
  else if (t === "b") { digits = abs.toString(2); if (alt) prefix = "0b"; }
  else if (t === "c") return pad(String.fromCharCode(abs), width, fill ?? " ", align ?? "<");
  else digits = String(abs);
  if (grouping && (t === "d" || t === "n")) digits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, grouping);
  const signText = neg ? "-" : sign === "+" ? "+" : sign === " " ? " " : "";
  if (zero && !align) { fill = "0"; align = "="; }
  if ((align ?? ">") === "=") {
    const body = digits.padStart(Math.max(0, width - signText.length - prefix.length), fill ?? " ");
    return signText + prefix + body;
  }
  return pad(signText + prefix + digits, width, fill ?? " ", align ?? ">");
}

function pad(text, width, fill, align) {
  if (text.length >= width) return text;
  const gap = width - text.length;
  if (align === "<") return text + fill.repeat(gap);
  if (align === "^") return fill.repeat(Math.floor(gap / 2)) + text + fill.repeat(gap - Math.floor(gap / 2));
  return fill.repeat(gap) + text;
}

/** Generated-identity aliases for the global functions this object defines. */
export function objectAliases(elf, module, { object_name }) {
  if (!module.alias_template) return [];
  const out = [];
  for (const placement of module.placementsFor(object_name)) {
    const section = elf.section(placement.section);
    if (section === null) continue;
    for (const symbol of elf.symbols) {
      if (symbol.shndx !== section.index || !symbol.name) continue;
      if (symbol.bind !== STB_GLOBAL || symbol.type !== STT_FUNC) continue;
      const moduleOffset = placement.offset + symbol.value;
      const identity = formatTemplate(module.alias_template, { module: module.name, module_offset: moduleOffset,
        image_offset: module.imageOffset(moduleOffset), vma: module.synthetic_vma + moduleOffset });
      if (identity === symbol.name) continue;
      out.push(new Alias({ identity, name: symbol.name, object: object_name, module_offset: moduleOffset }));
    }
  }
  return out;
}

/** Synthesize the whole surface for one module from its objects. */
export function synthesize(objects, module, image, { local_sections = [".text"] } = {}) {
  const local = moduleDefinedNames(objects, local_sections);
  const allSites = [], warnings = [], aliases = [];
  for (const [name, elf] of objects) {
    const [sites, objectWarnings] = collectSites(elf, module, image, { object_name: name, skip: local });
    allSites.push(...sites);
    warnings.push(...objectWarnings);
    aliases.push(...objectAliases(elf, module, { object_name: name }));
  }
  let [values, conflicts] = solve(allSites, module);
  const aliased = new Set(aliases.map((a) => a.identity));
  const shadowed = sorted([...new Set(values.map((v) => v.name))].filter((n) => aliased.has(n)));
  if (shadowed.length) {
    values = values.filter((v) => !aliased.has(v.name));
    warnings.push(`dropped ${shadowed.length} value line(s) an alias already defines: ` + shadowed.join(", "));
  }
  const valueNames = new Set(values.map((v) => v.name));
  const orphans = unpairedHi16(allSites).filter((n) => valueNames.has(n));
  if (orphans.length) {
    warnings.push("value(s) resting on an R_MIPS_HI16 with no R_MIPS_LO16 site, "
      + "whose low half is unobserved: any value in the same 64 KiB "
      + "window writes the same word, so these are right for the link "
      + "and non-canonical as numbers: " + orphans.join(", "));
  }
  if (!module.table_sites.length) {
    warnings.push("no shipped relocation table was supplied: every site is trusted "
      + "as a relocation site, so a literal the runtime does not patch "
      + "cannot be told apart from an addend");
  }
  return new RelocSurface({ module: module.name, objects: objects.map(([n]) => n), sites: allSites, values, conflicts, aliases,
    corroborated: module.table_sites.length > 0, warnings });
}

/** The surface as a linker symbol block plus an alias block. */
export function renderLinkerBlock(surface, { header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push("/*", " * Generated by `decomp-workbench reloc-surface` -- do not edit by hand.",
      ` * Module ${surface.module}, ${surface.objects.length} object(s).`, " */", "");
  }
  lines.push("/* Stored relocation addends, per translation unit. */");
  const byObject = new Map();
  for (const item of surface.values) {
    const origin = item.sites.length ? item.sites[0].object : "";
    if (!byObject.has(origin)) byObject.set(origin, []);
    byObject.get(origin).push(item);
  }
  for (const origin of sorted([...byObject.keys()])) {
    lines.push("", `/* ${origin} */`);
    for (const item of sorted(byObject.get(origin), (e) => e.name)) lines.push(`${item.name} = 0x${hex(item.value, 8, { upper: true })};`);
  }
  if (surface.aliases.length) {
    lines.push("", "/* Generated identities for adopted names. */");
    const byAlias = new Map();
    for (const a of surface.aliases) { if (!byAlias.has(a.object)) byAlias.set(a.object, []); byAlias.get(a.object).push(a); }
    for (const origin of sorted([...byAlias.keys()])) {
      lines.push("", `/* ${origin} */`);
      for (const a of sorted(byAlias.get(origin), (e) => e.identity)) lines.push(`${a.identity} = ${a.name};`);
    }
  }
  for (const c of surface.conflicts) lines.push(`/* UNRESOLVED ${c.symbol}: ${c.reason} */`);
  return lines;
}

/** `NAME = VALUE;` assignments read back out of a linker block (last wins). */
export function parseLinkerBlock(text) {
  const out = new Map();
  for (const line of splitlines(text)) {
    const stripped = strip(line);
    if (stripped.startsWith("/*") || stripped.startsWith("*") || stripped.startsWith("//")) continue;
    const m = ASSIGNMENT_RE.exec(line);
    if (m) out.set(m.groups.name, strip(m.groups.value));
  }
  return out;
}

/** The numeric half of parseLinkerBlock: name -> value. */
export function trackedValues(text) {
  const out = new Map();
  for (const [name, value] of parseLinkerBlock(text)) {
    try { out.set(name, pyInt(value, 0)); } catch { /* not a number: a symbol alias */ }
  }
  return out;
}

export class AuditRow {
  constructor({ name, status, tracked = null, synthesized = null }) { Object.assign(this, { name, status, tracked, synthesized }); Object.freeze(this); }
  asDict() { return { name: this.name, status: this.status, tracked: this.tracked, synthesized: this.synthesized }; }
}

/** A replay of a hand-written block against the synthesized surface. */
export class AuditReport {
  constructor({ rows = [], conflicts = [] } = {}) { Object.assign(this, { rows, conflicts }); Object.freeze(this); }
  count(status) { return this.rows.filter((r) => r.status === status).length; }
  get agree() { return this.count("agree"); }
  get disagree() { return this.count("disagree"); }
  get compared() { return this.agree + this.disagree; }
  get ok() { return this.disagree === 0 && !this.conflicts.length; }
  asDict() {
    return { agree: this.agree, disagree: this.disagree, compared: this.compared, untracked: this.count("untracked"),
      unreproduced: this.count("unreproduced"), rows: this.rows.map((r) => r.asDict()), conflicts: this.conflicts.map((c) => c.asDict()), ok: this.ok };
  }
}

/** Score the synthesized values against an existing hand-written block. */
export function audit(surface, tracked) {
  const synthesized = surface.valueMap();
  const t = tracked instanceof Map ? tracked : new Map(Object.entries(tracked));
  const rows = [];
  for (const name of sorted([...new Set([...t.keys(), ...synthesized.keys()])])) {
    if (t.has(name) && synthesized.has(name)) {
      rows.push(new AuditRow({ name, status: t.get(name) === synthesized.get(name) ? "agree" : "disagree", tracked: t.get(name), synthesized: synthesized.get(name) }));
    } else if (synthesized.has(name)) rows.push(new AuditRow({ name, status: "untracked", synthesized: synthesized.get(name) }));
    else rows.push(new AuditRow({ name, status: "unreproduced", tracked: t.get(name) }));
  }
  return new AuditReport({ rows, conflicts: surface.conflicts });
}

/** Whether a scratch can reproduce the target's own call relocations. */
export class PlaceholderFinding {
  constructor({ function: fn, call_sites = 0, self_named = [], absent_from_candidate = [], reproducible = [], candidate_read = false }) {
    Object.assign(this, { function: fn, call_sites, self_named, absent_from_candidate, reproducible, candidate_read });
    Object.freeze(this);
  }
  get unreproducible() { return sorted([...new Set([...this.self_named, ...this.absent_from_candidate])]); }
  get blocked() { return !!this.call_sites && !this.reproducible.length; }
  get message() {
    const names = this.unreproducible.slice(0, 3).join(", ");
    let text = `every R_MIPS_26 site in the target (${this.call_sites}) names a `
      + `symbol this scratch cannot reproduce (${names}); the permuter `
      + "score cannot reach zero for this function however good the C is "
      + "-- use `decomp-workbench linked-compare` against the linked "
      + "image instead";
    if (this.self_named.length && !this.candidate_read) {
      text += "; a self-named site also reads as ordinary self-recursion, which `--candidate-object` tells apart";
    }
    return text;
  }
  asDict() {
    return { function: this.function, call_sites: this.call_sites, self_named: [...this.self_named], absent_from_candidate: [...this.absent_from_candidate],
      reproducible: [...this.reproducible], unreproducible: this.unreproducible, candidate_read: this.candidate_read, blocked: this.blocked };
  }
}

function functionRange(elf, fn, section) {
  const header = elf.section(section);
  if (header === null) return null;
  for (const symbol of elf.symbols) {
    if (symbol.name === fn && symbol.shndx === header.index) {
      const size = symbol.size || header.size - symbol.value;
      return [symbol.value, symbol.value + size];
    }
  }
  return null;
}

/** Classify the target's call relocations by whether a scratch can name them. */
export function placeholderCallCheck(target, candidate, { function: fn, section = ".text" }) {
  const window = functionRange(target, fn, section);
  const names = [];
  for (const reloc of target.relocationsFor(section)) {
    if (reloc.type !== R_MIPS_26) continue;
    if (window !== null && !(window[0] <= reloc.offset && reloc.offset < window[1])) continue;
    const symbol = target.symbol(reloc.sym_index);
    if (symbol !== null && symbol.name) names.push(symbol.name);
  }
  const candidateNames = candidate !== null ? new Set(candidate.symbols.filter((s) => s.name).map((s) => s.name)) : new Set();
  const selfNamed = new Set(), absent = new Set(), reproducible = new Set();
  for (const name of names) {
    if (candidate !== null && candidateNames.has(name)) reproducible.add(name);
    else if (name === fn) selfNamed.add(name);
    else if (candidate !== null) absent.add(name);
    else reproducible.add(name);
  }
  return new PlaceholderFinding({ function: fn, call_sites: names.length, self_named: sorted([...selfNamed]), absent_from_candidate: sorted([...absent]),
    reproducible: sorted([...reproducible]), candidate_read: candidate !== null });
}

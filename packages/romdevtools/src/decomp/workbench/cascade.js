// cascade.js - every round of one allocator site's decision cascade, from a
// CDX log. A cascade is every round or it is misleading; sites are located
// by FRAME OFFSET, which a renumbering does not move; the colour reported is
// the post-resolution `p1color`, joined by web number, not the
// pre-resolution `bestcolor`.
//
// `savedetail` and `saveocc` are not part of the shipped `instrument-uopt`
// profile; they come from a campaign-local uopt.c patch. Everything here
// reads a log file, and the commands say which records a log was missing
// rather than printing an empty table.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ValueError, pyInt, strRepr, sorted, strip, hex, replace, pyRound, fixed, osErrorText } from "./py.js";
import {
  parseGlobalcolorTrace, optionalInteger, registerForColor, decodeForbiddenColors, decodeMincostTieColors,
  isIneligibleAllocatorCost, pyFloat,
} from "./globalcolor.js";

/** A site could not be located, or a log did not carry what was asked. */
export class CascadeError extends ValueError {
  constructor(message) { super(message); this.name = "ValueError"; }
}

/** The record grammar these commands read, one line per kind. */
export const RECORD_GRAMMAR = Object.freeze({
  p1dec: "SHIPPED. One decision. phase proc web sym class save nocs totalsave bestcost bestcolor bestreg forbidden0/1 regsleft numintf "
    + "available0/1 allcallersave taken1 taken2 decision forced. `class` here is the REGISTER class: 1 integer, 2 floating point.",
  p1color: "SHIPPED. The colour the web actually received, after any force or split resolved it. phase proc web sym color reg forced.",
  p1cost: "SHIPPED. One candidate colour's measured cost at one decision. phase proc web color reg kind cost best_before.",
  p1cand: "SHIPPED. One entry of the priority sweep that orders the decisions. phase proc web sym save nocs best.",
  webdetail: "SHIPPED. The web's identity. phase proc role web sym type dtype table chain exprtable exprchain bb line raw10 raw14 raw18 raw20. "
    + "For a stack-resident web `raw10` is the FRAME OFFSET, which is the only identity in the whole grammar that survives renumbering.",
  savedetail: "CAMPAIGN-LOCAL (WB-15). The save arithmetic for one web at one round. proc web sym occ gross chargeA chargeB net divisor nocs "
    + "dtype save class forced. `class` here is NOT the register class: it is 1 while net > 0 and 2 once net <= 0, i.e. 2 means the piece is "
    + "memory-resident.",
  saveocc: "CAMPAIGN-LOCAL (WB-15). One occurrence inside that arithmetic. proc web occ usesdefs weight term bb uses defs occp nl bb5 o22 o23 w34.",
});

/** Records without which a cascade cannot be built at all. */
export const REQUIRED_RECORDS = Object.freeze(["p1dec", "webdetail"]);

const RANGE_RE = /^\s*(-?\w+)\s*\.\.\s*(-?\w+)\s*$/;
const REGISTER_RE = /\$(?:f\d+|\w+)/g;

/** `record.fields.get(key)` for either field container; null when absent. */
export function fieldOf(record, key) {
  const f = record.fields;
  if (f && typeof f.get === "function") { const v = f.get(key); return v === undefined ? null : v; }
  return f && Object.prototype.hasOwnProperty.call(f, key) ? f[key] : null;
}

/** A record's fields as a plain object. */
export function fieldsObject(record) {
  const f = record.fields;
  if (f instanceof Map) return Object.fromEntries(f);
  if (f && typeof f.entries === "function" && !Array.isArray(f) && typeof f.get === "function") return Object.fromEntries(f.entries());
  return f ?? {};
}

const get = (fields, key, dflt = null) => (Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : dflt);

/** One signed frame offset from any spelling a trace or reader uses. */
export function parseFrameOffset(value) {
  const text = strip(String(value)).toLowerCase();
  let number;
  try { number = pyInt(text, 0); } catch {
    throw new CascadeError(`${strRepr(value)} is not a frame offset; write it as the trace prints it `
      + "(0xfffffdf8), as a signed number (-520), or give --slot with --frame");
  }
  if (number >= 0x80000000 && number <= 0xFFFFFFFF) number -= 0x100000000;
  return number;
}

/** Render an offset the way the trace does, with the signed value beside it. */
export function formatFrameOffset(offset) {
  const word = Number(BigInt(offset) & 0xFFFFFFFFn);
  return `0x${hex(word, 8)} (${offset >= 0 ? "+" : ""}${offset})`;
}

/** float(value), or NaN when absent or malformed. */
export function toFloat(value) {
  if (value === null || value === undefined) return NaN;
  try { return pyFloat(value); } catch { return NaN; }
}

/** Finite floats as numbers, everything else as "nan". */
export function toNumber(value) { return Number.isFinite(value) ? value : "nan"; }

/** `{value:.Nf}` with the original's spelling of non-finite values. */
export function fmtF(value, n) {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  return fixed(value, n);
}

/** Parse one inclusive `LO..HI` row range. */
export function parseRowRange(value) {
  const m = RANGE_RE.exec(value);
  if (!m) throw new CascadeError(`${strRepr(value)} is not a row range; write it as LO..HI`);
  let low, high;
  try { low = pyInt(m[1], 0); high = pyInt(m[2], 0); } catch { throw new CascadeError(`${strRepr(value)} is not a row range; write it as LO..HI`); }
  if (low > high) throw new CascadeError(`row range ${strRepr(value)} runs backwards; write it as LO..HI`);
  return [low, high];
}

/** One `saveocc` record: a single occurrence inside a web's save sum. */
export class Occurrence {
  constructor({ web, index, block, uses, defs, weight, term, nl, o22, o23, w34 }) {
    Object.assign(this, { web, index, block, uses, defs, weight, term, nl, o22, o23, w34 });
    Object.freeze(this);
  }
  /** `w34 AND NOT o23 AND o22 AND (defs != 0 OR nl == 0)` (L92). */
  get charges_b() { return Boolean(this.w34 && !this.o23 && this.o22 && (this.defs || !this.nl)); }
  asDict() {
    return { web: this.web, occurrence: this.index, block: this.block, uses: this.uses, defs: this.defs, weight: toNumber(this.weight),
      term: toNumber(this.term), nl: this.nl, o22: this.o22, o23: this.o23, w34: this.w34, charges_b: this.charges_b };
  }
}

/** One `savedetail` record: the save arithmetic for a web at one round. */
export class SaveDetail {
  constructor({ web, symbol, occurrence_count, gross, charge_a, charge_b, net, nocs, dtype, save, piece_class, occurrences = [] }) {
    Object.assign(this, { web, symbol, occurrence_count, gross, charge_a, charge_b, net, nocs, dtype, save, piece_class, occurrences });
    Object.freeze(this);
  }
  /** `savedetail class=2` means priced out of a colour (not the register file). */
  get memory_resident() { return this.piece_class === 2; }
  get charge_b_contributors() { return this.occurrences.filter((o) => o.charges_b); }
  get charge_b_accounted() {
    if (!this.occurrences.length || !Number.isFinite(this.charge_b)) return false;
    const total = this.charge_b_contributors.reduce((s, o) => s + o.weight, 0);
    return Math.abs(total - this.charge_b) <= 1e-6;
  }
  asDict() {
    return { web: this.web, symbol: this.symbol, occurrence_count: this.occurrence_count, gross: toNumber(this.gross),
      charge_a: toNumber(this.charge_a), charge_b: toNumber(this.charge_b), net: toNumber(this.net), nocs: this.nocs, dtype: this.dtype,
      save: toNumber(this.save), piece_class: this.piece_class, memory_resident: this.memory_resident,
      charge_b_accounted: this.charge_b_accounted, occurrences: this.occurrences.map((o) => o.asDict()) };
  }
}

export function colorName(color) {
  if (color === null || color === undefined || color < 0) return "-";
  const register = registerForColor(color);
  return register ? `c${color}/${register}` : `c${color}`;
}

/** One `p1dec` decision with everything the log says about it. */
export class Round {
  constructor(f) {
    for (const k of ["ordinal", "index", "web", "symbol", "register_class", "save", "nocs", "net", "best_cost", "natural_color", "resolved_color",
      "decision", "forced", "forbidden", "mincost_tie", "registers_left", "interference", "entering", "pieces"]) this[k] = f[k] === undefined ? null : f[k];
    Object.freeze(this);
  }
  get natural_register() { return registerForColor(this.natural_color); }
  get resolved_register() { return registerForColor(this.resolved_color); }
  get declined() { return this.decision !== "color"; }
  get resolution_differs() { return this.resolved_color !== null && this.natural_color !== null && this.resolved_color !== this.natural_color; }
  /** The decision as the one inequality it is (L28). */
  get inequality() {
    if (!Number.isFinite(this.net) || !Number.isFinite(this.best_cost)) return `net ? <= bestcost ? -> ${this.decision}`;
    const answer = this.net <= this.best_cost ? "YES" : "NO";
    const outcome = answer === "YES" ? "split (memory-resident, no colour)" : "colour it";
    return `net ${fmtF(this.net, 3)} <= bestcost ${fmtF(this.best_cost, 3)} ?  ${answer} -> ${outcome}`;
  }
  get deficit() {
    if (!Number.isFinite(this.net) || !Number.isFinite(this.best_cost)) return NaN;
    return this.net - this.best_cost;
  }
  colorName(color) { return colorName(color); }
  asDict() {
    return {
      ordinal: this.ordinal, round: this.index, web: this.web, symbol: this.symbol, register_class: this.register_class,
      save: toNumber(this.save), nocs: this.nocs, net: toNumber(this.net), best_cost: toNumber(this.best_cost), decision: this.decision,
      inequality: this.inequality, deficit: toNumber(this.deficit), natural_color: this.natural_color, natural_register: this.natural_register,
      resolved_color: this.resolved_color, resolved_register: this.resolved_register, resolution_differs: this.resolution_differs,
      forced: this.forced, forbidden_colors: [...this.forbidden],
      forbidden_registers: this.forbidden.map((c) => ({ color: c, register: registerForColor(c) })),
      mincost_tie_colors: [...this.mincost_tie], registers_left: this.registers_left, interference: this.interference,
      entering: this.entering === null ? null : this.entering.asDict(), pieces: this.pieces.map((p) => p.asDict()),
    };
  }
}

/** One allocator site: a frame offset, its symbol, and its web family. */
export class Site {
  constructor({ key, symbol, frame_offset, webs, detail, caution = null }) {
    Object.assign(this, { key, symbol, frame_offset, webs, detail, caution });
    Object.freeze(this);
  }
  asDict() {
    return { key: this.key, symbol: this.symbol, frame_offset: this.frame_offset,
      frame_offset_text: this.frame_offset === null ? null : formatFrameOffset(this.frame_offset), webs: [...this.webs], caution: this.caution };
  }
}

/** Every round of one site's decision cascade, in log order. */
export class Cascade {
  constructor({ name, site, rounds, occurrences, costs, undecided = [], warnings = [] }) {
    Object.assign(this, { name, site, rounds, occurrences, costs, undecided, warnings });
    Object.freeze(this);
  }
  /** Whether no web of this site ever received a colour. */
  get killed() { return !this.rounds.some((r) => r.resolved_color !== null); }
  get final() { return this.rounds.length ? this.rounds[this.rounds.length - 1] : null; }
  get colored() { return this.rounds.filter((r) => r.resolved_color !== null); }
  /** The one-line kill signal a sweep column carries. */
  killLine() {
    const symbol = this.site.symbol === null ? "-" : String(this.site.symbol);
    if (this.killed) return `kill: YES ${this.name} sym=${symbol} rounds=${this.rounds.length} colors=0`;
    const taken = this.colored;
    const last = taken[taken.length - 1];
    return `kill: NO ${this.name} sym=${symbol} rounds=${this.rounds.length} colors=${taken.length} final=w${last.web}:${last.colorName(last.resolved_color)}`;
  }
  asDict() {
    return {
      log: this.name, site: this.site.asDict(), killed: this.killed, kill_line: this.killLine(), round_count: this.rounds.length,
      rounds: this.rounds.map((r) => r.asDict()), undecided_pieces: this.undecided.map((p) => p.asDict()), warnings: [...this.warnings],
      occurrences: Object.fromEntries(sorted([...this.occurrences.entries()], (e) => e[0]).map(([web, items]) => [String(web), items.map((i) => i.asDict())])),
    };
  }
}

/** Printed whenever a site is located by trace-local symbol number. */
export const SYMBOL_CAUTION = "located by symbol number, which is trace-local: a rebase renumbers it "
  + "and this lookup then silently names a different variable, or nothing. "
  + "Use --frame-offset (or --slot with --frame) for anything you will "
  + "compare across builds.";

/** One parsed CDX log, indexed the way a site query needs it. */
export class CdxLog {
  constructor(text, { name }) {
    this.name = name;
    this.trace = parseGlobalcolorTrace(text);
    this.records = [...this.trace.decisions];
    this.kinds = new Map();
    for (const r of this.records) this.kinds.set(r.phase, (this.kinds.get(r.phase) ?? 0) + 1);
  }

  static read(p) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: false }).decode(readFileSync(p)); } catch (e) {
      throw new CascadeError(`cannot read ${p}: ${osErrorText(e)}`);
    }
    if (!text.includes("[CDX]")) {
      throw new CascadeError(`${p} holds no [CDX] records. A cascade needs an instrumented build: compile with CDX_LOG=1 and keep the `
        + "compiler's stderr. `decomp-workbench trace-cascade --grammar` prints the records this reads.");
    }
    return new CdxLog(text, { name: path.basename(p) });
  }

  *of(kind) { for (const r of this.records) if (r.phase === kind) yield r; }

  missing(kinds) { return [...kinds].filter((k) => !this.kinds.get(k)); }

  require(kinds, { purpose }) {
    const absent = this.missing(kinds);
    if (!absent.length) return;
    throw new CascadeError(`${this.name} carries no ${absent.join("/")} record(s), which ${purpose} needs. Present: `
      + `${sorted([...this.kinds.keys()]).join(", ") || "nothing"}. The ${absent.join("/")} grammar is a campaign-local uopt patch, not `
      + "part of the shipped `instrument-uopt` profile -- see `trace-cascade --grammar`.");
  }

  /** Every frame offset a `webdetail` names, to its symbols. */
  frameOffsets() {
    const found = new Map();
    for (const r of this.of("webdetail")) {
      const raw = fieldOf(r, "raw10");
      const symbol = optionalInteger(fieldOf(r, "sym"));
      if (raw === null || symbol === null) continue;
      let offset;
      try { offset = parseFrameOffset(raw); } catch (e) { if (e instanceof CascadeError) continue; throw e; }
      if (!found.has(offset)) found.set(offset, new Set());
      found.get(offset).add(symbol);
    }
    return found;
  }

  /** Every web the log attributes to one symbol, in first-seen order. */
  websOfSymbol(symbol) {
    const seen = [];
    for (const r of this.records) {
      if (optionalInteger(fieldOf(r, "sym")) !== symbol) continue;
      const web = optionalInteger(fieldOf(r, "web"));
      if (web !== null && !seen.includes(web)) seen.push(web);
    }
    return seen;
  }

  symbolOfWeb(web) {
    for (const r of this.records) {
      if (optionalInteger(fieldOf(r, "web")) === web) {
        const symbol = optionalInteger(fieldOf(r, "sym"));
        if (symbol !== null) return symbol;
      }
    }
    return null;
  }

  webDetail(web) {
    for (const r of this.of("webdetail")) if (optionalInteger(fieldOf(r, "web")) === web) return { ...fieldsObject(r) };
    return {};
  }

  /** Locate one site, by frame offset for preference. */
  resolve({ frame_offset = null, symbol = null, web = null } = {}) {
    const given = [["--frame-offset/--slot", frame_offset], ["--symbol", symbol], ["--web", web]].filter(([, v]) => v !== null && v !== undefined).map(([n]) => n);
    if (given.length !== 1) {
      throw new CascadeError("name exactly one site: --frame-offset (or --slot with --frame), --web, or --symbol"
        + (given.length ? `; got ${given.join(", ")}` : ""));
    }
    if (frame_offset !== null && frame_offset !== undefined) return this.resolveOffset(frame_offset);
    if (web !== null && web !== undefined) return this.resolveWeb(web);
    return this.resolveSymbol(symbol, { caution: SYMBOL_CAUTION });
  }

  resolveOffset(offset) {
    this.require(["webdetail"], { purpose: "locating a site by frame offset" });
    const table = this.frameOffsets();
    const symbols = table.get(offset);
    if (!symbols || !symbols.size) throw new CascadeError(noOffsetMessage(this.name, offset, table));
    if (symbols.size > 1) {
      const listed = sorted([...symbols]).join(", ");
      throw new CascadeError(`frame offset ${formatFrameOffset(offset)} is claimed by ${symbols.size} symbols in ${this.name} (${listed}). Two `
        + "symbols sharing one stack home is a real allocator outcome, not a lookup failure; pass --symbol to say which one you mean.");
    }
    const symbol = [...symbols][0];
    const site = this.resolveSymbol(symbol, { caution: null });
    return new Site({ key: `frame offset ${formatFrameOffset(offset)}`, symbol, frame_offset: offset, webs: site.webs, detail: site.detail });
  }

  resolveSymbol(symbol, { caution }) {
    const webs = this.websOfSymbol(symbol);
    if (!webs.length) {
      throw new CascadeError(`no record in ${this.name} names sym=${symbol}. Symbol numbers are trace-local and renumber whenever the source is rebased `
        + "-- one campaign's sym=1042 became sym=1039 and the script that grepped the old number reported a kill that had not "
        + "happened. Locate the site by --frame-offset instead.");
    }
    const detail = this.webDetail(webs[0]);
    let offset = null;
    const raw = get(detail, "raw10");
    if (raw !== null) {
      try { offset = parseFrameOffset(raw); } catch (e) { if (!(e instanceof CascadeError)) throw e; offset = null; }
    }
    return new Site({ key: `symbol ${symbol}`, symbol, frame_offset: offset, webs, detail, caution });
  }

  resolveWeb(web) {
    const symbol = this.symbolOfWeb(web);
    if (symbol === null) {
      throw new CascadeError(`no record in ${this.name} names web=${web}. Web numbers are trace-local: they change with any edit that changes the `
        + "number of live ranges. Locate the site by --frame-offset.");
    }
    const site = this.resolveSymbol(symbol, { caution: null });
    return new Site({ key: `web ${web}`, symbol, frame_offset: site.frame_offset, webs: site.webs, detail: site.detail });
  }

  /** Build every round of one site's cascade, in log order. */
  cascade(site) {
    this.require(REQUIRED_RECORDS, { purpose: "a cascade" });
    const family = new Set(site.webs);
    const decisions = [];
    const saves = new Map(), colors = new Map(), costs = new Map(), occurrences = new Map(), pending = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    let decisionOrdinal = 0;
    this.records.forEach((record, position) => {
      const fields = fieldsObject(record);
      const web = optionalInteger(get(fields, "web"));
      if (record.phase === "p1dec" || record.phase === "p2dec") decisionOrdinal += 1;
      if (web === null || !family.has(web)) return;
      if (record.phase === "savedetail") {
        let detail = saveDetail(fields);
        if (detail !== null) {
          // `saveocc` records precede the `savedetail` that sums them.
          detail = replace(detail, { occurrences: [...(pending.get(web) ?? [])] });
          pending.delete(web);
          push(saves, web, [position, detail]);
          if (!occurrences.has(web)) occurrences.set(web, []);
          occurrences.get(web).push(...detail.occurrences);
        }
      } else if (record.phase === "saveocc") {
        const item = occurrence(fields);
        if (item !== null) push(pending, web, item);
      } else if (record.phase === "p1cost" || record.phase === "p2cost") {
        push(costs, web, { ...fields });
      } else if (record.phase === "p1dec" || record.phase === "p2dec") {
        decisions.push([position, decisionOrdinal, { ...fields }]);
      } else if (record.phase === "p1color" || record.phase === "p2color") {
        const color = optionalInteger(get(fields, "color"));
        if (color !== null) push(colors, web, color);
      }
    });
    // A savedetail before a decision is the state that decision reads.
    const claimed = new Set();
    const rounds = [];
    decisions.forEach(([position, ordinal, fields], i) => {
      const web = optionalInteger(get(fields, "web"));
      const history = web !== null ? saves.get(web) ?? [] : [];
      let entering = null;
      for (const [sp, detail] of history) if (sp < position && !claimed.has(sp)) entering = [sp, detail];
      if (entering !== null) claimed.add(entering[0]);
      rounds.push(makeRound(fields, { ordinal, index: i + 1, entering: entering === null ? null : entering[1] }));
    });
    // Whatever savedetail is left between this decision and the next one --
    // any web's -- is a piece this split carved off.
    const ordered = sorted([...saves.values()].flat(), (e) => e[0]);
    const bounded = [];
    decisions.forEach(([position], i) => {
      const following = i + 1 < decisions.length ? decisions[i + 1][0] : null;
      const inWindow = (sp) => sp > position && (following === null || sp < following);
      const pieces = ordered.filter(([sp]) => inWindow(sp) && !claimed.has(sp)).map(([, d]) => d);
      for (const [sp] of ordered) if (inWindow(sp)) claimed.add(sp);
      bounded.push(replace(rounds[i], { pieces }));
    });
    const undecided = ordered.filter(([sp]) => !claimed.has(sp)).map(([, d]) => d);
    const occ = new Map(sorted([...occurrences.entries()], (e) => e[0]));
    const cst = new Map(sorted([...costs.entries()], (e) => e[0]));
    return new Cascade({ name: this.name, site, rounds: attachColors(bounded, colors), occurrences: occ, costs: cst,
      undecided, warnings: netWarnings(bounded) });
  }
}

function noOffsetMessage(name, offset, table) {
  const plausible = sorted([...table.keys()].filter((i) => -0x4000 < i && i < 0x4000), (i) => [Math.abs(i - offset), i]);
  const nearest = plausible.slice(0, 5).map((i) => formatFrameOffset(i)).join(", ");
  return `no web in ${name} sits at frame offset ${formatFrameOffset(offset)}. `
    + "This is NOT a kill: a killed web still has a webdetail record. It means the offset is wrong, or the frame moved under you. "
    + (nearest ? `Nearest offsets present: ${nearest}.` : "No stack-resident webs are recorded at all.");
}

function saveDetail(fields) {
  const web = optionalInteger(get(fields, "web"));
  const symbol = optionalInteger(get(fields, "sym"));
  if (web === null) return null;
  return new SaveDetail({ web, symbol: symbol === null ? -1 : symbol, occurrence_count: optionalInteger(get(fields, "occ")) || 0,
    gross: toFloat(get(fields, "gross")), charge_a: toFloat(get(fields, "chargeA")), charge_b: toFloat(get(fields, "chargeB")),
    net: toFloat(get(fields, "net")), nocs: optionalInteger(get(fields, "nocs")) || 0, dtype: optionalInteger(get(fields, "dtype")),
    save: toFloat(get(fields, "save")), piece_class: optionalInteger(get(fields, "class")) });
}

/** One `saveocc` record's occurrence, or null without a web. */
export function occurrence(fields) {
  const web = optionalInteger(get(fields, "web"));
  if (web === null) return null;
  const n = (k) => optionalInteger(get(fields, k)) || 0;
  return new Occurrence({ web, index: n("occ"), block: n("bb"), uses: n("uses"), defs: n("defs"), weight: toFloat(get(fields, "weight")),
    term: toFloat(get(fields, "term")), nl: n("nl"), o22: n("o22"), o23: n("o23"), w34: n("w34") });
}

function makeRound(fields, { ordinal, index, entering }) {
  const oi = (k) => optionalInteger(get(fields, k));
  const forbidden0 = oi("forbidden0"), forbidden1 = oi("forbidden1") || 0;
  const available0 = oi("available0"), available1 = oi("available1") || 0;
  const natural = oi("bestcolor"), web = oi("web"), symbol = oi("sym");
  return new Round({
    ordinal, index, web: web === null ? -1 : web, symbol: symbol === null ? -1 : symbol, register_class: oi("class"),
    save: toFloat(get(fields, "save")), nocs: oi("nocs") || 0, net: toFloat(get(fields, "totalsave")), best_cost: toFloat(get(fields, "bestcost")),
    natural_color: natural === null || natural < 0 ? null : natural, resolved_color: null, decision: get(fields, "decision", "?"), forced: oi("forced"),
    forbidden: forbidden0 === null ? [] : [...decodeForbiddenColors(forbidden0, forbidden1)],
    mincost_tie: available0 === null ? [] : [...decodeMincostTieColors(available0, available1)],
    registers_left: oi("regsleft"), interference: oi("numintf"), entering, pieces: [],
  });
}

function netWarnings(rounds) {
  const notes = [];
  for (const item of rounds) {
    const e = item.entering;
    if (e === null || !Number.isFinite(e.net)) continue;
    if (!Number.isFinite(item.net) || Math.abs(item.net - e.net) <= 1e-6) continue;
    notes.push(`round ${item.index} (w${item.web}): p1dec totalsave ${fmtF(item.net, 6)} but savedetail net ${fmtF(e.net, 6)}. L28 says `
      + "these are one number; a log where they differ is either a different instrument revision or a mis-paired record.");
  }
  return notes;
}

/** Join `p1color` to the rounds of its own web, in order, from the end. */
function attachColors(rounds, colors) {
  const pendingColors = new Map([...colors.entries()].map(([w, l]) => [w, [...l]]));
  const resolved = [];
  for (const item of [...rounds].reverse()) {
    const queue = pendingColors.get(item.web);
    const color = queue && queue.length ? queue.pop() : null;
    resolved.push(replace(item, { resolved_color: color }));
  }
  return resolved.reverse();
}

// -- reports over a whole log, not one site ----------------------------

/** Rank the p1 colouring order, with the same-save tie groups named. */
export function colorOrderReport(log, { limit = null, register_class = null } = {}) {
  log.require(["p1dec"], { purpose: "a colour-order report" });
  const entries = [];
  let position = 0;
  for (const record of log.of("p1dec")) {
    position += 1;
    const fields = fieldsObject(record);
    const itemClass = optionalInteger(get(fields, "class"));
    if (register_class !== null && itemClass !== register_class) continue;
    const color = optionalInteger(get(fields, "bestcolor"));
    entries.push({ position, web: optionalInteger(get(fields, "web")), symbol: optionalInteger(get(fields, "sym")), register_class: itemClass,
      save: toNumber(toFloat(get(fields, "save"))), nocs: optionalInteger(get(fields, "nocs")), net: toNumber(toFloat(get(fields, "totalsave"))),
      best_cost: toNumber(toFloat(get(fields, "bestcost"))), color, register: registerForColor(color),
      interference: optionalInteger(get(fields, "numintf")), registers_left: optionalInteger(get(fields, "regsleft")),
      decision: get(fields, "decision", "?") });
  }
  const shown = limit === null ? entries : entries.slice(0, limit);
  const groups = new Map();
  for (const item of shown) {
    const v = item.save;
    if (typeof v === "number") {
      const k = pyRound(v, 6);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    }
  }
  const ties = sorted([...groups.entries()], (e) => e[0], true).filter(([, m]) => m.length > 1)
    .map(([save, members]) => ({ save, members: members.map((i) => ({ position: i.position, web: i.web })) }));
  return { log: log.name, decision_count: entries.length, shown: shown.length, register_class, order: shown, tie_groups: ties };
}

/** Each web's occurrence-block set, and where the sets meet. */
export function blockReport(log, { webs, blocks }) {
  log.require(["saveocc"], { purpose: "a block report" });
  const perWeb = new Map(), detail = new Map();
  for (const record of log.of("saveocc")) {
    const item = occurrence(fieldsObject(record));
    if (item === null) continue;
    if (!perWeb.has(item.web)) { perWeb.set(item.web, new Set()); detail.set(item.web, []); }
    perWeb.get(item.web).add(item.block);
    detail.get(item.web).push(item);
  }
  const wanted = new Set(blocks);
  let selected;
  if (webs.length) {
    const missing = webs.filter((w) => !perWeb.has(w));
    if (missing.length) {
      throw new CascadeError(`${log.name} records no occurrences for web(s) ${missing.join(", ")}; a web with no saveocc record never entered the save sum`);
    }
    selected = [...webs];
  } else if (wanted.size) {
    selected = sorted([...perWeb.entries()].filter(([, items]) => [...items].some((b) => wanted.has(b))).map(([w]) => w));
  } else throw new CascadeError("name the webs with --web, or the blocks with --block");
  let intersection = [];
  if (selected.length > 1) {
    const [first, ...rest] = selected.map((w) => perWeb.get(w));
    intersection = sorted([...first].filter((b) => rest.every((s) => s.has(b))));
  }
  return {
    log: log.name,
    webs: selected.map((web) => ({ web, block_count: perWeb.get(web).size, blocks: sorted([...perWeb.get(web)]),
      selected_blocks: wanted.size ? sorted([...perWeb.get(web)].filter((b) => wanted.has(b))) : [],
      occurrences: detail.get(web).map((o) => o.asDict()) })),
    queried_blocks: sorted([...wanted]),
    intersection,
    disjoint: selected.length > 1 && !intersection.length,
  };
}

/** Which of these colours' registers the reference object uses (occupancy). */
export function romColorOccupancy(instructions, { colors, rows = null }) {
  const [low, high] = rows !== null ? rows : [1, instructions.length];
  const seen = new Set();
  instructions.forEach((item, i) => {
    const index = i + 1;
    if (!(low <= index && index <= high)) return;
    for (const token of String(item?.assembly ?? "").match(REGISTER_RE) ?? []) seen.add(token.toLowerCase());
  });
  const present = [], absent = [];
  for (const color of colors) {
    const register = registerForColor(color);
    if (register === null) continue;
    (seen.has(register.toLowerCase()) ? present : absent).push({ color, register });
  }
  return { rows: [low, Math.min(high, instructions.length)], present, absent,
    reading: "occupancy over the named rows, not a liveness analysis: absence is proof the colour was free, presence is not proof it was taken" };
}

/** Normalise `p1cost` records, flagging IDO's unavailable-cost sentinel. */
export function costRows(costs) {
  return costs.map((entry) => {
    const color = optionalInteger(get(entry, "color"));
    const value = toFloat(get(entry, "cost"));
    return { color, register: registerForColor(color), kind: get(entry, "kind"), cost: toNumber(value),
      eligible: Number.isFinite(value) && !isIneligibleAllocatorCost(value) };
  });
}

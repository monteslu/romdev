// globalcolor.js - parsers for the uopt globalcolor traces: the stable
// CSAVE/CUP live-range records and the later [CDX] decision records, joined
// into per-web allocator decisions with their costs, interference edges and
// provenance snapshots.
//
// Plain JS ESM + JSDoc.

import { PassEvidence } from "./pass-evidence.js";
import { pyInt, sorted, splitlines, strip, floatRepr } from "./py.js";

/** Color to machine register for the pinned IDO 5.3 profile. */
export const COLOR_REGISTERS = new Map([
  [1, "v0"], [2, "v1"], [3, "a0"], [4, "a1"], [5, "a2"], [6, "a3"],
  ...Array.from({ length: 6 }, (_, i) => [7 + i, `t${i}`]),
  ...Array.from({ length: 9 }, (_, i) => [14 + i, `s${i}`]),
  [23, "ra"],
]);

/** Color to floating-point register, class 2 of the same color space. */
export const FP_COLOR_REGISTERS = new Map([
  [24, "$f0"], [25, "$f2"], [26, "$f12"], [27, "$f14"], [28, "$f16"], [29, "$f18"],
]);

/** ugen's local scratch rotation; p1 never colors into it. */
export const FP_LOCAL_RING = Object.freeze(["$f4", "$f6", "$f8", "$f10"]);

/** The one table every trace reader looks a color up in. */
export const ALLOCATOR_COLOR_REGISTERS = new Map([...COLOR_REGISTERS, ...FP_COLOR_REGISTERS]);

/** Name a color's machine register where the pinned profile confirms it. */
export function registerForColor(color) {
  return color === null || color === undefined ? null : ALLOCATOR_COLOR_REGISTERS.get(color) ?? null;
}

const removeDollar = (s) => (s.startsWith("$") ? s.slice(1) : s);

/** Return the pinned allocator color for one physical register name. */
export function colorForRegister(register) {
  const normalized = removeDollar(register).toLowerCase();
  for (const [color, name] of ALLOCATOR_COLOR_REGISTERS) if (removeDollar(name) === normalized) return color;
  return null;
}

/** Highest color the two forbidden/available mask words can describe. */
export const MAX_MASK_COLOR = 63;

function colorBitSet(word0, word1, color) {
  if (color < 0 || color > MAX_MASK_COLOR) return false;
  if (color < 32) return Boolean((BigInt(word0) >> BigInt(31 - color)) & 1n);
  return Boolean((BigInt(word1) >> BigInt(63 - color)) & 1n);
}

function colorsInMask(word0, word1) {
  const out = [];
  for (let c = 0; c <= MAX_MASK_COLOR; c++) if (colorBitSet(word0, word1, c)) out.push(c);
  return out;
}

/** Return whether a web's interference mask rules one color out. */
export function colorIsForbidden(forbidden0, forbidden1, color) { return colorBitSet(forbidden0, forbidden1, color); }

/** Every color the two mask words rule out, ascending. */
export function decodeForbiddenColors(forbidden0, forbidden1) { return colorsInMask(forbidden0, forbidden1); }

/** Every color tied for minimum cost, ascending. */
export function decodeMincostTieColors(available0, available1) { return colorsInMask(available0, available1); }

export const FLOAT_PATTERN = String.raw`(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[-+]?(?:inf|nan))`;
export const CSAVE_RE = new RegExp(String.raw`^CSAVE\s+bitpos=(?<bitpos>\d+)\s+kind=(?<kind>\d+)\s+dtype=(?<dtype>\d+)\s+unk1C=(?<weight>-?\d+)\s+`
  + String.raw`adjsave=(?<adjusted_save>${FLOAT_PATTERN})\s+unk23=(?<flag>\d+)`, "i");
export const CUP_RE = new RegExp(String.raw`^CUP\s+bitpos=(?<bitpos>\d+)\s+reg=(?<register>-?\d+)\s+cs=(?<color_class>-?\d+)\s+`
  + String.raw`cost=(?<cost>${FLOAT_PATTERN})`, "i");
export const CDX_RE = /^\[CDX\]\s+(?<phase>\S+)\s+(?<fields>.*)$/;
export const FIELD_RE = /([A-Za-z0-9_]+)=([^\s]+)/g;

/** IDO's finite unavailable-color sentinel sits at or above this. */
export const IDO_INELIGIBLE_COST_FLOOR = 1.0e19;

/** float(text) with the original's accepted spellings; NaN-free failure throws. */
export function pyFloat(text) {
  const s = strip(String(text)).replace(/(?<=\d)_(?=\d)/g, "");
  const m = /^([-+]?)(?:(inf(?:inity)?)|(nan)|((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?))$/i.exec(s);
  if (!m) throw new Error(`could not convert string to float: '${text}'`);
  const neg = m[1] === "-";
  if (m[2]) return neg ? -Infinity : Infinity;
  if (m[3]) return NaN;
  const v = Number(m[4]);
  return neg ? -v : v;
}

/** Parse one optional trace integer without trusting diagnostic text. */
export function optionalInteger(value) {
  if (value === null || value === undefined) return null;
  try { return pyInt(value, 0); } catch { return null; }
}

/** Return whether an IDO color cost is the unavailable-color sentinel. */
export function isIneligibleAllocatorCost(value) { return Number.isFinite(value) && value >= IDO_INELIGIBLE_COST_FLOOR; }

/** Finite values as numbers, non-finite values as JSON strings. */
export function serializeFloat(value) {
  if (Number.isFinite(value)) return value;
  if (Number.isNaN(value)) return "nan";
  return value > 0 ? "inf" : "-inf";
}

/** `{value:g}` / `{value:Wg}`: six significant digits, trailing zeros trimmed. */
export function formatG(value, width = 0, precision = 6) {
  let s;
  if (Number.isNaN(value)) s = "nan";
  else if (!Number.isFinite(value)) s = value > 0 ? "inf" : "-inf";
  else if (value === 0) s = Object.is(value, -0) ? "-0" : "0";
  else {
    const p = precision === 0 ? 1 : precision;
    const exp = Number(value.toExponential(p - 1).split("e")[1]);
    if (exp < -4 || exp >= p) {
      let [m, e] = value.toExponential(p - 1).split("e");
      if (m.includes(".")) m = m.replace(/0+$/, "").replace(/\.$/, "");
      const en = Number(e);
      s = `${m}e${en < 0 ? "-" : "+"}${String(Math.abs(en)).padStart(2, "0")}`;
    } else {
      s = value.toFixed(Math.max(0, p - 1 - exp));
      if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    }
  }
  return s.padStart(width, " ");
}

/** The measured cost of assigning one color/register. */
export class ColorCost {
  constructor({ register, color_class, cost }) { Object.assign(this, { register, color_class, cost }); Object.freeze(this); }
  get eligible() { return Number.isFinite(this.cost) && !isIneligibleAllocatorCost(this.cost); }
  asDict() { return { register: this.register, color_class: this.color_class, cost: serializeFloat(this.cost), eligible: this.eligible }; }
}

/** One live range or web observed by CSAVE/CUP instrumentation. */
export class LiveRange {
  constructor({ bitpos, kind, dtype, weight, adjusted_save, flag, color_costs = [] }) {
    Object.assign(this, { bitpos, kind, dtype, weight, adjusted_save, flag, color_costs });
  }
  get total_save() { return this.adjusted_save * this.weight; }
  get finite_costs() { return this.color_costs.filter((c) => Number.isFinite(c.cost)); }
  get eligible_costs() { return this.color_costs.filter((c) => c.eligible); }
  asDict() {
    return { bitpos: this.bitpos, kind: this.kind, dtype: this.dtype, weight: this.weight,
      adjusted_save: serializeFloat(this.adjusted_save), flag: this.flag,
      color_costs: this.color_costs.map((c) => c.asDict()), total_save: serializeFloat(this.total_save),
      finite_color_costs: this.finite_costs.map((c) => c.asDict()), eligible_color_costs: this.eligible_costs.map((c) => c.asDict()) };
  }
}

/** A higher-level CDX globalcolor decision record. */
export class ColorDecision {
  constructor({ phase, fields, raw }) { Object.assign(this, { phase, fields, raw }); Object.freeze(this); }
  asDict() { return { phase: this.phase, fields: { ...this.fields }, raw: this.raw }; }
}

const get = (o, k, d = null) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

/** One allocator decision joined with optional webdetail metadata. */
export class AllocatorWebDecision {
  static CONTEST_ADVICE = "regsleft=0 at this decision: the register was taken, not "
    + "underpriced, so no cost lever can win it -- field-guide lever 28 "
    + "(decomp-workbench guide 28) frees a slot by taking a local out of "
    + "web candidacy";

  constructor({ proc, web, phase, fields, detail, color_costs, interference, decision_trace_ordinal }) {
    Object.assign(this, { proc, web, phase, fields, detail, color_costs, interference, decision_trace_ordinal });
    Object.freeze(this);
  }
  get CONTEST_ADVICE() { return AllocatorWebDecision.CONTEST_ADVICE; }
  get dtype() { return optionalInteger(get(this.detail, "dtype")); }
  get total_save() {
    try { return pyFloat(get(this.fields, "totalsave", "nan")); } catch { return NaN; }
  }
  get assigned_color() {
    const value = get(this.fields, "actualcolor", get(this.fields, "bestcolor"));
    if (value === null) return null;
    const color = optionalInteger(value);
    return color !== null && color >= 0 ? color : null;
  }
  get natural_color() {
    const color = optionalInteger(get(this.fields, "bestcolor"));
    return color !== null && color >= 0 ? color : null;
  }
  get phase_tag() { return get(this.fields, "phase") || this.phase.slice(0, 2); }
  get force_key() { return `${this.phase_tag}:w${this.web}`; }
  get assigned_register() { return registerForColor(this.assigned_color); }
  get forbidden_colors() {
    const first = optionalInteger(get(this.fields, "forbidden0"));
    if (first === null) return [];
    const second = optionalInteger(get(this.fields, "forbidden1")) || 0;
    return decodeForbiddenColors(first, second);
  }
  get mincost_tie_colors() {
    const first = optionalInteger(get(this.fields, "available0"));
    if (first === null) return [];
    const second = optionalInteger(get(this.fields, "available1")) || 0;
    return decodeMincostTieColors(first, second);
  }
  get registers_left() { return optionalInteger(get(this.fields, "regsleft")); }
  get contested_allocation() {
    return ["split", "no-color"].includes(get(this.fields, "decision")) && this.registers_left === 0;
  }
  get explanation() {
    const decision = get(this.fields, "decision", "unknown");
    const contest = this.contested_allocation ? `; ${AllocatorWebDecision.CONTEST_ADVICE}` : "";
    if (decision === "split") {
      return "split: this web was divided instead of receiving one "
        + "allocation; inspect its live range and interference edges" + contest;
    }
    const color = this.assigned_color;
    if (color === null) return `${decision}: no selected color was recorded${contest}`;
    const register = this.assigned_register;
    const target = `c${color}` + (register ? ` (${register})` : "");
    return `${decision}: selected ${target}${contest}`;
  }

  /** Measure the source-level barrier between natural and desired colors. */
  colorBarrier(desiredColor) {
    const costs = new Map();
    for (const record of this.color_costs) {
      const color = optionalInteger(get(record, "color"));
      if (color === null) continue;
      if (!Object.prototype.hasOwnProperty.call(record, "cost")) continue;
      try { costs.set(color, pyFloat(record.cost)); } catch { continue; }
    }
    const naturalColor = this.natural_color;
    const naturalCost = naturalColor !== null ? costs.get(naturalColor) ?? null : null;
    const desiredCost = costs.get(desiredColor) ?? null;
    const desiredForbidden = this.forbidden_colors.includes(desiredColor);
    const desiredIneligible = desiredCost !== null && isIneligibleAllocatorCost(desiredCost);
    const gap = desiredCost !== null && naturalCost !== null && !desiredIneligible && !isIneligibleAllocatorCost(naturalCost)
      ? desiredCost - naturalCost : null;
    const desiredRegister = registerForColor(desiredColor);
    const naturalRegister = registerForColor(naturalColor);
    const blockingNeighbors = [];
    for (const edge of this.interference) {
      const assigned = optionalInteger(String(get(edge, "assigned", "")));
      if (assigned !== desiredColor) continue;
      const neighborWeb = optionalInteger(String(get(edge, "other", "")));
      const neighborDetail = get(edge, "neighbor_detail");
      blockingNeighbors.push({
        phase: this.phase_tag, web: neighborWeb,
        force_key: neighborWeb !== null ? `${this.phase_tag}:w${neighborWeb}` : null,
        assigned_color: assigned, assigned_register: registerForColor(assigned),
        detail: neighborDetail && typeof neighborDetail === "object" && !Array.isArray(neighborDetail) ? neighborDetail : {},
      });
    }
    let status, advice;
    if (desiredColor === naturalColor) {
      status = "already-natural";
      advice = "the desired color is already the allocator's natural choice; "
        + "inspect any later force override or downstream recoloring "
        + "instead of searching for a cost or tie-break source edit";
    } else if (desiredForbidden) {
      status = "desired-forbidden";
      if (blockingNeighbors.length) {
        const blockers = blockingNeighbors.map((i) => String(i.force_key || "unknown web")).join(", ");
        advice = "the desired color is occupied by an interfering web "
          + `(${blockers}); reshape that overlap or create a legal `
          + "coalescing/reuse edge before testing relative cost. The "
          + "register is taken, not underpriced: field-guide lever 28 "
          + "(decomp-workbench guide 28) removes a competing local "
          + "from web candidacy outright rather than reweighting it";
      } else {
        advice = "the desired color is ruled out by interference; recapture "
          + `with CDX_DETAIL_WEB=${this.web} to name the blocking web`;
      }
    } else if (desiredIneligible) {
      status = "desired-ineligible";
      advice = "the desired color has IDO's unavailable-cost sentinel, not a "
        + "large affinity penalty; inspect the register-class/availability "
        + "constraints before attempting a cost or tie-break source edit";
    } else if (gap === null) {
      status = "cost-unmeasured";
      advice = "the trace does not contain both costs; capture p1cost/p2cost "
        + "records before choosing a source lever";
    } else if (gap > 0) {
      status = "natural-cheaper";
      advice = "make the natural color unavailable or improve the desired "
        + `color's relative cost/affinity by more than ${formatG(gap)}`;
    } else if (gap === 0) {
      status = "tie-break";
      advice = "both colors have equal measured cost; investigate traversal, "
        + "coalescing, and tie-break order";
    } else {
      status = "desired-cheaper-but-unselected";
      advice = "the desired color is cheaper in the captured costs; inspect "
        + "eligibility and whether this cost record precedes selection";
    }
    return {
      status, natural_color: naturalColor, natural_register: naturalRegister,
      natural_cost: naturalCost !== null ? serializeFloat(naturalCost) : null,
      desired_color: desiredColor, desired_register: desiredRegister,
      desired_cost: desiredCost !== null ? serializeFloat(desiredCost) : null,
      desired_forbidden: desiredForbidden, desired_ineligible: desiredIneligible,
      blocking_neighbors: blockingNeighbors, interference_recorded: this.interference.length > 0,
      cost_gap: gap !== null ? serializeFloat(gap) : null, advice,
      claim_boundary: "a force tests the endpoint only; stock-compiler acceptance "
        + "still requires a source-caused allocator decision",
    };
  }

  asDict() {
    return {
      proc: this.proc, web: this.web, phase: this.phase, phase_tag: this.phase_tag, force_key: this.force_key,
      fields: this.fields, detail: this.detail, color_costs: this.color_costs, interference: this.interference,
      decision_trace_ordinal: this.decision_trace_ordinal, assigned_color: this.assigned_color,
      assigned_register: this.assigned_register, natural_color: this.natural_color,
      natural_register: registerForColor(this.natural_color), forbidden_colors: this.forbidden_colors,
      mincost_tie_colors: this.mincost_tie_colors, explanation: this.explanation,
    };
  }
}

const saveKey = (v) => [Number.isNaN(v), !Number.isNaN(v) ? -v : 0.0];
const tk = (...parts) => JSON.stringify(parts);

function uniqueProvenance(entries) {
  if (!entries) return {};
  const keys = Object.keys(entries);
  if (keys.length !== 2 || !keys.includes("preselect") || !keys.includes("postselect")) return {};
  if (keys.some((s) => entries[s].length !== 1)) return {};
  const before = entries.preselect[0], after = entries.postselect[0];
  const merged = {};
  for (const name of sorted(new Set([...Object.keys(before), ...Object.keys(after)]))) {
    if (name === "snapshot") continue;
    const pre = get(before, name), post = get(after, name);
    if (pre === post && pre !== null) merged[name] = pre;
    else {
      if (pre !== null) merged[`preselect_${name}`] = pre;
      if (post !== null) merged[`postselect_${name}`] = post;
    }
  }
  return merged;
}

const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Parsed globalcolor live ranges and decisions. */
export class GlobalColorTrace {
  /** @param {{live_ranges: Map<number, LiveRange>, decisions: ColorDecision[], unparsed_diagnostic_lines: string[]}} f */
  constructor({ live_ranges, decisions, unparsed_diagnostic_lines }) {
    Object.assign(this, { live_ranges, decisions, unparsed_diagnostic_lines });
  }

  ranked({ dtype = null, limit = null } = {}) {
    const selected = sorted([...this.live_ranges.values()].filter((i) => dtype === null || i.dtype === dtype),
      (i) => [...saveKey(i.total_save), i.bitpos]);
    return limit ? selected.slice(0, limit) : selected;
  }

  decisionsFor(proc = null, { web = null } = {}) {
    return this.decisions.filter((item) => {
      if (proc !== null && optionalInteger(get(item.fields, "proc")) !== proc) return false;
      if (web !== null && optionalInteger(get(item.fields, "web")) !== web) return false;
      return true;
    });
  }

  lineageFor(proc = null, { tables = null } = {}) {
    return this.decisions.filter((item) => {
      if (item.phase !== "lineage_range" && item.phase !== "lineage_member") return false;
      if (proc !== null && optionalInteger(get(item.fields, "proc")) !== proc) return false;
      if (tables !== null && !tables.has(optionalInteger(get(item.fields, "table")))) return false;
      return true;
    });
  }

  webdetailTables() {
    const tables = new Set();
    for (const item of this.decisions) {
      if (item.phase !== "webdetail") continue;
      for (const key of ["table", "exprtable"]) {
        const v = optionalInteger(get(item.fields, key));
        if (v !== null) tables.add(v);
      }
    }
    return tables;
  }

  allocatorWebs({ proc = null, web = null, dtype = null, limit = null } = {}) {
    const decisionPhases = new Map();
    for (const item of this.decisions) {
      if (item.phase !== "p1dec" && item.phase !== "p2dec") continue;
      const p = optionalInteger(get(item.fields, "proc")), w = optionalInteger(get(item.fields, "web"));
      if (p === null || w === null) continue;
      const k = tk(p, w);
      if (!decisionPhases.has(k)) decisionPhases.set(k, new Set());
      decisionPhases.get(k).add(get(item.fields, "phase") || item.phase.slice(0, 2));
    }
    const details = new Map(), legacyDetails = new Map(), costs = new Map(), interference = new Map();
    const neighborDetails = new Map(), provenance = new Map(), allocations = new Map();
    for (const item of this.decisions) {
      if (!has(item.fields, "proc") || !has(item.fields, "web")) continue;
      const p = optionalInteger(item.fields.proc), w = optionalInteger(item.fields.web);
      if (p === null || w === null) continue;
      const dp = get(item.fields, "phase");
      if (item.phase === "webdetail" && get(item.fields, "role") === "target") {
        if (dp === "p1" || dp === "p2") details.set(tk(p, w, dp), item.fields);
        else legacyDetails.set(tk(p, w), item.fields);
      } else if (item.phase === "webdetail" && get(item.fields, "role") === "neighbor") {
        if (dp === "p1" || dp === "p2") push(neighborDetails, tk(p, w, dp), item.fields);
      } else if (item.phase === "intf") {
        if (dp === "p1" || dp === "p2") push(interference, tk(p, w, dp), item.fields);
      } else if (item.phase === "p1cost" || item.phase === "p2cost") {
        push(costs, tk(p, w, item.phase.slice(0, 2)), item.fields);
      } else if (item.phase === "provenance_web") {
        const snapshot = get(item.fields, "snapshot");
        if ((dp === "p1" || dp === "p2") && (snapshot === "preselect" || snapshot === "postselect")) {
          const k = tk(p, w, dp);
          if (!provenance.has(k)) provenance.set(k, {});
          (provenance.get(k)[snapshot] ??= []).push(item.fields);
        }
      } else if (item.phase === "p1color" || item.phase === "p2color") {
        push(allocations, tk(p, w, item.phase.slice(0, 2)), item.fields);
      }
    }

    let joined = [];
    const traceCounts = new Map();
    for (const item of this.decisions) {
      if (item.phase !== "p1dec" && item.phase !== "p2dec") continue;
      if (!has(item.fields, "proc") || !has(item.fields, "web")) continue;
      const p = optionalInteger(item.fields.proc), w = optionalInteger(item.fields.web);
      if (p === null || w === null) continue;
      const phase = get(item.fields, "phase") || item.phase.slice(0, 2);
      const ok = tk(p, phase);
      traceCounts.set(ok, (traceCounts.get(ok) ?? 0) + 1);
      let detail = details.get(tk(p, w, phase)) ?? null;
      if (detail === null) {
        const phases = decisionPhases.get(tk(p, w));
        if (phases && phases.size === 1 && phases.has(phase)) detail = legacyDetails.get(tk(p, w)) ?? null;
      }
      const provenanceDetail = uniqueProvenance(provenance.get(tk(p, w, phase)));
      if (Object.keys(provenanceDetail).length) detail = { ...provenanceDetail, ...(detail || {}) };
      const decisionFields = { ...item.fields };
      const rows = allocations.get(tk(p, w, phase)) ?? [];
      if (rows.length === 1) {
        const ac = get(rows[0], "color"), ar = get(rows[0], "reg");
        if (ac !== null) decisionFields.actualcolor = ac;
        if (ar !== null) decisionFields.actualreg = ar;
      }
      const joinedInterference = [];
      for (const edge of interference.get(tk(p, w, phase)) ?? []) {
        const joinedEdge = { ...edge };
        const other = optionalInteger(get(edge, "other"));
        const candidates = other !== null ? neighborDetails.get(tk(p, other, phase)) ?? [] : [];
        const unique = new Map();
        for (const c of candidates) {
          const items = sorted(Object.entries(c));
          unique.set(JSON.stringify(items), items);
        }
        if (unique.size === 1) joinedEdge.neighbor_detail = Object.fromEntries([...unique.values()][0]);
        joinedInterference.push(joinedEdge);
      }
      const joinedItem = new AllocatorWebDecision({
        proc: p, web: w, phase: item.phase, fields: decisionFields, detail: detail || {},
        color_costs: costs.get(tk(p, w, item.phase.slice(0, 2))) ?? [], interference: joinedInterference,
        decision_trace_ordinal: traceCounts.get(ok),
      });
      if (proc !== null && p !== proc) continue;
      if (web !== null && w !== web) continue;
      if (dtype !== null && joinedItem.dtype !== dtype) continue;
      joined.push(joinedItem);
    }
    joined = sorted(joined, (i) => [...saveKey(i.total_save), i.proc, i.web, i.phase]);
    return limit ? joined.slice(0, limit) : joined;
  }

  asDict() {
    return {
      live_ranges: this.ranked().map((i) => i.asDict()),
      allocator_webs: this.allocatorWebs().map((i) => i.asDict()),
      decisions: this.decisions.map((i) => i.asDict()),
      unparsed_diagnostic_lines: this.unparsed_diagnostic_lines,
    };
  }
}

/** Parse the stable CSAVE/CUP format and the later CDX format. */
export function parseGlobalcolorTrace(text) {
  const liveRanges = new Map(), pendingCosts = new Map(), decisions = [], unparsed = [];
  for (const raw of splitlines(text)) {
    const line = strip(raw);
    let m = CSAVE_RE.exec(line);
    if (m) {
      const g = m.groups;
      const bitpos = pyInt(g.bitpos);
      const pending = pendingCosts.get(bitpos) ?? [];
      pendingCosts.delete(bitpos);
      liveRanges.set(bitpos, new LiveRange({ bitpos, kind: pyInt(g.kind), dtype: pyInt(g.dtype), weight: pyInt(g.weight),
        adjusted_save: pyFloat(g.adjusted_save), flag: pyInt(g.flag), color_costs: pending }));
      continue;
    }
    m = CUP_RE.exec(line);
    if (m) {
      const g = m.groups;
      const bitpos = pyInt(g.bitpos);
      const item = new ColorCost({ register: pyInt(g.register), color_class: pyInt(g.color_class), cost: pyFloat(g.cost) });
      if (liveRanges.has(bitpos)) liveRanges.get(bitpos).color_costs.push(item);
      else push(pendingCosts, bitpos, item);
      continue;
    }
    m = CDX_RE.exec(line);
    if (m) {
      const fields = {};
      for (const f of m.groups.fields.matchAll(FIELD_RE)) fields[f[1]] = f[2];
      decisions.push(new ColorDecision({ phase: m.groups.phase, fields, raw }));
      continue;
    }
    if (line.startsWith("CSAVE") || line.startsWith("CUP") || line.startsWith("[CDX]")) unparsed.push(raw);
  }
  for (const bitpos of pendingCosts.keys()) unparsed.push(`CUP records for bitpos=${bitpos} appeared without CSAVE`);
  return new GlobalColorTrace({ live_ranges: liveRanges, decisions, unparsed_diagnostic_lines: unparsed });
}

/** Return what this trace settles about the pass that owns a residual. */
export function passEvidence(trace, { proc = null, web = null } = {}) {
  const selected = (item) => {
    if (proc !== null && optionalInteger(get(item.fields, "proc")) !== proc) return false;
    return web === null || optionalInteger(get(item.fields, "web")) === web;
  };
  const declined = trace.decisions.some((i) => i.phase === "force_declined" && selected(i));
  const contested = trace.allocatorWebs({ proc, web }).some((i) => i.contested_allocation);
  return new PassEvidence({ contested_allocation: contested, force_declined: declined });
}

export { floatRepr };

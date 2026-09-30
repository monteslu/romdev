// decompme-search.js - gate 0: is this function already matched in public?
// A query is a set of terms (a name and every spelling of an address), each
// asked separately and merged; --max-score (instruction count times 100) is a
// binding filter over the union rather than a search term, because a scratch
// named after a data label is only found by its size.
//
// Plain JS ESM + JSDoc.

import { ValueError, strRepr, sorted } from "./py.js";
import { formatG } from "./globalcolor.js";
import { urlParts } from "./decompme-fetch.js";

export const DEFAULT_API_BASE = "https://decomp.me/api";
export const SEARCH_SCHEMA = "decomp-workbench-public-match-check-v1";
export const SCORE_UNITS_PER_INSTRUCTION = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const ADDRESS_RE = /^(?:0x)?([0-9a-fA-F]{4,16})$/;

/** One public scratch, with only the fields a gate-0 decision needs. */
export class SearchHit {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  /** A site-verified zero: the site compiled it and found no difference. */
  get is_public_match() { return this.score === 0 && this.match_override === false; }
  /** An owner-declared match the site did not verify. */
  get is_override_claim() { return this.match_override === true; }
  asDict({ api_base }) {
    return { slug: this.slug, name: this.name, owner: this.owner, score: this.score, max_score: this.max_score,
      match_override: this.match_override, last_updated: this.last_updated, found_by: [...this.found_by],
      url: scratchUrl(this.slug, { api_base }), public_match: this.is_public_match, override_claim: this.is_override_claim };
  }
}

function scratchUrl(slug, { api_base }) {
  const p = urlParts(api_base);
  return `${p.netloc ? `${p.scheme}://${p.netloc}` : "https://decomp.me"}/scratch/${slug}`;
}

/** The spellings of `address` a scratch name might use. */
export function addressTerms(address) {
  const m = ADDRESS_RE.exec(address.trim());
  if (!m) throw new ValueError(`not a hexadecimal address: ${strRepr(address)}. Pass something like 0x800C1A90 or 800c1a90.`);
  const digits = m[1];
  const seen = [];
  for (const term of [digits.toUpperCase(), digits.toLowerCase(), `0x${digits.toLowerCase()}`]) if (!seen.includes(term)) seen.push(term);
  return seen;
}

function integer(v) { return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null; }

function owner(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const key of ["username", "name", "display_name"]) if (typeof v[key] === "string" && v[key]) return v[key];
  }
  return null;
}

function hit(payload, term) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const slug = payload.slug;
  if (typeof slug !== "string" || !slug) return null;
  const override = payload.match_override;
  return new SearchHit({ slug, name: typeof payload.name === "string" ? payload.name : null, owner: owner(payload.owner),
    score: integer(payload.score), max_score: integer(payload.max_score), match_override: typeof override === "boolean" ? override : null,
    last_updated: typeof payload.last_updated === "string" ? payload.last_updated : null, found_by: [term] });
}

/** urllib.parse.quote with its default safe set ("/"). */
export function quote(s) {
  return [...Buffer.from(s, "utf8")].map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_.~\-/]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export function searchUrl(term, { api_base, page_size }) {
  return `${api_base.replace(/\/+$/, "")}/scratch?search=${quote(term)}&page_size=${page_size}`;
}

/** Query the public search for every term, and report what came back. */
export async function publicMatchCheck({ client, query = null, address = null, max_score = null, instructions = null, api_base = DEFAULT_API_BASE, page_size = DEFAULT_PAGE_SIZE }) {
  const terms = [];
  if (query && query.trim()) terms.push(query.trim());
  if (address) terms.push(...addressTerms(address));
  if (!terms.length) {
    throw new ValueError("nothing to search for. Give a function name, an --address, or both. --max-score binds the result size; the public search itself takes a term, so it cannot be the only input.");
  }
  if (instructions !== null && max_score !== null) throw new ValueError("give --max-score or --instructions, not both");
  if (instructions !== null) max_score = instructions * SCORE_UNITS_PER_INSTRUCTION;
  page_size = Math.max(1, Math.min(page_size, MAX_PAGE_SIZE));
  const ordered = new Map();
  const queries = [];
  const seenTerms = [];
  for (const term of terms) {
    if (seenTerms.includes(term)) continue;
    seenTerms.push(term);
    const url = searchUrl(term, { api_base, page_size });
    const payload = await client.getJson(url);
    const results = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.results : undefined;
    if (!Array.isArray(results)) throw new ValueError(`${url} did not answer with a search page: expected a 'results' list.`);
    queries.push({ term, url, returned: results.length });
    for (const item of results) {
      const h = hit(item, term);
      if (h === null) continue;
      const previous = ordered.get(h.slug);
      ordered.set(h.slug, previous === undefined ? h : new SearchHit({ ...previous, found_by: [...previous.found_by, term] }));
    }
  }
  let hits = [...ordered.values()];
  let excluded = 0;
  if (max_score !== null) {
    const bound = hits.filter((h) => h.max_score === max_score);
    excluded = hits.length - bound.length;
    hits = bound;
  }
  hits = sorted(hits, (h) => [h.score !== null ? h.score : 2 ** 30, h.slug]);
  const warnings = [];
  if (max_score !== null && max_score % SCORE_UNITS_PER_INSTRUCTION) {
    warnings.push(`max_score=${max_score} is not a multiple of ${SCORE_UNITS_PER_INSTRUCTION}; decomp.me binds it to the target's instruction count times ${SCORE_UNITS_PER_INSTRUCTION}. If you meant an instruction count, pass --instructions.`);
  }
  const matches = hits.filter((h) => h.is_public_match);
  const claims = hits.filter((h) => h.is_override_claim);
  return {
    schema: SEARCH_SCHEMA,
    gate: "gate-0-public-novelty",
    queries,
    max_score_binding: max_score === null ? null : { max_score, instructions: max_score / SCORE_UNITS_PER_INSTRUCTION, excluded_results: excluded },
    warnings,
    result_count: hits.length,
    results: hits.map((h) => h.asDict({ api_base })),
    public_matches: matches.map((h) => h.slug),
    override_claims: claims.map((h) => h.slug),
    verdict: matches.length ? "public-match-exists" : claims.length ? "override-claim-only" : "no-public-match",
    limits: [
      "The public search takes a term; family walks and name-only lookups both miss matches in unrelated lineages.",
      "An empty result is not proof that no public match exists \u2014 a scratch may be named after a data label rather than the function. Bind on --max-score as well.",
    ],
  };
}

const flag = (v) => (v === null || v === undefined ? "?" : v ? "true" : "false");

function verdictLine(report) {
  if (report.verdict === "public-match-exists") return "gate 0: a site-verified public match already exists. Read it before spending a campaign on this function.";
  if (report.verdict === "override-claim-only") return "gate 0: only owner-declared matches were found. Verify one locally with check-scratch before treating it as done.";
  return "gate 0: no public match found for these terms. That is not proof of novelty; try the address and the max_score binding too.";
}

/** Render the report for a person, loudest fact first. */
export function renderPublicMatchCheck(report) {
  const matches = report.public_matches, claims = report.override_claims;
  const lines = [`public match check: ${report.result_count} scratches, ${matches.length} site-verified match(es), ${claims.length} override claim(s)`];
  lines.push(`queries: ${report.queries.map((q) => strRepr(q.term)).join(", ")}`);
  const binding = report.max_score_binding;
  if (binding !== null) {
    lines.push(`bound to max_score=${binding.max_score} (${formatG(binding.instructions)} instructions); ${binding.excluded_results} other result(s) excluded`);
  }
  for (const entry of report.results) {
    const score = entry.score === null ? "?" : entry.score;
    const maximum = entry.max_score === null ? "?" : entry.max_score;
    const common = `slug=${entry.slug} owner=${entry.owner || "?"} score=${score}/${maximum} override=${flag(entry.match_override)} updated=${entry.last_updated || "?"}`;
    if (entry.public_match) { lines.push(`!! MATCH  ${common}`); lines.push(`           ${entry.url}`); }
    else if (entry.override_claim) {
      lines.push(`!! CLAIM  ${common}`);
      lines.push("           match_override=true: the owner declared this a match and the site did not verify it. Read it, do not trust the score.");
      lines.push(`           ${entry.url}`);
    } else lines.push(`   near   ${common}`);
  }
  lines.push(...report.warnings.map((w) => `warning: ${w}`));
  lines.push(verdictLine(report));
  lines.push(...report.limits.map((l) => `limit: ${l}`));
  return lines;
}

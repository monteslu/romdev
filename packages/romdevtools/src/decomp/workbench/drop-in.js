// drop-in.js - one instrumented `cc` carrying both passes' traces, planned
// and audited. plan() writes the reproducible two-profile recipe (which
// generated source each profile is applied to, in which order, closed by
// which gates); audit() byte-scans the built binaries for each profile's
// injected marker strings, so a profile that did not survive a rebuild is a
// failed check rather than a week of empty logs. The audit is one-sided: a
// marker present proves the profile was compiled in, not that it fires.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { ValueError } from "./py.js";
import { shlexQuote } from "./pass-replay-cli.js";

export const PLAN_SCHEMA = "decomp-workbench-drop-in-plan-v1";
export const AUDIT_SCHEMA = "decomp-workbench-drop-in-audit-v1";

/** str(Path(p)): the original's normalized spelling of a path. */
export function pathStr(p) {
  let s = String(p);
  if (s === "") return ".";
  const abs = s.startsWith("/");
  const parts = s.split("/").filter((x) => x && x !== ".");
  const lead = abs ? (s.startsWith("//") && !s.startsWith("///") ? "//" : "/") : "";
  return lead + parts.join("/") || (abs ? "/" : ".");
}
const join = (a, b) => pathStr(`${pathStr(a)}/${b}`);

export class Profile {
  constructor({ name, source, command, environment, markers, answers }) {
    Object.assign(this, { name, source, command, environment, markers, answers });
    Object.freeze(this);
  }
  asDict() {
    return { profile: this.name, source: this.source, command: [...this.command], environment: [...this.environment], markers: [...this.markers], answers: this.answers };
  }
}

/** The four profiles a complete drop-in carries, in application order. */
export const PROFILES = Object.freeze([
  new Profile({ name: "uopt-globalcolor", source: "uopt.c",
    command: ["instrument-uopt", "--profile", "globalcolor", "--profile", "alias", "{input}", "{output}"],
    environment: ["CDX_LOG", "CDX_OUT", "CDX_DETAIL_WEB", "CDX_FORCE"], markers: ["CDX_LOG", "CDX_OUT", "CDX_FORCE"],
    answers: "which web took which colour, what each occurrence was charged, and whether a forced colour is accepted or declined -- the only direct evidence for an allocation tie" }),
  new Profile({ name: "uopt-alias", source: "uopt.c", command: [], environment: ["DKWB_UOPT_ALIAS_TRACE"], markers: ["DKWB-BASE", "DKWB-ALIAS-QUERY"],
    answers: "which base a memory reference was resolved against, and how an alias query was answered" }),
  new Profile({ name: "ugen-freelist", source: "ugen.c", command: ["instrument-ugen", "--emit-provenance", "{input}", "{output}"],
    environment: ["DKWB_UGEN_TRACE"], markers: ["DKWB-FREELIST", "DKWB-CALL"],
    answers: "the temp-ring pop sequence with the source line each pop was consumed on -- the construct that bought or sold a pop" }),
  new Profile({ name: "ugen-emit-provenance", source: "ugen.c", command: [], environment: ["DKWB_UGEN_SCHED"], markers: ["DKWB-EMIT-V1"],
    answers: "the order ugen wrote instruction records and the source line each carries into as1 -- the line-order conflicts a join removes" }),
]);

/** Scheduler evidence that needs no drop-in at all. */
export const STOCK_EVIDENCE = Object.freeze([
  ["cc -Wa,-R", "as1's own list-scheduler trace: per-block dependence graph, node readiness, and the key that decided each selection. Print-only; the object is cmp-identical with -R on. Read it with `trace-scheduler --from-as1-r`"],
]);

/** What must pass before an instrumented drop-in is used for evidence. */
export const GATES = Object.freeze([
  "traces off: build one translation unit through the instrumented cc with every trace variable unset, and cmp the object against the stock build. Byte-identical, whole file, in every configuration the project ships",
  "positive control: with each variable set in turn, confirm the profile's own records appear. An empty log is the failure this command exists for",
  "collateral: rebuild the whole translation unit set and confirm the project's own link and image comparison are unchanged",
  "stamp: record the instrumented binaries' hashes with `decomp-workbench instrument-gate`, so a later log can be tied to the compiler that produced it",
]);

function digest(p) { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; } }
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** Describe the two-profile rebuild over one generated-compiler tree. */
export function plan({ generated, output, workbench = "decomp-workbench" }) {
  const steps = [], sources = [], seen = new Set();
  for (const profile of PROFILES) {
    if (!seen.has(profile.source)) {
      seen.add(profile.source);
      const sourcePath = join(generated, profile.source);
      sources.push({ source: profile.source, path: sourcePath, sha256: digest(sourcePath), present: isFile(sourcePath) });
    }
    if (!profile.command.length) continue;
    const inPath = join(generated, profile.source), outPath = join(output, profile.source);
    const argv = [workbench, ...profile.command.map((t) => t.replace("{input}", inPath).replace("{output}", outPath))];
    // Both instrument commands refuse input == output without --in-place.
    if (inPath === outPath) argv.push("--in-place");
    steps.push({ profile: profile.name, argv, produces: join(output, profile.source) });
  }
  return {
    schema: PLAN_SCHEMA, generated: pathStr(generated), output: pathStr(output), sources, steps,
    profiles: PROFILES.map((p) => p.asDict()),
    stock_evidence: STOCK_EVIDENCE.map(([command, answers]) => ({ command, answers })),
    gates: [...GATES],
    proof: "a recipe, not a build. Nothing here compiles anything, and a plan over a tree that does not exist yet is still the plan; the gates below are what make a built drop-in trustworthy, and `check-drop-in` is what says the profiles survived the rebuild.",
  };
}

/** Render the plan as a script an operator can read before running. */
export function renderScript(document) {
  const lines = ["#!/bin/sh", "# Generated by `decomp-workbench instrument-drop-in`.", "# Read it before running it: it rewrites generated compiler source.", "set -eu", ""];
  for (const s of document.sources) lines.push(`test -f ${shlexQuote(s.path)}`);
  lines.push("");
  for (const step of document.steps) { lines.push(`# ${step.profile}`); lines.push(step.argv.map(shlexQuote).join(" ")); lines.push(""); }
  lines.push("# Rebuild both passes from the instrumented sources, then:");
  for (const gate of document.gates) lines.push(`#   - ${gate}`);
  lines.push("");
  return lines.join("\n");
}

export class ProfileAudit {
  constructor({ profile, binary, present, absent }) { Object.assign(this, { profile, binary, present, absent }); Object.freeze(this); }
  get carried() { return !this.absent.length; }
  asDict() { return { profile: this.profile, binary: this.binary, present: [...this.present], absent: [...this.absent], carried: this.carried }; }
}

/** Report which profiles' markers are present in the built binaries. */
export function audit(binaries, { profiles = PROFILES } = {}) {
  if (!binaries.length) throw new ValueError("name at least one built compiler binary to audit");
  const contents = binaries.map((p) => [String(p), readFileSync(p)]);
  const audits = [];
  for (const profile of profiles) {
    let best = null;
    for (const [name, data] of contents) {
      const present = [], absent = [];
      for (const m of profile.markers) (data.includes(Buffer.from(m, "ascii")) ? present : absent).push(m);
      const candidate = new ProfileAudit({ profile: profile.name, binary: name, present, absent });
      if (best === null || candidate.present.length > best.present.length) best = candidate;
    }
    audits.push(best);
  }
  const missing = audits.filter((a) => !a.carried).map((a) => a.profile);
  return {
    schema: AUDIT_SCHEMA, binaries: contents.map(([n]) => n), profiles: audits.map((a) => a.asDict()), complete: !missing.length, missing,
    proof: "a byte scan of the built binaries for each profile's injected marker strings. A marker present proves the profile was compiled in; a marker absent proves it was not. Neither proves it fires -- run the positive control for that.",
  };
}

/** Render the audit as the lines an operator reads before a campaign. */
export function formatAudit(document) {
  const lines = [`binaries: ${document.binaries.join(", ")}`];
  for (const e of document.profiles) {
    const detail = e.carried ? e.present.join(", ") : "missing " + e.absent.join(", ");
    lines.push(`  ${e.profile.padEnd(24)} ${(e.carried ? "carried" : "ABSENT").padEnd(8)} ${detail}`);
  }
  if (document.missing.length) {
    lines.push("", "incomplete drop-in: " + document.missing.join(", ") + ". Its logs will be empty rather than wrong, which is why this is checked and not discovered.");
  }
  return lines.join("\n");
}

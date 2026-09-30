// compose.js - editing a source the way a composer must: the base named by
// its SHA-256, every edit carrying the text it expects on its line, frozen
// zones refused, and every anchor re-read at its own line in the emitted
// file (a whole-file search would be satisfied by a coincidental duplicate).
// Three refusals: the base moved, an anchor moved, the edit is in a frozen
// zone. This makes the edit land where it was aimed, or not at all.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { createHash } from "node:crypto";
import { ValueError, strRepr, splitlines, splitWs, pyInt } from "./py.js";
import { osText } from "./py-path.js";

export const COMPOSE_SCHEMA = "decomp-workbench-compose-v1";

/** A composed edit could not be proved to land where it was aimed. */
export class ComposeError extends ValueError { constructor(message) { super(message); this.name = "ValueError"; this.composeError = true; } }

/** SHA-256 of a source file's bytes (whole-file, to catch a rebase). */
export function sourceSha256(p) { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

/** Parse `LO..HI` (or a bare `N`) into an inclusive line range. */
export function parseZone(text) {
  const raw = text.trim();
  if (!raw) throw new ComposeError("a frozen zone cannot be empty; write LO..HI or N");
  let lowText, highText;
  if (raw.includes("..")) { const i = raw.indexOf(".."); lowText = raw.slice(0, i); highText = raw.slice(i + 2); } else lowText = highText = raw;
  let low, high;
  try { low = pyInt(lowText); high = pyInt(highText); } catch {
    throw new ComposeError(`${strRepr(text)} is not a line range; write LO..HI (for example 900..940)`);
  }
  if (low < 1 || high < low) throw new ComposeError(`${strRepr(text)} is not a line range: lines start at 1 and LO must not exceed HI`);
  return [low, high];
}

export class Anchor {
  constructor({ line, text, owner = "" }) { Object.assign(this, { line, text, owner }); Object.freeze(this); }
}

export class Edit {
  constructor({ line, expect, replace = null, insert = [], label = "" }) { Object.assign(this, { line, expect, replace, insert: [...insert], label }); Object.freeze(this); }
  get deletes() { return this.replace === null && !this.insert.length; }
  asDict() { return { line: this.line, expect: this.expect, replace: this.replace, insert: [...this.insert], label: this.label }; }
}

export class EditPlan {
  constructor({ base, base_sha256, edits = [], frozen = [], frozen_owner = "", anchors = [], label = "" }) {
    Object.assign(this, { base, base_sha256, edits, frozen, frozen_owner, anchors, label }); Object.freeze(this);
  }
  asDict() {
    return { base: String(this.base), base_sha256: this.base_sha256, label: this.label, edits: this.edits.map((e) => e.asDict()),
      frozen: this.frozen.map((z) => [...z]), frozen_owner: this.frozen_owner,
      anchors: this.anchors.map((a) => ({ line: a.line, text: a.text, owner: a.owner })) };
  }
}

export class ComposedSource {
  constructor({ text, plan, line_map = new Map(), verified_anchors = [] }) { Object.assign(this, { text, plan, line_map, verified_anchors }); Object.freeze(this); }
  asDict() {
    return { schema: COMPOSE_SCHEMA, base: String(this.plan.base), base_sha256: this.plan.base_sha256, label: this.plan.label,
      edits: this.plan.edits.length, frozen: this.plan.frozen.map((z) => [...z]), verified_anchors: [...this.verified_anchors] };
  }
}

const normalize = (t) => splitWs(t).join(" ");
const inFrozen = (line, frozen) => frozen.find(([lo, hi]) => lo <= line && line <= hi) ?? null;
const labelOf = (e) => e.label || strRepr(e.expect);

/** Apply `plan` to its base and return the emitted source, or refuse loudly. */
export function applyPlan(plan, { text = null } = {}) {
  let actualSha;
  if (text === null) {
    try { text = fs.readFileSync(plan.base, "utf8"); } catch (e) { throw new ComposeError(`cannot read the base ${plan.base}: ${osText(e)}`); }
    actualSha = sourceSha256(plan.base);
  } else actualSha = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  if (plan.base_sha256 && actualSha !== plan.base_sha256) {
    throw new ComposeError(`${plan.base} is not the base this plan was written against.\n  expected sha256 ${plan.base_sha256}\n  found    sha256 ${actualSha}\n`
      + "Every line number in the plan refers to the expected file. Re-derive the plan against the current base rather than re-pointing it.");
  }
  const lines = splitlines(text);
  const total = lines.length;
  const seen = new Map();
  for (const edit of plan.edits) {
    if (!(edit.line >= 1 && edit.line <= total)) throw new ComposeError(`${plan.base} has ${total} line(s); the edit ${labelOf(edit)} names line ${edit.line}`);
    const zone = inFrozen(edit.line, plan.frozen);
    if (zone) {
      const owner = plan.frozen_owner ? ` (${plan.frozen_owner})` : "";
      throw new ComposeError(`line ${edit.line} is inside the frozen zone ${zone[0]}..${zone[1]}${owner} and this plan edits it. `
        + "A frozen zone is another construction's protected lines; composing over it merges two stages' work silently.");
    }
    if (seen.has(edit.line)) {
      const other = seen.get(edit.line);
      throw new ComposeError(`two edits target line ${edit.line} (${labelOf(other)} and ${labelOf(edit)}). One line, one edit: the second would be written against text the first replaced.`);
    }
    seen.set(edit.line, edit);
    const found = lines[edit.line - 1];
    if (normalize(found) !== normalize(edit.expect)) {
      throw new ComposeError(`${plan.base}:${edit.line} does not say what the plan expects.\n  expected: ${normalize(edit.expect)}\n  found:    ${normalize(found)}\nThe edit would land on a different statement.`);
    }
  }
  for (const anchor of plan.anchors) {
    if (!(anchor.line >= 1 && anchor.line <= total)) throw new ComposeError(`${plan.base} has ${total} line(s); the anchor names line ${anchor.line}`);
    const found = lines[anchor.line - 1];
    if (normalize(found) !== normalize(anchor.text)) {
      const owner = anchor.owner ? ` (${anchor.owner})` : "";
      throw new ComposeError(`${plan.base}:${anchor.line} is not the anchor line${owner}.\n  expected: ${normalize(anchor.text)}\n  found:    ${normalize(found)}`);
    }
  }
  const emitted = [];
  const lineMap = new Map();
  lines.forEach((line, i) => {
    const number = i + 1;
    const pending = seen.get(number);
    if (!pending) { emitted.push(line); lineMap.set(number, emitted.length); return; }
    emitted.push(...pending.insert);
    if (pending.replace !== null) { emitted.push(pending.replace); lineMap.set(number, emitted.length); }
    else if (pending.insert.length) { emitted.push(line); lineMap.set(number, emitted.length); }
  });
  const verified = [];
  for (const anchor of plan.anchors) {
    const moved = lineMap.get(anchor.line);
    if (moved === undefined) throw new ComposeError(`the plan deleted line ${anchor.line}, which is also one of its anchors`);
    if (normalize(emitted[moved - 1]) !== normalize(anchor.text)) {
      throw new ComposeError(`after composing, line ${moved} (base line ${anchor.line}) no longer reads ${strRepr(normalize(anchor.text))}. The emitted source is not trustworthy; nothing was written.`);
    }
    verified.push(anchor.line);
  }
  for (const [low, high] of plan.frozen) {
    for (let number = low; number <= Math.min(high, total); number++) {
      const moved = lineMap.get(number);
      if (moved === undefined) throw new ComposeError(`base line ${number} is inside the frozen zone ${low}..${high} and did not survive the edit`);
      if (normalize(emitted[moved - 1]) !== normalize(lines[number - 1])) {
        throw new ComposeError(`after composing, frozen line ${number} changed. The emitted source is not trustworthy; nothing was written.`);
      }
    }
  }
  const trailing = text.endsWith("\n") || !text ? "\n" : "";
  return new ComposedSource({ text: emitted.join("\n") + trailing, plan, line_map: lineMap, verified_anchors: verified });
}

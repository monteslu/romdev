// screen.js - the one line a sweep prints per object: identity (short
// SHA-1), true length, frame, float load/store traffic (optionally at one
// named slot), and the ring coset relative to the target, read from the one
// phase implementation.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { createHash } from "node:crypto";

const LOAD_RE = /^(?:lwc1|ldc1)\s+\$?f\d+\s*,\s*(-?\d+)\(\$?sp\)/;
const STORE_RE = /^(?:swc1|sdc1)\s+\$?f\d+\s*,\s*(-?\d+)\(\$?sp\)/;

/** An object's short SHA-1: twelve hex characters. */
export function fileSha1(p) { return createHash("sha1").update(fs.readFileSync(String(p))).digest("hex").slice(0, 12); }

function traffic(instructions, { slot }) {
  let loads = 0, stores = 0;
  for (const item of instructions) {
    const text = item.assembly.trim();
    const load = LOAD_RE.exec(text);
    if (load) { if (slot === null || parseInt(load[1], 10) === slot) loads += 1; continue; }
    const store = STORE_RE.exec(text);
    if (store && (slot === null || parseInt(store[1], 10) === slot)) stores += 1;
  }
  return [loads, stores];
}

export class ScreenLine {
  constructor({ label, sha1, instructions, frame, loads, stores, slot = null, coset = null, quotiented = null, positional = null, coset_unavailable = null }) {
    Object.assign(this, { label, sha1, instructions, frame, loads, stores, slot, coset, quotiented, positional, coset_unavailable });
    Object.freeze(this);
  }
  get rotated() { return this.coset !== null && this.coset !== "id" && this.coset !== "?"; }
  render() {
    const suffix = this.slot === null ? "" : String(this.slot);
    const parts = [this.sha1 ? `sha=${this.sha1}` : "sha=-", `ni=${this.instructions}`, `frame=${this.frame !== null ? this.frame : "-"}`, `ld${suffix}=${this.loads}`, `st${suffix}=${this.stores}`];
    if (this.coset !== null) parts.push(`coset=${this.coset}`);
    return "screen: " + parts.join(" ");
  }
  caution() {
    if (!this.rotated) return null;
    const s = (v) => (v === null ? "None" : String(v));
    return `COSET: this object's scratch ring sits at ${this.coset}, not the target's. A ring-quotienting scorer reads it as ${s(this.quotiented)} row(s); as written it is ${s(this.positional)}. Do not record it as a win on the quotiented number.`;
  }
  asDict() {
    return { label: this.label, sha1: this.sha1, instructions: this.instructions, frame: this.frame, loads: this.loads, stores: this.stores, slot: this.slot,
      coset: this.coset, coset_quotiented: this.quotiented, coset_positional: this.positional, coset_unavailable: this.coset_unavailable,
      coset_caution: this.caution(), rendered: this.render() };
  }
}

/** Build one screen line, reading the coset only when a target allows it. */
export async function buildScreenLine(instructions, { label, path = null, target = null, slot = null, ring = null }) {
  const { frameSize } = await import("./compare.js");
  const { trueInstructionCount } = await import("./objdump.js");
  const [loads, stores] = traffic(instructions, { slot });
  let coset = null, quotiented = null, positional = null, unavailable = null;
  if (target && target.length) {
    const { DEFAULT_RING, buildPhaseReport } = await import("./phase.js");
    const { buildShiftDiff } = await import("./shift-align.js");
    const report = buildPhaseReport(target, instructions, { shift: buildShiftDiff(target, instructions), ring: ring || DEFAULT_RING });
    const entry = report.slots[0];
    coset = entry.coset_evidence === "no-evidence" ? "?" : entry.coset.label;
    quotiented = entry.quotiented;
    positional = entry.positional;
  } else {
    unavailable = "no target instructions were supplied, so the ring coset is not measured here; score against a target object to read it";
  }
  return new ScreenLine({ label, sha1: path !== null ? fileSha1(path) : null, instructions: trueInstructionCount(instructions),
    frame: frameSize(instructions.map((i) => i.assembly).join("\n")), loads, stores, slot, coset, quotiented, positional, coset_unavailable: unavailable });
}

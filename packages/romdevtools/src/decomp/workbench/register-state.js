// register-state.js - explicit per-input reservations, not inferred
// allocator ownership. A sidecar is an operator-supplied diagnostic
// assumption bound to an input and symbol; the hash binding prevents
// accidental reuse, it does not prove the contents of a compiler trace.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ValueError, strip } from "./py.js";

export const REGISTER_STATE_SCHEMA = "decomp-workbench-register-reservations-v1";
export const IDO53_GP_SEED = Object.freeze(["t6", "t7", "t8", "t9", "t0", "t1", "t2", "t3", "t4", "t5"]);
export const IDO53_SHARED_GP = Object.freeze(["t0", "t1", "t2", "t3", "t4", "t5"]);

/** Conditional integer scratch withdrawals for one procedure, supplied explicitly. */
export class RegisterReservations {
  /** @param {{reserved: string[], evidence: string}} fields */
  constructor({ reserved, evidence }) {
    if (!Array.isArray(reserved) || reserved.some((r) => typeof r !== "string")
      || new Set(reserved).size !== reserved.length || !reserved.every((r) => IDO53_SHARED_GP.includes(r))
      || typeof evidence !== "string" || !strip(evidence)) {
      throw new ValueError("invalid IDO 5.3 shared-register reservations");
    }
    this.reserved = Object.freeze([...reserved]);
    this.evidence = evidence;
    Object.freeze(this);
  }

  get temp_ring() { return IDO53_GP_SEED.filter((n) => !this.reserved.includes(n)); }

  asDict() {
    return { basis: "supplied-reservations", reserved: [...this.reserved], temp_ring: [...this.temp_ring], evidence: this.evidence };
  }
}

/**
 * Load an explicitly scoped sidecar; never borrow the other side's state.
 * @param {string|null} sidecar
 * @param {string} inputPath
 * @param {string|null} symbol
 */
export function loadReservations(sidecar, inputPath, symbol) {
  if (sidecar === null || sidecar === undefined) return null;
  const value = JSON.parse(readFileSync(sidecar, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== REGISTER_STATE_SCHEMA || symbol === null || symbol === undefined
    || value.symbol !== symbol
    || value.input_sha256 !== createHash("sha256").update(readFileSync(inputPath)).digest("hex")
    || !Array.isArray(value.reserved) || typeof value.evidence !== "string") {
    throw new ValueError("register reservations do not bind this input and symbol");
  }
  return new RegisterReservations({ reserved: value.reserved, evidence: value.evidence });
}

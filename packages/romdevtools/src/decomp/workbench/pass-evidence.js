// pass-evidence.js - what a compiler trace already said about the decision
// behind a residual. Split out of the mechanism view so the trace readers
// (globalcolor) and the view can both import it without a cycle; view.js
// re-exports it.
//
// Plain JS ESM + JSDoc.

export class PassEvidence {
  constructor({ contested_allocation = false, force_declined = false, ring_pop_divergence = false, schedule_slot_divergence = false } = {}) {
    Object.assign(this, { contested_allocation, force_declined, ring_pop_divergence, schedule_slot_divergence });
    Object.freeze(this);
  }

  /** Whether this evidence settles anything at all. */
  get decisive() {
    return this.contested_allocation || this.force_declined || this.ring_pop_divergence || this.schedule_slot_divergence;
  }
}

// coverage.js - what a sweep is entitled to claim, given what it actually
// visited: exhaustive coverage permits a proof about the space, a sample only
// evidence about the sample.
//
// Plain JS ESM + JSDoc.

export class SweepCoverage {
  constructor({ basis, space, covered, step = null, excluded = 0 }) {
    Object.assign(this, { basis, space, covered, step, excluded });
    Object.freeze(this);
  }
  get exhaustive() { return this.space === null || this.space === undefined ? false : this.covered + this.excluded >= this.space; }
  get unvisited() { return this.space === null || this.space === undefined ? null : Math.max(0, this.space - this.covered - this.excluded); }
  get fraction() { return !this.space ? null : this.covered / this.space; }
  get vocabulary() { return this.exhaustive ? "swept-exhaustively" : "sampled"; }
  sentence() {
    if (this.space === null || this.space === undefined) {
      return `coverage: ${this.covered} point(s) of an unbounded space (${this.basis}); this is a sample, and a negative result here is evidence, not a proof`;
    }
    const stride = this.step && this.step > 1 ? `, step ${this.step}` : "";
    const excluded = this.excluded ? `, ${this.excluded} excluded` : "";
    const headline = `coverage: ${this.vocabulary} -- ${this.covered} of ${this.space} point(s)${stride}${excluded} (${this.basis})`;
    if (this.exhaustive) return headline + "; a negative result here is a proof about this space";
    return `${headline}; ${this.unvisited} point(s) were never visited, so a negative result here is evidence about the sample and not a proof about the space`;
  }
  asDict() {
    return { basis: this.basis, space: this.space, covered: this.covered, step: this.step, excluded: this.excluded,
      unvisited: this.unvisited, exhaustive: this.exhaustive, fraction: this.fraction, vocabulary: this.vocabulary, sentence: this.sentence() };
  }
}

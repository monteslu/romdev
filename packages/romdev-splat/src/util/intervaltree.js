// The subset of the intervaltree API splat uses (addi() and point queries on
// half-open [begin, end) intervals), written for this package from that
// documented behaviour.

export class Interval {
  constructor(begin, end, data) { this.begin = begin; this.end = end; this.data = data; }
}

export class IntervalTree {
  constructor() { this.items = []; this.keys = new Map(); }

  addi(begin, end, data) {
    if (begin === null || end === null || begin === undefined || end === undefined) {
      throw new TypeError("'>=' not supported between instances of 'int' and 'NoneType'");
    }
    if (begin >= end) throw new Error(`IntervalTree: Null Interval objects not allowed in IntervalTree: Interval(${begin}, ${end})`);
    const k = begin + ":" + end;
    let same = this.keys.get(k);
    if (!same) { same = []; this.keys.set(k, same); }
    if (same.includes(data)) return;
    same.push(data);
    this.items.push(new Interval(begin, end, data));
  }

  /** tree[point]: the intervals containing point, in insertion order. */
  at(point) {
    const out = [];
    for (const it of this.items) if (it.begin <= point && point < it.end) out.push(it);
    return out;
  }

  get size() { return this.items.length; }
}

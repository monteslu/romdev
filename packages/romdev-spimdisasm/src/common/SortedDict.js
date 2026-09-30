// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/SortedDict.py

function bisectLeft(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bisectRight(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x < a[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export class SortedDict {
  constructor(other = null) {
    this.map = new Map();
    this.sortedKeys = [];
    if (other !== null && other !== undefined) {
      const entries = other instanceof Map || other instanceof SortedDict ? other.entries() : Object.entries(other);
      for (const [key, value] of entries) this.add(key, value);
    }
  }

  add(key, value) {
    if (!this.map.has(key)) {
      // Avoid adding the key twice if it is already on the map (bisect.insort == insort_right)
      this.sortedKeys.splice(bisectRight(this.sortedKeys, key), 0, key);
    }
    this.map.set(key, value);
  }

  remove(key) {
    if (!this.map.has(key)) throw new Error(`KeyError: ${key}`);
    this.map.delete(key);
    const idx = bisectLeft(this.sortedKeys, key);
    this.sortedKeys.splice(idx, 1);
  }

  /** Pair with the greatest key <= key (or < key when not inclusive), or null. */
  getKeyRight(key, inclusive = true) {
    const index = inclusive ? bisectRight(this.sortedKeys, key) : bisectLeft(this.sortedKeys, key);
    if (index === 0) return null;
    const currentKey = this.sortedKeys[index - 1];
    return [currentKey, this.map.get(currentKey)];
  }

  /** Pair with the smallest key >= key (or > key when not inclusive), or null. */
  getKeyLeft(key, inclusive = true) {
    const index = inclusive ? bisectLeft(this.sortedKeys, key) : bisectRight(this.sortedKeys, key);
    if (index === this.sortedKeys.length) return null;
    const k = this.sortedKeys[index];
    return [k, this.map.get(k)];
  }

  *getRange(startKey, endKey, startInclusive = true, endInclusive = false) {
    const keyIndexStart = startInclusive ? bisectLeft(this.sortedKeys, startKey) : bisectRight(this.sortedKeys, startKey);
    const keyIndexEnd = endInclusive ? bisectRight(this.sortedKeys, endKey) : bisectLeft(this.sortedKeys, endKey);
    for (let index = keyIndexStart; index < keyIndexEnd; index++) {
      const key = this.sortedKeys[index];
      yield [key, this.map.get(key)];
    }
  }

  /** Like getRange but removes each pair. Iterates in descending order. */
  *getRangeAndPop(startKey, endKey, startInclusive = true, endInclusive = false) {
    const keyIndexStart = startInclusive ? bisectLeft(this.sortedKeys, startKey) : bisectRight(this.sortedKeys, startKey);
    const keyIndexEnd = endInclusive ? bisectRight(this.sortedKeys, endKey) : bisectLeft(this.sortedKeys, endKey);
    for (let index = keyIndexEnd - 1; index > keyIndexStart - 1; index--) {
      const key = this.sortedKeys[index];
      const value = this.map.get(key);
      this.remove(key);
      yield [key, value];
    }
  }

  index(key) {
    if (!this.map.has(key)) return null;
    return bisectLeft(this.sortedKeys, key);
  }

  // Mapping protocol
  get(key, dflt = null) {
    return this.map.has(key) ? this.map.get(key) : dflt;
  }

  getItem(key) {
    if (!this.map.has(key)) throw new Error(`KeyError: ${key}`);
    return this.map.get(key);
  }

  set(key, value) {
    this.add(key, value);
    return this;
  }

  delete(key) {
    if (!this.map.has(key)) return false;
    this.remove(key);
    return true;
  }

  has(key) {
    return this.map.has(key);
  }

  /** MutableMapping.pop(key, default) */
  pop(key, ...dflt) {
    if (this.map.has(key)) {
      const v = this.map.get(key);
      this.remove(key);
      return v;
    }
    if (dflt.length > 0) return dflt[0];
    throw new Error(`KeyError: ${key}`);
  }

  get size() {
    return this.map.size;
  }

  get length() {
    return this.map.size;
  }

  *keys() {
    yield* this.sortedKeys.slice();
  }

  *values() {
    for (const k of this.sortedKeys.slice()) yield this.map.get(k);
  }

  *items() {
    for (const k of this.sortedKeys.slice()) yield [k, this.map.get(k)];
  }

  entries() {
    return this.items();
  }

  [Symbol.iterator]() {
    return this.keys();
  }

  toString() {
    const parts = [];
    for (const [k, v] of this.items()) parts.push(`${k}: ${v}`);
    return `SortedDict({${parts.join(", ")}})`;
  }
}

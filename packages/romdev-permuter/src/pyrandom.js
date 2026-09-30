// pyrandom.js - Python's `random.Random` (MT19937 + the pure-Python methods
// the permuter calls), so a given seed produces the same stream of choices as
// upstream. Spec: CPython Modules/_randommodule.c (init_genrand,
// init_by_array, genrand_uint32, random_seed for int seeds, getrandbits,
// random) and Lib/random.py (_randbelow_with_getrandbits, randrange, randint,
// choice, shuffle, sample, uniform).
//
// Integers above 2**53 (the permuter's rng seeds go up to 10**20, and PERM
// macro counts can be factorials) are BigInts; methods accept either.
import { randomBytes } from "node:crypto";

const N = 624, M = 397;
const MATRIX_A = 0x9908b0df, UPPER_MASK = 0x80000000, LOWER_MASK = 0x7fffffff;

export class PyRandom {
  constructor(seed) {
    this.mt = new Uint32Array(N);
    this.mti = N + 1;
    this.seed(seed);
  }

  /** random.seed(a): an int (Number or BigInt) seeds deterministically; null/undefined seeds from the OS. */
  seed(a) {
    let n;
    if (a == null) n = BigInt("0x" + randomBytes(32).toString("hex"));
    else if (typeof a === "bigint") n = a;
    else if (typeof a === "number" && Number.isInteger(a)) n = BigInt(a);
    else throw new TypeError("PyRandom.seed: only integer seeds are supported");
    if (n < 0n) n = -n;
    const key = [];
    if (n === 0n) key.push(0);
    while (n > 0n) { key.push(Number(n & 0xffffffffn)); n >>= 32n; }
    this.initByArray(key);
  }

  initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  initByArray(key) {
    const mt = this.mt;
    const keyLength = key.length;
    this.initGenrand(19650218);
    let i = 1, j = 0;
    for (let k = N > keyLength ? N : keyLength; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= keyLength) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.mti = N;
  }

  genrandUint32() {
    const mt = this.mt;
    let y;
    if (this.mti >= N) {
      let kk;
      for (kk = 0; kk < N - M; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random(): 53-bit float in [0, 1). */
  random() {
    const a = this.genrandUint32() >>> 5, b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** getrandbits(k) as a Number (k <= 32) or BigInt (k > 32). */
  getrandbits(k) {
    if (k < 0) throw new RangeError("number of bits must be non-negative");
    if (k === 0) return 0;
    if (k <= 32) return this.genrandUint32() >>> (32 - k);
    let result = 0n, shift = 0n;
    for (let kk = k; kk > 0; kk -= 32) {
      let r = this.genrandUint32();
      if (kk < 32) r >>>= 32 - kk;
      result |= BigInt(r) << shift;
      shift += 32n;
    }
    return result;
  }

  /** _randbelow_with_getrandbits(n): n > 0, Number or BigInt; returns the same kind. */
  _randbelow(n) {
    if (typeof n === "bigint") {
      if (n <= 0xffffffffn) return BigInt(this._randbelow(Number(n)));
      const k = n.toString(2).length;
      let r = this.getrandbits(k);
      while (r >= n) r = this.getrandbits(k);
      return r;
    }
    if (n > 0xffffffff) {
      if (!Number.isSafeInteger(n)) throw new RangeError("use a BigInt for ranges beyond 2**53");
      return Number(this._randbelow(BigInt(n)));
    }
    const k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(start, stop) {
    if (stop === undefined) {
      if (start > 0 || start > 0n) return this._randbelow(start);
      throw new RangeError("empty range for randrange()");
    }
    if (typeof start === "bigint" || typeof stop === "bigint") {
      const s = BigInt(start), width = BigInt(stop) - s;
      if (width > 0n) return s + this._randbelow(width);
      throw new RangeError(`empty range in randrange(${start}, ${stop})`);
    }
    const width = stop - start;
    if (width > 0) return start + this._randbelow(width);
    throw new RangeError(`empty range in randrange(${start}, ${stop})`);
  }

  randint(a, b) {
    if (b < a) throw new RangeError(`empty range in randint(${a}, ${b})`);
    if (typeof a === "bigint" || typeof b === "bigint") return BigInt(a) + this._randbelow(BigInt(b) - BigInt(a) + 1n);
    return a + this._randbelow(b - a + 1);
  }

  choice(seq) {
    if (!seq.length) throw new PyIndexError("Cannot choose from an empty sequence");
    return seq[this._randbelow(seq.length)];
  }

  shuffle(x) {
    for (let i = x.length - 1; i >= 1; i--) {
      const j = this._randbelow(i + 1);
      const t = x[i]; x[i] = x[j]; x[j] = t;
    }
  }

  sample(population, k) {
    const n = population.length;
    if (!(0 <= k && k <= n)) throw new RangeError("Sample larger than population or is negative");
    const result = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = population.slice();
      for (let i = 0; i < k; i++) {
        const j = this._randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set();
      for (let i = 0; i < k; i++) {
        let j = this._randbelow(n);
        while (selected.has(j)) j = this._randbelow(n);
        selected.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }

  uniform(a, b) { return a + (b - a) * this.random(); }
}

export class PyIndexError extends Error {
  constructor(message) { super(message); this.name = "IndexError"; }
}

/** The module-level `random` (seeded from the OS, like a fresh process). */
export const globalRandom = new PyRandom();

// PyRandom must replay CPython's random.Random stream exactly: the rng seed a
// permuter run prints ("--seed N") only reproduces a candidate if every draw
// matches upstream's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PyRandom } from "../src/pyrandom.js";

test("MT19937 reference vector (mt19937ar.c init_by_array {0x123,0x234,0x345,0x456})", () => {
  const r = new PyRandom(0);
  r.initByArray([0x123, 0x234, 0x345, 0x456]);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => r.genrandUint32()), [1067595299, 955945823, 477289528, 4107218783, 4228976476]);
});

test("random.Random(n).random() matches CPython for small int seeds", () => {
  assert.equal(new PyRandom(0).random(), 0.8444218515250481);
  assert.equal(new PyRandom(1).random(), 0.13436424411240122);
  assert.equal(new PyRandom(42).random(), 0.6394267984578837);
});

test("int seeds are split into 32-bit words little-endian; negative seeds use abs()", () => {
  const big = 12345678901234567890n;
  const a = new PyRandom(big), b = new PyRandom(-big);
  assert.equal(a.random(), b.random());
  const c = new PyRandom(0);
  c.initByArray([Number(big & 0xffffffffn), Number((big >> 32n) & 0xffffffffn)]);
  const d = new PyRandom(big);
  assert.equal(c.genrandUint32(), d.genrandUint32());
});

test("_randbelow draws getrandbits(n.bit_length()) with rejection, as random.py does", () => {
  // choice() of a one-element list still consumes a 1-bit draw per attempt.
  const r1 = new PyRandom(5), r2 = new PyRandom(5);
  r1.choice(["x"]);
  let k;
  do { k = r2.genrandUint32() >>> 31; } while (k >= 1);
  assert.equal(r1.genrandUint32(), r2.genrandUint32());
  // BigInt ranges (the permuter's rng seeds: randrange(1, 10**20)).
  const r = new PyRandom(9);
  const v = r.randrange(1n, 10n ** 20n);
  assert.equal(typeof v, "bigint");
  assert.ok(v >= 1n && v < 10n ** 20n);
});

test("sample, shuffle, randint, uniform follow random.py's algorithms", () => {
  const r = new PyRandom(3), s = new PyRandom(3);
  const got = r.sample([10, 20, 30, 40], 2);
  // pool algorithm (n <= setsize): j = randbelow(n - i), pool[j] = pool[n - i - 1]
  const pool = [10, 20, 30, 40];
  const want = [];
  for (let i = 0; i < 2; i++) { const j = s._randbelow(4 - i); want.push(pool[j]); pool[j] = pool[4 - i - 1]; }
  assert.deepEqual(got, want);
  const x = [1, 2, 3, 4, 5], y = x.slice();
  new PyRandom(11).shuffle(x);
  const t = new PyRandom(11);
  for (let i = y.length - 1; i >= 1; i--) { const j = t._randbelow(i + 1); [y[i], y[j]] = [y[j], y[i]]; }
  assert.deepEqual(x, y);
  const u = new PyRandom(4), w = new PyRandom(4);
  assert.equal(u.uniform(2, 5), 2 + 3 * w.random());
  assert.equal(new PyRandom(8).randint(3, 3), 3);
});

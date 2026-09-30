import { test } from "node:test";
import assert from "node:assert/strict";

import { PySet, pyHashInt, pyHashTuple, pyHash, PY_HASH_NONE } from "../src/py/pyset.js";

// Expected orders are hand-simulated from CPython's Objects/setobject.c:
// slot = hash & mask, LINEAR_PROBES=9 only while i+9 <= mask, then
// perturb >>= 5; i = (i*5 + 1 + perturb) & mask; resize when
// fill*5 >= mask*3 to the smallest power of two > used*4.

const order = (s) => [...s];

test("small table collisions use perturbed probing", () => {
    // 1 -> slot 1; 9 -> slot 1 taken, i=(1*5+1)&7=6; 17 -> 1, 6, then 7
    assert.deepEqual(order(new PySet([1, 9, 17])), [1, 9, 17]);
    assert.deepEqual(order(new PySet([17, 9, 1])), [17, 9, 1]);
    // no collisions: slot order, not insertion order
    assert.deepEqual(order(new PySet([5, 1, 3])), [1, 3, 5]);
});

test("addresses with high bits", () => {
    // 0x80000004 -> slot 4, 0x80000008 -> slot 0
    assert.deepEqual(order(new PySet([0x80000004, 0x80000008])), [0x80000008, 0x80000004]);
    // 0x80000010: slot 0 taken, perturb=0x4000000, i=1 taken,
    // perturb=0x200000, i=(5+1+0x200000)&7=6
    const s = new PySet([0x80000010, 0x80000008, 0x80000000]);
    assert.deepEqual(s._debugSlots().map((x) => (x === "" ? "" : x.toString(16))),
        ["80000010", "80000008", "", "", "", "", "80000000", ""]);
});

test("resize at fill*5 >= mask*3 reinserts in old slot order", () => {
    const s = new PySet([40, 1, 2, 3]);
    assert.deepEqual(order(s), [40, 1, 2, 3]); // 40 & 7 == 0
    s.add(4); // fill 5 -> resize to 32 slots, 40 & 31 == 8
    assert.deepEqual(order(s), [1, 2, 3, 4, 40]);
    assert.equal(s._mask, 31);
    // linear probing in the 32 slot table: 33 & 31 == 1, slots 2..4 taken
    s.add(33);
    assert.deepEqual(order(s), [1, 2, 3, 4, 33, 40]);
});

test("discard leaves a dummy that the next colliding add reuses", () => {
    const s = new PySet([1, 9]);
    assert.equal(s.delete(1), true);
    assert.equal(s.delete(1), false);
    s.add(17); // slot 1 dummy remembered, 6 has 9, 7 empty -> goes to dummy slot 1
    assert.deepEqual(order(s), [17, 9]);
    s.add(1); // 1 -> 17 at slot 1, 9 at 6, empty 7
    assert.deepEqual(order(s), [17, 9, 1]);
    assert.equal(s.size, 3);
});

test("negative ints hash like CPython", () => {
    assert.equal(pyHashInt(-1), -2n);
    assert.equal(pyHashInt(-2), -2n);
    assert.equal(pyHashInt(2n ** 61n - 1n), 0n);
    assert.equal(pyHashInt(2n ** 61n), 1n);
    assert.equal(pyHashInt(-(2n ** 61n)), -1n - 1n); // -1 -> -2
    // 0 -> 0, -1 (hash -2, slot 6), 2 -> 2, -2 (hash -2, not equal to -1)
    // probes slot 6 until perturb runs out, then (6*5+1)&7 == 7
    assert.deepEqual(order(new PySet([0, -1, 2, -2])), [0, 2, -1, -2]);
});

test("numbers and bigints are the same Python int", () => {
    const s = new PySet([1, 2n, 3]);
    assert.equal(s.has(1n), true);
    assert.equal(s.has(2), true);
    s.add(2);
    assert.equal(s.size, 3);
});

test("set operations follow CPython iteration rules", () => {
    const a = new PySet([1, 9, 17]);
    const b = new PySet([17, 1]);
    // the smaller set is iterated: b is [17, 1]
    assert.deepEqual(order(a.intersection(b)), [17, 1]);
    assert.deepEqual(order(b.intersection(a)), [17, 1]);
    assert.deepEqual(order(a.difference(b)), [9]);
    assert.deepEqual(order(a.union(new PySet([2]))), [1, 2, 9, 17]);
    assert.deepEqual(order(a.copy()), order(a));
    assert.equal(a.isdisjoint(new PySet([2, 3])), true);
    assert.equal(a.isdisjoint([3, 9]), false);
    const c = new PySet([1, 2, 3]);
    c.update([40]);
    assert.deepEqual(order(c), [40, 1, 2, 3]);
    c.clear();
    assert.equal(c.size, 0);
    assert.deepEqual(order(c), []);
});

test("perturbing one inserted value changes the order", () => {
    // Same as the first case but 17 -> 25 (25 & 7 == 1 too, perturb 0):
    // collision chain is identical so order is unchanged...
    assert.deepEqual(order(new PySet([1, 9, 25])), [1, 9, 25]);
    // ...while 17 -> 16 lands in slot 0 and moves to the front.
    const perturbed = order(new PySet([1, 9, 16]));
    assert.notDeepEqual(perturbed, [1, 9, 16]);
    assert.deepEqual(perturbed, [16, 1, 9]);
});

test("tuple and None hashes", () => {
    assert.equal(PY_HASH_NONE, 0xFCA86420n);
    assert.equal(pyHash(null), 0xFCA86420n);
    // hash(()) on 64-bit CPython 3.8+
    assert.equal(pyHashTuple([]), 5740354900026072187n);
    // hash((1, 2)) on 64-bit CPython 3.8+
    assert.equal(pyHashTuple([1, 2]), -3550055125485641917n);
    assert.notEqual(pyHashTuple([0x80000000, null]), pyHashTuple([0x80000000, 0]));
});

test("custom hash/eq for non-int members", () => {
    const hash = (o) => pyHashTuple([o.address, o.vrom]);
    const eq = (x, y) => x.address === y.address && x.vrom === y.vrom;
    const s = new PySet(null, { hash, eq });
    const a = { address: 0x80001000, vrom: null };
    s.add(a);
    s.add({ address: 0x80001000, vrom: null });
    assert.equal(s.size, 1);
    assert.equal(s.has({ address: 0x80001000, vrom: null }), true);
    s.add({ address: 0x80001004, vrom: 0x1004 });
    assert.equal(s.size, 2);
});

test("iterating while mutating throws like CPython", () => {
    const s = new PySet([1, 2, 3]);
    assert.throws(() => {
        for (const k of s) {
            s.add(k + 100);
        }
    });
});

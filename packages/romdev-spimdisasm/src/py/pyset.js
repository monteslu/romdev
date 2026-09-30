// SPDX-License-Identifier: MIT
//
// A set that iterates in exactly the same order as a CPython `set`.
//
// This is a port of the hash table logic of CPython's Objects/setobject.c
// (open addressing, LINEAR_PROBES linear probes followed by perturbed
// probing, dummy entries left by deletions, table growth when
// fill*5 >= mask*3, set_insert_clean on resize, set_merge fast paths).
// CPython 3.12 and 3.13 only differ in free-threading bookkeeping (3.13
// re-checks that a remembered dummy slot is still a dummy before reusing
// it, which can not change without concurrent mutation), so both produce
// the same iteration order and a single implementation covers both.
//
// Keys default to Python ints (JS numbers that are integers, or BigInts),
// hashed like CPython's int hash. Other key kinds can be used by passing a
// `hash` function (returning a BigInt Python hash) and an `eq` function.

const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;
const PYSET_MINSIZE = 8;

const HASH_MODULUS = (1n << 61n) - 1n;
const DUMMY = Symbol("PySet.dummy");

/** CPython 3.12+ `hash(None)`. */
export const PY_HASH_NONE = 0xFCA86420n;

/**
 * Python `hash()` of an int. Returns a signed 64-bit BigInt.
 * @param {number|bigint} n
 * @returns {bigint}
 */
export function pyHashInt(n) {
    if (typeof n === "number") {
        if (!Number.isInteger(n)) {
            throw new TypeError(`pyHashInt: not an integer: ${n}`);
        }
        n = BigInt(n);
    } else if (typeof n === "boolean") {
        n = n ? 1n : 0n;
    }
    let h;
    if (n >= 0n) {
        h = n % HASH_MODULUS;
    } else {
        h = -((-n) % HASH_MODULUS);
    }
    if (h === -1n) {
        h = -2n;
    }
    return h;
}

const XXPRIME_1 = 11400714785074694791n;
const XXPRIME_2 = 14029467366897019727n;
const XXPRIME_5 = 2870177450012600261n;
const U64 = (1n << 64n) - 1n;

/**
 * Python `hash()` of a value made of ints, bools, None (null/undefined)
 * and tuples (JS arrays). Returns a signed 64-bit BigInt.
 * @param {any} value
 * @returns {bigint}
 */
export function pyHash(value) {
    if (value === null || value === undefined) {
        return PY_HASH_NONE;
    }
    if (Array.isArray(value)) {
        return pyHashTuple(value);
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return pyHashInt(value);
    }
    throw new TypeError(`pyHash: unsupported value ${String(value)}`);
}

/**
 * CPython's tuple hash (Objects/tupleobject.c, xxHash based, 64-bit
 * Py_uhash_t). Items are hashed with `pyHash`.
 * @param {any[]} items
 * @returns {bigint}
 */
export function pyHashTuple(items) {
    let acc = XXPRIME_5;
    for (const item of items) {
        const lane = BigInt.asUintN(64, pyHash(item));
        acc = (acc + lane * XXPRIME_2) & U64;
        acc = ((acc << 31n) | (acc >> 33n)) & U64;
        acc = (acc * XXPRIME_1) & U64;
    }
    acc = (acc + (BigInt(items.length) ^ (XXPRIME_5 ^ 3527539n))) & U64;
    if (acc === U64) {
        return 1546275796n;
    }
    return BigInt.asIntN(64, acc);
}

function defaultEq(a, b) {
    // Python int equality between JS numbers and BigInts
    return a == b;
}

export class PySet {
    /**
     * @param {Iterable<any>|null} [iterable]
     * @param {{hash?: (key: any) => bigint, eq?: (a: any, b: any) => boolean}} [options]
     */
    constructor(iterable = null, options = {}) {
        this._hashFn = options.hash ?? pyHashInt;
        this._eqFn = options.eq ?? defaultEq;
        this._emptyToMinsize();
        if (iterable !== null && iterable !== undefined) {
            this.update(iterable);
        }
    }

    _emptyToMinsize() {
        this._mask = PYSET_MINSIZE - 1;
        /** @type {any[]} undefined == empty slot, DUMMY == deleted */
        this._keys = new Array(PYSET_MINSIZE);
        /** @type {bigint[]} */
        this._hashes = new Array(PYSET_MINSIZE).fill(0n);
        this._fill = 0;
        this._used = 0;
    }

    _newEmptyLike() {
        return new PySet(null, { hash: this._hashFn, eq: this._eqFn });
    }

    _hash(key) {
        return this._hashFn(key);
    }

    _keyEq(a, b) {
        return a === b || this._eqFn(a, b);
    }

    /** set_lookkey: returns slot index of the key or of the empty slot. */
    _lookkey(key, hash) {
        let mask = this._mask;
        let perturb = BigInt.asUintN(64, hash);
        let i = Number(perturb & BigInt(mask));
        for (;;) {
            let probes = (i + LINEAR_PROBES <= mask) ? LINEAR_PROBES : 0;
            let j = i;
            do {
                const k = this._keys[j];
                if (k === undefined) {
                    return j;
                }
                if (this._hashes[j] === hash && k !== DUMMY && this._keyEq(k, key)) {
                    return j;
                }
                j++;
            } while (probes-- > 0);
            perturb >>= PERTURB_SHIFT;
            i = (i * 5 + 1 + Number(perturb & BigInt(mask))) & mask;
        }
    }

    /** set_add_entry */
    _addEntry(key, hash) {
        const mask = this._mask;
        let perturb = BigInt.asUintN(64, hash);
        let i = Number(perturb & BigInt(mask));
        let freeslot = -1;
        for (;;) {
            let probes = (i + LINEAR_PROBES <= mask) ? LINEAR_PROBES : 0;
            let j = i;
            do {
                const k = this._keys[j];
                if (k === undefined) {
                    // found_unused_or_dummy
                    if (freeslot >= 0) {
                        this._used++;
                        this._keys[freeslot] = key;
                        this._hashes[freeslot] = hash;
                        return;
                    }
                    this._fill++;
                    this._used++;
                    this._keys[j] = key;
                    this._hashes[j] = hash;
                    if (this._fill * 5 < mask * 3) {
                        return;
                    }
                    this._tableResize(this._used > 50000 ? this._used * 2 : this._used * 4);
                    return;
                }
                if (this._hashes[j] === hash) {
                    if (k !== DUMMY && this._keyEq(k, key)) {
                        // found_active
                        return;
                    }
                } else if (k === DUMMY) {
                    freeslot = j;
                }
                j++;
            } while (probes-- > 0);
            perturb >>= PERTURB_SHIFT;
            i = (i * 5 + 1 + Number(perturb & BigInt(mask))) & mask;
        }
    }

    /** set_insert_clean */
    static _insertClean(keys, hashes, mask, key, hash) {
        let perturb = BigInt.asUintN(64, hash);
        let i = Number(perturb & BigInt(mask));
        for (;;) {
            if (keys[i] === undefined) {
                keys[i] = key;
                hashes[i] = hash;
                return;
            }
            if (i + LINEAR_PROBES <= mask) {
                for (let j = 1; j <= LINEAR_PROBES; j++) {
                    if (keys[i + j] === undefined) {
                        keys[i + j] = key;
                        hashes[i + j] = hash;
                        return;
                    }
                }
            }
            perturb >>= PERTURB_SHIFT;
            i = (i * 5 + 1 + Number(perturb & BigInt(mask))) & mask;
        }
    }

    /** set_table_resize */
    _tableResize(minused) {
        let newsize = PYSET_MINSIZE;
        while (newsize <= minused) {
            newsize *= 2;
        }
        const oldKeys = this._keys;
        const oldHashes = this._hashes;
        const oldMask = this._mask;
        if (newsize === PYSET_MINSIZE && oldMask === PYSET_MINSIZE - 1 && this._fill === this._used) {
            // small table, no dummies: nothing to do
            return;
        }
        const newMask = newsize - 1;
        const keys = new Array(newsize);
        const hashes = new Array(newsize).fill(0n);
        const hadDummies = this._fill !== this._used;
        if (hadDummies) {
            this._fill = this._used;
        }
        for (let idx = 0; idx <= oldMask; idx++) {
            const k = oldKeys[idx];
            if (k !== undefined && k !== DUMMY) {
                PySet._insertClean(keys, hashes, newMask, k, oldHashes[idx]);
            }
        }
        this._keys = keys;
        this._hashes = hashes;
        this._mask = newMask;
    }

    /** set_discard_entry, returns true if found */
    _discardEntry(key, hash) {
        const j = this._lookkey(key, hash);
        if (this._keys[j] === undefined) {
            return false;
        }
        this._keys[j] = DUMMY;
        this._hashes[j] = -1n;
        this._used--;
        return true;
    }

    _containsEntry(key, hash) {
        return this._keys[this._lookkey(key, hash)] !== undefined;
    }

    /** set_merge */
    _merge(other) {
        if (other === this || other._used === 0) {
            return;
        }
        if ((this._fill + other._used) * 5 >= this._mask * 3) {
            this._tableResize((this._used + other._used) * 2);
        }
        if (this._fill === 0 && this._mask === other._mask && other._fill === other._used) {
            for (let i = 0; i <= other._mask; i++) {
                const k = other._keys[i];
                if (k !== undefined) {
                    this._keys[i] = k;
                    this._hashes[i] = other._hashes[i];
                }
            }
            this._fill = other._fill;
            this._used = other._used;
            return;
        }
        if (this._fill === 0) {
            this._fill = other._used;
            this._used = other._used;
            for (let i = 0; i <= other._mask; i++) {
                const k = other._keys[i];
                if (k !== undefined && k !== DUMMY) {
                    PySet._insertClean(this._keys, this._hashes, this._mask, k, other._hashes[i]);
                }
            }
            return;
        }
        for (let i = 0; i <= other._mask; i++) {
            const k = other._keys[i];
            if (k !== undefined && k !== DUMMY) {
                this._addEntry(k, other._hashes[i]);
            }
        }
    }

    /** set_next style entries of the live table: [key, hash] */
    *_entries() {
        const used = this._used;
        const keys = this._keys;
        for (let i = 0; i <= this._mask; i++) {
            if (this._used !== used || this._keys !== keys) {
                throw new Error("Set changed size during iteration");
            }
            const k = keys[i];
            if (k !== undefined && k !== DUMMY) {
                yield [k, this._hashes[i]];
            }
        }
    }

    // ---- JS Set-like API ----

    get size() {
        return this._used;
    }

    add(key) {
        this._addEntry(key, this._hash(key));
        return this;
    }

    has(key) {
        return this._containsEntry(key, this._hash(key));
    }

    /** Python `discard`; returns whether the key was present. */
    delete(key) {
        return this._discardEntry(key, this._hash(key));
    }

    discard(key) {
        this.delete(key);
    }

    /** Python `remove`: throws if missing. */
    remove(key) {
        if (!this.delete(key)) {
            throw new Error(`KeyError: ${String(key)}`);
        }
    }

    clear() {
        this._emptyToMinsize();
    }

    *[Symbol.iterator]() {
        for (const [k] of this._entries()) {
            yield k;
        }
    }

    values() {
        return this[Symbol.iterator]();
    }

    keys() {
        return this[Symbol.iterator]();
    }

    *entries() {
        for (const k of this) {
            yield [k, k];
        }
    }

    forEach(callback, thisArg) {
        for (const k of this) {
            callback.call(thisArg, k, k, this);
        }
    }

    // ---- Python API ----

    /** set.update / `|=` with a single argument. */
    update(iterable) {
        if (iterable instanceof PySet) {
            this._merge(iterable);
            return this;
        }
        for (const k of iterable) {
            this.add(k);
        }
        return this;
    }

    copy() {
        const result = this._newEmptyLike();
        result._merge(this);
        return result;
    }

    /** set.union / `|` */
    union(...others) {
        const result = this.copy();
        for (const other of others) {
            if (other === this) {
                continue;
            }
            result.update(other);
        }
        return result;
    }

    /** set.intersection / `&` with a single argument */
    intersection(other) {
        if (other === this) {
            return this.copy();
        }
        const result = this._newEmptyLike();
        if (other instanceof PySet) {
            let so = this;
            let ot = other;
            if (ot._used > so._used) {
                [so, ot] = [ot, so];
            }
            for (const [k, h] of ot._entries()) {
                if (so._containsEntry(k, h)) {
                    result._addEntry(k, h);
                }
            }
            return result;
        }
        for (const k of other) {
            const h = this._hash(k);
            if (this._containsEntry(k, h)) {
                result._addEntry(k, h);
                if (result._used >= this._used) {
                    break;
                }
            }
        }
        return result;
    }

    /** set.intersection_update / `&=` */
    intersectionUpdate(other) {
        const tmp = this.intersection(other);
        this._keys = tmp._keys;
        this._hashes = tmp._hashes;
        this._mask = tmp._mask;
        this._fill = tmp._fill;
        this._used = tmp._used;
        return this;
    }

    /** set_difference_update_internal (`-=`) */
    differenceUpdate(other) {
        if (other === this) {
            this.clear();
            return this;
        }
        if (other instanceof PySet) {
            let ot = other;
            if ((ot._used >> 3) > this._used) {
                ot = this.intersection(ot);
            }
            for (const [k, h] of ot._entries()) {
                this._discardEntry(k, h);
            }
        } else {
            for (const k of other) {
                this.delete(k);
            }
        }
        if ((this._fill - this._used) <= Math.floor(this._mask / 4)) {
            return this;
        }
        this._tableResize(this._used > 50000 ? this._used * 2 : this._used * 4);
        return this;
    }

    /** set.difference / `-` with a single argument */
    difference(other) {
        if (!(other instanceof PySet)) {
            return this.copy().differenceUpdate(other);
        }
        if ((this._used >> 2) > other._used) {
            return this.copy().differenceUpdate(other);
        }
        const result = this._newEmptyLike();
        for (const [k, h] of this._entries()) {
            if (!other._containsEntry(k, h)) {
                result._addEntry(k, h);
            }
        }
        return result;
    }

    isdisjoint(other) {
        if (other === this) {
            return this._used === 0;
        }
        if (other instanceof PySet) {
            let so = this;
            let ot = other;
            if (ot._used > so._used) {
                [so, ot] = [ot, so];
            }
            for (const [k, h] of ot._entries()) {
                if (so._containsEntry(k, h)) {
                    return false;
                }
            }
            return true;
        }
        for (const k of other) {
            if (this.has(k)) {
                return false;
            }
        }
        return true;
    }

    /** Debug helper: the raw slot layout ("" empty, "<dummy>", or key). */
    _debugSlots() {
        const out = [];
        for (let i = 0; i <= this._mask; i++) {
            const k = this._keys[i];
            out.push(k === undefined ? "" : (k === DUMMY ? "<dummy>" : k));
        }
        return out;
    }
}

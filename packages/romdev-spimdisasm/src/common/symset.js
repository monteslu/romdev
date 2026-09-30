// SPDX-License-Identifier: MIT
// Python set emulation for spimdisasm's sets.
//
// spimdisasm keeps `set[int]` and `set[ContextSymbol]` collections. Some of them
// are iterated by callers (splat iterates `referencedVrams`), so their iteration
// order must match CPython's hash-table order. PySet reproduces that order.

import { PySet, pyHashTuple, pyHashInt } from "../py/pyset.js";

export { PySet };

/** New Python-ordered set of ints. */
export function newIntSet(iterable) {
  return new PySet(iterable);
}

function symHash(sym) {
  return pyHashTuple([sym.address, sym.vromAddress === undefined ? null : sym.vromAddress]);
}

function symEqForSet(a, b) {
  return a === b || (a.address === b.address && (a.vromAddress ?? null) === (b.vromAddress ?? null));
}

/** New Python-ordered set of ContextSymbol (hash/eq on (address, vromAddress)). */
export function newSymbolSet(iterable) {
  return new PySet(iterable, { hash: symHash, eq: symEqForSet });
}

export { pyHashInt };

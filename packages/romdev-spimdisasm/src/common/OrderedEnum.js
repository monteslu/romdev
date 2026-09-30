// SPDX-License-Identifier: MIT
// Port of spimdisasm/common/OrderedEnum.py
//
// Python's OrderedEnum adds rich comparisons between members of the same enum.
// JS enums created with createEnum are compared through these helpers.

export const OrderedEnum = Object.freeze({
  ge: (a, b) => a.value >= b.value,
  gt: (a, b) => a.value > b.value,
  le: (a, b) => a.value <= b.value,
  lt: (a, b) => a.value < b.value,
});

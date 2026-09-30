// SPDX-License-Identifier: MIT
// Version selection for the spimdisasm port.
//
// The package reproduces several upstream spimdisasm releases. The selected
// release changes GlobalConfig defaults, compiler properties and a handful of
// code paths (gated with `atLeast`). Each spimdisasm release is paired with the
// rabbitizer release it was published against.

export const SUPPORTED_VERSIONS = Object.freeze(["1.35.0", "1.39.3", "1.42.4"]);

export const RABBITIZER_VERSION_FOR = Object.freeze({
  "1.35.0": "1.13.0",
  "1.39.3": "1.14.3",
  "1.42.4": "1.16.2",
});

export const DEFAULT_VERSION = "1.42.4";

let currentStr = DEFAULT_VERSION;
let current = [1, 42, 4];
const hooks = [];

export function parseVersion(v) {
  if (Array.isArray(v)) return v.map(Number);
  const parts = String(v).split(".").map((x) => Number.parseInt(x, 10));
  while (parts.length < 3) parts.push(0);
  return parts;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when the configured spimdisasm version is >= the given version. */
export function atLeast(v) {
  return cmp(current, parseVersion(v)) >= 0;
}

export function versionString() {
  return currentStr;
}

export function versionInfo() {
  return [...current];
}

/** Register a callback run after every version change (used to reset defaults). */
export function onVersionChange(fn) {
  hooks.push(fn);
}

export function setVersion(v) {
  const s = Array.isArray(v) ? v.join(".") : String(v);
  if (!SUPPORTED_VERSIONS.includes(s)) {
    throw new Error(`romdev-spimdisasm: unsupported spimdisasm version '${s}'. Supported: ${SUPPORTED_VERSIONS.join(", ")}`);
  }
  currentStr = s;
  current = parseVersion(s);
  for (const fn of hooks) fn(s);
}

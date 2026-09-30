// SPDX-License-Identifier: MIT
// Single access point to the rabbitizer module (romdev-rabbitizer, a WASM
// build of rabbitizer whose JS API mirrors the Python rabbitizer module).
//
// Every other module reads `rabbitizer.<Name>` through the proxy exported here,
// which forwards to the active rabbitizer instance. configureVersion() swaps
// the instance for the rabbitizer release paired with the selected spimdisasm
// release. Callers that configure rabbitizer (for example splat setting
// `rabbitizer.config.*`) must use this same proxy (exported by the package as
// `rabbitizer`) so their settings reach the instance spimdisasm decodes with.

import { loadRabbitizerSync } from "romdev-rabbitizer";
import { RABBITIZER_VERSION_FOR, onVersionChange, versionString } from "./version.js";

const loaded = new Map();
let mod = null;

function load(version) {
  if (!loaded.has(version)) loaded.set(version, loadRabbitizerSync(version));
  return loaded.get(version);
}

/** Activate the rabbitizer instance for the given rabbitizer release. */
export function useRabbitizerVersion(version) {
  mod = load(version);
  return mod;
}

const handler = {
  get(_t, prop) {
    if (mod === null) throw new Error("romdev-spimdisasm: no rabbitizer instance active");
    return mod[prop];
  },
  set(_t, prop, value) {
    mod[prop] = value;
    return true;
  },
  has(_t, prop) {
    return mod !== null && prop in mod;
  },
  ownKeys() {
    return mod === null ? [] : Reflect.ownKeys(mod);
  },
  getOwnPropertyDescriptor(_t, prop) {
    if (mod === null) return undefined;
    const d = Reflect.getOwnPropertyDescriptor(mod, prop);
    if (d) d.configurable = true;
    return d;
  },
};

/** Proxy that forwards to the active rabbitizer module. */
export const rabbitizer = new Proxy({}, handler);

/** Replace the active rabbitizer instance (tests, custom builds). */
export function setRabbitizer(m) {
  mod = m;
}

export function getRabbitizer() {
  return mod;
}

export function hasRabbitizer() {
  return mod !== null;
}

// Activate the rabbitizer release paired with the default spimdisasm release,
// and follow configureVersion().
useRabbitizerVersion(RABBITIZER_VERSION_FOR[versionString()]);
onVersionChange((v) => useRabbitizerVersion(RABBITIZER_VERSION_FOR[v]));

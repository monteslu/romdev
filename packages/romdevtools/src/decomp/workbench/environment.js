// environment.js - validation and composition for explicit compiler
// environments. Campaigns are sealed: host values enter only by name, and
// then become identity-bearing values like any other.
//
// Plain JS ESM + JSDoc.

import { ValueError, strRepr } from "./py.js";
import { parseForceSpecification } from "./instrument-uopt.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse explicit NAME=VALUE entries and validate known controls. */
export function parseEnvironment(values) {
  const result = {};
  for (const value of values) {
    const i = value.indexOf("=");
    const name = i < 0 ? value : value.slice(0, i);
    if (i < 0 || !name || !NAME_RE.test(name)) throw new ValueError(`invalid environment entry: ${strRepr(value)}`);
    result[name] = value.slice(i + 1);
  }
  if ("CDX_FORCE" in result) parseForceSpecification(result.CDX_FORCE);
  return result;
}

/** The exact environment passed to a compiler process. */
export function resolveCompilerEnvironment(explicit, inheritedNames = [], { host = null } = {}) {
  const source = host ?? process.env;
  const result = { ...explicit };
  for (const name of inheritedNames) {
    if (!NAME_RE.test(name)) throw new ValueError(`invalid inherited environment name: ${strRepr(name)}`);
    if (name in result) continue;
    if (!(name in source)) throw new ValueError(`--inherit-env requested ${name}, but it is not set in the host environment`);
    result[name] = source[name];
  }
  return result;
}

/** Join verified path-sensitive toolchain settings without ambiguity. */
export async function mergeToolchainEnvironment(environment, toolchain, { require_ready = false } = {}) {
  const { toolchainEnvironment } = await import("./toolchain.js");
  const supplied = await toolchainEnvironment(toolchain, { require_ready });
  for (const [name, value] of Object.entries(supplied)) {
    if (name in environment && environment[name] !== value) {
      throw new ValueError(`--toolchain supplies ${name}=${strRepr(value)}, but --env supplied ${strRepr(environment[name])}`);
    }
  }
  return { ...supplied, ...environment };
}

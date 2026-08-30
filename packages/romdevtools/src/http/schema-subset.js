// Per-target schema subsets, so a caller can pay for the parameters it will
// actually use.
//
// A few tools are deliberately broad: `disasm` fronts the whole RE engine and
// carries 49 parameters across targets as different as "read a byte range" and
// "recompile NES code to 65816". An agent that pulls the schema in on demand
// pays for all 49 even when it wants six of them for a one-shot
// `target:'rom'` read — a direct, repeated per-use token cost.
//
// Splitting the tool would be the other fix, but it breaks every existing
// caller and scatters one coherent surface across several names. Filtering the
// SCHEMA keeps one tool and one mental model, and lets a caller say which
// target it is here for. The full schema stays the default: a caller that asks
// for nothing still gets everything, exactly as before.

/**
 * Parameters that are always meaningful, whatever the target.
 * `target` itself must survive filtering or the result cannot be called.
 */
const ALWAYS = ["target", "platform", "path", "outputPath", "inline", "echo"];

/**
 * target → the extra parameters that target actually reads.
 * Only tools/targets listed here can be filtered; anything unknown falls back
 * to the complete schema rather than guessing and hiding a needed field.
 */
const SUBSETS = {
  disasm: {
    rom: ["offset", "address", "length", "endAddress", "untilReturn", "bank", "banks", "count", "symbols", "symbolsPath", "mapper", "widths", "cpu"],
    bytes: ["bytes", "base64", "address", "length", "cpu", "symbols"],
    project: ["projectName", "sourcesPaths", "symbols", "symbolsPath", "bank", "banks"],
    references: ["address", "bank", "symbols", "symbolsPath", "maxSitesPerBank"],
    xrefs: ["address", "bank", "symbols", "symbolsPath", "maxSitesPerBank"],
    cfg: ["address", "bank", "symbols", "symbolsPath"],
    functions: ["address", "bank", "symbols", "symbolsPath"],
    accessScan: ["address", "bank", "symbols", "symbolsPath", "maxSitesPerBank"],
  },
};

/**
 * Narrow a JSON Schema to the parameters one target uses.
 *
 * @param {string} toolName
 * @param {string|undefined} target
 * @param {object} schema full JSON Schema (properties/required/…)
 * @returns {{schema: object, filtered: boolean, note?: string}}
 */
export function schemaForTarget(toolName, target, schema) {
  const perTool = SUBSETS[toolName];
  const keep = target && perTool ? perTool[target] : null;
  if (!keep || !schema || typeof schema !== "object" || !schema.properties) {
    return { schema, filtered: false };
  }
  const allowed = new Set([...ALWAYS, ...keep]);
  /** @type {Record<string, any>} */
  const properties = {};
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (allowed.has(name)) properties[name] = spec;
  }
  // Never drop a REQUIRED parameter: a subset that cannot be called is worse
  // than a large one.
  for (const name of schema.required ?? []) {
    if (!properties[name] && schema.properties[name]) properties[name] = schema.properties[name];
  }
  const dropped = Object.keys(schema.properties).length - Object.keys(properties).length;
  return {
    schema: { ...schema, properties },
    filtered: true,
    note: `Filtered to target:'${target}' — ${Object.keys(properties).length} of ` +
      `${Object.keys(schema.properties).length} parameters (${dropped} omitted). ` +
      `Omit ?for= to get the complete schema.`,
  };
}

/** Targets that can be filtered for a tool, for discoverability. */
export function filterableTargets(toolName) {
  return Object.keys(SUBSETS[toolName] ?? {});
}

// PICO-8 .p8 cart "builder" — a PACKAGER, not a compiler. PICO-8 carts are plain-text
// files with labeled sections (__lua__, __gfx__, __gff__, __label__, __map__, __sfx__,
// __music__); the Lua is source, not machine code. So "build" here = assemble a valid
// .p8 from the given Lua (+ optional data sections) that FAKE-08 can load and run.
//
// Accepts either a full .p8 already (passed through / validated) or bare Lua source
// (wrapped into a minimal but valid .p8). Data sections can be supplied verbatim.

const P8_HEADER = "pico-8 cartridge // http://www.pico-8.com";
const KNOWN_SECTIONS = ["lua", "gfx", "gff", "label", "map", "sfx", "music"];

/** Is this text already a full .p8 cart (has the header + a __lua__ section)? */
export function isP8Cart(text) {
  return /^pico-8 cartridge/i.test(text.trimStart()) && /(^|\n)__lua__/.test(text);
}

/**
 * Assemble a .p8 cart.
 * @param {object} opts
 * @param {string} opts.lua         Lua source for the __lua__ section (required unless `p8` given).
 * @param {string} [opts.p8]        A complete .p8 already — validated + passed through.
 * @param {number} [opts.version]   PICO-8 format version line (default 18).
 * @param {Object<string,string>} [opts.sections]  Extra sections by name → body text
 *        (e.g. { gfx: "...", map: "...", sfx: "...", music: "..." }). Bodies are the raw
 *        hex/number rows PICO-8 uses; passed through verbatim.
 * @returns {{ text: string, bytes: Uint8Array, warnings: string[] }}
 */
export function packP8({ lua, p8, version = 18, sections = {} } = {}) {
  const warnings = [];

  if (p8 != null) {
    if (!isP8Cart(p8)) {
      throw new Error("pico8 build: `p8` was given but doesn't look like a .p8 cart (missing 'pico-8 cartridge' header or __lua__ section).");
    }
    const text = p8.endsWith("\n") ? p8 : p8 + "\n";
    return { text, bytes: new TextEncoder().encode(text), warnings };
  }

  if (typeof lua !== "string" || lua.trim() === "") {
    throw new Error("pico8 build: provide `lua` (the cart's Lua source) or a full `p8`.");
  }

  // Validate any extra section names.
  for (const name of Object.keys(sections)) {
    if (!KNOWN_SECTIONS.includes(name)) {
      warnings.push(`unknown .p8 section '__${name}__' — passing through, but PICO-8/FAKE-08 may ignore it.`);
    }
  }

  const parts = [P8_HEADER, `version ${version}`, "__lua__", lua.replace(/\n$/, "")];
  // Emit data sections in canonical order (skip __lua__, handled above).
  for (const name of KNOWN_SECTIONS) {
    if (name === "lua") continue;
    if (sections[name] != null) {
      parts.push(`__${name}__`, String(sections[name]).replace(/\n$/, ""));
    }
  }
  // Pass through any unknown sections last (so nothing the caller sent is dropped).
  for (const [name, body] of Object.entries(sections)) {
    if (!KNOWN_SECTIONS.includes(name)) {
      parts.push(`__${name}__`, String(body).replace(/\n$/, ""));
    }
  }

  const text = parts.join("\n") + "\n";
  return { text, bytes: new TextEncoder().encode(text), warnings };
}

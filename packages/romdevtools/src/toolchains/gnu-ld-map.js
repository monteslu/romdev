// Parse a GNU ld `.map` (the "Linker script and memory map" the m68k-elf
// toolchain produces for Genesis/SGDK builds) into a flat symbol list, so the
// `symbols` tool can resolve a C global's name → address on Genesis the same way
// it does for cc65 (.dbg) and SDCC (sdld .map) targets.
//
// The map has two relevant line shapes, and we parse BOTH because each catches
// symbols the other misses:
//
//   1. A symbol DEFINITION — leading whitespace, a 0x-address, more whitespace,
//      then a bare symbol name to EOL (no size, no object file):
//          "                0xe0ff004a                score"
//      Emitted for GLOBAL (non-static) symbols. C symbols on m68k-elf carry NO
//      leading underscore (unlike SDCC's sdld map).
//
//   2. A per-symbol SECTION line — SGDK builds with -ffunction-sections /
//      -fdata-sections, so every symbol gets its own section whose name IS the
//      symbol name:
//          " .bss.levelIdx  0xe0ff0048   0x1 /work/main.o"
//          " .data.table    0x00012340   0x40 /work/main.o"
//          " .text.update   0x00001a40   0x53c /work/main.o"
//      This is the ONLY place a `static` file-local global appears (shape 1 is
//      skipped for statics) — so without parsing shape 2 we'd miss exactly the
//      file-local variables the v0.6.0 feedback flagged. We extract the name
//      from `.<seg>.<name>` for the standard segments.
//
// SGDK links 68k work-RAM through its $E0FF0000 mirror (hardware mirrors
// $FF0000 across the high bus). The work-RAM region the emulator exposes as
// `system_ram` (or `genesis_m68k`) is indexed by the LOW 16 BITS of the symbol
// address — e.g. score@0xe0ff004a → memory({op:'read', region:'system_ram',
// offset:0x4a}). Callers get the full address; the low-16 mapping is documented
// on the `symbols`/`memory` tools.

/**
 * @param {string} mapText  the GNU ld map (build({output:'romWithDebug'}).mapText on Genesis)
 * @returns {Array<{name:string, address:number, addressHex:string, ramOffset:number|null}>}
 *   sorted by address, de-duplicated. `ramOffset` is the low-16 work-RAM offset
 *   for symbols in the $E0FF0000 mirror (else null).
 */
export function parseGnuLdMap(mapText) {
  if (!mapText) return [];
  const byName = new Map(); // name -> {name, address}; first (global) def wins
  // Shape 1: whitespace, 0x<hex>, whitespace, <bare C identifier> to EOL.
  // (no '.', no trailing object-file column; rejects PROVIDE/ASSERT which have '='/'(').
  const defRe = /^\s+0x([0-9A-Fa-f]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;
  // Shape 2: a per-symbol section ` .<seg>.<name>  0x<hex>  0x<size> <obj>` for
  // the segments that hold addressable C symbols. The size + object-file columns
  // distinguish it from a plain `.text`/`.bss` area header (no name suffix).
  const secRe = /^\s+\.(?:text|data|rodata|bss)\.([A-Za-z_][A-Za-z0-9_]*)\s+0x([0-9A-Fa-f]+)\s+0x[0-9A-Fa-f]+\s+\S/;

  for (const rawLine of mapText.split(/\r?\n/)) {
    let address = null, name = null;
    const d = defRe.exec(rawLine);
    if (d) { address = parseInt(d[1], 16); name = d[2]; }
    else {
      const s = secRe.exec(rawLine);
      if (s) { name = s[1]; address = parseInt(s[2], 16); }
    }
    if (name == null) continue;
    // Shape-1 global definitions are authoritative; don't let a later section
    // line clobber one. But a section line DOES fill in a static the def list lacks.
    if (!byName.has(name)) byName.set(name, { name, address });
  }

  const out = [];
  for (const { name, address } of byName.values()) {
    const inWorkRamMirror = (address >>> 16) === 0xe0ff;
    out.push({
      name,
      address,
      addressHex: "0x" + address.toString(16).toUpperCase().padStart(8, "0"),
      ramOffset: inWorkRamMirror ? (address & 0xffff) : null,
    });
  }
  out.sort((a, b) => a.address - b.address);
  return out;
}

/**
 * Heuristic: does this `map` text look like a GNU ld map (vs an sdld .map)?
 * The GNU map has the unmistakable "Linker script and memory map" header.
 * @param {string} mapText
 * @returns {boolean}
 */
export function isGnuLdMap(mapText) {
  return typeof mapText === "string" && mapText.includes("Linker script and memory map");
}

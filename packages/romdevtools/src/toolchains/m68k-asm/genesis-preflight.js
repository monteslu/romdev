// Genesis lint for assembly builds: the two mistakes that leave a ROM that
// assembles but does not boot. Warnings, not errors.
//
// Plain JS ESM + JSDoc.

/**
 * @param {string} source
 * @returns {string | null} a warning block, or null when the source looks fine
 */
export function genesisAsmPreflight(source) {
  if (typeof source !== "string") return null;
  const issues = [];

  // The 68000 reads SSP from $00000000 and the reset PC from $00000004 on
  // power-on; a source without a vector table jumps to garbage.
  const hasReset = /\bdc\.l\s+(\$00FF[E-F][0-9A-F]{3}|_reset|reset)\b/i.test(source);
  if (!hasReset) {
    issues.push(
      "[genesis asm preflight] source does not appear to declare a 68K reset vector. " +
      "The 68K reads SSP from $00000000 and reset PC from $00000004 on power-on. " +
      "Without a vector table, the cart will jump to garbage. " +
      "See romdev-toolchain-m68k-gcc/share/genesis/lib/header.s for the canonical vector table layout."
    );
  }

  // The SEGA string at $100. genesis_plus_gx boots without it; hardware (TMSS) does not.
  const hasSegaMagic = /(SEGA MEGA DRIVE|SEGA GENESIS|SEGA 32X|SEGA PICO|SEGA CD)/i.test(source);
  if (!hasSegaMagic) {
    issues.push(
      "[genesis asm preflight] no 'SEGA' magic string found in source. " +
      "Genesis ROM header at $100 must include 'SEGA MEGA DRIVE' or similar " +
      "for real hardware to boot. genesis_plus_gx tolerates its absence; " +
      "real cartridges do not. See romdev-toolchain-m68k-gcc/share/genesis/lib/header.s."
    );
  }

  if (issues.length) return "warning: genesis asm preflight\n" + issues.join("\n");
  return null;
}

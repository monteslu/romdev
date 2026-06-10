// patch-header.js — patch a Game Boy / GBC ROM with the canonical
// Nintendo boot logo + valid header + global checksums.
//
// USAGE:
//   node patch-header.js <rom-file>           # patches in place
//   node patch-header.js <in.gb> <out.gb>    # writes to new file
//
// WHY: most libretro GB cores (gambatte) refuse to load a ROM whose
// Nintendo logo at $0104-$0133 doesn't match the canonical bytes or
// whose header checksum at $014D doesn't validate.
//
// NOTE: romdev's own build pipeline DOES auto-patch the header now (it
// runs a bundled rgbfix after every gb/gbc link — see the
// "rgbfix (auto header fix)" line in build logs), so you only need this
// script when rebuilding the project OUTSIDE romdev with stock SDCC and
// no RGBDS installed. It's what keeps the forked project self-contained.
//
// The bundled gb_crt0.s reserves $0100-$014F for the header window,
// so the bytes patched in here land on actual cartridge-header
// territory, not on code.

import { readFileSync, writeFileSync } from "node:fs";

const NINTENDO_LOGO = [
  0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B,
  0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
  0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E,
  0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
  0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC,
  0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E,
];

/**
 * Patch a GB/GBC ROM buffer in place. Returns the same buffer.
 *
 * Fills EVERY cartridge-header byte the boot ROM and gambatte care
 * about — not just the Nintendo logo + checksums.
 *
 * Why this matters (round 26 friction report): an agent shipped a
 * working C ROM that booted into a WHITE SCREEN on gambatte. Root
 * cause: `gb_crt0.s` allocates `.ds 0x4C` at $0104 to reserve the
 * header window. The ld65 sm83 linker fills the unused part with
 * the pad byte ($FF). $0143 (CGB flag) = $FF means "CGB-aware" →
 * gambatte enters CGB mode → DMG BGP/OBP0/OBP1 register writes are
 * silently ignored → white screen. Patching ONLY the logo + checksums
 * (the pre-round-26 behaviour) left $0143 = $FF intact.
 *
 * Now we fill the whole $0134..$014C window with ROM-only DMG cart
 * defaults (or CGB-aware defaults when `cgb` is set). Caller can
 * still override with `cartType` / `romSize` / `ramSize` for mapper-
 * specific carts; the defaults cover the vast majority of homebrew.
 *
 * @param {Uint8Array} rom
 * @param {object} [opts]
 * @param {boolean} [opts.cgb]       Set $0143 = $80 (CGB-aware + DMG-compat). Default false → $0143 = $00 (DMG-only).
 * @param {string}  [opts.title]     Up to 11 ASCII chars at $0134..$013E (uppercase, padded with $00). Default ""=zero-fill.
 * @param {number}  [opts.cartType]  Cart type byte at $0147. Default 0x00 = ROM-only.
 * @param {number}  [opts.romSize]   ROM size byte at $0148. Default 0x00 = 32 KB.
 * @param {number}  [opts.ramSize]   RAM size byte at $0149. Default 0x00 = none.
 * @param {number}  [opts.destination] Destination code at $014A. Default 0x01 = non-Japan.
 */
export function patchGbHeader(rom, opts = {}) {
  if (rom.length < 0x150) {
    throw new Error(`ROM too small to patch (got ${rom.length} bytes, need ≥ 336)`);
  }
  // Nintendo logo at $0104-$0133.
  for (let i = 0; i < NINTENDO_LOGO.length; i++) {
    rom[0x0104 + i] = NINTENDO_LOGO[i];
  }

  // ─── Title field $0134..$013E (11 bytes ASCII, zero-padded). ──
  // On CGB carts, $013F-$0142 is the manufacturer code (4 ASCII) and
  // $0143 is the CGB flag. We zero-fill everything not covered by an
  // explicit option so the agent doesn't have to think about it.
  for (let i = 0x0134; i <= 0x0142; i++) rom[i] = 0x00;
  if (opts.title) {
    const t = String(opts.title).toUpperCase().slice(0, 11);
    for (let i = 0; i < t.length; i++) {
      rom[0x0134 + i] = t.charCodeAt(i) & 0xFF;
    }
  }

  // ─── CGB flag $0143 ── $00 = DMG-only, $80 = CGB-aware + DMG-compat,
  // $C0 = CGB-only (rejected by DMG). Default DMG-only since that's
  // what `createProject({platform:"gb"})` should produce; the GBC
  // tree overrides via patchGbHeader({cgb: true}).
  rom[0x0143] = opts.cgb ? 0x80 : 0x00;

  // ─── New licensee code $0144..$0145 ── two ASCII chars. We don't
  // self-publish, so $00 $00 is fine; the boot ROM checks this against
  // the old licensee byte ($014B) below.
  rom[0x0144] = 0x00;
  rom[0x0145] = 0x00;

  // ─── SGB flag $0146 ── $00 = no SGB enhancement (we don't).
  rom[0x0146] = 0x00;

  // ─── Cart type $0147 ── $00 = ROM-only is the safe default.
  // Common alternatives the caller can pass: $01 = MBC1, $03 = MBC1+RAM+BAT,
  // $11 = MBC3, $13 = MBC3+RAM+BAT, $19 = MBC5.
  rom[0x0147] = opts.cartType ?? 0x00;

  // ─── ROM size $0148 ── 0 = 32 KB (2 banks). 1 = 64 KB, 2 = 128 KB, ...
  // Default 0 matches the bundled 32 KB build size.
  rom[0x0148] = opts.romSize ?? 0x00;

  // ─── RAM size $0149 ── 0 = no RAM. Standard alternatives: $02 = 8 KB,
  // $03 = 32 KB. Only meaningful when cartType selects a battery-backed MBC.
  rom[0x0149] = opts.ramSize ?? 0x00;

  // ─── Destination $014A ── 0 = Japan, 1 = non-Japan. Default 1.
  rom[0x014A] = opts.destination ?? 0x01;

  // ─── Old licensee $014B ── $33 means "see $0144..$0145" (new format).
  // This is the canonical value modern homebrew uses.
  rom[0x014B] = 0x33;

  // ─── ROM version $014C ── $00 (first version).
  rom[0x014C] = 0x00;

  // Header checksum at $014D: sum -((byte+1)) for $0134..$014C.
  let hcs = 0;
  for (let i = 0x0134; i <= 0x014C; i++) {
    hcs = (hcs - rom[i] - 1) & 0xFF;
  }
  rom[0x014D] = hcs;
  // Global ROM checksum at $014E-$014F: 16-bit sum of all bytes
  // except $014E/$014F themselves. Boot ROM doesn't actually check
  // this on hardware, but emulators may.
  let gcs = 0;
  for (let i = 0; i < rom.length; i++) {
    if (i === 0x014E || i === 0x014F) continue;
    gcs = (gcs + rom[i]) & 0xFFFF;
  }
  rom[0x014E] = (gcs >> 8) & 0xFF;
  rom[0x014F] = gcs & 0xFF;
  return rom;
}

// CLI entry — only runs when invoked directly.
const isCli = import.meta.url.startsWith("file:") &&
              process.argv[1] &&
              import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isCli) {
  const inPath = process.argv[2];
  const outPath = process.argv[3] ?? inPath;
  if (!inPath) {
    console.error("usage: node patch-header.js <rom-file> [<out-file>]");
    process.exit(1);
  }
  const rom = new Uint8Array(readFileSync(inPath));
  // Auto-detect CGB based on file extension.
  const cgb = /\.gbc$/i.test(inPath) || /\.gbc$/i.test(outPath);
  patchGbHeader(rom, { cgb });
  writeFileSync(outPath, rom);
  console.log(`patched ${inPath}${outPath !== inPath ? ` → ${outPath}` : ""} (${rom.length} bytes${cgb ? ", CGB" : ""})`);
}

// snes9x's per-title fixes (CMemory::ApplyROMFixes) for a loaded cart,
// evaluated from the generated table (snes9x-romfixes.json) against the
// header name and ID the way snes9x's match_na / match_nn / match_nc /
// match_id compare them. The result is the handful of timing and memory
// parameters the cart is emitted with.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";

const FIXES = JSON.parse(readFileSync(new URL("./snes9x-romfixes.json", import.meta.url), "utf8"));

/**
 * @typedef {object} RomFixes
 * @property {number} apuSpeedup    Timings.APUSpeedup (SPC ticks per 256 taken off the APU clock ratio)
 * @property {number} dmaCpuSync    Timings.DMACPUSync (master clocks per (H)DMA start)
 * @property {number} renderPos     Timings.RenderPos (HC of the row-render event)
 * @property {number} sramInit      SNESGameFixes.SRAMInitialValue (the power-on SRAM fill)
 * @property {number|null} sramSize SRAMSize override (null = the header's)
 * @property {boolean} uniracers    SNESGameFixes.Uniracers (HDMA to $2104 resets the OAM address)
 * @property {string[]} applied     human-readable list of the rules that matched
 */

/**
 * @param {{ romName: string, romId: Uint8Array, pal: boolean, sramInit?: number }} cart
 * @returns {RomFixes}
 */
export function romFixes(cart) {
  /** @type {RomFixes} */
  const f = { apuSpeedup: 0, dmaCpuSync: 18, renderPos: 512, sramInit: cart.sramInit ?? 0x60, sramSize: null, uniracers: false, applied: [] };
  const name = cart.romName;
  const id = String.fromCharCode(...cart.romId);
  const atom = (a) => {
    if (a.any) return a.any.some((and) => and.every(atom));
    if (a.setting) {
      if (a.setting === "PAL") return cart.pal;
      throw new Error(`snes romfixes: condition on Settings.${a.setting}`);
    }
    if (a.compare) throw new Error(`snes romfixes: comparison ${a.compare} in a rule`);
    switch (a.match) {
      case "na": return name === a.str;
      case "nn": return name.startsWith(a.str);
      case "nc": return name.toLowerCase().startsWith(a.str.toLowerCase());
      case "id": return id.startsWith(a.str);
      default: throw new Error(`snes romfixes: match_${a.match}`);
    }
  };
  for (const chain of FIXES.applyRomFixes) {
    for (const rule of chain) {
      if (rule.when === null) break;   // unconditional statements (the master setting, the speedup call)
      if (!rule.when.some((and) => and.every(atom))) continue;
      for (const s of rule.sets) {
        switch (s.set) {
          case "Timings.APUSpeedup": f.apuSpeedup = s.value; break;
          case "Timings.DMACPUSync": f.dmaCpuSync = s.value; break;
          case "Timings.RenderPos": f.renderPos = s.value; break;
          case "SNESGameFixes.SRAMInitialValue": f.sramInit = s.value; break;
          case "SNESGameFixes.Uniracers": f.uniracers = !!s.value; break;
          case "SRAMSize": f.sramSize = s.value; break;
          case "SRAMMask": break;   // recomputed from SRAMSize
          default: throw new Error(`snes romfixes: effect ${s.set}`);
        }
        f.applied.push(`${s.set} = ${typeof s.value === "object" ? s.value.expr : s.value}`);
      }
      break;   // an else-if chain applies its first match only
    }
  }
  return f;
}

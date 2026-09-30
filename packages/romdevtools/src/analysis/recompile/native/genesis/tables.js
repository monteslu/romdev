// Build-time tables for the sync32 Genesis runtime (rd_tables.c).
//
// genesis_plus_gx builds several large tables at power-on: the YM2612's
// power/sine/LFO tables (with pow, sin and log), the Z80's ADD/SUB flag
// tables and the VDP's layer-priority tables. On sync32 they would cost
// ~0.8 MB of the 304 KB game RAM and need a libm the console does not have,
// so they are generated here once and linked into flash as const data.
//
// Each table comes from gpgx itself, not from a re-derivation:
//   - YM2612 tl_tab / sin_tab: ../../wat/sms/gpgx-sound.json, parsed from
//     gpgx's source and checked against the reference core's heap;
//     lfo_pm_table: ym2612.c's integer loop over lfo_pm_output, ported.
//   - (Z80 SZHVC_add / SZHVC_sub: z80FlagTables ports z80_init's loop; the
//     runtime computes those flags per use instead, see z80.c ROMDEV_S32.)
//   - VDP lut[0..5]: the make_lut_* functions are read out of the vendored
//     vdp_render.c and evaluated as JavaScript (their bodies are integer
//     expressions on small non-negative ints, which mean the same thing in
//     both languages), so the table is gpgx's by construction.
//
// LICENSE: derived from Genesis Plus GX (non-commercial, see NOTICE).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { gpgxSoundTables } from "../../wat/sms/psg.js";

const RUNTIME = new URL("./runtime/", import.meta.url);

/** ym2612.c init_tables: lfo_pm_table from lfo_pm_output (UINT8 arithmetic). */
export function ymLfoPmTable(lfoPmOutput) {
  const out = (row, step) => lfoPmOutput[row * 8 + step];
  const t = new Int32Array(128 * 8 * 32);
  for (let i = 0; i < 8; i++) {
    for (let fnum = 0; fnum < 128; fnum++) {
      for (let step = 0; step < 8; step++) {
        let value = 0;
        for (let bit = 0; bit < 7; bit++) {
          if (fnum & (1 << bit)) value = (value + out(bit * 8 + i, step)) & 0xff;
        }
        t[fnum * 256 + i * 32 + step] = value;
        t[fnum * 256 + i * 32 + (step ^ 7) + 8] = value;
        t[fnum * 256 + i * 32 + step + 16] = -value;
        t[fnum * 256 + i * 32 + (step ^ 7) + 24] = -value;
      }
    }
  }
  return t;
}

/** z80.c z80_init: the ADD/ADC and SUB/SBC flag tables. */
export function z80FlagTables() {
  const SF = 0x80, ZF = 0x40, YF = 0x20, HF = 0x10, XF = 0x08, VF = 0x04, NF = 0x02, CF = 0x01;
  const add = new Uint8Array(2 * 256 * 256), sub = new Uint8Array(2 * 256 * 256);
  let padd = 0, padc = 256 * 256, psub = 0, psbc = 256 * 256;
  for (let oldval = 0; oldval < 256; oldval++) {
    for (let newval = 0; newval < 256; newval++) {
      let val = newval - oldval;
      let f = newval ? ((newval & 0x80) ? SF : 0) : ZF;
      f |= newval & (YF | XF);
      if ((newval & 0x0f) < (oldval & 0x0f)) f |= HF;
      if (newval < oldval) f |= CF;
      if ((val ^ oldval ^ 0x80) & (val ^ newval) & 0x80) f |= VF;
      add[padd++] = f;

      val = newval - oldval - 1;
      f = newval ? ((newval & 0x80) ? SF : 0) : ZF;
      f |= newval & (YF | XF);
      if ((newval & 0x0f) <= (oldval & 0x0f)) f |= HF;
      if (newval <= oldval) f |= CF;
      if ((val ^ oldval ^ 0x80) & (val ^ newval) & 0x80) f |= VF;
      add[padc++] = f;

      val = oldval - newval;
      f = NF | (newval ? ((newval & 0x80) ? SF : 0) : ZF);
      f |= newval & (YF | XF);
      if ((newval & 0x0f) > (oldval & 0x0f)) f |= HF;
      if (newval > oldval) f |= CF;
      if ((val ^ oldval) & (oldval ^ newval) & 0x80) f |= VF;
      sub[psub++] = f;

      val = oldval - newval - 1;
      f = NF | (newval ? ((newval & 0x80) ? SF : 0) : ZF);
      f |= newval & (YF | XF);
      if ((newval & 0x0f) >= (oldval & 0x0f)) f |= HF;
      if (newval >= oldval) f |= CF;
      if ((val ^ oldval) & (oldval ^ newval) & 0x80) f |= VF;
      sub[psbc++] = f;
    }
  }
  return { add, sub };
}

/**
 * The VDP layer tables: vdp_render.c's own make_lut_* functions, lifted out
 * of the C text and run as JavaScript. Refuses (throws) if a function body
 * holds anything beyond the integer statements the translation handles.
 */
export function vdpLuts(vdpRenderSource) {
  const names = ["make_lut_bg", "make_lut_bgobj", "make_lut_bg_ste", "make_lut_obj", "make_lut_bgobj_ste", "make_lut_bgobj_m4"];
  const fns = {};
  for (const n of names) {
    const re = new RegExp(`static uint32 ${n}\\(uint32 (\\w+), uint32 (\\w+)\\)\\s*\\{`, "m");
    const m = re.exec(vdpRenderSource);
    if (!m) throw new Error(`vdp tables: ${n} not found in vdp_render.c`);
    // body up to the matching closing brace
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    for (; i < vdpRenderSource.length && depth; i++) {
      if (vdpRenderSource[i] === "{") depth++;
      else if (vdpRenderSource[i] === "}") depth--;
    }
    let body = vdpRenderSource.slice(start, i - 1);
    body = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\bint\s+(\w+)\s*;/g, "let $1;").replace(/\bint\s+(\w+)\s*=/g, "let $1 =");
    if (/\b(uint\d+|unsigned|char|short|long|for|while|\*\s*\w+\s*=)\b/.test(body)) throw new Error(`vdp tables: ${n} has C the translation does not handle`);
    fns[n] = new Function(m[1], m[2], body);
  }
  const lut = new Uint8Array(6 * 0x10000);
  for (let bx = 0; bx < 0x100; bx++) {
    for (let ax = 0; ax < 0x100; ax++) {
      const index = (bx << 8) | ax;
      lut[0 * 0x10000 + index] = fns.make_lut_bg(bx, ax) & 0xff;
      lut[1 * 0x10000 + index] = fns.make_lut_bgobj(bx, ax) & 0xff;
      lut[2 * 0x10000 + index] = fns.make_lut_bg_ste(bx, ax) & 0xff;
      lut[3 * 0x10000 + index] = fns.make_lut_obj(bx, ax) & 0xff;
      lut[4 * 0x10000 + index] = fns.make_lut_bgobj_ste(bx, ax) & 0xff;
      lut[5 * 0x10000 + index] = fns.make_lut_bgobj_m4(bx, ax) & 0xff;
    }
  }
  return lut;
}

/** A C array initializer, 32 values per line. */
function cArray(decl, values) {
  const lines = [];
  for (let i = 0; i < values.length; i += 32) lines.push("  " + Array.from(values.slice(i, i + 32), (v) => String(v)).join(","));
  return `${decl} = {\n${lines.join(",\n")}\n};\n`;
}

/**
 * rd_tables.c: every build-time table, as const data (flash).
 * @returns {{source:string, bytes:number}}
 */
export function tablesSource() {
  const snd = gpgxSoundTables().ym2612;
  if (snd.tlTab.length !== 13 * 2 * 256 || snd.sinTab.length !== 1024) throw new Error("gpgx-sound.json: unexpected YM2612 table sizes");
  const lfo = ymLfoPmTable(snd.lfoPmOutput);
  const vdp = vdpLuts(readFileSync(new URL("gpgx/vdp_render.c", RUNTIME), "utf8"));
  const parts = [
    "/* Generated by romdev (src/analysis/recompile/native/genesis/tables.js).",
    "   genesis_plus_gx's power-on tables, precomputed into flash; derived from",
    "   Genesis Plus GX (non-commercial). Do not edit. */",
    "",
    cArray("const signed int rd_ym_tl_tab[6656]", snd.tlTab),
    cArray("const unsigned int rd_ym_sin_tab[1024]", snd.sinTab),
    cArray("const short rd_ym_lfo_pm_table[32768]", lfo),
    cArray("const unsigned char rd_vdp_lut[6][65536]", vdp),
  ];
  return { source: parts.join("\n"), bytes: 6656 * 4 + 1024 * 4 + 32768 * 2 + 6 * 65536 };
}

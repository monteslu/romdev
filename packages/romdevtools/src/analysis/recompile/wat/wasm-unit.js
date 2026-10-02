// Placing a compiled C unit in a recompiled cart: the units the recompiler
// data generators print from an emulator's own C (scripts/recompile-gen/
// lib/wasm-unit.mjs: snes9x's coprocessors, genesis_plus_gx's SVP). A
// unit's memory (its data, .bss and C stack) sits at a base the cart's
// layout chooses; every address inside it was written as @{offset}.
//
// Plain JS ESM + JSDoc.

/**
 * The whole unit as module fields, placed at `base`.
 * @param {{size:number, types?:string, table?:string|null, globals?:string, funcs:string, data:{off:number, hex:string, relocs:{at:number, rel:number}[]}[]}} u
 * @param {number} base  linear address of the unit's memory (16-byte aligned)
 * @param {string} label the comment line naming the unit
 */
export function placeUnit(u, base, label) {
  const place = (t) => t.replace(/@\{(-?\d+)\}/g, (_, n) => String(base + Number(n)));
  const parts = [`  ;; ---- ${label}, memory at 0x${base.toString(16)}, ${u.size} bytes`];
  if (u.types) parts.push(u.types);
  if (u.table) parts.push(u.table);
  if (u.globals) parts.push(place(u.globals));
  for (const d of u.data) {
    const bytes = Buffer.from(d.hex, "hex");
    for (const r of d.relocs) bytes.writeUInt32LE((base + r.rel) >>> 0, r.at);
    let s = "";
    for (const v of bytes) s += "\\" + (v < 16 ? "0" : "") + v.toString(16);
    parts.push(`  (data (i32.const ${base + d.off}) "${s}")`);
  }
  parts.push(place(u.funcs));
  return parts.join("\n");
}

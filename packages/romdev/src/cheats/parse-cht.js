// Parser for RetroArch `.cht` cheat files.
//
// Format (one game per file):
//   cheats = N
//   cheat0_desc = "Infinite Lives"
//   cheat0_code = "00C7:FF"          (or a Game Genie code, or +-joined combo)
//   cheat0_enable = false
//   cheat1_desc = ...
//
// We parse this into a flat list of { desc, code } entries. Decoding the code
// into an address/value (and classifying ram vs code) is a SEPARATE step
// (gamegenie.js) so the parser stays format-only and testable in isolation.

/** Parse `.cht` text → { count, entries: [{ index, desc, code, enable }] }. */
export function parseCht(text) {
  const entries = new Map(); // index → partial entry
  let declaredCount = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes from string values.
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);

    if (key === "cheats") {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) declaredCount = n;
      continue;
    }

    // cheatK_field
    const m = /^cheat(\d+)_(desc|code|enable|address|value)$/.exec(key);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const field = m[2];
    let e = entries.get(idx);
    if (!e) { e = { index: idx }; entries.set(idx, e); }

    if (field === "desc") e.desc = val;
    else if (field === "code") e.code = val;
    else if (field === "enable") e.enable = /^true$/i.test(val);
    // Some older .cht use cheatK_address / cheatK_value instead of _code.
    else if (field === "address") e.address = val;
    else if (field === "value") e.value = val;
  }

  // Normalize: an entry with address+value but no code becomes an ADDR:VAL code.
  const list = Array.from(entries.values())
    .sort((a, b) => a.index - b.index)
    .map((e) => {
      let code = e.code;
      if (!code && e.address != null && e.value != null) {
        code = `${e.address}:${e.value}`;
      }
      return { index: e.index, desc: e.desc ?? "", code: code ?? "", enable: !!e.enable };
    })
    .filter((e) => e.code); // drop entries with no usable code

  return { count: declaredCount ?? list.length, entries: list };
}

/** Split a `+`-joined multi-code combo into its individual codes. A single
 *  cheat may patch several locations; each sub-code decodes independently. */
export function splitCombo(code) {
  return String(code).split("+").map((c) => c.trim()).filter(Boolean);
}

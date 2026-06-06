// Parser for cc65 / ld65 `.dbg` debug info files.
//
// Documented format: https://cc65.github.io/doc/debug-info.html
// Each line is `<type>\t<k1=v1>,<k2=v2>,...`. The first line is `version`,
// the second is `info` (counts), then a stream of records by type.
//
// We don't parse every record type — only the ones an agent would want for
// "what is this address" or "where is symbol X" workflows:
//   sym    — assembly symbols
//   csym   — C-level symbols (names from the original C source)
//   scope  — scope ranges (functions etc.)
//   seg    — segment definitions (e.g. CODE @ $8000, BSS @ $0000)
//   line   — source line numbers
//   span   — address ranges associated with lines/scopes
//   file   — source file paths

/**
 * @typedef {Object} DbgInfo
 * @property {Map<number, { name: string, file?: number, line?: number }>} files
 * @property {Map<number, { name: string, addrsize: string, type?: string, val?: number, size?: number, scope?: number, ref?: number, exp?: number, sym?: number }>} syms
 * @property {Map<number, { name: string, scope?: number, type?: string, sc?: string, sym?: number, offs?: number }>} csyms
 * @property {Map<number, { name: string, mod?: number, type?: string, size?: number, parent?: number, sym?: number, span?: number }>} scopes
 * @property {Map<number, { name: string, start: number, size: number, addrsize?: string, type?: string, oname?: string, ooffs?: number }>} segs
 * @property {Map<number, { seg: number, start: number, size?: number, type?: string }>} spans
 * @property {Map<number, { file: number, line: number, type?: string, span?: number | number[], count?: number }>} lines
 */

/**
 * Parse a .dbg file's text contents.
 * @param {string} text
 * @returns {DbgInfo}
 */
export function parseDbg(text) {
  /** @type {DbgInfo} */
  const out = {
    files: new Map(),
    syms: new Map(),
    csyms: new Map(),
    scopes: new Map(),
    segs: new Map(),
    spans: new Map(),
    lines: new Map(),
  };

  for (const line of text.split("\n")) {
    if (!line || line.startsWith("version") || line.startsWith("info")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const type = line.slice(0, tab);
    const fields = parseFields(line.slice(tab + 1));
    const id = fields.id !== undefined ? Number(fields.id) : -1;

    switch (type) {
      case "file":
        out.files.set(id, { name: trimQ(fields.name) });
        break;

      case "sym":
        out.syms.set(id, {
          name: trimQ(fields.name),
          addrsize: fields.addrsize,
          type: fields.type,
          val: fields.val !== undefined ? Number(fields.val) : undefined,
          size: fields.size !== undefined ? Number(fields.size) : undefined,
          scope: fields.scope !== undefined ? Number(fields.scope) : undefined,
          ref: fields.ref !== undefined ? Number(fields.ref) : undefined,
          exp: fields.exp !== undefined ? Number(fields.exp) : undefined,
          sym: fields.sym !== undefined ? Number(fields.sym) : undefined,
        });
        break;

      case "csym":
        out.csyms.set(id, {
          name: trimQ(fields.name),
          scope: fields.scope !== undefined ? Number(fields.scope) : undefined,
          type: fields.type,
          sc: fields.sc,
          sym: fields.sym !== undefined ? Number(fields.sym) : undefined,
          offs: fields.offs !== undefined ? Number(fields.offs) : undefined,
        });
        break;

      case "scope":
        out.scopes.set(id, {
          name: trimQ(fields.name),
          mod: fields.mod !== undefined ? Number(fields.mod) : undefined,
          type: fields.type,
          size: fields.size !== undefined ? Number(fields.size) : undefined,
          parent: fields.parent !== undefined ? Number(fields.parent) : undefined,
          sym: fields.sym !== undefined ? Number(fields.sym) : undefined,
          span: fields.span !== undefined ? Number(fields.span) : undefined,
        });
        break;

      case "seg":
        out.segs.set(id, {
          name: trimQ(fields.name),
          start: fields.start !== undefined ? Number(fields.start) : 0,
          size: fields.size !== undefined ? Number(fields.size) : 0,
          addrsize: fields.addrsize,
          type: fields.type,
          oname: fields.oname ? trimQ(fields.oname) : undefined,
          ooffs: fields.ooffs !== undefined ? Number(fields.ooffs) : undefined,
        });
        break;

      case "span":
        out.spans.set(id, {
          seg: fields.seg !== undefined ? Number(fields.seg) : -1,
          start: fields.start !== undefined ? Number(fields.start) : 0,
          size: fields.size !== undefined ? Number(fields.size) : undefined,
          type: fields.type,
        });
        break;

      case "line": {
        let span;
        if (fields.span !== undefined) {
          // span can be "5" or "5+6+7"
          const s = String(fields.span);
          span = s.includes("+") ? s.split("+").map((n) => Number(n)) : Number(s);
        }
        out.lines.set(id, {
          file: fields.file !== undefined ? Number(fields.file) : -1,
          line: fields.line !== undefined ? Number(fields.line) : 0,
          type: fields.type,
          span,
          count: fields.count !== undefined ? Number(fields.count) : undefined,
        });
        break;
      }
      default:
        // Ignore mod/lib/type/sym-info — not needed for our queries yet.
        break;
    }
  }

  return out;
}

function parseFields(str) {
  /** @type {Record<string, string>} */
  const result = {};
  let i = 0;
  const n = str.length;
  while (i < n) {
    // Skip whitespace.
    while (i < n && (str[i] === "," || str[i] === " ")) i++;
    if (i >= n) break;
    // Read key.
    let k = "";
    while (i < n && str[i] !== "=" && str[i] !== ",") {
      k += str[i++];
    }
    if (str[i] !== "=") {
      // Bare key (rare); store as empty value.
      result[k] = "";
      continue;
    }
    i++; // consume '='
    // Read value: either a quoted string or until next comma.
    let v = "";
    if (str[i] === '"') {
      v += str[i++];
      while (i < n) {
        v += str[i];
        if (str[i] === '"' && str[i - 1] !== "\\") {
          i++;
          break;
        }
        i++;
      }
    } else {
      while (i < n && str[i] !== ",") {
        v += str[i++];
      }
    }
    result[k] = v;
  }
  return result;
}

function trimQ(s) {
  if (!s) return "";
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * High-level helpers built on top of a parsed DbgInfo.
 */
export class DbgIndex {
  /** @param {DbgInfo} info */
  constructor(info) {
    this.info = info;

    // Build a name → list-of-symbols lookup.
    /** @type {Map<string, { kind: "sym" | "csym", id: number, addr?: number }[]>} */
    this.byName = new Map();

    for (const [id, sym] of info.syms) {
      const entry = { kind: /** @type {const} */ ("sym"), id, addr: sym.val };
      const list = this.byName.get(sym.name) ?? [];
      list.push(entry);
      this.byName.set(sym.name, list);
    }
    for (const [id, csym] of info.csyms) {
      // C symbols don't carry the address directly — they point at a sym.
      let addr;
      if (csym.sym !== undefined) {
        const s = info.syms.get(csym.sym);
        if (s) addr = s.val;
      }
      const entry = { kind: /** @type {const} */ ("csym"), id, addr };
      const list = this.byName.get(csym.name) ?? [];
      list.push(entry);
      this.byName.set(csym.name, list);
    }
  }

  /**
   * Resolve a symbol name (C or asm) to an address.
   * Returns null if not found, or the first matching address if multiple.
   * @param {string} name
   */
  addressOf(name) {
    const list = this.byName.get(name);
    if (!list || list.length === 0) return null;
    for (const e of list) {
      if (typeof e.addr === "number") return e.addr;
    }
    return null;
  }

  /**
   * Find the symbol whose value (if any) most closely contains the address.
   * Returns the symbol nearest at-or-below the address.
   * @param {number} addr
   */
  symbolAt(addr) {
    /** @type {{ name: string, addr: number, kind: string } | null} */
    let best = null;
    for (const [_id, sym] of this.info.syms) {
      if (typeof sym.val !== "number") continue;
      if (sym.val > addr) continue;
      if (!best || sym.val > best.addr) {
        best = { name: sym.name, addr: sym.val, kind: "sym" };
      }
    }
    return best;
  }

  /** Convenience: list every named symbol with an address. */
  listSymbols() {
    /** @type {{ name: string, addr: number, kind: string }[]} */
    const out = [];
    for (const [_id, sym] of this.info.syms) {
      if (typeof sym.val === "number" && sym.name) {
        out.push({ name: sym.name, addr: sym.val, kind: "sym" });
      }
    }
    for (const [_id, csym] of this.info.csyms) {
      if (csym.sym !== undefined) {
        const s = this.info.syms.get(csym.sym);
        if (s && typeof s.val === "number") {
          out.push({ name: csym.name, addr: s.val, kind: "csym" });
        }
      }
    }
    return out.sort((a, b) => a.addr - b.addr);
  }
}

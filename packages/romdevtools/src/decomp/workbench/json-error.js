// json-error.js - parse JSON and, on failure, report the same message the
// workbench's documents always carried ("Expecting value: line 1 column 1
// (char 0)", "Unterminated string starting at: ...", "Extra data: ...").
// Only the error text is computed here; accepted documents are parsed by
// JSON.parse.
//
// Plain JS ESM + JSDoc.

export class JSONDecodeError extends SyntaxError {
  constructor(msg, doc, pos) {
    const lineno = doc.slice(0, pos).split("\n").length;
    const colno = pos - (doc.lastIndexOf("\n", pos - 1) + 1) + 1;
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
    Object.assign(this, { msg, doc, pos, lineno, colno });
    this.name = "JSONDecodeError";
  }
}

const WS = /[ \t\n\r]*/y;
const NUMBER = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;

function skip(s, i) { WS.lastIndex = i; WS.exec(s); return WS.lastIndex; }

function scanString(s, end) {
  const begin = end - 1;
  for (;;) {
    if (end >= s.length) throw new JSONDecodeError("Unterminated string starting at", s, begin);
    const c = s[end];
    if (c === '"') return end + 1;
    if (c === "\\") {
      const e = s[end + 1];
      if (e === undefined) throw new JSONDecodeError("Unterminated string starting at", s, begin);
      if (e === "u") {
        const h = s.slice(end + 2, end + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new JSONDecodeError("Invalid \\uXXXX escape", s, end + 1);
        end += 6; continue;
      }
      if (!'"\\/bfnrt'.includes(e)) throw new JSONDecodeError("Invalid \\escape", s, end);
      end += 2; continue;
    }
    if (c.charCodeAt(0) < 0x20) throw new JSONDecodeError("Invalid control character at", s, end);
    end += 1;
  }
}

function scanValue(s, i) {
  const c = s[i];
  if (c === '"') return scanString(s, i + 1);
  if (c === "{") return scanObject(s, i + 1);
  if (c === "[") return scanArray(s, i + 1);
  for (const word of ["null", "true", "false", "NaN", "Infinity", "-Infinity"]) if (s.startsWith(word, i)) return i + word.length;
  NUMBER.lastIndex = i;
  const m = NUMBER.exec(s);
  if (m && m.index === i && m[0].length) return i + m[0].length;
  throw new JSONDecodeError("Expecting value", s, i);
}

function scanObject(s, i) {
  i = skip(s, i);
  if (s[i] === "}") return i + 1;
  for (;;) {
    if (s[i] !== '"') throw new JSONDecodeError("Expecting property name enclosed in double quotes", s, i);
    i = scanString(s, i + 1);
    i = skip(s, i);
    if (s[i] !== ":") throw new JSONDecodeError("Expecting ':' delimiter", s, i);
    i = skip(s, i + 1);
    i = scanValue(s, i);
    i = skip(s, i);
    if (s[i] === "}") return i + 1;
    if (s[i] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, i);
    i = skip(s, i + 1);
  }
}

function scanArray(s, i) {
  i = skip(s, i);
  if (s[i] === "]") return i + 1;
  for (;;) {
    i = scanValue(s, i);
    i = skip(s, i);
    if (s[i] === "]") return i + 1;
    if (s[i] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, i);
    i = skip(s, i + 1);
  }
}

/** json.loads(text): the parsed value, or a JSONDecodeError with the original wording. */
export function loadsJson(text) {
  const s = String(text);
  let end;
  const start = skip(s, 0);
  end = scanValue(s, start);
  end = skip(s, end);
  if (end !== s.length) throw new JSONDecodeError("Extra data", s, end);
  try { return JSON.parse(s); } catch {
    // Only the non-standard constants the original also accepts remain.
    return JSON.parse(s.replace(/\bNaN\b|-?\bInfinity\b/g, (m) => (m === "NaN" ? "null" : m.startsWith("-") ? "-1e999" : "1e999")));
  }
}

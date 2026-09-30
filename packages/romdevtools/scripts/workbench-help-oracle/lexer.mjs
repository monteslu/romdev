// Tokenizer for the Python subset the workbench's parser-building code uses.
// Produces NAME, NUMBER, STRING (with prefix + raw body), OP, NEWLINE, INDENT, DEDENT, EOF.

const OPS = ["**=", "//=", ">>=", "<<=", "...", "->", ":=", "**", "//", "<<", ">>", "<=", ">=", "==", "!=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "+", "-", "*", "/", "%", "@", "<", ">", "=", ".", ",", ":", ";", "(", ")", "[", "]", "{", "}", "~", "|", "&", "^"];

export function tokenize(src, file = "<src>") {
  const toks = [];
  const indents = [0];
  let i = 0, line = 1, depth = 0, atLineStart = true;
  const push = (type, value, extra = {}) => toks.push({ type, value, line, file, ...extra });
  while (i < src.length) {
    if (atLineStart && depth === 0) {
      // measure indentation
      let col = 0, j = i;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) { col += src[j] === "\t" ? 8 - (col % 8) : 1; j++; }
      if (src[j] === "\n" || src[j] === "#" || src[j] === "\r" || j >= src.length) {
        // blank or comment-only line
        while (j < src.length && src[j] !== "\n") j++;
        i = j + 1; line++;
        continue;
      }
      i = j;
      if (col > indents[indents.length - 1]) { indents.push(col); push("INDENT", col); }
      while (col < indents[indents.length - 1]) { indents.pop(); push("DEDENT", col); }
      atLineStart = false;
    }
    const c = src[i];
    if (c === "\n") { if (depth === 0) { push("NEWLINE", "\n"); atLineStart = true; } i++; line++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") { i++; continue; }
    if (c === "\\" && src[i + 1] === "\n") { i += 2; line++; continue; }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    // strings (with prefixes)
    const sm = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
    if (sm && (sm[1] === "" || /^[a-zA-Z]+$/.test(sm[1])) && (sm[1].length === 0 || !/[a-zA-Z0-9_]/.test(src[i - 1] ?? " "))) {
      const prefix = sm[1].toLowerCase(), q = sm[2];
      let j = i + sm[0].length, body = "";
      const startLine = line;
      for (;;) {
        if (j >= src.length) throw new Error(`${file}:${startLine}: unterminated string`);
        if (src.startsWith(q, j)) { j += q.length; break; }
        if (src[j] === "\\") { body += src[j] + src[j + 1]; if (src[j + 1] === "\n") line++; j += 2; continue; }
        if (src[j] === "\n") { if (q.length === 1) throw new Error(`${file}:${line}: newline in string`); line++; }
        body += src[j]; j++;
      }
      toks.push({ type: "STRING", prefix, body, line: startLine, file });
      i = j;
      continue;
    }
    const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 80));
    if (nm) { push("NAME", nm[0]); i += nm[0].length; continue; }
    const num = /^(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(src.slice(i, i + 40));
    if (num) { push("NUMBER", num[0]); i += num[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      if ("([{".includes(op)) depth++;
      if (")]}".includes(op)) depth--;
      push("OP", op); i += op.length; continue;
    }
    throw new Error(`${file}:${line}: unexpected character ${JSON.stringify(c)}`);
  }
  push("NEWLINE", "\n");
  while (indents.length > 1) { indents.pop(); push("DEDENT", 0); }
  push("EOF", null);
  return toks;
}

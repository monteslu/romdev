// command-line.js - shell-free command-template parsing: POSIX shlex grammar,
// and the Microsoft backslash-before-quote rules on Windows.
//
// Plain JS ESM + JSDoc.

import { ValueError } from "./py.js";

const WS = /[ \t\n\r\v\f]/;

/** shlex.split(value) in POSIX mode (no comments). */
export function shlexSplit(value) {
  const out = [];
  let token = "", started = false, state = null; // null | "'" | '"'
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (state === "'") { if (c === "'") state = null; else token += c; continue; }
    if (state === '"') {
      if (c === '"') { state = null; continue; }
      if (c === "\\") {
        const n = value[i + 1];
        if (n === undefined) throw new ValueError("No escaped character");
        if (n === "\\" || n === '"') { token += n; i++; } else token += c;
        continue;
      }
      token += c; continue;
    }
    if (WS.test(c)) { if (started) { out.push(token); token = ""; started = false; } continue; }
    if (c === "'" || c === '"') { state = c; started = true; continue; }
    if (c === "\\") {
      const n = value[i + 1];
      if (n === undefined) throw new ValueError("No escaped character");
      token += n; i++; started = true; continue;
    }
    token += c; started = true;
  }
  if (state !== null) throw new ValueError("No closing quotation");
  if (started) out.push(token);
  return out;
}

function splitWindowsCommand(value) {
  const args = [];
  let current = [], quote = null, started = false, index = 0;
  while (index < value.length) {
    const ch = value[index];
    if (quote === null && /\s/.test(ch)) {
      if (started) { args.push(current.join("")); current = []; started = false; }
      index += 1; continue;
    }
    if (ch === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; started = true; index += 1; continue; }
    if (ch === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; started = true; index += 1; continue; }
    if (ch === "\\" && quote !== "'") {
      let end = index;
      while (end < value.length && value[end] === "\\") end += 1;
      const count = end - index;
      if (end < value.length && value[end] === '"') {
        current.push("\\".repeat(Math.floor(count / 2)));
        if (count % 2) current.push('"');
        else quote = quote === '"' ? null : '"';
        started = true; index = end + 1; continue;
      }
      current.push("\\".repeat(count)); started = true; index = end; continue;
    }
    current.push(ch); started = true; index += 1;
  }
  if (quote !== null) throw new ValueError("No closing quotation");
  if (started) args.push(current.join(""));
  return args;
}

/** Split a user-supplied command without asking a shell to interpret it. */
export function splitCommand(value, { windows = null } = {}) {
  if (windows === null) windows = process.platform === "win32";
  return windows ? splitWindowsCommand(value) : shlexSplit(value);
}

// terminal.js - predictable terminal width, colour and pager behaviour for
// the human (non-JSON) renderings.
//
// Plain JS ESM + JSDoc.

export const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ELLIPSIS = "\u2026";

export const WEB_COLORS = ["36", "33", "35", "32", "34", "31"];

/** One colour per verdict family, so a wall of reports is scannable by hue. */
export const VERDICT_COLORS = Object.freeze({
  "exact": "32", "instruction-exact": "32", "words-identical": "32", "instruction-words-identical": "32",
  "constant": "33", "constant-mismatch": "33", "operand-mismatch": "33",
  "commutative-order": "34", "schedule": "36", "schedule-mismatch": "36",
  "structure": "35", "structure-mismatch": "35", "phase-shift": "95",
  "register-permutation": "91", "allocation": "31", "allocation-mismatch": "31",
  "relocation-layout-mismatch": "90", "unknown-relocation": "1;31",
});
export const DEFAULT_VERDICT_COLOR = "31";

/** Minimal ANSI painter with a monochrome-safe default. */
export class Painter {
  constructor(enabled) { this.enabled = !!enabled; }
  _wrap(code, text) { return this.enabled && text ? `\x1b[${code}m${text}\x1b[0m` : text; }
  bold(text) { return this._wrap("1", text); }
  warn(text) { return this._wrap("1;31", text); }
  web(number, text) { return this._wrap(WEB_COLORS[(((number - 1) % WEB_COLORS.length) + WEB_COLORS.length) % WEB_COLORS.length], text); }
  verdict(name, text = null) { return this._wrap(`1;${VERDICT_COLORS[name] ?? DEFAULT_VERDICT_COLOR}`, text === null ? name : text); }
}

/** Decide whether ANSI output is appropriate. Command output is captured, never a TTY. */
export function resolveColor(choice, { env = process.env, isatty = false } = {}) {
  if (choice === "always") return true;
  if (choice === "never") return false;
  if (env.NO_COLOR) return false;
  return !!isatty;
}

export function visibleLength(text) { return String(text).replace(ANSI_RE, "").length; }

export function visibleLjust(text, width) { return text + " ".repeat(Math.max(0, width - visibleLength(text))); }

/** Column budget for a renderer: 0 unlimited, -1 the terminal (120 when captured). */
export function resolveWidth(width) { return width === -1 ? (process.stdout.columns || 120) : width; }

/** Bound a rendered line without splitting terminal escape sequences. */
export function fitLine(line, width) {
  const visible = line.replace(ANSI_RE, "");
  if (width <= 0 || visible.length <= width) return line;
  if (width === 1) return ELLIPSIS;
  const budget = width - 1;
  const parts = [];
  let position = 0, consumed = 0, broke = false;
  const hasAnsi = /\x1b\[[0-9;]*m/.test(line);
  for (const m of line.matchAll(/\x1b\[[0-9;]*m/g)) {
    const plain = line.slice(position, m.index);
    const take = Math.min(plain.length, budget - consumed);
    parts.push(plain.slice(0, take));
    consumed += take;
    if (consumed >= budget) { broke = true; break; }
    parts.push(m[0]);
    position = m.index + m[0].length;
  }
  if (!broke) parts.push(line.slice(position).slice(0, budget - consumed));
  return parts.join("") + ELLIPSIS + (hasAnsi ? "\x1b[0m" : "");
}

/**
 * Render lines directly, or through the user's pager when appropriate:
 * --pager always, or --pager auto on a terminal when the text is taller than
 * it. Paging is done by whoever owns the terminal (io.page); a command whose
 * output is captured (the MCP tool, a pipe) is never a terminal, so its text
 * is written as it is, exactly as the original's pager falls back to plain
 * output when stdout is not a TTY.
 */
export function emitLines(io, lines, { width, pager = "auto" }) {
  const term = io.terminal ?? { isTTY: false, columns: 120, rows: 24 };
  const effective = width === -1 ? (term.columns || 120) : width;
  const text = lines.map((l) => fitLine(l, effective)).join("\n") + "\n";
  const usePager = pager === "always" || (pager === "auto" && term.isTTY && (text.match(/\n/g) ?? []).length > (term.rows || 24));
  if (usePager && io.page) io.page(text);
  else io.write(text);
}

export function warnToStderr(io) { return (note) => io.eprint(`warning: ${note}`); }

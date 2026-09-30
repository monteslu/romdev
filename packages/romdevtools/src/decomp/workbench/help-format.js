// help-format.js - usage and --help text laid out exactly the way the
// workbench's argument parser always printed it (the standard library
// HelpFormatter of the interpreter the workbench shipped against, colour
// off), including its word wrapping, usage-line folding, mutually exclusive
// group brackets and %(default)s expansion.
//
// A parser model:
//   { prog, usage?, description?, epilog?, formatter?: "raw_description" |
//     "raw_text" | "defaults", addHelp?: true,
//     actions: [Action], groups: [{title, description?, actions:[Action]}],
//     mutex: [{required, actions:[Action]}] }
// An Action: { option_strings: [], dest, nargs (null|0|n|"?"|"*"|"+"|"..."|"A..."),
//   const, default, choices, required, help (string|null|SUPPRESS), metavar
//   (string|string[]|null), type, subactions? (a subcommand listing) }
//
// Plain JS ESM + JSDoc.

import { pyRepr } from "./pyrepr.js";
import { PyFloat, floatRepr } from "./py.js";

export const SUPPRESS = "==SUPPRESS==";
const WS = "\t\n\x0b\x0c\r ";

// -- textwrap ------------------------------------------------------------

const WP = "[\\p{L}\\p{N}\\p{Mn}_!\"'&.,?]";
const LT = "[\\p{L}\\p{Mn}_]";
const W = "[\\p{L}\\p{N}\\p{Mn}_]";
const WSC = "[\\t\\n\\x0b\\x0c\\r ]";
const NWS = "[^\\t\\n\\x0b\\x0c\\r ]";
const WORDSEP = new RegExp(
  `(${WSC}+|(?<=${WP})-{2,}(?=${W})|${NWS}+?(?:-(?:(?<=${LT}{2}-)|(?<=${LT}-${LT}-))(?=${LT}-?${LT})|(?=${WSC}|$)|(?<=${WP})(?=-{2,}${W})))`, "u");

function expandTabs(text, tabsize = 8) {
  let out = "", col = 0;
  for (const ch of text) {
    if (ch === "\t") { const n = tabsize - (col % tabsize); out += " ".repeat(n); col += n; }
    else { out += ch; col = ch === "\n" || ch === "\r" ? 0 : col + 1; }
  }
  return out;
}

function splitChunks(text) {
  text = expandTabs(text);
  text = [...text].map((c) => (WS.includes(c) ? " " : c)).join("");
  return text.split(WORDSEP).filter((c) => c);
}

const blank = (s) => s.trim() === "" && [...s].every((c) => WS.includes(c) || /\s/.test(c));

/** textwrap.wrap(text, width, initial_indent, subsequent_indent) */
export function wrap(text, width, { initialIndent = "", subsequentIndent = "" } = {}) {
  const chunks = splitChunks(text).reverse();
  const lines = [];
  if (width <= 0) throw new Error(`invalid width ${width} (must be > 0)`);
  while (chunks.length) {
    let cur = [], curLen = 0;
    const indent = lines.length ? subsequentIndent : initialIndent;
    const w = width - indent.length;
    if (blank(chunks[chunks.length - 1]) && lines.length) chunks.pop();
    while (chunks.length) {
      const l = chunks[chunks.length - 1].length;
      if (curLen + l <= w) { cur.push(chunks.pop()); curLen += l; } else break;
    }
    if (chunks.length && chunks[chunks.length - 1].length > w) {
      // _handle_long_word
      const spaceLeft = w < 1 ? 1 : w - curLen;
      if (spaceLeft > 0) {
        let end = spaceLeft;
        const chunk = chunks[chunks.length - 1];
        if (chunk.length > spaceLeft) {
          const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
          if (hyphen > 0 && [...chunk.slice(0, hyphen)].some((c) => c !== "-")) end = hyphen + 1;
        }
        cur.push(chunk.slice(0, end));
        chunks[chunks.length - 1] = chunk.slice(end);
      } else if (!cur.length) cur.push(chunks.pop());
      curLen = cur.reduce((s, c) => s + c.length, 0);
    }
    if (cur.length && blank(cur[cur.length - 1])) { curLen -= cur[cur.length - 1].length; cur.pop(); }
    if (cur.length) lines.push(indent + cur.join(""));
  }
  return lines;
}

/** textwrap.fill */
export function fill(text, width, opts) { return wrap(text, width, opts).join("\n"); }

// -- % formatting of help strings ------------------------------------------

function pyStrValue(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (v instanceof PyFloat) return floatRepr(v.value);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : floatRepr(v);
  if (typeof v === "string") return v;
  if (typeof v === "function") return v.displayName ?? v.name;
  return pyRepr(v);
}

/** `help % params` for the %(name)s / %(name)r / %(name)d / %% forms. */
export function percentFormat(text, params) {
  return text.replace(/%(?:\(([^)]*)\))?([-#0 +]*)(\d*)(?:\.(\d+))?([sdirfgx%])/g, (m, name, flags, width, prec, conv) => {
    if (conv === "%") return "%";
    if (name === undefined) throw new Error(`format requires a mapping: ${m}`);
    if (!(name in params)) throw new Error(`KeyError: '${name}'`);
    const v = params[name];
    let s;
    if (conv === "s") s = pyStrValue(v);
    else if (conv === "r") s = pyRepr(v);
    else if (conv === "d" || conv === "i") s = String(Math.trunc(Number(v)));
    else if (conv === "f") s = Number(v).toFixed(prec === undefined ? 6 : Number(prec));
    else if (conv === "x") s = Math.trunc(Number(v)).toString(16);
    else s = pyStrValue(v);
    if (conv === "s" && prec !== undefined) s = s.slice(0, Number(prec));
    const wdt = Number(width || 0);
    if (s.length < wdt) s = flags.includes("-") ? s.padEnd(wdt) : s.padStart(wdt, flags.includes("0") && conv !== "s" ? "0" : " ");
    return s;
  });
}

// -- the formatter ----------------------------------------------------------

const isLong = (s) => s.length > 2;

function metavarFormatter(action, defaultMetavar) {
  let result;
  if (action.metavar !== null && action.metavar !== undefined) result = action.metavar;
  else if (action.choices !== null && action.choices !== undefined) result = `{${action.choices.map((c) => pyStrValue(c)).join(",")}}`;
  else result = defaultMetavar;
  return (n) => (Array.isArray(result) ? result : Array(n).fill(result));
}

function formatArgs(action, defaultMetavar) {
  const get = metavarFormatter(action, defaultMetavar);
  const n = action.nargs;
  if (n === null || n === undefined) return `${get(1)[0]}`;
  if (n === "?") return `[${get(1)[0]}]`;
  if (n === "*") { const m = get(1); return m.length === 2 ? `[${m[0]} [${m[1]} ...]]` : `[${m[0]} ...]`; }
  if (n === "+") { const m = get(2); return `${m[0]} [${m[1]} ...]`; }
  if (n === "...") return "...";
  if (n === "A...") return `${get(1)[0]} ...`;
  if (n === SUPPRESS) return "";
  return get(n).slice(0, n).join(" ");
}

const defaultOptionalMetavar = (a) => a.dest.toUpperCase();
const defaultPositionalMetavar = (a) => a.dest;

function formatUsagePart(action) {
  if (action.nargs === 0) return action.usage_text ?? action.option_strings[0];
  return `${action.option_strings[0]} ${formatArgs(action, defaultOptionalMetavar(action))}`;
}

function actionsUsageParts(actions, mutex) {
  actions = actions.filter((a) => a.help !== SUPPRESS);
  const groupOf = new Map(actions.map((a) => [a, null]));
  for (const g of mutex) for (const a of g.actions) if (groupOf.has(a)) groupOf.set(a, g);
  const pop = (a) => { const had = groupOf.has(a); const g = groupOf.get(a) ?? null; groupOf.delete(a); return [had, g]; };
  const positionals = [];
  for (const a of actions) {
    if (a.option_strings.length) continue;
    const [, g] = pop(a);
    if (g) positionals.push([g.required, [...g.actions.filter((b) => b.option_strings.length && pop(b)[0]), a]]);
    else positionals.push([null, [a]]);
  }
  const optionals = [];
  for (const a of actions) {
    if (!a.option_strings.length || !groupOf.has(a)) continue;
    const [, g] = pop(a);
    if (g) optionals.push([g.required, [a, ...g.actions.filter((b) => b !== a && b.option_strings.length && pop(b)[0])]]);
    else optionals.push([null, [a]]);
  }
  const parts = [];
  let posStart = null;
  [...optionals, ...positionals].forEach(([required, group], i) => {
    const start = parts.length;
    if (i === optionals.length) posStart = start;
    const inGroup = group.length > 1;
    for (const a of group) {
      let part;
      if (!a.option_strings.length) {
        part = formatArgs(a, defaultPositionalMetavar(a));
        if (inGroup && part[0] === "[" && part[part.length - 1] === "]") part = part.slice(1, -1);
      } else {
        part = formatUsagePart(a);
        if (!(a.required || required || inGroup)) part = `[${part}]`;
      }
      parts.push(part);
    }
    if (inGroup) {
      parts[start] = (required ? "(" : "[") + parts[start];
      for (let k = start; k < parts.length - 1; k++) parts[k] += " |";
      parts[parts.length - 1] += required ? ")" : "]";
    }
  });
  if (posStart === null) posStart = parts.length;
  return [parts, posStart];
}

class Formatter {
  constructor(prog, { width, formatter = null }) {
    this.prog = prog;
    this.indentIncrement = 2;
    this.width = width;
    this.maxHelpPosition = Math.min(24, Math.max(width - 20, 4));
    this.currentIndent = 0;
    this.actionMaxLength = 0;
    this.raw = formatter === "raw_description" || formatter === "raw_text";
    this.rawText = formatter === "raw_text";
    this.defaults = formatter === "defaults";
    this.root = { parent: null, heading: null, items: [] };
    this.current = this.root;
  }
  indent() { this.currentIndent += this.indentIncrement; }
  dedent() { this.currentIndent -= this.indentIncrement; }
  sectionHelp(sec) {
    if (sec.parent) this.indent();
    const itemHelp = sec.items.map((f) => f()).filter((p) => p && p !== SUPPRESS).join("");
    if (sec.parent) this.dedent();
    if (!itemHelp) return "";
    const heading = sec.heading !== SUPPRESS && sec.heading !== null && sec.heading !== undefined ? `${" ".repeat(this.currentIndent)}${sec.heading}:\n` : "";
    return ["\n", heading, itemHelp, "\n"].filter((p) => p).join("");
  }
  startSection(heading) {
    this.indent();
    const sec = { parent: this.current, heading, items: [] };
    this.current.items.push(() => this.sectionHelp(sec));
    this.current = sec;
  }
  endSection() { this.current = this.current.parent; this.dedent(); }
  addText(text) { if (text !== SUPPRESS && text !== null && text !== undefined) this.current.items.push(() => this.formatText(text)); }
  addUsage(usage, actions, mutex, prefix = null) { if (usage !== SUPPRESS) this.current.items.push(() => this.formatUsage(usage, actions, mutex, prefix)); }
  addArgument(action) {
    if (action.help === SUPPRESS) return;
    const lengths = [this.invocation(action).length + this.currentIndent];
    if (action.subactions) {
      this.indent();
      for (const sub of action.subactions) lengths.push(this.invocation(sub).length + this.currentIndent);
      this.dedent();
    }
    this.actionMaxLength = Math.max(this.actionMaxLength, ...lengths);
    this.current.items.push(() => this.formatAction(action));
  }
  formatHelp() {
    let help = this.sectionHelp(this.root);
    if (help) help = help.replace(/\n\n\n+/g, "\n\n").replace(/^\n+|\n+$/g, "") + "\n";
    return help;
  }
  formatUsage(usage, actions, mutex, prefix) {
    if (prefix === null) prefix = "usage: ";
    if (usage !== null && usage !== undefined) usage = percentFormat(usage, { prog: this.prog });
    else if (!actions.length) usage = this.prog;
    else {
      const prog = this.prog;
      const [parts, posStart] = actionsUsageParts(actions, mutex);
      usage = [prog, ...parts].filter((p) => p).join(" ");
      const textWidth = this.width - this.currentIndent;
      if (prefix.length + usage.length > textWidth) {
        const optParts = parts.slice(0, posStart), posParts = parts.slice(posStart);
        const getLines = (ps, indent, pfx = null) => {
          const lines = [];
          let line = [];
          const indentLength = indent.length;
          let lineLen = pfx !== null ? pfx.length - 1 : indentLength - 1;
          for (const part of ps) {
            if (lineLen + 1 + part.length > textWidth && line.length) { lines.push(indent + line.join(" ")); line = []; lineLen = indentLength - 1; }
            line.push(part);
            lineLen += part.length + 1;
          }
          if (line.length) lines.push(indent + line.join(" "));
          if (pfx !== null) lines[0] = lines[0].slice(indentLength);
          return lines;
        };
        let lines;
        if (prefix.length + prog.length <= 0.75 * textWidth) {
          const indent = " ".repeat(prefix.length + prog.length + 1);
          if (optParts.length) { lines = getLines([prog, ...optParts], indent, prefix); lines.push(...getLines(posParts, indent)); }
          else if (posParts.length) lines = getLines([prog, ...posParts], indent, prefix);
          else lines = [prog];
        } else {
          const indent = " ".repeat(prefix.length);
          let ls = getLines([...optParts, ...posParts], indent);
          if (ls.length > 1) ls = [...getLines(optParts, indent), ...getLines(posParts, indent)];
          lines = [prog, ...ls];
        }
        usage = lines.join("\n");
      }
    }
    return `${prefix}${usage}\n\n`;
  }
  formatText(text) {
    if (text.includes("%(prog)")) text = percentFormat(text, { prog: this.prog });
    const textWidth = Math.max(this.width - this.currentIndent, 11);
    const indent = " ".repeat(this.currentIndent);
    return this.fillText(text, textWidth, indent) + "\n\n";
  }
  fillText(text, width, indent) {
    if (this.raw) return text.split(/(?<=\n)/).map((l) => indent + l).join("");
    const t = text.replace(/[\t\n\x0b\x0c\r ]+/g, " ").trim();
    return fill(t, width, { initialIndent: indent, subsequentIndent: indent });
  }
  splitLines(text, width) {
    if (this.rawText) return text.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/);
    return wrap(text.replace(/[\t\n\x0b\x0c\r ]+/g, " ").trim(), width);
  }
  invocation(action) {
    if (!action.option_strings.length) return metavarFormatter(action, defaultPositionalMetavar(action))(1).join(" ");
    if (action.nargs === 0) return action.option_strings.join(", ");
    return action.option_strings.join(", ") + " " + formatArgs(action, defaultOptionalMetavar(action));
  }
  helpString(action) {
    let help = action.help;
    if (this.defaults) {
      if (help === null || help === undefined) help = "";
      if (!help.includes("%(default)") && action.default !== SUPPRESS && !action.required
        && (action.option_strings.length || action.nargs === "?" || action.nargs === "*")) help += " (default: %(default)s)";
    }
    return help;
  }
  expandHelp(action) {
    const help = this.helpString(action);
    if (!help.includes("%")) return help;
    const params = { ...action, prog: this.prog };
    for (const k of Object.keys(params)) if (params[k] === SUPPRESS) delete params[k];
    if (params.choices !== null && params.choices !== undefined) params.choices = params.choices.map((c) => pyStrValue(c)).join(", ");
    return percentFormat(help, params);
  }
  formatAction(action) {
    const helpPosition = Math.min(this.actionMaxLength + 2, this.maxHelpPosition);
    const helpWidth = Math.max(this.width - helpPosition, 11);
    const actionWidth = helpPosition - this.currentIndent - 2;
    let header = this.invocation(action);
    let indentFirst = 0;
    const help = this.helpString(action);
    if (!help) header = `${" ".repeat(this.currentIndent)}${header}\n`;
    else if (header.length <= actionWidth) header = `${" ".repeat(this.currentIndent)}${header.padEnd(actionWidth)}  `;
    else { header = `${" ".repeat(this.currentIndent)}${header}\n`; indentFirst = helpPosition; }
    const parts = [header];
    if (help && help.trim()) {
      const text = this.expandHelp(action);
      if (text) {
        const lines = this.splitLines(text, helpWidth);
        parts.push(`${" ".repeat(indentFirst)}${lines[0] ?? ""}\n`);
        for (const l of lines.slice(1)) parts.push(`${" ".repeat(helpPosition)}${l}\n`);
      }
    } else if (!header.endsWith("\n")) parts.push("\n");
    if (action.subactions) {
      this.indent();
      for (const sub of action.subactions) parts.push(this.formatAction(sub));
      this.dedent();
    }
    return parts.join("");
  }
}

/** The terminal width the help is laid out for (COLUMNS, else 80) minus 2. */
export function helpWidth(env = process.env, stream = process.stdout) {
  let cols = parseInt(env.COLUMNS ?? "", 10);
  if (!(cols > 0)) cols = stream?.isTTY && stream.columns ? stream.columns : 80;
  return cols - 2;
}

/** parser.format_help() */
export function formatParserHelp(parser, { width = helpWidth() } = {}) {
  const f = new Formatter(parser.prog, { width, formatter: parser.formatter });
  f.addUsage(parser.usage ?? null, parser.actions, parser.mutex ?? []);
  f.addText(parser.description ?? null);
  for (const g of parser.groups) {
    f.startSection(g.title);
    f.addText(g.description ?? null);
    for (const a of g.actions) f.addArgument(a);
    f.endSection();
  }
  f.addText(parser.epilog ?? null);
  return f.formatHelp();
}

/** parser.format_usage() */
export function formatParserUsage(parser, { width = helpWidth() } = {}) {
  const f = new Formatter(parser.prog, { width, formatter: parser.formatter });
  f.addUsage(parser.usage ?? null, parser.actions, parser.mutex ?? []);
  return f.formatHelp();
}

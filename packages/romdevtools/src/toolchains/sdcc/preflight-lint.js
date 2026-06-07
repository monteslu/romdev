// Pre-flight scan for SDCC sm83 / z80 C sources.
//
// What this catches now: C89 violations — mid-block declarations and
// C99 inline for-loop counter decls. SDCC's sm83 frontend is C89 only,
// and its error reporting for these is misleading (it points at the
// line AFTER the offense). We emit the warning with the right file:line.
//
// The "crash family" patterns (#1..#10, #37, #38, #39 from agent reports)
// were stack-overflow symptoms — fixed at the build level with
// -s STACK_SIZE=8388608. Those checks are gone.

/**
 * @typedef {Object} LintIssue
 * @property {"warning"} severity
 * @property {string} file
 * @property {number} line
 * @property {string} message
 * @property {string} stage    always "lint"
 * @property {string} ref      anchor in SDCC_GOTCHAS.md (e.g. "#3")
 */

/**
 * Lint a single C source for known SDCC C89 violations.
 * @param {string} source  raw C text
 * @param {string} file    virtual filename for error reporting
 * @param {{port?: string}} [opts]
 *        `port` is "sm83" (GB/GBC) or "z80" (SMS/GG/MSX/Coleco/ZXSpectrum)
 *        — controls the message wording so it says "SDCC sm83" on GB/GBC
 *        and "SDCC z80" on the z80 platforms. Default "sm83" for back-compat.
 * @returns {LintIssue[]}
 */
export function lintSdccSource(source, file = "main.c", opts = {}) {
  const port = opts.port || "sm83";
  const portLabel = `SDCC ${port}`;
  const issues = [];
  const lines = source.split(/\r?\n/);

  // ─── C89 violations ─────────────────────────────────────────────
  // SDCC's sm83 and z80 frontends are both C89-only — no inline for-loop
  // counter decls, no mid-block decls. Catching these here gives a clear
  // file:line; otherwise SDCC reports the misleading "syntax error on
  // the NEXT decl" line.

  // for (int i = ...; ...; ...) / for (uint8_t i = ...) etc.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip line comments + block-comment opens to reduce false positives.
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    // C99 for-loop counter declaration: for (type-keyword identifier ...
    if (/\bfor\s*\(\s*(?:unsigned\s+|signed\s+)?(?:char|short|int|long|signed|unsigned|u?int(?:8|16|32|64)_t|size_t|ptrdiff_t|bool|u8|u16|u32|u64|uint8|uint16|uint32|uint64|int8|int16|int32|int64)\b/.test(code)) {
      issues.push({
        severity: "warning",
        file,
        line: i + 1,
        stage: "lint",
        message: "C99 inline for-loop counter declaration",
        details: `${portLabel} is C89 only. Declare the counter at the top of the enclosing block: \`int i; for (i = 0; ...; i++)\`. See SDCC_GOTCHAS.md § C89 vs C99.`,
        ref: "C89",
      });
    }
  }

  // ─── uint8 loop-bound trap ──────────────────────────────────────
  // `uint8_t i; for (i = 0; i < BOUND; i++)` where BOUND > 255 is an
  // infinite loop (the counter can never reach the bound) and SDCC gives
  // no warning. Detect: a u8-typed counter used in a `< BOUND` test where
  // BOUND is a literal or a simple `A * B` product that exceeds 255.
  // CONSERVATIVE: only flag when we can SEE the counter declared u8 and
  // the bound is a constant we can evaluate — never guess.
  {
    // Build a SCOPE-AWARE map of where each name is declared and at what
    // width. A name like `i` is commonly re-declared in several functions
    // — some as uint8_t, some as uint16_t. A flat "is this name ever u8"
    // set wrongly flags the uint16_t loop just because a DIFFERENT
    // function declared its own `i` as uint8_t (the SMS/GG default
    // scaffold false-positive). Instead we record EVERY declaration's
    // line + width, then for each loop consult the nearest declaration of
    // the counter that appears ABOVE the loop — i.e. the one actually in
    // scope — and only flag it when that declaration is 8-bit.
    //
    // decls: Map<name, Array<{line:number, u8:boolean}>>  (line is 1-based)
    const decls = new Map();
    const addDecl = (names, line, u8) => {
      for (const raw of names.split(",")) {
        const n = raw.trim();
        if (!n) continue;
        if (!decls.has(n)) decls.set(n, []);
        decls.get(n).push({ line, u8 });
      }
    };
    const u8re   = /\b(?:unsigned\s+char|char|u8|uint8_t|uint8|int8_t|int8|signed\s+char)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*;/;
    // 16-bit-or-wider integer declarations (and float/double, which also
    // can't overflow at 255). Anything not 8-bit is "wide" for our purpose.
    const wideRe = /\b(?:unsigned\s+(?:short|int|long)|signed\s+(?:short|int|long)|short|int|long|u16|u32|u64|uint16_t|uint16|int16_t|int16|uint32_t|uint32|int32_t|int32|uint64_t|uint64|int64_t|int64|size_t|ptrdiff_t)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*;/;
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      const m8 = code.match(u8re);
      if (m8) { addDecl(m8[1], i + 1, true); continue; }
      const mw = code.match(wideRe);
      if (mw) addDecl(mw[1], i + 1, false);
    }
    // Is the counter declared 8-bit in the scope visible at `loopLine`?
    // Use the NEAREST declaration above the loop. If the nearest visible
    // declaration is wide (uint16_t etc.), the loop is fine.
    const counterIsU8AtLine = (counter, loopLine) => {
      const ds = decls.get(counter);
      if (!ds) return false;
      let best = null;
      for (const d of ds) {
        if (d.line <= loopLine && (best === null || d.line > best.line)) best = d;
      }
      // No declaration above the loop (e.g. param/global declared after, or
      // out-of-order) — fall back to "flag only if EVERY decl is u8" so we
      // never wolf-cry on a name that is also declared wide somewhere.
      if (best === null) return ds.every((d) => d.u8);
      return best.u8;
    };
    const evalConst = (expr) => {
      // Only literals and pure `A * B [* C]` products of decimal/hex ints.
      const t = expr.trim();
      if (/^(?:0x[0-9a-fA-F]+|\d+)$/.test(t)) return Number(t);
      const parts = t.split("*").map((s) => s.trim());
      if (parts.length >= 2 && parts.every((p) => /^(?:0x[0-9a-fA-F]+|\d+)$/.test(p))) {
        return parts.reduce((a, p) => a * Number(p), 1);
      }
      return null;
    };
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      // for ( ... ident < BOUND ; ... )  — grab the counter + bound.
      const m = code.match(/\bfor\s*\([^;]*;\s*([A-Za-z_]\w*)\s*<\s*([^;]+?)\s*;/);
      if (!m) continue;
      const [, counter, boundExpr] = m;
      if (!counterIsU8AtLine(counter, i + 1)) continue;
      const bound = evalConst(boundExpr);
      if (bound !== null && bound > 255) {
        issues.push({
          severity: "warning",
          file,
          line: i + 1,
          stage: "lint",
          message: `uint8 loop counter '${counter}' with bound ${bound} (> 255) — infinite loop`,
          details: `A u8/uint8_t/char counter can never reach ${bound}, so this loop never exits and all code after it is dead. ${portLabel} gives no warning. Declare '${counter}' as uint16_t. See GB TROUBLESHOOTING § uint8 loop-bound trap.`,
          ref: "uint8-loop-bound",
        });
      }
    }
  }

  // ─── __xdata / VRAM byte-copy miscompile ────────────────────────
  // SDCC sm83 miscompiles `for (i...) dst[i] = src[i];` when dst is an
  // __xdata pointer (e.g. into VRAM $8000) — it writes through the return
  // address and crashes the CPU. Hard to prove the pointer target
  // statically, so flag the SHAPE (an array-index copy `a[i] = b[i];`
  // inside a for-loop) as ADVISORY, pointing at memcpy_vram. Conservative:
  // require a for-loop on the line/just above + an indexed-to-indexed copy.
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    // indexed-to-indexed copy: ident[idx] = ident[idx];  (same index token)
    const cp = code.match(/\b([A-Za-z_]\w*)\s*\[\s*([A-Za-z_]\w*)\s*\]\s*=\s*([A-Za-z_]\w*)\s*\[\s*([A-Za-z_]\w*)\s*\]\s*;/);
    if (!cp) continue;
    const idx1 = cp[2], idx2 = cp[4];
    if (idx1 !== idx2) continue; // not a parallel copy
    // Require a for-loop driving this copy (this line or the 2 above).
    const ctx = (lines[i] + "\n" + (lines[i - 1] || "") + "\n" + (lines[i - 2] || ""));
    if (!/\bfor\s*\(/.test(ctx)) continue;
    issues.push({
      severity: "warning",
      file,
      line: i + 1,
      stage: "lint",
      message: `byte-copy loop \`${cp[1]}[${idx1}] = ${cp[3]}[${idx2}]\` — miscompiles if the destination is VRAM/__xdata`,
      details: `${portLabel} miscompiles this pattern when '${cp[1]}' points into VRAM ($8000-$9FFF) or another __xdata region — it writes through the return address and crashes the CPU (PC near $002B, sprites/tiles never show). If '${cp[1]}' is a VRAM/__xdata pointer, use \`memcpy_vram(${cp[1]}, ${cp[3]}, n)\` (in gb_runtime.c) instead. Ignore if '${cp[1]}' is plain WRAM/an array. See GB TROUBLESHOOTING § the #1 SDCC footgun.`,
      ref: "xdata-copy-miscompile",
    });
  }

  // Mid-block declarations (rough heuristic — flags any `type name [=...] ;`
  // that appears after a non-decl, non-blank statement at deeper indent
  // than the function opening brace).
  const c89DeclWarnings = detectMidBlockDecls(lines, portLabel);
  for (const w of c89DeclWarnings) {
    issues.push({ ...w, file, stage: "lint", severity: "warning", ref: "C89" });
  }

  return issues;
}

/**
 * Lint a `sources` map. Returns issues from every TU.
 * @param {Record<string, string>} sources
 * @param {{port?: string}} [opts]  See lintSdccSource.
 */
export function lintSources(sources, opts = {}) {
  const issues = [];
  for (const [name, src] of Object.entries(sources)) {
    if (!/\.(c|h)$/i.test(name)) continue;
    issues.push(...lintSdccSource(src, name, opts));
  }
  return issues;
}

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Detect mid-block variable declarations (C89 violation). Simple state
 * machine: track block depth + whether we've seen a non-decl statement
 * in this block. A decl after a non-decl statement is the violation.
 *
 * False positives: typedefs in unusual places, prototype-style empty
 * blocks. Not strict — we only emit warnings.
 */
function detectMidBlockDecls(lines, portLabel = "SDCC sm83") {
  const issues = [];
  // Block stack: each entry is {sawCode: boolean, midDeclCount: number}
  const stack = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Strip block comments. Handle multi-line comments crudely.
    if (inComment) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = line.slice(end + 2);
      inComment = false;
    }
    line = line.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, "");
    const blockOpen = line.indexOf("/*");
    if (blockOpen >= 0) {
      line = line.slice(0, blockOpen);
      inComment = true;
    }
    line = line.replace(/\/\/.*$/, "");
    const stripped = line.trim();
    if (!stripped) continue;

    // Detect what's on this line BEFORE and AFTER any braces. Order
    // matters: if the line is `void foo(void) {` we need the `{` to
    // push the block stack BEFORE we evaluate the rest of the line as
    // a statement.
    // Strip prototype-style "type name(...)" function headers — those
    // aren't statements and shouldn't set sawCode. After the `{` we'll
    // see the body.
    const hadOpen  = stripped.includes("{");
    const hadClose = stripped.includes("}");
    if (hadOpen) {
      // Process anything BEFORE the brace as part of the OUTER scope
      // (which we don't care about for mid-decl detection — the inner
      // scope is what counts), then push.
      stack.push({ sawCode: false, midDeclCount: 0 });
    }
    if (hadClose) stack.pop();

    if (stack.length === 0) continue;
    const inFunction = stack.length >= 1;
    if (!inFunction) continue;

    // After-brace content: take whatever comes after the LAST `{` on
    // this line (so `void main(void) { i = 5;` evaluates ` i = 5;`
    // against the freshly-pushed block).
    let after = stripped;
    const lastOpen = stripped.lastIndexOf("{");
    if (lastOpen >= 0) after = stripped.slice(lastOpen + 1).trim();
    if (!after) continue;

    if (/^[{}]/.test(after)) continue;
    if (/^#/.test(after)) continue;
    if (/^[A-Za-z_]\w*\s*:\s*$/.test(after)) continue; // label

    // Match a declaration. Cover:
    //   - plain types:        u8 x;          int x = 5;
    //   - pointers:           u8 *p;         char **argv;
    //   - arrays:             u8 buf[10];
    //   - extern:             extern u8 x;
    //   - typedef'd types:    SomeType x;    (any caps-leading or _-leading identifier)
    // Anchor: start of the trimmed line + type-token + optional `*`s + identifier.
    //
    // CONSERVATIVE: prefer false-negatives. The cost of a false-positive
    // ("you have a mid-block decl" when the user is innocent) is way
    // worse than missing a real one — the agent has already told us
    // they distrust the linter after one wolf cry.
    const TYPE_RE = /^(?:static\s+|const\s+|register\s+|volatile\s+|extern\s+|auto\s+)*(?:unsigned\s+|signed\s+)?(?:char|short|int|long|float|double|void|struct\s+\w+|union\s+\w+|enum\s+\w+|u?int(?:8|16|32|64)_t|u8|u16|u32|u64|uint8|uint16|uint32|uint64|int8|int16|int32|int64|size_t|ptrdiff_t|bool|FILE|[A-Z][A-Za-z0-9_]*_t)\s+\*{0,3}\s*[A-Za-z_]\w*/;
    const isDecl = TYPE_RE.test(after);

    // Identify what counts as "non-decl code" — only the ACTUAL flow-
    // control keywords + assignments + calls. Things that AREN'T code:
    //   - control-flow KEYWORDS inside a declaration's initializer
    //   - assignments inside an initializer (e.g. `int x = (cond ? a : b);`)
    // The simplest correct rule: lines that don't match TYPE_RE and DO
    // contain `=`, `(`, `return`, or a recognized statement keyword.
    // We only set sawCode=true on those.
    //
    // Lines that are ONLY trailing tokens of a previous statement (e.g.
    // continuation of a multi-line assignment) DON'T count either — but
    // we don't track those, so allow some noise on multi-line stmts.
    const looksLikeCode = !isDecl && (
      /^(?:return\b|if\s*\(|for\s*\(|while\s*\(|do\b|switch\s*\(|goto\b|break\b|continue\b|case\b|default\s*:)/.test(after) ||
      // assignment: ident or pointer/array deref + `=` (not `==`)
      /^[*&(]?\s*[A-Za-z_][A-Za-z0-9_.\->\[\]\s]*?[^=!<>]=[^=]/.test(after) ||
      // function call as statement: ident(...)
      /^[A-Za-z_]\w*\s*\(/.test(after) ||
      // postfix ++/-- as a statement: `i++;` or `*p--;`
      /^[*&(]?\s*[A-Za-z_][A-Za-z0-9_.\->\[\]]*\s*(?:\+\+|--)\s*;/.test(after) ||
      // prefix ++/-- as a statement: `++i;`
      /^(?:\+\+|--)\s*[A-Za-z_]/.test(after)
    );

    const top = stack[stack.length - 1];
    if (isDecl) {
      if (top.sawCode) {
        // Report EVERY mid-block decl in the block, not just the first.
        // Earlier rounds suppressed subsequent decls (one-per-block) which
        // led to the "linter says line 533, real decl is line 539" footgun
        // an agent reported in round 24 — the linter caught an earlier
        // decl the agent didn't recognize, then suppressed the obvious
        // one. Reporting all of them eliminates the surprise: every line
        // the lint mentions IS a real mid-block decl.
        const ordinal = top.midDeclCount === 0 ? "Mid-block declaration" : `Mid-block declaration (#${top.midDeclCount + 1} in this block)`;
        issues.push({
          line: i + 1,
          message: `${ordinal} (C89 violation)`,
          details: `${portLabel} is C89 only — variable declarations must come BEFORE any code statement in a block. Move this declaration to the top of the enclosing block. NOTE: SDCC's own reported error line is usually wrong (points at the line AFTER the offense); use this warning's line instead. If the line shown doesn't look like a decl to you, double-check: typedef'd names ending in \`_t\` and struct/union/enum types all count as declarations. See SDCC_GOTCHAS.md § C89 vs C99.`,
        });
        top.midDeclCount++;
      }
      // A decl itself never sets sawCode — that's the whole point.
    } else if (looksLikeCode) {
      // Real statement — flag any future decl in this block.
      top.sawCode = true;
    }
    // Lines that match neither (continuations, comments-only after strip,
    // unrecognized syntax) are left alone — we don't flip sawCode on them.
  }
  return issues;
}

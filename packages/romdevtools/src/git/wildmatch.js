// wildmatch.js - a line-for-line port of git's wildmatch.c (the matcher
// behind .gitignore, .gitattributes, pathspecs and includeIf), so a pattern
// means exactly what it means to git: `*` stops at `/` under WM_PATHNAME,
// `**` spans directories only as a whole component, bracket classes take
// ranges, `!`/`^` negation, backslash escapes and the POSIX [:class:] names.
//
// Works on JS strings (one code unit per "byte"); git's paths are UTF-8, and
// every special character the matcher cares about is ASCII, so the only
// divergence is a bracket RANGE spanning non-ASCII code points.
//
// Plain JS ESM + JSDoc.

export const WM_CASEFOLD = 1;
export const WM_PATHNAME = 2;

const WM_NOMATCH = 1;
const WM_MATCH = 0;
const WM_ABORT_ALL = -1;
const WM_ABORT_TO_STARSTAR = -2;

const isUpper = (c) => c >= 65 && c <= 90;
const isLower = (c) => c >= 97 && c <= 122;
const isDigit = (c) => c >= 48 && c <= 57;
const isAlpha = (c) => isUpper(c) || isLower(c);
const lower = (c) => (isUpper(c) ? c + 32 : c);
const upper = (c) => (isLower(c) ? c - 32 : c);
const isGlobSpecial = (c) => c === 42 /* * */ || c === 63 /* ? */ || c === 91 /* [ */ || c === 92 /* \ */;

const CLASSES = {
  alnum: (c) => isAlpha(c) || isDigit(c),
  alpha: isAlpha,
  blank: (c) => c === 32 || c === 9,
  cntrl: (c) => c < 32 || c === 127,
  digit: isDigit,
  graph: (c) => c > 32 && c < 127,
  lower: isLower,
  print: (c) => c >= 32 && c < 127,
  punct: (c) => c > 32 && c < 127 && !isAlpha(c) && !isDigit(c),
  space: (c) => c === 32 || (c >= 9 && c <= 13),
  upper: isUpper,
  xdigit: (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
};

/**
 * @param {string} P pattern
 * @param {string} T text
 * @param {number} p index into P
 * @param {number} t index into T
 * @param {number} flags
 */
function dowild(P, T, p, t, flags) {
  const pat0 = p;
  const at = (s, i) => (i < s.length ? s.charCodeAt(i) : 0);
  for (; at(P, p) !== 0; t++, p++) {
    let pCh = at(P, p);
    let tCh = at(T, t);
    let matched, matchSlash, negated, prevCh;
    if (tCh === 0 && pCh !== 42) return WM_ABORT_ALL;
    if ((flags & WM_CASEFOLD) && isUpper(tCh)) tCh = lower(tCh);
    if ((flags & WM_CASEFOLD) && isUpper(pCh)) pCh = lower(pCh);
    switch (pCh) {
      case 92: // '\\'
        pCh = at(P, ++p);
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
      default:
        if (tCh !== pCh) return WM_NOMATCH;
        continue;
      case 63: // '?'
        if ((flags & WM_PATHNAME) && tCh === 47) return WM_NOMATCH;
        continue;
      case 42: { // '*'
        if (at(P, ++p) === 42) {
          const prevP = p - 2;
          while (at(P, ++p) === 42) { /* skip */ }
          if ((prevP < pat0 || at(P, prevP) === 47) &&
              (at(P, p) === 0 || at(P, p) === 47 || (at(P, p) === 92 && at(P, p + 1) === 47))) {
            if (at(P, p) === 47 && dowild(P, T, p + 1, t, flags) === WM_MATCH) return WM_MATCH;
            matchSlash = 1;
          } else matchSlash = 0;
        } else matchSlash = (flags & WM_PATHNAME) ? 0 : 1;
        if (at(P, p) === 0) {
          if (!matchSlash && T.indexOf("/", t) >= 0) return WM_NOMATCH;
          return WM_MATCH;
        } else if (!matchSlash && at(P, p) === 47) {
          const slash = T.indexOf("/", t);
          if (slash < 0) return WM_NOMATCH;
          t = slash;
          break; // the slash is consumed by the loop
        }
        for (;;) {
          if (tCh === 0) break;
          if (!isGlobSpecial(at(P, p))) {
            let pc = at(P, p);
            if ((flags & WM_CASEFOLD) && isUpper(pc)) pc = lower(pc);
            while ((tCh = at(T, t)) !== 0 && (matchSlash || tCh !== 47)) {
              if ((flags & WM_CASEFOLD) && isUpper(tCh)) tCh = lower(tCh);
              if (tCh === pc) break;
              t++;
            }
            if (tCh !== pc) return matchSlash ? WM_ABORT_ALL : WM_ABORT_TO_STARSTAR;
          }
          matched = dowild(P, T, p, t, flags);
          if (matched !== WM_NOMATCH) {
            if (!matchSlash || matched !== WM_ABORT_TO_STARSTAR) return matched;
          } else if (!matchSlash && tCh === 47) return WM_ABORT_TO_STARSTAR;
          tCh = at(T, ++t);
        }
        return WM_ABORT_ALL;
      }
      case 91: { // '['
        pCh = at(P, ++p);
        if (pCh === 94) pCh = 33; // '^' -> '!'
        negated = pCh === 33 ? 1 : 0;
        if (negated) pCh = at(P, ++p);
        prevCh = 0;
        matched = 0;
        do {
          if (!pCh) return WM_ABORT_ALL;
          if (pCh === 92) {
            pCh = at(P, ++p);
            if (!pCh) return WM_ABORT_ALL;
            if (tCh === pCh) matched = 1;
          } else if (pCh === 45 && prevCh && at(P, p + 1) && at(P, p + 1) !== 93) {
            pCh = at(P, ++p);
            if (pCh === 92) { pCh = at(P, ++p); if (!pCh) return WM_ABORT_ALL; }
            if (tCh <= pCh && tCh >= prevCh) matched = 1;
            else if ((flags & WM_CASEFOLD) && isLower(tCh)) {
              const tu = upper(tCh);
              if (tu <= pCh && tu >= prevCh) matched = 1;
            }
            pCh = 0;
          } else if (pCh === 91 && at(P, p + 1) === 58) {
            p += 2;
            const s = p;
            while ((pCh = at(P, p)) && pCh !== 93) p++;
            if (!pCh) return WM_ABORT_ALL;
            const i = p - s - 1;
            if (i < 0 || at(P, p - 1) !== 58) {
              p = s - 2;
              pCh = 91;
              if (tCh === pCh) matched = 1;
              prevCh = pCh;
              pCh = at(P, ++p);
              if (pCh === 93) break;
              continue;
            }
            const name = P.slice(s, s + i);
            const fn = CLASSES[name];
            if (!fn) return WM_ABORT_ALL;
            if (name === "upper" && (flags & WM_CASEFOLD)) { if (isUpper(tCh) || isLower(tCh)) matched = 1; }
            else if (fn(tCh)) matched = 1;
            pCh = 0;
          } else if (tCh === pCh) matched = 1;
          prevCh = pCh;
          pCh = at(P, ++p);
        } while (pCh !== 93);
        if (matched === negated || ((flags & WM_PATHNAME) && tCh === 47)) return WM_NOMATCH;
        continue;
      }
    }
  }
  return t < T.length ? WM_NOMATCH : WM_MATCH;
}

/** True when `text` matches `pattern` under git's wildmatch rules. */
export function wildmatch(pattern, text, flags = 0) {
  return dowild(pattern, text, 0, 0, flags) === WM_MATCH;
}

/** Characters before the first glob special (git's simple_length). */
export function simpleLength(s) {
  for (let i = 0; i < s.length; i++) if (isGlobSpecial(s.charCodeAt(i))) return i;
  return s.length;
}

export const hasWildcard = (s) => simpleLength(s) < s.length;

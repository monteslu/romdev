// Python pathlib.PurePosixPath / os.path semantics on plain strings.
//
// splat builds every output path (and many strings written into outputs,
// like `.incbin "..."` and INCLUDE_ASM paths) from pathlib objects, so the
// exact normalisation rules matter: "." parts vanish, ".." parts stay,
// Path("") is ".", joining an absolute path replaces the left side.
// Filesystem access goes through runtime.abs(), which resolves a (possibly
// relative) Python-style path against the run's virtual cwd.

/** Normalise like pathlib's parser: drop "" and "." parts, keep "..". */
export function P(...parts) {
  let abs = false;
  let segs = [];
  for (const partRaw of parts) {
    if (partRaw == null) throw new TypeError('path part is null');
    const part = String(partRaw);
    if (part.startsWith('/')) { abs = true; segs = []; }
    for (const s of part.split('/')) {
      if (s === '' || s === '.') continue;
      segs.push(s);
    }
  }
  if (abs) return '/' + segs.join('/');
  return segs.length ? segs.join('/') : '.';
}

/** os.path.normpath (posix). */
export function normpath(p) {
  p = String(p);
  if (p === '') return '.';
  const initialSlashes = p.startsWith('//') && !p.startsWith('///') ? 2 : (p.startsWith('/') ? 1 : 0);
  const comps = p.split('/');
  const out = [];
  for (const c of comps) {
    if (c === '' || c === '.') continue;
    if (c !== '..' || (!initialSlashes && out.length === 0) || (out.length && out[out.length - 1] === '..')) {
      out.push(c);
    } else if (out.length) {
      out.pop();
    }
  }
  let r = out.join('/');
  if (initialSlashes) r = '/'.repeat(initialSlashes) + r;
  return r || '.';
}

export function isAbs(p) { return String(p).startsWith('/'); }

export function name(p) {
  p = P(p);
  if (p === '.' || p === '/') return '';
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function parent(p) {
  p = P(p);
  if (p === '.' || p === '/') return p;
  const i = p.lastIndexOf('/');
  if (i === -1) return '.';
  if (i === 0) return '/';
  return p.slice(0, i);
}

/** PurePath.suffix (CPython 3.12 rule: a leading dot is not a suffix, nor a trailing one). */
export function suffix(p) {
  const n = name(p);
  const i = n.lastIndexOf('.');
  if (0 < i && i < n.length - 1) return n.slice(i);
  return '';
}

export function suffixes(p) {
  const n = name(p);
  if (n.endsWith('.')) return [];
  const stripped = n.replace(/^\.+/, '');
  const parts = stripped.split('.').slice(1);
  return parts.map((s) => '.' + s);
}

export function stem(p) {
  const n = name(p);
  const s = suffix(p);
  return s ? n.slice(0, -s.length) : n;
}

export function withSuffix(p, suf) {
  if (suf && (!suf.startsWith('.') || suf === '.')) throw new Error(`Invalid suffix ${suf}`);
  const n = name(p);
  if (!n) throw new Error(`${p} has an empty name`);
  const s = suffix(p);
  const newName = (s ? n.slice(0, -s.length) : n) + suf;
  const par = parent(p);
  return par === '.' ? newName : P(par, newName);
}

/** PurePath.relative_to (no ".." walking); throws like ValueError. */
export function relativeTo(p, base) {
  p = P(p); base = P(base);
  if (base === '.') {
    if (isAbs(p)) throw new Error(`${p} is not in the subpath of ${base}`);
    return p;
  }
  if (p === base) return '.';
  const prefix = base === '/' ? '/' : base + '/';
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  throw new Error(`${p} is not in the subpath of ${base}`);
}

/** os.path.relpath(path, start) with both resolved against cwd. */
export function relpath(path, start, cwd) {
  const a = normpath(isAbs(path) ? path : cwd + '/' + path);
  const b = normpath(isAbs(start) ? start : cwd + '/' + start);
  const as = a.split('/').filter(Boolean);
  const bs = b.split('/').filter(Boolean);
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  const rel = [...Array(bs.length - i).fill('..'), ...as.slice(i)];
  return rel.length ? rel.join('/') : '.';
}

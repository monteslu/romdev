// Per-run state that Python splat keeps in the process: the working
// directory (virtual here: nothing ever calls process.chdir), the splat
// behaviour version, and the output streams.

import fs from 'node:fs';
import nodePath from 'node:path';
import { isAbs, normpath } from './util/pypath.js';

export class SplatError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'SplatError';
    this.exitCode = exitCode;
  }
}

export const rt = {
  cwd: '/',
  /** splat version whose behaviour is reproduced, [major, minor, patch]. */
  version: [0, 37, 1],
  /** (stream: 'stdout'|'stderr', text) sink; text includes its trailing newline. */
  sink: null,
};

export function atLeast(v) {
  const want = String(v).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = rt.version[i] || 0; const b = want[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function abs(p) {
  p = String(p);
  return isAbs(p) ? p : nodePath.join(rt.cwd, p);
}

export function exists(p) { return fs.existsSync(abs(p)); }
export function isFile(p) {
  try { return fs.statSync(abs(p)).isFile(); } catch { return false; }
}

/** Python text-mode read (UTF-8, universal newlines). */
export function readText(p) {
  return fs.readFileSync(abs(p), 'utf8').replace(/\r\n?/g, '\n');
}

export function readBytes(p) { return fs.readFileSync(abs(p)); }

export function mkdirp(dir) { fs.mkdirSync(abs(dir), { recursive: true }); }

/** Python open(p, "w", newline=nl).write(text). newline null/undefined/"" = no translation on posix. */
export function writeText(p, text, newline = '\n') {
  let out = text;
  if (newline && newline !== '\n') out = text.replace(/\n/g, newline);
  fs.writeFileSync(abs(p), out, 'utf8');
}

export function writeBytes(p, bytes) { fs.writeFileSync(abs(p), bytes); }

/** A Python text file object opened for writing: collects write() calls. */
export class TextFile {
  constructor(p, newline = '\n') { this.path = p; this.newline = newline; this.parts = []; }
  write(s) { this.parts.push(s); return s.length; }
  close() { writeText(this.path, this.parts.join(''), this.newline); }
}

/** Python pathlib.Path.resolve(): absolute, symlinks resolved where they exist. */
export function resolvePath(p) {
  const a = normpath(abs(p));
  // Resolve the longest existing prefix, then append the rest.
  const parts = a.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const head = '/' + parts.slice(0, i).join('/');
    let real;
    try { real = fs.realpathSync(head); } catch { continue; }
    const rest = parts.slice(i);
    return normpath(rest.length ? real + '/' + rest.join('/') : real);
  }
  return a;
}

export function print(...args) {
  emit('stdout', args.map(String).join(' ') + '\n');
}

export function emit(stream, text) {
  if (rt.sink) rt.sink(stream, text);
}

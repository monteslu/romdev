// splat.util.log: status-coloured messages; error() stops the run.
import { emit, SplatError } from '../runtime.js';
import { pyStr } from './pyfmt.js';

const ANSI = {
  ok: '\x1b[32m',
  warn: '\x1b[33m\x1b[1m',
  error: '\x1b[31m\x1b[1m',
  skip: '\x1b[2m',
};

export function write(msg, { status = null } = {}) {
  const stream = status === 'warn' || status === 'error' ? 'stderr' : 'stdout';
  emit(stream, (ANSI[status] || '') + pyStr(msg) + '\n');
}

export function error(msg) {
  write(msg, { status: 'error' });
  throw new SplatError(pyStr(msg), 2);
}

// line_num is zero-indexed
export function parsingErrorPreamble(path, lineNum, line) {
  write('');
  write(`error reading ${path}, line ${lineNum + 1}:`, { status: 'error' });
  write(`\t${line}`);
}

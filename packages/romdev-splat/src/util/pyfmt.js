// Python formatting and conversion helpers.
import { PyFloat } from './yaml11.js';

/** f"{v:X}" / f"{v:0{width}X}" */
export function hex(v, width = 0) {
  if (typeof v !== 'number' && typeof v !== 'bigint') throw new TypeError(`cannot hex-format ${v}`);
  const neg = v < 0;
  let s = (neg ? -v : v).toString(16).toUpperCase();
  if (s.length < width - (neg ? 1 : 0)) s = s.padStart(width - (neg ? 1 : 0), '0');
  return (neg ? '-' : '') + s;
}

/** f"{v:x}" */
export function hexl(v, width = 0) { return hex(v, width).toLowerCase(); }

/** Python hex(v) */
export function pyHex(v) { return (v < 0 ? '-0x' : '0x') + Math.abs(v).toString(16); }

export function isInt(v) { return typeof v === 'number' && Number.isInteger(v) || typeof v === 'boolean'; }
export function isPyInt(v) { return (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'boolean'; }
export function isStr(v) { return typeof v === 'string'; }
export function isDict(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PyFloat); }
export function isList(v) { return Array.isArray(v); }

/** Python int(v) for the value kinds splat feeds it. */
export function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  if (v instanceof PyFloat) return Math.trunc(v.value);
  if (typeof v === 'string') {
    const s = v.trim().replace(/_/g, '');
    if (!/^[-+]?\d+$/.test(s)) throw new Error(`invalid literal for int() with base 10: '${v}'`);
    return parseInt(s, 10);
  }
  throw new TypeError(`int() argument must be a string or a number, not '${pyTypeName(v)}'`);
}

/** Python int(s, 0). */
export function pyInt0(s) {
  const t = String(s).trim();
  const m = /^([-+]?)(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|0+|[1-9][0-9_]*)$/.exec(t);
  if (!m || /__|_$|^[-+]?_/.test(m[2]) || /^0[xXoObB]_*$/.test(m[2])) {
    throw new Error(`invalid literal for int() with base 0: '${s}'`);
  }
  const body = m[2].replace(/_/g, '');
  let v;
  if (/^0[xX]/.test(body)) v = parseInt(body.slice(2), 16);
  else if (/^0[oO]/.test(body)) v = parseInt(body.slice(2), 8);
  else if (/^0[bB]/.test(body)) v = parseInt(body.slice(2), 2);
  else v = parseInt(body, 10);
  return m[1] === '-' ? -v : v;
}

export function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (v instanceof PyFloat) return 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/** Python str(v) for the values splat prints. */
export function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (Array.isArray(v) || (typeof v === 'object' && v.constructor === Object)) return pyRepr(v);
  if (v instanceof Set) return pyRepr(v);
  return String(v);
}

function pyFloatRepr(f) {
  if (Number.isInteger(f)) return f.toFixed(1);
  if (f === Infinity) return 'inf';
  if (f === -Infinity) return '-inf';
  if (Number.isNaN(f)) return 'nan';
  return String(f);
}

export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let s = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    if (q === "'") s = s.replace(/'/g, "\\'");
    return q + s + q;
  }
  if (typeof v === 'number') return String(v);
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (v instanceof Set) return v.size ? '{' + [...v].map(pyRepr).join(', ') + '}' : 'set()';
  if (typeof v === 'object') {
    return '{' + Object.entries(v).map(([k, x]) => pyRepr(k) + ': ' + pyRepr(x)).join(', ') + '}';
  }
  return String(v);
}

/** str.ljust */
export function ljust(s, n) { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

/** Python bool(v) truthiness. */
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (v instanceof PyFloat) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Set || v instanceof Map) return v.size > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** f"{n:5}" for ints (right aligned). */
export function rjust(v, n) { const s = String(v); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

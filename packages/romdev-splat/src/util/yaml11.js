// YAML loading with PyYAML SafeLoader semantics (YAML 1.1 implicit typing,
// merge keys, shared aliases, last-duplicate-key-wins).
//
// The `yaml` package parses the document structure (failsafe schema, so every
// scalar arrives as its source string); this module then resolves plain
// scalars with PyYAML's own implicit resolver regexes and constructors
// (yaml/resolver.py + yaml/constructor.py SafeConstructor).

import { parseDocument, isMap, isSeq, isScalar, isAlias } from 'yaml';

/** A YAML float (Python float), kept distinct from ints. */
export class PyFloat {
  constructor(value) { this.value = value; }
  valueOf() { return this.value; }
  toString() { return String(this.value); }
}

const RE_BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const RE_FLOAT = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const RE_INT = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const RE_MERGE = /^(?:<<)$/;
const RE_NULL = /^(?:~|null|Null|NULL|)$/;
const RE_TIMESTAMP = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;

// PyYAML registers resolvers per first character; the lists are checked in
// registration order (bool, float, int, merge, null, timestamp).
const RESOLVERS = [
  ['bool', RE_BOOL, 'yYnNtTfFoO'],
  ['float', RE_FLOAT, '-+0123456789.'],
  ['int', RE_INT, '-+0123456789'],
  ['merge', RE_MERGE, '<'],
  ['null', RE_NULL, '~nN\0'],
  ['timestamp', RE_TIMESTAMP, '0123456789'],
];

function resolvePlain(value) {
  const first = value === '' ? '\0' : value[0];
  for (const [kind, re, firsts] of RESOLVERS) {
    if (!firsts.includes(first)) continue;
    if (re.test(value)) return kind;
  }
  return 'str';
}

function constructInt(src) {
  let value = src.replace(/_/g, '');
  let sign = 1n;
  if (value[0] === '-') sign = -1n;
  if ('+-'.includes(value[0])) value = value.slice(1);
  let big;
  if (value === '0') big = 0n;
  else if (value.startsWith('0b')) big = BigInt('0b' + value.slice(2));
  else if (value.startsWith('0x')) big = BigInt('0x' + value.slice(2));
  else if (value[0] === '0') big = BigInt('0o' + value.slice(1));
  else if (value.includes(':')) {
    const digits = value.split(':').map((d) => BigInt(d)).reverse();
    let base = 1n; big = 0n;
    for (const d of digits) { big += d * base; base *= 60n; }
  } else big = BigInt(value);
  const r = sign * big;
  if (r > BigInt(Number.MAX_SAFE_INTEGER) || r < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`YAML integer ${src} exceeds the safe integer range`);
  }
  return Number(r);
}

function constructFloat(src) {
  let value = src.replace(/_/g, '').toLowerCase();
  let sign = 1;
  if (value[0] === '-') sign = -1;
  if ('+-'.includes(value[0])) value = value.slice(1);
  if (value === '.inf') return new PyFloat(sign * Infinity);
  if (value === '.nan') return new PyFloat(NaN);
  if (value.includes(':')) {
    const digits = value.split(':').map((d) => parseFloat(d)).reverse();
    let base = 1; let r = 0;
    for (const d of digits) { r += d * base; base *= 60; }
    return new PyFloat(sign * r);
  }
  return new PyFloat(sign * parseFloat(value));
}

function constructBool(src) {
  return { yes: true, no: false, true: true, false: false, on: true, off: false }[src.toLowerCase()];
}

const TAG = 'tag:yaml.org,2002:';

function scalarValue(node) {
  const src = node.value == null ? '' : String(node.value);
  let kind;
  if (node.tag && node.tag !== '!') {
    const t = node.tag.startsWith(TAG) ? node.tag.slice(TAG.length) : node.tag;
    kind = t;
  } else if (node.type === 'PLAIN' && node.tag !== '!') {
    kind = resolvePlain(src);
  } else {
    kind = 'str';
  }
  switch (kind) {
    case 'str': return src;
    case 'int': return constructInt(src);
    case 'float': return constructFloat(src);
    case 'bool': return constructBool(src);
    case 'null': return null;
    case 'merge': return MERGE_KEY;
    case 'timestamp': return src;
    default: throw new Error(`unsupported YAML tag ${node.tag}`);
  }
}

const MERGE_KEY = Symbol('merge');

/** Python-dict-like key used for JS object properties. */
function keyString(k) {
  if (k === null) return 'None';
  if (k === true) return 'True';
  if (k === false) return 'False';
  if (k instanceof PyFloat) return String(k.value);
  return String(k);
}

function convert(node, doc, anchors) {
  if (node == null) return null;
  if (isAlias(node)) {
    if (!anchors.has(node.source)) throw new Error(`found undefined alias ${node.source}`);
    return anchors.get(node.source);
  }
  if (isScalar(node)) {
    const v = scalarValue(node);
    if (node.anchor) anchors.set(node.anchor, v);
    return v;
  }
  if (isSeq(node)) {
    const out = [];
    if (node.anchor) anchors.set(node.anchor, out);
    for (const it of node.items) out.push(convert(it, doc, anchors));
    return out;
  }
  if (isMap(node)) {
    const out = {};
    if (node.anchor) anchors.set(node.anchor, out);
    // PyYAML flatten_mapping: merge entries are collected first (a list merges
    // each map in order, earlier maps winning), then explicit keys override.
    const merged = [];
    const explicit = [];
    for (const pair of node.items) {
      const kNode = pair.key;
      const isMergeKey = isScalar(kNode) && kNode.type === 'PLAIN' && !kNode.tag && kNode.value === '<<';
      if (isMergeKey) {
        const val = convert(pair.value, doc, anchors);
        const maps = Array.isArray(val) ? val : [val];
        const submerge = [];
        for (const m of maps) {
          if (m === null || typeof m !== 'object' || Array.isArray(m)) {
            throw new Error('expected a mapping or list of mappings for merging');
          }
          submerge.push(Object.entries(m));
        }
        // PyYAML: submerge.reverse(); for value in submerge: merge.extend(value)
        submerge.reverse();
        for (const e of submerge) merged.push(...e);
      } else {
        const k = convert(kNode, doc, anchors);
        explicit.push([keyString(k), convert(pair.value, doc, anchors)]);
      }
    }
    for (const [k, v] of merged) out[k] = v;
    for (const [k, v] of explicit) out[k] = v;
    return out;
  }
  throw new Error('unsupported YAML node');
}

/** Parse one YAML document with PyYAML SafeLoader semantics. */
export function loadYaml(text) {
  const doc = parseDocument(text, {
    schema: 'failsafe', uniqueKeys: false, merge: false, version: '1.1', strict: false, prettyErrors: false,
  });
  if (doc.errors && doc.errors.length) throw doc.errors[0];
  return convert(doc.contents, doc, new Map());
}

export const _internals = { resolvePlain, constructInt };

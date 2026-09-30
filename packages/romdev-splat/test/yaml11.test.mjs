import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadYaml, PyFloat } from '../src/util/yaml11.js';

test('YAML 1.1 implicit scalars follow PyYAML SafeLoader', () => {
  const y = loadYaml(`
hex: 0x80000400
hexu: 0x8000_0400
oct: 017
dec: 1_000
zero: 0
neg: -12
bin: 0b1010
sexa: 1:30
notint: 08
float: 1.5
floatexp: 1.0e+3
notfloat: 1e5
inf: .inf
yes: yes
No: No
on: ON
off: off
y: y
n: n
null1: ~
null2: null
empty:
str: "0x10"
single: '017'
text: hello world
`);
  assert.equal(y.hex, 0x80000400);
  assert.equal(y.hexu, 0x80000400);
  assert.equal(y.oct, 15);
  assert.equal(y.dec, 1000);
  assert.equal(y.zero, 0);
  assert.equal(y.neg, -12);
  assert.equal(y.bin, 10);
  assert.equal(y.sexa, 90);
  assert.equal(y.notint, '08');
  assert.ok(y.float instanceof PyFloat);
  assert.equal(y.float.value, 1.5);
  assert.equal(y.floatexp.value, 1000);
  assert.equal(y.notfloat, '1e5');
  assert.equal(y.inf.value, Infinity);
  // keys go through the same resolver: `yes`/`on`/`off` keys become True/False
  assert.equal(y.True, true);
  assert.equal(y.False, false);
  assert.equal(y.y, 'y');
  assert.equal(y.n, 'n');
  assert.equal(y.null1, null);
  assert.equal(y.null2, null);
  assert.equal(y.empty, null);
  assert.equal(y.str, '0x10');
  assert.equal(y.single, '017');
  assert.equal(y.text, 'hello world');
});

test('merge keys: explicit keys win, earlier merged maps win over later ones', () => {
  const y = loadYaml(`
a: &a {x: 1, y: 2}
b: &b {y: 3, z: 4}
c:
  <<: [*a, *b]
  x: 9
d:
  <<: *b
`);
  assert.deepEqual(y.c, { x: 9, y: 2, z: 4 });
  assert.deepEqual(y.d, { y: 3, z: 4 });
  // aliases share the object, as PyYAML does
  assert.equal(y.d.y, 3);
});

test('aliases resolve to the same object and duplicate keys keep the last value', () => {
  const y = loadYaml('a: &l [1, 2]\nb: *l\nk: 1\nk: 2\n');
  assert.equal(y.a, y.b);
  assert.equal(y.k, 2);
});

test('segment list entries keep their shapes', () => {
  const y = loadYaml(`
segments:
  - [0x1000, c, boot/main]
  - { type: bss, vram: 0x80001000, name: heap }
  - [auto, .data, x]
  - [0x2000]
`);
  assert.deepEqual(y.segments[0], [0x1000, 'c', 'boot/main']);
  assert.deepEqual(y.segments[1], { type: 'bss', vram: 0x80001000, name: 'heap' });
  assert.deepEqual(y.segments[2], ['auto', '.data', 'x']);
  assert.deepEqual(y.segments[3], [0x2000]);
});

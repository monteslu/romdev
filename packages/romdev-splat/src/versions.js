// Which splat / spimdisasm / rabbitizer versions a project pins.
//
// splat behaviour is reproduced for the versions romdev's targets use:
// 0.37.1 (default) and 0.34.1. spimdisasm/rabbitizer versions are passed to
// the disassembler backend.
import fs from 'node:fs';
import path from 'node:path';

export const SUPPORTED_SPLAT_VERSIONS = ['0.34.1', '0.37.1'];
export const DEFAULT_SPLAT_VERSION = '0.37.1';

function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function fromUvLock(text) {
  const out = {};
  const re = /\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g;
  for (const m of text.matchAll(re)) out[m[1]] = m[2];
  return out;
}

function fromRequirements(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([0-9][^\s;#]*)/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function fromVenv(dir) {
  const out = {};
  const lib = path.join(dir, '.venv', 'lib');
  let pys = [];
  try { pys = fs.readdirSync(lib).filter((d) => d.startsWith('python')); } catch { return out; }
  for (const py of pys) {
    const sp = path.join(lib, py, 'site-packages');
    let names = [];
    try { names = fs.readdirSync(sp); } catch { continue; }
    for (const n of names) {
      const m = /^([A-Za-z0-9_.]+)-([0-9][^-]*)\.dist-info$/.exec(n);
      if (m) out[m[1].toLowerCase().replace(/_/g, '-')] = m[2];
    }
  }
  return out;
}

/**
 * Detect the pinned versions for a project checkout. Sources, first match
 * wins per package: uv.lock, tools/requirements-python.txt,
 * requirements.txt, a vendored tools/splat/src/splat/__init__.py, then the
 * project's .venv (installed dist-info). Returns {splat, spimdisasm,
 * rabbitizer, n64img, sources}; missing entries are null.
 */
export function detectProjectVersions(projectDir) {
  const found = { splat: null, spimdisasm: null, rabbitizer: null, n64img: null };
  const sources = {};
  const take = (map, src) => {
    const pick = (key, names) => {
      if (found[key]) return;
      for (const n of names) {
        if (map[n]) { found[key] = map[n]; sources[key] = src; return; }
      }
    };
    pick('splat', ['splat64']);
    pick('spimdisasm', ['spimdisasm']);
    pick('rabbitizer', ['rabbitizer']);
    pick('n64img', ['n64img']);
  };
  const uv = readIf(path.join(projectDir, 'uv.lock'));
  if (uv) take(fromUvLock(uv), 'uv.lock');
  for (const req of ['tools/requirements-python.txt', 'requirements.txt']) {
    const t = readIf(path.join(projectDir, req));
    if (t) take(fromRequirements(t), req);
  }
  const vendored = readIf(path.join(projectDir, 'tools/splat/src/splat/__init__.py'));
  if (vendored && !found.splat) {
    const m = /__version__\s*=\s*"([^"]+)"/.exec(vendored);
    if (m) { found.splat = m[1]; sources.splat = 'tools/splat/src/splat/__init__.py'; }
  }
  take(fromVenv(projectDir), '.venv');
  return { ...found, sources };
}

export function parseVersion(v) {
  const s = String(v);
  if (!SUPPORTED_SPLAT_VERSIONS.includes(s)) {
    throw new Error(`romdev-splat reproduces splat ${SUPPORTED_SPLAT_VERSIONS.join(' and ')}; ${s} is not supported`);
  }
  return s.split('.').map(Number);
}

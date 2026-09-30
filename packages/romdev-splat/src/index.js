// romdev-splat: a JavaScript port of splat (https://github.com/ethteck/splat),
// the binary splitting tool used by N64/PS1 decompilation projects.
//
//   import { split } from 'romdev-splat';
//   const r = await split(['config/us/game.us.yaml'], { cwd: '/path/to/project' });
//
// Runs never touch process.cwd(): relative config paths, and every relative
// path splat derives from them, resolve against `cwd`.
import path from 'node:path';
import { rt, SplatError } from './runtime.js';
import { main } from './split.js';
import { loadBackend, setBackend } from './disassembler/spim.js';
import { DEFAULT_SPLAT_VERSION, detectProjectVersions, parseVersion, SUPPORTED_SPLAT_VERSIONS } from './versions.js';
import { extensionReport, PORTED_EXTENSIONS } from './ext/index.js';

export { detectProjectVersions, SUPPORTED_SPLAT_VERSIONS, DEFAULT_SPLAT_VERSION, PORTED_EXTENSIONS, SplatError };

let queue = Promise.resolve();

/**
 * Run `splat split`.
 *
 * @param {string|string[]} configPaths yaml config(s), merged in order (relative to `cwd`).
 * @param {object} [o]
 * @param {string[]} [o.modes] default ['all'].
 * @param {boolean} [o.verbose]
 * @param {boolean} [o.useCache]  --use-cache
 * @param {boolean} [o.skipVersionCheck]
 * @param {boolean} [o.stdoutOnly]
 * @param {boolean} [o.disassembleAll]
 * @param {boolean} [o.makeFullDisasmForCode]
 * @param {string} [o.cwd] directory the invocation runs from (default process.cwd(), read only).
 * @param {string} [o.basePath] overrides the resolved `base_path` option.
 * @param {string} [o.splatVersion] '0.37.1' (default) or '0.34.1'; 'auto' reads the project's pins.
 * @param {string} [o.spimdisasmVersion] backend version; 'auto' reads the project's pins.
 * @param {string} [o.projectDir] where 'auto' looks for pins (default cwd).
 * @param {object} [o.backend] {spimdisasm, rabbitizer} to use instead of romdev-spimdisasm.
 * @param {(stream: 'stdout'|'stderr', text: string) => void} [o.onOutput]
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, error:Error|null,
 *   splatVersion:string, spimdisasmVersion:string|null, extensions:object[]}>}
 */
export function split(configPaths, o = {}) {
  const run = queue.then(() => runSplit(configPaths, o));
  queue = run.catch(() => {});
  return run;
}

async function runSplit(configPaths, o) {
  const cwd = path.resolve(o.cwd || process.cwd());
  const projectDir = o.projectDir ? path.resolve(cwd, o.projectDir) : cwd;
  let splatVersion = o.splatVersion || DEFAULT_SPLAT_VERSION;
  let spimdisasmVersion = o.spimdisasmVersion || (splatVersion === 'auto' ? 'auto' : null);
  if (splatVersion === 'auto' || spimdisasmVersion === 'auto') {
    const pins = detectProjectVersions(projectDir);
    if (splatVersion === 'auto') splatVersion = pins.splat || DEFAULT_SPLAT_VERSION;
    if (spimdisasmVersion === 'auto') spimdisasmVersion = pins.spimdisasm;
  }
  const version = parseVersion(splatVersion);

  const stdout = [];
  const stderr = [];
  const prev = { cwd: rt.cwd, version: rt.version, sink: rt.sink };
  rt.cwd = cwd;
  rt.version = version;
  rt.sink = (stream, text) => {
    (stream === 'stderr' ? stderr : stdout).push(text);
    if (o.onOutput) o.onOutput(stream, text);
  };
  extensionReport.length = 0;
  let exitCode = 0;
  let error = null;
  try {
    const backend = o.backend || await loadBackend({ spimdisasmVersion });
    setBackend(backend);
    const paths = (Array.isArray(configPaths) ? configPaths : [configPaths]).map(String);
    main(paths, o.modes && o.modes.length ? o.modes : null, !!o.verbose, !!o.useCache, !!o.skipVersionCheck,
      !!o.stdoutOnly, !!o.disassembleAll, !!o.makeFullDisasmForCode, { basePath: o.basePath ?? null });
  } catch (e) {
    error = e;
    exitCode = e instanceof SplatError ? e.exitCode : 1;
    if (!(e instanceof SplatError)) rt.sink('stderr', `${e && e.stack ? e.stack : e}\n`);
  } finally {
    rt.cwd = prev.cwd;
    rt.version = prev.version;
    rt.sink = prev.sink;
  }
  return {
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    error,
    splatVersion,
    spimdisasmVersion,
    extensions: [...extensionReport],
  };
}

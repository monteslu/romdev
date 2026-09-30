// Access to the disassembler backend (romdev-spimdisasm, a 1:1 port of the
// Python spimdisasm module, and romdev-rabbitizer). Loaded lazily so the
// parts of splat that never disassemble work without them, and so a caller
// can inject a backend (tests).
//
// Python splat runs in a fresh process, so spimdisasm's GlobalConfig and
// rabbitizer's config start from their defaults every time. Here they are
// process globals shared by every run: each run re-selects the spimdisasm
// version (which resets GlobalConfig) and restores rabbitizer's config to the
// values it had when its WASM module was first loaded.

let backend = null;
const rabbitizerDefaults = new Map(); // rabbitizer module -> {name: value}

const DEFAULT_SPIMDISASM = '1.42.4';

function snapshotConfig(rab) {
  if (rabbitizerDefaults.has(rab)) return;
  const snap = {};
  for (const k of Object.keys(rab.config)) snap[k] = rab.config[k];
  rabbitizerDefaults.set(rab, snap);
}

function restoreConfig(rab) {
  const snap = rabbitizerDefaults.get(rab);
  if (!snap) return;
  for (const [k, v] of Object.entries(snap)) rab.config[k] = v;
}

/** Load (or reuse) romdev-spimdisasm configured for `spimdisasmVersion`. */
export async function loadBackend({ spimdisasmVersion = null } = {}) {
  const spimdisasm = await import('romdev-spimdisasm');
  const rabMod = await import('romdev-rabbitizer');
  const version = spimdisasmVersion || DEFAULT_SPIMDISASM;
  if (!spimdisasm.SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`romdev-spimdisasm does not reproduce spimdisasm ${version} (supported: ${spimdisasm.SUPPORTED_VERSIONS.join(', ')})`);
  }
  const rabVersion = spimdisasm.RABBITIZER_VERSION_FOR[version];
  const rab = rabMod.loadRabbitizerSync(rabVersion);
  snapshotConfig(rab);
  restoreConfig(rab);
  spimdisasm.setRabbitizer(rab);
  spimdisasm.configureVersion(version);
  return { spimdisasm, rabbitizer: rab, spimdisasmVersion: version, rabbitizerVersion: rabVersion };
}

export function setBackend(b) { backend = b; }
export function getBackend() { return backend; }

export function spim() {
  if (!backend) throw new Error('splat: no disassembler backend loaded');
  return backend.spimdisasm;
}

export function rabbitizer() {
  if (!backend) throw new Error('splat: no disassembler backend loaded');
  return backend.rabbitizer;
}

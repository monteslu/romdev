// Which GPU this server renders on, and proof of where GPU work really went.
//
// A machine with two GPUs (a discrete card driving the displays, an integrated
// one for tests) must keep agent GPU work off the display GPU: a cart hammering
// the GPU the compositor runs on can stall or wedge the desktop. The pin names
// one GPU by PCI address:
//
//   ROMDEV_GPU=0000:69:00.0            (environment), else
//   $XDG_CONFIG_HOME/romdev/gpu        (one line, the same address)
//
// applyGpuPin() runs before any GPU library loads and points every API at it:
//   Vulkan (Dawn, so WebGPU)  MESA_VK_DEVICE_SELECT=<vendor>:<device> and
//                             MESA_VK_DEVICE_SELECT_FORCE_DEFAULT_DEVICE=1
//                             (Mesa's device-select layer offers only that GPU)
//   GL (EGL through Mesa)     DRI_PRIME=pci-<address>
//   wasmcart's adapter        WASMCART_WGPU_POWER, the pinned GPU's class
//                             (integrated: low-power, discrete: high-performance)
// Variables the environment already sets win, so an operator can still steer.
//
// The pin is a request. What the drivers did is read back from the kernel:
// every DRM file descriptor the process holds names its PCI device
// (/proc/<pid>/fdinfo drm-pdev) and the GPU engine time its client has used
// (drm-engine-gfx, nanoseconds). drmUsage() sums them per device, so a timing
// run can say which GPU did its work, not which one it asked for.
//
// Plain JS ESM + JSDoc. Linux only where it reads sysfs and procfs; elsewhere
// every reader returns null and the pin is a no-op.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PCI_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i;

/** @type {null | {pci:string, vendorId:string, deviceId:string, discrete:boolean, power:string, source:string, card:string|null, env:Record<string,string>}} */
let _pin = null;
let _pinError = null;

function readText(f) {
  try { return fs.readFileSync(f, "utf8").trim(); } catch { return null; }
}

function configPin() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const v = readText(path.join(base, "romdev", "gpu"));
  return v ? { value: v.split(/\s+/)[0], source: path.join(base, "romdev", "gpu") } : null;
}

/** sysfs facts about a PCI GPU, or null when it is not there. */
export function pciGpu(pci) {
  const sys = `/sys/bus/pci/devices/${pci}`;
  const vendor = readText(`${sys}/vendor`), device = readText(`${sys}/device`);
  if (!vendor || !device) return null;
  const vram = Number(readText(`${sys}/mem_info_vram_total`) || 0);
  let card = null;
  try { card = fs.readdirSync(`${sys}/drm`).find((n) => /^card\d+$/.test(n)) || null; } catch { /* no DRM node */ }
  // An integrated GPU's VRAM is a carve-out of system RAM (0.5 to 2 GiB); a
  // discrete card has its own, gigabytes of it. amdgpu reports the size.
  const discrete = vram === 0 ? true : vram >= 3 * 2 ** 30;
  return { vendorId: vendor.replace(/^0x/, ""), deviceId: device.replace(/^0x/, ""), vramBytes: vram, discrete, card };
}

/**
 * Resolve the pin and set the GPU environment. Call before any GPU library
 * creates a context (the drivers read these variables at instance creation).
 * Idempotent.
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {typeof _pin}
 */
export function applyGpuPin({ log = () => {} } = {}) {
  if (_pin || _pinError) return _pin;
  let want = null, source = null;
  if (process.env.ROMDEV_GPU) { want = process.env.ROMDEV_GPU.trim(); source = "ROMDEV_GPU"; }
  else { const c = configPin(); if (c) { want = c.value; source = c.source; } }
  if (!want || want === "none") return null;
  if (!PCI_RE.test(want)) {
    _pinError = `GPU pin '${want}' (${source}) is not a PCI address like 0000:69:00.0`;
    log(`romdev: ${_pinError}; GPU not pinned`);
    return null;
  }
  const g = pciGpu(want);
  if (!g) {
    _pinError = `GPU pin ${want} (${source}): no such PCI device`;
    log(`romdev: ${_pinError}; GPU not pinned`);
    return null;
  }
  const env = {
    MESA_VK_DEVICE_SELECT: `${g.vendorId}:${g.deviceId}`,
    MESA_VK_DEVICE_SELECT_FORCE_DEFAULT_DEVICE: "1",
    DRI_PRIME: "pci-" + want.replace(/[:.]/g, "_"),
    WASMCART_WGPU_POWER: g.discrete ? "high-performance" : "low-power",
  };
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
  _pin = { pci: want.toLowerCase(), vendorId: g.vendorId, deviceId: g.deviceId, discrete: g.discrete,
    power: g.discrete ? "high-performance" : "low-power", source, card: g.card,
    env: Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])) };
  log(`romdev: GPU pinned to ${_pin.pci} (${_pin.vendorId}:${_pin.deviceId}, ${g.discrete ? "discrete" : "integrated"}) from ${source}`);
  return _pin;
}

/** The pin applyGpuPin() set, or {pinned:false, reason}. */
export function gpuPinInfo() {
  if (_pin) return { pinned: true, ..._pin };
  return { pinned: false, reason: _pinError || "no GPU pin (set ROMDEV_GPU or $XDG_CONFIG_HOME/romdev/gpu to a PCI address): the drivers pick the GPU" };
}

/**
 * GPU use of one process from its DRM file descriptors, per PCI device:
 * {pci: {clients, gfxNs, vramKiB}}. A DRM client is counted once however many
 * descriptors share it. null when procfs says nothing (not Linux).
 * @param {string|number} [pid] - "self" by default
 */
export function drmUsage(pid = "self") {
  const dir = `/proc/${pid}/fdinfo`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const seen = new Set();
  const out = {};
  for (const n of names) {
    const t = readText(`${dir}/${n}`);
    if (!t || !t.includes("drm-pdev")) continue;
    const field = (k) => { const m = new RegExp(`^${k}:\\s*(\\S+)`, "m").exec(t); return m ? m[1] : null; };
    const pdev = field("drm-pdev"), client = field("drm-client-id");
    if (!pdev) continue;
    const key = `${pdev}/${client}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = (out[pdev] ??= { clients: 0, gfxNs: 0, vramKiB: 0 });
    d.clients++;
    d.gfxNs += Number(field("drm-engine-gfx") || 0);
    d.vramKiB += Number(field("drm-memory-vram") || 0);
  }
  return out;
}

/**
 * GPU engine time every OTHER process holds on `pci` (another server, a
 * native test, a game), summed: {pids, gfxNs}. Scans /proc, so call it at the
 * edges of a run, not per frame.
 * @param {string} pci
 */
export function otherGpuClients(pci) {
  let pids;
  try { pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const self = String(process.pid);
  let gfxNs = 0;
  const who = [];
  for (const p of pids) {
    if (p === self) continue;
    const u = drmUsage(p);
    const d = u?.[pci];
    if (d && d.gfxNs > 0) { gfxNs += d.gfxNs; who.push(Number(p)); }
  }
  return { pids: who, gfxNs };
}

/** The GPU's current shader clock (MHz) and busy percentage from sysfs, or nulls. */
export function gpuSysfs(pci) {
  const sys = `/sys/bus/pci/devices/${pci}`;
  let sclkMhz = null;
  const s = readText(`${sys}/pp_dpm_sclk`);
  if (s) {
    const cur = s.split("\n").find((l) => l.includes("*"));
    const m = cur && /(\d+)\s*Mhz/i.exec(cur);
    if (m) sclkMhz = Number(m[1]);
  }
  const b = readText(`${sys}/gpu_busy_percent`);
  return { sclkMhz, busyPercent: b == null ? null : Number(b) };
}

// How much GPU memory THIS process is holding.
//
// WHY THIS EXISTS. On 2026-08-20 the server was found holding 26.69 GB of GTT
// -- and GTT is not a GPU-side pool: it is ordinary system RAM mapped into the
// GPU's address space (the Graphics Translation Table). So that was 26.69 GB
// of the machine's 54 GB, checked out to the GPU and unavailable to anything
// else. It went to 0.16 GB the instant the server exited, so it was
// unambiguously ours.
//
// The reason it took a forensic pass to find: NOTHING SHOWS IT. `ps`, `top`
// and RSS all attribute GTT to the GPU rather than to the process, so the
// server looked like a 3 GB process on a machine with 2.7 GB free and 19 GB
// visibly accounted for. The only place it surfaces per-process is DRM
// fdinfo. That invisibility is the actual hazard here -- a leak nobody can
// see does not get reported, it gets rediscovered.
//
// Read from /proc/self/fdinfo rather than the AMD-only
// /sys/class/drm/*/device/mem_info_gtt_used, for two reasons: fdinfo is the
// generic DRM interface (amdgpu, i915, xe, nouveau all implement the same
// drm-* keys), and it attributes the memory to THIS process instead of to the
// whole machine, which is the difference between "something is leaking" and
// "romdev is leaking".
//
// Everything here is best-effort and read-only: on a machine with no DRM fds,
// a non-Linux host, or a driver that does not publish the keys, it reports
// nothing rather than failing.

import { readdirSync, readFileSync } from "node:fs";

/** Keys worth reporting, in the order a reader wants them. */
const CATEGORIES = ["gtt", "vram", "cpu"];

/**
 * GPU memory this process currently holds, in MB, by category.
 *
 * A driver reports the SAME allocation on every DRM fd the process holds (we
 * routinely hold 3), so summing across fds would triple-count. The maximum
 * across fds is the honest figure.
 *
 * @returns {{gttMb?: number, vramMb?: number, driver?: string} | null}
 */
export function gpuMemory() {
  let fds;
  try {
    fds = readdirSync("/proc/self/fdinfo");
  } catch {
    return null; // not Linux, or no procfs
  }

  /** @type {Record<string, number>} */
  const peak = {};
  let driver;

  for (const fd of fds) {
    let text;
    try {
      text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    } catch {
      continue; // fd closed between readdir and read — normal, skip it
    }
    if (!text.includes("drm-driver")) continue;

    const drv = /^drm-driver:\s*(\S+)/m.exec(text);
    if (drv) driver = drv[1];

    for (const cat of CATEGORIES) {
      // drm-resident-* is what is actually backed right now, which is the
      // number that matters for "am I consuming the machine's memory".
      const m = new RegExp(`^drm-resident-${cat}:\\s*(\\d+)\\s*KiB`, "m").exec(text);
      if (!m) continue;
      const mb = Math.round(Number(m[1]) / 1024);
      if (!(cat in peak) || mb > peak[cat]) peak[cat] = mb;
    }
  }

  if (!driver) return null; // no DRM fds: headless, or software rendering
  const out = { driver };
  if (peak.gtt !== undefined) out.gttMb = peak.gtt;
  if (peak.vram !== undefined) out.vramMb = peak.vram;
  return out;
}

/**
 * A warning when this process is holding an unreasonable amount of GPU
 * memory, else null.
 *
 * The threshold is deliberately generous. A legitimately busy server with
 * several 3D cores and a window open runs in the low hundreds of MB; the leak
 * that prompted this was 26_000. Anything past a couple of GB is not a heavy
 * workload, it is something not being released -- and because GTT is system
 * RAM, it is taking the machine down with it.
 */
export function gpuMemoryWarning(mem = gpuMemory()) {
  if (!mem || mem.gttMb === undefined) return null;
  if (mem.gttMb < 2048) return null;
  return `This server is holding ${(mem.gttMb / 1024).toFixed(1)} GB of GPU-mapped memory (GTT). `
    + "GTT is SYSTEM RAM lent to the GPU, so this is consuming the machine's memory even though "
    + "`ps`/`top` will not attribute it to this process. Anything past ~2 GB means GL resources are "
    + "not being released. Restarting the server reclaims it immediately; report what the session was "
    + "doing (platform, whether a playtest window or bezel was open) so the leak can be traced.";
}

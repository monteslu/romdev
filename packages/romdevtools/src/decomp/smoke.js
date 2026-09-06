// smoke.js — reproducible runtime comparison of the base ROM against the
// rebuilt ROM: same pinned core, same inputs, two isolated sessions, compare
// DECODED pixels (not PNG bytes) and the CPU register file at the end.
//
// This is a boot/render smoke check with an explicit coverage statement. It
// never claims gameplay coverage: it says what was exercised (frames, inputs)
// and what was compared.
import fs from "node:fs";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sha1File } from "./project.js";

export async function callTool(reg, name, args, sessionKey) {
  const { runTool } = await import("../http/tool-registry.js");
  const tool = reg.get(name);
  if (!tool) throw new Error(`smoke: tool '${name}' is not registered`);
  const r = await runTool(tool, args, sessionKey);
  // runTool returns {ok, result} (HTTP shape); unwrap, and surface a tool error.
  if (r && r.ok === false) throw Object.assign(new Error(`${name}(${JSON.stringify(args).slice(0, 80)}) failed: ${r.error}`), { code: /No ROM loaded|evicted/.test(String(r.error)) ? "LOST_RUNTIME_STATE" : "RUNTIME_TOOL_FAILED" });
  const v = r && typeof r === "object" && "result" in r ? r.result : r;
  if (v && Array.isArray(v.content)) {
    const text = v.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return v;
}

function decodePng(buf) {
  // pngjs is a dependency of romdev-core-host; resolve it from there.
  return import("pngjs").then(({ PNG }) => { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data }; });
}

/**
 * @param {import('./project.js').Project} project
 * @param {{frames:number, inputs:Array<{frame:number,buttons:object}>, sessionKey:string, sessionHandle?:string}} a
 */
export async function runSmoke(project, { frames, inputs, sessionKey, sessionHandle, scriptPath, saveState = true }) {
  if (scriptPath) {
    const sc = JSON.parse(await readFile(scriptPath, "utf8"));
    inputs = sc.inputs ?? inputs; frames = sc.frames ?? frames;
  }
  const { buildToolRegistry } = await import("../http/tool-registry.js");
  const base = project.abs(project.m.rom.path);
  const rebuilt = project.m.built?.rom ? project.abs(project.m.built.rom) : null;
  if (!rebuilt || !fs.existsSync(rebuilt)) throw Object.assign(new Error(`rebuilt ROM not found at ${rebuilt}; run decomp({op:'verify'}) first`), { code: "NO_REBUILT_ROM" });
  const handle = sessionHandle ?? sessionKey ?? "decomp-smoke";
  const outDir = path.join(project.ws, "smoke", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  const sides = [{ name: "original", rom: base, key: `${handle}:orig` }, { name: "rebuilt", rom: rebuilt, key: `${handle}:rebuilt` }];
  const script = [...inputs].sort((a, b) => a.frame - b.frame);
  await writeFile(path.join(outDir, "inputs.json"), JSON.stringify({ frames, inputs: script, project: project.id, romSha1: project.m.rom.sha1 }, null, 2));
  const { CORES } = await import("../cores/registry.js");
  const corePkg = CORES[project.m.platform]?.pkg ?? null;
  let coreVersion = null;
  try { coreVersion = JSON.parse(await readFile(new URL(`../../../${corePkg}/package.json`, import.meta.url), "utf8")).version; } catch {}
  const results = {};
  for (const side of sides) {
    const reg = buildToolRegistry(side.key);
    const load = await callTool(reg, "loadMedia", { platform: project.m.platform, path: side.rom }, side.key);
    let at = 0;
    for (const step of script) {
      if (step.frame > at) { await callTool(reg, "frame", { op: "step", frames: step.frame - at }, side.key); at = step.frame; }
      await callTool(reg, "input", { op: "set", ports: [step.buttons] }, side.key);
    }
    if (frames > at) await callTool(reg, "frame", { op: "step", frames: frames - at }, side.key);
    const png = path.join(outDir, `${side.name}.png`);
    await callTool(reg, "frame", { op: "screenshot", path: png }, side.key);
    let cpu = null;
    try { cpu = await callTool(reg, "cpu", { op: "read" }, side.key); } catch (e) { cpu = { error: String(e?.message ?? e) }; }
    let checkpoint = null;
    if (saveState) { try { const st = await callTool(reg, "state", { op: "save", name: "decomp-smoke", path: path.join(outDir, `${side.name}.state`) }, side.key); checkpoint = st?.resolvedPath ?? st?.path ?? path.join(outDir, `${side.name}.state`); } catch (e) { checkpoint = { error: String(e?.message ?? e).slice(0, 160) }; } }
    const img = await decodePng(await readFile(png));
    results[side.name] = { load: { loaded: load?.loaded ?? null, core: load?.core ?? null }, checkpoint, png, width: img.width, height: img.height, pixelsSha1: createHash("sha1").update(img.data).digest("hex"), cpu, romSha1: await sha1File(side.rom), session: side.key, data: img.data };
  }
  const a = results.original, b = results.rebuilt;
  let differingPixels = null, firstDiff = null;
  if (a.width === b.width && a.height === b.height) {
    differingPixels = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) { differingPixels++; if (!firstDiff) firstDiff = { x: (i / 4) % a.width, y: Math.floor(i / 4 / a.width) }; }
    }
  }
  const regsA = JSON.stringify(a.cpu?.registers ?? a.cpu ?? null), regsB = JSON.stringify(b.cpu?.registers ?? b.cpu ?? null);
  const report = {
    project: project.id, frames, inputs: script.length, inputScript: path.join(outDir, "inputs.json"), replay: `decomp({op:'smoke', project:'${project.id}', scriptPath:'${path.join(outDir, "inputs.json")}'})`,
    core: { name: a.load.core ?? null, package: corePkg, version: coreVersion }, sessions: { original: a.session, rebuilt: b.session }, checkpoints: { original: a.checkpoint, rebuilt: b.checkpoint },
    pcAtEnd: { original: a.cpu?.pcHex ?? null, rebuilt: b.cpu?.pcHex ?? null, note: (a.cpu?.pcHex === "$80000180" || b.cpu?.pcHex === "$80000180") ? "the frame-boundary PC is the exception vector ($80000180): it is the interrupt handler, NOT the main loop or the code responsible for any memory change" : undefined },
    original: { rom: project.m.rom.path, romSha1: a.romSha1, pixelsSha1: a.pixelsSha1, png: a.png, size: `${a.width}x${a.height}` },
    rebuilt: { rom: project.m.built.rom, romSha1: b.romSha1, pixelsSha1: b.pixelsSha1, png: b.png, size: `${b.width}x${b.height}` },
    pixelsIdentical: differingPixels === 0, differingPixels, firstDifferingPixel: firstDiff, cpuRegistersIdentical: regsA === regsB,
    cpuOriginal: a.cpu, cpuRebuilt: regsA === regsB ? undefined : b.cpu,
    coverage: `boot + ${frames} frames with ${script.length} scripted input events on the pinned core; decoded RGB compared per pixel and the CPU register file compared at the end. This is a boot/render smoke check, NOT gameplay coverage — unexercised code paths are unobserved, not verified.`,
    artifacts: outDir,
  };
  delete report.cpuOriginal?.data;
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

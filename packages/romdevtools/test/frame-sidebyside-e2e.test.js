// frame({op:'sideBySide'}) end-to-end through the REAL registered tools.
// Builds two real ROMs on DIFFERENT cores (NES via fceumm, GB via gambatte),
// loads the second into the comparison slot via the real loadMedia({slot:'b'}),
// and drives the real frame handler. Proves the two-cores-at-once capture:
//   - two distinct cores live in one session at the same time,
//   - sideBySide composites both into one PNG (A|B layout, both dimensions),
//   - per-pane summaries report each platform + frame independently,
//   - slot B is required (clear error when absent).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { z } from "zod";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore } from "../src/mcp/tools/toolchain.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { registerLifecycleTools } from "../src/mcp/tools/lifecycle.js";
import { clearHost, clearHostB, getHostBOrNull } from "../src/mcp/state.js";

const parse = (r) => JSON.parse(r.content[0].text);

test("frame sideBySide composites two real cores (NES slot A + GB slot B)", { timeout: 300000 }, async () => {
  const key = "sbs-e2e";
  const root = await mkdtemp(path.join(tmpdir(), "sbs-e2e-"));
  // Register the real tools on a fake server (no observer middleware needed —
  // we assert the handler result directly).
  const tools = {};
  const fakeServer = { tool: (name, _d, _s, handler) => { tools[name] = handler; } };
  registerLifecycleTools(fakeServer, z, key);
  registerFrameTools(fakeServer, z, key);

  try {
    // Before loading slot B, sideBySide must fail with a clear "load slot B".
    // (Load slot A first so the error is specifically about B.)
    const nesProj = path.join(root, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: nesProj, template: "default", overwrite: true });
    const nesRom = path.join(root, "a.nes");
    assert.equal(parse(await buildProjectCore({ path: nesProj, platform: "nes", outputPath: nesRom })).ok, true, "NES build");
    await tools.loadMedia({ platform: "nes", path: nesRom });

    // safeTool catches the throw and returns a structured error result (the
    // framework's contract) rather than rejecting — assert on that.
    const noB = await tools.frame({ op: "sideBySide", inline: true });
    assert.equal(noB.isError, true, "sideBySide is an error result when slot B is empty");
    assert.match(noB.content[0].text, /slot B/i, "error names slot B and how to load it");

    // Load a GB ROM into slot B (a different core — gambatte).
    const gbProj = path.join(root, "gb-default");
    await createProjectImpl({ platform: "gb", name: "gb-default", path: gbProj, template: "default", overwrite: true });
    const gbRom = path.join(root, "b.gb");
    assert.equal(parse(await buildProjectCore({ path: gbProj, platform: "gb", outputPath: gbRom })).ok, true, "GB build");
    const loadB = parse(await tools.loadMedia({ platform: "gb", path: gbRom, slot: "b" }));
    assert.equal(loadB.slot, "b", "loadMedia reports slot b");
    assert.ok(getHostBOrNull(key), "slot B host is live");

    // Capture both, stepping the same frame count. inline:true returns the image
    // content + (text) summary; assert the composite + both panes.
    const res = await tools.frame({ op: "sideBySide", frames: 60, inline: true });
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img && img.data, "an inline PNG image came back");
    const png = PNG.sync.read(Buffer.from(img.data, "base64"));
    // NES is 256 wide, GB 160 (upscaled toward NES's 240px height). The composite
    // must be wider than either pane alone and at least the taller pane's height.
    assert.ok(png.width > 256, `composite width ${png.width} spans both panes`);
    assert.ok(png.height >= 144, `composite height ${png.height} fits both`);

    // The text line names both platforms + their independent frame counts.
    const txt = res.content.find((c) => c.type === "text").text;
    assert.match(txt, /left: nes/i);
    assert.match(txt, /right: gb/i);

    // path mode returns structured per-pane summaries.
    const outPng = path.join(root, "sbs.png");
    const j = parse(await tools.frame({ op: "sideBySide", frames: 30, path: outPng }));
    assert.equal(j.layout, "A|B");
    assert.equal(j.panes.a.platform, "nes");
    assert.equal(j.panes.b.platform, "gb");
    // Both stepped from 60 → +30 = 90 (A) ; B started at 0 → 60 → 90 as well.
    assert.equal(j.panes.a.frame, 90, "slot A advanced 60+30");
    assert.equal(j.panes.b.frame, 90, "slot B advanced 60+30 independently");
    const onDisk = await readFile(outPng);
    assert.ok(onDisk.length > 0, "composite written to disk");
  } finally {
    clearHost(key);
    clearHostB(key);
    await rm(root, { recursive: true, force: true });
  }
});

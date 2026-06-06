// R35 — SMS PSG sound wrapper smoke test.
//
// sms_sfx.{h,c} wraps the SN76489 PSG (same chip as Genesis PSG; on SMS
// accessed via I/O port $7F). 5-function API matching the cross-platform
// shape: sfx_init / sfx_tone / sfx_noise / sfx_update / sfx_off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

test("R35 SMS sfx wrapper: sfx_init + sfx_tone + sfx_noise + sfx_update compile + link", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const sfxH = await readFile(join(REPO_ROOT, "src/platforms/sms/lib/c/sms_sfx.h"), "utf-8");
  const sfxC = await readFile(join(REPO_ROOT, "src/platforms/sms/lib/c/sms_sfx.c"), "utf-8");
  const hw   = await readFile(join(REPO_ROOT, "src/platforms/sms/lib/c/sms_hw.h"), "utf-8");
  const main = `
#include "sms_hw.h"
#include "sms_sfx.h"
void main(void) {
    sfx_init();
    sfx_tone(0, 200, 8);
    sfx_tone(1, 400, 4);
    sfx_noise(12);
    while (1) { sfx_update(); }
}
`;
  const r = await buildForPlatform({
    platform: "sms",
    language: "c",
    sources: { "main.c": main, "sms_sfx.c": sfxC },
    includes: { "sms_hw.h": hw, "sms_sfx.h": sfxH },
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length >= 16384);
});

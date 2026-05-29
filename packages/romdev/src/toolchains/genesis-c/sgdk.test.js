// sgdk.test.js — Genesis C build via the bundled SGDK runtime.
//
// Confirms the WASM toolchain chains correctly through SGDK's link
// requirements: rom_header.c → .o → .bin (256-byte cart header),
// sega.s with that header incbin'd → .o, link with libmd.a + libgcc.a,
// extract raw ROM via objcopy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGenesisC } from "./genesis-c.js";

test("buildGenesisC sgdk:true: #include <genesis.h> + VDP_drawText links to a valid SGDK ROM", async () => {
  const r = await buildGenesisC({
    source: `
#include <genesis.h>

int main(bool hard) {
    VDP_drawText("Hello from SGDK", 10, 12);
    while (1) { SYS_doVBlankProcess(); }
    return 0;
}
`,
    sgdk: true,
  });
  assert.equal(r.ok, true, "SGDK build failed at " + r.stage + ":\n" + r.log);
  assert.equal(r.runtime, "sgdk");
  assert.ok(r.binary.length >= 256, "expected at least header bytes");

  // SGDK's sega.s emits the SEGA header at $100. Vector table at $0..$FF.
  const headerStart = Buffer.from(r.binary.subarray(0x100, 0x110)).toString("ascii");
  assert.equal(headerStart, "SEGA MEGA DRIVE ", "header at $100 missing");
});

test("buildGenesisC sgdk:false: bare main() still works (minimum-viable path)", async () => {
  const r = await buildGenesisC({
    source: "int counter = 7; int main(void) { counter += 1; return counter; }",
    sgdk: false,
  });
  assert.equal(r.ok, true, "minimal build failed at " + r.stage + ":\n" + r.log);
  assert.equal(r.runtime, "minimal");
});

// build({output:'reassemble'}) on a LEGACY rebuild.json project.
//
// Early disasm({target:'project'}) (v0.2x era) wrote its manifest as
// rebuild.json. A mature annotated project built by that version therefore
// fails this op, and the old error said:
//
//   "no reassemble.json in '…'. This op rebuilds a disasm({target:'project'})
//    directory — run that first (it writes reassemble.json + original.rom)."
//
// Two problems. The diagnosis reads as "this was never a disasm project", which
// is wrong and points at the wrong fix. And the ADVICE is dangerous: re-running
// disasm({target:'project'}) on an annotated project regenerates the sources and,
// done into the same directory, destroys months of annotations — on exactly the
// projects most likely to hit this error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reassembleProjectCore } from "../src/mcp/tools/toolchain.js";

function makeProject({ legacy }) {
  const dir = mkdtempSync(path.join(tmpdir(), "reassemble-legacy-"));
  if (legacy) {
    // A stale legacy manifest, in the shape actually found in the field: one
    // source entry where the real project has nine, and a mapper that no longer
    // matches. Its presence is the signal; its contents are not trustworthy.
    writeFileSync(path.join(dir, "rebuild.json"), JSON.stringify({
      platform: "nes",
      sourcesPaths: { "prg.asm": "prg.asm" },
      inesHeader: { mapper: 2 },
    }, null, 2));
  }
  writeFileSync(path.join(dir, "bank7.asm"), "; annotated work that must not be regenerated over\n");
  return dir;
}

test("a legacy rebuild.json is detected and named, not misdiagnosed", async () => {
  const dir = makeProject({ legacy: true });
  await assert.rejects(
    () => reassembleProjectCore({ path: dir, platform: "nes" }),
    (err) => {
      assert.match(err.message, /LEGACY rebuild\.json/,
        "says what it actually found");
      assert.doesNotMatch(err.message, /run that first/,
        "does not claim this was never a disasm project");
      return true;
    },
  );
});

test("the legacy error refuses to advise regenerating over annotations", async () => {
  const dir = makeProject({ legacy: true });
  await assert.rejects(
    () => reassembleProjectCore({ path: dir, platform: "nes" }),
    (err) => {
      // The dangerous advice, explicitly negated.
      assert.match(err.message, /Do NOT re-run disasm\(\{target:'project'\}\)/);
      assert.match(err.message, /overwrite your annotations/);
      // The safe path, named.
      assert.match(err.message, /build\(\{output:'rom'/);
      assert.match(err.message, /sourcesPaths/);
      assert.match(err.message, /linkerConfigPath/);
      // And the caveat that a legacy manifest's recorded call is often stale,
      // so a consumer validates rather than trusts it.
      assert.match(err.message, /stale/i);
      // The migration that doesn't touch the sources.
      assert.match(err.message, /SCRATCH directory/i);
      return true;
    },
  );
});

test("a directory with neither manifest still warns against regenerating over sources", async () => {
  const dir = makeProject({ legacy: false });
  await assert.rejects(
    () => reassembleProjectCore({ path: dir, platform: "nes" }),
    (err) => {
      assert.match(err.message, /no reassemble\.json/);
      // The original guidance survives for a genuinely fresh directory...
      assert.match(err.message, /run that first/);
      // ...but the destructive reading is closed off for the annotated case.
      assert.match(err.message, /do NOT regenerate over it/i);
      assert.match(err.message, /scratch dir/i);
      return true;
    },
  );
});

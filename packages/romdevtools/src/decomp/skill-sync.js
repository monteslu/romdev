// skill-sync.js - stop the distributed skill from describing a romdev that no
// longer exists.
//
// THE FAILURE. The installed client skill is version 0.14.0 and describes "~14
// platforms". The running server is far past that and supports N64, PS1,
// Dreamcast, wasmcart and the whole `decomp` domain. The skill does not mention
// N64 ONCE. An agent following it can correctly read the documentation it was
// given and conclude that romdev cannot do the thing it is being asked to do -
// and nothing anywhere tells it the document is stale.
//
// A stale skill is worse than no skill: no skill makes an agent ask, while a
// confidently wrong one makes it stop.
//
// So: the server reports the mismatch at initialization, this module can
// GENERATE a current skill from the live capability manifest, and the refresh
// is an explicit command rather than something that silently overwrites a file
// the user may have edited.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";

/** Where a distributed skill may be installed. */
export function skillLocations() {
  const home = os.homedir();
  return [
    path.join(home, ".claude", "skills", "romdev", "SKILL.md"),
    path.join(home, ".codex", "skills", "romdev", "SKILL.md"),
    ...(process.env.ROMDEV_SKILL_PATH ? [process.env.ROMDEV_SKILL_PATH] : []),
  ];
}

/** Read the installed skill's declared version and platform coverage. */
export async function readInstalledSkill() {
  for (const p of skillLocations()) {
    if (!fs.existsSync(p)) continue;
    let text = "";
    try { text = await readFile(p, "utf8"); } catch { continue; }
    const version = (/^\s*version:\s*"?([\d.]+)"?/m.exec(text) ?? [])[1] ?? null;
    // What the skill CLAIMS to cover, so a mismatch can be named concretely
    // instead of reduced to a version number the reader cannot act on.
    const mentions = {};
    for (const plat of ["n64", "ps1", "playstation", "dreamcast", "wasmcart", "jsgame", "decomp"]) {
      mentions[plat] = new RegExp(`\\b${plat}\\b`, "i").test(text);
    }
    return { path: p, version, bytes: text.length, mentions, text };
  }
  return null;
}

/**
 * Compare the installed skill against the running server.
 *
 * @param {{version:string, platforms:string[], hasDecomp?:boolean}} server
 */
export async function skillStatus(server) {
  const installed = await readInstalledSkill();
  if (!installed) {
    return { installed: false, serverVersion: server.version,
      note: "no distributed romdev skill is installed here. Nothing is stale, but nothing documents the server either." };
  }
  const missing = [];
  for (const plat of ["n64", "ps1", "dreamcast", "wasmcart"]) {
    if (server.platforms?.includes(plat) && !installed.mentions[plat]) missing.push(plat);
  }
  if (server.hasDecomp && !installed.mentions.decomp) missing.push("decomp (the matching-decompilation domain)");

  // AN OP THE SKILL NEVER NAMES IS AN OP THE AGENT WILL NOT USE.
  //
  // Comparing version strings alone reported `stale: false` on a skill that
  // mentioned NONE of five newly shipped ops - a document that was current by
  // number and wrong by content. The live op list is the authority.
  const undocumentedOps = (server.ops ?? []).filter((op) => !new RegExp(`\\bop\\s*:\\s*['"]?${op}\\b`, "i").test(installed.text ?? "")
    && !new RegExp(`\\b${op}\\b`).test(installed.text ?? ""));

  const versionDrift = installed.version && installed.version !== server.version;
  const stale = versionDrift || missing.length > 0 || undocumentedOps.length > 0;

  return {
    installed: true, path: installed.path,
    skillVersion: installed.version, serverVersion: server.version,
    versionDrift, undocumentedCapabilities: missing,
    ...(undocumentedOps.length ? { undocumentedOps } : {}),
    stale,
    ...(stale ? {
      warning: (versionDrift
        ? `The installed romdev skill is version ${installed.version} while this server is ${server.version}`
        : `The installed romdev skill reports the same version as this server (${server.version}) but its CONTENT is behind`)
        + (missing.length ? `, and it never mentions: ${missing.join(", ")}. An agent following it can correctly conclude romdev does not support them.` : ".")
        + (undocumentedOps.length ? ` It documents none of these ops: ${undocumentedOps.join(", ")}. A matching version number does not mean matching content.` : ""),
      remedy: `decomp({op:'skill', action:'write'}) regenerates it from the LIVE capability manifest. `
        + `It will not overwrite without action:'write', because the file may have been edited by hand.`,
    } : { note: "the installed skill matches this server" }),
  };
}

/**
 * The matching-decompilation section of the skill: the contract that keeps a
 * reader honest about exactness, and every `decomp` op, read from the server's
 * own schema. Part of the one skill document (http/skill-doc.js buildSkillDoc),
 * which both GET /skills/romdev/SKILL.md and decomp({op:'skill', action:'write'})
 * produce.
 */
export function decompSkillSection({ decompPlatforms = [], ops = [] }) {
  if (!decompPlatforms.length) return "";
  return `## Matching decompilation (\`decomp\`)

Supported for: **${decompPlatforms.join(", ")}**.

The loop is generate → compile → compare → refine against the project's OWN compiler and build system. What matters most when using it:

- **An exactness verdict is never invented.** A check that could not run reports \`unknown\` or \`error\`, never \`exact\`.
- **Exactness and source quality are SEPARATE.** A byte-exact candidate can still be artificial (self-assignments, empty branches, comma-zero expressions). \`decomp({op:'gate'})\` classifies source quality and never overwrites the exactness result.
- **Ranking uses only CURRENT-tree evidence.** Attempts measured against a different source tree are visible but never rank the queue.
- **The default queue is game targets only.** Handwritten assembly counts in completion accounting and is never an automatic C-recovery task.
- **A matching mixed C/asm ROM is not a finished decompilation.** \`decomp({op:'ledger'})\` reports completion as separate dimensions and deliberately produces no single percentage.
${ops.length ? `
### Every \`decomp\` op

An op missing from this list is an op an agent will not reach for, so the list is
generated from the server's own schema rather than maintained by hand:

${ops.map((o) => `\`op:'${o}'\``).join(", ")}.

Worth knowing about the newer ones: \`diagnose\` groups a comparison's residuals
by COMPILER MECHANISM (scheduling permutation, branch lowering, register
assignment, frame layout) and proposes experiments that state what would refute
them; \`layout\` maps the stack frame and resolves an address against symbols
that already exist; \`variants\` runs a bounded batch of named source variants
under one dependency snapshot; \`research\` indexes prior drafts and notes as
CLAIMS that never outrank a measurement; \`replay\` re-runs the preserved
fixture cases through this same public API.` : ""}

Start with \`decomp({op:'status'})\`, then \`decomp({op:'plan'})\`.
`;
}

/** Write the generated skill, backing up whatever was there. */
export async function writeSkill(content, { targetPath } = {}) {
  const target = targetPath ?? skillLocations().find((p) => fs.existsSync(p)) ?? skillLocations()[0];
  await mkdir(path.dirname(target), { recursive: true });
  let backup = null;
  if (fs.existsSync(target)) {
    // NEVER silently destroy a hand-edited file.
    backup = `${target}.backup-${Date.now()}`;
    await writeFile(backup, await readFile(target, "utf8"));
  }
  await writeFile(target, content);
  return { written: target, backup, bytes: content.length,
    note: backup ? `the previous skill was saved to ${backup} - it may have contained hand edits` : "no previous skill existed at this path" };
}

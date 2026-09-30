// scratch-bundle.js - reproducible, upload-neutral decomp.me scratch bundles:
// the three inputs copied into one directory with a deterministic manifest,
// SHA256SUMS and paste instructions. Creating one never contacts decomp.me.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { ValueError } from "./py.js";
import { dumps } from "./pyjson.js";
import { fileSha256 } from "./campaign.js";

/** Paths and manifest produced for one local scratch bundle. */
export class ScratchBundleResult {
  constructor({ output, manifest }) { Object.assign(this, { output, manifest }); Object.freeze(this); }
}

const expand = (p) => (p === "~" || String(p).startsWith("~/") ? (process.env.HOME ?? "") + String(p).slice(1) : String(p));
const resolve = (p) => { const a = path.resolve(expand(p)); try { return fs.realpathSync(a); } catch { return a; } };

function copyInput(source, destination) {
  const input = resolve(source);
  let st = null;
  try { st = fs.statSync(input); } catch { st = null; }
  if (!st?.isFile()) throw new ValueError(`scratch input is not a file: ${input}`);
  fs.copyFileSync(input, destination);
}

/** Copy scratch inputs and write a deterministic manifest and instructions. */
export function bundleScratch(output, { target_assembly, context, source, platform, compiler, compiler_flags, diff_label, project = null, preset = null, compiler_id = null, language = null, provenance = null }) {
  const required = { platform, compiler, diff_label };
  const missing = Object.entries(required).filter(([, v]) => !String(v).trim()).map(([n]) => n);
  if (missing.length) throw new ValueError("scratch metadata cannot be empty: " + missing.join(", "));
  const outputPath = resolve(output);
  if (fs.existsSync(outputPath)) {
    if (!fs.statSync(outputPath).isDirectory()) throw new ValueError(`scratch output exists and is not a directory: ${outputPath}`);
    if (fs.readdirSync(outputPath).length) throw new ValueError(`scratch output directory is not empty: ${outputPath}`);
  } else fs.mkdirSync(outputPath, { recursive: true });
  const inputs = { "target.s": target_assembly, "context.c": context, "source.c": source };
  for (const [name, input] of Object.entries(inputs)) copyInput(input, path.join(outputPath, name));
  const files = {};
  for (const name of Object.keys(inputs).sort()) files[name] = { sha256: fileSha256(path.join(outputPath, name)) };
  const decompMe = { platform, compiler, compiler_flags, diff_label };
  if (preset) decompMe.preset = preset;
  if (compiler_id) decompMe.compiler_id = compiler_id;
  if (language) decompMe.language = language;
  const manifest = { schema: "decomp-workbench-scratch-bundle-v1", decomp_me: decompMe, files };
  if (project) manifest.project = project;
  if (provenance && Object.keys(provenance).length) manifest.provenance = provenance;
  fs.writeFileSync(path.join(outputPath, "scratch.json"), dumps(manifest) + "\n", "utf8");
  fs.writeFileSync(path.join(outputPath, "SHA256SUMS"), Object.entries(files).map(([n, m]) => `${m.sha256}  ${n}\n`).join(""), "utf8");
  fs.writeFileSync(path.join(outputPath, "README.md"), bundleReadme(manifest), "utf8");
  return new ScratchBundleResult({ output: outputPath, manifest });
}

function bundleReadme(manifest) {
  const s = manifest.decomp_me;
  const { preset, compiler_id: compilerId, language } = s;
  const identity = compilerId ? ` (canonical compiler id \`${compilerId}\`)` : "";
  const languageStep = language ? `\n5. Verify the language is \`${language}\`.` : "";
  let selection;
  if (preset) {
    selection = `3. Select preset \`${preset}\`.
4. Under **Compiler options**, verify compiler \`${s.compiler}\`${identity};
   presets can silently select a different frontend even when their names look
   similar.${languageStep}`;
  } else {
    const compilerLine = `4. Under **Compiler options**, select compiler \`${s.compiler}\`${identity}.`;
    selection = `3. Set **Preset** to **Custom**.
${compilerLine}${languageStep}`;
  }
  const projectLine = manifest.project ? `\nProject: \`${manifest.project}\`.\n` : "";
  return `# decomp.me scratch bundle
${projectLine}
This directory is upload-neutral: creating it does not contact decomp.me.

1. Open <https://www.decomp.me/new>.
2. Choose platform \`${s.platform}\`.
${selection}

Then use diff label \`${s.diff_label}\`, paste \`target.s\` into **Target
assembly**, paste \`context.c\` into **Context**, create the scratch, and paste
\`source.c\` into the source editor.

If a preset was not selected, use these compiler flags:

   \`\`\`text
   ${s.compiler_flags}
   \`\`\`

Run \`decomp-workbench check-scratch .\` from this directory before sharing. It
verifies \`SHA256SUMS\`, the manifest, and the three copied inputs consistently
on every supported platform. \`scratch.json\` contains the same settings and
content identities in a machine-readable form.
`;
}

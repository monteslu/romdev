// agent-skill.js - install the portable decompilation campaign Agent Skill
// for a supported client. An existing, differing installation is never
// overwritten; an identical one is reported as current.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ValueError, strRepr, sorted } from "./py.js";
import { FileNotFoundError, OSError } from "./py-extra.js";

export const SKILL_NAME = "n64-decomp-campaign";
export const SUPPORTED_CLIENTS = ["codex", "claude"];

/** The skill directory shipped with this installation. */
export function bundledSkillPath() {
  const p = fileURLToPath(new URL(`./data/skills/${SKILL_NAME}`, import.meta.url));
  if (!fs.existsSync(path.join(p, "SKILL.md"))) throw new FileNotFoundError(`bundled skill is missing: ${p}`);
  return p;
}

/** The personal skill directory for one supported client. */
export function defaultSkillsDirectory(client, env = process.env) {
  let root;
  if (client === "codex") root = env.CODEX_HOME ? expand(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  else if (client === "claude") root = path.join(os.homedir(), ".claude");
  else throw new ValueError(`unsupported client ${strRepr(client)}; choose ${SUPPORTED_CLIENTS.join(", ")}`);
  return path.join(root, "skills");
}

const expand = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

function filesUnder(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full); else if (st.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Hash relative paths and contents for a deterministic tree identity. */
export function skillTreeDigest(root) {
  const digest = createHash("sha256");
  // Ordered the way paths order: component by component.
  const items = sorted(filesUnder(root).map((f) => [path.relative(root, f).split(path.sep).join("/"), f]), (i) => i[1].split("/"));
  for (const [rel, full] of items) {
    const r = Buffer.from(rel, "utf8");
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(r.length));
    digest.update(len); digest.update(r); digest.update(fs.readFileSync(full));
  }
  return digest.digest("hex");
}

/** Install the bundled skill safely; returns [path, "installed"|"current"]. */
export function installAgentSkill(client, { destination = null } = {}) {
  if (!SUPPORTED_CLIENTS.includes(client)) throw new ValueError(`unsupported client ${strRepr(client)}; choose ${SUPPORTED_CLIENTS.join(", ")}`);
  const source = bundledSkillPath();
  let skills = destination !== null && destination !== undefined ? path.resolve(expand(destination)) : path.resolve(defaultSkillsDirectory(client));
  try { skills = fs.realpathSync(skills); } catch { /* not created yet */ }
  if (fs.existsSync(skills) && !fs.statSync(skills).isDirectory()) {
    throw Object.assign(new OSError(`skills destination is not a directory: ${skills}`), { kind: "NotADirectoryError" });
  }
  const target = path.join(skills, SKILL_NAME);
  let lst = null;
  try { lst = fs.lstatSync(target); } catch { lst = null; }
  if (lst) {
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch { isDir = false; }
    if (isDir && skillTreeDigest(target) === skillTreeDigest(source)) return [target, "current"];
    throw Object.assign(new OSError(`skill already exists and differs: ${target}; move it aside or choose --destination`), { kind: "FileExistsError" });
  }
  fs.mkdirSync(skills, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(skills, `.${SKILL_NAME}-`));
  try {
    const staged = path.join(temporary, SKILL_NAME);
    fs.cpSync(source, staged, { recursive: true, dereference: true });
    fs.renameSync(staged, target);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return [target, "installed"];
}

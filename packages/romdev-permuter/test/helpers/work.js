// Scratch directories for tests live under test/.work (gitignored), never in
// the system temp dir.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".work");

export function workDir(tag) {
  const d = path.join(WORK, `${tag}-${randomBytes(4).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
}

export function removeDir(d) { rmSync(d, { recursive: true, force: true }); }

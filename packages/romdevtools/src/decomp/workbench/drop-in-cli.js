// drop-in-cli.js - `instrument-drop-in` (instrument drop-in) and
// `check-drop-in` (instrument check).
//
// Plain JS ESM + JSDoc.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { audit, formatAudit, plan, renderScript } from "./drop-in.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const errText = (e) => (e?.code && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);

export function instrumentDropInCommand(args, io) {
  const document = plan({ generated: expandUser(args.generated), output: expandUser(args.output) });
  const scriptPath = args.script ? expandUser(args.script) : null;
  try {
    if (scriptPath !== null) {
      if (existsSync(scriptPath)) throw Object.assign(new Error(`refusing to overwrite script: ${scriptPath}`), { name: "OSError", plain: true });
      mkdirSync(path.dirname(path.resolve(scriptPath)), { recursive: true });
      writeFileSync(scriptPath, renderScript(document), "utf8");
      chmodSync(scriptPath, 0o755);
    }
  } catch (e) {
    if (!e.plain && !isInputError(e)) throw e;
    io.eprint(`error: ${e.plain ? e.message : errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(document));
  else {
    io.write(renderScript(document));
    if (scriptPath !== null) io.print(`# written to ${scriptPath}`);
  }
  const missing = document.sources.filter((s) => !s.present).map((s) => s.source);
  if (missing.length && args.require_sources) { io.eprint("error: generated source not found: " + missing.join(", ")); return 1; }
  return 0;
}

export function checkDropInCommand(args, io) {
  let document;
  try { document = audit(args.binary.map(expandUser)); } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(document));
  else io.print(formatAudit(document));
  return document.complete ? 0 : 1;
}

export const COMMAND_SPECS = [
  {
    path: ["instrument-drop-in"], handler: instrumentDropInCommand,
    help: "plan one instrumented cc carrying both passes' profiles",
    description: "Print the reproducible recipe for an instrumented drop-in that carries the uopt CDX profiles and the ugen free-list and emit-order hooks together, with the fidelity gates that close it.",
    arguments: [
      { dest: "generated", help: "the recompiled compiler's generated C (ido-static-recomp: build/5.3/out)" },
      { dest: "output", help: "where the instrumented sources are written" },
      { flags: ["--script"], metavar: "PATH", help: "also write the recipe as a runnable script; refuses to overwrite" },
      { flags: ["--require-sources"], action: "store_true", help: "exit 1 when a generated source named by the plan is not present" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["check-drop-in"], handler: checkDropInCommand,
    help: "report which instrumentation profiles a built compiler carries",
    description: "Scan built compiler binaries for each profile's injected marker strings. A profile that did not survive a rebuild produces empty logs rather than errors, so it is checked rather than discovered.",
    arguments: [
      { dest: "binary", nargs: "+", help: "built compiler binaries (uopt, ugen, or cc)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];

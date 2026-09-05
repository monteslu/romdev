// feedback — a defect / token-sink report that lands in ONE local file the
// maintainer can collect, stamped with everything a report needs to be
// comparable: server version, pid, the platform and media the session had
// loaded, and the time.
//
// Why a tool at all: the server instructions tell an agent that a host-compiler
// install kicking off is "a DEFECT to report", and there was no way to report
// one. Every project invented its own convention (a hand-maintained markdown
// file plus timestamped essays), each report paid three shell calls to learn
// the version it was reporting against, and one such file lost ~340 lines to a
// truncation because it was git-excluded. This is deliberately a LOCAL,
// append-only log: it never phones home — the human zips the file up and
// sends it. Its value is that reports arrive in one shape with the stamps
// already on them.
//
// Reach for it for a defect you actually hit or a step that cost far more
// tokens than it should have — not for restating a doc nit you noticed in
// passing.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonContent, safeTool } from "../util.js";
import { peekSession } from "../state.js";

const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8")).version;
  } catch { return "0.0.0"; }
})();

/** Where the log lives. Overridable so a CI/collector can point it elsewhere. */
export function feedbackPath() {
  return process.env.ROMDEV_FEEDBACK_PATH || path.join(homedir(), ".romdev", "feedback.jsonl");
}

/**
 * Build the JSON line for one report. Exported for tests.
 * @param {{title:string, body:string, severity?:string, tool?:string, platform?:string, tokensWasted?:string, sessionKey?:string}} args
 */
export function feedbackEntry({ title, body, severity = "bug", tool, platform, tokensWasted, sessionKey }) {
  const session = sessionKey ? peekSession(sessionKey) : {};
  return {
    at: new Date().toISOString(),
    romdevVersion: PKG_VERSION,
    serverPid: process.pid,
    severity,
    title: String(title).trim(),
    body: String(body).trim(),
    ...(tool ? { tool } : {}),
    platform: platform ?? session.platform ?? null,
    media: session.path ?? null,
    ...(tokensWasted ? { tokensWasted } : {}),
    node: process.version,
    os: process.platform,
  };
}

export async function recordFeedbackCore(args) {
  const entry = feedbackEntry(args);
  const file = feedbackPath();
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  return {
    recorded: true,
    path: file,
    entry,
    note: "Appended to a local, append-only log — nothing leaves this machine. The maintainer collects the file out-of-band; tell the human where it is so they can send it.",
  };
}

export async function listFeedbackCore({ last = 20 } = {}) {
  const file = feedbackPath();
  let text = "";
  try { text = await readFile(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const lines = text.split("\n").filter(Boolean);
  const entries = lines.slice(-last).map((l) => { try { return JSON.parse(l); } catch { return { corrupt: l }; } });
  return { path: file, total: lines.length, entries };
}

export function registerFeedbackTools(server, z, sessionKey) {
  server.tool(
    "feedback",
    "Report a romdev defect or a token sink you actually hit, keyed by `op`. " +
    "op:'record' (default) appends ONE structured line to a LOCAL append-only log (~/.romdev/feedback.jsonl, or $ROMDEV_FEEDBACK_PATH) stamped with romdevVersion, serverPid, the session's loaded platform + media path, and the time — the stamps every hand-written report used to pay shell calls to collect. Nothing leaves the machine; the human sends the file to the maintainer. " +
    "Use it for: a tool that returned wrong/misleading output, a documented step that fails, an error whose text hid the cause, a host-toolchain install that started, or a job that took far more calls than it should have (say what would have made it one call). NOT for restating doc nits noticed in passing — one report per distinct issue. " +
    "op:'list' reads back the last `last` entries.",
    {
      op: z.enum(["record", "list"]).default("record").describe("record=append one report (default); list=read back recent reports."),
      title: z.string().min(3).max(160).optional().describe("op:'record' — one line: the defect or the cost, e.g. \"output:'run' refused on sync32 — NODERAWFS core given in-memory bytes\"."),
      body: z.string().min(1).optional().describe("op:'record' — what you did, what happened, what you expected, and the fix or the cheaper path you wanted. Exact error text if short."),
      severity: z.enum(["blocker", "bug", "ergonomics", "token", "doc", "idea"]).default("bug").describe("op:'record' — blocker=could not proceed; bug=wrong behaviour; ergonomics=worked but fought you; token=cost far more calls/tokens than it should; doc=missing/wrong docs; idea=a capability that would have helped."),
      tool: z.string().optional().describe("op:'record' — the tool + op involved, e.g. \"build({output:'run'})\"."),
      platform: z.string().optional().describe("op:'record' — platform id; defaults to whatever this session has loaded."),
      tokensWasted: z.string().optional().describe("op:'record' — rough cost, e.g. \"6 calls, ~40k tokens bisecting\"."),
      last: z.number().int().min(1).max(500).default(20).describe("op:'list' — how many recent entries to return."),
    },
    safeTool(async (args) => {
      if (args.op === "list") return jsonContent(await listFeedbackCore(args));
      if (!args.title || !args.body) throw new Error("feedback({op:'record'}): `title` and `body` are required.");
      return jsonContent(await recordFeedbackCore({ ...args, sessionKey }));
    }),
  );
}

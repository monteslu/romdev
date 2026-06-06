// SKILL.md generator (Agent Skills open standard) + the channel-aware preambles.
//
// One shared body (AGENTS.md, channel-neutral) is wrapped per delivery channel:
//   - MCP connection instructions = mcpPreamble + body   (says "call the MCP
//     tools"; never mentions HTTP routes / skills)
//   - GET /romdev-skill.md        = skill frontmatter + skillPreamble + body +
//     generated tool reference     (says "POST /tool/{name}"; never mentions MCP)
//
// So neither surface mentions the other: the delivery instructions live in the
// preambles here, not in AGENTS.md. The tool reference is generated from the live
// registry (descriptions + JSON-Schema params), so it never drifts from the code.

import { toolJsonSchema } from "./tool-registry.js";

/**
 * MCP-channel preamble — prepended to the shared AGENTS body when the server
 * hands instructions to an MCP client. Talks ONLY about MCP tool-calling.
 */
export const mcpPreamble = [
  "romdev: homebrew retro game development + reverse-engineering for coding agents.",
  "All ~34 tools register at session init — call any by name directly, no loading step. Each is a domain VERB with an operation axis: memory({op}), build({output}), breakpoint({on}), cpu({op}), sprites({op}), tiles({op}), disasm({target}), romPatch({op}), …",
  "catalog({op:'categories'}) maps the tools by purpose (a guide, not a gate); catalog({op:'status'}) is a session re-orient.",
].join("\n");

/**
 * Skill-channel preamble — talks ONLY about the HTTP routes. No MCP.
 */
export const skillPreamble = [
  "romdev gives you homebrew retro game development + reverse-engineering for ~14 platforms (NES, SNES, Game Boy, Genesis, GBA, Atari, C64, and more) — build, run, screenshot, inspect, patch, disassemble, convert assets, drive emulators.",
  "",
  "## Prerequisite: the romdev server must be running",
  "romdev bundles every compiler + emulator as WASM and runs them in-process — but that engine lives in the romdev SERVER, which must be started once: `npx romdev-mcp` (it listens on http://localhost:7331; no other install, no host gcc/emulator needed). These routes drive that running server. If a call gets connection-refused, the server isn't running — start it with `npx romdev-mcp`.",
  "",
  "## How to call romdev",
  "Each capability is an HTTP route on the running romdev server (default http://localhost:7331):",
  "  • POST /tool/{name}  — run a tool. The JSON request body is the arguments. The response is JSON.",
  "  • GET  /tool/{name}/schema — that tool's JSON Schema (the exact parameters + types).",
  "  • GET  /openapi.json — the full machine-readable API; GET /documentation — a browsable console.",
  "",
  "Sessions (for stateful work like load→step→read): your first POST returns an `x-romdev-session` header.",
  "Echo that header on subsequent calls to keep the SAME emulator session. Omit it for one-shot file tools.",
  "",
  "Each tool is a domain VERB keyed by an operation axis — e.g. POST /tool/memory {\"op\":\"read\",…},",
  "POST /tool/build {\"output\":\"rom\",…}, POST /tool/romPatch {\"op\":\"findPointer\",…}. The full per-tool",
  "parameter list is in the TOOL REFERENCE at the end of this doc (and /openapi.json).",
].join("\n");

/**
 * Build GET /romdev-skill.md: frontmatter + skill preamble + shared body +
 * generated tool reference.
 * @param {{registry: Map<string,any>, agentsBody: string, version?: string}} args
 * @returns {string}
 */
export function buildSkillDoc({ registry, agentsBody, version }) {
  const frontmatter = [
    "---",
    "name: romdev",
    "description: Homebrew retro game development and ROM reverse-engineering for ~14 platforms (NES, SNES, Game Boy/Color, Genesis, GBA, Atari 2600/7800, Lynx, C64, SMS, Game Gear, PC Engine, MSX). Use when building, running, debugging, disassembling, asset-converting, or romhacking a retro game — drives bundled emulators and toolchains over HTTP.",
    `metadata:`,
    `  version: "${version ?? "0.0.0"}"`,
    "---",
    "",
  ].join("\n");

  const body = sanitizeForSkillChannel((agentsBody || "").trim());
  const reference = skillToolReference(registry);

  return [
    frontmatter,
    skillPreamble,
    body ? "\n---\n\n" + body : "",
    "\n---\n\n" + reference,
    "",
  ].join("\n");
}

/**
 * Sanitize the shared AGENTS body for the SKILL channel: drop MCP-protocol-
 * specific INSTRUCTIONS (session-id headers, re-initialize, 404 reconnect — none
 * of which apply to the HTTP/skill surface), and soften the few descriptive
 * "these MCP tools" mentions to channel-neutral wording. We do NOT try to scrub
 * every letters-"MCP" occurrence by force (that risks mangling meaning); we
 * remove the lines that would MISLEAD a skill user (telling them to do an
 * MCP-only thing) and neutralize the casual "MCP tools" phrasing.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForSkillChannel(text) {
  if (!text) return text;
  const lines = text.split("\n");
  const kept = [];
  for (const line of lines) {
    // Drop whole lines that are MCP-protocol instructions (session/reconnect).
    if (/Mcp-Session-Id|re-?initialize|session not found|MCP client|MCP connection|MCP sessions/i.test(line)) {
      continue;
    }
    // Neutralize casual descriptive mentions so the skill channel never says "MCP".
    let l = line
      .replace(/\bthese MCP tools\b/gi, "these tools")
      .replace(/\bevery other MCP tool\b/gi, "every other tool")
      .replace(/\bMCP[- ]exposed\b/gi, "exposed")
      .replace(/\bsix MCP calls\b/gi, "six calls")
      .replace(/\bthe MCP server\b/gi, "the romdev server")
      .replace(/\bover MCP\b/gi, "over HTTP")
      .replace(/\bfor use outside MCP\b/gi, "for standalone use")
      .replace(/\bvia these MCP tools\b/gi, "via these tools")
      .replace(/\bMCP\b/g, "romdev"); // catch-all: any remaining bare "MCP" → "romdev"
    kept.push(l);
  }
  return kept.join("\n");
}

/**
 * Generate the TOOL REFERENCE section from the live registry: each tool's
 * description + a compact param list from its JSON Schema. (Progressive
 * disclosure: the agent can also GET /tool/{name}/schema for the full validator.)
 * @param {Map<string,any>} registry
 * @returns {string}
 */
export function skillToolReference(registry) {
  const lines = ["# TOOL REFERENCE", "", `${registry.size} tools. POST the args as JSON to /tool/{name}.`, ""];
  for (const name of [...registry.keys()].sort()) {
    const tool = registry.get(name);
    const js = toolJsonSchema(tool.inputSchema);
    const props = js.properties || {};
    const required = new Set(js.required || []);
    lines.push(`## ${name}`);
    // first paragraph of the description (full prose can be long; the schema
    // carries per-param detail). Sanitized so a tool desc that mentions MCP
    // doesn't leak into the skill (channel-neutral) surface.
    const firstLine = sanitizeForSkillChannel((tool.description || "").split("\n")[0]).trim();
    if (firstLine) lines.push(firstLine);
    const paramList = Object.keys(props).map((p) => {
      const t = props[p].type || (props[p].enum ? "enum" : "any");
      const req = required.has(p) ? "" : "?";
      const en = props[p].enum ? `(${props[p].enum.join("|")})` : "";
      return `${p}${req}:${t}${en}`;
    });
    if (paramList.length) lines.push("`POST /tool/" + name + "` params: " + paramList.join(", "));
    lines.push("");
  }
  return lines.join("\n");
}

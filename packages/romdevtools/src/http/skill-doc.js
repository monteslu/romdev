// SKILL.md generator (Agent Skills open standard) + the channel-aware preambles.
//
// One shared body (AGENTS.md, channel-neutral) is wrapped per delivery channel:
//   - MCP connection instructions = mcpPreamble + body   (says "call the MCP
//     tools"; never mentions HTTP routes / skills)
//   - GET /skills/romdev/SKILL.md = skill frontmatter + skillPreamble + body +
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
  "romdev: homebrew retro game development + reverse-engineering for coding agents — 18 platforms (NES through GBA, C64, GameTank, + the 3D consoles N64/PlayStation/Dreamcast).",
  "HARD RULE: NEVER install a host compiler or emulator (no clang/gcc/Xcode/devkitPro/brew/apt, no downloaded emulator). romdev BUNDLES every compiler (cc65, sdcc, gcc, arm/m68k/mips/sh-gcc, tcc, wla, rgbds, vasm, asar, dasm) + every emulator core as WASM and runs them through these tools — build({output:'rom'|'run'}) compiles, loadMedia+frame runs. If you're about to install or call a host toolchain, STOP and use the romdev build tool instead; an install kicking off is a DEFECT to report.",
  "All ~32 tools register at session init — call any by name directly, no loading step. Each is a domain VERB with an operation axis: memory({op}), build({output}), breakpoint({on}), cpu({op}), sprites({op}), tiles({op}), disasm({target}), romPatch({op}), …",
  "RE engine (all 18 platforms): disasm({target:'functions'}) auto-detects functions, disasm({target:'cfg'}) graphs control flow, disasm({target:'xrefs'}) finds cross-references, disasm({target:'decompile'}) emits Ghidra C pseudocode, symbols({op:'analyze'}) maps a ROM's structure in one call.",
  "catalog({op:'categories'}) maps the tools by purpose (a guide, not a gate); catalog({op:'status'}) is a session re-orient.",
].join("\n");

/**
 * Skill-channel preamble — talks ONLY about the HTTP routes. No MCP.
 */
export const skillPreamble = [
  "romdev gives you homebrew retro game development + reverse-engineering for 18 platforms (NES, SNES, Game Boy, Genesis, GBA, Atari, C64, GameTank, the 3D consoles N64/PlayStation/Dreamcast, and more) — build, run, screenshot, inspect, patch, disassemble, convert assets, drive emulators.",
  "It also ships a full RE analysis engine (Rizin + Ghidra, all 18 platforms): control-flow graphs, cross-references, auto-detected functions, a one-shot structural map, and a C-pseudocode decompiler — `disasm({target:'cfg'|'xrefs'|'functions'|'decompile'})` and `symbols({op:'analyze'})`.",
  "",
  "## HARD RULE: never install a compiler or emulator — romdev already bundles every one",
  "Every compiler/assembler/linker (cc65, sdcc, gcc, arm/m68k/mips/sh-gcc, tcc, wla, rgbds, vasm, asar, dasm) and every emulator core ships as WASM INSIDE romdev and runs in-process through these tools — `build({output:'rom'|'run'})` compiles, `loadMedia`+`frame` runs. You do NOT need, and must NOT install, a host `clang`/`gcc`/Xcode/Command-Line-Tools/devkitPro/`brew`/`apt` compiler or any emulator to build or run a ROM here. If you catch yourself about to install or invoke a host compiler/emulator — STOP. That's never the move: use the romdev `build` tool. (`platform({op:'toolchains'})` lists what's bundled for each platform.) A compiler/emulator install kicking off while using romdev is a DEFECT to report, not a step to take.",
  "",
  "## Prerequisite: romdev runs LOCALLY (same machine as you)",
  "The romdev SERVER hosts all that bundled WASM in-process; start it once with `npx romdevtools` (listens on http://localhost:7331 — that single `npx` is the ONLY install, and it pulls the toolchains/cores as bundled WASM, never a host compiler). If a call gets connection-refused, the server isn't running — start it.",
  "**romdev runs on the SAME machine as you, and tools take FILESYSTEM PATHS** (`path`, `outputPath`, `modulePath`, `vgmPath`, …) — those are paths on the local disk romdev shares with you, NOT uploads. Pass an absolute local path; romdev reads/writes it directly. (This is also why it's localhost-only and needs no auth.) Likewise output paths land on the local disk where you can read them back.",
  "",
  "## How to call romdev",
  "Each capability is an HTTP route on the local romdev server (default http://localhost:7331):",
  "  • POST /tool/{name}  — run a tool. The JSON request body is the arguments. The response is JSON.",
  "  • GET  /tool/{name}/schema — that tool's JSON Schema (the exact parameters + types).",
  "  • GET  /openapi.json — the full machine-readable API; GET /documentation — a browsable console.",
  "",
  "## Sessions — IMPORTANT for stateful work (load → step → read)",
  "**Pick ONE session id for yourself and send it as the `x-romdev-session` header on EVERY call.** Make it UNIQUE and DESCRIPTIVE of what you're doing — e.g. `nes-platformer-build`, `rpg-romhack-text`, `gba-sprite-debug` (a slug, optionally with a short random suffix to stay unique). A human may be watching the live observer at /livestream, where your session id is the label for all your activity — a descriptive id tells them at a glance which agent/task each call belongs to; a bare uuid or `default` is opaque. The emulator/host is per-session: the ROM you `loadMedia` lives in YOUR session, and the next `frame`/`memory`/`cpu` call only sees it if it carries the SAME id. Do NOT send a new id each call — that's a fresh empty session every time (your loaded ROM vanishes; \"No ROM loaded\"). Several agents can share one server safely: each just sends a DIFFERENT id, so nobody clobbers another's ROM (another reason to make yours distinctive). The header is REQUIRED on every `/tool/{name}` call — omit it and you get a **401** (the server will NOT silently run you in a throwaway session). Pure file tools (romPatch/cart/encodeAudio) still need the header; just reuse your one id everywhere.",
  "",
  "Each tool is a domain VERB keyed by an operation axis — e.g. POST /tool/memory {\"op\":\"read\",…},",
  "POST /tool/build {\"output\":\"rom\",…}, POST /tool/romPatch {\"op\":\"findPointer\",…}. The full per-tool",
  "parameter list is in the TOOL REFERENCE at the end of this doc (and /openapi.json).",
].join("\n");

/**
 * Build GET /skills/romdev/SKILL.md: frontmatter + skill preamble + shared body +
 * generated tool reference.
 * @param {{registry: Map<string,any>, agentsBody: string, version?: string}} args
 * @returns {string}
 */
export function buildSkillDoc({ registry, agentsBody, version }) {
  const frontmatter = [
    "---",
    "name: romdev",
    "description: Homebrew retro game development and ROM reverse-engineering for 18 platforms (NES, SNES, Game Boy/Color, Genesis, GBA, Atari 2600/7800, Lynx, C64, SMS, Game Gear, PC Engine, MSX, GameTank, N64, PlayStation, Dreamcast). Use when building, running, debugging, disassembling, asset-converting, or romhacking a retro game — drives bundled emulators and toolchains over HTTP. NEVER install a host compiler/emulator; romdev bundles all of them as WASM (use the build tool).",
    `metadata:`,
    `  version: "${version ?? "0.0.0"}"`,
    "---",
    "",
  ].join("\n");

  const body = sanitizeForSkillChannel((agentsBody || "").trim());
  const reference = skillToolReference(registry);

  // Update note — stamped with the running server's version. A saved skill is a
  // static snapshot (it doesn't auto-update), but this doc is GENERATED live from
  // the running server, so re-fetching always gives the current version. An agent
  // can check the running version two ways: the tool call POST /tool/catalog
  // {"op":"status"} → `romdevVersion`, or GET /healthz → `version`.
  const v = version ?? "0.0.0";
  const updateNote = [
    "## Keeping this skill current",
    `This skill was generated by romdev **v${v}** (it's a snapshot — it does not auto-update). ` +
    "romdev generates it live from the running server, so to update: run the latest `npx romdevtools`, " +
    `then re-fetch \`GET http://localhost:7331/skills/romdev/SKILL.md\` and overwrite your saved copy. ` +
    "To check whether you're stale, ask the running server its version — `POST /tool/catalog {\"op\":\"status\"}` " +
    "returns `romdevVersion` (or `GET /healthz` → `version`); if it's newer than the `metadata.version` above, re-fetch.",
  ].join("\n");

  return [
    frontmatter,
    skillPreamble,
    "\n" + updateNote,
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
    // Drop whole lines that are MCP-PROTOCOL or MCP-CONNECTION framing — they
    // mislead a skill reader (a skill is read/invoked, not "connected to", and
    // there's no session-id header / reconnect / "connect your agent" step here;
    // the skillPreamble already gives the skill-appropriate intro + prereq).
    if (/Mcp-Session-Id|re-?initialize|session not found|MCP client|MCP connection|MCP sessions/i.test(line)) continue;
    if (/connect your (agent|coding agent)|restart its MCP connection|restart your MCP|your MCP client should/i.test(line)) continue;

    let l = line
      // section header that frames romdev as "a server you connect to"
      .replace(/^##\s+What this server does\s*$/i, "## What romdev does")
      // descriptive MCP / server-connection phrasings → channel-neutral
      .replace(/\bthese MCP tools\b/gi, "these tools")
      .replace(/\bevery other MCP tool\b/gi, "every other tool")
      .replace(/\bMCP[- ]exposed\b/gi, "exposed")
      .replace(/\bsix MCP calls\b/gi, "six calls")
      .replace(/\bthe MCP server\b/gi, "romdev")
      .replace(/\bover MCP\b/gi, "over HTTP")
      .replace(/\bfor use outside MCP\b/gi, "for standalone use")
      .replace(/\bvia these MCP tools\b/gi, "via these tools")
      // "this server" / "the server" connection-model phrasing → "romdev"
      .replace(/\banything else this server can do\b/gi, "anything else romdev can do")
      .replace(/\bwhat this server does\b/gi, "what romdev does")
      .replace(/\bthe server tries to self-heal\b/gi, "romdev tries to self-heal")
      .replace(/\bthe rest of the server keeps working\b/gi, "the rest of romdev keeps working")
      .replace(/\bevery other tool \(build, run, screenshot, inspect\) is fully headless\b/gi,
        "every other tool (build, run, screenshot, inspect) is fully headless")
      .replace(/\bThe server runs on the same machine\b/gi, "romdev runs on the same machine")
      .replace(/\bthe biggest mistake agents make on this server\b/gi, "the biggest mistake agents make")
      .replace(/\bMCP\b/g, "romdev"); // catch-all: any remaining bare "MCP" → "romdev"
    kept.push(l);
  }
  let out = kept.join("\n");
  // Collapse any leading blank lines left by dropped header lines.
  out = out.replace(/^\s*\n+/, "");
  return out;
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

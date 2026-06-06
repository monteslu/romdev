// Register MCP tools on the server.
//
// The surface is ~34 consolidated domain tools (memory({op}), build({output}),
// breakpoint({on}), …) and EVERY one registers at session init. There is no
// progressive-disclosure / lean mode anymore: the dynamic loadCategory dance
// never propagated reliably to clients (they don't re-read tools/list after a
// list_changed notification), and the consolidated surface is small enough that
// loading it all up front is simply correct. `catalog({op:'categories'})` still
// exposes the category map for orientation — it's a guide, not a gate.
//
// The CATEGORIES array below still groups tools by purpose (used by catalog and
// by the internal one-shot "build succeeded → consider playtest" hint), and
// `disclosure.loadCategory("all")` is the internal "register every category"
// helper — NOT a user-facing tool.
//
// Design principle "narrow at entry, deep once in": categories don't
// gate access; they organize discoverability. Once loaded, primitives
// are fully usable.

import { randomUUID } from "node:crypto";
import { registerLifecycleTools } from "./lifecycle.js";
import { registerFrameTools } from "./frame.js";
import { registerInputTools } from "./input.js";
import { registerStateTools } from "./state.js";
import { registerMemoryTools } from "./memory.js";
import { registerToolchainTools } from "./toolchain.js";
import { registerPlaytestTools } from "./playtest.js";
import { registerPlatformTools as registerPlatformSpecificTools } from "./platform-tools.js";
import { registerPlatformTools } from "./platforms.js";
import { registerSymbolTools } from "./symbols.js";
import { registerRomIdTools } from "./rom-id.js";
import { registerDiffRomsTools } from "./diff-roms.js";
import { registerFreeSpaceTools } from "./free-space.js";
import { registerReinjectTools } from "./reinject.js";
import { registerSpliceChrTools } from "./splice-chr.js";
import { registerCartPartsTools } from "./cart-parts.js";
import { registerFontMapTools } from "./font-map.js";
import { registerDisasmTools } from "./disasm.js";
import { registerFindReferencesTools } from "./find-references.js";
import { registerRenderingContextTools } from "./rendering-context.js";
import { registerTraceVramSourceTools } from "./trace-vram-source.js";
import { registerRunUntilTools } from "./run-until.js";
import { registerWatchMemoryTools } from "./watch-memory.js";
import { registerAddressToSymbolTools } from "./address-to-symbol.js";
import { registerRecordTools } from "./record.js";
import { registerTileInspectTools } from "./tile-inspect.js";
import { registerAssetTools } from "./assets.js";
import { registerArtLoaderTools } from "./art-loaders.js";
import { registerSpritePipelineTools } from "./sprite-pipeline.js";
import { registerLospecTools } from "./lospec.js";
import { registerMetaSpriteTools } from "./metasprite-tools.js";
import { registerProjectTools } from "./project.js";
import { registerInputLayoutTools } from "./input-layout.js";
import { registerSnippetTools } from "./snippets.js";
import { registerPlatformDocsTools } from "./platform-docs.js";
import { registerAudioTools } from "./audio.js";
import { registerCheatTools } from "./cheats.js";
import { createDisclosure } from "../disclosure.js";
import { jsonContent, safeTool, withClearToolErrors } from "../util.js";
import { getHostOrNull, setDisclosure } from "../state.js";
import { MERGE_MAP } from "../tool-manifest.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// catalog({op:'whatsNew'}): the recent CHANGELOG + an old→new RENAME TABLE
// derived from MERGE_MAP (the single source of truth for the consolidation), so
// an agent resuming a handoff written against an older server can re-map every
// renamed tool in ONE read. Pre-1.0 the surface is consolidated freely with NO
// deprecated aliases (see the consolidation), which is exactly why this exists.
async function buildWhatsNew() {
  // old name → "newTool({axis:'oldOpName'})". The op value is best-effort: most
  // absorbed tools become an op whose name is a shortened form, so we surface the
  // axis + the new tool and let the tool's own description give the exact op enum.
  const renames = {};
  for (const [newTool, entry] of Object.entries(MERGE_MAP)) {
    if (entry.unchanged) continue;
    for (const old of entry.absorbs ?? []) {
      renames[old] = { nowOn: newTool, axis: entry.axis };
    }
  }
  // Recent CHANGELOG entries (top of the file = newest). Best-effort: if the file
  // isn't packaged in some install, return the rename table alone.
  let changelog = null;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/mcp/tools/ → package root is three up.
    const text = await readFile(join(here, "..", "..", "..", "CHANGELOG.md"), "utf8");
    // Keep the two most recent version sections.
    const sections = text.split(/^## /m);
    changelog = sections.slice(0, 3).join("## ").trim();
  } catch { /* changelog not present in this install */ }
  return {
    note: "Pre-1.0 the tool surface is consolidated freely with NO deprecated aliases. If a tool name from an older handoff is missing, it's almost certainly now an `op` (or other axis) on a domain tool — find it below, then read that tool's description for the exact op enum and params.",
    renameTable: renames,
    axisLegend: "Every domain tool is keyed by ONE axis: op (most), output (build), on (breakpoint), target (disasm), view (background), source (palette), stage (encodeArt), from (importArt). The value names the operation, e.g. romPatch({op:'findPointer'}).",
    ...(changelog ? { changelog } : { changelogNote: "CHANGELOG.md not bundled in this install." }),
  };
}

/**
 * Categories for progressive disclosure. Each entry's `register` is the
 * existing per-module registration function — we don't rewrite the
 * tools themselves, just defer when they're added to the server.
 *
 * `sessionKey` is threaded into every register fn so handlers can scope
 * `getHost(sessionKey)` etc. per MCP session. Toolchain/asset registers
 * that don't touch host accept the extra arg harmlessly.
 */
const CATEGORIES = [
  {
    name: "platforms",
    description: "Discover supported platforms, their cores, toolchains, and language matrices.",
    useWhen: ["scaffolding a new project", "checking which platforms are available", "looking up a platform's default language"],
    register: (s, z, k) => registerPlatformTools(s, z, k), // listPlatforms, resolvePlatform
  },
  {
    name: "run",
    description: "Load ROMs, step frames, take screenshots (PNG or ANSI/chafa for text-only agents), query host status.",
    useWhen: ["just built a ROM and want to run it", "stepping frames to verify behavior", "capturing screenshots", "text-only LLM that needs to 'see' the frame — use screenshot({format:'ascii'})"],
    register: (s, z, k) => { registerLifecycleTools(s, z, k); registerFrameTools(s, z, k); },
  },
  {
    name: "input",
    description: "Drive controllers, press buttons, learn each platform's hardware bit layout.",
    useWhen: ["scripting button presses to reach a game state", "writing input-reading asm and need the register format"],
    register: (s, z, k) => { registerInputTools(s, z, k); registerInputLayoutTools(s, z, k); },
  },
  {
    name: "state",
    description: "Save/load emulator snapshots, dump raw savestates for forensic inspection.",
    useWhen: ["want to repro a bug from a specific frame", "comparing two emulator moments", "investigating an opaque core"],
    register: (s, z, k) => registerStateTools(s, z, k),
  },
  {
    name: "memory",
    description: "Read/write platform memory regions: system_ram, save_ram, VRAM, plus platform extras (NES OAM, SNES CGRAM/ARAM/FillRAM).",
    useWhen: ["inspecting variable values during play", "verifying that an upload landed in VRAM/ARAM", "patching memory live"],
    register: (s, z, k) => registerMemoryTools(s, z, k),
  },
  {
    name: "debug",
    description: "Cross-platform debugging primitives: inspectSprites, inspectPalette, getCPUState (main/spc700/z80), getAudioState (dsp/psg/ym2612), disassemble, symbol lookup.",
    useWhen: ["sprites rendering wrong", "audio silent or distorted", "CPU stuck in unknown state", "need to read what existing ROM bytes do"],
    register: (s, z, k) => {
      registerPlatformSpecificTools(s, z, k); // inspectSprites/Palette, getCPUState, getDspState, ...
      registerSymbolTools(s, z, k);            // buildSourceWithDebug, resolveSymbol, lookupAddress, ...
      registerDisasmTools(s, z, k);            // disassemble, disassembleRom
      registerFindReferencesTools(s, z, k);    // findReferences
      registerRenderingContextTools(s, z, k);  // background{view} (map/renderState/rendered)
      registerTraceVramSourceTools(s, z, k);   // traceVramSource (Genesis VRAM-DMA source)
      registerTileInspectTools(s, z, k);       // tiles{op} (png/pixels/fingerprints/ascii/preview)
      registerAddressToSymbolTools(s, z, k);   // addressToSymbol — PC → C function name
      registerCheatTools(s, z, k);             // gameCheats (labeled RAM/code map), applyCheat, clearCheats
    },
  },
  {
    name: "assets",
    description: "Convert PNGs to platform tile formats, encode WAVs to BRR, scan ROMs to identify them.",
    useWhen: ["importing graphics or audio assets", "checking what a ROM file is"],
    register: (s, z, k) => { registerAssetTools(s, z, k); registerAudioTools(s, z, k); registerRomIdTools(s, z, k); registerDiffRomsTools(s, z, k); registerFreeSpaceTools(s, z, k); registerReinjectTools(s, z, k); registerSpliceChrTools(s, z, k); registerCartPartsTools(s, z, k); registerFontMapTools(s, z, k); registerArtLoaderTools(s, z, k); registerSpritePipelineTools(s, z, k); registerLospecTools(s, z, k); registerMetaSpriteTools(s, z, k); },
  },
  {
    name: "project",
    description: "Project scaffolding + starter snippets per platform.",
    useWhen: ["starting a new game from scratch", "looking up canonical patterns like NMI handler, OAM DMA, joypad read"],
    register: (s, z, k) => { registerProjectTools(s, z, k); registerSnippetTools(s, z, k); registerPlatformDocsTools(s, z); },
  },
  {
    name: "show",
    description: "Show the game to a human: playtest opens a native SDL window where your user can watch and play. The emulator stays live — every other tool (screenshot, readMemory, saveState, pause, stepFrames, ...) keeps working against the SAME running ROM. Call this category early so your human can see progress instead of waiting for build logs.",
    useWhen: ["agent just got a build working and wants the user to see it", "showing the user a feature mid-development", "letting the user play-test what was built", "any time the user would benefit from watching the game live"],
    register: (s, z, k) => { registerPlaytestTools(s, z, k); },
  },
  {
    name: "advanced",
    description: "Less common automation: runUntil (drive a ROM headlessly until a condition), watchMemory (cross-platform memory-write trace — see what code touched a RAM byte), runUntilWrite (step until target byte is written, return the PC), record (capture inputs for replay).",
    useWhen: ["want to automate reaching a specific game state", "tracking down which code writes a specific RAM byte (gameplay variable hunting)", "recording an input macro for regression testing"],
    register: (s, z, k) => { registerRunUntilTools(s, z, k); registerWatchMemoryTools(s, z, k); registerRecordTools(s, z, k); },
  },
];

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {any} z zod (passed in to avoid duplicate-package issues)
 * @param {string} sessionKey opaque per-McpServer identifier used to scope
 *   host state — each MCP session gets its own LibretroHost so two agents
 *   pointed at the same server can't clobber each other's loaded ROM /
 *   screenshots / memory reads.
 */
export function registerTools(server, z, sessionKey) {
  // Tests and other in-process callers may omit sessionKey — mint one so
  // host state is still isolated per registerTools() call.
  if (!sessionKey) sessionKey = randomUUID();
  // Clear validation errors for EVERY tool registered below: turns the SDK's
  // raw JSON validation dump into a plain sentence and catches unknown/misspelled
  // params (which the SDK otherwise drops silently). One wrap, all 34 tools.
  // This is what lets the param descriptions stay terse — the guidance lives in
  // the error (paid only on a bad call), not in every agent's initial context.
  server = withClearToolErrors(server, z);
  // ---- entry-tier disclosure manager ----
  const disclosure = createDisclosure(server, z, CATEGORIES, sessionKey);
  // Share with tool handlers outside this module (toolchain.js etc.) so
  // they can emit one-shot session hints (e.g. nudge to playtest after
  // the first successful build).
  setDisclosure(disclosure);

  // ---- ALWAYS-LOADED ENTRY TIER ----
  // catalog: what categories exist + the live session snapshot.
  server.tool(
    "catalog",
    "Orient yourself, keyed by `op`.\n" +
    "• op:'categories' (default) — the catalog of tool categories, each {name, description, useWhen[], loaded}. This server registers EVERY tool at session start, so this is just a map grouped by purpose for orientation, NOT a gate — you do NOT need to load anything before calling a tool.\n" +
    "• op:'status' — a snapshot of the current session: which platform's core/ROM is in the running host (if any), current frame count, last-loaded media, loaded categories. Call this when you've lost context across many tool calls and want to re-ground.\n" +
    "• op:'whatsNew' — the recent CHANGELOG + an OLD→NEW tool RENAME TABLE. Call this FIRST if you're resuming work from a handoff written against an older server: pre-1.0 the surface is consolidated freely (no deprecated aliases), so a name you remember may now be an `op` on a domain tool. This maps them in one read instead of probing each tool.",
    {
      op: z.enum(["categories", "status", "whatsNew"]).default("categories")
        .describe("categories=tool-category catalog; status=live session snapshot (host/platform/frameCount/media); whatsNew=recent CHANGELOG + old→new tool rename table."),
    },
    safeTool(async ({ op = "categories" }) => {
      if (op === "whatsNew") {
        return jsonContent(await buildWhatsNew());
      }
      if (op === "status") {
        const host = getHostOrNull(sessionKey);
        const cats = disclosure.listCategories();
        const base = host
          ? { ...host.getStatus() }
          : { loaded: false, hint: "no host yet; call loadMedia (in category 'run') to load a ROM" };
        return jsonContent({
          ...base,
          loadedCategories: cats.filter((c) => c.loaded).map((c) => c.name),
          unloadedCategories: cats.filter((c) => !c.loaded).map((c) => c.name),
        });
      }
      const categories = disclosure.listCategories();
      return jsonContent({
        categories,
        note: "Every tool registers at session init — this catalog is just a map grouped by purpose, NOT a gate. Call any tool by name directly.",
        humanInTheLoopHint: "Iterate INTERNALLY on screenshots first (build({output:'run'}) returns one inline; frame({op:'screenshot'/'stepAndShot'}) re-shoots the live host) — don't open a window to debug. Once the game actually boots and shows the feature you're working on, call playtest({}) so your human can watch and play it live. Opening a window on a black screen or a crash just wastes the human's attention — show them something that works.",
      });
    }),
  );

  // loadCategory + describeTool DELETED with the progressive-disclosure path:
  // the whole surface is ~34 tools now and every one registers at session init,
  // so the dynamic lean-mode dance (which never worked reliably — clients don't
  // re-read tools/list after list_changed) has no reason to exist. `catalog`
  // still exposes the category map for orientation. (See the consolidation.)

  // getStatus is now catalog({op:'status'}).

  // build is the universal build verb. Almost every workflow
  // starts with "build my ROM," so we register it at entry tier
  // unconditionally — but the rest of the toolchain category stays
  // deferred (runSource, listToolchains, etc.).
  registerToolchainTools(server, z, sessionKey);

  // playtest is ALSO entry-tier. The whole point of the server is getting
  // games in front of people — so the "open a native window the human can
  // watch/play" tool must be callable the instant there's a ROM, with no
  // loadCategory dance. Two separate agents got stuck because playtest sat
  // behind the 'show' category. It's still LISTED under 'show' for
  // discovery, but registered here so it's live from session start.
  // (registerCategorySafely skips the duplicate when 'show' loads.)
  registerPlaytestTools(server, z, sessionKey);

  // ---- AUTO-ARM THE FULL TOOL SURFACE ----
  // Progressive disclosure was causing more harm than good: agents needed
  // 4-5 serial loadCategory round-trips to arm a normal game-dev workflow
  // (run + assets + debug + memory + ...), discovered each missing category
  // only when a call failed, and re-called loadCategory in a loop — made far
  // worse when a session reconnects (re-arm cost). The full surface is ~36K
  // tokens; for a coding agent that's an acceptable one-time cost, and it
  // removes the thrash + the "I can't see the tool" confusion entirely.
  //
  // So by default we register EVERY category at session init. listCategories
  // / loadCategory still exist (idempotent, harmless) for clients that probe
  // Register EVERY category now — there is no lean/deferred mode anymore. The
  // surface is small enough (~34 tools) that loading it all up front is the
  // right call (the dynamic loadCategory dance never propagated reliably to
  // clients). `disclosure.loadCategory("all")` is just the internal "register
  // all categories" helper here, not a user-facing tool.
  try {
    disclosure.loadCategory("all");
  } catch (e) {
    console.error("[mcp] category registration failed:", e?.message ?? e);
  }
}

// ---- helper: which category owns a tool name? ----
// Used so describeTool's error message can name the category to load.
// Maintained by hand for now; if categories explode we can derive this
// by registering each category into a dummy server and comparing diffs.
const TOOL_OWNER = {
  // platforms category
  platform: "platforms",
  // run category
  loadMedia: "run", host: "run",
  frame: "run",
  // input category
  input: "input",
  // state category
  state: "state",
  // memory category
  memory: "memory",
  // debug category
  tiles: "debug", sprites: "debug",
  background: "debug", encodeArt: "assets",
  cpu: "debug", audioDebug: "debug",
  symbols: "debug",
  disasm: "debug",
  cheats: "debug",
  inspectTile: "debug",
  // assets category
  encodeAudio: "assets",
  cart: "assets",
  listRoms: "assets", romPatch: "assets", validateRom: "assets",
  assembleSnippet: "assets",

  text: "assets",
  importArt: "assets",
  palette: "debug",
  // project category
  scaffold: "project",
  // show category (was: advanced)
  playtest: "show",
  // advanced category
  runUntil: "advanced",
  watch: "advanced", breakpoint: "advanced", dmaTrace: "advanced",
  recordSession: "advanced",
  // entry tier itself
  catalog: "entry",
  build: "entry", listRunnableFormats: "entry",
};

function ownerCategoryOf(name) {
  return TOOL_OWNER[name] ?? null;
}

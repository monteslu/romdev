// Register MCP tools on the server, with progressive disclosure.
//
// Entry tier (always loaded at session init):
//   - listCategories, loadCategory  → discover + load additional tools
//   - describeTool                  → introspect a tool's schema/usage
//   - getStatus                     → cheap "what's loaded right now?" re-orient
//   - buildSource                   → universal build verb (every workflow needs)
//   - playtest / playtestStop / playtestStatus → open a live window for the
//       human ASAP. The server exists to get games in front of people, so the
//       human-visibility tools must never sit behind a loadCategory call.
//
// Everything else lives in deferred categories. Agents call
// `loadCategory({category:"debug"})` to register the debug tier into
// their session. `loadCategory({category:"all"})` is the power-user
// escape hatch — registers everything in one call.
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
import { registerPreviewTileTools } from "./preview-tile.js";
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
import { jsonContent, safeTool } from "../util.js";
import { getHostOrNull, setDisclosure } from "../state.js";

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
      registerTileInspectTools(s, z, k);       // tile/CHR inspection helpers
      registerAddressToSymbolTools(s, z, k);   // addressToSymbol — PC → C function name
      registerCheatTools(s, z, k);             // gameCheats (labeled RAM/code map), applyCheat, clearCheats
    },
  },
  {
    name: "assets",
    description: "Convert PNGs to platform tile formats, encode WAVs to BRR, scan ROMs to identify them.",
    useWhen: ["importing graphics or audio assets", "checking what a ROM file is"],
    register: (s, z, k) => { registerAssetTools(s, z, k); registerAudioTools(s, z, k); registerRomIdTools(s, z, k); registerDiffRomsTools(s, z, k); registerFreeSpaceTools(s, z, k); registerReinjectTools(s, z, k); registerSpliceChrTools(s, z, k); registerCartPartsTools(s, z, k); registerPreviewTileTools(s, z, k); registerFontMapTools(s, z, k); registerArtLoaderTools(s, z, k); registerSpritePipelineTools(s, z, k); registerLospecTools(s, z, k); registerMetaSpriteTools(s, z, k); },
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
  // ---- entry-tier disclosure manager ----
  const disclosure = createDisclosure(server, z, CATEGORIES, sessionKey);
  // Share with tool handlers outside this module (toolchain.js etc.) so
  // they can emit one-shot session hints (e.g. nudge to playtest after
  // the first successful build).
  setDisclosure(disclosure);

  // ---- ALWAYS-LOADED ENTRY TIER ----
  // listCategories: what's available?
  server.tool(
    "listCategories",
    "Return the catalog of tool categories. Each entry has {name, description, useWhen[], loaded}. NOTE: by default this server registers EVERY tool at session start — you do NOT need to call loadCategory before using a tool; they're all callable already. This catalog is just a map of what exists, grouped by purpose. (Only if the server is running in lean mode, ROMDEV_LEAN_TOOLS=1, are non-entry tools deferred — then loadCategory registers them.)",
    {},
    safeTool(async () => {
      const categories = disclosure.listCategories();
      return jsonContent({
        categories,
        entryTier: ["listCategories", "loadCategory", "describeTool", "getStatus", "buildSource", "playtest", "playtestStop", "playtestStatus"],
        powerUserHint: "Call loadCategory({category:\"all\"}) to register every category at once — skips the discovery dance for capable agents.",
        humanInTheLoopHint: "Iterate INTERNALLY on screenshots first (runSource returns one inline; stepAndScreenshot/screenshot re-shoot the live host) — don't open a window to debug. Once the game actually boots and shows the feature you're working on, call playtest({}) so your human can watch and play it live. playtest is entry-tier (no loadCategory needed). Opening a window on a black screen or a crash just wastes the human's attention — show them something that works.",
      });
    }),
  );

  // loadCategory: register the deferred tools for one (or all) categories.
  // Response includes the full tool schemas just registered, so the agent
  // can call them immediately without waiting for tools/list_changed to
  // propagate to its client (which is async).
  server.tool(
    "loadCategory",
    "Register a tool category into your session. After this call the returned tools are callable immediately — no need to wait for tools/list_changed. Pass `category:\"all\"` to load every category in one call (power-user escape hatch). Idempotent: re-loading a loaded category is safe.\n\n" +
    "RESPONSE: by default returns just {name, description} per tool to keep the response small (loading the full 65-tool surface with schemas can exceed the tool-output cap). Call `describeTool({name})` to get the full schema for a specific tool when you need it. Pass `verbose:true` to get full schemas inline — only useful if you're confident the response will fit.",
    {
      category: z.string().describe("Category name from listCategories(), or 'all' to load everything."),
      verbose: z.boolean().default(false).describe("If true, include each tool's full parameter schema in the response (large). Default: brief {name, description} only — call describeTool for individual schemas."),
    },
    safeTool(async ({ category, verbose }) => {
      const r = disclosure.loadCategory(category, { verbose });
      return jsonContent({
        loaded: r.loaded,
        alreadyLoaded: r.alreadyLoaded,
        toolsRegistered: r.tools.length,
        tools: r.tools,
        hint: r.tools.length > 0
          ? `${r.tools.length} tools are now callable. Call them by name directly; don't wait for tools/list_changed.${verbose ? "" : " Call describeTool({name}) for a tool's full schema."}`
          : `Category was already loaded; nothing new registered.`,
      });
    }),
  );

  // describeTool: get a tool's schema + description without crawling internals.
  server.tool(
    "describeTool",
    "Return the full schema, description, and parameters of a named tool. Use this when listCategories or loadCategory shows you a tool name but you want to know what params it takes before calling it.",
    {
      name: z.string().describe("Exact tool name (case-sensitive)."),
    },
    safeTool(async ({ name }) => {
      const desc = disclosure.describe(name);
      if (!desc) {
        // Structured error: name the category that owns this tool, if any,
        // so the agent knows what to load. The category index lives in
        // TOOL_OWNER below; we keep it in sync with the register fns.
        const owner = ownerCategoryOf(name);
        if (owner) {
          throw new Error(
            `tool '${name}' is not loaded in this session. ` +
            `It belongs to category '${owner}'. ` +
            `Call loadCategory({category:"${owner}"}) to register it, then call describeTool again.`
          );
        }
        throw new Error(`unknown tool '${name}'. Call listCategories() to see what's available.`);
      }
      return jsonContent(desc);
    }),
  );

  // getStatus: cheap re-orient. Returns what's loaded, what session looks like.
  server.tool(
    "getStatus",
    "Return a snapshot of the current session: which categories are loaded, which platform's core/ROM is in the running host (if any), current frame count, last-loaded media. Call this when you've lost context across many tool calls and want to re-ground before proceeding.",
    {},
    safeTool(async () => {
      const host = getHostOrNull(sessionKey);
      const cats = disclosure.listCategories();
      // Flatten host status to top-level so legacy callers (and the
      // old lifecycle getStatus shape) keep working — `frameCount`,
      // `loaded`, `platform`, etc. live where they always did. PD
      // metadata (loadedCategories) is additive on the side.
      const base = host
        ? { ...host.getStatus() }
        : { loaded: false, hint: "no host yet; call loadMedia (in category 'run') to load a ROM" };
      return jsonContent({
        ...base,
        loadedCategories: cats.filter((c) => c.loaded).map((c) => c.name),
        unloadedCategories: cats.filter((c) => !c.loaded).map((c) => c.name),
      });
    }),
  );

  // buildSource is the universal build verb. Almost every workflow
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
  // them, and a token-constrained client can opt back into lean mode with
  // ROMDEV_LEAN_TOOLS=1 (only the entry tier loads; agent calls loadCategory
  // as needed).
  if (process.env.ROMDEV_LEAN_TOOLS !== "1") {
    try {
      disclosure.loadCategory("all");
    } catch (e) {
      console.error("[mcp] auto-load-all failed (continuing with entry tier):", e?.message ?? e);
    }
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
  readMemory: "memory", writeMemory: "memory",
  // debug category
  inspectPatternTiles: "debug", sprites: "debug",
  background: "debug", convertImageToTiles: "debug",
  imageToTilemap: "debug",
  getCPUState: "debug", audioDebug: "debug",
  buildSourceWithDebug: "debug", symbols: "debug",
  disasm: "debug",
  cheats: "debug",
  inspectTile: "debug",
  // assets category
  pcmToBrr: "assets", wavToXgm2Pcm: "assets",
  cart: "assets",
  listRoms: "assets", patchRom: "assets", patchFile: "assets", validateRom: "assets",
  assembleSnippet: "assets", diffRoms: "assets", findFreeSpace: "assets", spliceCHR: "assets",
  findPointerTo: "assets", makeStoredBlock: "assets", relocateBlock: "assets",

  previewTileArt: "assets",
  text: "assets",
  loadTilemap: "assets", loadAsepriteSheet: "assets", loadGifAnimation: "assets", loadSpriteSheet: "assets",
  cropSpriteSheet: "assets", quantizePngForPlatform: "assets", crossPlatformSpriteImport: "assets",
  validateGenesisTiles: "assets",
  palette: "debug",
  // project category
  scaffold: "project",
  // show category (was: advanced)
  playtest: "show", playtestStop: "show", playtestStatus: "show", playtestFramebuffer: "show",
  // advanced category
  runUntil: "advanced",
  watchMemory: "advanced", runUntilWrite: "advanced", findWriter: "advanced",
  recordSession: "advanced",
  // entry tier itself (so describeTool works for them)
  listCategories: "entry", loadCategory: "entry", describeTool: "entry", getStatus: "entry",
  buildSource: "entry", runSource: "entry", listRunnableFormats: "entry",
};

function ownerCategoryOf(name) {
  return TOOL_OWNER[name] ?? null;
}

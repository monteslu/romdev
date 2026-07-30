// Register MCP tools on the server.
//
// The surface is ~32 consolidated domain tools (memory({op}), build({output}),
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
import { registerPlaytestTools, getPlaytestHumanStatus } from "./playtest.js";
import { registerPlatformTools as registerPlatformSpecificTools } from "./platform-tools.js";
import { registerPlatformTools } from "./platforms.js";
import { registerSymbolTools } from "./symbols.js";
import { registerRomIdTools } from "./rom-id.js";
import { registerDiffRomsTools } from "./diff-roms.js";
import { registerFreeSpaceTools } from "./free-space.js";
import { registerReinjectTools } from "./reinject.js";
import { registerSpliceChrTools } from "./splice-chr.js";
import { registerCartPartsTools } from "./cart-parts.js";
import { registerNativePackTools } from "./native-pack.js";
import { registerWasmInspectTools } from "./wasm-inspect.js";
import { registerRegressionTools } from "./regression.js";
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
import { da65Available } from "../../toolchains/cc65/da65.js";
import { cc65Available } from "../../toolchains/cc65/cc65.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The debug capabilities the LOADED core (and the installed toolchain) actually
 * implement — so an agent picks a working trace strategy UP FRONT instead of
 * discovering the gaps through a string of `notSupported` returns (each a wasted
 * round trip). Capability varies by platform/core build and by whether the
 * cc65/da65 toolchain is installed, so it can't be assumed. Surfaced in
 * catalog({op:'status'}). Names are agent-facing (what you'd reach for), mapped
 * to the host's existing *Supported() probes.
 * @param {import("romdev-core-host/index.js").LibretroHost|null} host
 */
function hostCapabilities(host) {
  const da65 = da65Available();
  const cc65 = cc65Available();
  // Toolchain caps don't need a loaded host — report them either way so an agent
  // can check build/disasm availability before loading a ROM.
  const toolchains = {
    da65Disasm: da65,    // disasm({target:'rom'/'references'/'cfg'/'xrefs'/'functions'/'decompile'}) — all da65-backed
    cc65Build: cc65,     // build({platform:'nes'/'c64'/'atari7800'/'lynx'}) — cc65/ca65
    ld65Link: cc65,      // the ld65 linker (ships with cc65 in the same package)
    da65Toolchain: da65, // legacy alias for da65Disasm (kept for back-compat)
  };
  if (!host) return toolchains;
  const has = (m) => { try { return !!host[m]?.(); } catch { return false; } };
  // Native-runtime hosts (wasmcart/jsgame) expose a getCapabilities() descriptor
  // instead of the per-supported() methods. When present, surface its facts so an
  // agent picks the wasm/audio tools without probing by failure — the same reason
  // the emulator caps below exist. Guarded so libretro hosts are untouched.
  const nativeCaps = (() => {
    try { return host.getCapabilities?.() ?? null; } catch { return null; }
  })();
  const wasm = nativeCaps?.hasWasmIntrospection
    ? {
        kind: nativeCaps.kind,                     // 'wasmcart'
        wasmIntrospection: true,                   // wasm({op}) tool applies
        wasmMemoryBytes: (() => { try { return host.wasmMemorySize(); } catch { return 0; } })(),
        wasmExportCount: (() => { try { return host.wasmExports().length; } catch { return 0; } })(),
        audioCapture: !!nativeCaps.hasAudio,       // audioDebug({op:'record'})
      }
    : {};
  return {
    pcBreakpoint: has("pcBreakSupported"),       // breakpoint({on:'pc'})
    watchpointExact: has("watchpointSupported"), // breakpoint({on:'write', precision:'exact'}) + condition filter
    readWatch: has("readWatchSupported"),        // breakpoint({on:'read'})
    rangeWatch: has("vramWatchSupported"),       // watch({on:'range'}) (VRAM-port trace)
    registerWrite: has("setRegSupported"),       // register write + callSubroutine
    registerSnapshot: has("regSnapSupported"),   // registersAtHit on a break
    cheats: has("cheatsSupported"),              // cheats({op:'apply'}) via retro_cheat_set
    diskImage: has("diskImageSupported"),        // C64 .d64 loadMedia
    keyboard: has("keyboardSupported"),          // keyboard input (C64/MSX)
    ...wasm,
    ...toolchains,
  };
}

// Package version — surfaced by catalog({op:'status'}) so an agent can
// check the running romdev version with a plain TOOL CALL (works over MCP AND the
// HTTP/skill surface), e.g. to detect a saved skill is stale. (GET /healthz also
// reports it for non-tool HTTP clients.)
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

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
    useWhen: ["before forking an example for a new game", "checking which platforms are available", "looking up a platform's default language"],
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
    description: "Cross-platform debugging + reverse-engineering: inspectSprites, inspectPalette, getCPUState (main/spc700/z80, plus the 3D CPUs: MIPS R3000/R4300, SH-4), getAudioState (dsp/psg/ym2612/… + spu/ai/aica for PS1/N64/Dreamcast), and the disasm/RE engine — disassemble (raw/ROM/rebuildable-project), plus the Rizin/Ghidra ops disasm({target:'cfg'|'xrefs'|'functions'|'decompile'}) (control-flow graphs, deep xrefs, auto-detected functions, and C pseudocode) and symbols({op:'analyze'}) (one-shot structural map).",
    useWhen: ["sprites rendering wrong", "audio silent or distorted", "CPU stuck in unknown state", "need to read what existing ROM bytes do", "reverse-engineering an unknown ROM — carve its functions/structure before labeling them live", "want C-like pseudocode to understand a routine"],
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
      registerWasmInspectTools(s, z, k);       // wasm{op} — WASM-runtime cart introspection (wasmcart)
    },
  },
  {
    name: "assets",
    description: "Convert PNGs to platform tile formats, encode WAVs to BRR, scan ROMs to identify them.",
    useWhen: ["importing graphics or audio assets", "checking what a ROM file is"],
    register: (s, z, k) => { registerAssetTools(s, z, k); registerAudioTools(s, z, k); registerRomIdTools(s, z, k); registerDiffRomsTools(s, z, k); registerFreeSpaceTools(s, z, k); registerReinjectTools(s, z, k); registerSpliceChrTools(s, z, k); registerCartPartsTools(s, z, k); registerNativePackTools(s, z, k); registerFontMapTools(s, z, k); registerArtLoaderTools(s, z, k); registerSpritePipelineTools(s, z, k); registerLospecTools(s, z, k); registerMetaSpriteTools(s, z, k); },
  },
  {
    name: "project",
    description: "The example-game library (fork/list/show) + starter snippets per platform.",
    useWhen: ["starting a new game (ALWAYS fork the nearest example — never a blank file)", "looking up canonical patterns like NMI handler, OAM DMA, joypad read"],
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
    description: "Less common automation + MOTION/TELEMETRY tracing: runUntil (drive a ROM headlessly until a condition), watch({on:'mem', format:'series'}) (a compact value-vs-frame CURVE per byte — the primitive for velocity/scroll/sprite-position over time), runUntilWrite (step until target byte is written, return the PC), recordSession (hold/script input over N frames while sampling memory + screenshots into an analyzable timeline — use it to diagnose game-FEEL issues: choppy movement, scroll jumps, camera-vs-sprite desync, NOT just input macros).",
    useWhen: ["want to automate reaching a specific game state", "tracking down which code writes a specific RAM byte (gameplay variable hunting)", "diagnosing why movement/scrolling feels choppy or wrong — sample sprite X + scroll regs over frames with recordSession or watch series", "recording an input macro for regression testing"],
    register: (s, z, k) => { registerRunUntilTools(s, z, k); registerWatchMemoryTools(s, z, k); registerRecordTools(s, z, k); registerRegressionTools(s, z, k); },
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
  // params (which the SDK otherwise drops silently). One wrap, all 32 tools.
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
    "• op:'status' — a snapshot of the current session: which platform's core/ROM is in the running host (if any), current frame count, last-loaded media, loaded categories. Call this when you've lost context across many tool calls and want to re-ground.",
    {
      op: z.enum(["categories", "status"]).default("categories")
        .describe("categories=tool-category catalog; status=live session snapshot (romdevVersion + serverPid/serverStartedAt/serverUptimeSeconds + host/platform/frameCount/media + a `capabilities` map of which debug ops the loaded core/toolchain implement — call this to check the running version, pick a working trace strategy before probing by failure, or DETECT a server restart: an unprompted restart discards every host/ROM/state, and a changed serverPid is how a session tells that apart from 'I never loaded a ROM')."),
    },
    safeTool(async ({ op = "categories" }) => {
      if (op === "status") {
        const host = getHostOrNull(sessionKey);
        const cats = disclosure.listCategories();
        const base = host
          ? { ...host.getStatus() }
          : { loaded: false, hint: "no host yet; call loadMedia (in category 'run') to load a ROM" };
        // Human co-drive signals: an agent re-grounding mid-session needs to
        // know a human is playing in a playtest window BEFORE it fights them
        // for input/stepping (pause, or use a second session).
        const human = getPlaytestHumanStatus(sessionKey);
        // Process identity + age, so a session can DETECT a server restart.
        //
        // A restart between two consecutive calls seconds apart silently
        // discarded all emulator state; the error text on the next call was good
        // (it names the three causes and the recovery), but nothing let the
        // session notice the event itself, log it, or tell "the server restarted"
        // apart from "I never loaded a ROM". A pid that changed or an uptime
        // that went backwards is proof, and costs nothing to report.
        const uptimeSeconds = Math.round(process.uptime());
        const startedAt = new Date(Date.now() - uptimeSeconds * 1000).toISOString();
        return jsonContent({
          romdevVersion: PKG_VERSION,
          serverPid: process.pid,
          serverStartedAt: startedAt,
          serverUptimeSeconds: uptimeSeconds,
          ...(uptimeSeconds < 120
            ? { serverRecentlyStarted: `This server process is only ${uptimeSeconds}s old. If your session is older than that, it RESTARTED under you and every host/ROM/state is gone — re-run loadMedia; a fresh boot is the recovery point. Compare serverPid across calls to detect this without guessing.` }
            : {}),
          ...base,
          // Which debug ops the loaded core + installed toolchain implement, so
          // an agent picks a working trace strategy up front instead of probing
          // by failure (~4 dead calls/session). v0.41.0 feedback #2 (002129).
          capabilities: hostCapabilities(host),
          playtestWindowOpen: human.windowOpen,
          ...(human.windowOpen
            ? {
                humanInputActive: human.humanInputActive,
                ...(human.framesSinceHumanInput != null ? { framesSinceHumanInput: human.framesSinceHumanInput } : {}),
                ...(human.humanInputActive
                  ? { humanInputNote: "A human is ACTIVELY playing in the playtest window — their input overwrites yours each tick and real-time stepping races yours. host({op:'pause'}) to inspect, or use a second session (different x-romdev-session) for deterministic work." }
                  : {}),
              }
            : {}),
          loadedCategories: cats.filter((c) => c.loaded).map((c) => c.name),
          unloadedCategories: cats.filter((c) => !c.loaded).map((c) => c.name),
        });
      }
      const categories = disclosure.listCategories();
      return jsonContent({
        romdevVersion: PKG_VERSION,
        categories,
        note: "Every tool registers at session init — this catalog is just a map grouped by purpose, NOT a gate. Call any tool by name directly.",
        humanInTheLoopHint: "Iterate INTERNALLY on screenshots first (build({output:'run'}) returns one inline; frame({op:'screenshot'/'stepAndShot'}) re-shoots the live host) — don't open a window to debug. Once the game actually boots and shows the feature you're working on, call playtest({}) so your human can watch and play it live. Opening a window on a black screen or a crash just wastes the human's attention — show them something that works.",
      });
    }),
  );

  // loadCategory + describeTool DELETED with the progressive-disclosure path:
  // the whole surface is ~32 tools now and every one registers at session init,
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
  // surface is small enough (~32 tools) that loading it all up front is the
  // right call (the dynamic loadCategory dance never propagated reliably to
  // clients). `disclosure.loadCategory("all")` is just the internal "register
  // all categories" helper here, not a user-facing tool.
  try {
    disclosure.loadCategory("all");
  } catch (e) {
    console.error("[mcp] category registration failed:", e?.message ?? e);
  }
}


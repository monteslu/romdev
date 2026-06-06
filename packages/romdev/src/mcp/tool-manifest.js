// Tool manifest — the SINGLE SOURCE OF TRUTH for the consolidated tool surface.
//
// The 132→34 consolidation (see internal CONSOLIDATION_PLAN) merges narrow tools
// into domain tools with a typed operation axis. This manifest records, for each
// consolidated tool, the OLD tools it absorbs and the axis it routes on — so:
//   1. a coverage-gate test can assert every old tool name maps to exactly one
//      new tool (no capability silently dropped, no dupe);
//   2. a tool-count budget test can fail the build if the surface regrows;
//   3. docs + the rename map for downstream agents derive from one place.
//
// GOVERNANCE: a new capability is a new PARAMETER/op-value on an existing tool by
// default — NOT a new top-level tool. Adding an entry here is a deliberate act the
// budget test surfaces at PR time.
//
// Each MERGE_MAP entry: newTool → { absorbs:[...oldNames], axis:'op'|'as'|... }.
// `absorbs: []` + `unchanged:true` means the tool kept its name (no merge).
// This map grows one domain at a time as each consolidated tool lands.

export const MERGE_MAP = {
  // ── files (generic disk I/O) ──
  files: { absorbs: ["writeAsset", "readAsset", "listAssets"], axis: "op" },
  // ── cheats (DB lookup/search + apply/clear + make) ──
  cheats: { absorbs: ["gameCheats", "searchCheats", "applyCheat", "clearCheats", "makeCheat"], axis: "op" },
  // ── text (custom-font learn/encode/find for romhacking) ──
  text: { absorbs: ["learnFontMap", "encodeTextForRom", "findEncodedText"], axis: "op" },
  // ── symbols (name↔addr, memory map, PC→symbol). buildSourceWithDebug stays for `build`. ──
  symbols: { absorbs: ["resolveSymbol", "lookupAddress", "getMemoryMap", "listSymbols", "addressToSymbol"], axis: "op" },
  // ── disasm (raw bytes / ROM / project / references) ──
  disasm: { absorbs: ["disassemble", "disassembleRom", "disassembleProject", "findReferences"], axis: "target" },
  // ── state (save/load/list/export/dump/diff; diffState moved here from memory.js) ──
  state: { absorbs: ["saveState", "loadState", "listStates", "exportState", "dumpState", "diffState"], axis: "op" },
  // ── input (set/press/sequence/navigate/layout; getInputLayout folded in) ──
  input: { absorbs: ["setInput", "pressButton", "inputSequence", "navigate", "getInputLayout"], axis: "op" },
  // ── platform (list/resolve/toolchains/docs/doc; spans platforms.js+platform-docs.js+toolchain.js) ──
  platform: { absorbs: ["listPlatforms", "resolvePlatform", "listToolchains", "installToolchain", "listPlatformDocs", "getPlatformDoc"], axis: "op" },
  // ── host (unload/shutdown/reset/pause/resume FSM; loadMedia + getStatus stay separate) ──
  host: { absorbs: ["unloadMedia", "shutdown", "reset", "pause", "resume"], axis: "op" },
  // ── frame (step/screenshot/stepAndShot/stepInstruction; stepInstruction folded from watch-memory.js) ──
  frame: { absorbs: ["stepFrames", "screenshot", "stepAndScreenshot", "stepInstruction"], axis: "op" },
  // ── scaffold (project/game + snippets; patchGbHeader stays standalone in project.js) ──
  scaffold: { absorbs: ["createProject", "createGame", "starterSnippets", "copyStarterSnippets"], axis: "op" },
  // ── cart (identify/extract/wrap; identifyRom from rom-id.js, rest from cart-parts.js) ──
  cart: { absorbs: ["identifyRom", "extractCart", "wrapRomFromParts"], axis: "op" },
  // ── palette (live/platformMaster/lospec; spans platform-tools.js + lospec.js) ──
  palette: { absorbs: ["inspectPalette", "getPlatformPalettePng", "getLospecPalette"], axis: "source" },
  // ── audioDebug (inspect/record; getAudioState from platform-tools.js, recordAudio from audio.js; pcmToBrr/wavToXgm2Pcm stay) ──
  audioDebug: { absorbs: ["getAudioState", "recordAudio"], axis: "op" },
  // ── sprites (inspect OAM + meta-sprite pipeline; inspectSprites from platform-tools.js, rest from metasprite-tools.js; validateGenesisTiles stays for encodeArt) ──
  sprites: { absorbs: ["inspectSprites", "groupVisibleSprites", "previewVisibleSprites", "captureMetaSprite", "renderMetaSpritePreview", "emitMetaSpriteRenderer", "extractSpriteFromScreenshot"], axis: "op" },
  // ── background (tilemap/render-state; inspectBackgroundMap from platform-tools.js, getRenderingContext from rendering-context.js, whichTilesAreRendered from which-tiles.js) ──
  background: { absorbs: ["inspectBackgroundMap", "getRenderingContext", "whichTilesAreRendered"], axis: "view" },
  // ── tiles (decode/render tile bytes; inspectPatternTiles from platform-tools.js, getTile/tileFingerprints/tilesAscii from tile-inspect.js, extractSpriteSheet from rom-id.js, previewTileArt from preview-tile.js) ──
  tiles: { absorbs: ["inspectPatternTiles", "getTile", "tileFingerprints", "tilesAscii", "extractSpriteSheet", "previewTileArt"], axis: "as" },
  // ── encodeArt (PNG→native art; convertImageToTiles+imageToTilemap from platform-tools.js, quantizePngForPlatform+cropSpriteSheet from sprite-pipeline.js, validateGenesisTiles from metasprite-tools.js) ──
  encodeArt: { absorbs: ["convertImageToTiles", "imageToTilemap", "quantizePngForPlatform", "cropSpriteSheet", "validateGenesisTiles"], axis: "stage" },
  // ── importArt (editor-file/ROM → native tiles; load* from art-loaders.js, crossPlatformSpriteImport from sprite-pipeline.js as from:'rom') ──
  importArt: { absorbs: ["loadAsepriteSheet", "loadGifAnimation", "loadSpriteSheet", "loadTilemap", "crossPlatformSpriteImport"], axis: "from" },
  // ── memory (read/write/search; all 8 from memory.js) ──
  memory: { absorbs: ["readMemory", "writeMemory", "readCartRom", "snapshotMemory", "diffMemory", "classifyRegion", "searchValue", "searchNext"], axis: "op" },
  // ── cpu (read/drive; getCPUState from platform-tools.js, setRegister/callSubroutine/decompressWith from watch-memory.js) ──
  cpu: { absorbs: ["getCPUState", "setRegister", "callSubroutine", "decompressWith"], axis: "op" },
  // ── breakpoint (STOP-on-first; all 4 from watch-memory.js) ──
  breakpoint: { absorbs: ["findWriter", "runUntilWrite", "runUntilPC", "runUntilRead"], axis: "on" },
  // ── watch (LOG-ALL; all 3 from watch-memory.js) ──
  watch: { absorbs: ["watchMemory", "watchRange", "logPCRange"], axis: "on" },
  // ── dmaTrace (Genesis VDP-DMA; watchDma from watch-memory.js, traceVramSource from trace-vram-source.js) ──
  dmaTrace: { absorbs: ["watchDma", "traceVramSource"], axis: "precision" },
  // ── build (compile/run; buildSource/buildProject/runSource from toolchain.js, buildSourceWithDebug from symbols.js). ENTRY-TIER. ──
  build: { absorbs: ["buildSource", "buildSourceWithDebug", "buildProject", "runSource"], axis: "output" },
  // ── romPatch (8-op ROM-hack toolkit; patchFile/patchRom from rom-id.js, spliceCHR from splice-chr.js, relocateBlock/makeStoredBlock/findPointerTo from reinject.js, findFreeSpace from free-space.js, diffRoms from diff-roms.js) ──
  romPatch: { absorbs: ["patchFile", "patchRom", "spliceCHR", "relocateBlock", "makeStoredBlock", "findFreeSpace", "findPointerTo", "diffRoms"], axis: "op" },
  // ── catalog (orient; listCategories + getStatus, both entry-tier in index.js) ──
  catalog: { absorbs: ["listCategories", "getStatus"], axis: "op" },
  // ── playtest (show-a-human window FSM; all 4 from playtest.js). ENTRY-TIER. ──
  playtest: { absorbs: ["playtestStop", "playtestStatus", "playtestFramebuffer"], axis: "op" },
  // ── encodeAudio (external clip → native sample format; pcmToBrr + wavToXgm2Pcm from audio.js) ──
  encodeAudio: { absorbs: ["pcmToBrr", "wavToXgm2Pcm"], axis: "target" },
};

/** Every OLD tool name that the consolidation removes (absorbed into a new tool). */
export function absorbedToolNames() {
  const names = [];
  for (const entry of Object.values(MERGE_MAP)) {
    if (entry.absorbs) names.push(...entry.absorbs);
  }
  return names;
}

/** The consolidated (new) tool names this manifest defines. */
export function consolidatedToolNames() {
  return Object.keys(MERGE_MAP);
}

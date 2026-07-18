// chafa-render.js — wrap @monteslu/chafa-wasm into a "give me an RGBA
// buffer + target cell size, get back an ANSI string" helper.
//
// One char cell = 2 vertical pixels via half-block symbols (▀ ▄ █),
// so a 256×224 NES frame at 1:1 pixel mapping is 256 cols × 112 rows.
// Most agents will pass smaller dimensions (e.g. cols=80) and let
// chafa downsample for a readable context-window-sized view.
//
// Chafa init is a few hundred ms — keep the canvas + symbol map alive
// between calls. setupCanvas() reuses the canvas when dimensions and
// settings haven't changed (same pattern as retroemu's videoWorker).

let chafa = null;
let initPromise = null;

let symbolMap = 0;
let canvasConfig = 0;
let canvas = 0;
let lastSettings = "";

// chafa.h CHAFA_SYMBOL_TAG_* bitmask flags. Real values cross-checked
// against retroemu's videoWorker.js (which uses this lib in
// production). My original constants were guessed and wrong — e.g.
// I had BLOCK=1, ASCII=2; real BLOCK=0x8, ASCII=0x4000. The bad
// values silently picked an unrelated tag, which is why "ascii"
// mode was still rendering Unicode block glyphs.
/* eslint-disable no-unused-vars -- the full chafa tag enum is kept for reference; not all are used. */
const TAG_SPACE     = 0x1;
const TAG_SOLID     = 0x2;
const TAG_STIPPLE   = 0x4;
const TAG_BLOCK     = 0x8;
const TAG_BORDER    = 0x10;
const TAG_QUAD      = 0x80;
const TAG_VHALF     = 0x200;
const TAG_BRAILLE   = 0x800;
const TAG_ASCII     = 0x4000;
const TAG_SEXTANT   = 0x400000;
const TAG_OCTANT    = 0x4000000;
/* eslint-enable no-unused-vars */

const SYMBOL_TAGS = {
  // Pure ASCII glyphs (space + printable 7-bit) — most text-shaped,
  // safest for any environment, lossiest visually.
  ascii:     TAG_SPACE | TAG_ASCII,
  // Half-block (▀ ▄ █) — 1 cell = 2 stacked pixels (top fg / bottom bg).
  // Best image fidelity for retro frames; requires Unicode.
  halfblock: TAG_SPACE | TAG_VHALF,
  // Mixed half/full-block + borders — chafa picks the best glyph
  // per cell. Denser than pure half-block.
  block:     TAG_SPACE | TAG_BLOCK | TAG_BORDER,
  // Quad (▘ ▝ ▖ ▗ ▙ etc.) — 1 cell = 2×2 pixels. Doubles horizontal
  // density at the cost of glyph variety.
  quad:      TAG_SPACE | TAG_QUAD,
  // Sextant (1 cell = 2×3 pixels) — Unicode 13+ font support required.
  sextant:   TAG_SPACE | TAG_SEXTANT,
};

// chafa canvas-mode constants (from chafa.h). Values cross-checked
// against retroemu's videoWorker.js which uses this exact lib in
// production. (I had these flipped originally — TRUECOLOR=0 not 5,
// FGBG=5 not 0 — which made `colors:'true'` silently render in
// no-color mode and emit zero SGR escapes.)
const COLOR_MODES = {
  true:  0,  // CHAFA_CANVAS_MODE_TRUECOLOR
  "256": 1,  // CHAFA_CANVAS_MODE_INDEXED_256
  "16":  3,  // CHAFA_CANVAS_MODE_INDEXED_16
  fgbg:  5,  // CHAFA_CANVAS_MODE_FGBG (no color, only fg/bg shape)
};

const CHAFA_OPTIMIZATION_ALL = 0xff;

async function loadChafa() {
  if (chafa) return chafa;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const mod = await import("@monteslu/chafa-wasm");
    let c = mod.default || mod;
    if (typeof c === "function") c = await c();
    chafa = c;
    return chafa;
  })();
  return initPromise;
}

function setupCanvas(termCols, termRows, symbols, colors) {
  const settings = `${termCols}x${termRows}|${symbols}|${colors}`;
  if (settings === lastSettings && canvas) return;

  // Tear down stale instances.
  if (canvas) { chafa._chafa_canvas_unref(canvas); canvas = 0; }
  if (canvasConfig) { chafa._chafa_canvas_config_unref(canvasConfig); canvasConfig = 0; }
  if (symbolMap) { chafa._chafa_symbol_map_unref(symbolMap); symbolMap = 0; }

  symbolMap = chafa._chafa_symbol_map_new();
  const tags = SYMBOL_TAGS[symbols] ?? SYMBOL_TAGS.halfblock;
  chafa._chafa_symbol_map_add_by_tags(symbolMap, tags);

  canvasConfig = chafa._chafa_canvas_config_new();
  chafa._chafa_canvas_config_set_geometry(canvasConfig, termCols, termRows);
  const mode = COLOR_MODES[colors] ?? COLOR_MODES.true;
  chafa._chafa_canvas_config_set_canvas_mode(canvasConfig, mode);
  chafa._chafa_canvas_config_set_symbol_map(canvasConfig, symbolMap);
  chafa._chafa_canvas_config_set_optimizations(canvasConfig, CHAFA_OPTIMIZATION_ALL);

  canvas = chafa._chafa_canvas_new(canvasConfig);
  lastSettings = settings;
}

// Serial mutex for the singleton canvas/symbolMap. Two concurrent
// renderRgbaToAnsi calls (different MCP sessions, or even one session
// firing back-to-back without awaiting) would race on the shared
// WASM-side state — at best garbled output, at worst a heap corruption
// crash. Chain everything onto a promise queue so only one render
// runs at a time.
let renderQueue = Promise.resolve();

/**
 * Render an RGBA8888 image to an ANSI escape-sequence string.
 *
 * Calls are serialized via an internal mutex — safe to invoke from
 * multiple concurrent contexts (e.g. two MCP sessions). Each call
 * still completes in <10ms so the queue doesn't grow.
 *
 * @param {Uint8Array} rgba   width*height*4 bytes
 * @param {number}     width  pixel width of `rgba`
 * @param {number}     height pixel height of `rgba`
 * @param {object}     opts
 * @param {number}     opts.cols    terminal columns to render into
 * @param {number}     opts.rows    terminal rows to render into
 * @param {string}     opts.symbols 'halfblock' | 'block' | 'quad' | 'sextant' | 'ascii'
 * @param {string}     opts.colors  'true' | '256' | '16' | 'fgbg'
 * @returns {Promise<string>} ANSI string ready to write to a terminal
 */
export async function renderRgbaToAnsi(rgba, width, height, opts) {
  const ticket = renderQueue.then(() => renderOnce(rgba, width, height, opts));
  // Replace the queue tail BEFORE awaiting, so subsequent callers
  // chain behind our work. Use .catch to swallow this caller's error
  // (it still propagates to the actual awaiter); without this, one
  // bad call would poison the queue and break every future call.
  renderQueue = ticket.catch(() => {});
  return ticket;
}

async function renderOnce(rgba, width, height, opts) {
  const c = await loadChafa();
  const cols    = opts.cols    | 0;
  const rows    = opts.rows    | 0;
  const symbols = opts.symbols || "ascii";
  const colors  = opts.colors  || "true";

  setupCanvas(cols, rows, symbols, colors);

  // Pump pixels into chafa WASM heap.
  const ptr = c._malloc(rgba.length);
  if (!ptr) throw new Error("chafa-render: out of WASM heap (rgba alloc)");
  try {
    c.HEAPU8.set(rgba, ptr);
    c._chafa_canvas_set_contents_rgba8(canvas, ptr, width, height, width * 4);
  } finally {
    c._free(ptr);
  }

  const gsPtr = c._chafa_canvas_build_ansi(canvas);
  if (!gsPtr) return "";
  const strPtr = c._g_string_free_and_steal(gsPtr);
  if (!strPtr) return "";
  try {
    return c.UTF8ToString(strPtr);
  } finally {
    c._free(strPtr);
  }
}

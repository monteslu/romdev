// lospec.js — R17 helper to fetch a CC0 retro palette from lospec.com
// by id, with optional snap to a target platform's master palette via
// nearest-neighbour. Feeds straight into quantizePngForPlatform's
// per-palette overrides.

import { jsonContent, safeTool } from "../util.js";
import { resolveIntent } from "../../platforms/common/intent.js";

/** lospec.com hosts each palette at https://lospec.com/palette-list/<id>.json. */
const LOSPEC_URL_BASE = "https://lospec.com/palette-list";

/**
 * Fetch a lospec palette by id (the URL slug, e.g. "kirokaze-gameboy").
 * @param {string} id
 * @returns {Promise<{name:string, colors:number[][], author?:string, url:string}>}
 */
async function fetchLospecPalette(id) {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(
      `getLospecPalette: id '${id}' looks malformed. Use the URL slug as it appears on lospec.com — ` +
      `lowercase letters, digits, and hyphens only (e.g. 'kirokaze-gameboy', 'pico-8', 'sweetie-16').`
    );
  }
  const url = `${LOSPEC_URL_BASE}/${id}.json`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`getLospecPalette: network fetch failed for ${url}: ${e.message}`);
  }
  if (res.status === 404) {
    throw new Error(
      `getLospecPalette: no palette named '${id}' found on lospec.com. ` +
      `Check the URL slug from the palette's page (https://lospec.com/palette-list/${id}).`
    );
  }
  if (!res.ok) {
    throw new Error(`getLospecPalette: lospec returned HTTP ${res.status} for ${url}.`);
  }
  const data = await res.json();
  // lospec JSON shape: { name, author, colors: [["RRGGBB", ...], ...] } — colors are hex strings.
  /** @type {string[]} */
  const rawColors = data.colors ?? [];
  const colors = rawColors.map((hex) => {
    const clean = String(hex).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
      throw new Error(`getLospecPalette: lospec '${id}' returned malformed color '${hex}'.`);
    }
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  });
  return {
    name: data.name ?? id,
    author: data.author,
    colors,
    url: `https://lospec.com/palette-list/${id}`,
  };
}

/**
 * Snap each color in `palette` to the nearest entry in `master`.
 * Used when the caller wants a lospec palette but the platform has a
 * fixed hardware palette (NES 2C02 master, etc.).
 */
function snapToMaster(palette, master) {
  return palette.map(([r, g, b]) => {
    let best = master[0];
    let bestD = Infinity;
    for (const [mr, mg, mb] of master) {
      const dr = r - mr, dg = g - mg, db = b - mb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = [mr, mg, mb]; }
    }
    return best;
  });
}

/**
 * Programmatic equivalent of the MCP tool. Exported for tests.
 *
 * @param {{id:string, asPlatform?:string}} args
 */
export async function getLospecPaletteImpl({ id, asPlatform }) {
  const fetched = await fetchLospecPalette(id);
  if (!asPlatform) {
    return {
      id,
      name: fetched.name,
      author: fetched.author,
      url: fetched.url,
      colors: fetched.colors,
      snappedToMaster: false,
    };
  }
  // Snap to platform master where one exists. Today: NES only — other
  // platforms have full 24-bit color and don't need snapping. The
  // platform-specific snap functions are kept private to their tool
  // files; for NES we mirror the NES_MASTER table inline so this module
  // stays self-contained.
  if (asPlatform === "nes") {
    // Re-export the table by re-importing — keeps sprite-pipeline.js the
    // single source of truth for the NES master palette.
    const { snapToNesMasterPublic } = await getNesMasterSnap();
    const snapped = fetched.colors.map(([r, g, b]) => snapToNesMasterPublic(r, g, b));
    return {
      id,
      name: fetched.name,
      author: fetched.author,
      url: fetched.url,
      colors: snapped,
      sourceColors: fetched.colors,
      snappedToMaster: true,
      asPlatform,
    };
  }
  // Other platforms don't have a hardware master to snap to (or we
  // haven't tabulated one). Return colors verbatim with a note.
  return {
    id,
    name: fetched.name,
    author: fetched.author,
    url: fetched.url,
    colors: fetched.colors,
    snappedToMaster: false,
    asPlatform,
    note: `Platform '${asPlatform}' has no hardware master palette to snap to (or none tabulated yet). Returning lospec colors verbatim.`,
  };
}

// Lazy import of the NES master snap to avoid pulling in sprite-pipeline.js's
// full module surface at load time.
async function getNesMasterSnap() {
  const mod = await import("./sprite-pipeline.js");
  if (typeof mod.snapToNesMasterPublic === "function") return mod;
  // Fallback: re-export under a private name. Implementation reuses
  // the master table that already lives in sprite-pipeline.js.
  throw new Error("getLospecPalette: internal — snapToNesMasterPublic not exported from sprite-pipeline.js");
}

export function registerLospecTools(server, z, _sessionKey) {
  server.tool(
    "getLospecPalette",
    "Fetch a CC0 retro palette from lospec.com by URL slug. Optionally snap each color to a target platform's hardware master palette (today: NES; other platforms returned verbatim). " +
    "Feeds straight into `quantizePngForPlatform({palette})` for 'I want my game to use this Lospec palette' workflows.\n\n" +
    "Examples of common slugs: 'kirokaze-gameboy', 'pico-8', 'sweetie-16', 'endesga-32', 'nostalgia-16'. " +
    "Find the slug from the palette's lospec.com URL: https://lospec.com/palette-list/<slug>.",
    {
      id: z.string().describe("Lospec palette slug (lowercase letters / digits / hyphens). From the URL of the palette's lospec page."),
      asPlatform: z.string().optional().describe("Optional. Snap each color to this platform's hardware master palette via nearest-neighbour. Today only 'nes' has a tabulated master; other platforms return colors verbatim with a note."),
    },
    safeTool(async (args) => jsonContent(await getLospecPaletteImpl(args))),
  );
}

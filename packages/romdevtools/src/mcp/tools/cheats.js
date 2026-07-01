import path from "node:path";
import { readFile } from "node:fs/promises";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { attachObserverFrame } from "./watch-memory.js";
import { lookupCheats, searchCheatGames } from "../../cheats/lookup.js";
import { encodeForDevice, nativeDevicesFor, decodeCode, encodeRaw } from "../../cheats/gamegenie.js";

// Per-platform cheat address space (for makeCheat validation). A Game Genie
// letter code can only address these ranges; out-of-range → raw ADDR:VAL only.
const GG_ADDR_RANGE = {
  nes: [0x8000, 0xFFFF],      // PRG space (mapped ROM)
  gb: [0x0002, 0x7FFF],       // ROM
  gbc: [0x0002, 0x7FFF],
  genesis: [0x000000, 0xFFFFFF],
  megadrive: [0x000000, 0xFFFFFF],
  md: [0x000000, 0xFFFFFF],
  snes: [0x008000, 0xFFFFFF], // mapped ROM ($xx:8000-$xx:FFFF); the Game Genie
                              // ROM device patches here. (Pro Action Replay is
                              // a RAM poke — for a ROM patch we pick GG below.)
  gametank: [0x0000, 0xFFFF], // flat 16-bit CPU space. GameTank's Game Genie is a
                              // READ substitution on the bus, so any read address is
                              // valid (RAM or cart ROM). A NEW format — see gamegenie.js.
};

// The native ROM-PATCH device per platform (installs a read-intercept), as
// opposed to the RAM-poke device. Used when a raw ROM-range code must be
// re-encoded so it actually takes effect. SMS/GG are intentionally absent:
// Action Replay is a RAM device and SMS/GG cheats are RAM addresses, so a raw
// SMS/GG code is already a correct RAM poke — nothing to re-encode.
const ROM_PATCH_DEVICE = {
  nes: "game-genie",
  genesis: "game-genie", megadrive: "game-genie", md: "game-genie",
  gb: "game-genie", gbc: "game-genie",
  snes: "game-genie",   // NOT pro-action-replay (that's the RAM device)
};

/**
 * Resolve a user-supplied cheat code into the string to hand the core, fixing
 * the raw-ROM-cheat footgun: a raw `ADDR:VAL[:COMPARE]` on a ROM address is
 * decoded by the core as a per-frame RAM poke (silently no-ops on read-only
 * ROM), so we re-encode it to the platform's ROM-patch device (a read-
 * intercept). Native-device codes (no `:`) pass through unchanged. Shared by
 * applyCheat and loadMedia({cheats}).
 * @param {string} rawCode
 * @param {string|null} platform
 * @returns {{ code: string, appliedAs: "ram"|"rom"|"raw"|"rom-unencodable", reencodedFrom: string|null }}
 */
export function resolveCheatCodeForApply(rawCode, platform) {
  let code = rawCode, appliedAs = "raw", reencodedFrom = null;
  const isRawForm = typeof rawCode === "string" && rawCode.includes(":");
  if (isRawForm && platform) {
    const decoded = decodeCode(rawCode, platform);
    const range = GG_ADDR_RANGE[platform];
    const inRom = decoded && range && decoded.address >= range[0] && decoded.address <= range[1];
    if (inRom) {
      const dev = ROM_PATCH_DEVICE[platform];
      const enc = dev ? encodeForDevice(decoded, platform, dev) : null;
      if (enc && enc.code) { code = enc.code; appliedAs = "rom"; reencodedFrom = rawCode; }
      else appliedAs = "rom-unencodable";
    } else if (decoded) {
      appliedAs = "ram";
      // Normalize the raw RAM code so a short hand-typed `AA:VV` (e.g. "32:09")
      // is re-emitted in the binding width ("0032:09"). The libretro parser
      // (verified on fceumm) silently DROPS an under-padded RAM address — it
      // parses but never pokes — so passing the user's short string through
      // verbatim is the inert-cheat footgun. encodeRaw pads the address to the
      // width the core honors. (No-op for already-padded codes.)
      const norm = encodeRaw(decoded);
      if (norm !== rawCode) reencodedFrom = rawCode;
      code = norm;
    }
  }
  return { code, appliedAs, reencodedFrom };
}

// Platforms that have a bundled cheat INDEX (a DB to look up with gameCheats).
// These are exactly the platforms the romdev_game_codes package ships an index for
// (the romdev platforms the community cheats tree actually covers). All tier-1
// cores expose retro_cheat_set, so applyCheat/makeCheat work everywhere (see
// MAKE_CHEAT_PLATFORMS) — this set is specifically about a shipped DB to look
// up. C64 is intentionally absent: the libretro-database cheats tree has no
// "Commodore - 64" folder (zero source cheats), so there is nothing to index —
// makeCheat still works on C64 via raw ADDR:VAL codes. (Source of truth for the
// list is romdev_game_codes' listPlatforms(); kept inline here to avoid a load at
// module init.)
const SUPPORTED = new Set([
  "nes", "gb", "gbc", "snes", "genesis", "sms", "gg",
  "atari2600", "atari7800", "lynx", "gba", "pce", "msx",
]);

// Platforms makeCheat can CREATE a code for. Every tier-1 core decodes raw
// ADDR:VAL via retro_cheat_set, so this is all 14 — even C64 (no DB index) and
// gba/lynx/pce/msx (DB is apply-only / raw-poke). Native-device encoding (Game
// Genie / PAR / GameShark / Action Replay) is added per platform by
// nativeDevicesFor(); the rest get a verified raw code.
const MAKE_CHEAT_PLATFORMS = [
  "nes", "gb", "gbc", "snes", "genesis", "sms", "gg",
  "atari2600", "atari7800", "lynx", "gba", "c64", "pce", "msx",
  "gametank", // NEW: GameTank Game Genie (read-substitution device) — see gamegenie.js
];

// gameCheats indexes whose codes are predominantly ENCRYPTED at the source
// (Code Breaker / GameShark v3 on GBA), so we ship the raw code for apply but
// CANNOT descramble it to a labeled address — the entry is apply-only, not a
// labeled RE map. Surfaced in the gameCheats `note` so the agent doesn't expect
// addresses it won't get.
const APPLY_ONLY_INDEX = new Set(["gba"]);

// ── *Core functions: one per cheat operation. The `cheats` tool routes to them.
//    Stateful ops take sessionKey so getHost(sessionKey) resolves the live host.

/** op:'lookup' — read-only DB lookup of a ROM's known cheats. */
export async function cheatsLookupCore({ path: romPath, platform, filter, kind = "all" }) {
      const mod = await import("../../rom-id/identifier.js");
      const id = await mod.identifyFile(romPath).catch(() => null);
      const plat = platform ?? id?.platform;
      if (!plat || !SUPPORTED.has(plat)) {
        return {
          matched: false, confidence: "none", platform: plat ?? "unknown",
          note: `No bundled cheat index for platform '${plat ?? "unknown"}'. Supported: ${[...SUPPORTED].join(", ")}.`,
        };
      }
      const bytes = await readFile(romPath).catch(() => null);
      const fileName = path.basename(romPath);
      const res = await lookupCheats({
        platform: plat,
        romName: id?.title || undefined,
        fileName,
        bytes: bytes ? new Uint8Array(bytes) : undefined,
      });
      if (res.matched && res.entries) {
        let entries = res.entries;
        if (kind !== "all") {
          entries = entries.filter((e) => (e.parts || []).some((p) => p && p.kind === kind));
        }
        if (filter) {
          const f = filter.toLowerCase();
          entries = entries.filter((e) => (e.desc || "").toLowerCase().includes(f));
        }
        // Pretty-print addresses/values as hex for the agent.
        const pretty = entries.map((e) => ({
          desc: e.desc,
          code: e.code,
          // `device` tells the agent WHICH cheat device each code is for —
          // game-genie / pro-action-replay / gameshark / action-replay / raw —
          // so it's never assumed to be "Game Genie".
          parts: (e.parts || []).map((p) => {
            if (!p) return null;
            if (p.address == null) return { device: p.device, kind: p.kind, decoded: false };
            return {
              device: p.device,
              address: "$" + p.address.toString(16).toUpperCase(),
              value: "0x" + p.value.toString(16).toUpperCase().padStart(2, "0"),
              ...(p.compare != null ? { compare: "0x" + p.compare.toString(16).toUpperCase().padStart(2, "0") } : {}),
              kind: p.kind,
            };
          }),
        }));
        return {
          ...res,
          entryCount: pretty.length,
          totalInGame: res.entries.length,
          entries: pretty,
          ...(APPLY_ONLY_INDEX.has(plat) ? {
            mapNote: `${plat.toUpperCase()} source cheats are encrypted (Code Breaker / GameShark), so the addresses are NOT descrambled — these entries are APPLY-ONLY: the labeled \`code\` works with applyCheat (the core decodes it live), but \`parts\` carry no usable address, so this is not a labeled-address RE map the way NES/GB/etc. indexes are.`,
          } : {}),
        };
      }
      return res;
}

/** op:'search' — fuzzy game-name search in the cheat DB. */
export async function cheatsSearchCore({ platform, query, limit }) {
      return await searchCheatGames({ platform, query, limit });
}

/** op:'apply' — enable a cheat live (non-destructive, volatile core state). */
export async function cheatsApplyCore({ code, desc, path: romPath, index, enabled = true }, sessionKey) {
      const host = getHost(sessionKey);
      if (!host.cheatsSupported || !host.cheatsSupported()) {
        throw new Error("The loaded core does not expose the cheat interface. (Older core build — rebuild with cheat exports.)");
      }
      let rawCode = code;
      let resolvedDesc;
      if (!rawCode && desc) {
        if (!romPath) throw new Error("applyCheat: `desc` requires `path` to look the cheat up.");
        const mod = await import("../../rom-id/identifier.js");
        const id = await mod.identifyFile(romPath).catch(() => null);
        const bytes = await readFile(romPath).catch(() => null);
        const res = await lookupCheats({
          platform: id?.platform, romName: id?.title || undefined,
          fileName: path.basename(romPath), bytes: bytes ? new Uint8Array(bytes) : undefined,
        });
        if (!res.matched) throw new Error(`applyCheat: no DB match for that ROM, so cannot resolve desc='${desc}'. Pass a raw \`code\` instead.`);
        const f = desc.toLowerCase();
        const entry = res.entries.find((e) => (e.desc || "").toLowerCase().includes(f));
        if (!entry) throw new Error(`applyCheat: no cheat matching desc='${desc}' in '${res.game}'.`);
        rawCode = entry.code;
        resolvedDesc = entry.desc;
      }
      if (!rawCode) throw new Error("applyCheat: provide `code` (raw) or `desc` (+`path`).");

      // Resolve the raw-ROM-cheat footgun (raw ADDR:VAL on a ROM address is a
      // RAM poke that silently no-ops — re-encode it to a ROM-patch device). See
      // resolveCheatCodeForApply. Shared with loadMedia({cheats}).
      const plat = host.getStatus?.().platform ?? null;
      const { code: codeToApply, appliedAs, reencodedFrom } = resolveCheatCodeForApply(rawCode, plat);

      const unencodable = appliedAs === "rom-unencodable";
      // Slot selection: an explicit `index` wins. Otherwise, if an active cheat
      // already targets the SAME address, REUSE its slot — applying `005C:03` over
      // an active `005C:02` should REPLACE the freeze, not stack a second one that
      // fights for the same byte (v0.41.0 feedback 213831 #3). Only append a new
      // slot when nothing targets this address yet.
      const newAddr = cheatAddress(codeToApply);
      let replacedSlot = null;
      let slot;
      if (index != null) {
        slot = index;
      } else if (newAddr != null) {
        const existing = host.listActiveCheats().find((c) => cheatAddress(c.code) === newAddr);
        if (existing) { slot = existing.index; replacedSlot = existing.index; }
        else slot = host.listActiveCheats().length;
      } else {
        slot = host.listActiveCheats().length;
      }
      // Still install it (the raw poke may be what the user wants), but warn.
      host.setCheat(slot, codeToApply, enabled);
      return {
        applied: enabled,
        slot,
        ...(replacedSlot != null ? { replacedSameAddress: true } : {}),
        code: codeToApply,
        appliedAs,
        ...(reencodedFrom ? { reencodedFrom } : {}),
        ...(resolvedDesc ? { desc: resolvedDesc } : {}),
        active: host.listActiveCheats(),
        note: (replacedSlot != null
          ? `REPLACED the active cheat on the same address (slot ${replacedSlot}) — applying a new freeze on an address that already had one swaps it rather than stacking two that fight over the byte. To remove a single freeze without clearing the rest, use cheats({op:'remove', code|slot}). `
          : "") +
          (reencodedFrom
          ? `Raw code ${reencodedFrom} names a ROM address — re-encoded to the native ROM-patch device (${codeToApply}) so the core installs a read-intercept (a raw ADDR:VAL on a ROM address is treated as a RAM poke and would silently no-op). `
          : unencodable
          ? `WARNING: this raw code names a ROM address but couldn't be re-encoded to a ROM-patch code (a ROM patch needs a COMPARE byte — pass ADDR:VAL:COMPARE). As applied it's a RAM poke and will likely NO-OP on this read-only ROM address. Read the current byte and supply it as the compare, or use makeCheat. `
          : "") +
          "Applied in volatile core state — the ROM file is untouched; reset / loadState / clearCheats removes it. " +
          "Screenshot to see the effect (and to verify the cheat's address label is correct). " +
          "`appliedAs` tells you how it went in: 'ram' poke, 'rom' read-intercept, 'raw' core-decoded code, or 'rom-unencodable' (a ROM address that couldn't be made into a working ROM patch).",
      };
}

/** The CPU/RAM address a cheat code targets, or null if undecodable. Used to
 *  detect same-address freezes (replace, not stack) + for op:'remove' by code. */
function cheatAddress(code) {
  if (typeof code !== "string") return null;
  // raw ADDR:VAL[:COMPARE] — the address is the first field.
  if (code.includes(":")) {
    const a = parseInt(code.split(":")[0], 16);
    return Number.isNaN(a) ? null : (a & 0xffff);
  }
  // a device code (Game Genie / PAR / GameShark) — decode it platform-agnostically.
  try {
    const d = decodeCode(code, null);
    return d && d.address != null ? (d.address & 0xffff) : null;
  } catch { return null; }
}

/** op:'remove' — disable ONE active cheat (by slot index or by code/address),
 *  leaving the rest in place. The single-slot complement to op:'clear' (nuke-all).
 *  v0.41.0 feedback 213831 #3. */
export async function cheatsRemoveCore({ slot, code }, sessionKey) {
      const host = getHost(sessionKey);
      if (!host.listActiveCheats) return { removed: false, reason: "no cheat interface on this core", active: [] };
      const active = host.listActiveCheats();
      let target = null;
      if (slot != null) {
        target = active.find((c) => c.index === slot);
      } else if (code != null) {
        // match by exact code OR by the address the code targets (so a user can
        // remove '005C:02' by passing '005C:03', '$5C', or the device code).
        const addr = cheatAddress(code);
        target = active.find((c) => c.code === code) || (addr != null ? active.find((c) => cheatAddress(c.code) === addr) : null);
      } else {
        throw new Error("cheats({op:'remove'}): provide `slot` (index) or `code` (the cheat to remove).");
      }
      if (!target) {
        return { removed: false, reason: `no active cheat matching ${slot != null ? `slot ${slot}` : `code '${code}'`}`, active };
      }
      host.setCheat(target.index, target.code, false); // disable that slot only
      return {
        removed: true,
        slot: target.index,
        code: target.code,
        active: host.listActiveCheats(),
        note: "Disabled that one cheat (volatile); the rest stay active. Use op:'clear' to remove ALL, op:'apply' to add/swap.",
      };
}

/** op:'clear' — remove ALL active cheats (volatile core-side reset). */
export async function cheatsClearCore(_args, sessionKey) {
      const host = getHost(sessionKey);
      if (host.clearCheats) host.clearCheats();
      return { cleared: true, active: host.listActiveCheats ? host.listActiveCheats() : [] };
}

/** op:'make' — CREATE a new cheat code from an address + value. */
export async function cheatsMakeCore({ platform, address, value, values, compare, device }) {
      const range = GG_ADDR_RANGE[platform];
      const devices = device ? [device] : nativeDevicesFor(platform);

      // Build the code set for ONE value (factored out so a `values[]` batch
      // reuses it without a per-value round-trip).
      const buildFor = (v) => {
        const parts = { address, value: v, ...(compare != null ? { compare } : {}) };
        const verify = (code) => {
          const back = decodeCode(code, platform);
          return !!back && back.address === address && back.value === v && (compare == null || back.compare === compare);
        };
        const codes = [];
        let rangeNote;
        for (const dev of devices) {
          if (dev === "raw") continue; // raw always added below
          if (dev === "game-genie" && range && (address < range[0] || address > range[1])) {
            rangeNote = `address $${address.toString(16).toUpperCase()} is outside this platform's Game Genie range ($${range[0].toString(16).toUpperCase()}-$${range[1].toString(16).toUpperCase()}); use the raw or another device code.`;
            continue;
          }
          const r = encodeForDevice(parts, platform, dev);
          if (r && r.code && verify(r.code)) codes.push({ device: r.device, code: r.code, verified: true });
        }
        const raw = encodeForDevice(parts, platform, "raw").code;
        return {
          value: "0x" + v.toString(16).toUpperCase().padStart(2, "0"),
          codes, raw, ...(rangeNote ? { rangeNote } : {}),
        };
      };

      const common = {
        platform,
        address: "$" + address.toString(16).toUpperCase(),
        ...(compare != null ? { compare: "0x" + compare.toString(16).toUpperCase().padStart(2, "0") } : {}),
        kind: compare != null ? "code" : "ram",
      };

      // Batch form: one entry per value.
      if (values && values.length) {
        const variants = values.map(buildFor);
        return {
          ...common,
          variants,
          note: (compare != null ? "ROM/code patches" : "RAM cheats") + " for " + platform + " at " + common.address +
            " across " + values.length + " values. Each variant carries device codes + raw. Apply any with cheats({op:'apply', code}).",
        };
      }

      // Single-value form (back-compat).
      if (value == null) throw new Error("makeCheat: provide `value` (single) or `values` (batch).");
      const built = buildFor(value);
      const primary = built.codes[0]?.code || built.raw;
      return {
        ...common,
        value: built.value,
        codes: built.codes,
        raw: built.raw,
        ...(built.rangeNote ? { rangeNote: built.rangeNote } : {}),
        note: (compare != null ? "ROM/code patch" : "RAM cheat") + " for " + platform + ". " +
          "Devices: " + (built.codes.length ? built.codes.map((c) => `${c.device} ${c.code}`).join(", ") + ", " : "") + "raw " + built.raw + ". " +
          "Apply to confirm: cheats({op:'apply', code: \"" + primary + "\" }). Non-destructive — no ROM file is touched.",
      };
}

export function registerCheatTools(server, z, sessionKey) {
  server.tool(
    "cheats",
    "Cheat lookup / search / apply / create for the loaded ROM. `op`: " +
    "'lookup' (THIS game's known cheats from the bundled DB — returns labeled RAM addresses + Game Genie/ROM code " +
    "sites, so it answers 'which byte holds X?' for free); " +
    "'search' (fuzzy-find a game by NAME when you don't have the exact No-Intro title — searches ALL platforms by " +
    "default and each match reports its own `platform`, so you don't need to know the console; pass `platform` only " +
    "to scope it. Returns game names + cheat counts; then lookup the chosen one with its platform); " +
    "'apply' (enable a cheat on the LOADED game — pass a raw `code` or a `desc` from lookup); " +
    "'clear' (remove all active cheats); 'make' (CREATE a shareable code from an address+value). " +
    "TRUST: lookup matches by NAME/fuzzy similarity, NOT a verified CRC — a PROBABLE match. Labels are usually " +
    "right, but a different region/revision can use different addresses — VERIFY before patching: apply + observe, " +
    "or check the address in live memory with memory/watch. " +
    "apply is NON-DESTRUCTIVE (volatile core state; reset / loadState / clear removes it, the ROM file is never " +
    "touched), so it doubles as the verifier — apply a label, screenshot, confirm. " +
    "make emits the platform's NATIVE device code (not always 'Game Genie': NES/Genesis=Game Genie; SNES=Pro " +
    "Action Replay+GG; GB/GBC=Game Genie(ROM)+GameShark(RAM); SMS/GG=Action Replay) plus the raw ADDR:VAL, all " +
    "round-trip `verified`. RAM cheat = address+value; ROM/code cheat = also `compare` (the byte currently there — " +
    "read it first).",
    {
      op: z.enum(["lookup", "search", "apply", "remove", "clear", "make"]).describe("lookup THIS game's DB cheats; search the DB by game name; apply a cheat live (replaces an active cheat on the SAME address); remove ONE active cheat (by slot/code); clear ALL cheats; make a new code."),
      // lookup
      path: z.string().optional().describe("op=lookup/apply(+desc): absolute ROM path. lookup sniffs platform+name from it."),
      filter: z.string().optional().describe("op=lookup: case-insensitive substring filter on cheat descriptions."),
      kind: z.enum(["ram", "code", "all"]).default("all").describe("op=lookup: RAM-variable cheats, ROM/code cheats, or all (default)."),
      // search
      query: z.string().optional().describe("op=search: free-text game name — any form; tags/region/punctuation ignored."),
      limit: z.number().int().min(1).max(50).default(12).describe("op=search: max results (default 12)."),
      // apply
      code: z.string().optional().describe("op=apply: raw cheat code (ADDR:VAL or a Game Genie code). Provide code OR desc."),
      desc: z.string().optional().describe("op=apply: description of a matched cheat (requires `path`). First substring match is applied."),
      index: z.number().int().min(0).optional().describe("op=apply: cheat slot (default: reuse the slot of an active cheat on the same address, else next free). Reuse a slot to replace it."),
      enabled: z.boolean().default(true).describe("op=apply: false disables the slot instead of enabling."),
      slot: z.number().int().min(0).optional().describe("op=remove: the active-cheat slot to disable (from apply's `slot` / active[].index). Provide slot OR code."),
      // make / search / lookup share `platform`
      platform: z.enum([...MAKE_CHEAT_PLATFORMS]).optional().describe("op=lookup: override platform detection. op=search: OPTIONAL — omit to search ALL platforms (each match returns its own `platform`); pass one only to scope the search. op=make: REQUIRED — the target platform (all 14 tier-1)."),
      address: z.number().int().min(0).optional().describe("op=make: address to cheat (RAM addr, or the ROM addr to patch)."),
      value: z.number().int().min(0).max(255).optional().describe("op=make: replacement byte (0-255). Provide value OR values."),
      values: z.array(z.number().int().min(0).max(255)).min(1).max(64).optional().describe("op=make: batch — a code per value at the same address. Returns variants[]."),
      compare: z.number().int().min(0).max(255).optional().describe("op=make: ROM cheats only — the byte CURRENTLY at `address` (read it first). Selects the device's ROM-patch form."),
      device: z.enum(["game-genie", "pro-action-replay", "gameshark", "action-replay", "raw"]).optional().describe("op=make: force a specific device's encoding. Default: the platform's native device(s)."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "lookup": return jsonContent(await cheatsLookupCore(args));
        case "search": return jsonContent(await cheatsSearchCore(args));
        case "apply":  return attachObserverFrame(jsonContent(await cheatsApplyCore(args, sessionKey)), getHost(sessionKey), "cheat applied");
        case "remove": return jsonContent(await cheatsRemoveCore(args, sessionKey));
        case "clear":  return jsonContent(await cheatsClearCore(args, sessionKey));
        case "make":   return jsonContent(await cheatsMakeCore(args));
        default: throw new Error(`cheats: unknown op '${args.op}'`);
      }
    }),
  );
}

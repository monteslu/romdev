import path from "node:path";
import { readFile } from "node:fs/promises";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { lookupCheats } from "../../cheats/lookup.js";
import { encodeForDevice, nativeDevicesFor, decodeCode } from "../../cheats/gamegenie.js";

// Per-platform cheat address space (for makeCheat validation). A Game Genie
// letter code can only address these ranges; out-of-range → raw ADDR:VAL only.
const GG_ADDR_RANGE = {
  nes: [0x8000, 0xFFFF],      // PRG space
  gb: [0x0002, 0x7FFF],       // ROM
  gbc: [0x0002, 0x7FFF],
  genesis: [0x000000, 0xFFFFFF],
  megadrive: [0x000000, 0xFFFFFF],
};

// Platforms that have a bundled cheat INDEX (a DB to look up with gameCheats).
// All 12 tier-1 cores expose retro_cheat_set, so applyCheat/makeCheat work
// everywhere (see MAKE_CHEAT_PLATFORMS) — these are specifically the ones with
// a shipped index. C64 is intentionally absent: the libretro-database cheats
// tree has no "Commodore - 64" folder (zero source cheats), so there is nothing
// to index — makeCheat still works on C64 via raw ADDR:VAL codes.
const SUPPORTED = new Set([
  "nes", "gb", "gbc", "snes", "genesis", "sms", "gg",
  "atari2600", "atari7800", "lynx", "gba",
]);

// Platforms makeCheat can CREATE a code for. Every tier-1 core decodes raw
// ADDR:VAL via retro_cheat_set, so this is all 12 — even C64 (no DB index) and
// gba/lynx (DB is apply-only). Native-device encoding (Game Genie / PAR /
// GameShark / Action Replay) is added per platform by nativeDevicesFor(); the
// rest get a verified raw code.
const MAKE_CHEAT_PLATFORMS = [
  "nes", "gb", "gbc", "snes", "genesis", "sms", "gg",
  "atari2600", "atari7800", "lynx", "gba", "c64",
];

// gameCheats indexes whose codes are predominantly ENCRYPTED at the source
// (Code Breaker / GameShark v3 on GBA), so we ship the raw code for apply but
// CANNOT descramble it to a labeled address — the entry is apply-only, not a
// labeled RE map. Surfaced in the gameCheats `note` so the agent doesn't expect
// addresses it won't get.
const APPLY_ONLY_INDEX = new Set(["gba"]);

export function registerCheatTools(server, z, sessionKey) {
  // ── gameCheats — read-only lookup ─────────────────────────────────────
  server.tool(
    "gameCheats",
    "Look up the KNOWN cheats for a ROM from the bundled cheat database and return THIS GAME'S entries only " +
    "(never the whole DB — your context stays clean). For romhacking/RE this is a free, crowd-sourced MAP: each " +
    "RAM cheat is a LABELED RAM ADDRESS (e.g. \"Infinite Magic\" → $00CD) and each Game Genie/ROM cheat is a " +
    "LABELED CODE SITE (address + value + compare). It answers the most expensive RE question — 'which byte/" +
    "routine holds X?' — for free. Returns { matched, confidence, game, platform, crc32, entries:[{desc, code, " +
    "parts:[{address,value,compare?,kind:'ram'|'code'}]}], note }. " +
    "CONFIDENCE/TRUST: a match is by No-Intro NAME or filename, NOT a verified CRC identification — so it is a " +
    "PROBABLE match. The labels are very likely right, but a different region/revision can use different " +
    "addresses. VERIFY a label before trusting it for a patch (apply the cheat and observe, or check the address " +
    "in live memory with readMemory/watchMemory). Pass `apply` to also enable matched cheats live (see applyCheat).",
    {
      path: z.string().describe("Absolute path to the ROM file. Platform + name are sniffed from it (override with `platform`)."),
      platform: z.enum([...SUPPORTED]).optional().describe("Override platform detection."),
      filter: z.string().optional().describe("Case-insensitive substring to filter cheat descriptions (e.g. 'lives', 'health') — cuts a long list to the relevant ones."),
      kind: z.enum(["ram", "code", "all"]).default("all").describe("Return only RAM-variable cheats, only ROM/code cheats, or all (default). RAM cheats are labeled variables; code cheats are labeled patch sites."),
    },
    safeTool(async ({ path: romPath, platform, filter, kind = "all" }) => {
      const mod = await import("../../rom-id/identifier.js");
      const id = await mod.identifyFile(romPath).catch(() => null);
      const plat = platform ?? id?.platform;
      if (!plat || !SUPPORTED.has(plat)) {
        return jsonContent({
          matched: false, confidence: "none", platform: plat ?? "unknown",
          note: `No bundled cheat index for platform '${plat ?? "unknown"}'. Supported: ${[...SUPPORTED].join(", ")}.`,
        });
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
        return jsonContent({
          ...res,
          entryCount: pretty.length,
          totalInGame: res.entries.length,
          entries: pretty,
          ...(APPLY_ONLY_INDEX.has(plat) ? {
            mapNote: `${plat.toUpperCase()} source cheats are encrypted (Code Breaker / GameShark), so the addresses are NOT descrambled — these entries are APPLY-ONLY: the labeled \`code\` works with applyCheat (the core decodes it live), but \`parts\` carry no usable address, so this is not a labeled-address RE map the way NES/GB/etc. indexes are.`,
          } : {}),
        });
      }
      return jsonContent(res);
    }),
  );

  // ── applyCheat — enable a cheat live (non-destructive) ────────────────
  server.tool(
    "applyCheat",
    "Apply a cheat to the LOADED game and play with it on — the fun-bonus / 'what does this do' tool. Works two " +
    "ways: pass a raw `code` (e.g. '00C7:FF', 'SXIOPO', 'AJ9T-CA5Y') for any platform the core understands, OR " +
    "pass `desc` to apply a matched entry from gameCheats by its description. " +
    "NON-DESTRUCTIVE — exactly how RetroArch does it: the code is applied in volatile CORE state (a per-frame RAM " +
    "write for RAM cheats; an in-core read-intercept for ROM cheats). The ROM file on disk is NEVER modified, and " +
    "reset / loadState / clearCheats removes it. Also a great VERIFIER: apply a gameCheats label, screenshot, and " +
    "confirm the effect to prove the address is right. Returns the active-cheat list.",
    {
      code: z.string().optional().describe("Raw cheat code string (ADDR:VAL or a Game Genie code). The core decodes it. Provide `code` OR `desc`."),
      desc: z.string().optional().describe("Description of a cheat from the matched game (requires `path` to look it up). Case-insensitive substring; the first match is applied."),
      path: z.string().optional().describe("ROM path — required with `desc` to look the cheat up in the DB."),
      index: z.number().int().min(0).optional().describe("Cheat slot to use (default: next free slot). Reuse a slot to replace it."),
      enabled: z.boolean().default(true).describe("false disables the slot instead of enabling."),
    },
    safeTool(async ({ code, desc, path: romPath, index, enabled = true }) => {
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

      const slot = index != null ? index : host.listActiveCheats().length;
      host.setCheat(slot, rawCode, enabled);
      return jsonContent({
        applied: enabled,
        slot,
        code: rawCode,
        ...(resolvedDesc ? { desc: resolvedDesc } : {}),
        active: host.listActiveCheats(),
        note: "Applied in volatile core state — the ROM file is untouched; reset / loadState / clearCheats removes it. " +
          "Screenshot to see the effect (and to verify the cheat's address label is correct).",
      });
    }),
  );

  // ── clearCheats — remove all active cheats ────────────────────────────
  server.tool(
    "clearCheats",
    "Remove ALL active cheats from the loaded game (calls the core's cheat-reset). Non-destructive — the ROM was " +
    "never modified; this just clears the volatile core-side cheat state. Returns the now-empty active list.",
    {},
    safeTool(async () => {
      const host = getHost(sessionKey);
      if (host.clearCheats) host.clearCheats();
      return jsonContent({ cleared: true, active: host.listActiveCheats ? host.listActiveCheats() : [] });
    }),
  );

  // ── makeCheat — CREATE a new cheat code from an address + value ───────
  server.tool(
    "makeCheat",
    "CREATE a brand-new cheat code from an address + value (the inverse of decoding). Turn a byte you found — " +
    "via runUntilWrite/watchMemory/gameCheats — into a shareable code, for ANY ROM including your own homebrew/WIP " +
    "(no database entry needed). Emits the code for the platform's NATIVE cheat DEVICE — and labels it, so it's " +
    "never falsely called 'Game Genie': NES/Genesis = Game Genie; SNES = Pro Action Replay (+ Game Genie); GB/GBC " +
    "= Game Genie (ROM) + GameShark (RAM); SMS/GG = Action Replay. Always also returns the raw ADDR:VAL form. Each " +
    "generated code is round-trip `verified` (decoded back and confirmed to reproduce your address/value). " +
    "RAM cheat: give `address` + `value`. ROM/code cheat: also give `compare` (the byte currently at that ROM " +
    "address — read it first), yielding the device's ROM-patch form. Apply the result with applyCheat to confirm. " +
    "NON-DESTRUCTIVE — nothing is written to any ROM file.",
    {
      platform: z.enum([...MAKE_CHEAT_PLATFORMS]).describe("Target platform (all 12 tier-1 systems). Selects which cheat device(s) the code is encoded for; platforms without a native letter-code device (atari2600/7800, lynx, gba, c64) get a verified raw ADDR:VAL code that applyCheat passes straight to the core. See tool description."),
      address: z.number().int().min(0).describe("Address to cheat. RAM cheats: the RAM address (e.g. 0x00CD / SNES 0x7E0DBF). ROM cheats: the ROM address of the byte to patch."),
      value: z.number().int().min(0).max(255).optional().describe("Replacement byte value (0-255). Provide `value` OR `values`."),
      values: z.array(z.number().int().min(0).max(255)).min(1).max(64).optional().describe("Batch: make a code for each value at the same address/compare in one call (e.g. values:[2,3] to offer two strengths). Returns `variants:[{value, codes, raw}]`."),
      compare: z.number().int().min(0).max(255).optional().describe("ROM cheats only: the byte CURRENTLY at `address` (read it first). Its presence selects the device's ROM-patch form (e.g. 8-char NES Game Genie)."),
      device: z.enum(["game-genie", "pro-action-replay", "gameshark", "action-replay", "raw"]).optional().describe("Force a specific device's encoding. Default: the platform's native device(s)."),
    },
    safeTool(async ({ platform, address, value, values, compare, device }) => {
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
        return jsonContent({
          ...common,
          variants,
          note: (compare != null ? "ROM/code patches" : "RAM cheats") + " for " + platform + " at " + common.address +
            " across " + values.length + " values. Each variant carries device codes + raw. Apply any with applyCheat({code}).",
        });
      }

      // Single-value form (back-compat).
      if (value == null) throw new Error("makeCheat: provide `value` (single) or `values` (batch).");
      const built = buildFor(value);
      const primary = built.codes[0]?.code || built.raw;
      return jsonContent({
        ...common,
        value: built.value,
        codes: built.codes,
        raw: built.raw,
        ...(built.rangeNote ? { rangeNote: built.rangeNote } : {}),
        note: (compare != null ? "ROM/code patch" : "RAM cheat") + " for " + platform + ". " +
          "Devices: " + (built.codes.length ? built.codes.map((c) => `${c.device} ${c.code}`).join(", ") + ", " : "") + "raw " + built.raw + ". " +
          "Apply to confirm: applyCheat({ code: \"" + primary + "\" }). Non-destructive — no ROM file is touched.",
      });
    }),
  );
}

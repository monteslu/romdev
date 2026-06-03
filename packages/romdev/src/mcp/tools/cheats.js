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

// Platforms whose bundled cheat index + a cheat-capable core exist.
const SUPPORTED = new Set(["nes", "gb", "gbc", "snes", "genesis", "sms", "gg", "atari2600", "atari7800"]);

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
      platform: z.enum([...SUPPORTED]).describe("Target platform. Selects which cheat device(s) the code is encoded for (see tool description)."),
      address: z.number().int().min(0).describe("Address to cheat. RAM cheats: the RAM address (e.g. 0x00CD / SNES 0x7E0DBF). ROM cheats: the ROM address of the byte to patch."),
      value: z.number().int().min(0).max(255).describe("Replacement byte value (0-255)."),
      compare: z.number().int().min(0).max(255).optional().describe("ROM cheats only: the byte CURRENTLY at `address` (read it first). Its presence selects the device's ROM-patch form (e.g. 8-char NES Game Genie)."),
      device: z.enum(["game-genie", "pro-action-replay", "gameshark", "action-replay", "raw"]).optional().describe("Force a specific device's encoding. Default: the platform's native device(s)."),
    },
    safeTool(async ({ platform, address, value, compare, device }) => {
      const out = {
        platform,
        address: "$" + address.toString(16).toUpperCase(),
        value: "0x" + value.toString(16).toUpperCase().padStart(2, "0"),
        ...(compare != null ? { compare: "0x" + compare.toString(16).toUpperCase().padStart(2, "0") } : {}),
      };
      const parts = { address, value, ...(compare != null ? { compare } : {}) };
      const range = GG_ADDR_RANGE[platform];
      const verify = (code, dev) => {
        const back = decodeCode(code, platform);
        return !!back && back.address === address && back.value === value && (compare == null || back.compare === compare);
      };

      // Which devices to emit: the forced one, or the platform's native list.
      const devices = device ? [device] : nativeDevicesFor(platform);
      const codes = [];
      for (const dev of devices) {
        if (dev === "raw") continue; // raw always added below
        // Letter/device codes have an address range; flag (don't emit garbage) if out of range.
        if (dev === "game-genie" && range && (address < range[0] || address > range[1])) {
          codes.push({ device: dev, code: null, note: `address $${address.toString(16).toUpperCase()} is outside this platform's Game Genie range ($${range[0].toString(16).toUpperCase()}-$${range[1].toString(16).toUpperCase()}); use the raw or another device code.` });
          continue;
        }
        const r = encodeForDevice(parts, platform, dev);
        if (r && r.code) {
          const verified = verify(r.code, dev);
          codes.push({ device: r.device, code: r.code, verified, ...(verified ? {} : { note: "round-trip check FAILED — not trustworthy" }) });
        }
      }
      out.codes = codes.filter((c) => c.code && c.verified !== false);
      out.raw = encodeForDevice(parts, platform, "raw").code;
      // Pick a primary code to suggest applying (first verified device, else raw).
      const primary = out.codes[0]?.code || out.raw;
      out.kind = compare != null ? "code" : "ram";
      out.note =
        (compare != null ? "ROM/code patch" : "RAM cheat") + " for " + platform + ". " +
        "Devices: " + (out.codes.length ? out.codes.map((c) => `${c.device} ${c.code}`).join(", ") + ", " : "") + "raw " + out.raw + ". " +
        "Apply to confirm: applyCheat({ code: \"" + primary + "\" }). Non-destructive — no ROM file is touched.";
      if (codes.some((c) => c.code === null)) out.rangeNote = codes.find((c) => c.code === null).note;
      return jsonContent(out);
    }),
  );
}

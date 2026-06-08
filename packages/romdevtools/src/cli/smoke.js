#!/usr/bin/env node
// romdev-cli — direct CLI for the romdev host.
//
// End users use `play` to fire up a ROM in a window. The other subcommands
// are smoke-test harnesses that match what the MCP tools do, useful for
// scripting + debugging without a running MCP server.
//
// Usage:
//   romdev-cli play <rom-or-zip> [--platform PLAT] [--scale N]
//   romdev-cli identify <rom-or-zip>
//   romdev-cli run --core <path> --rom <path> [--frames N] [--screenshot out.png]
//
// `play` accepts .zip files — the first ROM-shaped entry is extracted to a
// temp file and loaded into the matching libretro core. Platform is
// inferred from the file extension if not given.

import { writeFile, mkdtemp } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import yauzl from "yauzl";
import { LibretroHost } from "../host/index.js";
import { framebufferToPng } from "../host/framebuffer.js";
import { resolveCore } from "../cores/registry.js";

// Extension → platform mapping. Drives auto-detection when --platform isn't
// passed. Keep this in sync with cores/registry.js platform IDs.
const EXT_TO_PLATFORM = {
  ".nes": "nes",
  ".unf": "nes",
  ".fds": "nes",
  ".sfc": "snes",
  ".smc": "snes",
  ".swc": "snes",
  ".fig": "snes",
  ".gb":  "gb",
  ".gbc": "gbc",
  ".gba": "gba",
  ".md":  "genesis",
  ".gen": "genesis",
  ".smd": "genesis",
  ".bin": "genesis",  // ambiguous; could be Genesis or other — defaults to Genesis
  ".sms": "sms",
  ".gg":  "gg",
  ".a26": "atari2600",
  ".a78": "atari7800",
  ".lnx": "lynx",
  ".prg": "c64",
  ".d64": "c64",
  ".t64": "c64",
};

// Known ROM file extensions for picking which entry in a .zip is the real
// ROM (vs. a README, save state, etc.).
const ROM_EXTS = new Set(Object.keys(EXT_TO_PLATFORM));

function platformFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_PLATFORM[ext] ?? null;
}

// Extract the first ROM-looking entry from a .zip to a temp file. Returns
// { tempPath, originalName }.
async function extractFirstRomFromZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      let found = false;
      zipfile.on("entry", (entry) => {
        if (found) return;
        const ext = path.extname(entry.fileName).toLowerCase();
        if (!ROM_EXTS.has(ext)) {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, async (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", async () => {
            try {
              const dir = await mkdtemp(path.join(tmpdir(), "romdev-"));
              const tempPath = path.join(dir, path.basename(entry.fileName));
              await writeFile(tempPath, Buffer.concat(chunks));
              resolve({ tempPath, originalName: entry.fileName });
            } catch (we) {
              reject(we);
            }
          });
          stream.on("error", reject);
        });
      });
      zipfile.on("end", () => {
        if (!found) reject(new Error(`no ROM-shaped file found in ${zipPath}`));
      });
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

async function playCommand(romPath, opts) {
  if (!existsSync(romPath)) {
    throw new Error(`file not found: ${romPath}`);
  }

  // Extract zip if needed
  let actualPath = romPath;
  if (path.extname(romPath).toLowerCase() === ".zip") {
    console.error(`unzipping ${path.basename(romPath)}...`);
    const { tempPath, originalName } = await extractFirstRomFromZip(romPath);
    actualPath = tempPath;
    console.error(`  → ${originalName} (${statSync(tempPath).size} bytes)`);
  }

  // Resolve platform
  const platform = opts.platform ?? platformFromExtension(actualPath);
  if (!platform) {
    throw new Error(
      `could not infer platform from extension ${path.extname(actualPath)}. ` +
      `Pass --platform explicitly. Known extensions: ${Object.keys(EXT_TO_PLATFORM).join(", ")}`,
    );
  }

  const core = resolveCore(platform);
  if (!core) {
    throw new Error(`no bundled core for platform '${platform}'`);
  }
  console.error(`platform: ${platform} (${core.displayName})`);

  // Load core + media
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform, path: actualPath });

  // Hand off to playtest
  const { playtest } = await import("../playtest/playtest.js");
  const scale = opts.scale ? parseInt(opts.scale, 10) : 3;
  const title = opts.title ?? `romdev-cli — ${path.basename(romPath)}`;
  const aspect = opts.aspect === "tv" ? "tv" : "fb";
  const session = await playtest({ host, scale, title, aspect });
  await session.closed;
  console.error("playtest closed");
}

async function identifyCommand(romPath) {
  if (!existsSync(romPath)) throw new Error(`file not found: ${romPath}`);
  const { identifyRomFile } = await import("../rom-id/identifier.js");
  const info = await identifyRomFile(romPath);
  console.log(JSON.stringify(info, null, 2));
}

async function runCommand(values) {
  if (!values.core) throw new Error("--core <path> is required");
  if (!values.rom)  throw new Error("--rom <path> is required");

  const host = new LibretroHost();
  await host.loadCore(values.core);
  await host.loadMedia({
    platform: values.platform,
    path: values.rom,
    mediaKind: values["media-kind"],
  });

  const n = parseInt(values.frames, 10);
  console.error(`stepping ${n} frames...`);
  host.stepFrames(n);
  const status = host.getStatus();
  console.error(`done. frame=${status.frameCount} fb=${status.fbWidth}x${status.fbHeight}`);

  if (values.screenshot) {
    const f = host.getFramebuffer();
    const png = framebufferToPng(f.width, f.height, f.pixels, f.pitch, f.format);
    await writeFile(values.screenshot, png);
    console.error(`wrote ${values.screenshot} (${png.length} bytes)`);
  }
}

function usage(exitCode = 0) {
  console.error(`romdev-cli — homebrew retro game tooling

Usage:
  romdev-cli play <rom-or-zip> [--platform PLAT] [--scale N] [--title T] [--aspect fb|tv]
      Open a real SDL window for any ROM. Detects platform from extension.
      Extracts the first ROM out of a .zip automatically.
      --aspect fb (default): window opens at raw framebuffer * scale.
      --aspect tv: stretch to the core's reported TV aspect ratio
                   (Atari 2600 ~4:3, SNES ~8:7, etc.).
      Run \`romdev-cli play --help\` for the keyboard/gamepad bindings.

  romdev-cli identify <rom-or-zip>
      Print a JSON description of the ROM (platform, mapper, hash, etc.).

  romdev-cli run --core <_libretro.js> --rom <path> [--frames N] [--screenshot out.png]
      Smoke-test: step N frames headless, optionally write a PNG. For
      pipelines that need a fast no-window verification. Most users want
      'play' instead.

Examples:
  romdev-cli play ~/Downloads/Donkey\\ Kong\\ Country.zip
  romdev-cli play smb1.nes --scale 4
  romdev-cli play Adventure.a26 --aspect tv
  romdev-cli identify rom.smc
`);
  process.exit(exitCode);
}

async function playHelp() {
  const { KEYBOARD_BINDINGS_HELP } = await import("../playtest/playtest.js");
  console.error(`romdev-cli play — open a ROM in a native window

Usage:
  romdev-cli play <rom-or-zip> [options]

Options:
  --platform <id>   Override extension-based platform detection.
  --scale <N>       Integer upscale factor (default: 3).
  --title <text>    Window title.
  --aspect <mode>   'fb' (default) = raw framebuffer * scale.
                    'tv' = stretch to the core's reported TV aspect ratio.

Controls:
${KEYBOARD_BINDINGS_HELP}
`);
  process.exit(0);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      core:       { type: "string" },
      rom:        { type: "string" },
      frames:     { type: "string", default: "60" },
      screenshot: { type: "string" },
      platform:   { type: "string" },
      "media-kind": { type: "string" },
      scale:      { type: "string" },
      title:      { type: "string" },
      aspect:     { type: "string" },
      help:       { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0];
  // Global --help with no command shows top-level usage. With a command,
  // it falls through so the command can show its own detailed help.
  if (values.help && !cmd) usage(0);
  if (!cmd) usage(1);

  switch (cmd) {
    case "play":
      if (values.help) { await playHelp(); break; }
      if (!positionals[1]) {
        console.error("usage: romdev-cli play <rom-or-zip>  (try --help for controls)");
        process.exit(1);
      }
      await playCommand(positionals[1], values);
      break;
    case "identify":
      if (!positionals[1]) {
        console.error("usage: romdev-cli identify <rom-or-zip>");
        process.exit(1);
      }
      await identifyCommand(positionals[1]);
      break;
    case "run":
      await runCommand(values);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage(1);
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? err);
  process.exit(1);
});

# romdev — Deployment repo/package sketch (PAPER ONLY — nothing created yet)

**Status:** planning artifact for review. NO repos created, NO commits, NO pushes,
NO folder renames done yet. This is the full map to sign off on first.

**Settled decisions (this session):**
- Folder + main project rename: `romdev` → **`romdev`** (never was a git repo — clean slate).
- Topology: **polyrepo** — separate GitHub repo per package, each with its own CI.
- GitHub home: **`monteslu/`** (personal). npm: main pkg **`romdev`** (unscoped); the rest **`romdev-*`** (npm org `romdev`, to be created before first publish).
- Install model: hard deps, exact-pinned in `romdev`. `npx romdev` installs everything. No custom CLI.
- Engines: Node **≥24**.
- **WASM IS committed to git** (decided 2026-05-29) — directly, no LFS. Each binary repo commits its built `.wasm` + glue alongside the build recipe. Rationale: makes CI trivial (clean checkout has the wasm → full test suite just runs, no fetch/build/split gymnastics), no LFS friction, and the tested wasm == committed wasm == published wasm (reproducible). Cost = clone size on the 3 heavy repos (arm-gcc ~155M, sdcc 22M, m68k 20M); fine — they're personal repos, cloned rarely, wasm is near-static. **Publishing is still MANUAL/local** (`npm publish` from disk) — no auto-publish, no publish CI, no npm tokens in CI. (The earlier "git-untracked-wasm blocker" + the whole CI-wrinkle question below are now MOOT — wasm-in-git resolves both.)

---

## Collapse rule (answers "single-system+single-compiler → one platform repo?")

A platform collapses into ONE `romdev-platform-X` package iff its core is used by no
other platform AND its compiler is used by no other platform. Computed against the
verified sharing map:

- **Collapsible (3):** `snes` (snes9x + asar/tcc816/wladx), `gba` (mgba + arm-gcc),
  `atari2600` (stella + dasm). → one `romdev-platform-X` repo each.
- **Not collapsible:** everything sharing a core or compiler — gambatte (gb+gbc),
  gpgx (genesis+sms+gg), cc65 (nes+c64+7800+lynx), sdcc (gb+gbc+sms+gg). Those stay
  as standalone shared `core-*` / `toolchain-*` packages.

---

## THE REPO LIST (final proposal)

### 1 — main package
| # | GitHub repo | npm | holds |
|---|---|---|---|
| 1 | `monteslu/romdev` | `romdev` | MCP server, generic tools, ALL scaffolds/libs/snippets/debug-helpers (ppu/vdp/maria/tia), JS build-glue (`_worker`, `common`, `gba-c`, `genesis-c`, `snes-c`), CLI (`romdev` server + `romdev play <rom>`). Hard-deps (exact-pinned) on every package below. **This is the fast-churning layer.** |

### Collapsed platform packages (3) — core + compiler together, nothing shared
| # | GitHub repo | npm | binaries | platform |
|---|---|---|---|---|
| 2 | `monteslu/romdev-platform-snes` | `romdev-platform-snes` | snes9x core + asar + tcc816 + wladx | SNES |
| 3 | `monteslu/romdev-platform-gba` | `romdev-platform-gba` | mgba core + arm-none-eabi-gcc (**155M**) | GBA |
| 4 | `monteslu/romdev-platform-atari2600` | `romdev-platform-atari2600` | stella2014 core + dasm | Atari 2600 |

### Shared emulator cores (7) — used by >1 platform, so standalone
| # | GitHub repo | npm | core | serves |
|---|---|---|---|---|
| 5 | `monteslu/romdev-core-fceumm` | `romdev-core-fceumm` | fceumm | NES |
| 6 | `monteslu/romdev-core-gambatte` | `romdev-core-gambatte` | gambatte | GB, GBC |
| 7 | `monteslu/romdev-core-gpgx` | `romdev-core-gpgx` | genesis_plus_gx | Genesis, SMS, GG |
| 8 | `monteslu/romdev-core-vice` | `romdev-core-vice` | vice_x64 | C64 |
| 9 | `monteslu/romdev-core-handy` | `romdev-core-handy` | handy | Lynx |
| 10 | `monteslu/romdev-core-prosystem` | `romdev-core-prosystem` | prosystem | Atari 7800 |

(fceumm serves only NES, but NES's compiler cc65 IS shared → NES can't collapse, so fceumm stays a standalone core. Same logic: vice/handy/prosystem are solo cores but their platforms use shared cc65.)

### Shared compiler toolchains (4) — used by >1 platform, so standalone
| # | GitHub repo | npm | binary | serves |
|---|---|---|---|---|
| 11 | `monteslu/romdev-toolchain-cc65` | `romdev-toolchain-cc65` | cc65 (cc65+ca65+ld65+da65) | NES, C64, Lynx, 7800 |
| 12 | `monteslu/romdev-toolchain-sdcc` | `romdev-toolchain-sdcc` | sdcc (+sdas/sdld/mcpp, **22M**) | GB, GBC, SMS, GG |
| 13 | `monteslu/romdev-toolchain-m68k-gcc` | `romdev-toolchain-m68k-gcc` | m68k-elf-gcc (**20M**) | Genesis (C) |
| 14 | `monteslu/romdev-toolchain-vasm` | `romdev-toolchain-vasm` | vasm68k | Genesis (asm) |
| 15 | `monteslu/romdev-toolchain-rgbds` | `romdev-toolchain-rgbds` | rgbds (rgbasm/link/fix) | GB/GBC (asm) |

**Total: 15 repos** (1 main + 3 collapsed-platform + 6 shared-core + 5 shared-toolchain).
(Down from the naïve 18 — the SNES/GBA/2600 collapse merges 3 core + 4 toolchain packages into 3 platform packages.)

### Dependency wiring (what `romdev`'s package.json hard-deps, exact-pinned)
All 14 packages above. Platform→binary resolution inside `romdev`:
- NES → core-fceumm + toolchain-cc65
- GB/GBC → core-gambatte + toolchain-sdcc (+ toolchain-rgbds for asm)
- SMS/GG → core-gpgx + toolchain-sdcc
- Genesis → core-gpgx + toolchain-vasm (+ toolchain-m68k-gcc for C)
- C64 → core-vice + toolchain-cc65
- Lynx → core-handy + toolchain-cc65
- Atari 7800 → core-prosystem + toolchain-cc65
- SNES → platform-snes (self-contained)
- GBA → platform-gba (self-contained)
- Atari 2600 → platform-atari2600 (self-contained)

---

## Per-binary-repo structure (each of #2–#15)

```
romdev-<name>/
  package.json         # name, version, files: ["wasm/", "index.js"], engines >=24
  index.js             # exports the wasm/glue paths (what romdev's resolver imports)
  wasm/                # the built .wasm + emscripten .js glue  ← PUBLISHED
  build/               # build recipe — NOT published (.npmignore)
    build-<core>.sh    #   (moved from romdev's scripts/)
    patches/*.patch    #   (moved from romdev's scripts/patches/ — colocated w/ binary)
    UPSTREAM.md        #   upstream repo + pinned commit
  .npmignore           # excludes build/
  .github/workflows/build.yml   # Emscripten CONTAINER, linux-only, manual/​on-patch trigger
  README.md
```

Published tarball = `wasm/` + `index.js` + package.json + README. The `build/` recipe
lives in the repo but is `.npmignore`'d (same split as today's 14GB `build/`).

## `romdev` (main repo) structure
```
romdev/
  package.json         # bin: { romdev: ... }, hard-deps on all binary pkgs (exact pins)
  src/                 # server, tools, host, observer, playtest, rom-id, cli
  platform-src/        # scaffolds + per-platform runtime libs + debug helpers  (the churning content)
  .github/workflows/test.yml   # VM matrix {ubuntu,macos,windows}×{x64,arm64}, npm test, tag-gated publish
```
(Resolvers change from `path.join(__dirname,"wasm")` → `import.meta.resolve("romdev-core-fceumm")` etc.)

---

## EXECUTION ORDER (do NOT create repos until step 5 passes)

1. **Rename** working folder + project → `romdev` (you said you'll do this). Restart MCP server (absolute paths change).
2. **Strip dead weight** (D1): drop cc65 Apple/GEOS/Atari-8bit `.lib`s + any unshipped-target artifacts. Re-measure.
3. **Scaffold all 15 locally** under e.g. `~/code/cliemu/romdev-packages/` (or a workspace dir): create each folder, move its wasm + build-recipe + patches in, write package.json/index.js/.npmignore.
4. **Wire + prove locally:** point `romdev`'s deps at the local folders (`npm link` or `file:` deps), change the resolvers, and run the FULL suite + a build-per-platform. **This is the gate.** If a platform breaks, fix the split here — on disk, reversible, zero repos created.
5. **Only now create repos:** `gh repo create monteslu/romdev-<name> --private` ×15, push each. Decide per-repo wasm storage (commit vs LFS) — the 155M/22M/20M ones may want LFS.
6. **npm org + first publish:** create the `romdev` npm org; publish binary packages first (so romdev's deps resolve), then `romdev` last.
7. **Wire CI** (D5/D6): main repo VM-matrix test; binary repos Emscripten-container build.

---

## CI: trivial now (wasm-in-git resolved it)
Clean checkout has the wasm → CI just runs `npm test` (full suite, no fetch/build/split).
Main `romdev` repo: VM matrix {ubuntu,macos,windows}×{x64,arm64} `npm test` on PR/push.
Binary repos: a small `npm test` (build a hello-world per their platform) on push. No publish
job anywhere (manual publish). No npm tokens in CI.

## Decided defaults (best-practice calls — see chat for reasoning)
- **WASM-in-git:** committed directly, no LFS. (Resolved.)
- **Publish:** manual `npm publish` from disk. No auto-publish for v1.
- **Repo visibility:** create **private**, flip public at launch. (Easy to make public; impossible to un-publish a leak. Standard for pre-release.)
- **Upstream source for `build/`:** fetch-at-build with a pinned commit/tag (don't vendor full upstream trees — keeps each repo lean; the pinned ref keeps it reproducible).
- **`romdev-platform-snes`** bundles snes9x+asar+tcc816+wladx (all SNES-only) — fine; its build does 4 Emscripten builds.

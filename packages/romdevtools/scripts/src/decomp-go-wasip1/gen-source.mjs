// Generate the Go source build-decomp-go-tools.sh builds the PS1 decomp
// project's disk and asset tools from. The pinned tree is never edited: its
// two tool modules are copied to <out dir> and rewritten there.
// usage: node gen-source.mjs <pinned tree> <this dir> <out dir>
//
// The copy is a Go workspace of two modules with neutral paths,
// psxdecomp/psx-assets and psxdecomp/psx-disk. Changes, each checked against
// the exact source shape it expects so the build fails when the pin moves:
// - wasip1 support: bindiff.go (tcell has no WASI backend), deps/exec_unix.go
//   (no Setsid on wasip1), and the enum reader's `cpp` child, handed to the
//   host through romdev_exec_wasip1.go.
// - no game text in the binaries. The project's short name is in its module
//   path, package names, file names and messages; the module and the game
//   package are renamed, and every string that names a project file, env
//   var or repository is rebuilt at run time from the project the tool runs
//   in (projectid.go reads the project's own tools/<name>-assets/go.mod).
//   The stage, boss and character tables go (romdev_names.go), and the disc
//   identifiers `make` writes come from the original image (romdev_pvd.go).
//
// Also writes <out dir>/.game-package: the upstream name of the renamed
// package directory, so test binaries can be run in the real tree.
import fs from "node:fs";
import path from "node:path";

const [src, ovl, out] = process.argv.slice(2);
const fatal = (m) => { console.error(`FATAL: gen-source: ${m}`); process.exit(1); };

// The project's tools: tools/<name>-assets and tools/<name>-disk.
const assetDirs = fs.readdirSync(path.join(src, "tools")).filter((d) => d.endsWith("-assets") && fs.existsSync(path.join(src, "tools", d, "go.mod")));
if (assetDirs.length !== 1) fatal(`expected one tools/*-assets Go module, found ${assetDirs.length}`);
const NAME = assetDirs[0].slice(0, -"-assets".length);
const NAME_RE = new RegExp(NAME.replace(/[^a-z0-9]/gi, ""), "i");
const NAME_RE_G = new RegExp(NAME_RE.source, "gi");
const UP = { assets: path.join(src, "tools", `${NAME}-assets`), disk: path.join(src, "tools", `${NAME}-disk`) };
const GEN = { assets: path.join(out, "tools/psx-assets"), disk: path.join(out, "tools/psx-disk") };
const GAME_PKG = "psxgame";
const modOf = (dir) => (fs.readFileSync(path.join(dir, "go.mod"), "utf8").match(/^module (\S+)$/m) ?? fatal(`${dir}/go.mod: no module line`))[1];
const MOD = { assets: modOf(UP.assets), disk: modOf(UP.disk) };
const NEWMOD = { assets: "psxdecomp/psx-assets", disk: "psxdecomp/psx-disk" };

// Copy a module, renaming the game package directory.
const copyTree = (from, to) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const name = e.isDirectory() && e.name === NAME && from === UP.assets ? GAME_PKG : e.name;
    const a = path.join(from, e.name), b = path.join(to, name);
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyTree(a, b); } else fs.copyFileSync(a, b);
  }
};
fs.rmSync(out, { recursive: true, force: true });
for (const k of ["assets", "disk"]) { fs.mkdirSync(GEN[k], { recursive: true }); copyTree(UP[k], GEN[k]); }
if (!fs.existsSync(path.join(GEN.assets, GAME_PKG))) fatal(`no tools/${NAME}-assets/${NAME} package`);
fs.writeFileSync(path.join(out, ".game-package"), NAME + "\n");

// Workspace and module files.
{
  let w = fs.readFileSync(path.join(src, "go.work"), "utf8");
  const use = w.match(/^use \(\n[\s\S]*?^\)\n/m) ?? fatal("go.work: no use block");
  w = w.replace(use[0], "use (\n\t./tools/psx-assets\n\t./tools/psx-disk\n)\n");
  fs.writeFileSync(path.join(out, "go.work"), w);
  if (fs.existsSync(path.join(src, "go.work.sum"))) fs.copyFileSync(path.join(src, "go.work.sum"), path.join(out, "go.work.sum"));
  for (const k of ["assets", "disk"]) {
    const f = path.join(GEN[k], "go.mod");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(`module ${MOD[k]}\n`, `module ${NEWMOD[k]}\n`));
  }
}

const rd = (k, rel) => fs.readFileSync(path.join(GEN[k], rel), "utf8");
const wr = (k, rel, t) => fs.writeFileSync(path.join(GEN[k], rel), t);
const add = (k, rel, from) => { fs.mkdirSync(path.dirname(path.join(GEN[k], rel)), { recursive: true }); fs.copyFileSync(path.join(ovl, from), path.join(GEN[k], rel)); };
// Replace exactly one occurrence of `a` (string or regex) in `text`.
const once = (file, text, a, b) => {
  const n = typeof a === "string" ? text.split(a).length - 1 : (text.match(new RegExp(a.source, a.flags.replace("g", "") + "g")) ?? []).length;
  if (n !== 1) fatal(`${file}: expected exactly one ${a}, found ${n}`);
  return typeof a === "string" ? text.split(a).join(b) : text.replace(a, () => b);
};
// The `var <name> = <type>{ ... }` block (top level, closing `}` at column 0).
const block = (file, text, name) => text.match(new RegExp(`^var ${name} = [^\\n]*\\{\\n([\\s\\S]*?)^\\}\\n`, "m")) ?? fatal(`${file}: var ${name} block not found`);
const edit = (k, rel, fn) => wr(k, rel, fn(rd(k, rel), rel));

// ---- wasip1 ----------------------------------------------------------------
add("assets", "bindiff.go", "bindiff.go");
add("assets", "deps/exec_unix.go", "exec_unix.go");
add("assets", `${GAME_PKG}/romdev_exec_wasip1.go`, "romdev_exec_wasip1.go");
edit("assets", `${GAME_PKG}/enum.go`, (t, f) => {
  t = once(f, t, 'exec.LookPath("cpp")', 'romdevLookPath("cpp")');
  return once(f, t, "cmd.Output()", "romdevOutput(cmd)");
});

// ---- stage, boss and character tables ----------------------------------------
add("assets", "romdev_names.go", "romdev_names.go");
// objdiffgen.go: metaOverlays (basename -> id, kind, label) and the init()
// that adds the weapons to it go; romdev_names.go derives them from the code.
edit("assets", "objdiffgen.go", (t, f) => {
  const m = block(f, t, "metaOverlays");
  if (m[1].split("\n").filter(Boolean).length < 40) fatal(`${f}: metaOverlays is smaller than expected`);
  t = t.replace(m[0], "");
  t = once(f, t, /^func init\(\) \{\n\tfor hand := 0; hand <= 1; hand\+\+ \{\n[\s\S]*?metaOverlays\[id\] = [\s\S]*?^\}\n/m, "");
  t = once(f, t, /\t\t\tvar overlayMeta metaOverlay\n\t\t\tfor _, val := range metaOverlays \{\n\t\t\t\tif val\.id == ovlID \{\n\t\t\t\t\toverlayMeta = val\n\t\t\t\t\tbreak\n\t\t\t\t\}\n\t\t\t\}\n/, "\t\t\toverlayMeta := romdevMetaOverlayByID(ovlID)\n");
  t = once(f, t, "metaOverlays[splatConfig.Options.Basename]", "romdevMetaOverlay(splatConfig.Options.Basename)");
  if (t.includes("metaOverlays")) fatal(`${f}: metaOverlays still referenced`);
  return t;
});
// objdiffsaturn.go / build_saturn.go: the Saturn lists come from config/saturn/.
edit("assets", "objdiffsaturn.go", (t, f) => {
  t = t.replace(block(f, t, "saturnOverlays")[0], "");
  return once(f, t, "range saturnOverlays {", "range romdevSaturnOverlays() {");
});
edit("assets", "build_saturn.go", (t, f) => {
  for (const [v, fn] of [["saturnSplitterYAMLs", "romdevSaturnSplitterYAMLs"], ["saturnExtractSentinels", "romdevSaturnExtractSentinels"]]) {
    t = t.replace(block(f, t, v)[0], "");
    t = once(f, t, `range ${v} {`, `range ${fn}() {`);
    if (t.includes(v)) fatal(`${f}: ${v} still referenced`);
  }
  return t;
});
// spriteset: a self-assignment under one asset directory (a leftover debugger hook).
edit("assets", "assets/spriteset/handler.go", (t, f) => once(f, t, /\tif e\.AssetDir == "assets\/[a-z_]+" \{\n\t\te\.AssetDir = e\.AssetDir\n\t\}\n/, ""));

// ---- disc identifiers ----------------------------------------------------------
add("disk", "discs/romdev_pvd.go", "romdev_pvd.go");
edit("disk", "discs/make.go", (t, f) => once(f, t,
  /\timg\.Pvd\.SystemIdentifier = [^\n]*\n\timg\.Pvd\.VolumeIdentifier = [^\n]*\n\timg\.Pvd\.PublisherIdentifier = [^\n]*\n\timg\.Pvd\.DataPreparerIdentifier = [^\n]*\n\timg\.Pvd\.ApplicationIdentifier = [^\n]*\n/,
  "\tromdevSetIdentifiers(img, inputPath)\n"));
// The asset tool assembles its image in a temp directory; the original
// extracted disc it starts from is where the image is found.
edit("assets", "mods/makedisk.go", (t, f) => once(f, t,
  "func MakeDisk(outputFileName, buildPath, originPath, fileListPath string, dryrun bool) error {\n",
  "func MakeDisk(outputFileName, buildPath, originPath, fileListPath string, dryrun bool) error {\n\tdiscs.ReferenceDirs = append(discs.ReferenceDirs, originPath)\n"));
add("assets", "projectid/projectid.go", "projectid.go");

// ---- the project's name ---------------------------------------------------------
// Split Go source into code, comments and string literals.
const tokens = (t) => {
  const out = []; let i = 0, start = 0;
  const push = (kind, end) => { if (end > start) out.push({ kind, s: t.slice(start, end) }); start = end; };
  while (i < t.length) {
    const c = t[i];
    if (c === "/" && t[i + 1] === "/") { push("code", i); const e = t.indexOf("\n", i); i = e < 0 ? t.length : e; push("comment", i); }
    else if (c === "/" && t[i + 1] === "*") { push("code", i); i = t.indexOf("*/", i + 2) + 2; push("comment", i); }
    else if (c === '"' || c === "'") { push("code", i); i++; while (t[i] !== c) i += t[i] === "\\" ? 2 : 1; i++; push(c === '"' ? "string" : "rune", i); }
    else if (c === "`") { push("code", i); i = t.indexOf("`", i + 1) + 1; push("raw", i); }
    else i++;
  }
  push("code", t.length);
  return out;
};
const REPO_RE = new RegExp(`[A-Za-z0-9_.-]+/${NAME_RE.source}-decomp`, "gi");
// A string literal naming the project becomes an expression built at run time
// (assets) or a neutral text (disk, which has no project to read).
const rewriteString = (k, s) => {
  if (k === "disk") return s.replace(new RegExp(`${NAME_RE.source}-dis[ck]`, "gi"), "psx-disk").replace(new RegExp(`${NAME_RE.source}\\.cue`, "gi"), "image.cue").replace(NAME_RE_G, "psx");
  const q = s[0], body = s.slice(1, -1), parts = [];
  let last = 0;
  for (const m of body.matchAll(new RegExp(`${REPO_RE.source}|${NAME_RE.source}`, "gi"))) {
    if (m.index > last) parts.push(q + body.slice(last, m.index) + q);
    const w = m[0];
    parts.push(w.includes("/") ? "projectid.Repo()" : w === w.toUpperCase() ? "projectid.Upper()" : "projectid.Name()");
    last = m.index + w.length;
  }
  if (last < body.length) parts.push(q + body.slice(last) + q);
  return parts.length === 1 ? parts[0] : `(${parts.join(" + ")})`;
};
const addImport = (t, imp) => {
  if (t.includes(`"${imp}"`)) return t;
  if (/^import \(\n/m.test(t)) return t.replace(/^import \(\n/m, `import (\n\t"${imp}"\n`);
  if (/^import "/m.test(t)) return t.replace(/^import "/m, `import "${imp}"\nimport "`);
  return t.replace(/^(package \w+\n)/m, `$1\nimport "${imp}"\n`);
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const leftovers = [];
for (const k of ["assets", "disk"]) {
  for (const file of walk(GEN[k]).filter((f) => f.endsWith(".go"))) {
    let t = fs.readFileSync(file, "utf8");
    // Import paths: the game package, then each module.
    t = t.split(`"${MOD.assets}/${NAME}"`).join(`"${NEWMOD.assets}/${GAME_PKG}"`);
    for (const m of ["assets", "disk"]) t = t.split(`"${MOD[m]}"`).join(`"${NEWMOD[m]}"`).split(`"${MOD[m]}/`).join(`"${NEWMOD[m]}/`);
    let usesId = false;
    t = tokens(t).map(({ kind, s }) => {
      if (!NAME_RE.test(s)) return s;
      if (kind === "code") {
        // The game package (`package x`, `x.Ident`) and identifiers built on the name.
        return s.replace(new RegExp(`\\b${NAME_RE.source}\\b`, "g"), GAME_PKG).replace(NAME_RE_G, "Project");
      }
      if (kind === "string" || kind === "raw") { const r = rewriteString(k, s); if (r.includes("projectid.")) usesId = true; return r; }
      return s; // comments do not ship
    }).join("");
    if (usesId) t = addImport(t, `${NEWMOD.assets}/projectid`);
    for (const { kind, s } of tokens(t)) if (kind !== "comment" && NAME_RE.test(s)) leftovers.push(`${path.relative(out, file)}: ${s.match(new RegExp(`.{0,30}${NAME_RE.source}.{0,30}`, "i"))[0]}`);
    fs.writeFileSync(file, t);
  }
}
if (leftovers.length) fatal(`the project's name is left in code:\n  ${leftovers.join("\n  ")}`);

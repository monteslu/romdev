// Copy the PS1 decomp project's string-encoder crate (tools/<name>_str) to
// <out dir> as the crate psx_str, for build-decomp-rust-tools.sh. The pinned
// tree is not edited. The project's short name is in the crate name, its
// messages, the define its `cc` wrapper passes and the temp file it writes;
// the messages become neutral and the define and temp file name are built at
// run time from the project's own tools/<name>_str directory, so the name is
// never in the binary.
// usage: node gen-source.mjs <pinned tree> <out dir>
import fs from "node:fs";
import path from "node:path";

const [src, out] = process.argv.slice(2);
const fatal = (m) => { console.error(`FATAL: psx-str gen-source: ${m}`); process.exit(1); };
const crates = fs.readdirSync(path.join(src, "tools")).filter((d) => d.endsWith("_str") && fs.existsSync(path.join(src, "tools", d, "Cargo.toml")));
if (crates.length !== 1) fatal(`expected one tools/*_str crate, found ${crates.length}`);
const crate = crates[0], name = crate.slice(0, -"_str".length);
const NAME_RE = new RegExp(name.replace(/[^a-z0-9]/gi, ""), "i");
const once = (file, text, a, b) => {
  const n = text.split(a).length - 1;
  if (n !== 1) fatal(`${file}: expected exactly one ${JSON.stringify(a)}, found ${n}`);
  return text.split(a).join(b);
};

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, "tools", crate), out, { recursive: true });
const rw = (rel, fn) => { const f = path.join(out, rel); fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8"), rel)); };
rw("Cargo.toml", (t, f) => once(f, t, `name = "${crate}"`, `name = "psx_str"`));
rw("Cargo.lock", (t, f) => once(f, t, `name = "${crate}"`, `name = "psx_str"`));
const tag = "romdev_project_name()";
rw("src/main.rs", (t, f) => {
  const UP = name.toUpperCase();
  t = once(f, t, `out.push("-D${UP}_STR".to_string());`, `out.push(format!("-D{}_STR", ${tag}.to_uppercase()));`);
  t = once(f, t, `eprintln!("${crate} cc: {}", msg);`, `eprintln!("psx-str cc: {}", msg);`);
  t = once(f, t, `"usage: ${crate} cc <compiler> <args...>"`, `"usage: psx-str cc <compiler> <args...>"`);
  t = once(f, t, `format!("{}.${crate}.c", output)`, `format!("{}.{}_str.c", output, ${tag})`);
  t = t.replace(new RegExp(`(\\.about\\("String processor to interpret sequence of characters from )${UP}("\\))`), "$1a PS1 game$2");
  t += `
// romdev: the project's short name, from its own tools/<name>_str crate in
// the working directory ("psx" outside a project).
fn ${tag} -> String {
    if let Ok(entries) = std::fs::read_dir("tools") {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().join("Cargo.toml").is_file())
            .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix("_str")).map(String::from))
            .collect();
        names.sort();
        if let Some(n) = names.into_iter().next() {
            return n;
        }
    }
    "psx".to_string()
}
`;
  return t;
});
// Comments do not ship; everything else must be free of the name.
for (const rel of ["Cargo.toml", "src/main.rs"]) {
  const bad = fs.readFileSync(path.join(out, rel), "utf8").split("\n").filter((l) => NAME_RE.test(l.replace(/\/\/.*$/, "")));
  if (bad.length) fatal(`${rel}: the project's name is left in:\n  ${bad.join("\n  ")}`);
}
fs.writeFileSync(path.join(out, ".project-name"), name + "\n");
